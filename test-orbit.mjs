// ============================================================
// test-orbit.mjs — orbit 行为测试（直接调用工具 execute）
// 覆盖 2.x 核心业务逻辑：建环/注入打点/残留提醒、收口/采纳、纠偏、
// 复盘检查站、experience_add（校验/重复/冲突/留痕）、蒸馏（增量/幻觉过滤）、
// playbook 显示、health（淘汰/冲突）、review（list/clean/apply/outdate）。
// 用内存 domain + 假 LLM，不触碰真实数据与网络。
// Usage: node test-orbit.mjs  （路径可 ORBIT_DEPLOYED / ORBIT_DOMAIN 覆盖）
// ============================================================

import assert from "node:assert/strict";

const DOMAIN = process.env.ORBIT_DOMAIN || "/Users/sifangwan/.dsh/profiles/node_modules/dsh-orbit/lib/domain.js";
const DEPLOYED = process.env.ORBIT_DEPLOYED || "/Users/sifangwan/.dsh/profiles/node_modules/dsh-orbit/lib/index.js";

const { orbitDomain } = await import(DOMAIN);
const { default: OrbitController } = await import(DEPLOYED);

// ------------------------------------------------------------
// mock 基础设施
// ------------------------------------------------------------

/** 内存版 domain：Map 存储，put 时 zod parse（模拟真实校验，能抓 schema 不匹配）。 */
function createMemoryDomain(spec) {
  const stores = new Map();
  for (const name of Object.keys(spec.tables)) stores.set(name, new Map());
  return {
    table(name) {
      const store = stores.get(name);
      const valueSchema = spec.tables[name]?.valueSchema;
      return {
        get(key) { return store.get(key); },
        put(key, value) {
          const parsed = valueSchema ? valueSchema.parse(structuredClone(value)) : value;
          store.set(key, parsed);
          return parsed;
        },
        entries() { return [...store.entries()]; },
      };
    },
  };
}

/** 假 LLM：按调用顺序弹出预设响应（字符串），产出 BlockAssembler 兼容的流。 */
class MockLLM {
  constructor(responses = []) { this.queue = [...responses]; this.calls = 0; }
  async *stream() {
    this.calls++;
    const text = this.queue.shift() ?? "[]";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
  }
}

/** askApproval 假交互：approve=true 选 options[0]，false 选 options[1]。 */
function createUserQuestions({ approve = true } = {}) {
  return {
    async ask({ questions }) {
      const q = questions[0];
      const picked = approve ? q.options[0].label : (q.options[1]?.label ?? q.options[0].label);
      return { answers: [{ id: q.id, selected: [picked] }] };
    },
  };
}

const SESSION_ID = "test-session";
const GOAL_ID = "goal-test";
const mockAgent = { session: { id: SESSION_ID, events: [] } };

function createMockCtx({ llm, userQuestions, goal }) {
  const tools = [];
  return {
    ctx: {
      reflect: { provide() {} },
      tools: { register(tool) { tools.push(tool); } },
      systemPrompt: { section() {} },
      storage: { domain: { open: async (spec) => createMemoryDomain(spec) } },
      goals: { get: () => goal ?? null },
      llm: { stream: (...a) => llm.stream(...a) },
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      interval: () => () => {},
      get(key) { return key === "userQuestions" ? userQuestions : undefined; },
      effect() { return () => {}; },
    },
    tools,
  };
}

/** 每个用例的独立环境。config 传给 OrbitController（embedding 等配置）。 */
async function freshEnv({ llmResponses = [], approve = true, goal = { id: GOAL_ID }, config = {} } = {}) {
  const llm = new MockLLM(llmResponses);
  const userQuestions = createUserQuestions({ approve });
  const { ctx, tools } = createMockCtx({ llm, userQuestions, goal });
  const inst = new OrbitController(ctx, config);
  const domain = await inst.domain(); // 触发 storage.domain.open,拿到解析后的 domain
  const exec = { agent: mockAgent, signal: { aborted: false } };
  return {
    inst, tools, llm,
    domain: () => domain,
    run: async (name, args) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `工具 ${name} 未注册`);
      return tool.execute(args, exec);
    },
  };
}

