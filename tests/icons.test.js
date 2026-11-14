/**
 * Icon contract (SPEC.md §视觉与图标契约).
 *
 * Two kinds of proof:
 *   - 单一来源：`icons/classification-icons.mjs`（canonical）与 client.js 的
 *     `@icon-map` 生成区块必须逐字节同源；新增分类只改前者。
 *   - 覆盖完整：每个分类维度、每个分类出现点（状态点、组头、行、筛选、概览、
 *     详情、标签 chip、标签管理、规则、任务状态、原生左栏徽标、空态）都渲染
 *     来自同一映射表的图标。删掉任何一处图标或改错映射，本文件必须变红。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as LIB from '../icons/classification-icons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_FILE = path.join(ROOT, 'client.js');
const SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8');

/* ------------------------------------------------------------------ *
 * Minimal render harness (same shape as tests/client.test.js)
 * ------------------------------------------------------------------ */

function flattenChildren(input) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    if (value === null || value === undefined || value === false || value === true) return;
    out.push(value);
  };
  walk(input);
  return out;
}

function createFakeReact() {
  function createElement(type, props, ...rest) {
    const children = flattenChildren(rest);
    const merged = Object.assign({}, props || {});
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
    if (typeof type === 'function') return type(merged);
    return { type: typeof type === 'string' ? type : 'component', props: merged, children };
  }
  return {
    createElement,
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() {},
    useMemo(fn) { return fn(); },
    useRef(value) { return { current: value }; }
  };
}

function loadPlugin() {
  const document = {
    head: { appendChild() { return {}; } },
    body: { appendChild() {} },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    querySelector() { return null; }
  };
  let moduleDef = null;
  const sandbox = {
    window: { navigator: { language: 'zh-CN' }, __ModuleLoader__: { load(def) { moduleDef = def; } } },
    navigator: { language: 'zh-CN' },
    document,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    fetch() { throw new Error('icon tests must not call fetch'); }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: CLIENT_FILE });
  assert.ok(moduleDef, 'window.__ModuleLoader__.load must be called');
  return moduleDef.factory(function require(name) {
    if (name === 'react') return createFakeReact();
    throw new Error('unexpected require: ' + name);
  });
}

function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const entry of node) findNodes(entry, predicate, out); return out; }
  if (typeof node !== 'object') return out;
  if (node.props && predicate(node)) out.push(node);
  if (node.children) findNodes(node.children, predicate, out);
  return out;
}

const iconNodes = (node) => findNodes(node, (entry) => entry.type === 'svg' && entry.props && entry.props['data-sm-icon']);
const iconNames = (node) => iconNodes(node).map((entry) => entry.props['data-sm-icon']);
const byClass = (node, className) => findNodes(node, (entry) => String(entry.props.className || '').split(/\s+/).includes(className));

const plugin = loadPlugin();
const helpers = plugin.helpers;
const components = plugin.components;

/* ------------------------------------------------------------------ *
 * Single source of truth
 * ------------------------------------------------------------------ */

test('client bundle icon block is byte-identical to the canonical module', () => {
  const begin = SOURCE.indexOf('/* @icon-map:begin');
  const end = SOURCE.indexOf('/* @icon-map:end */');
  assert.ok(begin > 0 && end > begin, 'client.js keeps the generated @icon-map markers');
  const block = SOURCE.slice(begin, end);
  const match = block.match(/var ICON_LIB = (\{[\s\S]*\});\s*$/);
  assert.ok(match, 'the generated block declares exactly one ICON_LIB literal');
  const embedded = JSON.parse(match[1]);
  assert.deepEqual(embedded, JSON.parse(JSON.stringify(LIB.iconLib())),
    'run `node tools/sync-icon-map.mjs` after editing icons/classification-icons.mjs');
});

