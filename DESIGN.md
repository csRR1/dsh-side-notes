# DSH 旁注插件（Side Notes）设计文档

> 状态：设计定稿（v2，2026-11-22）。L0 起步阶段，尚未实现业务代码。
> v2 相对 v1 的变化：§1 已完成 7 项接口验证（结论在 §15）；里程碑从 M1–M4 改为 L0–L7；批注缩到助手消息级；项目备忘入口改为左栏底部按钮；新增 §16 分发与版本。

---

## 0. 一句话目标

让用户在主 agent **正在干活时**也能随时表达想法，并且这些想法**不会粗暴打断**主任务：问题走旁路回答，修正攒到停顿点批量投递，紧急情况才立即插话。

**非目标**：不做第二套聊天客户端；不替换 composer；不自建模型路由（L7 之前）；不做多用户权限；不做跨机器同步；不做导出（用户已明确只要 localStorage 级持久）。

---

## 1. 已验证的事实（含出处与验证结论）

### 1.1 客户端插件骨架（模板已验证）

| 能力 | 事实 | 出处 |
|---|---|---|
| 客户端插件格式 | 纯 JS 免构建：`window.__ModuleLoader__.load({ id, factory(require){…} })`；React 走 `require('react')` | `skills/dsh-doc/templates/decoration/client.js` |
| 客户端清单 | `package.json` 里 `dsh.client = { platform:'web', immediately, inject:[…] }`，并导出 `"./client"` | 同模板 `package.json` |
| 槽位注册 | `ctx.slots.inject(name, () => ctx.slots.register({ name, id, order }, Component))`，在 `apply(ctx)` 里做，返回 dispose | 同模板 `client.js` |
| Host 侧 | `index.js` 导出 `apply(ctx)`（M1 可为空壳）；`cordis.patch.yml` 插入 host 行 | 同模板 `index.js` / `cordis.patch.yml` |

### 1.2 运行时能力（2026-11-22 实测验证，结论见 §15）

| 能力 | 结论 | 关键符号 |
|---|---|---|
| 客户端提交 steer | ✅ 可行 | `ctx.sessions.scope(id)` → `sessionOf(actx)` → `SessionFace.prompt(content, 'queue'\|'steer', signal?, requestId?)`；先 `beginSubmission()` 登记回显 |
| 写 composer 草稿 | ✅ 文字可写，⚠️ 无聚焦 API | `inputActions.setDraft(text)`、`addAttachments(ids)`、`submit()` |
| 工具卡片批注槽位 | ❌ 不存在 | 只有 `conversation.chat.assistant-actions`（助手消息动作列表）/ `conversation.chat.turnTail`（轮次结尾 chain）/ `conversation.chat.node`（整体替换渲染器，不用） |
| 右侧栏 tab | ✅ 可注册并自动打开，❌ 无 `pin`/`keepMounted` | `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })`；`createSidebarRightController().openTab(kind, opts)` + `expand()` |
| 工作区右键菜单 | ❌ 不存在 | 替代：`sidebar.footer.action`（左栏底部，设置旁） |
| 附件上传 | ✅ 可调，但只拿"暂存凭证"，持久化发生在 prompt 准入 | `ctx.fileUpload.upload(sessionId, blob, name, signal, onProgress)`；`ctx.conversation.createDrafts(sessionId, File[])` |
| 附件生命周期 | ✅ 无 GC 风险（永不删除） | `dsh-attachment` README："附件永远不会被删除" |

> 注意：v1 里写的 `conversation.chat.user.before` 槽位、tab 的 `keepMounted` 字段，**在本版本均不存在**，已从设计中移除。

---

## 2. 用户流程

### 2.1 三条入口

```
主对话（agent 正在干活）
│
├─ 入口 A · 旁注      composer 旁便签图标 / Alt+Enter
│                     输入半句话 → 进收件箱（默认不打断）
│
├─ 入口 B · 批注      助手消息右上角「批注」（仅助手消息级）
│                     留一条意见 → 同一收件箱，带消息锚点
│
└─ 入口 C · 旁问      右侧栏 tab
                      问问题 → 档 1/2/3 回答 → 「插回主线」
```