/** 构造环对象（补全 schema 必填）。 */
function makeRing(id, over = {}) {
  return {
    ring_id: id, goal_id: GOAL_ID, track: "config",
    assumption: "", reason: "", task: `任务${id}`, done_when: "判据",
    critical: false, status: "running", result: null, review: null,
    evidence: { session_id: SESSION_ID, seq_start: 1, seq_end: null },
    distilled_at: null, injected_experiences: [], adopted_experiences: [],
    created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z",
    ...over,
  };
}

/** 构造经验条目（补全 schema 必填）。 */
function makeExp(id, over = {}) {
  return {
    id, experience: `经验${id}`, action: "动作", evidence: ["ring_x"],
    invalidates_when: "失效条件", scope: { kind: "global", id: null },
    version: 1, status: "active", created_at: "2026-08-24T00:00:00.000Z",
    ...over,
  };
}

async function putPb(env, track, entries, revision = 1) {
  await env.domain().table("playbooks").put(track, {
    track, entries, revision, updated_at: "2026-08-24T00:00:00.000Z",
  });
}

async function putRing(env, ring) {
  await env.domain().table("rings").put(ring.ring_id, ring);
}

// ------------------------------------------------------------
// 测试用例
// ------------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- A. 建环 / 注入打点 / 残留提醒 ----------

test("A1 建环:无 active goal 时 fail", async () => {
  const env = await freshEnv({ goal: null });
  const r = await env.run("orbit_ring_create", { task: "t", done_when: "d", track: "config" });
  assert.equal(r.ok, false);
  assert.match(r.message, /没有 active goal/);
});

test("A2 建环:环写入 domain,status=running", async () => {
  const env = await freshEnv();
  const r = await env.run("orbit_ring_create", { task: "t1", done_when: "d1", track: "analysis" });
  assert.equal(r.ok, true);
  const ringId = r.ring.ring_id;
  const ring = env.domain().table("rings").get(ringId);
  assert.equal(ring.status, "running");
  assert.equal(ring.track, "analysis");
  assert.equal(ring.evidence.session_id, SESSION_ID);
});

test("A3 注入打点:注入后 exp.injected_count=1 且 ring 记 injected_experiences", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2")]);
  const r = await env.run("orbit_ring_create", { task: "t", done_when: "d", track: "config" });
  assert.equal(r.ok, true);
  const pb = env.domain().table("playbooks").get("config");
  const e1 = pb.entries.find((e) => e.id === "exp_1");
  assert.equal(e1.injected_count, 1);
  const ring = env.domain().table("rings").get(r.ring.ring_id);
  assert.ok(ring.injected_experiences.includes("exp_1"));
  assert.ok(ring.injected_experiences.includes("exp_2"));
});

test("A4 残留提醒:会话已有 running 环时,create 返回提醒", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_stale", { task: "旧环未收口" }));
  const r = await env.run("orbit_ring_create", { task: "新环", done_when: "d", track: "config" });
  assert.equal(r.ok, true);
  assert.match(r.message, /当前会话还有 1 个进行中的环/);
  assert.match(r.message, /旧环未收口/);
});

// ---------- B. 收口 / 采纳 ----------

test("B1 收口:done_when_met=true → completed", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1"));
  const r = await env.run("orbit_ring_close", { ring_id: "ring_1", done_when_met: true, summary: "成功" });
  assert.equal(r.ok, true);
  const ring = env.domain().table("rings").get("ring_1");
  assert.equal(ring.status, "completed");
  assert.equal(ring.result.done_when_met, true);
  assert.ok(ring.evidence.seq_end !== null);
});

test("B2 收口:done_when_met=false → failed", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1"));
  await env.run("orbit_ring_close", { ring_id: "ring_1", done_when_met: false, summary: "失败" });
  const ring = env.domain().table("rings").get("ring_1");
  assert.equal(ring.status, "failed");
});

test("B3 采纳:close 填 adopted_experiences → exp.adopted_count=1 且 ring 记录", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2")]);
  await putRing(env, makeRing("ring_1", { injected_experiences: ["exp_1", "exp_2"] }));
  const r = await env.run("orbit_ring_close", {
    ring_id: "ring_1", done_when_met: true, summary: "ok",
    adopted_experiences: JSON.stringify(["exp_1"]),
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /采纳 exp_1/);
  const pb = env.domain().table("playbooks").get("config");
  assert.equal(pb.entries.find((e) => e.id === "exp_1").adopted_count, 1);
  assert.equal(pb.entries.find((e) => e.id === "exp_2").adopted_count, 0);
  const ring = env.domain().table("rings").get("ring_1");
  assert.deepEqual(ring.adopted_experiences, ["exp_1"]);
});

