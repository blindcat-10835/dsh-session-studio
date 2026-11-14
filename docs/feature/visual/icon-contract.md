# 分类图标与统一视觉

> 契约（冻结）：[SPEC.md §视觉与图标契约](../../../SPEC.md)。本文件记录实现落点与验证方式。

## 问题

插件里「分类」出现点很多：会话状态、时间桶、分组维度、标签、标签来源、规则动作模式、
后台任务状态、空态、原生左栏徽标与悬停卡。改动前只有状态是一个 8px 色点，其余分类全靠
文字；同一分类在不同组件里各画各的（emoji、字符、纯色块），没有单一映射。

## 方案

- `icons/classification-icons.mjs` 是唯一手写的映射表：24×24 字形库 + 8 张分类表
  （status / bucket / group / mark / tagSource / ruleMode / empty / job）。
- `tools/sync-icon-map.mjs` 把 `iconLib()` 序列化进 `client.js` 的 `@icon-map` 生成块；
  客户端是无构建 bundle，不能 `import`，所以用「生成 + 逐字节比对」替代运行时共享。
- `Icon` / `StatusIcon` / `GroupIcon` / `Badge` / `JobStateIcon` 是唯一渲染出口；
  组件不再拼 svg、不写 emoji、不写颜色。
- 色板收敛为 6 个语义 tone，全部映射宿主 `--dsw-alias-*` 令牌，浅色/深色共用。

## 出现点清单

见 SPEC.md §3；每一行都有 `tests/icons.test.js` 的渲染断言。测试分两类：

1. **结构**：生成块与 canonical 源深比较；所有表项的字形与 tone 合法；七档状态图标唯一。
2. **渲染**：`StatusDot`、`GroupHeadContent`、`Row`、`DetailPane`、`Chip`、`RulesDialog`、
   `JobsIndicator/JobRow`、`RowStatusBadge/RowHoverSection`、`EmptyState`、`Page`
   （概览/分组切换/筛选）逐个断言 `[data-sm-icon]`。

## 反向红证（2026-11-14 实测）

每条都是「改坏 → `node --test tests/icons.test.js` 变红 → 还原 → 14/14 绿」：

| 改坏方式 | 变红的用例 | 读数 |
|---|---|---|
| 删掉 `Row` 里的 `StatusDot` | rows render the status glyph … | 13 pass / 1 fail |
| 删掉 `GroupHeadContent` 的 `GroupIcon` | group heads carry the category glyph … | 13 pass / 1 fail |
| 手改 client 生成块里 `failed` 的字形 | byte-identical to the canonical module | 13 pass / 1 fail |
| canonical 里把 `failed` 改成 `running` 的 `play` 并重新生成 | seven session statuses … all mapped（唯一性） | 13 pass / 1 fail |
| canonical 里删掉 `earlier` 时间桶并重新生成 | time buckets … all mapped + groupIconMeta | 12 pass / 2 fail |

## 门禁

```bash
node --check client.js
node --test tests/*.test.js
```