- 项目备忘入口：左栏**底部、设置齿轮旁**的「备忘」按钮（`sidebar.footer.action`），点击打开右侧栏「项目」视图。

### 2.2 三档分流（自动，可手动覆盖）

| 档 | 回答者 | 触发 | 成本 |
|---|---|---|---|
| 1 | 不调模型，面板本地渲染 | 快照能直接答（"做到哪了/下一步"） | 0 |
| 2 | 单次轻量 LLM 调用（快照 + 问题，无工具） | 解释、判断、总结类 | ~1k token |
| 3 | 子代理会话（有工具） | 需要读代码/查文档/跑命令 | 高 |

**自动规则（先规则，不调模型）**

- 含 `?`/`？`/“为什么/怎么/是不是/啥意思/能吗”→ **问题**
- 含“改成/换成/不要/加上/删掉/停/别” → **需求**
- 以“记一下/待办/别忘了”开头 → **备忘**（只存档）
- 问题 → 档 1 优先；快照命中不到 → 档 2；用户显式“去查” → 档 3
- 需求 → 收件箱（默认在停顿点投递）；带“现在/立刻/停” → 立即 steer

**人为覆盖**：输入框右侧三档切换（`自动 | 旁问 | 插话`），默认“自动”；投递后 5 秒内可“撤回改投递方式”。

### 2.3 默认策略（已确认）

- **攒着**：默认不打断，收件箱按“停顿点”投递。
- 停顿点 = 主会话无 running turn；到点后**自动投递 + 10 秒可拦截**（[立即]/[取消]），三道闸门：① 主输入框有草稿或聚焦 → 延后；② 最后 10 秒还在写 → 延后；③ 两次投递间隔 ≥30 秒，每小时 ≤20 次。
- 一次最多 3 条合并投递、合计 ≤400 token，其余排队。
- 可在设置里整体切换为“立即插话”。
- **插话不打断正在跑的工具调用**：普通旁注等 step 边界投递；只有紧急词（停/立刻/马上/别做了）触发 `cancel()`，且写操作前二次确认。

---

## 3. 界面

```
┌──────────────────────────────┬─────────────────────┐
│ 主对话                        │ 旁注  [会话][项目] ⚙ │
│                              │ ┌─────────────────┐ │
│  ▸ 用户消息 ………              │ │ 进度 ▓▓▓▓░░ 4/9  │ │
│  ▸ 工具卡片 ………              │ │ 正在: 生成第4页   │ │
│  ▸ agent 输出 …… [✎ 批注]   │ ├─────────────────┤ │
│                              │ │ 收件箱 (3)       │ │
│  ┌────────────────────────┐  │ │ ☐ 改成 B 方案     │ │
│  │ 输入框          [🗒 3]  │  │ │ ☐ 图太小 ↳第4步  │ │
│  └────────────────────────┘  │ │ [发送到主线]      │ │
│                              │ ├─────────────────┤ │
│                              │ │ 旁问              │ │
│                              │ │ Q: 卡在哪了？      │ │
│                              │ │ A: 在等导出…      │ │
│                              │ │ [→ 插回主线]      │ │
│                              │ └─────────────────┘ │
└──────────────────────────────┴─────────────────────┘
```

- 右侧栏顶部一个分段开关 `[会话][项目]`：会话 = 本次收件箱；项目 = 该工作区长期备忘。
- tab 类型：`id = dsh-side-notes/notes`，`kind = side-notes`。
- **无 `keepMounted`**：切 tab 会卸载组件，故面板状态一律放在 React 之外的 store（store.js）。
- composer dock：一个 28×28 **便签图标**（非 `+`）+ 未读数角标。
- 批注：**仅助手消息**右上角 hover 出现小图标（`conversation.chat.assistant-actions`）。
- 项目备忘入口：左栏底部「备忘」按钮（`sidebar.footer.action`）。
- 视觉规范：右栏 320–360px；全用 DSH 主题 token；条目单行 32px，hover 才出操作；无阴影（仅浮层/灯箱有）；120ms 淡入。

---

## 4. 架构

### 4.1 包结构（单包双端，零依赖免构建）