test("B4 采纳:非法 adopted(不在注入列表)被忽略", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1")]);
  await putRing(env, makeRing("ring_1", { injected_experiences: ["exp_1"] }));
  const r = await env.run("orbit_ring_close", {
    ring_id: "ring_1", done_when_met: true, summary: "ok",
    adopted_experiences: JSON.stringify(["exp_bogus"]),
  });
  assert.equal(r.ok, true);
  const ring = env.domain().table("rings").get("ring_1");
  assert.deepEqual(ring.adopted_experiences, []);
});

// ---------- C. 纠偏 ----------

test("C1 ring_review:记录纠偏", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1"));
  const r = await env.run("orbit_ring_review", {
    ring_id: "ring_1", alignment: "drifted", assumption_broke: true, affects_future: true, next_focus: "X",
  });
  assert.equal(r.ok, true);
  const ring = env.domain().table("rings").get("ring_1");
  assert.equal(ring.review.alignment, "drifted");
  assert.equal(ring.review.assumption_broke, true);
});

// ---------- D. 复盘检查站 ----------

test("D1 reflect:goal 下无环时 fail", async () => {
  const env = await freshEnv();
  const r = await env.run("orbit_reflect", { summary: "复盘" });
  assert.equal(r.ok, false);
  assert.match(r.message, /没有环/);
});

test("D2 reflect:有 running 环时检查站列出未收口", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1", { task: "未收口环" }));
  const r = await env.run("orbit_reflect", { summary: "复盘" });
  assert.equal(r.ok, true);
  assert.match(r.message, /1 个环未收口/);
  assert.match(r.message, /未收口环/);
});

test("D3 reflect:正常复盘写入 reflections", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1", { status: "completed", result: { done_when_met: true, summary: "s", findings: [], risks: [] } }));
  const r = await env.run("orbit_reflect", { summary: "复盘完成", what_worked: JSON.stringify(["w"]) });
  assert.equal(r.ok, true);
  assert.match(r.message, /收口检查/);
  const reflections = [...env.domain().table("reflections").entries()];
  assert.equal(reflections.length, 1);
  assert.equal(reflections[0][1].summary, "复盘完成");
});

// ---------- E. experience_add ----------

test("E1 experience_add:缺 action fail", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1"));
  const r = await env.run("orbit_experience_add", {
    track: "config", experience: "e", action: "", evidence: JSON.stringify(["ring_1"]), invalidates_when: "x",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /action 必填/);
});

