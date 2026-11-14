# 内部接口契约（实现层，非产品文档）

产品语义见 [PRD.md](./PRD.md)；这里只冻结模块之间的 JS 接口，避免并行开发时互相猜。所有模块是 ESM、纯 Node、无构建步骤；用 `node --check` 自检。

## 已就位（Lead 所有，勿改）

- `host/store.js`：`StateStore`（`loadSync/sessionOf/patchSession/ensureTagDef/tagDefs/rules/putRule/deleteRule/readDoc/writeDoc/gcOrphans/settings/version/bump`）、`normalizeTag(s)`、`normalizeTags(list)`、`emptySession()`、`DEFAULT_SETTINGS`、`StateError`、`resolveDataDir(config)`。
- `host/sessions.js`：`createSessionSource({ctx,logger,settings})` → `{ list, exists, statOf, factsOf, rename, archive, unarchive, artifactDir }`；`foldFacts(headEvents, tailEvents)`、`emptyFacts()`。

`sessions.list()` 返回：`{ id, updatedAt, running, blank, cwd, parentSessionId, origin, archived, pinned }`。
`sessions.factsOf(id,{tailEvents})` 返回：`{ title, titleSource, firstMessage, lastTurnEnd, lastTurnEndAt, messageCount, revision?, eventCount?, error? }`，其中 `lastTurnEnd ∈ {completed,aborted,blocked,error,max-tokens,interrupted,forked,null}`。

## 宿主行数据（`GET /sessions` 的 rows，客户端唯一数据源）

```js
{
  id, title, cwd, workspaceTitle, updatedAt, createdAt /* 暂为 null：controller list 不提供 */,
  running, blank, subagent, archived, pinned,
  tags: string[], suggestedTags: string[], note: string,
  titleLocked: boolean, titleSource: 'ai'|'manual'|null, intent: string|null,
  lastTurnEnd: string|null, lastTurnEndAt: number|null, indexedAt: number|null,
}
```

客户端另可用实时事实覆盖：`running`、`pendingInteraction`、`completionUnread`，并按 PRD §3 的优先级重算状态；宿主不下发 `pendingInteraction`/`completionUnread`。

## 各模块接口（teammate 所有）

### host/status.js — 状态索引器
```js
createStatusIndexer({ store, sessions, logger, settings }) => {
  start({ force = false } = {}): { started: boolean, running: boolean }
  status(): { running: boolean, processed: number, total: number, startedAt, finishedAt, lastError }
  rowOf(id): { lastTurnEnd, lastTurnEndAt, revision, indexedAt } | null
  ensure(ids): Promise<void>          // 同步等待这些 id 索引完成（AI/规则预览前用）
  stop(): void
}
```
- 缓存文件 `status-index.json`：`{ schema, sessions: { <id>: { revision, lastTurnEnd, lastTurnEndAt, title, titleSource, firstMessage, indexedAt } } }`，用 `store.readDoc` / `store.writeDoc`（同步写、原子）。`title/titleSource/firstMessage` 取自同一次 `sessions.factsOf(id)`（firstMessage 只存前 400 字符），`rowOf(id)` 一并返回——`/sessions` 的行标题来自这里，不再第二次读日志。
- 用 `sessions.statOf(id).revision` 与缓存比对决定是否重读；`force` 忽略缓存。
- 并发 = `settings.status.concurrency`（默认 2），必须顺序处理、支持 `stop()`，且**不得**读取 `sessions.factsOf` 之外的全量日志。
- 新增会话/会话变化不主动扫描：`GET /sessions` 时若发现未索引 id，自动 `start()` 增量补齐。

### host/tags.js — 标签操作
```js
createTagService({ store, logger, sessions }) => {
  apply({ sessionIds, op, tags }): { updated: number, tagDefs },   // op: append|replace|clear
  fillMissing({ dryRun = true }): { candidates: [{sessionId, title, tags}], updated: number },
  addSuggestions(id, tags, source): string[],      // 只写 suggestedTags
}
```
- `op:'replace'` 与 `'clear'` 只改插件状态，从不碰会话日志；`append` 逐会话去重。
- `fillMissing` 只处理 `tags.length === 0` 的会话，写入它们的 `suggestedTags`，**绝不覆盖**已有标签。

