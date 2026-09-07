// ============================================================
// scripts/embed-inject-test.mjs — 评估「embedding 相关性排序注入」vs「当前顺序取3」
// 数据:真实 orbit 数据(config track active 经验 + 真实历史任务文本)
// embedding:本机 Ollama qwen3-embedding(与 memory 统一路径)
// 指标:每个任务的 embedding top3 平均余弦 vs 顺序 top3 平均余弦 + 重合度
// Usage: node scripts/embed-inject-test.mjs
// ============================================================

import { readFileSync } from "node:fs";

const ORBIT_JSON = process.env.ORBIT_JSON || "/Users/sifangwan/.dsh/storages/orbit.json";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.EMBED_MODEL || "qwen3-embedding:0.6b";
const TOP_N = 3;

async function embed(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed 失败: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error(`embed 返回数量不符: ${data.embeddings?.length} != ${texts.length}`);
  }
  return data.embeddings;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- 数据 ----------
const data = JSON.parse(readFileSync(ORBIT_JSON, "utf8"));
const pb = data.tables.playbooks.config;
const active = pb.entries.filter((e) => e.status === "active");
console.log(`config active 经验: ${active.length} 条\n`);

// 经验文本(注入时展示的内容)
const expTexts = active.map((e) => `${e.experience} 动作:${e.action}`);

// 真实任务文本(config 历史环的 task)
const tasks = [
  "实现强化 prompt 三步收口硬规则:policy 加收口纪律段 + reflect 升级收口检查站",
  "实现 experience_add 机制加固:重复检测(可插拔粗筛)+ 留痕 + evidence 存在性校验",
  "实现 orbit 2.1.0「可度量」:domain v6 + 双轨打点 + 收口回显 + 案例摘要 + playbook 统计",
  "实现 orbit 2.2.0「可检验」:健康度显示 + orbit_health + 冲突检测 + review outdate",
  "实测 v5:确认 review 拆两道与残留提醒功能可用",
];

// ---------- embedding 全部 ----------
console.log(`调 Ollama embed(${MODEL})...`);
const taskEmbs = await embed(tasks);
const expEmbs = await embed(expTexts);
console.log("完成\n");

// ---------- 评估 ----------
const seqTop3 = active.slice(0, TOP_N);
const seqTop3Scores = tasks.map((t, ti) => seqTop3.map((e, ei) => ({
  id: e.id, score: cosine(taskEmbs[ti], expEmbs[active.indexOf(e)]),
})));
// 注:上面 active.indexOf(e) 与 expEmbs 对齐;seqTop3 是 active 前 3

let totalEmb = 0, totalSeq = 0, overlapTotal = 0;
console.log("=".repeat(110));
console.log("任务 | embedding top3 (分数) | 顺序 top3 (分数) | 重合 | 平均分 emb/seq");
console.log("=".repeat(110));

for (let ti = 0; ti < tasks.length; ti++) {
  const scores = active.map((e, ei) => ({ id: e.id, score: cosine(taskEmbs[ti], expEmbs[ei]) }));
  scores.sort((a, b) => b.score - a.score);
  const embTop = scores.slice(0, TOP_N);
  const seqTop = active.slice(0, TOP_N).map((e) => ({ id: e.id, score: scores.find((s) => s.id === e.id).score }));

  const embAvg = embTop.reduce((s, x) => s + x.score, 0) / TOP_N;
  const seqAvg = seqTop.reduce((s, x) => s + x.score, 0) / TOP_N;
  const overlap = embTop.filter((x) => seqTop.some((y) => y.id === x.id)).length;
  totalEmb += embAvg; totalSeq += seqAvg; overlapTotal += overlap;

  console.log(`T${ti + 1}`);
  console.log(`  ${tasks[ti].slice(0, 45)}`);
  console.log(`  emb: ${embTop.map((x) => `${x.id}(${x.score.toFixed(3)})`).join(" ")}`);
  console.log(`  seq: ${seqTop.map((x) => `${x.id}(${x.score.toFixed(3)})`).join(" ")}`);
  console.log(`  重合 ${overlap}/3 | 平均 emb=${embAvg.toFixed(3)} seq=${seqAvg.toFixed(3)}`);
}

console.log("=".repeat(110));
console.log(`汇总(5 任务): embedding 平均分 ${(totalEmb / tasks.length).toFixed(3)} vs 顺序平均分 ${(totalSeq / tasks.length).toFixed(3)}`);
console.log(`提升: ${(((totalEmb - totalSeq) / (totalSeq || 1)) * 100).toFixed(1)}%`);
console.log(`重合率: ${overlapTotal}/15 (${((overlapTotal / 15) * 100).toFixed(0)}%)`);
console.log("\n【解读】重合率低 + emb 平均分高 = embedding 显著改变了选择且更相关;");
console.log("重合率高 = 顺序取 3 恰好也相关(经验少时正常),embedding 价值有限。");