test("E2 experience_add:evidence 不存在 fail", async () => {
  const env = await freshEnv();
  const r = await env.run("orbit_experience_add", {
    track: "config", experience: "e", action: "a", evidence: JSON.stringify(["ring_bogus"]), invalidates_when: "x",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /环都不存在/);
});

test("E3 experience_add:重复检测命中,用户放弃 → 不写入", async () => {
  const env = await freshEnv({ approve: false });
  await putRing(env, makeRing("ring_1"));
  await putPb(env, "config", [makeExp("exp_1", { experience: "默认权限模型常比预想更严格,第三方插件不能随意写事件" })]);
  const r = await env.run("orbit_experience_add", {
    track: "config", experience: "默认权限模型通常比预期更严格,第三方插件不能随意写会话事件",
    action: "a", evidence: JSON.stringify(["ring_1"]), invalidates_when: "x",
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /疑似重复/);
  const pb = env.domain().table("playbooks").get("config");
  assert.equal(pb.entries.filter((e) => e.status === "active").length, 1); // 未新增
});

test("E4 experience_add:正常写入,留痕 reviewed_by=user + note=via_experience_add", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1"));
  const r = await env.run("orbit_experience_add", {
    track: "config", experience: "新经验", action: "新动作", evidence: JSON.stringify(["ring_1"]), invalidates_when: "失效",
  });
  assert.equal(r.ok, true);
  const pb = env.domain().table("playbooks").get("config");
  const e = pb.entries.find((x) => x.experience === "新经验");
  assert.ok(e);
  assert.equal(e.reviewed_by, "user");
  assert.equal(e.note, "via_experience_add");
});

test("E5 experience_add:冲突检测(假 LLM 返回冲突)→ 返回含冲突提示", async () => {
  const env = await freshEnv({ llmResponses: [JSON.stringify([{ index: 0, reason: "结论互相矛盾" }])] });
  await putRing(env, makeRing("ring_1"));
  await putPb(env, "config", [makeExp("exp_old", { experience: "盘点必须严格分离不动环境" })]);
  const r = await env.run("orbit_experience_add", {
    track: "config", experience: "盘点发现问题应当场直接修复", action: "a",
    evidence: JSON.stringify(["ring_1"]), invalidates_when: "x",
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /冲突提示/);
  assert.match(r.message, /exp_old/);
});

// ---------- F. 蒸馏 ----------

test("F1 蒸馏:增量只蒸未蒸馏环,回写 distilled_at", async () => {
  const env = await freshEnv({
    llmResponses: [JSON.stringify([{ experience: "候选经验", action: "动作", evidence: ["ring_1"], invalidates_when: "失效", case_summary: "案例" }])],
  });
  const done = new Date().toISOString();
  await putRing(env, makeRing("ring_1", { status: "completed", result: { done_when_met: true, summary: "s", findings: [], risks: [] } }));
  await putRing(env, makeRing("ring_2", { status: "completed", result: { done_when_met: true, summary: "s", findings: [], risks: [] }, distilled_at: done }));
  const r = await env.run("orbit_distill", { track: "config" });
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1);
  const ring1 = env.domain().table("rings").get("ring_1");
  assert.ok(ring1.distilled_at !== null); // 未蒸馏的被处理
  const pb = env.domain().table("playbooks").get("config");
  assert.equal(pb.entries.filter((e) => e.status === "pending").length, 1);
});

test("F2 蒸馏:幻觉 id 过滤(候选 evidence 引用不存在的环→过滤)", async () => {
  const env = await freshEnv({
    llmResponses: [JSON.stringify([
      { experience: "好候选", action: "a", evidence: ["ring_1"], invalidates_when: "x" },
      { experience: "坏候选", action: "a", evidence: ["ring_bogus"], invalidates_when: "x" },
    ])],
  });
  await putRing(env, makeRing("ring_1", { status: "completed", result: { done_when_met: true, summary: "s", findings: [], risks: [] } }));
  const r = await env.run("orbit_distill", { track: "config" });
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1); // 只有好候选
  assert.match(r.message, /好候选/);
  assert.doesNotMatch(r.message, /坏候选/);
});

// ---------- G. playbook 显示 ----------

test("G1 playbook:统计/健康度/案例摘要显示", async () => {
  const env = await freshEnv();
  await putRing(env, makeRing("ring_1", {
    status: "completed",
    result: { done_when_met: true, summary: "s", findings: [], risks: [] },
    adopted_experiences: ["exp_1"],
  }));
  await putPb(env, "config", [makeExp("exp_1", {
    injected_count: 3, adopted_count: 1, last_adopted_at: "2026-08-24T00:00:00.000Z",
    case_summary: "某项目迁移时",
  })]);
  const r = await env.run("orbit_playbook", { track: "config" });
  assert.equal(r.ok, true);
  assert.match(r.message, /展示 3 次/);
  assert.match(r.message, /采纳 1 次/);
  assert.match(r.message, /采纳环成功率/);
  assert.match(r.message, /案例: 某项目迁移时/);
});

// ---------- H. health ----------

test("H1 health:建议淘汰(展示≥3 未采纳)", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [
    makeExp("exp_stale", { injected_count: 5, adopted_count: 0 }),
    makeExp("exp_fresh", { injected_count: 1, adopted_count: 0 }),
  ]);
  const r = await env.run("orbit_health", { track: "config" });
  assert.equal(r.ok, true);
  assert.match(r.message, /exp_stale/);
  assert.match(r.message, /从未被采纳/);
  assert.doesNotMatch(r.message, /exp_fresh/); // 展示 1 次不算
});

