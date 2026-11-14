# PRD 实现审计（v1.0）

审计对象：[PRD.md](./PRD.md)（v1.0）。审计时间：2026-11-11（v0.3），2026-11-12 复核对齐 v0.3.1 分组拖动排序与 v0.3.2 标签管理，2026-11-14 定版 1.0。
方法：① 逐条读 PRD；② 在代码里定位实现（行号见各条）；③ 跑全量测试（231 passed / 0 failed）；④ 在真实 GUI（临时实例 :3099）逐项点验能点的链路。
状态口径：**✅ 已实现并验证**（真实 GUI 点过）/ **🟡 已实现**（单测覆盖，GUI 未逐项点）/ **⚠ 有偏离**（见 §10 编号）/ **❌ 未做**。

## 结论摘要

| 维度 | 结果 |
|---|---|
| §2 用户故事 1–28（v0.1/v0.2 基线） | 28/28 有实现；其中 3 条带偏离（#21、#23、#27 见 D7/D8/D10） |
| §2 用户故事 29–31（v0.3 新增） | 3/3 已实现并在 GUI 验证 |
| §2 用户故事 32（v0.3.1 新增） | 1/1 已实现并在 GUI 验证（拖动 + ↑/↓ + 记忆 + 恢复默认） |
| §2 用户故事 33–34（v0.3.2 新增） | 2/2 已实现并在 GUI 验证（标签管理界面的新建/改名/删除；右键打标签后面板自动出 chip） |
| §3 状态词表 | ✅ 7 档，客户端 `STATUS_IDS` 与 `deriveStatus` 为唯一真源 |
| §4–§6 数据/规则/AI | ✅ 全部实现，AI 受 D4（无模型路由时禁用）约束 |
| §7 交互规格 | ✅ 实现；§7.2 已由「自绘菜单」升级为「原生共享菜单 + 追加项」（D7/D13/D14/D15）；§7.6 分组顺序（v0.3.1）、§7.7 标签管理（v0.3.2）已实现 |
| §8 HTTP 契约 | ✅ 全部路由存在（含 v0.3 的 `GET /session-meta` 与 v0.3.2 的 `GET/POST /tag-defs`） |
| §9 持久化 | ✅ 原子写 + 重启标记中断 |
| §10 偏离 | 16 条，全部有意识、有记录，无“偷偷降级” |
| §11 里程碑 | M1 / M1.1 / M1.2 / M1.3 / M1.4 完成；M2 未做 |

**审计中发现的唯一实质缺陷（已修复）**：右键改成原生菜单后，v0.1 行内里那套「标签编辑 / 备注 / 移入回收站」没了入口（原生菜单不能开插件自己的对话框）。修法：行尾加「⋯」按钮，弹插件自己的菜单 = 原生条目 + 这三条（`pluginMenuItemsFor`），并在 GUI 里点了「备注」确认弹出对话框。

## §2 用户故事逐条对照

