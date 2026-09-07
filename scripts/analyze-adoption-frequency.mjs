// analyze-adoption-frequency.mjs — 采纳信号回溯分析(方案A/B 观测)
// 对每个有注入记录的环:读会话日志,检测建环后 agent 文本是否引用注入经验。
// 按「指令/id标注」生效时点分组:baseline(无指令)/ instruction(指令无id标注)/ annotated(指令+id标注)。
// 当前会话(session-f005c5b1)含大量元讨论会假阳性,单独分栏。只读,不改数据。
// Usage: node scripts/analyze-adoption-frequency.mjs [--detail]
import { execSync } from "node:child_process";

const ORBIT_JSON = process.env.ORBIT_JSON || "/Users/sifangwan/.dsh/storages/orbit.json";
const SESS_DIR = "/Users/sifangwan/.dsh/sessions/--Users-sifangwan-dsh-workspace--";
const SELF_SESSION = "session-f005c5b1"; // 当前会话(含元讨论,单独统计)
const DETAIL = process.argv.includes("--detail");

const { readFileSync } = await import("node:fs");
const data = JSON.parse(readFileSync(ORBIT_JSON, "utf8"));
const rings = Object.values(data.tables.rings);
const injRings = rings.filter((r) => (r.injected_experiences ?? []).length > 0);

function sessionFile(sid) {
  const base = sid.startsWith("session-") ? sid : `session-${sid}`;
  try {
    const dir = execSync(`ls -d "${SESS_DIR}/${base}"* 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
    return dir ? `${dir}/session.jsonl.zstd` : null;
  } catch { return null; }
}
function readSession(sid) {
  const f = sessionFile(sid);
  if (!f) return null;
  try {
    const out = execSync(`zstd -dc "${f}" 2>/dev/null`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

// 显式引用模式
const EXPLICIT_PATTERNS = [/注入的经验[^。]{0,30}/, /参考经验[^。]{0,40}/, /提醒我[^。]{0,40}/, /经验提醒[^。]{0,30}/, /经验提示[^。]{0,30}/, /参考了[^。]{0,30}/];
const hasExplicitRef = (t) => EXPLICIT_PATTERNS.some((re) => re.test(t));
// id 引用:注入的 exp_id 出现在文本,或 agent 用 [exp_xxx] 方括号形式
const hasExpId = (t, ids) => ids.some((id) => t.includes(id));
const hasBracketId = (t) => /\[exp_[0-9a-f]{8}\]/.test(t);

// 时段分界:指令验证环 / id标注验证环 的创建时间
const timeOf = (rid) => injRings.find((r) => r.ring_id === rid)?.created_at ?? "";
const INSTRUCTION_AT = timeOf("ring_838816bf");      // 指令生效确认(第一个带指令的环)
const ANNOTATED_AT = timeOf("ring_c416ffcd");        // id 标注生效确认
function periodOf(r) {
  const t = r.created_at ?? "";
  if (!INSTRUCTION_AT) return t ? "?" : "?";
  if (t < INSTRUCTION_AT) return "baseline";
  if (!ANNOTATED_AT || t < ANNOTATED_AT) return "instruction";
  return "annotated";
}

const rows = [];
for (const ring of injRings) {
  const sid = ring.evidence?.session_id;
  const expIds = ring.injected_experiences ?? [];
  const events = readSession(sid);
  if (!events) { rows.push({ ring: ring.ring_id, period: periodOf(ring), session: sid, note: "日志不可读" }); continue; }
  const taskKey = ring.task.slice(0, 20);
  let createSeq = -1;
  for (const e of events) {
    if (e.type === "tool/call") {
      const d = e.data || {};
      const argStr = JSON.stringify(d.arguments ?? d.args ?? d);
      if ((d.name === "orbit_ring_create" || argStr.includes("orbit_ring_create")) && argStr.includes(taskKey)) { createSeq = e.seq ?? 0; break; }
    }
  }
  if (createSeq < 0) {
    for (const e of events) {
      if (e.type === "tool/call" && JSON.stringify(e.data ?? {}).includes("orbit_ring_create")) { createSeq = e.seq ?? 0; break; }
    }
  }
  let postText = "";
  for (const e of events) {
    if ((e.seq ?? -1) <= createSeq) continue;
    if (e.type === "assistant/message") {
      for (const b of (e.data?.message?.content ?? [])) {
        if ((b.type === "text" || b.type === "reasoning") && typeof b.text === "string") postText += "\n" + b.text;
      }
    } else if (e.type === "text-chunks") postText += (e.data?.text ?? "");
  }
  rows.push({
    ring: ring.ring_id, period: periodOf(ring), session: sid.startsWith(SELF_SESSION) ? "self" : "other",
    track: ring.track, task: ring.task.slice(0, 30), created: (ring.created_at ?? "").slice(5, 16),
    explicit: hasExplicitRef(postText), hasId: hasExpId(postText, expIds), bracketId: hasBracketId(postText),
    snippet: extractSnippet(postText),
  });
}

// 汇总(分时段 × 分会话类型)
console.log(`有注入环: ${injRings.length} | 指令生效: ${(INSTRUCTION_AT || "?").slice(5, 16)} | id标注生效: ${(ANNOTATED_AT || "?").slice(5, 16)}\n`);
for (const sess of ["other", "self"]) {
  const rows_s = rows.filter((r) => r.session === sess && !r.note);
  const periods = ["baseline", "instruction", "annotated"];
  console.log(`=== ${sess === "other" ? "独立会话(可信)" : "当前会话(含元讨论)"} ===`);
  for (const p of periods) {
    const rp = rows_s.filter((r) => r.period === p);
    if (!rp.length) continue;
    const expN = rp.filter((r) => r.hasId).length;
    const expB = rp.filter((r) => r.bracketId).length;
    const expR = rp.filter((r) => r.explicit).length;
    const adopted = rp.filter((r) => r.hasId || r.bracketId).length;
    console.log(`  [${p}] ${rp.length} 环 | exp_id 引用 ${expN} (${((expN / rp.length) * 100).toFixed(0)}%) | [exp_]形式 ${expB} (${((expB / rp.length) * 100).toFixed(0)}%) | 显式引用 ${expR} | 可关联 ${adopted} (${((adopted / rp.length) * 100).toFixed(0)}%)`);
    if (DETAIL) for (const r of rp) console.log(`      ${r.created} ${r.ring} | ${r.track} | ${r.task} | id:${r.hasId ? "✅" : "—"} | [exp_]:${r.bracketId ? "✅" : "—"} | ${(r.snippet ?? "").slice(0, 45)}`);
  }
  console.log();
}

function extractSnippet(text) {
  for (const re of EXPLICIT_PATTERNS) { const m = text.match(re); if (m) return m[0]; }
  const m = text.match(/\[?exp_[0-9a-f]{8}\]?/); return m ? m[0] : null;
}
