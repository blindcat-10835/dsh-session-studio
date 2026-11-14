# ADR-0006：会话详情用面板内分栏，不用右侧栏页类型

- 状态：已采纳（v0.2 修订，取代原「右栏页类型」设计）
- 日期：2026-11-11

## 背景

v0.2 最初把「查看详情」实现为向右侧栏注册页类型：`sidebarRightTabs.register({id, kind})` + `sidebar.right.pane.tab` 正文槽，再用 `sidebarRight.openTab(kind, {params})` 打开。静态读文档时这看起来正确，单测（纯函数 + 假 ctx）也全绿。

真实浏览器验证推翻了它：点击「查看详情」只得到红色提示 `操作失败：sidebarRight: no session surface is mounted`。读 `@deepseek-ai/dsh-client-ui-sidebar-right` 的源码后确认，`openTab`/`openResource` 是 `require()` 出来的**当前屏幕会话的已挂载 surface**操作；而插件面板本身是一个占据主栏的全局面板，此时不存在任何 session surface，所以这条路在本插件的使用方式下永远抛错，加 inject 也无法解决。

## 决策

详情改为**插件面板内部的主从分栏**：左侧保持列表，右侧约 340px 显示详情（窄屏改为覆盖式抽屉），状态由插件自己持有；`Esc`/关闭按钮收起，焦点回到原行。详情正文仍是同一个组件，只是数据来源从 `useTabInfo()` 换成受控 props。

## 后果

- 详情在用户不离开列表的前提下可用，打开/切换行是纯本地操作，无平台依赖、无竞态。
- 代价：详情与原生右栏不能同时占屏；「右栏按会话分区」的语义不再适用于本插件（PRD D8 已改写）。
- 教训（已写进 CONTRACTS）：客户端能力不能只按类型定义推断——`sidebarRight` 这类服务有「当前是否有 surface」的运行期前提，UI 能力必须在真实 GUI 里点一次才算验过。
