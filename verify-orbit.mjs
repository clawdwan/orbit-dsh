// Mock-instantiation harness for dsh-orbit.
// Imports the DEPLOYED copy from the dsh profile's node_modules (deps resolve there);
// does NOT touch the running web. Catches load-time errors (defineDomain / zod / tool schema).
// Usage: node verify-orbit.mjs
// 路径可被环境变量覆盖（ORBIT_DEPLOYED / ORBIT_DOMAIN），默认指向本地部署副本。

const DEPLOYED = process.env.ORBIT_DEPLOYED || "/Users/sifangwan/.dsh/profiles/node_modules/dsh-orbit/lib/index.js";
const DOMAIN = process.env.ORBIT_DOMAIN || "/Users/sifangwan/.dsh/profiles/node_modules/dsh-orbit/lib/domain.js";

const tools = [];
const sections = [];

const mockCtx = {
  reflect: { provide() {} },
  tools: { register(tool) { tools.push(tool.name); } },
  systemPrompt: { section(spec) { sections.push(spec.name); } },
  storage: { domain: { open: async () => { throw new Error("mock: domain.open 不应在构造期被调用"); } } },
  goals: { get: () => undefined },
  llm: { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }) },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  interval: () => () => {},  // timer：no-op
  get() { return undefined; },
  effect() { return () => {}; },
};

try {
  // 1. Import domain.js — runs defineDomain + zod schema compile at load (fail-loud risk).
  const d = await import(DOMAIN);
  if (!d.orbitDomain || d.orbitDomain.name !== "orbit") throw new Error("orbitDomain 异常");
  if (d.orbitDomain.version !== 6) throw new Error(`版本应为 6，实际 ${d.orbitDomain.version}`);
  if (!d.experienceEntrySchema) throw new Error("experienceEntrySchema 未导出");
  if (d.normalizeTrack("Analysis") !== "analysis") throw new Error("normalizeTrack 异常");
  if (d.normalizeTrack("bogus") !== "other") throw new Error("normalizeTrack 回退异常");

  // 2. Import the plugin — Service + tools must compile.
  const mod = await import(DEPLOYED);
  const Ctor = mod.default ?? mod.OrbitController;
  // 回归守卫：注入声明必须覆盖所有 ctx.* 依赖（上次漏 timer 导致 fail-loud）。
  const REQUIRED_INJECT = ["tools", "systemPrompt", "storage", "goals", "llm", "timer"];
  for (const s of REQUIRED_INJECT) {
    if (!Array.isArray(Ctor.inject) || !Ctor.inject.includes(s)) throw new Error(`inject 声明缺少 "${s}"`);
  }
  const instance = new Ctor(mockCtx, {});
  if (typeof instance !== "object") throw new Error("Service 实例化失败");

  // 3. 流程纪律回归守卫：prompt 收口纪律段 + reflect 收口检查站（防未来误删关键规则）。
  const fs = await import("node:fs");
  const src = fs.readFileSync(DEPLOYED, "utf8");
  for (const phrase of ["收口纪律", "update_goal complete 之前", "orbit_ring_close", "收口检查", "疑似重复", "via_experience_add", "adopted_experiences", "injected_count", "backfillCaseSummaries", "case_summary", "orbit_health", "outdate", "采纳环成功率", "冲突提示", "embedTexts", "embedProvider", "embedMinScore", "orbit_weekly_distill"]) {
    if (!src.includes(phrase)) throw new Error(`部署副本缺少流程纪律关键短语: ${phrase}`);
  }

  console.log("domain.name:", d.orbitDomain.name, "| tables:", Object.keys(d.orbitDomain.tables).join(","));
  console.log("registered tools:", JSON.stringify(tools));
  console.log("systemPrompt sections:", JSON.stringify(sections));
  console.log("VERIFY_PASS");
} catch (err) {
  console.error("VERIFY_FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
}
