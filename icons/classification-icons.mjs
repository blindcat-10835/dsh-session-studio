/**
 * dsh-session-studio — 分类图标唯一映射表（canonical source）。
 *
 * 这个文件是「分类 → 图标」的**唯一出处**：`client.js` 里 `@icon-map` 区块由
 * `node tools/sync-icon-map.mjs` 从这里生成，`tests/icons.test.js` 逐字节比对两者。
 * 不要手改 client.js 里的生成区块，也不要让组件自己拼 svg / emoji / 换色。
 *
 * 视觉语言与 dsh-task-workbench 的 `ICON_PATHS`（AIDEV-159）一致：24×24 viewBox、
 * `stroke=currentColor`、`stroke-width=1.6`、圆角端点；能同名复用的字形直接复用，
 * 两个插件的同一分类在观感上必须是同一套。颜色只走少量语义 tone（neutral /
 * muted / brand / warn / error / success），具体色值由 client.js 的 CSS 用
 * `--dsw-alias-*` 令牌映射，浅色/深色主题由宿主令牌负责对比度。
 *
 * 消费契约（AIDEV-159 任务台插件）：
 *   1. 以本文件为源，不要在另一侧手写第二份映射；
 *   2. 用同一个 `tools/sync-icon-map.mjs` 思路把自己 client bundle 的生成区块
 *      从本模块刷出，并用测试比对 `ICON_LIB` 与 `iconLib()` 的 JSON 是否相等；
 *   3. 新增分类先改本文件，再跑生成器，最后补「每个出现点都渲染图标」的用例。
 */

const raw = (tag, attrs) => [tag, attrs];
const p = (d) => raw('path', { d });
const c = (cx, cy, r, attrs) => raw('circle', Object.assign({ cx, cy, r }, attrs || {}));
const r = (x, y, width, height, rx) => raw('rect', { x, y, width, height, rx: rx === undefined ? 2 : rx });

/**
 * 字形库：值是可 JSON 序列化的 [tag, attrs] 数组，便于原样嵌进无构建的
 * client bundle，也便于测试把两侧当成同一份数据比较。
 */
