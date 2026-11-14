# ADR-0007：复用原生右键菜单，并只用「座位」给原生行加装饰

- 状态：已采纳（v0.3）
- 日期：2026-11-11
- 相关：PRD §7.2、§7.5、D7、D13、D14；ADR-0001、ADR-0006

## 背景

v0.2 的结论是「原生会话右键菜单只能挂在原生行上，插件行只能自绘一份」。这个结论来自当时看到的 `openSessionMenu`：它由 `ui-workspace` 内部持有，插件拿不到。

v0.3 重新查了客户端契约，发现这个结论不成立：

- `ctx.contextMenus`（`@deepseek-ai/dsh-client-ui-context-menu`）是**内置与外部插件共用**的客户端能力：`open(target, point)` 可以让任何调用方弹出同一个弹层，`register({id, target, order, resolve})` 可以给 `target:'session'` 追加条目，条目支持 `children` 渲染真正的二级子菜单、`run` 返回 Promise、`failureLabel` 承接失败提示。
- 原生那 6 个会话条目本身就是用这套 API 注册的（`ui-workspace/lib/client.js` 里 order 100/200/300/450/600），所以「同一个弹层」天然可用。
- 原生行还留了三个只读座位：`sidebar.session.row.leading`（悬停/状态点旁，条件受限）、`sidebar.session.row.trailing`（时间之后、置顶标记之前）、`sidebar.session.row.hover`（悬停卡里的一个 section）。它们只把 `sessionId` 交给占用者，明确要求「不要绑定或持有 Session」。

反过来，两个能力确实不存在：

- 「分组方式」菜单（按工作区/按工作区树/单列表）是 `ui-workspace` 里的硬编码数组，没有插槽、没有注册表、没有 contextMenus target。
- `contextMenus` 只能按 id 追加/合并，不能删除、隐藏或重排原生条目；同一 target 内 id 重复会注册失败。

## 决策

1. **面板行的右键一律弹出原生共享菜单**（`contextMenus.open`），自绘 `RowMenu` 降级为 `contextMenus` 不可用时的回退。
2. **只追加两个贡献**：`id: dsh-session-studio.tags`（order 500，标签子菜单）、`id: dsh-session-studio.panel-actions`（order 550，面板在场时的「查看详情」「打开会话」）。子菜单的每一项是一次 `POST /tags` 切换，成功后 `menus.notify()` 给原生提示，失败走 `failureLabel`。
3. **面板在场性由面板自己发布**：`panelBridge.active` 由 Page 的挂载 effect 置位，菜单 `resolve` 时读取；`requestPanelDetail` 通过订阅把 detailId 送进面板，并留一个「挂载时消费 pending detailId」的保险。
4. **原生行只加装饰**：`sidebar.session.row.trailing` 放状态点 + 标签数，`sidebar.session.row.hover` 放状态名 + 标签 chip；两者用一个 60ms 合并、30s 缓存的批量探针 `GET /session-meta?ids=…` 取数，绝不绑定 Session。
5. **分组能力仍留在插件面板**，并在 PRD 里明确写死「原生分组菜单不可扩展」，避免以后有人再把它当需求做一遍。

## 后果

- 好处：面板行与原生行是同一个菜单，原生项的行为/快捷键/可访问性零维护；插件只补原生没有的；升级原生时不会被自绘菜单拖住。
- 好处：用户不必打开面板也能在原生左栏看到状态与标签，且不改变原生分组语义。
- 代价：追加项无法插到任意位置（只有 order 相对顺序），也无法隐藏原生项；子菜单里的 ✓ 是读盘结果，改完要重新打开菜单。
- 代价：多了一个只读 HTTP 探针与客户端批处理缓存；装饰在索引未完成前只能显示“完成/运行中”这类可派生状态。
- 实测记录：v0.2「右侧栏详情页」的失败（ADR-0006）与 v0.2「原生菜单不可复用」的错误结论，都说明**客户端契约必须先在那个真实 GUI 里点到才算数**；v0.3 的两条链路（原生菜单 → 标签切换；原生行 → 装饰）都是在临时实例上点过之后才写进 PRD 的。