| # | 故事 | 状态 | 实现 / 证据 |
|---|---|---|---|
| 1 | 按状态分组 | ✅ | `groupRows(rows,'status')`（client.js:230 起）；组头 `statusCounts` 出 7 档计数；空组不出现 |
| 2 | 按时间桶分组 | 🟡 | `bucketOf`/`BUCKET_IDS`；无 updatedAt 落“更早” |
| 3 | 按标签分组 | 🟡 | `groupRows(...,'tag')`；多标签重复出现 + “未打标签”组（D3） |
| 4 | 标签规则 + 命中预览 | 🟡 | `RulesDialog` + `POST /rules/preview`；默认只产生建议标签 |
| 5 | AI 批量重命名 | 🟡 | 批量条 → `POST /ai/rename/preview`（202 job）；上限 50（D4 时置灰） |
| 6 | 先预览再应用 | 🟡 | `RenamePreviewDialog`（逐条取消、跳过原因）→ `/ai/rename/apply` |
| 7 | 组合筛选 | 🟡 | `filterRows` 叠加状态/时间/标签 + 搜索 |
| 8 | 重命名前读内容 | 🟡 | 预览项带“依据”（首条消息片段）；`readContent` 可关闭 |
| 9 | 自动跳过运行中/空白/子代理 | ✅ | `skipReasonFor` + 宿主二次校验（tests/ai.test.js） |
| 10 | 折叠后组头仍汇总 | 🟡 | 组头常显 total + 7 档计数；折叠只藏行 |
| 11 | 7 档状态点 | ✅ | `STATUS_IDS` + `StatusDot`/`deriveStatus`（tests/client.test.js） |
| 12 | 批量追加/替换/清空标签 | 🟡 | 批量条三动作；替换/清空二次确认 |
| 13 | 搜索标题/ID/备注/标签 | ✅ | `matchesSearch`（ID 前缀） |
| 14 | 一键补齐缺失标签 | 🟡 | `FillMissingDialog` + `tags.fillMissing` job；只处理零标签 |
| 15 | 意图闭集 + 手动改名锁定 | 🟡 | `intent` 枚举 + `titleLocked`（`/rename` 置锁） |
| 16 | 待处理概览 | 🟡 | `OVERVIEW_IDS` 四个可点计数 |
| 17 | 归档视图搜索 | 🟡 | `ARCHIVE_VIEWS` = 隐藏/一起/只看 |
| 18 | 批量删除＝回收站 | ✅ | `DeleteDialog` → `POST /trash`；恢复走 `/trash/restore`（D1） |
| 19 | 批量恢复归档 | 🟡 | 批量条“取消归档” → `/unarchive` |
| 20 | 归档运行中会话先停工作 | ✅ | `ArchiveConfirmDialog` + `stopActivity:true`（client.js:3233/3360） |
| 21 | 插件行右键＝原生菜单 | ✅ | **v0.3**：`contextMenus.open({kind:'session'})`；GUI 实测出现 取消置顶/重命名/分叉/复制 ID/标签/在文件夹显示/查看详情/打开会话/归档 |
| 22 | 插件里跳转到会话 | 🟡 | 双击行 / 菜单「打开会话」/ `Ctrl+Enter` → `uiWorkspace.openSession`；归档/空白置灰 |
| 23 | 右侧分栏看详情 | ⚠ | 改为**面板内主从分栏**（D8，ADR-0006）；GUI 已实测打开与内容 |
| 24 | 重命名/补齐标签后台任务 | 🟡 | 4 类异步端点 → `host/jobs.js`；离开面板再回来仍在（tests/jobs.test.js） |
| 25 | 任务进度与结果 | 🟡 | `JobsIndicator` + `JobsPanel` + `JobDetailList`；800ms 轮询（`JOB_POLL_MS`） |
| 26 | 任务中断可解释 | ✅ | 启动时 `queued|running → interrupted`；客户端 404 也记中断（D12） |
| 27 | 键盘操作 | ⚠ | 面板内 `Ctrl+Alt+G`/`Ctrl+Shift+F`/`Ctrl+Alt+A`（D10 限定面板焦点）；菜单键盘由原生弹层负责 |
| 28 | “空闲”不存在 | ✅ | 正常收尾=完成、中断/取消=中断，分开计数筛选（tests/status.test.js） |
| 29 | 面板行右键＝原生同款菜单 | ✅ | v0.3；同上 #21（原生项 + 两个面板专属项 `panel-actions`） |
| 30 | 任意会话行右键改标签 | ✅ | v0.3；`dsh-session-studio.tags` 子菜单，GUI 实测点 ✓ 取消后 `GET /sessions/:id/value` 返回 `["bug"]` |
| 31 | 原生左栏行显示状态/标签 | ✅ | v0.3；`row.trailing` 徽标（点+标签数，悬停时原生会隐藏）+ `row.hover` 状态名与 chip，截图确认 |
| 32 | 分组能上下拖动排序 | ✅ | v0.3.1（§7.6）；`applyGroupOrder`/`moveGroupKey`/`moveGroupBy` + 组头 ⠿ 拖动与 ↑/↓；按维度存 `localStorage`；GUI 实测拖 `完成` 到末位后顺序变 `运行中/中断/完成` 且写入成功，`恢复默认顺序` 复原 |
| 33 | 要有一个标签管理界面 | ✅ | v0.3.2（§7.7）；工具栏「标签管理」→ `TagManagerDialog`（`GET/POST /tag-defs`）：列表带来源徽标与用量、新建（同名报错）、改名（撞名合并，同步会话 tags/suggestedTags 与规则）、删除（二次确认 + 清引用 + 空规则一并删除）、搜索；host 侧 `vocabulary/createDef/renameDef/removeDef`（tests/tags.test.js 6 例 + tests/client.test.js 1 例） |
| 34 | 右键加标签后面板立刻可见 | ✅ | v0.3.2（D16）；线上 3081 实测：`GET /sessions` 中 `suggestedTags ∩ tags` 的会话数 0（改前 5 条），行内只剩一个实心 chip；`notifyTagWrite(ids)` 广播桥叫醒面板（清 metaCache、重置词表缓存、重探、1.5s 合并刷新），`tags.apply` 用 `withoutAccepted` 清同名建议避免双 chip；GUI 实测右键勾选后行内 chip 出现 |