### host/rules.js — 标签规则
```js
createRuleService({ store, sessions, tags, statusIndex }) => {
  list(): Rule[]
  validate(input): Rule                        // 校验 + 规范化，非法抛 StateError('invalid_rule')
  save(input): Rule                            // id 缺省则生成 r-<rand>
  remove(id): boolean
  preview({ rule, limit }): { matches: [{ sessionId, title, tags, evidence }], scanned: number },
  apply({ ruleId, mode }): { suggested: number, updated: number, sessions: string[] },
  suggestFor(ids): { [sessionId]: string[] }    // 只算建议，不落库
}
```
- 匹配字段：`title`、`firstMessage`、`cwd`、`note`（需 `sessions.factsOf`，必须走状态索引缓存或直接 `factsOf`，带并发上限）。
- `action.mode:'suggest'` 写 suggestedTags；`'apply'` 追加到 tags，**从不删除**。

### host/ai.js — AI 批量流水线
```js
createAiService({ store, sessions, statusIndex, settings, logger, llm, agentDefaultModel }) => {
  available(): { ok: boolean, reason?: string, model?: string }
  previewRename({ sessionIds, readContent }): { items: [{ sessionId, currentTitle, proposed, reason, skipReason }], model, skipped: number },
  applyRename({ items }): { applied: [{ sessionId, title }], failed: [{ sessionId, code, message }] },
  previewTags({ sessionIds, mode }): { items: [{ sessionId, suggestions, intent, reason }], vocabulary, model },
  applyTags({ items }): { applied, failed },
}
```
- 模型调用：`llm` 服务（未注入时 `available().ok === false`，接口回 503 `llm_unavailable`）。路由取 `agentDefaultModel` 的当前选择。**不要**发明第二套凭据。
- 跳过规则在预览阶段决定并写进 `skipReason`：`running` / `blank` / `subagent` / `titleLocked`（仅重命名）/ `archived`。
- 应用阶段对每个 id 再校验一次跳过条件（防止预览与应用之间状态变化）。
- 重命名应用：`sessions.rename(id, title)` 成功后 `store.patchSession(id, { titleSource: 'ai', titleLocked: false })`。

### host/trash.js — 回收站
```js
createTrashService({ store, sessions, logger, dataDir }) => {
  list(): [{ sessionId, title, cwd, deletedAt }]
  move(ids): { trashed: string[], refused: [{sessionId, code, message}] }
  restore(ids): { restored: string[], refused: [...] }
}
```
- `move`：`sessions.artifactDir(id)` 得到会话目录 → `rename()` 到 `<dataDir>/trash/<sessionId>/`；写 `trash.json` 索引（原子）。运行中的会话先拒绝（`code:'running'`）。目录缺失但会话仍可查时写 tombstone 条目（不搬目录，`tombstone:true`），恢复即删除条目。
- `restore`：从索引取原路径，目录搬回；索引删除。

