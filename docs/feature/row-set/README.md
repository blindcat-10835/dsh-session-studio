# 行集与筛选口径（AIDEV-161）

## 现象

会话管理面板里选状态筛选「运行中」得到空结果，顶部概览卡（得处理 / 阻塞 / 失败）全 0，而原生侧栏里同一时刻就有正在运行的会话，行内还带运行标记。用户另报「正在刷新…」常驻。

## 根因（两条，都在「行集」而不是筛选代码）

1. **子代理判定把分叉会话整片隐藏。** 面板的行集来自宿主 `GET /sessions`，宿主按 `origin === 'subagent' || Boolean(parentSessionId)` 判子代理并在默认视图隐藏。分叉/派生会话带 `parentSessionId`，但原生侧栏（`dsh-client-ui-workspace#sessionVisible`）只把显式 `origin === 'subagent'` 当子代理 —— 于是这些会话在侧栏可见、在面板里连行都没有，筛选与计数自然一处都匹配不到。实测现役数据：277 条会话，默认视图只显示 54 条；被以 subagent 名义隐藏的 135 条里，大量带 `parentSessionId`。
2. **行集是一份快照。** 面板只在挂载/刷新时取一次语料；快照之后才开始的会话在快照里没有行，实时 store 知道它、宿主语料下次读到它，但这一次的筛选/计数看不到。这是与根因 1 独立的第二条路径，同一症状。

「正在刷新…」：加载条的生命周期等于一次在飞请求。请求没有截止时间，且成功回调里的清理写在最后一行 —— 一条永不返回的连接（例如 `dsh-web.service` 重启时被遗弃的 keep-alive socket），或回调中途抛错，都会让标记永远为真。

## 修法

- `host/sessions.js` 导出唯一的 `isSubagent(session)`：`origin === 'subagent'` 才算子代理。`host/api.js`（行集）、`host/ai.js`（跳过规则）、`host/rules.js`（候选集）、`host/tags.js`（补标签集合）共用同一个判定，不再各写一份 `parentSessionId ||`。
- `client.js`：`unknownLiveSessionIds(rowsRaw, liveById, sessionsById)` 比对快照与实时 store，发现未知 id 就重读一次语料；同一 id 只问一次（`healAskedRef`），语料不认的 id 不造成刷新循环。
- `client.js`：`request()` 默认带 `REQUEST_TIMEOUT_MS = 15000` 的 `AbortSignal.timeout`；`load()` 的清理放进 `finally`，应用响应抛错也照常收尾并按普通失败提示。

## 证据

- 门禁（Node 24.22.1，与现役 dsh web 同版本）：`node --check client.js host/*.js index.js` 通过；`node --test tests/*.test.js` ⇒ **253 tests / 253 pass / 0 fail / 0 skipped**，exit 0。
  - 注：Node 23 的 test runner 会把 `tests/ai.test.js` 的超时用例记为 cancelled（13 例假红），同一份代码在 Node 24 全绿；门禁以 Node 24 为准。
- 反向红证（逐条实测变红后还原）：
  1. `isSubagent` 改回 `Boolean(parentSessionId) || origin === 'subagent'` ⇒ 5 例红（`tests/api.test.js` / `tests/ai.test.js` / `tests/tags.test.js` 的行集与跳过规则断言）。
  2. `unknownLiveSessionIds` 直接 `return []` ⇒ `tests/client.test.js` 的 helper 用例红。
  3. 去掉 `merged.signal` 的赋值 ⇒ 截止时间用例红（请求不再被 abort）。
- 现役数据（:3080，修复前的宿主进程）：`GET /sessions` 默认 54 行；`?includeArchived=true&includeSubagents=true` 277 行；其中 135 行带 subagent 标记被默认隐藏，151 行带 `parentSessionId`。行集口径就是用户看到「侧栏有、面板没有」的直接来源。

## 未完成项（如实登记）

宿主模块在进程启动时加载，`host/*.js` 的改动**需要重启 `dsh-web.service` 才在 :3080 生效**；重启会轮换 launch token（浏览器需重新授权一次），并且会中断当前正在运行的会话，所以本轮没有重启 —— 现役面板的实时复验（选「运行中」列出运行中会话、各状态计数等于行数）待重启后执行。