test('every icon table entry resolves to an existing glyph and a sanctioned tone', () => {
  for (const kind of Object.keys(LIB.CATEGORY_ICONS)) {
    const table = LIB.CATEGORY_ICONS[kind];
    assert.ok(Object.keys(table).length > 0, kind + ' has entries');
    for (const [key, meta] of Object.entries(table)) {
      assert.ok(LIB.ICON_PATHS[meta.icon], kind + '.' + key + ' → unknown glyph ' + meta.icon);
      assert.ok(LIB.ICON_TONES.includes(meta.tone), kind + '.' + key + ' → unknown tone ' + meta.tone);
    }
  }
  for (const [name, spec] of Object.entries(LIB.ICON_PATHS)) {
    assert.ok(Array.isArray(spec) && spec.length > 0, name + ' has drawable children');
    for (const entry of spec) {
      assert.ok(Array.isArray(entry) && typeof entry[0] === 'string', name + ' child is [tag, attrs]');
    }
  }
});

test('the seven session statuses, time buckets, group dimensions and job states are all mapped', () => {
  assert.deepEqual(Object.keys(LIB.STATUS_ICONS), helpers.STATUS_IDS);
  assert.deepEqual(Object.keys(LIB.BUCKET_ICONS), helpers.BUCKET_IDS);
  assert.deepEqual(Object.keys(LIB.GROUP_ICONS), helpers.GROUP_IDS);
  for (const state of helpers.JOB_STATES.concat(['idle'])) {
    assert.ok(LIB.JOB_ICONS[state], 'job state ' + state + ' has an icon');
  }
  const statusGlyphs = helpers.STATUS_IDS.map((id) => LIB.STATUS_ICONS[id].icon);
  assert.equal(new Set(statusGlyphs).size, statusGlyphs.length,
    'each status keeps its own glyph — statuses are not colour-only');
});

test('groupIconMeta resolves every group key form to the same category glyph', () => {
  for (const status of helpers.STATUS_IDS) {
    assert.deepEqual(helpers.groupIconMeta('status:' + status), LIB.STATUS_ICONS[status]);
  }
  for (const bucket of helpers.BUCKET_IDS) {
    assert.deepEqual(helpers.groupIconMeta('time:' + bucket), LIB.BUCKET_ICONS[bucket]);
  }
  assert.equal(helpers.groupIconMeta('tag:华为').icon, 'tag');
  assert.equal(helpers.groupIconMeta('untagged').icon, 'tagOff');
  assert.equal(helpers.groupIconMeta('all').icon, LIB.GROUP_ICONS.none.icon);
});

/* ------------------------------------------------------------------ *
 * Every category occurrence renders an icon
 * ------------------------------------------------------------------ */

test('StatusDot renders the mapped glyph plus an accessible name for all seven statuses', () => {
  for (const status of helpers.STATUS_IDS) {
    const tree = components.StatusDot({ status });
    assert.equal(tree.props.role, 'img');
    assert.equal(tree.props['aria-label'], plugin.dictionary.en['status.' + status]);
    assert.equal(tree.props['data-sm-status'], status);
    assert.deepEqual(iconNames(tree), [LIB.STATUS_ICONS[status].icon]);
  }
});

test('group heads carry the category glyph for status, time, tag and untagged groups', () => {
  const cases = [
    { key: 'status:running', icon: LIB.STATUS_ICONS.running.icon },
    { key: 'time:today', icon: LIB.BUCKET_ICONS.today.icon },
    { key: 'tag:华为', icon: 'tag' },
    { key: 'untagged', icon: 'tagOff' },
    { key: 'all', icon: LIB.GROUP_ICONS.none.icon }
  ];
  for (const entry of cases) {
    const group = { key: entry.key, label: 'G', total: 1, counts: { running: 1 } };
    const tree = components.GroupHeadContent({ group, collapsed: false });
    const head = byClass(tree, 'sm-group-icon')[0];
    assert.ok(head, entry.key + ' renders a group icon slot');
    assert.deepEqual(iconNames(head), [entry.icon]);
  }
});

test('rows render the status glyph and every mark glyph (locked / archived / pinned / subagent)', () => {
  const row = {
    id: 's-icon-1', title: 'T', status: 'pending', cwd: '/w', updatedAt: 1,
    tags: [], suggestedTags: [], titleLocked: true, archived: true, pinned: true, subagent: true
  };
  const tree = components.Row({ row, selected: false });
  const names = iconNames(tree);
  assert.equal(names[0], LIB.STATUS_ICONS.pending.icon, 'the row status glyph is first');
  for (const mark of ['lock', 'archive', 'pin', 'branch']) {
    assert.ok(names.includes(mark), 'row badge glyph ' + mark);
  }
});

