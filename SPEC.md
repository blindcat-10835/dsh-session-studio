# dsh-session-studio — 视觉与图标契约（frozen）

> 本文件冻结插件的分类视觉：哪些概念算分类、每类用什么图标、图标在哪些出现点必须存在。
> 产品语义见 [docs/PRD.md](docs/PRD.md)，术语见 [CONTEXT.md](CONTEXT.md)；本文件只赢「图标与观感」，
> 不改交互语义、不改数据结构。

## 1. 单一映射表

| 层 | 位置 | 规则 |
|---|---|---|
| canonical 源 | `icons/classification-icons.mjs` | **唯一手写**的图标字形与分类映射；新增/改名只改这里 |
| client 生成块 | `client.js` 的 `@icon-map:begin … @icon-map:end` | 由 `node tools/sync-icon-map.mjs` 从 canonical 源序列化；**禁止手改** |
| 运行期查询 | `iconMetaOf(kind, key)` / `groupIconMeta(groupKey)` | 组件只能通过这两个函数取图标；未知键回落 `dot`，不猜名字、不换色 |

`tests/icons.test.js` 逐字节比较 canonical `iconLib()` 与 client 生成块。两侧漂移即红：

```bash
node tools/sync-icon-map.mjs      # 改完 canonical 源后重新生成
node --check client.js
node --test tests/*.test.js       # 含「生成块 == canonical」用例
```

## 2. 分类维度与图标

字形 24×24 viewBox、`stroke=currentColor`、`stroke-width=1.6`、圆角端点；与
dsh-task-workbench（AIDEV-159）的 `ICON_PATHS` 同名同形，两个插件观感一致。

### 会话状态（`STATUS_ICONS`，优先级即数组顺序）

| key | 图标 | tone | 语义 |
|---|---|---|---|
| `pending` | `clock` | warn | 待处理：停在等你回应 |
| `running` | `play` | brand | 运行中 |
| `blocked` | `shield` | warn | 阻塞：前置策略拒绝 |
| `failed` | `circleX` | error | 失败 |
| `unread` | `circleDot` | success | 已完成未读 |
| `completed` | `circleCheck` | success | 完成（透明度 .72） |
| `interrupted` | `stop` | muted | 中断/取消 |

七档图标互不重复：状态不是只靠颜色区分。

### 时间桶（`BUCKET_ICONS`）

`today → sun`、`week → calendarWeek`、`month → calendarMonth`、`earlier → rewind`，均 neutral/muted。

### 分组维度（`GROUP_ICONS`）

`status → layers`、`time → clock`、`tag → tag`、`none → tree`。

### 其他分类表

| 表 | 键 → 图标 |
|---|---|
| `MARK_ICONS` | `locked → lock`、`archived → archive`、`pinned → pin`、`subagent → branch` |
| `TAG_SOURCE_ICONS` | `manual → manual`、`rule → funnel`、`ai → spark` |
| `RULE_MODE_ICONS` | `suggest → spark`、`apply → check` |
| `JOB_ICONS` | queued `clock` / running `play` / succeeded `check` / failed `circleX` / cancelled `stop` / interrupted `pause` / idle `clock` |
| `EMPTY_ICONS` | empty `inbox` / filtered `filter` / error `alert` / search `search` / tag `tag` / rule `funnel` / trash `archive` |

标签本身固定 `tag`；`untagged` 组固定 `tagOff`。分组键 `status:*` / `time:*` / `tag:*` / `untagged` / `all`
统一经 `groupIconMeta` 解析。

## 3. 必须出现图标的位置（no icon-free category）