export const ICON_PATHS = {
  /* ---- 与 task-workbench ICON_PATHS 同名同形（共享语义） ---- */
  tree: [p('M8 6h13M8 12h13M8 18h13'), p('M3.5 6h.01M3.5 12h.01M3.5 18h.01')],
  tag: [p('M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z'), c(7.5, 7.5, 1.2)],
  play: [p('M7 4.5v15l12-7.5z')],
  pause: [p('M8 5v14M16 5v14')],
  stop: [r(6, 6, 12, 12, 2)],
  clock: [c(12, 12, 8), p('M12 8v4l3 2')],
  calendar: [r(3, 5, 18, 16, 2), p('M3 10h18M8 3v4M16 3v4')],
  alert: [p('M12 4l8 14H4zM12 10v4M12 16.5h.01')],
  check: [p('M5 13l4 4L19 7')],
  circle: [c(12, 12, 9)],
  circleDot: [c(12, 12, 9), raw('circle', { cx: 12, cy: 12, r: 3.5, fill: 'currentColor', stroke: 'none' })],
  circleCheck: [c(12, 12, 9), p('M8.2 12.4 11 15.2 15.8 9')],
  circleX: [c(12, 12, 9), p('M9.2 9.2 14.8 14.8M14.8 9.2 9.2 14.8')],
  lock: [r(5, 11, 14, 9, 2), p('M8 11V8a4 4 0 0 1 8 0v3')],
  manual: [p('M5 4h9l5 5v11H5z'), p('M14 4v5h5'), p('M8 13h8M8 16h5')],
  spark: [p('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z')],
  filter: [p('M4 6h16M7 12h10M10 18h4')],
  chevronRight: [p('M9 6l6 6-6 6')],
  chevronDown: [p('M6 9l6 6 6-6')],
  close: [p('M6 6l12 12M18 6L6 18')],
  refresh: [p('M20 11a8 8 0 1 0-2.3 6.4'), p('M20 5v6h-6')],
  external: [p('M14 4h6v6M20 4l-8 8'), p('M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')],
  link: [p('M10.5 13.5a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13.5 4.8l-1.4 1.4'), p('M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4')],
  rewind: [p('M4 11a8 8 0 1 0 2.6-5.9'), p('M4 4v6h6')],
  sliders: [p('M4 7h9M17 7h3M4 17h5M13 17h7'), c(15, 7, 2), c(11, 17, 2)],
  folder: [p('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z')],
  flag: [p('M6 21V4M6 5h11l-2 3 2 3H6')],
  info: [c(12, 12, 8), p('M12 11v5M12 8h.01')],
  copy: [r(9, 9, 11, 11, 2), p('M5 15V5a1 1 0 0 1 1-1h9')],
  branch: [c(6, 6, 2.5), c(6, 18, 2.5), c(18, 9, 2.5), p('M6 8.5v7M18 11.5c0 3-3 3.5-6 4.5')],
  shield: [p('M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z')],
  bell: [p('M6 9a6 6 0 0 1 12 0c0 4 1 5 1 5H5s1-1 1-5zM10 19a2 2 0 0 0 4 0')],
  layers: [p('M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5')],
  inbox: [p('M4 6h16v12H4zM4 13h5l1 2h4l1-2h5')],
  hash: [p('M5 9h14M5 15h14M10 4 8 20M16 4l-2 16')],
  dot: [c(12, 12, 8), c(12, 12, 3)],
  search: [c(11, 11, 7), p('M20 20l-3.7-3.7')],
  plus: [p('M12 5v14M5 12h14')],
  minus: [p('M5 12h14')],

  /* ---- 本插件新增（同一 24 网格、同一笔画语言） ---- */
  sun: [
    c(12, 12, 4),
    p('M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6')
  ],
  calendarWeek: [r(3, 5, 18, 16, 2), p('M3 10h18M8 3v4M16 3v4M7 14h2M11 14h2M15 14h2')],
  calendarMonth: [
    r(3, 5, 18, 16, 2),
    p('M3 10h18M8 3v4M16 3v4M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2M15 17h2')
  ],
  tagOff: [p('M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z'), c(7.5, 7.5, 1.2), p('M4 20 20 4')],
  archive: [r(3, 4, 18, 5, 1.5), p('M5 9v10h14V9M10 13h4')],
  pin: [p('M9 3h6l-1 6 4 4H6l4-4-1-6z'), p('M12 13v8')],
  funnel: [p('M4 5h16l-6 7v6l-4 2v-8L4 5z')],
  list: [p('M4 6h16M4 12h16M4 18h16')]
};

/** 语义色 tone；CSS 只认这几个类，不允许调用点自带颜色。 */
export const ICON_TONES = ['neutral', 'muted', 'brand', 'warn', 'error', 'success'];

/** 会话状态七档（PRD §3 / CONTEXT「会话状态」），优先级即数组顺序。 */
export const STATUS_ICONS = {
  pending: { icon: 'clock', tone: 'warn' },
  running: { icon: 'play', tone: 'brand' },
  blocked: { icon: 'shield', tone: 'warn' },
  failed: { icon: 'circleX', tone: 'error' },
  unread: { icon: 'circleDot', tone: 'success' },
  completed: { icon: 'circleCheck', tone: 'success' },
  interrupted: { icon: 'stop', tone: 'muted' }
};

/** 时间桶（CONTEXT「时间桶」）。 */
export const BUCKET_ICONS = {
  today: { icon: 'sun', tone: 'neutral' },
  week: { icon: 'calendarWeek', tone: 'neutral' },
  month: { icon: 'calendarMonth', tone: 'neutral' },
  earlier: { icon: 'rewind', tone: 'muted' }
};

/** 分组维度（状态 / 时间 / 标签 / 不分组）。 */
export const GROUP_ICONS = {
  status: { icon: 'layers', tone: 'neutral' },
  time: { icon: 'clock', tone: 'neutral' },
  tag: { icon: 'tag', tone: 'brand' },
  none: { icon: 'tree', tone: 'neutral' }
};