```
dsh-side-notes/
├─ package.json          # dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # 插入 host 行
├─ index.js              # host: apply(ctx)，M1 为空壳
├─ client.js             # 浏览器入口，__ModuleLoader__.load
├─ src/                  # 客户端内部模块（纯 JS，无构建）
│   ├─ store.js          # 收件箱 / 项目备忘 / 设置
│   ├─ snapshot.js       # 主任务快照采集
│   ├─ router.js         # 三档分流规则
│   ├─ answerer.js       # Answerer 接口 + 三实现
│   ├─ panel.js          # 旁注面板组件
│   ├─ composer-dock.js  # composer 便签按钮
│   └─ annotate.js       # 助手消息批注
├─ locale/zh.json, en.json
├─ docs/DETAIL.md
└─ icon.svg
```

### 4.2 数据流

```
用户输入
  → router.classify()            （纯规则，0 token）
  → { kind: question | requirement | memo, urgency }
  → question → answerer.tier1(snapshot) → 命中? 渲染 : tier2(snapshot, q) → 渲染
  → requirement → inbox.enqueue({ text, target, createdAt })
  → inbox.flush() 在“停顿点”触发
  → deliver(): steer 投递（不可用 → 写草稿 → 复制兜底）
```

### 4.3 Answerer 抽象（三档可替换）

```js
interface Answerer {
  id: 'local' | 'llm' | 'subagent'
  canAnswer(question, snapshot): boolean
  answer(question, snapshot, { signal, onDelta }): AsyncIterable<string>
}
```

### 4.4 主任务快照（≤ 600 token）

从 session projection 取（projection 名称 L4 开工第一件事确认）：

```json
{
  "turn": 7,
  "lastUserAsk": "把实验报告做成 12 页答辩 PPT",
  "plan": ["1 收集素材", "2 设计规范", "3 逐页生成"],
  "recentSteps": [
    { "tool": "pwsh", "summary": "python svg_to_pptx.py", "ok": true }
  ],
  "filesTouched": ["design_spec.md"],
  "blockedOn": null,
  "pendingNotes": ["改成 B 方案", "图太小"]
}
```

**硬约束**：不塞全文、不塞历史消息原文、不塞工具输出内容（只一行摘要）。超出预算截断。

### 4.5 投递实现（三级降级，已验证 1、2 级可行）

1. **steer 投递**（最优）：`SessionFace.prompt([{type:'text',text}], 'steer')`（先 `beginSubmission()` 登记回显）。
2. **写草稿 + 聚焦**（次优）：`inputActions.setDraft(text)` 写进 composer（聚焦走 DOM，无公开 API）。
3. **复制到剪贴板 + 提示**（兜底）。

### 4.6 图片（本地草稿，不转持久）

- 存储：**IndexedDB**（`dsh-side-notes/images`），列表缩略图 320px WebP（约 20KB），原图压缩到长边 ≤1600px 质量 0.82。
- 入口：`Ctrl+V` 粘贴 / 拖入 / 选文件。
- 拖出到 composer：`ctx.conversation.createDrafts(sessionId, [File])` → `inputActions.addAttachments([id])`。
- **不做**"首次发送转持久"：图片永远浏览器本地；清浏览器数据/换机器即丢（用户已接受）。agent 看不到备忘里的图（除非拖出发送）。

---

## 5. 数据与持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| 收件箱、批注、旁问 | `localStorage['dsh.side-notes.v1.session.<sessionId>']` | 会话绑定 |
| 项目备忘 | `localStorage['dsh.side-notes.v1.workspace.<workspaceId>']` | 跨会话、跨标签页（`storage` 事件同步） |
| 最近删除（A 方案） | 同上 value 内 `deleted[]` | 最多 20 条、7 天自动清、面板底部折叠 |
| 备忘图片 | IndexedDB `dsh-side-notes/images` | blob，引用计数清理 |
| 插件配置 | host `Config` schema（L6 加） | `defaultMode: 'queue' \| 'steer'` 等 |

- workspaceId 用 `ctx.workspaces` 拿，key 用 **id 不用显示名**（改名不丢）。
- 存储失败不能影响主对话（try/catch + 内存兜底）；版本化 key，解析失败即清该 key。
- **不做导出**：仅 localStorage/IndexedDB 级持久（用户明确要求）。

---

## 6. Token 预算与省钱原则

