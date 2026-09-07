// ============================================================
// dsh-orbit — storage domain spec（环 / 复盘 / playbook 三张表）
// 持久化用 ctx.storage.domain（宿主级共享、zod 校验、写链串行、事件发射）。
// ============================================================

import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";

/** 环的状态机（一次实验的生命周期）。 */
const RingStatus = z.enum(["running", "awaiting_approval", "completed", "failed", "skipped"]);

/** 内环纠偏：单环自评。 */
const ringReview = z.object({
  alignment: z.enum(["aligned", "partial", "drifted"]),
  assumption_broke: z.boolean(),
  affects_future: z.boolean(),
  next_focus: z.string().nullable(),
});

/** 证据指针：指向会话轨迹的 (sessionId, seq 区间)。 */
const ringEvidence = z.object({
  session_id: z.string(),
  seq_start: z.number(),
  seq_end: z.number().nullable(),
});

/** 环 = 一次实验（假设 + 决策 + 任务 + done_when 尺子 + 结果）。 */
export const ringSchema = z.object({
  ring_id: z.string(),
  goal_id: z.string(),
  track: z.string(),
  assumption: z.string(),
  reason: z.string(),
  task: z.string(),
  done_when: z.string(),
  critical: z.boolean(),

  status: RingStatus,
  result: z.object({
    done_when_met: z.boolean(),
    summary: z.string(),
    findings: z.array(z.string()),
    risks: z.array(z.string()),
  }).nullable(),

  review: ringReview.nullable(),
  evidence: ringEvidence,
  distilled_at: z.string().nullable(),   // 蒸馏状态：null=未蒸馏，时间戳=已蒸馏

  // 双轨度量（v6）：注入打点（自动）+ 采纳报告（agent 收口时填）
  injected_experiences: z.array(z.string()).default([]),  // 建环时注入的参考经验 id
  adopted_experiences: z.array(z.string()).default([]),   // 收口时 agent 报告实际采纳的经验 id
  injected_scores: z.record(z.string(), z.number()).default({}),  // 注入时各候选的余弦分数(调阈值用)

  created_at: z.string(),
  updated_at: z.string(),
});

/** 外环复盘：goal 封存时整树收口。 */
export const reflectionSchema = z.object({
  reflection_id: z.string(),
  goal_id: z.string(),
  track: z.string(),
  summary: z.string(),
  what_worked: z.array(z.string()),
  what_failed: z.array(z.string()),
  plan_gaps: z.array(z.string()),
  done_when_quality: z.object({ good: z.array(z.string()), poor: z.array(z.string()) }),
  would_do_differently: z.array(z.string()),
  created_at: z.string(),
});

/** 一条可复用经验（进化的成品，v2）。三必填：action / evidence / invalidates_when。 */
export const experienceEntrySchema = z.object({
  id: z.string(),
  experience: z.string(),              // 经验表述（一句）
  action: z.string(),                   // 必填：下次具体做什么不同的事
  evidence: z.array(z.string()),        // 必填：依据（ring_id 引用，可回放）
  invalidates_when: z.string(),         // 必填：什么情况下这条经验会被推翻
  scope: z.object({                     // 适用域
    kind: z.enum(["global", "session"]),
    id: z.string().nullable(),          // session 适用时填 session_id，global 为 null
  }),
  version: z.number(),
  status: z.enum(["pending", "active", "rejected", "outdated"]),
  reviewed_by: z.enum(["agent", "user"]).nullable().optional(),  // 裁决人：agent 清理 / user 裁决
  note: z.string().optional(),                                   // 附加说明（如 agent_cleaned）

  // 双轨度量（v6）：injected=被展示（自动打点）/ adopted=被采纳（agent 收口报告）
  injected_count: z.number().default(0),
  adopted_count: z.number().default(0),
  last_injected_at: z.string().nullable().default(null),
  last_adopted_at: z.string().nullable().default(null),
  case_summary: z.string().optional(),                          // 案例摘要：蒸馏时 LLM 生成 / 旧数据回填

  created_at: z.string(),
});

/** 任务类型 playbook：进化的沉淀物，按 track 聚合，含结构化经验条目。 */
export const playbookSchema = z.object({
  track: z.string(),
  entries: z.array(experienceEntrySchema),
  revision: z.number(),
  updated_at: z.string(),
});

export const orbitDomain = defineDomain({
  name: "orbit",
  version: 6,
  tables: {
    rings: { valueSchema: ringSchema },
    reflections: { valueSchema: reflectionSchema },
    playbooks: { valueSchema: playbookSchema },
  },
});

/** 合法 track（语义轨道 = 原 task_type），非法时回退 other。 */
export const TRACKS = ["research", "analysis", "trade", "query", "config", "other"];

export function normalizeTrack(raw) {
  const t = String(raw ?? "").toLowerCase().trim();
  return TRACKS.includes(t) ? t : "other";
}