/** 非状态叠加标记（CONTEXT「叠加标记」）。 */
export const MARK_ICONS = {
  locked: { icon: 'lock', tone: 'muted' },
  archived: { icon: 'archive', tone: 'muted' },
  pinned: { icon: 'pin', tone: 'brand' },
  subagent: { icon: 'branch', tone: 'muted' }
};

/** 标签来源（CONTEXT「标签」）：手动 / 规则 / AI。 */
export const TAG_SOURCE_ICONS = {
  manual: { icon: 'manual', tone: 'muted' },
  rule: { icon: 'funnel', tone: 'brand' },
  ai: { icon: 'spark', tone: 'brand' }
};

/** 标签规则动作模式：只给建议 / 直接应用。 */
export const RULE_MODE_ICONS = {
  suggest: { icon: 'spark', tone: 'brand' },
  apply: { icon: 'check', tone: 'success' }
};

/** 空态与提示。 */
export const EMPTY_ICONS = {
  empty: { icon: 'inbox', tone: 'muted' },
  filtered: { icon: 'filter', tone: 'muted' },
  error: { icon: 'alert', tone: 'error' },
  search: { icon: 'search', tone: 'muted' },
  tag: { icon: 'tag', tone: 'muted' },
  rule: { icon: 'funnel', tone: 'muted' },
  trash: { icon: 'archive', tone: 'muted' }
};

/** 后台任务状态（JobsPanel）。 */
export const JOB_ICONS = {
  queued: { icon: 'clock', tone: 'muted' },
  running: { icon: 'play', tone: 'brand' },
  succeeded: { icon: 'check', tone: 'success' },
  failed: { icon: 'circleX', tone: 'error' },
  cancelled: { icon: 'stop', tone: 'muted' },
  interrupted: { icon: 'pause', tone: 'warn' },
  idle: { icon: 'clock', tone: 'muted' }
};

/** 所有分类维度的总表；`iconMeta(kind, key)` 是唯一查询入口。 */
export const CATEGORY_ICONS = {
  status: STATUS_ICONS,
  bucket: BUCKET_ICONS,
  group: GROUP_ICONS,
  mark: MARK_ICONS,
  tagSource: TAG_SOURCE_ICONS,
  ruleMode: RULE_MODE_ICONS,
  empty: EMPTY_ICONS,
  job: JOB_ICONS
};

const FALLBACK = { icon: 'dot', tone: 'muted' };

/** 唯一查询入口：未知键返回 `dot`（不猜名字、不静默换色）。 */
export function iconMeta(kind, key) {
  const table = CATEGORY_ICONS[kind];
  if (!table) return { icon: 'dot', tone: 'muted', unknown: true };
  const meta = table[key];
  if (!meta) return { icon: 'dot', tone: 'muted', unknown: true };
  return meta;
}

/** 标签分组的一个具体组 → 图标：`tag:<name>` 用标签字形，`untagged` 用反标签字形。 */
export function groupIconMeta(groupKey) {
  const key = String(groupKey || '');
  if (key.indexOf('status:') === 0) return STATUS_ICONS[key.slice(7)] || FALLBACK;
  if (key.indexOf('time:') === 0) return BUCKET_ICONS[key.slice(5)] || FALLBACK;
  if (key.indexOf('tag:') === 0) return { icon: 'tag', tone: 'brand' };
  if (key === 'untagged') return { icon: 'tagOff', tone: 'muted' };
  if (key === 'all') return GROUP_ICONS.none;
  return FALLBACK;
}

/** 快照给生成器 / 测试：一份纯 JSON，client bundle 与 Node 侧比较的就是它。 */
export function iconLib() {
  return {
    ICON_PATHS,
    ICON_TONES,
    STATUS_ICONS,
    BUCKET_ICONS,
    GROUP_ICONS,
    MARK_ICONS,
    TAG_SOURCE_ICONS,
    RULE_MODE_ICONS,
    EMPTY_ICONS,
    JOB_ICONS,
    CATEGORY_ICONS
  };
}