### host/jobs.js — 后台任务（v0.2 新增）
```js
createJobRunner({ store, logger, handlers, now = Date.now, flushMs = 400, keepFinished = 50 }) => {
  start({ type, params }): Job        // type 不在 handlers 里 → StateError('invalid_type')
  get(id): Job | null
  list({ active = false, limit = 20 }): Job[]
  cancel(id): Job | null              // 未知 id → null；终态 → 原样返回
  activeCount(): number
  recover(): void                     // 启动时把 queued|running 改成 interrupted
  stop(): void                        // 取消队列、清定时器、结束时不再写盘
}
```
- `handlers`：`{ [type]: async (jobCtx) => result }`，`jobCtx = { id, type, params, signal, report({ total?, done?, failed?, skipped? }), addItem({ key, state, message?, data? }) }`；handler 抛错 → 任务 `failed`，`error = { code:'handler_failed', message }`。
- 任务之间**串行**（FIFO 队列，同一时刻只跑一个）；任务内部并发由 handler 自己控制（AI 沿用 §6 批次并发 2）。
- 状态机：`queued → running → succeeded | failed | cancelled | interrupted`；只有 `queued`/`running` 可被 `cancel`（`queued` 直接取消，`running` 先 `signal.abort()` 再等 handler 退出，随后置 `cancelled`）。
- 进度：`percent = total > 0 ? Math.min(99, Math.floor(100 * done / total)) : 0`，终态成功时置 100。
- 持久化：`store.readDoc('jobs.json')` / `store.writeDoc('jobs.json', { schema: 1, jobs })`；写盘去抖 `flushMs`，任务进入终态与 `stop()` 时立即刷盘；保留全部未完成任务 + 最近 `keepFinished` 条终态任务。
- `items` 最多保留 200 条（`itemsTruncated`），`data` 必须是可 JSON 序列化的浅对象。
- 定时器必须 `.unref()`，`stop()` 后不得再有写盘或队列推进。
- 实现补充（v0.2 落地）：handler 抛错时 `error.code` 优先沿用错误自带的 code（如 `llm_unavailable`），缺省 `handler_failed`；`stop()` 之后再 `start()` 抛 `StateError('stopped')`；`list()` 进行中置顶、组内最新在前；`get/list/cancel` 返回快照副本。

### client.js — 面板（单文件浏览器 bundle）
```js
window.__ModuleLoader__.load({ id: 'dsh-session-manager', factory(require) { ... return { inject: [...], apply } } })
```
- 只 `require('react')`，不用 JSX，全部 `React.createElement`。注册槽：`main`（key `session-manager`）、`sidebar.panellist`（id `session-manager`，order 40）、v0.3 的两个只读座位 `sidebar.session.row.trailing`（id `dsh-session-manager.row-status`，order 20）与 `sidebar.session.row.hover`（id `dsh-session-manager.row-hover`，order 20）。v0.2 的详情分栏是面板内 UI（PRD §7.3），**不注册右栏页类型**。
- **inject 必须声明每个要读成员的服务（含点号嵌套服务）**：客户端沙箱对未声明的成员读取直接抛 `cannot get property "remote.session" without inject`，一次未捕获的读取就会让 `main` 槽崩溃、整个面板空白。当前声明：
  `inject: ['slots','locale','layout','contextMenus','uiWorkspace','remote','remote.session']`（详情分栏改为面板内实现后不再使用 sidebarRight 系服务；v0.3 起多声明 `contextMenus`，原生菜单的 open/register/notify 全走它）。
  注意 `inject` 只接受**字符串数组**：写成 `{required, optional}` 会被当成要等待名为 required/optional 的服务，插件永远 pending（实测）。
- v0.2 客户端额外依赖：`ctx.get('uiWorkspace')`（`openSession/forkSession/pinSession/unpinSession/archiveSession/unarchiveSession`）、`ctx.get('remote')` 的 `session.openWorkspacePath({path, action:'reveal'})`（**必须同时声明 `remote.session`**）。所有服务成员读取都要走 `optionalService()`/`hasMethod()` 这类防御包装：缺失时对应菜单项禁用并给原因，不得抛错阻断开面板。
- 数据只走 `fetch(API_PREFIX + ...)` 同源 JSON；实时状态用 `useSessionStatus` / `useSessions`（由 `ctx.slots` 提供，见 ui-session 的注入面）。
- 所有 slot 注册与 `<style data-plugin="dsh-session-manager">` 都由 `ctx.effect(...)` 持有，卸载时撤销。
- v0.3 原生菜单贡献（`dsh-session-manager:session-tags-menu` effect）：
  `contextMenus.register({ id:'dsh-session-manager.tags', target:'session', order:500, resolve })` 返回 `[{id, label, children:[{id,label,disabled? 或 run}]}]`；
  `register({ id:'dsh-session-manager.panel-actions', target:'session', order:550, resolve })` 在 `panelBridge.active` 时返回「查看详情」「打开会话」，否则返回 `[]`（原生左栏不应看到面板专属项）。`run` 抛错由 `failureLabel` 兜底提示。