## §3–§9 章节核对

- **§3 状态词表**：✅ 顺序与优先级一致（待处理 > 运行中 > 阻塞 > 失败 > 已完成未读 > 中断 > 完成）；`deriveStatus` 实测状态优先于索引派生。
- **§4 数据模型**：✅ `state.json` schema 1，`sessions`/`tagDefs`/`rules`/`settings`/`schema`；临时文件 + rename 原子写、300ms 去抖（`host/store.js`）。
- **§5 标签规则语义**：✅ 匹配字段 title/firstMessage/cwd/note；`suggest` 只写 suggestedTags，`apply` 只追加不删除。
- **§6 AI 流水线**：✅ 批次并发 2、每批 8、上限 50；未注入 `llm` 时 503 `llm_unavailable` 且按钮置灰（D4）。
- **§7 交互规格**：见上表；补充 §7.4 轮询 800ms、打开面板额外拉一次 `GET /jobs`（已实现）。
- **§8 HTTP 契约**：✅ 全量 25 条路由（+ v0.3 `GET /session-meta`），错误统一 `{error:{code,message}}`；tests/api.test.js 23 条覆盖。
- **§9 持久化**：✅ `state.json`/`status-index.json`/`trash.json`/`jobs.json` 原子写；`trash/<id>/` 整目录搬移。

## 未做 / 明确不做（M2 待办）

1. 原生「分组方式」菜单里加「按状态/按标签」— **做不到**（D13，硬编码数组无插槽）。
2. 原生菜单隐藏/重排原生项 — **做不到**（D14，只能追加）。
3. 右键子菜单新建标签 — 不做（D15，条目只能是按钮）。
4. 回收站行上的真实右键菜单（D11）：回收站仍是对话框，`restore/purge` 纯函数形态存在，`purge` 固定禁用。
5. 标签颜色、层级/别名、批量合并多个词、词表撤销 — M2（v0.3.2 只做了名字层面的 CRUD，ADR-0009「后果」）。
6. 虚拟滚动、英文文案打磨 — M2。（分组拖动排序原在此列，v0.3.1 已提前实现；标签词表 CRUD 原在此列，v0.3.2 已提前实现。）
7. AI 链路的端到端 GUI 验收：本机没有模型路由，只能验证到“按钮置灰 + 理由”（D4）。

## 测试分布（233 passed）

`client.test.js` 83 / `api.test.js` 23 / `ai.test.js` 21 / `ai-prompt.test.js` 17 / `trash.test.js` 17 / `rules.test.js` 16 / `tags.test.js` 16 / `status.test.js` 14 / `jobs.test.js` 12 / `e2e-contract.test.js` 12 / `wiring.test.js` 2。

v0.3.2 新增：`tags.test.js` +7（apply 清同名建议、旧 state.json 在读取时清双 chip、vocabulary 用量排序、createDef、renameDef 合并、removeDef 清引用并删空规则、/tag-defs 路由三种 op 与 4 条 400 文案）；`client.test.js` +3（`subscribeTagWrite/notifyTagWrite` 叫醒面板、`TagManagerDialog` 新建/改名/删除全流程、`decorateRows` 清同名建议）。