test('detail pane renders the status glyph and tag glyphs', () => {
  const row = {
    id: 's-icon-2', title: 'T', status: 'failed', cwd: '/w', updatedAt: 1,
    tags: ['bug'], suggestedTags: [], note: '', lastTurnEnd: 'error', intent: null
  };
  helpers.cacheRows([row]);
  const tree = components.DetailPane({ sessionId: row.id, row, onClose() {}, onChanged() {} });
  const names = iconNames(tree);
  assert.equal(names[0], LIB.STATUS_ICONS.failed.icon, 'detail header carries the status glyph');
  assert.ok(names.includes('tag'), 'each tag chip carries the tag glyph');
});

test('tag chips use the one tag glyph, muted for suggestions', () => {
  for (const muted of [false, true]) {
    const tree = components.Chip({ label: 'bug', muted });
    assert.deepEqual(iconNames(tree), ['tag']);
  }
});

test('rules render the rule glyph and the action-mode glyph', () => {
  const tree = components.RulesDialog({
    rules: [{
      id: 'r-1', name: '华为项目', enabled: true,
      match: { keywords: ['华为'], fields: ['title'], mode: 'any' },
      action: { tags: ['华为'], mode: 'suggest' }
    }],
    tagDefs: [{ name: '华为' }],
    busy: false,
    onClose() {},
    onChanged() {},
    onError() {}
  });
  const names = iconNames(tree);
  assert.ok(names.includes('funnel'), 'rule row carries the rule glyph');
  assert.ok(names.includes(LIB.RULE_MODE_ICONS.suggest.icon), 'the mode badge carries its glyph');
  assert.ok(names.includes('tag'), 'action tag chips carry the tag glyph');
});

test('job indicator and job rows use the job-state table', () => {
  const idle = components.JobsIndicator({ activeJobs: [], latest: { state: 'failed' }, open: false, onToggle() {} });
  assert.ok(iconNames(idle).includes(LIB.JOB_ICONS.failed.icon));
  const running = components.JobRow({
    job: { id: 'j1', state: 'running', type: 'ai.rename', total: 3, done: 1, failed: 0, skipped: 0, items: [], active: true }
  });
  assert.ok(iconNames(running).includes(LIB.JOB_ICONS.running.icon));
});

test('native sidebar badge and hover card render status and tag glyphs', () => {
  helpers.mergeSessionMeta({ 's-native': { running: false, lastTurnEnd: 'completed', tags: ['a', 'b'] } });
  const badge = components.RowStatusBadge({ sessionId: 's-native' });
  const badgeNames = iconNames(badge);
  assert.deepEqual(badgeNames, [LIB.STATUS_ICONS.completed.icon, 'tag']);
  const hover = components.RowHoverSection({ sessionId: 's-native' });
  assert.ok(iconNames(hover).includes(LIB.STATUS_ICONS.completed.icon));
  assert.ok(iconNames(hover).includes('tag'));
});

test('empty states resolve their glyph through the empty table', () => {
  for (const key of ['empty', 'filtered', 'error', 'tag', 'trash', 'rule', 'search']) {
    const tree = components.EmptyState({ icon: key, title: 't' });
    assert.deepEqual(iconNames(tree), [LIB.EMPTY_ICONS[key].icon], key);
  }
});

test('page overview, group-by segment and filters all render category glyphs', () => {
  const tree = components.Page({});
  const overview = byClass(tree, 'sm-overview-label');
  assert.equal(overview.length, helpers.OVERVIEW_IDS.length, 'one icon per overview card');
  for (const node of overview) assert.equal(iconNodes(node).length, 1);
  const segs = byClass(tree, 'sm-seg-btn');
  assert.equal(segs.length, helpers.GROUP_IDS.length, 'one icon per grouping dimension');
  for (const node of segs) assert.equal(iconNodes(node).length, 1);
  const filters = byClass(tree, 'sm-filter-chip');
  for (const node of filters) assert.equal(iconNodes(node).length, 1, 'every filter chip is icon+text');
});
