# Orbit CHANGELOG(版本与功能记录)

> 更新: 2026-09-02
> 本文件是公开的版本与功能记录(面向使用者/维护者);设计演进与路线图见本地 .internal/。

---

## 版本记录(功能演进)

| 版本 | 能力 | 一句话 |
|---|---|---|
| 1.0 | 核心闭环 | 环(假设→任务→done_when→结果)/ 复盘 / playbook / 蒸馏 / review 过门 / 通知 |
| 2.0.0 | 流程纪律线 | review 拆两道(clean by:agent / apply by:user) / 残留提醒 / 增量蒸馏 / prompt 收口纪律 / reflect 收口检查站 |
| 2.1.0 | 可度量 | 双轨度量(注入打点 + 采纳报告) / 案例摘要 / playbook 统计显示 |
| 2.2.0 | 可检验 | 健康度(采纳环成功率) / orbit_health(建议淘汰 + 冲突对) / 写入时冲突检测 / review outdate |

## 2. 工具面(9 个)

| 工具 | 用途 |
|---|---|
| `orbit_ring_create` | 建环(注入参考经验 + 打点 injected_count + 残留提醒) |
| `orbit_ring_close` | 收口(记结果;可填 adopted_experiences 报告采纳,打点 adopted_count,回显注入列表) |
| `orbit_ring_review` | 内环纠偏(alignment / assumption_broke / affects_future) |
| `orbit_reflect` | 外环复盘 + 收口检查站(未收口环 / 未纠偏环 / 重复复盘三检查) |
| `orbit_experience_add` | 手动沉淀成品经验(重复检测 + evidence 存在性校验 + 冲突提示 + 确认卡过门) |
| `orbit_distill` | 蒸馏候选(增量 / full 全量 / backfill 回填案例摘要) |
| `orbit_playbook` | 读 playbook(统计 + 健康度 + 案例摘要) |
| `orbit_health` | 健康度报告(建议淘汰 + 冲突对,LLM 全量扫描,best-effort) |
| `orbit_review` | review 过门:list / clean(agent) / apply(user,收后自动冲突检测,modify 支持 scope_kind) / outdate(active→outdated) |

## 3. 数据模型(domain v6)

### 环(ring)
```
ring_id / goal_id / track / assumption / reason / task / done_when / critical
status: running | awaiting_approval | completed | failed | skipped
result: { done_when_met, summary, findings[], risks[] }
review: { alignment, assumption_broke, affects_future, next_focus }
evidence: { session_id, seq_start, seq_end }
distilled_at: null | 时间戳        // 蒸馏状态
injected_experiences: []            // 建环时注入的参考经验 id
adopted_experiences: []             // 收口时报告采纳的经验 id
created_at / updated_at
```

### 经验(experience,playbook 条目)
```
id / experience / action / evidence[] / invalidates_when
scope: { kind: global | session, id }   // 默认 global;session 仅用户 review/experience_add 手动指定(蒸馏不自动标)
version / status: pending | active | rejected | outdated
reviewed_by: agent | user(nullable)    // 裁决人
note: 附加说明(via_distill / via_experience_add / agent_cleaned / user_outdated …)
injected_count / adopted_count         // 双轨度量
last_injected_at / last_adopted_at
case_summary                           // 案例摘要(蒸馏生成/backfill 回填)
created_at
```

### playbook
```
track / entries[] / revision / updated_at
```

## 4. 核心流程(闭环)

```
建环(注入参考经验,打点 injected_count)
  → 收口(记结果;报告采纳 adopted_experiences,打点 adopted_count)
  → 纠偏(orbit_ring_review,可选)
  → goal 收口前复盘(orbit_reflect,收口检查站)
  → 蒸馏(增量,产候选 pending;可 backfill 案例摘要)
  → review 过门(clean by:agent / apply by:user;写入时冲突检测)
  → active 经验下次建环注入
```

**双轨度量**:注入打点(自动,展示)= injected_count;采纳报告(agent 收口时填,使用)= adopted_count。
**健康度**:采纳该经验的环成功率(样本<3 标不足)。
**淘汰**:health 建议(展示≥3 未采纳 / 采纳环全失败样本≥3 / 超90天未采纳)→ 用户 outdate。
**冲突检测**:写入时(apply/experience_add)LLM 分批全量 vs 全部 active;health 全量扫描兜底。

## 5. 流程纪律(硬规则)

- prompt 收口纪律:环必须收口 / goal 收口必须先复盘 / 经验必须过用户门
- 唯一硬约束点:goal complete 前必须先 orbit_reflect(检查站会列出未收口/未纠偏环)
- 其余靠提醒(残留提醒 / 待审提醒)

## 6. 版本历史

| tag | 内容 |
|---|---|
| v1.0 | 核心闭环 |
| v2.0.0 | 流程纪律线 |
| v2.1.0 | 可度量(双轨 + 案例摘要) |
| v2.2.0 | 可检验(健康度 + 淘汰 + 冲突) |

## 7. 已知边界

- **冲突判断有误报**:LLM 可能把「互补」判成「矛盾」;报告是建议性质,靠用户裁决。
- **采纳归因粗粒度**:一环注入多条经验,无法归因单条贡献;健康度是集合级统计。
- **双轨度量语义**:injected=展示(自动),adopted=使用(agent 自我报告,有漏报/误报噪声)。
- **重复检测粗筛**:字符相似度(可插拔,预留 embedding 升级)。
- **未实现(设计后置)**:阶段3 策略层+经验层,实施需先经真实运行数据验证(见本地 ROADMAP)。

## 8. 安装与配置

```bash
dsh plugin --profile web add github:clawdwan/orbit-dsh-plugin
```

配置(cordis.patch.yml,dsh-orbit):`notifyUrl` / `notifyTargetId`(飞书通知,可选)/
`distillIntervalSeconds`(定时蒸馏周期)/ `distillProvider` / `distillModel`。

验证: `node verify-orbit.mjs`(路径可 `ORBIT_DEPLOYED` / `ORBIT_DOMAIN` 覆盖)。
