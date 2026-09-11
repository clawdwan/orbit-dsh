// ============================================================
// dsh-orbit — 「越做越会做」的反思层
// ------------------------------------------------------------
// 核心原语是「环」（一次实验）= 假设 + 决策 + 任务 + done_when + 结果。
// 根环 = DSH 原生 goal；环存 ctx.storage.domain（宿主级共享）。
// 内环纠偏 / 外环复盘 / 元环沉淀（playbook，过用户门）。
// ============================================================

import { Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { orbitDomain, normalizeTrack } from "./domain.js";

const LOOSE_OUTPUT = {
  schema: { type: "object", additionalProperties: true, properties: {} },
  render: (_args, value) => {
    const text =
      value && typeof value.message === "string"
        ? value.message
        : JSON.stringify(value ?? {}, null, 2);
    return [{ type: "text", text }];
  },
};

/**
 * 轨道语义提示（建环选 track 用）：research/analysis/trade/query/config/other。
 * 选择时按「任务本质」而非「手头在做什么」——例：给插件做「发布整理」是 other(发布/治理)，
 * 不是 config(工程开发实现)。
 */
const TRACK_HINTS = {
  research: "调研/梳理/查证：项目通读、技术预研、策略/方案梳理",
  analysis: "分析/盘点/验证：系统体检、数据/特征排查、对比测试、定位问题",
  trade: "交易决策：持仓评估、信号扫描、止损/买卖判断",
  query: "简单查询问答（一般不建环）",
  config: "工程开发实现：插件/系统开发、配置、代码改造、实现与修复",
  other: "通用杂项/发布/项目治理：GitHub 发布、版本管理、仓库整理、不属于上述",
};
const TRACK_LIST = Object.keys(TRACK_HINTS).join("|");

/** 解析 JSON 字符串数组参数（容错）。 */
function parseJsonArray(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 解析 JSON 对象 map（如 {"exp_x": "摘要"}），容错 markdown 围栏/裸对象。 */
function parseJsonMap(text) {  if (!text || typeof text !== "string") return null;
  let m = text.trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 当前会话最后事件的 seq（用于 evidence 指针）。 */
function currentSeq(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events) || events.length === 0) return 0;
  const last = events[events.length - 1];
  return typeof last?.seq === "number" ? last.seq : 0;
}

function ok(message, extra) {
  return { ok: true, message, ...(extra ?? {}) };
}
function fail(message) {
  return { ok: false, message };
}

class OrbitController extends Service {
  static inject = ["tools", "systemPrompt", "storage", "goals", "llm", "timer"];

  #domainPromise = null;
  #distillProvider;
  #distillModel;
  #distillIntervalSeconds;
  #notifyUrl;
  #notifyTargetId;
  #embedProvider;      // off | ollama | openai
  #embedUrl;
  #embedModel;
  #embedApiKey;
  #embedTimeoutMs;
  #embedMinScore;      // 注入阈值:余弦低于此分数不注入(宁缺毋滥)

  constructor(ctx, config = {}) {
    super(ctx, "orbit");

    // 蒸馏模型：可配置，默认 flash（蒸馏是单次 JSON 提取，不需要强推理）。
    this.#distillProvider = typeof config.distillProvider === "string" && config.distillProvider ? config.distillProvider : "deepseek-official";
    this.#distillModel = typeof config.distillModel === "string" && config.distillModel ? config.distillModel : "deepseek-v4-flash";
    // 定时蒸馏：可配置间隔（秒），默认 7 天；0 或未设则禁用。
    this.#distillIntervalSeconds = Number.isFinite(config.distillIntervalSeconds) && config.distillIntervalSeconds > 0
      ? config.distillIntervalSeconds
      : 604800;
    // 通知（可选）：配了 url+targetId 就推送，否则只写 pending、靠 agent 对话时对接。
    this.#notifyUrl = typeof config.notifyUrl === "string" && config.notifyUrl ? config.notifyUrl : null;
    this.#notifyTargetId = typeof config.notifyTargetId === "string" && config.notifyTargetId ? config.notifyTargetId : null;

    // Embedding（可选，默认 off）：注入相关性匹配用。off=不启用(回退顺序取3)。
    // ollama=本机 Ollama /api/embed；openai=OpenAI 兼容 /v1/embeddings（骨架）。
    const provider = String(config.embedProvider ?? "off").toLowerCase();
    this.#embedProvider = ["ollama", "openai"].includes(provider) ? provider : "off";
    this.#embedUrl = typeof config.embedUrl === "string" && config.embedUrl ? config.embedUrl : "http://127.0.0.1:11434";
    this.#embedModel = typeof config.embedModel === "string" && config.embedModel ? config.embedModel : "qwen3-embedding:0.6b";
    this.#embedApiKey = typeof config.embedApiKey === "string" ? config.embedApiKey : "";
    this.#embedTimeoutMs = Number.isFinite(config.embedTimeoutMs) && config.embedTimeoutMs > 0 ? config.embedTimeoutMs : 3000;
    // 注入阈值:余弦低于此分数不注入(宁缺毋滥)。0=不过滤(关闭阈值)。
    this.#embedMinScore = Number.isFinite(config.embedMinScore) && config.embedMinScore >= 0 ? config.embedMinScore : 0.35;

    // 周期蒸馏由 dsh-schedule 驱动(agent 到点调 orbit_weekly_distill)——
    // ctx.interval 计时器重启即重置不可靠,已移除(2026-09-07)。

    ctx.systemPrompt.section({
      name: "orbit:policy",
      order: 60,
      text: () => `## Orbit（反思层）

收到**有决策密度的多步任务**时，先建一个 goal，然后把它拆成一次次的「实验」（环）逐环推进：
1. 开始一步：orbit_ring_create(task=做什么, done_when=客观完成判据, assumption=假设, reason=为什么这么想, critical=是否不可逆/对外)；
2. 做完记录：orbit_ring_close(ring_id, done_when_met=判据是否达标, findings/risks)；
3. 需要时纠偏：orbit_ring_review(ring_id, alignment=aligned|partial|drifted, assumption_broke, affects_future)；
4. goal 收口时复盘：orbit_reflect(summary, what_worked/failed, plan_gaps, done_when_quality, would_do_differently)；
5. 复盘后若有成品经验，用 orbit_experience_add 逐条沉淀（必填 action/evidence/invalidates_when/scope）；
6. 下次同类任务时，orbit_ring_create 会自动注入匹配的参考经验。

**收口纪律（流程硬规则，收口处唯一强制点）**：
- 环必须收口：任务实际完成或放弃后，立即 orbit_ring_close 记录结果（判据是否达标、发现、风险）。running 只表示「正在进行」，不是常态。
- goal 收口必须先复盘：update_goal complete 之前，必须先调 orbit_reflect 做收口检查（未收口环/未复盘环都会在检查结果里列出）；未复盘直接 complete 视为流程违规。
- 经验必须过用户门：沉淀经验优先走「环→蒸馏→review」路径（pending 候选→用户裁决）；orbit_experience_add 仅限复盘现场确有把握的成品经验，且必须用户确认；禁止不经任何用户确认直接写 playbook。

简单任务（一句话查询/单步）不要建 goal、不要用环，直接执行即可。

**轨道选择**（orbit_ring_create 的 track 参数，按任务本质选，别按手头项目选）：
- research：调研/梳理/查证（项目通读、技术预研、方案梳理）
- analysis：分析/盘点/验证（系统体检、数据/特征排查、对比测试、问题定位）
- trade：交易决策（持仓评估、信号扫描、止损/买卖判断）
- query：简单查询问答（一般不建环）
- config：工程开发实现（插件/系统开发、配置、代码改造、修复）
- other：通用杂项/发布/项目治理（GitHub 发布、版本管理、仓库整理）——**发布类任务选 other，不是 config**

**待审提醒**：每次对话开始或有 pending 待审经验时，主动提醒用户「有 N 条待审经验，回复 review 查看并裁决」。用户说 review 后，用 orbit_review(action="list") 列出 pending；若其中明显有重复/质量差的候选，先用 orbit_review(action="clean", ids=[...]) 清掉（留痕 by:agent），再把有价值的列给用户用 orbit_review(action="apply") 裁决。

**通知配置引导**：orbit 支持每周自动蒸馏后推送提醒到某个飞书群。若用户想开启，问用户要飞书群 id，然后改 cordis.patch.yml 里 dsh-orbit 的 config，填 notifyUrl（桥的 /send 地址）和 notifyTargetId（飞书群 id）。未配置也照常工作，只是没有主动推送。

**周期蒸馏**：由 dsh-schedule 每周唤醒收件箱 agent，agent 到点调用 orbit_weekly_distill（蒸馏全部 track + 产出>0 自动推飞书待审提醒）。非周期蒸馏可随时手动 orbit_distill。`,
    });

    ctx.tools.register(defineTool({
      name: "orbit_ring_create",
      description:
        "开始一次「实验」（一个任务环）：设定假设、客观完成判据(done_when)，记录轨迹起点。critical=true 的环会先弹确认卡。要求当前有 active goal。",
      parameters: {
        task: { type: "string", required: true, description: "这一步要做什么" },
        done_when: { type: "string", required: true, description: "客观完成判据：一个可观测的事实，达成即算完成" },
        assumption: { type: "string", description: "这一步依赖的假设（可空）" },
        reason: { type: "string", description: "当时为什么这么想/这么决定（一句，可空）" },
        critical: { type: "boolean", description: "是否不可逆/对外操作，true 时执行前需确认" },
        track: { type: "string", description: `语义轨道 ${TRACK_LIST};按任务本质选(发布/仓库治理→other,工程开发实现→config,调研梳理→research,盘点验证→analysis,交易决策→trade)` },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const goal = this.ctx.goals.get(agent);
        if (!goal) return fail("没有 active goal，请先建 goal（create_goal）再开始环");
        const domain = await this.domain();

        const ring = {
          ring_id: `ring_${randomUUID().slice(0, 8)}`,
          goal_id: goal.id,
          track: normalizeTrack(args.track),
          assumption: typeof args.assumption === "string" ? args.assumption.trim() : "",
          reason: typeof args.reason === "string" ? args.reason.trim() : "",
          task: args.task.trim(),
          done_when: args.done_when.trim(),
          critical: args.critical === true,
          status: args.critical === true ? "awaiting_approval" : "running",
          result: null,
          review: null,
          evidence: { session_id: agent.session.id, seq_start: currentSeq(agent), seq_end: null },
          distilled_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (ring.critical) {
          const { approved, note } = await askApproval(this.ctx, agent, exec.signal, ring);
          if (!approved) {
            ring.status = "skipped";
            await domain.table("rings").put(ring.ring_id, ring);
            return ok(`关键环节「${ring.task}」未获批准，已跳过。${note ? `用户补充：${note}` : ""}`, { ring });
          }
          ring.status = "running";
        }

        await domain.table("rings").put(ring.ring_id, ring);
        const pb = domain.table("playbooks").get(ring.track);
        // 双轨度量·轨道1：注入打点（自动）——记录注入的经验 id 到环，并给经验 injected_count++ / last_injected_at
        let hint = "";
        let injectedIds = [];
        if (pb) {
          const inj = await this.injectExperiences(pb, agent.session.id, ring);
          hint = inj.text;
          injectedIds = inj.injected;
          const now = new Date().toISOString();
          // 注入分数记录(无论是否注入):供积累数据调阈值
          if (Object.keys(inj.scores ?? {}).length > 0) {
            ring.injected_scores = { ...(ring.injected_scores ?? {}), ...inj.scores };
            await domain.table("rings").put(ring.ring_id, ring);
          }
          if (injectedIds.length > 0) {
            ring.injected_experiences = [...(ring.injected_experiences ?? []), ...injectedIds];
            for (const e of pb.entries) {
              if (injectedIds.includes(e.id)) {
                e.injected_count = (e.injected_count ?? 0) + 1;
                e.last_injected_at = now;
              }
            }
            pb.updated_at = now;
            await domain.table("playbooks").put(ring.track, pb);
            await domain.table("rings").put(ring.ring_id, ring);
          }
        }
        const residual = checkResidualRings(domain, agent.session.id, ring.ring_id);
        let base = `已开始环 ${ring.ring_id}（track=${ring.track}）。\n判据: ${ring.done_when}`;
        if (residual) base += `\n\n⚠️ ${residual}`;
        return ok(hint ? `${base}\n\n${hint}` : base, { ring });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_ring_close",
      description:
        "结束一次实验，记录结果（判据是否达标）与轨迹终点。若本环建环时注入了参考经验，可填 adopted_experiences 报告实际采纳了哪几条（双轨度量：采纳信号）。",
      parameters: {
        ring_id: { type: "string", required: true },
        done_when_met: { type: "boolean", required: true, description: "done_when 判据是否达成" },
        summary: { type: "string", description: "结果总结" },
        findings: { type: "string", description: '发现的 JSON 字符串数组，如 ["发现A"]' },
        risks: { type: "string", description: '风险信号的 JSON 字符串数组' },
        adopted_experiences: { type: "string", description: '实际采纳的参考经验 id JSON 数组（必须在本环注入列表里），如 ["exp_x"]' },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const ring = domain.table("rings").get(args.ring_id);
        if (!ring) return fail(`环 ${args.ring_id} 不存在`);
        if (ring.status === "awaiting_approval") return fail("该环正在等待用户确认，先批准再关闭");

        const findings = parseJsonArray(args.findings);
        const risks = parseJsonArray(args.risks);
        if (findings === null || risks === null) return fail("findings/risks 必须是 JSON 字符串数组");

        ring.result = {
          done_when_met: args.done_when_met === true,
          summary: typeof args.summary === "string" ? args.summary : "",
          findings: findings.filter((f) => typeof f === "string"),
          risks: risks.filter((r) => typeof r === "string"),
        };
        ring.status = args.done_when_met === true ? "completed" : "failed";
        ring.evidence.seq_end = currentSeq(agent);
        ring.updated_at = new Date().toISOString();

        // 双轨度量·轨道2：采纳报告（agent 收口时填，必须在本环注入列表内）
        let adoptedNote = "";
        const injected = ring.injected_experiences ?? [];
        const adopted = parseJsonArray(args.adopted_experiences);
        if (adopted !== null && Array.isArray(adopted) && adopted.length > 0) {
          const validAdopted = adopted.filter((id) => typeof id === "string" && injected.includes(id));
          if (validAdopted.length > 0) {
            ring.adopted_experiences = [...(ring.adopted_experiences ?? []), ...validAdopted];
            adoptedNote = `，采纳 ${validAdopted.join("、")}`;
            // 打点：被采纳经验 adopted_count++ / last_adopted_at
            const pb = domain.table("playbooks").get(ring.track);
            if (pb) {
              const now = new Date().toISOString();
              let touched = false;
              for (const e of pb.entries) {
                if (validAdopted.includes(e.id)) {
                  e.adopted_count = (e.adopted_count ?? 0) + 1;
                  e.last_adopted_at = now;
                  touched = true;
                }
              }
              if (touched) {
                pb.updated_at = now;
                await domain.table("playbooks").put(ring.track, pb);
              }
            }
          }
        }

        await domain.table("rings").put(ring.ring_id, ring);

        // 回显注入列表，引导 agent 下个环节报告采纳（无注入则静默）
        const injectedHint = injected.length > 0
          ? `\n本环建环时注入了参考经验：${injected.join("、")}。若实际采纳了其中某些，下次可在 orbit_ring_close 填 adopted_experiences 报告。`
          : "";
        return ok(
          (args.done_when_met === true ? `环 ${ring.ring_id} 完成（判据达标）。` : `环 ${ring.ring_id} 判据未达标，标记 failed。`) +
          (adoptedNote ? ` 已记录采纳${adoptedNote}。` : "") + injectedHint,
          { ring },
        );
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_ring_review",
      description: "内环纠偏：完成后评估这一步是否对齐目标、假设是否破裂、是否影响后续。",
      parameters: {
        ring_id: { type: "string", required: true },
        alignment: { type: "string", required: true, enum: ["aligned", "partial", "drifted"], description: "对齐程度" },
        assumption_broke: { type: "boolean", required: true, description: "假设是否破裂" },
        affects_future: { type: "boolean", required: true, description: "是否产生会影响后续的新事实" },
        next_focus: { type: "string", description: "下个环节应聚焦的新方向" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const domain = await this.domain();
        const ring = domain.table("rings").get(args.ring_id);
        if (!ring) return fail(`环 ${args.ring_id} 不存在`);

        ring.review = {
          alignment: args.alignment,
          assumption_broke: args.assumption_broke === true,
          affects_future: args.affects_future === true,
          next_focus: typeof args.next_focus === "string" && args.next_focus.trim() ? args.next_focus.trim() : null,
        };
        ring.updated_at = new Date().toISOString();
        await domain.table("rings").put(ring.ring_id, ring);

        return ok(`已记录纠偏（alignment=${args.alignment}）。`, { ring });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_reflect",
      description:
        "外环复盘：goal 收口时，聚合本 goal 的所有环做结构化复盘，并提议把教训并入该 track 的 playbook（需用户批准）。",
      parameters: {
        summary: { type: "string", required: true, description: "本次收口的总结" },
        what_worked: { type: "string", description: '有效的做法 JSON 数组' },
        what_failed: { type: "string", description: '失败的/假设破裂的 JSON 数组' },
        plan_gaps: { type: "string", description: '规划时漏掉的 JSON 数组' },
        done_when_quality_good: { type: "string", description: '设得好的判据 JSON 数组' },
        done_when_quality_poor: { type: "string", description: '设得差的判据 JSON 数组' },
        would_do_differently: { type: "string", description: '下次会怎么改 JSON 数组' },
        track: { type: "string", description: "复盘归属的 track（缺省从本 goal 的环推断）" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const goal = this.ctx.goals.get(agent);
        const domain = await this.domain();

        // 聚合本 goal 的环
        const rings = [];
        for (const [, ring] of domain.table("rings").entries()) {
          if (goal && ring.goal_id === goal.id) rings.push(ring);
        }
        if (rings.length === 0) return fail("当前 goal 下没有环，无法复盘");

        // ---- 收口检查站：goal 收口前的健康检查（未收口/未复盘/重复复盘）----
        const open = rings.filter((r) => r.status === "running");
        const unreviewed = rings.filter((r) => !r.review);
        const priorReflections = [];
        if (goal) {
          for (const [, r] of domain.table("reflections").entries()) {
            if (r.goal_id === goal.id) priorReflections.push(r);
          }
        }
        const checks = [];
        if (open.length > 0) {
          checks.push(`⚠️ ${open.length} 个环未收口（running）：${open.map((r) => `「${r.task}」`).join("、")}。若已完成/放弃请先 orbit_ring_close。`);
        }
        if (unreviewed.length > 0) {
          checks.push(`ℹ️ ${unreviewed.length} 个环没有纠偏记录（review 为空）：${unreviewed.map((r) => `「${r.task}」`).join("、")}。若中途有假设破裂/方向漂移，补 orbit_ring_review 可提升蒸馏质量。`);
        }
        if (priorReflections.length > 0) {
          checks.push(`ℹ️ 本 goal 已有 ${priorReflections.length} 次复盘（${priorReflections.map((r) => r.reflection_id).join("、")}），本次为补充复盘。`);
        }
        const checkText = `\n\n--- 收口检查 ---\n${checks.length ? checks.join("\n") : "✅ goal 下所有环均已收口，可放心 complete。"}`;

        const track = normalizeTrack(args.track ?? dominantTrack(rings));
        const reflection = {
          reflection_id: `refl_${randomUUID().slice(0, 8)}`,
          goal_id: goal ? goal.id : "(no-goal)",
          track,
          summary: args.summary,
          what_worked: arrOr(args.what_worked),
          what_failed: arrOr(args.what_failed),
          plan_gaps: arrOr(args.plan_gaps),
          done_when_quality: {
            good: arrOr(args.done_when_quality_good),
            poor: arrOr(args.done_when_quality_poor),
          },
          would_do_differently: arrOr(args.would_do_differently),
          created_at: new Date().toISOString(),
        };
        await domain.table("reflections").put(reflection.reflection_id, reflection);
        return ok(
          `已复盘并写入 reflection ${reflection.reflection_id}。\n` +
          `若有值得沉淀的成品经验，用 orbit_experience_add 逐条添加（需 experience/action/evidence/invalidates_when/scope）。` +
          checkText,
          { reflection, checks: { open: open.length, unreviewed: unreviewed.length, prior_reflections: priorReflections.length } },
        );
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_experience_add",
      description:
        "把一条「成品经验」沉淀进 playbook（过用户门）。反废话三必填：action(下次具体做什么)、evidence(依据哪些环)、invalidates_when(何时失效)。scope=global 通用 / session 仅当前会话。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        experience: { type: "string", required: true, description: "经验表述（一句）" },
        action: { type: "string", required: true, description: "下次具体做什么不同的事（必填）" },
        evidence: { type: "string", required: true, description: '依据的 ring_id JSON 数组，如 ["ring_xxx"]' },
        invalidates_when: { type: "string", required: true, description: "什么情况下这条经验会被推翻（必填）" },
        scope_kind: { type: "string", enum: ["global", "session"], description: "适用域，默认 global" },
        case_summary: { type: "string", description: "案例摘要（一句场景说明，可空）" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const track = normalizeTrack(args.track);

        // 反废话三必填校验
        const action = (args.action ?? "").trim();
        const invalidates = (args.invalidates_when ?? "").trim();
        const evidence = parseJsonArray(args.evidence);
        if (!action) return fail("action 必填：经验必须落到一个具体动作");
        if (!invalidates) return fail("invalidates_when 必填：必须说明何时失效，否则是废话");
        if (evidence === null || evidence.length === 0) return fail("evidence 必填：必须引用至少一个真实环");

        // evidence 存在性校验（与蒸馏同源加固：防 LLM/手填幻觉 id）
        const realRingIds = new Set();
        for (const [, r] of domain.table("rings").entries()) realRingIds.add(r.ring_id);
        const validEvidence = evidence.filter((e) => typeof e === "string" && realRingIds.has(e));
        if (validEvidence.length === 0) return fail(`evidence 引用的环都不存在：${JSON.stringify(evidence)}`);

        const scopeKind = args.scope_kind === "session" ? "session" : "global";
        const caseSummary = typeof args.case_summary === "string" ? args.case_summary.trim() : "";
        const entry = {
          id: `exp_${randomUUID().slice(0, 8)}`,
          experience: (args.experience ?? "").trim(),
          action,
          evidence: validEvidence,
          invalidates_when: invalidates,
          scope: { kind: scopeKind, id: scopeKind === "session" ? agent.session.id : null },
          version: 1,
          status: "active",
          created_at: new Date().toISOString(),
          ...(caseSummary ? { case_summary: caseSummary } : {}),
        };

        // 重复检测（可插拔粗筛；将来可换 embedding）：与已有 active 经验对比，命中阈值走确认卡
        const pb = domain.table("playbooks").get(track);
        const dup = pb ? findDuplicate(pb, entry) : null;
        const askText = dup
          ? `经验「${entry.experience || "(未命名)"}」与已有 active 经验「${dup.entry.experience}」相似度 ${dup.score.toFixed(2)}，疑似重复。仍要写入吗？`
          : `沉淀经验到 track=${track} 的 playbook`;
        const askOptions = dup
          ? [
              { label: "继续写入", description: "保留疑似重复（不推荐，会占用注入名额）" },
              { label: "放弃", description: "丢弃这条候选，可走 review 对比后裁决" },
            ]
          : undefined;

        // 过用户门
        const { approved, note } = await askApproval(this.ctx, agent, exec.signal, {
          task: askText,
          done_when: dup ? undefined : `经验「${entry.experience || "(未命名)"}」并入 playbook`,
          title: dup ? "疑似重复经验" : "沉淀经验",
          question: askText,
          options: askOptions,
        });
        if (!approved) {
          return dup
            ? ok(`已放弃写入疑似重复经验（与 ${dup.entry.id} 相似度 ${dup.score.toFixed(2)}）。${note ? `用户补充：${note}` : ""}`, { entry: null, duplicate: dup.entry.id })
            : ok(`经验未获批准，已丢弃。${note ? `用户补充：${note}` : ""}`, { entry: null });
        }

        // 留痕：确认卡批准 = 用户确认；note 标来源路径
        entry.reviewed_by = "user";
        entry.note = "via_experience_add";

        const newPb = pb ?? {
          track,
          entries: [],
          revision: 0,
          updated_at: new Date().toISOString(),
        };
        newPb.entries = [...newPb.entries, entry];
        newPb.revision = (newPb.revision || 0) + 1;
        newPb.updated_at = new Date().toISOString();
        await domain.table("playbooks").put(track, newPb);

        // 写入时冲突检测（best-effort）：新经验 vs 其他 active
        let conflictNote = "";
        try {
          const others = newPb.entries.filter((e) => e.status === "active" && e.id !== entry.id);
          const target = { provider: this.#distillProvider, model: this.#distillModel };
          const conflicts = await detectConflicts(this.ctx, target, entry, others, agent.session.id);
          if (conflicts.length > 0) {
            conflictNote = "\n⚠️ 冲突提示（新经验与已有 active 疑似矛盾，请酌情处理）：\n" +
              conflicts.map((c) => `- ${c.b_id}: ${c.reason}`).join("\n");
          }
        } catch (e) {
          conflictNote = "\n⚠️ 冲突检测失败（不影响沉淀结果）: " + (e?.message || e);
        }

        return ok(
          `已沉淀经验到 track=${track}（revision=${newPb.revision}）。${dup ? ` 注：该经验与 ${dup.entry.id} 疑似重复（相似度 ${dup.score.toFixed(2)}），你已确认写入。` : ""}${conflictNote}`,
          { entry },
        );
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_distill",
      description:
        "离线蒸馏(可手动触发):读某 track 积累的环,直接调模型分析(不经 agent turn),产出经验候选(存 pending,待用户 review)。默认增量(只蒸已闭环且未蒸过的环);full=true 强制全量重蒸;backfill=true 只回填该 track 已有 active 经验的 case_summary(不产候选,不重蒸)。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        full: { type: "boolean", description: "true=强制全量重蒸(忽略已蒸馏标记),默认 false 增量" },
        backfill: { type: "boolean", description: "true=仅回填 active 经验的案例摘要(调 LLM 生成 case_summary),不产候选" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const track = normalizeTrack(args.track);
        try {
          if (args.backfill === true) {
            const n = await this.backfillCaseSummaries(track, agent.session.id);
            return ok(`已回填 ${n} 条 active 经验的案例摘要（track=${track}）。`);
          }
          const r = await this.distillTrackCore(track, agent.session.id, { full: args.full === true });
          if (r.skipped) return ok(`track=${track} 没有「已闭环且未蒸馏」的环(可能都已蒸过,或用 full=true 全量重蒸)。`);
          if (r.count === 0) return ok("蒸馏完成,未产出候选经验(可能数据不足或全被三必填过滤)。");
          return ok(`蒸馏完成,产出 ${r.count} 条候选经验(状态=pending,待用户 review)。\n\n${formatEntries(r.candidates)}`, { candidates: r.candidates });
        } catch (e) {
          return fail(`蒸馏失败: ${e?.message || e}`);
        }
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_weekly_distill",
      description:
        "周期蒸馏(由 dsh-schedule 每周唤醒 agent 时调用):蒸馏全部 track 的未蒸馏闭环,产出>0 时自动推送飞书通知(待审提醒);产出 0 或全跳过则静默。无需 goal/环。",
      parameters: {},
      output: LOOSE_OUTPUT,
      execute: async () => {
        const perTrack = [];
        let total = 0;
        const tracks = new Set();
        const domain = await this.domain();
        for (const [, ring] of domain.table("rings").entries()) tracks.add(ring.track);
        for (const track of tracks) {
          try {
            const r = await this.distillTrackCore(track, null);
            if (r.count > 0) { total += r.count; perTrack.push(`${track}:+${r.count}`); }
          } catch (e) {
            try { this.ctx.logger?.("orbit")?.warn?.(`weekly distill track=${track} 失败: ${e?.message || e}`); } catch {}
          }
        }
        if (total === 0) return ok("周期蒸馏完成:全部 track 无可蒸馏的未蒸馏闭环(无产出,静默)。");
        await this.notifyInbox(total, perTrack);
        return ok(`周期蒸馏完成:产出 ${total} 条待审经验(${perTrack.join(", ")}),已推送飞书提醒。`);
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_playbook",
      description: "读取某 track 的 playbook（结构化经验条目：经验/动作/依据/失效条件/适用域/健康度），供同类新任务规划时参考。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道 research|analysis|trade|query|config|other" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args) => {
        const domain = await this.domain();
        const track = normalizeTrack(args.track);
        const pb = domain.table("playbooks").get(track);
        if (!pb) return ok(`track=${track} 还没有 playbook。`, { track, playbook: null });
        const rings = [];
        for (const [, r] of domain.table("rings").entries()) rings.push(r);
        return ok(formatPlaybook(pb, rings), { track, playbook: pb });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_health",
      description:
        "经验健康度报告（阶段2 可检验）：建议淘汰列表（展示过从未被采纳 / 采纳环全失败且样本≥3 / 超90天未被采纳）+ 疑似冲突对（粗筛候选 + LLM 判断）。淘汰用 orbit_review action=outdate 裁决。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道 research|analysis|trade|query|config|other" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const track = normalizeTrack(args.track);
        const pb = domain.table("playbooks").get(track);
        if (!pb) return ok(`track=${track} 还没有 playbook。`);
        const rings = [];
        for (const [, r] of domain.table("rings").entries()) rings.push(r);
        const active = pb.entries.filter((e) => e.status === "active");
        if (active.length === 0) return ok(`track=${track} 没有 active 经验。`);

        const lines = [`=== orbit health: track=${track} ===`, `活跃经验: ${active.length} 条`, ""];

        // 1. 建议淘汰（信号需有样本量：展示≥3 仍未采纳，或采纳环全失败，或超90天未采纳）
        const stale = [];
        const now = Date.now();
        const DAY = 86400000;
        for (const e of active) {
          if ((e.injected_count ?? 0) >= 3 && (e.adopted_count ?? 0) === 0) {
            stale.push(`- ${e.id}: 展示 ${e.injected_count} 次 · 从未被采纳`);
          } else {
            const s = adoptionStats(e, rings);
            if (s && s.n >= 3 && s.rate === 0) stale.push(`- ${e.id}: 采纳环成功率 0%（样本 ${s.n}）`);
            if ((e.adopted_count ?? 0) > 0 && e.last_adopted_at) {
              const days = (now - Date.parse(e.last_adopted_at)) / DAY;
              if (days > 90) stale.push(`- ${e.id}: 已 ${Math.round(days)} 天未被采纳`);
            }
          }
        }
        lines.push("【建议淘汰】(确认后 orbit_review action=outdate ids=[...])");
        lines.push(stale.length ? stale.join("\n") : "- (无)");

        // 2. 疑似冲突（LLM 全量扫描：逐条 vs 其余，无粗筛漏检；低频手动可接受多次调用）
        lines.push("", "【疑似冲突】(LLM 全量判断)");
        const target = { provider: this.#distillProvider, model: this.#distillModel };
        const conflictMap = new Map(); // "a_id|b_id" 去重
        try {
          for (const e of active) {
            const others = active.filter((o) => o.id !== e.id);
            const res = await detectConflicts(this.ctx, target, e, others, agent.session.id);
            for (const c of res) {
              const key = [c.a_id, c.b_id].sort().join("|");
              conflictMap.set(key, c);
            }
          }
        } catch (e) {
          // best-effort：LLM 失败不拖垮整个 health 报告
          try { this.ctx.logger?.("orbit")?.warn?.(`health 冲突扫描失败: ${e?.message || e}`); } catch {}
          lines.push(`- (冲突扫描失败: ${e?.message || e})`);
        }
        const conflicts = [...conflictMap.values()];
        lines.push(conflicts.length ? conflicts.map((c) => `- ${c.a_id} ↔ ${c.b_id}: ${c.reason}`).join("\n") : "- (无)");
        return ok(lines.join("\n"), { track });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_review",
      description:
        "review 过门：list=列出候选（默认 pending，可看 cleaned=agent 清理的 / rejected=用户拒的）；clean=agent 批量清理重复/垃圾（标记 rejected，留痕 reviewed_by=agent）；apply=用户裁决（收/改/拒，留痕 reviewed_by=user，收后自动冲突检测）；outdate=把 active 经验标记为 outdated（用户裁决淘汰）。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        action: { type: "string", enum: ["list", "clean", "apply", "outdate"], description: "list=列出,clean=agent 清理,apply=用户裁决,outdate=标记淘汰" },
        status: { type: "string", enum: ["pending", "cleaned", "rejected"], description: "list 时筛选:pending=待审,cleaned=agent 清理过的,rejected=用户拒的" },
        ids: { type: "string", description: 'clean/outdate 时的 id 列表 JSON 数组，如 ["exp_x","exp_y"]' },
        decisions: { type: "string", description: 'apply 时的裁决 JSON 数组，形如 [{"id":"exp_x","decision":"accept|reject|modify","modified":{...}}]' },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const track = normalizeTrack(args.track);
        const pb = domain.table("playbooks").get(track);
        if (!pb) return ok(`track=${track} 还没有 playbook。`);

        // ---- list ----
        if (args.action !== "clean" && args.action !== "apply" && args.action !== "outdate") {
          let entries;
          if (args.status === "cleaned") {
            entries = pb.entries.filter((e) => e.status === "rejected" && e.reviewed_by === "agent");
          } else if (args.status === "rejected") {
            entries = pb.entries.filter((e) => e.status === "rejected" && e.reviewed_by === "user");
          } else {
            entries = pb.entries.filter((e) => e.status === "pending");
          }
          if (entries.length === 0) {
            const label = args.status === "cleaned" ? "agent 清理的" : args.status === "rejected" ? "用户拒的" : "待审";
            return ok(`track=${track} 没有${label}经验。`);
          }
          const label = args.status === "cleaned" ? "agent 清理的" : args.status === "rejected" ? "用户拒的" : "待审";
          return ok(`track=${track} 有 ${entries.length} 条${label}经验：\n\n${formatEntries(entries)}`);
        }

        // ---- clean（agent 批量清理）----
        if (args.action === "clean") {
          const ids = parseJsonArray(args.ids);
          if (ids === null || !Array.isArray(ids) || ids.length === 0) return fail("clean 需要 ids 列表");
          let cleaned = 0;
          for (const id of ids) {
            const entry = pb.entries.find((e) => e.id === id && e.status === "pending");
            if (!entry) continue;
            entry.status = "rejected";
            entry.reviewed_by = "agent";
            entry.note = "agent_cleaned";
            cleaned++;
          }
          pb.updated_at = new Date().toISOString();
          await domain.table("playbooks").put(track, pb);
          return ok(`已清理 ${cleaned} 条重复/垃圾候选（标记 rejected，留痕 reviewed_by=agent）。`);
        }

        // ---- outdate（用户裁决淘汰 active 经验）----
        if (args.action === "outdate") {
          const ids = parseJsonArray(args.ids);
          if (ids === null || !Array.isArray(ids) || ids.length === 0) return fail("outdate 需要 ids 列表");
          let outdated = 0;
          for (const id of ids) {
            const entry = pb.entries.find((e) => e.id === id && e.status === "active");
            if (!entry) continue;
            entry.status = "outdated";
            entry.reviewed_by = "user";
            entry.note = "user_outdated";
            outdated++;
          }
          pb.updated_at = new Date().toISOString();
          await domain.table("playbooks").put(track, pb);
          return ok(`已标记 ${outdated} 条 active 经验为 outdated（留痕 reviewed_by=user）。`);
        }

        // ---- apply（用户裁决）----
        const decisions = parseJsonArray(args.decisions);
        if (decisions === null) return fail("decisions 必须是 JSON 数组");

        let accepted = 0, rejected = 0, modified = 0;
        const newlyActive = [];
        for (const d of decisions) {
          if (!d || typeof d !== "object") continue;
          const entry = pb.entries.find((e) => e.id === d.id && e.status === "pending");
          if (!entry) continue;
          if (d.decision === "reject") {
            entry.status = "rejected";
            entry.reviewed_by = "user";
            rejected++;
          } else if (d.decision === "modify" && d.modified && typeof d.modified === "object") {
            if (typeof d.modified.experience === "string" && d.modified.experience.trim()) entry.experience = d.modified.experience.trim();
            if (typeof d.modified.action === "string" && d.modified.action.trim()) entry.action = d.modified.action.trim();
            if (typeof d.modified.invalidates_when === "string" && d.modified.invalidates_when.trim()) entry.invalidates_when = d.modified.invalidates_when.trim();
            if (typeof d.modified.scope_kind === "string" && (d.modified.scope_kind === "global" || d.modified.scope_kind === "session")) {
              entry.scope = d.modified.scope_kind === "session"
                ? { kind: "session", id: agent.session.id }
                : { kind: "global", id: null };
            }
            entry.version = (entry.version || 1) + 1;
            entry.status = "active";
            entry.reviewed_by = "user";
            entry.note = "via_distill";
            newlyActive.push(entry);
            modified++;
          } else {
            entry.status = "active";
            entry.reviewed_by = "user";
            entry.note = "via_distill";
            newlyActive.push(entry);
            accepted++;
          }
        }
        pb.updated_at = new Date().toISOString();
        await domain.table("playbooks").put(track, pb);

        // 冲突检测：新 active 经验 vs 其他 active（LLM 分批全量，best-effort 不阻塞）
        let conflictNote = "";
        if (newlyActive.length > 0) {
          try {
            const others = pb.entries.filter((e) => e.status === "active" && !newlyActive.includes(e));
            const target = { provider: this.#distillProvider, model: this.#distillModel };
            const conflicts = [];
            for (const e of newlyActive) {
              const res = await detectConflicts(this.ctx, target, e, others, agent.session.id);
              conflicts.push(...res);
            }
            if (conflicts.length > 0) {
              conflictNote = "\n\n⚠️ 冲突提示（新经验与已有 active 疑似矛盾，请酌情处理）：\n" +
                conflicts.map((c) => `- ${c.a_id} ↔ ${c.b_id}: ${c.reason}`).join("\n");
            }
          } catch (e) {
            conflictNote = "\n\n⚠️ 冲突检测失败（不影响裁决结果）: " + (e?.message || e);
          }
        }

        return ok(`已应用裁决：收 ${accepted}、拒 ${rejected}、改 ${modified}。${conflictNote}`);
      },
    }));
  }

  /** 惰性打开 storage domain（避免 init 时序问题，首次使用时 open）。 */
  domain() {
    if (!this.#domainPromise) {
      this.#domainPromise = this.ctx.storage.domain.open(orbitDomain);
    }
    return this.#domainPromise;
  }

  /** 蒸馏某 track（核心，供 orbit_distill 与定时共用）。返回 { skipped?, count, candidates }。 */
  async distillTrackCore(track, sessionId, { full = false } = {}) {
    const domain = await this.domain();
    const allRings = [];
    for (const [, ring] of domain.table("rings").entries()) {
      if (ring.track === track) allRings.push(ring);
    }
    if (allRings.length === 0) return { skipped: true, count: 0, candidates: [] };

    // 增量：默认只蒸「已闭环(status completed/failed)且未蒸馏过」的环；full=true 时全量。
    const rings = full
      ? allRings
      : allRings.filter((r) => (r.status === "completed" || r.status === "failed") && r.distilled_at == null);
    if (rings.length === 0) return { skipped: true, count: 0, candidates: [] };

    const pb = domain.table("playbooks").get(track);
    const existingActive = pb
      ? pb.entries.filter((e) => e.status === "active").map((e) => e.experience)
      : [];

    const target = { provider: this.#distillProvider, model: this.#distillModel };
    const prompt = buildDistillPrompt(track, rings, existingActive);
    const text = await runLlm(this.ctx, target, prompt, sessionId ?? "(orbit-auto)");

    const candidates = parseCandidates(text);
    if (candidates === null) {
      throw new Error(`模型输出无法解析为经验 JSON。原始输出(截断):\n${text.slice(0, 800) || "(空)"}`);
    }

    const valid = [];
    // 存在性校验：evidence 引用的环必须真实存在，过滤 LLM 幻觉/写错的 id（本次实测发现 8213e098→6913e098 之类）。
    const validRingIds = new Set(allRings.map((r) => r.ring_id));
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const action = String(c.action ?? "").trim();
      const invalidates = String(c.invalidates_when ?? "").trim();
      const evidence = Array.isArray(c.evidence)
        ? c.evidence.filter((e) => typeof e === "string" && validRingIds.has(e))
        : [];
      if (!action || !invalidates || evidence.length === 0) continue; // 反废话三必填；幻觉 id 全被过滤则视为无效候选
      // scope 最小化：候选一律 global（track 承担世界隔离，embedding 做相关匹配）；
      // session 只在用户 review / experience_add 时手动指定（避免蒸馏按写入会话自动标注的错位）。
      const scopeKind = "global";
      const caseSummary = String(c.case_summary ?? "").trim();
      valid.push({
        id: `exp_${randomUUID().slice(0, 8)}`,
        experience: String(c.experience ?? "").trim(),
        action,
        evidence,
        invalidates_when: invalidates,
        scope: { kind: scopeKind, id: null },
        version: 1,
        status: "pending",
        created_at: new Date().toISOString(),
        ...(caseSummary ? { case_summary: caseSummary } : {}),
      });
    }

    // 回写蒸馏标记：无论产出多少候选，都把处理过的环标 distilled_at，避免下次重复蒸馏。
    const distilledAt = new Date().toISOString();
    for (const ring of rings) {
      ring.distilled_at = distilledAt;
      await domain.table("rings").put(ring.ring_id, ring);
    }

    if (valid.length > 0) {
      const newPb = pb ?? { track, entries: [], revision: 0, updated_at: new Date().toISOString() };
      newPb.entries = [...newPb.entries, ...valid];
      newPb.updated_at = new Date().toISOString();
      await domain.table("playbooks").put(track, newPb);
    }
    return { count: valid.length, candidates: valid };
  }

  /** 批量回填：对某 track 缺 case_summary 的 active 经验，用 LLM 生成摘要写回（一次性/按需，不产候选）。返回回填条数。 */
  async backfillCaseSummaries(track, sessionId) {
    const domain = await this.domain();
    const pb = domain.table("playbooks").get(track);
    if (!pb) return 0;
    const missing = pb.entries.filter((e) => e.status === "active" && !e.case_summary);
    if (missing.length === 0) return 0;

    // 从 evidence 环聚合上下文，喂给 LLM 生成一句话场景摘要
    const ringById = new Map();
    for (const [, r] of domain.table("rings").entries()) ringById.set(r.ring_id, r);
    const context = missing.map((e) => ({
      id: e.id,
      experience: e.experience,
      rings: e.evidence.map((rid) => {
        const r = ringById.get(rid);
        return r ? `${r.task} | 判据: ${r.done_when} | 结果: ${r.result?.done_when_met === true ? "达成" : r.result ? "未达成" : "未知"}` : rid;
      }),
    }));
    const prompt = [
      "为以下每条经验写一句「案例摘要」(case_summary):概括其依据环的共同场景/背景,帮助回看时快速理解适用语境。",
      "输出 JSON 对象 { \"<exp_id>\": \"一句话摘要\" },不要输出其他文字。",
      JSON.stringify(context, null, 2),
    ].join("\n");
    const target = { provider: this.#distillProvider, model: this.#distillModel };
    const text = await runLlm(this.ctx, target, prompt, sessionId ?? "(orbit-auto)");
    const summaries = parseJsonMap(text);
    if (!summaries) return 0;

    let n = 0;
    const now = new Date().toISOString();
    for (const e of pb.entries) {
      if (e.status === "active" && !e.case_summary && typeof summaries[e.id] === "string" && summaries[e.id].trim()) {
        e.case_summary = summaries[e.id].trim();
        n++;
      }
    }
    if (n > 0) {
      pb.updated_at = now;
      await domain.table("playbooks").put(track, pb);
    }
    return n;
  }

  /** 注入参考经验：配置了 embedding 则按任务相关性排序取 top3（过滤低于 embedMinScore 的，宁缺毋滥），否则顺序取3；embedding 失败回退顺序。返回 { text, injected, scores }。 */
  async injectExperiences(pb, sessionId, ring) {
    const matched = pb.entries.filter((e) => matchScope(e, sessionId));
    if (matched.length === 0) return { text: "", injected: [], scores: {} };
    let selected = matched.slice(0, 3);
    const scores = {};
    if (this.#embedProvider !== "off" && matched.length > 3) {
      try {
        const taskText = `${ring.task} 判据:${ring.done_when}${ring.assumption ? ` 假设:${ring.assumption}` : ""}`;
        const texts = matched.map((e) => `${e.experience} 动作:${e.action}`);
        const vectors = await embedTexts(this.#embedProvider, this.#embedUrl, this.#embedModel, this.#embedApiKey, this.#embedTimeoutMs, [taskText, ...texts]);
        const q = vectors[0];
        const scored = matched.map((e, i) => ({ e, score: cosine(q, vectors[i + 1]) }));
        scored.sort((a, b) => b.score - a.score);
        for (const s of scored) scores[s.e.id] = Number(s.score.toFixed(3));
        // 阈值过滤：低于 embedMinScore 的不注入（宁缺毋滥）；0=不过滤
        const filtered = this.#embedMinScore > 0 ? scored.filter((s) => s.score >= this.#embedMinScore) : scored;
        selected = filtered.slice(0, 3).map((x) => x.e);
      } catch (err) {
        // best-effort：embedding 失败静默回退顺序取3，不阻塞建环
        try { this.ctx.logger?.("orbit")?.warn?.(`embedding 注入失败,回退顺序取3: ${err?.message || err}`); } catch {}
        selected = matched.slice(0, 3);
      }
    }
    const lines = [`参考经验（track=${pb.track}）：`];
    selected.forEach((e, i) => lines.push(`${i + 1}. [${e.id}] ${formatExperience(e, i + 1).replace(/^\d+\. /, "")}`));
    if (selected.length === 0) {
      // 宁缺毋滥：全部低于阈值则不注入，但说明原因
      return { text: `（本环未注入参考经验：候选均低于相关性阈值 ${this.#embedMinScore}，宁缺毋滥）`, injected: [], scores };
    }
    // 采纳指令：引导 agent 显式标注采纳了哪条经验（方案B：提升 exp_id 出现率，供文本检测自动关联）
    lines.push("");
    lines.push(`💡 若你在本环实际参考了上面的经验，请在回复中标注你参考的那条的 id（见每条前的 [exp_xxx]），并在收口 orbit_ring_close 时填 adopted_experiences 报告采纳。`);
    return { text: lines.join("\n"), injected: selected.map((e) => e.id), scores };
  }

  /** 定时自动蒸馏全部 track，并通知收件 session。 */
  async autoDistill() {
    const domain = await this.domain();
    const tracks = new Set();
    for (const [, ring] of domain.table("rings").entries()) tracks.add(ring.track);
    if (tracks.size === 0) return;

    let total = 0;
    const perTrack = [];
    for (const track of tracks) {
      try {
        const r = await this.distillTrackCore(track, null);
        if (r.count > 0) { total += r.count; perTrack.push(`${track}:+${r.count}`); }
      } catch (e) {
        try { this.ctx.logger?.("orbit")?.warn?.(`track=${track} 蒸馏失败: ${e?.message || e}`); } catch {}
      }
    }
    if (total > 0) await this.notifyInbox(total, perTrack);
  }

  /** 通知（可选增强）：配了 url+targetId 就 HTTP 推送到接口；否则静默（靠 agent 对话对接）。 */
  async notifyInbox(total, perTrack) {
    if (!this.#notifyUrl || !this.#notifyTargetId) return;
    const text = `orbit 定时蒸馏完成：产出 ${total} 条待审经验（${perTrack.join(", ")}）。回复「review」查看并裁决。`;
    try {
      const res = await fetch(this.#notifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: this.#notifyTargetId, text }),
      });
      if (!res.ok) {
        try { this.ctx.logger?.("orbit")?.warn?.(`通知推送失败 http=${res.status}`); } catch {}
      }
    } catch (e) {
      // 通知是 best-effort，失败不影响主链
      try { this.ctx.logger?.("orbit")?.warn?.(`通知推送失败: ${e?.message || e}`); } catch {}
    }
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function requireAgent(exec) {
  const agent = exec?.agent;
  if (agent === undefined) throw new Error("orbit_* 工具需要一个调用 agent");
  return agent;
}

function arrOr(raw) {
  const v = parseJsonArray(raw);
  return v === null ? [] : v.filter((x) => typeof x === "string");
}

function dedupe(list) {
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))];
}

function dominantTrack(rings) {
  const counts = {};
  for (const r of rings) counts[r.track] = (counts[r.track] || 0) + 1;
  let best = "other", bestN = -1;
  for (const [t, n] of Object.entries(counts)) if (n > bestN) { best = t; bestN = n; }
  return best;
}

/** 采纳健康度：采纳了该经验的环的成功率（样本 n）。无采纳环返回 null。 */
function adoptionStats(entry, rings) {
  const adoptedRings = rings.filter(
    (r) => (r.adopted_experiences ?? []).includes(entry.id) && r.result && r.status === "completed"
  );
  const n = adoptedRings.length;
  if (n === 0) return null;
  const ok = adoptedRings.filter((r) => r.result.done_when_met === true).length;
  return { n, ok, rate: Math.round((ok / n) * 100) };
}

/** 把一条经验格式成可读文本。rings 可选：传入则附加采纳健康度行。 */
function formatExperience(e, i, rings) {
  const scope = e.scope?.kind === "session" ? `会话 ${e.scope.id}` : "通用";
  const stats = [];
  if ((e.injected_count ?? 0) > 0) stats.push(`展示 ${e.injected_count} 次`);
  if ((e.adopted_count ?? 0) > 0) stats.push(`采纳 ${e.adopted_count} 次`);
  const statLine = stats.length > 0 ? `   ⚙ ${stats.join(" · ")}${e.last_adopted_at ? ` · 最后采纳 ${e.last_adopted_at.slice(0, 10)}` : ""}` : null;
  const healthLine = rings && e.status === "active" ? (() => {
    const s = adoptionStats(e, rings);
    if (!s) return null;
    const flag = s.n < 3 ? "（样本不足）" : "";
    return `   健康度: 采纳环成功率 ${s.rate}%（样本 ${s.n}${s.n >= 3 ? "" : "，不足"}）`;
  })() : null;
  const caseLine = e.case_summary ? `   案例: ${e.case_summary}` : null;
  return [
    `${i}. 【经验】${e.experience}`,
    `   → 动作: ${e.action}`,
    `   依据: ${e.evidence.join(", ")}`,
    `   失效: ${e.invalidates_when}`,
    `   适用: ${scope}`,
    ...(statLine ? [statLine] : []),
    ...(healthLine ? [healthLine] : []),
    ...(caseLine ? [caseLine] : []),
  ].join("\n");
}

/** 把 playbook 内容格式成可读文本（供 orbit_playbook 返回）。rings 可选：传则显示健康度。 */
function formatPlaybook(pb, rings) {
  const active = pb.entries.filter((e) => e.status === "active");
  if (active.length === 0) return `track=${pb.track} 的 playbook（revision=${pb.revision}）暂无活跃经验。`;
  const lines = [`track=${pb.track} 的 playbook（revision=${pb.revision}），${active.length} 条活跃经验：`];
  active.forEach((e, i) => lines.push(formatExperience(e, i + 1, rings)));
  return lines.join("\n");
}

/** 判断一条经验是否适用于当前会话。 */
function matchScope(entry, sessionId) {
  if (entry.status !== "active") return false;
  if (entry.scope?.kind === "session") return entry.scope.id === sessionId;
  return true; // global
}

/** 疑似重复阈值：bigram Jaccard × 长度因子。宁多提示不少提示。 */
const DUP_THRESHOLD = 0.4;

/**
 * 在 playbook 里找与候选经验疑似重复的 active 条目（可插拔粗筛）。
 * 返回 { entry, score } 或 null。将来换 embedding 只改 textSimilarity 内部实现。
 */
function findDuplicate(pb, candidate) {
  let best = null;
  let bestScore = 0;
  for (const e of pb.entries) {
    if (e.status !== "active") continue;
    const s = textSimilarity(candidate.experience, e.experience);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return bestScore >= DUP_THRESHOLD ? { entry: best, score: bestScore } : null;
}

/**
 * 中文经验文本相似度：相邻两字符 bigram 集合的 Jaccard × 长度因子。
 * 零依赖、纯 JS；语义级替换（embedding）留待知识进化线阶段2。
 */
function textSimilarity(a, b) {
  const ga = bigramSet(a);
  const gb = bigramSet(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const jaccard = inter / (ga.size + gb.size - inter);
  const lenFactor = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return jaccard * Math.sqrt(lenFactor);
}

/** 相邻两字符集合（含空白过滤；单字文本退化为自身）。 */
function bigramSet(s) {
  const set = new Set();
  const t = (s ?? "").replace(/\s+/g, "");
  if (t.length === 0) return set;
  if (t.length === 1) {
    set.add(t);
    return set;
  }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 余弦相似度。 */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** fetch 带超时（embedding best-effort 用）。 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 文本向量化（可插拔 provider，与 memory core.js 统一 Ollama 路径）。
 * ollama: POST {url}/api/embed {model, input:[...]} → {embeddings}
 * openai: POST {url}/v1/embeddings {model, input:[...]} → {data:[{embedding}]}（骨架已实现，需 embedApiKey）
 * 失败抛错，调用方负责 fallback（注入回退顺序取3）。
 */
async function embedTexts(provider, url, model, apiKey, timeoutMs, texts) {
  if (provider === "ollama") {
    const res = await fetchWithTimeout(`${url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    }, timeoutMs);
    if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(`ollama embed 返回数量不符 ${data.embeddings?.length} != ${texts.length}`);
    }
    return data.embeddings;
  }
  if (provider === "openai") {
    if (!apiKey) throw new Error("embedProvider=openai 需要配置 embedApiKey");
    const res = await fetchWithTimeout(`${url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
    }, timeoutMs);
    if (!res.ok) throw new Error(`openai embed HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error("openai embed 返回数量不符");
    return data.data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }
  throw new Error(`embedProvider 未配置或未知: ${provider}`);
}

/**
 * 冲突检测：新经验 vs 一批已有经验（LLM 分批全量，无粗筛漏检）。
 * 返回 [{ a_id, b_id, reason }]。best-effort，解析失败返回空数组。
 */
async function detectConflicts(ctx, target, entry, others, sessionId) {
  const out = [];
  const BATCH = 10;
  for (let i = 0; i < others.length; i += BATCH) {
    const batch = others.slice(i, i + BATCH);
    const prompt = [
      "你是「经验冲突检测器」。判断【新经验】与下列每条【已有经验】是否语义冲突(同场景下结论/做法互相矛盾;主题相关但结论互补不算冲突)。",
      `新经验: ${entry.experience}`,
      "已有经验:",
      batch.map((o, idx) => `${idx}. ${o.id}: ${o.experience}`).join("\n"),
      "输出 JSON 数组,只列冲突的:[{\"index\": 0, \"reason\": \"一句话理由\"}] 没有冲突输出 []",
    ].join("\n");
    const text = await runLlm(ctx, target, prompt, sessionId ?? "(orbit-auto)");
    const arr = parseJsonArray(text);
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      const idx = Number(c?.index);
      const b = batch[idx];
      if (b && typeof c?.reason === "string") out.push({ a_id: entry.id, b_id: b.id, reason: c.reason });
    }
  }
  return out;
}

/** 冲突检测：已配好的经验对（health 全量扫描用）。返回 [{ a_id, b_id, reason }]。 */
async function detectConflictPairs(ctx, target, pairs, sessionId) {
  const out = [];
  const BATCH = 10;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const prompt = [
      "你是「经验冲突检测器」。判断下列经验对是否语义冲突(同场景下结论/做法互相矛盾;主题相关但结论互补不算冲突)。",
      batch.map((p, idx) => `${idx}. A: ${p[0].experience} / B: ${p[1].experience}`).join("\n"),
      "输出 JSON 数组,只列冲突的:[{\"index\": 0, \"reason\": \"一句话理由\"}] 没有冲突输出 []",
    ].join("\n");
    const text = await runLlm(ctx, target, prompt, sessionId ?? "(orbit-auto)");
    const arr = parseJsonArray(text);
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      const idx = Number(c?.index);
      const p = batch[idx];
      if (p && typeof c?.reason === "string") out.push({ a_id: p[0].id, b_id: p[1].id, reason: c.reason });
    }
  }
  return out;
}

/** 注入参考经验（类方法）：配置了 embedding 则按任务相关性排序取 top3，否则顺序取3；失败回退顺序。返回 { text, injected }。 */
// （injectExperiences 已移为 OrbitController 方法，见类内定义）

/** 检查当前会话是否有残留的 running 环（排除刚建的），返回提醒文本（无则空串）。 */
function checkResidualRings(domain, sessionId, excludeRingId) {
  const running = [];
  for (const [, ring] of domain.table("rings").entries()) {
    if (ring.ring_id === excludeRingId) continue;
    if (ring.status === "running" && ring.evidence?.session_id === sessionId) {
      running.push(`「${ring.task}」`);
    }
  }
  if (running.length === 0) return "";
  return `当前会话还有 ${running.length} 个进行中的环：${running.join("、")}。若已完成请先收尾（orbit_ring_close），若仍在进行请忽略。`;
}

/** 把一批条目格式成可读文本。 */
function formatEntries(entries) {
  return entries.map((e, i) => formatExperience(e, i + 1)).join("\n");
}

/** 插件内直接调模型（不经 agent turn），返回拼好的文本。 */
async function runLlm(ctx, target, prompt, sessionId) {
  const messages = [createUserMessage({
    content: [{ type: "text", text: prompt }],
    source: { kind: "plugin", plugin: "dsh-orbit" },
  })];
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: 2000,
    sessionId,
    purpose: "orbit.distill",
    reasoningEffort: "off", // 蒸馏要干净 JSON，关推理
  };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const blocks = assembler.blocks();
  return blocks
    .filter((b) => b.type === "text" || b.type === "reasoning")
    .map((b) => b.text)
    .join("");
}

/** 构建蒸馏 prompt：把环的客观字段喂给模型，要求产出结构化经验。 */
function buildDistillPrompt(track, rings, existingActive) {
  const ringData = rings.map((r) => ({
    id: r.ring_id,
    task: r.task,
    done_when: r.done_when,
    assumption: r.assumption,
    done_when_met: r.result?.done_when_met ?? null,
    assumption_broke: r.review?.assumption_broke ?? null,
    alignment: r.review?.alignment ?? null,
  }));
  const existing = existingActive.length
    ? `\n已沉淀的活跃经验(避免重复):\n- ${existingActive.join("\n- ")}`
    : "";
  return [
    "你是「任务经验蒸馏器」。分析某轨道上积累的任务环(每次实验的客观记录)，提炼出可复用的成品经验。",
    "",
    `轨道 track: ${track}`,
    "环数据:",
    JSON.stringify(ringData, null, 2),
    existing,
    "",
    "要求:",
    "- 去重、提炼、合并，只产出真正可复用的经验(不是对单个环的复述)",
    "- 每条必须可动作(action:下次具体做什么不同的事)、可证伪(invalidates_when:何时失效)、有依据(evidence:引用的环 id)",
    "- case_summary:用一句话概括这些依据环的共同场景/背景(如「某项目 L0-L7 迁移盘点时」),帮助回看时快速理解经验适用语境",
    "- 禁止「正确的废话」(不可动作/不可证伪的话，如『注重质量』『要及时反馈』)",
    "",
    "只输出 JSON 数组(不要输出 JSON 以外的任何文字):",
    '[{"experience":"经验一句","action":"具体动作","evidence":["ring_id"],"invalidates_when":"何时失效","case_summary":"场景一句话"}]',
  ].join("\n");
}

/** 从模型输出里提取经验数组(容错:兼容裸数组、markdown 围栏、对象包裹)。 */
function parseCandidates(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();
  // 1. 裸数组
  let m = t.match(/\[[\s\S]*\]/);
  if (m) {
    try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch {}
  }
  // 2. 对象包裹 { experiences|entries|candidates|items: [...] }
  m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj)) return obj;
      for (const k of ["experiences", "entries", "candidates", "items", "results"]) {
        if (Array.isArray(obj[k])) return obj[k];
      }
    } catch {}
  }
  return null;
}

/** 通过 native user-questions 请求确认（关键环 / playbook 合并 / 疑似重复共用）。 */
async function askApproval(ctx, agent, signal, target) {
  const interaction = ctx.get("userQuestions");
  if (interaction === undefined) return { approved: false }; // fail-closed
  try {
    const options = target.options ?? [
      { label: "批准", description: "允许" },
      { label: "拒绝", description: "跳过/丢弃" },
    ];
    const question = target.question ?? `确认「${target.title ?? target.task}」?`;
    const detail = target.done_when
      ? `判据: ${target.done_when}`
      : `操作: ${target.title ?? target.task ?? question}`;
    const answer = await interaction.ask({
      questions: [{
        id: "orbit-approve",
        header: "Orbit 确认",
        question,
        detail,
        options,
        intent: { kind: "orbit-approve", approve: options[0].label },
      }],
      agent,
      signal,
    });
    const item = (answer?.answers || []).find((a) => a.id === "orbit-approve");
    const approved = item?.selected?.length === 1 && item.selected[0] === options[0].label;
    // 开放录入（custom）：此前只读 selected，用户填写的文字会被静默丢弃。
    // 这里把 custom 一并取出交给调用点回显，保证用户输入不丢失（不改变批准判定）。
    const rawNote = item?.custom;
    const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim() : undefined;
    return { approved, note };
  } catch (cause) {
    if (cause instanceof UserQuestionError && cause.code === "ASK_CANCELLED") return { approved: false };
    throw cause;
  }
}

export { OrbitController, OrbitController as default };