| 场景 | 预算 |
|---|---|
| 快照 | ≤ 600 token，只摘要 |
| 档 2 单次提问 | ≤ 1.5k 输入 / ≤ 300 输出，无历史 |
| 一次投递 | ≤ 3 条、合计 ≤ 400 token |
| 单轮插件总开销 | 目标 < 1k token，不在主流程额外调模型 |

**省钱的核心不是少写字，是"少让它白干"**：

1. 攒着 + 合并：3 条 = 1 次激活，且不打断正在跑的步骤（打断导致重读文件/重跑命令才是大头）。
2. 投递文本只写"用户意图"，绝不附上下文（主会话本来就有）。
3. 投递永远追加在末尾，绝不原地改写历史（保前缀缓存命中）。
4. 档 3 子会话用全新会话（不 fork，避免复制主上下文）。
5. 投递格式引导"一次处理完"（编号列表 + "不必逐条回复"）。
6. 分类纯规则 0 token；档 1 答案本地拼 0 token；快照不用模型生成。
7. 旁问默认无状态；档 2 每小时限 10 次；收件箱上限 20 条。
8. 绝不把插件说明写进 system prompt。
9. 自动投递节流：冷却 30s + 每小时 20 次上限。

---

## 7. 里程碑（L0–L7）

| 层级 | 交付 | 验收（用户可亲手验） | 模型 |
|---|---|---|---|
| ✅ **L0** | 空壳插件挂载：composer dock 一个绿勾图标 + 控制台 `[side-notes] L0 apply ok` | F5 后能看到图标 | Pro / high |
| ✅ **L1** | 收件箱：便签入口/Alt+Enter、增删/暂缓、未读角标、停顿点自动投递(10s 拦截)、steer+草稿降级、状态点、持久化 | 长命令时写 3 条 → 停顿点一次收到 | Pro(原型) / Flash(批量) |
| ✅ **L2** | 项目备忘：左栏底部按钮、工作区级存储、跨会话同步、与收件箱互转、删除+最近删除、勾完成、图片(IndexedDB)拖入拖出 | A 会话写 2 条 → 新开 B 会话仍在 | Pro / high（用户指定，未用 Flash） |
| ✅ **L3** | 助手消息批注：`assistant-actions` 加 ✎、按消息聚合、合并投递、5 秒撤回 | 给两条助手消息各批注 → 合并一条 | Pro / high |
| ✅ **L4** | 旁问档 1：快照 + 进度条 + 本地回答（做到哪了/下一步/卡在哪/文件） | 问"做到哪了" 1 秒出、0 token | Pro / high |
| ✅ **L5** | 旁问档 3：全新子会话 + 插回主线 | 问"找 X 调用点" → 结果一键插回 | Pro / high |
| ✅ **L6** | 设置(≤5 项)、冲突提示、i18n、错误边界、DETAIL.md、README 发布 | 改设置立刻生效；禁用再启用正常 | Flash / low |
| **L7** | （可选）档 2 流式通道 | 只在觉得慢时做 | Pro / high |

**时间**：L0 15–30 分钟；L1 1.5–2.5h；L2 1.5–2h；L3 30–50 分钟；L4 40–70 分钟；L5 1–2h；L6 40–80 分钟。合计约 7–10.5 小时。**最小可用 = L0+L1+L2 ≈ 3.5–5 小时**。建议一个里程碑一个会话。

**每层结束都停**，给你三样：`DESIGN.md` 进度勾选 + 一句话"改了什么/怎么验/已知限制" + 等你回"过"。只有 L0 必须单独停。

---

## 8. 安装与验证

```text
plugin_manager install_bundle target=D:\sk--harness\dsh-side-notes
plugin_manager list_plugins    # failed / overridden / restart-required 分别处理
```

- 本地目录安装会 **link** checkout（改文件 + 刷新页面生效；删目录即失效）。
- 客户端改动：无 `pnpm run dev:web`（打包安装版），**靠刷新页面**生效。
- host 改动：替换已安装包需重启 DSH。
- 无法截图时（无浏览器控制工具）：以"你看到的 + 控制台错误"为准。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| slot / API 在 DSH 升级后变更 | 槽位注册集中在 `src/register.js`；启动自检失败显示"插件需更新"，不黑屏 |
| 面板崩溃拖垮主对话 | 组件外层 ErrorBoundary，降级为一行提示 |
| steer 投递不可用 | 三级降级（草稿 → 复制） |
| 投递过于频繁 | 单次 3 条 + 停顿点节流（30s 冷却 / 每小时 20 次） |
| 收件箱数据损坏 | 版本化 key + 解析失败即清该 key |
| 图片孤儿累积 | IndexedDB 引用计数 + 最近删除 7 天清理 |

