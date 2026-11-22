# Side Notes（旁注）实现细节

> 状态：L0–L6 已完成并人工验收通过（i18n 取消，仅中文）。

## 当前进度

| 层级 | 状态 | 验收 |
|---|---|---|
| L0 空壳挂载 | ✅ | composer dock 绿勾可见 |
| L1a 投递链 | ✅ | steer 消息送达主对话 |
| L1b 收件箱 | ✅ | tab 打开、增/删/暂缓、合并投递送达 |
| L2 项目备忘 | ✅ | 左栏底部按钮 + 工作区级存储 + 图片(IndexedDB)拖入拖出 |
| L3 助手消息批注 | ✅ | assistant-actions ✎ + 按消息聚合 + 合并投递 + 5 秒撤回 |
| L4 旁问档 1 | ✅ | 快照 + 进度条 + 本地回答（0 token） |
| L5 旁问档 3 | ✅ | 子会话查证 + 结果一键插回主线 |
| L6 打磨 | ✅ | 错误边界/双击放大/README/设置 + 清缓存（重启后验）；i18n 取消 |
| L7（可选） | 未开始 | 见 DESIGN.md §7 |

## 已实现（client.js 单文件，未拆 src/）

- 右侧栏「旁注」tab：`sidebarRightTabs.register({ id: 'dsh-side-notes/notes', kind: 'side-notes', title, guide })` + `sidebar.right.pane.tab` 正文（key 同名）。
- composer dock ✎ 按钮（带未读角标）→ `ctx.sidebarRight.openTab('side-notes')`。
- 收件箱：localStorage `dsh.side-notes.v1.session.<sessionId>`，内存 store + `useSyncExternalStore`。
- 投递：`ctx.sessions.binding(sessionId).session.prompt([{type:'text',text}], 'steer')`；失败降级 `inputActions.setDraft`。
- 停顿点自动投递：`useSession((s)=>s.running)` true→false 触发 10 秒倒计时（`[立即][取消]`），≤3 条合并，30s 冷却。
- `Alt+Enter` 打开 tab。

### L2 新增

- 面板顶部分段开关 `[会话][项目]`，视图状态放 React 之外（模块级 `viewStore`，切 tab 卸载不丢）。
- 左栏底部「备忘」按钮：`sidebar.footer.action`（list, root scope）注册，点击切到项目视图 + 打开 tab。
- 项目备忘 store：localStorage `dsh.side-notes.v1.workspace.<workspaceId>`（按 **workspaceId**，改名不丢），`storage` 事件跨标签同步。
- workspaceId 取法：全局标准 prop `useWorkspaces(selector)`，按 `items[].sessionIds` 反查当前会话所属工作区。
- 勾完成：`done` 下沉变灰（未完成在前，已完成置底）。
- 删除 → 最近删除（20 条 / 7 天自动清理，折叠显示，可恢复/彻底删除/清空）。
- 与收件箱互转：收件箱条目「备忘」→ 项目（移动）；项目条目「插入」→ 当前会话收件箱（复制，备忘保留）。
- 图片：IndexedDB `dsh-side-notes/images`（键=imageId，值={blob, thumb}）；`Ctrl+V`/拖入/选文件；压缩 WebP 长边 ≤1600 质量 0.82 + 320px 缩略图（失败回退 PNG/原文件）；「发送」拖出用 `ctx.conversation.createDrafts(sessionId, [File], ordinary)` + `inputActions.addAttachments(ids)`。
- **拖入抢占**：项目视图 `dragenter/dragover/drop` 均 `stopPropagation()`，防止 `dsh-client-ui-attachment` 的 document 级拖放监听把文件投给主输入框。
- **最近删除置底**：面板 `flex:1` + 备忘列表 `overflow-y:auto`，最近删除固定在底部（带顶边分隔线），展开后内部限高 160px 滚动。
- **主题 token 样式**：颜色/字号改用 `--dsw-alias-*` 与 `--dsh-sidebar-*` token，正文 14px（与左栏一致）；左栏底部「项目备忘」按钮对齐左栏「设置」按钮（`.trigger`：42px 高、14px、`--dsw-alias-label-primary`、hover `--dsw-alias-interactive-bg-hover`，rail 态 36×36）。

### L3 新增

- `conversation.chat.assistant-actions` 槽位注册 ✎（SVG 铅笔，hover 显现），点击弹内联输入框（绝对定位 popover：`--dsw-alias-bg-overlay` 底 + `--dsw-alias-border-l3` 边 + 浮层阴影）。
- 批注条目进**同一收件箱 store**，带 `kind:'annotate'` + `messageId` 锚点（复用 `dsh.side-notes.v1.session.<sessionId>`）；面板条目显示 `[↳短id]` 标记。
- 合并投递：批注与普通旁注一起走现有 `doFlush`（≤3 条合并），投递文本带 `[↳短id]` 锚点。
- 5 秒撤回：提交后悬浮框切为「已批注 · Ns [撤回]」，倒计时归零自动消失，撤回即从队列移除。
- 槽位注入：`inject: (sessionId) => ({ sessionId })`（参照 message-feedback 范式，sessionId 传给组件；owner prop `{ messageId }`）。

### L4 新增（旁问档 1 · 本地回答，0 token）

- 快照数据源：`useProjection(key, selector?)`（session 标准 prop），读 `turnOutline` / `todos` / `sessionStats` / `userQuestions`；纯客户端、免重启。
- 快照拼装：`{ turn, lastUserAsk, plan(来自 todos), recentSteps(用 turnOutline.response 近似), filesTouched(null), blockedOn(来自 userQuestions.active 待答问题), pendingNotes(收件箱 queued) }`。
- 进度条：`done/total`（todos completed 占比），条在会话视图顶部。
- 旁问输入 + 本地规则回答 `answerTier1()`：覆盖「做到哪了 / 进度」「下一步」「卡在哪」「计划清单」；「文件」答暂不支持；答不了返回 null → 提示留给档 2/3。
- 已知缺口补齐说明：`recentSteps`（逐工具摘要）与 `filesTouched`（文件清单）无现成投影，走 A/A（近似 + 暂不支持）。