test("H2 health:冲突对(假 LLM 返回冲突)", async () => {
  const env = await freshEnv({
    llmResponses: [JSON.stringify([{ index: 0, reason: "结论矛盾" }])],
  });
  await putPb(env, "config", [makeExp("exp_a"), makeExp("exp_b")]);
  const r = await env.run("orbit_health", { track: "config" });
  assert.equal(r.ok, true);
  assert.match(r.message, /exp_a ↔ exp_b/);
  assert.match(r.message, /结论矛盾/);
});

// ---------- I. review ----------

test("I1 review:list pending", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1", { status: "pending" }), makeExp("exp_2", { status: "active" })]);
  const r = await env.run("orbit_review", { track: "config", action: "list" });
  assert.equal(r.ok, true);
  assert.match(r.message, /1 条待审经验/);
  assert.match(r.message, /exp_1/);
});

test("I2 review:clean → rejected + reviewed_by=agent + note=agent_cleaned", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1", { status: "pending" })]);
  const r = await env.run("orbit_review", { track: "config", action: "clean", ids: JSON.stringify(["exp_1"]) });
  assert.equal(r.ok, true);
  const e = env.domain().table("playbooks").get("config").entries[0];
  assert.equal(e.status, "rejected");
  assert.equal(e.reviewed_by, "agent");
  assert.equal(e.note, "agent_cleaned");
});

test("I3 review:apply accept → active + reviewed_by=user + note=via_distill", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1", { status: "pending" })]);
  const r = await env.run("orbit_review", { track: "config", action: "apply", decisions: JSON.stringify([{ id: "exp_1", decision: "accept" }]) });
  assert.equal(r.ok, true);
  const e = env.domain().table("playbooks").get("config").entries[0];
  assert.equal(e.status, "active");
  assert.equal(e.reviewed_by, "user");
  assert.equal(e.note, "via_distill");
});

test("I4 review:apply modify scope_kind=session → scope 变化", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1", { status: "pending" })]);
  const r = await env.run("orbit_review", {
    track: "config", action: "apply",
    decisions: JSON.stringify([{ id: "exp_1", decision: "modify", modified: { scope_kind: "session" } }]),
  });
  assert.equal(r.ok, true);
  const e = env.domain().table("playbooks").get("config").entries[0];
  assert.equal(e.scope.kind, "session");
  assert.equal(e.scope.id, SESSION_ID);
});

test("I5 review:apply reject → rejected + reviewed_by=user", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1", { status: "pending" })]);
  await env.run("orbit_review", { track: "config", action: "apply", decisions: JSON.stringify([{ id: "exp_1", decision: "reject" }]) });
  const e = env.domain().table("playbooks").get("config").entries[0];
  assert.equal(e.status, "rejected");
  assert.equal(e.reviewed_by, "user");
});

test("I6 review:outdate → active 标记 outdated + user_outdated", async () => {
  const env = await freshEnv();
  await putPb(env, "config", [makeExp("exp_1")]);
  const r = await env.run("orbit_review", { track: "config", action: "outdate", ids: JSON.stringify(["exp_1"]) });
  assert.equal(r.ok, true);
  const e = env.domain().table("playbooks").get("config").entries[0];
  assert.equal(e.status, "outdated");
  assert.equal(e.reviewed_by, "user");
  assert.equal(e.note, "user_outdated");
});

test("I7 review:apply 后冲突检测(假 LLM 返回冲突)→ 返回含冲突提示", async () => {
  const env = await freshEnv({
    llmResponses: [JSON.stringify([{ index: 0, reason: "与已有经验矛盾" }])],
  });
  await putPb(env, "config", [
    makeExp("exp_old", { experience: "盘点严格分离" }),
    makeExp("exp_new", { status: "pending", experience: "盘点顺手修复" }),
  ]);
  const r = await env.run("orbit_review", { track: "config", action: "apply", decisions: JSON.stringify([{ id: "exp_new", decision: "accept" }]) });
  assert.equal(r.ok, true);
  assert.match(r.message, /冲突提示/);
});

// ---------- J. embedding 注入匹配 ----------

/** mock fetch：返回预设向量（ollama /api/embed 响应）。 */
function mockFetchEmbed(vectors) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/embed")) return { ok: true, json: async () => ({ embeddings: vectors }) };
    throw new Error(`mock fetch 未覆盖: ${url}`);
  };
  return () => { globalThis.fetch = realFetch; };
}