- v0.3 面板在场性：Page 挂载时 `setPanelActive(true)` 并 `subscribePanelDetail(id => setDetailId(id))`，卸载时撤销；`requestPanelDetail(id)` 同时写 `panelBridge.detailId`，Page 每次渲染兜底消费一次（防止订阅建立前就点）。
- v0.3 行装饰数据：`requestSessionMeta(id)` 入队 → 60ms 合并 → `GET /session-meta?ids=a,b,c`（≤300 个）→ `mergeSessionMeta` 写缓存并通知订阅者；单条缓存 30s。座位组件只用 `props.sessionId`，不绑定 Session，不写会话状态。
- v0.3.2 标签词表 CRUD（PRD §7.7）**在宿主**：客户端只发 `POST /tag-defs {op,name,to?}` 并 adopt 返回的整份 `tagDefs`，本地不维护词表副本。宿主 `tags` 服务新增 `vocabulary()`（返回 `[{name,source,createdAt,sessions,suggested}]`，按 `sessions` 降序、再按名字 `localeCompare('zh-Hans-CN')`）、`createDef(name)`（同名→`StateError('invalid_tag')`）、`renameDef(from,to)`（返回 `{renamed,from,to,sessions,rules,tagDefs}`，**重名即合并**、旧 `createdAt` 保留）、`removeDef(name)`（返回 `{removed,name,sessions,rules,tagDefs}`，清所有会话 `tags`/`suggestedTags` 与规则 `action.tags`，规则变空则删规则）。三个写操作由路由统一 `await store.persistNow()`。
- v0.3.2 标签写入广播桥（客户端）：`subscribeTagWrite(listener)` / `notifyTagWrite(ids)`。`toggleSessionTag` 成功后调用 `notifyTagWrite([id])` → 删 `metaCache[id]`、重置词表缓存 `tagMenuCache`、`requestSessionMeta` 重探、再通知订阅者；Page 里的订阅者只做 `scheduleRefresh()`（1.5s 合并）。这是"原生菜单写入不经过 React，面板必须被叫醒"的唯一通道。
- v0.3.2 双 chip 修复（宿主）：`tags.apply` 的 `op:'replace'` 与 `renameDef` 都用 `withoutAccepted(suggestions, tags)` 按小写剔除与真标签同名的建议，避免同一词渲成"实心 + 虚化"两个 chip。
- v0.3.1 分组顺序（PRD §7.6）是**纯客户端视图状态**，不进 HTTP 契约、不落宿主盘：`applyGroupOrder(groups, order)` / `moveGroupKey(order, key, targetKey)` / `moveGroupBy(order, key, delta)` 都是纯函数（输入数组不变），`readGroupOrder()` / `writeGroupOrder(order)` 只读写 `localStorage['dsh-session-manager.group-order']`（存成 `{ [dimension]: string[] }`，三个维度各一份）。存储不可用（隐私模式、无 `localStorage`）时读写都退化：读返回 `{}`、写返回 `false`，界面照常按自然顺序工作。未知 key 一律排到已保存 key 之后，保证新状态/新标签不会因为“不在记忆里”而消失。

## 集成（Lead 所有）

`host/api.js` 按 PRD §8 冻结路由；`index.js` 组装 store/sessions/status/tags/rules/ai/trash/jobs + `webServer.register` + `tools.register`。任何模块抛 `StateError` → `{error:{code,message}}`，未预期异常 → 500 `internal`。

任务处理器由 Lead 在 `api.js` 注册：`ai.rename` → `ai.previewRename`、`rename.apply` → `ai.applyRename`、`ai.tags` → `ai.previewTags`、`tags.fillMissing` → `tags.fillMissing`（`dryRun` 从 `params` 读取）。