回滚：禁用 bundle 即可，不影响已有会话。

---

## 10. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 默认打断策略 | 攒着（停顿点自动投递 + 10s 拦截） | 频繁插话反复切任务更慢 |
| 档位选择 | 自动 + 手动覆盖 | 自动覆盖 90% 场景 |
| 档 2 实现顺序 | 最后（L7） | 需新 RPC，最大工程量 |
| 批注粒度 | 仅助手消息级 | 工具卡片/用户消息无槽位（已验证） |
| 项目备忘入口 | 左栏底部按钮 | 工作区右键菜单无槽位（已验证） |
| 项目备忘归属 | 按 workspaceId | 跨会话、改名不丢 |
| 备忘导出 | 不做 | 用户只要 localStorage 级持久 |
| 删除保护 | 最近删除（20 条 / 7 天，折叠） | 无导出，防误删 |
| 图片存储 | IndexedDB，不转持久 | 持久附件只在 prompt 准入时生成 |
| 图片拖出 | `createDrafts` + `addAttachments` | 公开 API，非 DataTransfer hack |
| 分发 | GitHub + npm，零依赖免构建 | 朋友 clone 即装，不引入构建 |
| 投递上限 | 3 条/次、400 token | 保护上下文 |
| 开发边界 | 不联网、不碰 DSH 源码、不改 profile | 隐私 + 可回滚 |

---

## 11. 模型与推理档位分配

### 可用路由（2026-11 本机 UI 实测）

| 模型 | 版本 | 上下文 | Vision | 备注 |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 1M | 支持 | 便宜、快 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 不支持 | 更强，约 3–4 倍价 |

> 子代理默认不用 Pro，要用得显式指定。

### 官方定价（USD / 1M tokens）

| | flash 闲时 | flash 高峰 | pro 闲时 | pro 高峰 |
|---|---|---|---|---|
| 输入（缓存命中） | 0.003 | 0.006 | 0.022 | 0.044 |
| 输入（未命中） | 0.15 | 0.30 | 0.66 | 1.32 |
| 输出 | 0.60 | 1.20 | 1.98 | 3.96 |

### 分配建议

| 阶段 | 模型 | 档位 | 理由 |
|---|---|---|---|
| L0 / L1a 投递链 / L3 挂点 / L4 快照 / L5 子会话 | **pro** | high | 判断接口存不存在，错了重写架构 |
| L1b / L2 面板、CRUD、样式 | flash | high | 机械活 |
| L6 文案、i18n、README | flash | low 或 off | |

**不要全程 max**。max 只在卡住且必须自己想明白时开单轮。

---

## 12. 会话节奏（省 token）

1. 一个里程碑一个会话；超长会话每轮重发历史是最大隐性成本。
2. 每个会话开头先读本文件（§13）。
3. 阶段结束时 `/compact`。
4. 关键状态写文件，不写进聊天。
5. 需要查代码的问题走档 3 子会话，主线不背包袱。

---

## 13. 交接协议（新会话必须遵守）

| 步骤 | 做什么 | 禁止 |
|---|---|---|
| 0 | 只读：读完本文件 + 列目录现状 | 禁止写文件、装插件、改配置 |
| 1 | 复述：用户要什么 / 默认策略 / 三档分流 / 投递降级 / 分层；列不确定点与顺序 | 禁止写业务代码 |
| 2 | 等待：等用户回"开始" | 禁止自行推进 |
| 3 | 确认后：先做 L0 挂载验证，再逐层推进 | 禁止跳过验证直接写 UI |

若用户只说"继续"，视为仅继续步骤 0–1 的复述，不等于批准开工。

---

## 14. 开场提示词（复制给新会话）