| 出现点 | 组件 | 断言 |
|---|---|---|
| 面板行状态点 | `Row` → `StatusDot` | 状态图标 + `role=img` + `aria-label` |
| 面板行叠加标记 | `Row` → `Badge` | locked/archived/pinned/subagent 各自字形 |
| 分组头 | `GroupHeadContent` | 每个 status/time/tag/untagged/all 组都有 `sm-group-icon` |
| 组头状态计数 | `GroupHeadContent` | 每档计数前是状态图标 |
| 顶部概览卡 | `Page` → `.sm-overview-label` | 四张卡各一个状态图标 |
| 分组维度切换 | `Page` → `.sm-seg-btn` | 四个维度各一个组图标 |
| 状态/时间/标签筛选 | `Page` → `.sm-filter-chip`、标签选择 | 每个 chip 都有图标；标签 chip 用 `tag` |
| 详情头 | `DetailPane` | 状态图标 + 标签 chip 图标 |
| 标签 chip / 建议标签 | `Chip` | 恒有 `tag`，建议态 muted |
| 标签管理行 | `TagManagerDialog` | 标签字形 + 来源字形 |
| 标签规则行 | `RulesDialog` | 规则字形 + 模式字形 + 动作标签字形 |
| 后台任务状态 | `JobsIndicator` / `JobRow` | 走 `JOB_ICONS` |
| 原生左栏行尾徽标 | `RowStatusBadge` | 状态图标；有标签时再加标签图标与数量 |
| 原生悬停卡 | `RowHoverSection` | 状态图标 + 每个标签字形 |
| 空态 | `EmptyState` | 走 `EMPTY_ICONS` |

「出现点」是封闭清单：新增分类展示必须先加进本表并在 `tests/icons.test.js` 补渲染断言。

## 4. 尺寸、对齐与间距

- 图标尺寸：行/组头/筛选 13–15px，chip/badge 11–12px，原生徽标 12px，空态 22px。
- 垂直对齐：图标放在 `inline-flex; align-items:center` 的行内，`line-height:0`，不撑高行高；
  纯文本旁用 `vertical-align:middle`。
- 间距取 4 的倍数：chip `gap 4px / padding 0 7px / height 20px`，badge `gap 3px / height 18px`，
  组头 `padding 9px 8px / gap 8px`，概览卡 `padding 10px 12px / gap 3px`。
- 圆角收敛：chip 6px、badge 5px、概览卡 9px；不再新增一套圆角。
- 颜色只走 6 个语义 tone（neutral/muted/brand/warn/error/success），每个 tone 只引用宿主
  `--dsw-alias-*` 令牌（`label-secondary`、`label-tertiary`、`brand-primary`、`state-*-primary`），
  浅色/深色由主题令牌负责对比度；调用点不得写颜色字面量。
- 状态 `running` 的图标做 `sm-pulse` 呼吸；`completed` 降低透明度，静止但仍可读。

## 5. 无障碍

- 纯图标（状态点、原生徽标、图标按钮）必须 `role="img"` + `aria-label` + `title`。
- 图标旁已有文字（组头、筛选、chip、badge、任务状态）时图标是装饰，加 `aria-hidden="true"`，
  不重复朗读。
- 分类采用「颜色 + 图标 + 文字」三重编码；任何一处去掉图标后仍须能靠文字识别，但门禁会因
  图标缺失变红。

## 6. 与 AIDEV-159（任务台插件）共享

- 共享的是 canonical 映射与字形语言，不是运行时代码：两个插件的 client 都是无构建单文件，
  dsh loader 只保证 `require('react')`，不能跨包 require。
- 消费契约：任务台以 `icons/classification-icons.mjs` 为源，用同一套「生成块 + JSON 比对」
  手法刷进自己的 bundle；不要另一侧手写第二份映射。
- 同名词形必须同形：`tag/play/pause/stop/clock/calendar/alert/check/circle*/lock/branch/
  shield/layers/inbox/filter/spark/rewind/manual/funnel` 与任务台 `ICON_PATHS` 保持一致。

## 7. 门禁与反向红证

```bash
node --check client.js
node --check icons/classification-icons.mjs
node --test tests/*.test.js
```

反向红证（提交前人工执行并记录）：

1. 删掉 `Row` 里的 `StatusDot` 或 `GroupHeadContent` 的 `GroupIcon` → `icons.test.js` 对应用例失败；
2. 把 `STATUS_ICONS.failed.icon` 改成 `play` → 唯一性/渲染断言失败；
3. 手改 client 生成块任一图标 → 「byte-identical to the canonical module」失败。

实机自证：dsh web（现役 :3080）打开会话面板，浅色/深色各截图一张；若换了 launch token，
必须提示用户重新授权。