### L5 新增（旁问档 3 · 子会话查证 + 插回主线）

- 触发：旁问输入若 `answerTier1()` 答不了（返回 null），自动走档 3。
- 新建子会话：`ctx.workspaces.create({ path: '<mainCwd>\.side-notes-ask' })`（A′ 独立旁问工作区；文件夹需已存在，失败回退主项目）→ `ctx.sessions.create({ workspaceId, cwd })`。
- 跑问题：`ctx.sessions.retain(id, { source: 'gateway' })` → `ref.ready.session.prompt([{type:'text',text}], 'queue')`；问题里带主项目绝对路径 + 「只读查证」约束。
- 读结果：轮询 `child.getSnapshot().running`，结束后读 `child.projections.faceOf('turnOutline')` 末条 `.response`；`ctx.sessions.refreshProjections(id)` 先行；`ref.release()` 收尾。
- 插回主线：结果下方「→ 插回主线」按钮，`deliver(sessionId, '【旁问】'+answer, 'queue')`。
- `deliver()` 增加 `mode` 参数（默认 steer，可传 queue）。

### L6 新增（打磨）

- **错误边界**：`PanelErrorBoundary` 包住 `Panel`，崩溃只显示提示、不拖垮主对话。
- **图片双击放大**：`ImageThumb` 双击读原图 blob → 全屏灯箱（遮罩/Esc/× 关闭）。
- **设置**（localStorage `dsh.side-notes.v1.settings`，模块级 `settingsStore`）：默认投递方式（queue/steer）、停顿点自动投递开关、单次合并上限（2/3/5）、旁问档 3 开关；改完立即生效。面板分段第三项「设置」。
- **清理旁问缓存**：Host 半边 `index.js` 注册 `/side-notes-clear` 命令（`node:fs` 删 `~/.dsh/sessions/*side-notes-ask*` 组）；设置页「清理旁问缓存」按钮 `session.command('/side-notes-clear')` 触发。**Host 改动需重启 DSH**。
- **i18n：取消**（用户决定只用中文）。
- **README.md**：功能、安装、四个坑、已知限制。

## 关键 API（已实测）

- 客户端 steer：`SessionFace.prompt(content, 'steer'|'queue', signal?, requestId?)`，先 `beginSubmission()` 可登记回显。
- 草稿：`inputActions.setDraft(text)` / `addAttachments(ids)`（无 focus API）。
- 附件：`ctx.fileUpload.upload(...)`（暂存凭证）；`ctx.conversation.createDrafts(sessionId, File[], uploadImages)` → `inputActions.addAttachments([id])` 可把 File 放进 composer；附件永不删除。
- 工作区：`ctx.workspaces`（IWorkspaces）；全局 prop `useWorkspaces`；`WorkspaceSnapshot.items[].workspaceId/sessionIds`。
- 左栏底部按钮槽：`sidebar.footer.action`（list, root scope；owner props `{ wide }`）。
- 会话作用域标准 props：`sessionId` / `useSession` / `useInput` / `inputActions`；全局标准 props：`useSessions` / `useWorkspaces`。

## 已知缺口（L3+ 补）

1. 自动投递只在 running true→false 触发；agent 空闲时写旁注不会自动发（需手动"发送到主线"）。
2. 无拖拽排序 / 原地编辑 / 剪贴板三级降级。
3. ✎ 是字符不是 SVG 图标；无 i18n（硬编码中文）。
4. 图片拖出仅「发送」按钮 + DataTransfer 自定义类型占位，未做真实 HTML5 拖到 composer 释放区（设计上本就以 createDrafts 程序化投递为主）。
5. 项目备忘条目**已支持原地编辑文字**：双击文字进入编辑（Enter 保存 / Esc 取消 / 失焦保存）。
6. L3 批注输入框是绝对定位 popover，最后一条消息贴近底部时可能被滚动容器裁剪（待验收观察，必要时改向上弹出或 portal）。
7. 项目备忘图片**双击放大（灯箱）**：用户已提出，**攒到 L6（UI 打磨）**做。纯客户端（读原图 blob + 全屏 overlay + Esc/点遮罩关闭），0 运行 token。
8. **「清理旁问缓存」按钮**：用户已提，**并进 L6**。需 Host 半边（`index.js`，现空壳）用 `node:fs` 删旁问会话日志目录（`~/.dsh/sessions/--<主项目cwd>--.side-notes-ask--/`）+ 客户端命令桥（`session.command('/side-notes-clear')`）；**host 改动需重启 DSH**。

## L2 待办（详见 DESIGN.md §7）— 已全部落地

1. ✅ 左栏底部「备忘」按钮：`sidebar.footer.action` 注册，点击 `ctx.sidebarRight.openTab('side-notes')` + 切到项目视图。
2. ✅ 项目备忘 store：localStorage `dsh.side-notes.v1.workspace.<workspaceId>`；`storage` 事件跨标签同步。
3. ✅ 删除进「最近删除」（20 条 / 7 天，折叠）；勾完成下沉变灰。
4. ✅ 与收件箱互转：提升为备忘 / 插入当前会话。
5. ✅ 图片：IndexedDB `dsh-side-notes/images`，`Ctrl+V`/拖入/选文件，压缩长边 ≤1600 WebP 0.82，缩略图 320px；拖出用 `createDrafts`。