test("J1 embedding 注入:配置 ollama 后按相关性排序取 top3(非顺序前3)", async () => {
  // 任务向量与第 4 条经验最接近 → 注入应含 exp_4
  const vectors = [
    [1, 0, 0, 0],   // 任务
    [0, 1, 0, 0],   // exp_1(顺序第1)
    [0, 0, 1, 0],   // exp_2
    [0, 0, 0, 1],   // exp_3
    [1, 0.1, 0, 0], // exp_4(与任务最相关)
  ];
  const restore = mockFetchEmbed(vectors);
  try {
    const env = await freshEnv({ config: { embedProvider: "ollama", embedUrl: "http://mock", embedModel: "m", embedTimeoutMs: 1000, embedMinScore: 0 } });
    await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2"), makeExp("exp_3"), makeExp("exp_4")]);
    const r = await env.run("orbit_ring_create", { task: "任务X", done_when: "d", track: "config" });
    assert.equal(r.ok, true);
    assert.ok(r.ring.injected_experiences.includes("exp_4"), "embedding 应把最相关的 exp_4 选入");
    assert.equal(r.ring.injected_experiences.length, 3);
  } finally {
    restore();
  }
});

test("J2 embedding 注入:fetch 失败回退顺序取3,不阻塞建环", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const env = await freshEnv({ config: { embedProvider: "ollama", embedUrl: "http://mock", embedModel: "m", embedTimeoutMs: 1000 } });
    await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2"), makeExp("exp_3"), makeExp("exp_4")]);
    const r = await env.run("orbit_ring_create", { task: "任务X", done_when: "d", track: "config" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ring.injected_experiences, ["exp_1", "exp_2", "exp_3"]); // 回退顺序
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("J3 embedding 阈值:低于 embedMinScore 的经验被过滤(宁缺毋滥)", async () => {
  // 4 条经验:仅 exp_4 与任务高分(~0.995),其余低分(~0) → 只注入 exp_4
  const vectors = [
    [1, 0, 0, 0, 0],   // 任务
    [0, 1, 0, 0, 0],   // exp_1(低分)
    [0, 0, 1, 0, 0],   // exp_2(低分)
    [0, 0, 0, 1, 0],   // exp_3(低分)
    [1, 0.1, 0, 0, 0], // exp_4(高分)
  ];
  const restore = mockFetchEmbed(vectors);
  try {
    const env = await freshEnv({ config: { embedProvider: "ollama", embedUrl: "http://mock", embedModel: "m", embedTimeoutMs: 1000, embedMinScore: 0.5 } });
    await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2"), makeExp("exp_3"), makeExp("exp_4")]);
    const r = await env.run("orbit_ring_create", { task: "任务X", done_when: "d", track: "config" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ring.injected_experiences, ["exp_4"]); // 只注入高分那条
    assert.ok(r.ring.injected_scores.exp_4 > 0.5);
    assert.ok(r.ring.injected_scores.exp_1 < 0.5);
  } finally {
    restore();
  }
});

test("J4 embedding 阈值:全部低于阈值 → 0 条注入(宁缺毋滥)", async () => {
  const vectors = [
    [1, 0], // 任务
    [0, 1], // exp_1(低分 0)
    [0, 1], // exp_2
    [0, 1], // exp_3
    [0, 1], // exp_4
  ];
  const restore = mockFetchEmbed(vectors);
  try {
    const env = await freshEnv({ config: { embedProvider: "ollama", embedUrl: "http://mock", embedModel: "m", embedTimeoutMs: 1000, embedMinScore: 0.5 } });
    await putPb(env, "config", [makeExp("exp_1"), makeExp("exp_2"), makeExp("exp_3"), makeExp("exp_4")]);
    const r = await env.run("orbit_ring_create", { task: "任务X", done_when: "d", track: "config" });
    assert.equal(r.ok, true);
    assert.equal((r.ring.injected_experiences ?? []).length, 0); // 全过滤,不注入
    assert.match(r.message, /未注入参考经验/);
  } finally {
    restore();
  }
});

// ------------------------------------------------------------
// runner
// ------------------------------------------------------------

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log("  ✓", t.name);
  } catch (e) {
    failed++;
    console.error("  ✗", t.name);
    console.error("    ", e && e.message ? e.message.split("\n").join("\n     ") : e);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("TEST_PASS");