```text
【第一件事不是干活，是读懂要求】
1) 读 D:\sk--harness\dsh-side-notes\DESIGN.md 全文，列出该目录下已有的文件。
2) 用 5–8 条复述你对这个插件的理解：用户要什么、默认打断还是攒着、三档分流、投递降级链、L0–L7 分层。
3) 列出你还不确定的点和你的实现顺序。
4) 停下来等确认。说"开始"之后才按 §7 逐层实现，L0 挂载通过前不写业务代码。
工作目录：D:\sk--harness\dsh-side-notes
```

---

## 15. 验证结果（2026-11-22 已填）

- [x] 客户端提交 steer：✅ `ctx.sessions.scope(id)` → `sessionOf(actx)` → `SessionFace.prompt(content,'queue'|'steer',signal?,requestId?)`；先 `beginSubmission()`。
- [x] 写 composer 草稿：✅ `inputActions.setDraft(text)` + `addAttachments(ids)`；聚焦无公开 API（走 DOM）。
- [x] 工具卡片批注槽位：❌ 无。仅 `conversation.chat.assistant-actions` / `turnTail`；`chat.node` 只能整体替换（不用）。
- [x] 右侧栏：✅ `openTab(kind,opts)` + `expand()` 可自动打开；❌ 无 pin / keepMounted。
- [x] 工作区右键菜单：❌ 无；改用 `sidebar.footer.action`；workspaceId 经 `ctx.workspaces`。
- [x] 附件上传：`ctx.fileUpload.upload(...)`（暂存凭证）+ `ctx.conversation.createDrafts(sessionId, File[])`。
- [x] 附件 GC：无风险（永不删除）。
- [x] session projection 名称（快照用）：客户端用 `useProjection(key, selector?)`（session 标准 prop，`PropsRuntime` 的 Scope 部分）；可用键 `turnOutline`（`[{turn,seq,prompt,response}]`）、`todos`（`[{content,status}]|null`）、`sessionStats`（`{turns,steps,…}`）、`userQuestions`（`{active:[{questions:[{question}]}],settled}`）、`goal`、`inbox`、`plan`（计划模式开关 `{active,pending}`，非任务清单）、`title`；`recentSteps`（逐工具摘要）与 `filesTouched`（文件清单）**无现成投影**，L4 用 `turnOutline.response` 近似、文件暂不支持。
- [x] 实际使用的模型/档位（每阶段记录）：L0 = pro/high；L1 = pro(原型)/flash(批量)；L2 = pro/high（用户指定）；L3 = pro/high（用户指定）；L4 = pro/high（原计划快照 Pro + 渲染 Flash，但子代理路由无 Flash，实际全程 Pro）；L5 = pro/high。
- [x] `conversation.chat.assistant-actions` 槽位（L3 实测）：owner prop = `{ messageId }`（定稿助手消息的 durable id，中断冻结的 partial 无 messageId 不渲染）；`scope:'session'`、`kind:'list'`；注册用 `ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name, id, order, inject:(sessionId)=>({...}) }, Component))`，参照 `dsh-client-ui-message-feedback`；渲染在助手消息 IconActions 行（copy/branch 旁），hover 显现。

---

## 16. 分发与版本（GitHub 路线）

### 作者侧

1. 骨架满足可发布标准：`package.json` 含 `name` + `version`（缺 version 会让官方请求准备失败）、`exports`、`dsh` 字段；无硬编码绝对路径；零 `dependencies`。
2. GitHub 建空仓库（不勾 README/.gitignore/license）→ 首次 push → 打 tag `v0.1.0` → Release 附 zip。
3. 每次改动更新 `version` + 一句 CHANGELOG + 新 tag。

### 朋友侧（四步）

```powershell
git clone https://github.com/<你>/dsh-side-notes.git D:\plugins\dsh-side-notes
# 在 DSH 里让 agent 执行：
plugin_manager install_bundle target=D:\plugins\dsh-side-notes
# 重启 DSH，刷新页面
```

升级：`cd D:\plugins\dsh-side-notes && git pull` → 重启 DSH。

### 四个必须写进 README 的坑

1. 目录不能删/挪（本地安装是 link）。
2. 安装会弹权限请求，要点同意。
3. 替换已安装包需重启 DSH。
4. 版本不对会白屏 → 插件自带自检显示"插件需更新"。
