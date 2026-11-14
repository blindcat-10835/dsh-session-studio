/**
 * Headless tests for client.js: the bundle contract (ModuleLoader, slots,
 * stylesheet ownership), the pure helpers, and one render smoke test per
 * panel/dialog using a tiny fake React.
 *
 * No browser, no jsdom, no network: effects are not executed during renders,
 * so the page stays in its loading phase and the dialogs render from props.
 */
import test from 'node:test';
// Non-strict deepEqual: helper results come from the vm realm, and their
// prototypes differ from this realm's Array/Object even when values match.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const CLIENT_FILE = path.join(PLUGIN_DIR, 'client.js');
const SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8');
const NS = 'dsh-session-studio';

/* ------------------------------------------------------------------ *
 * Fake React and DOM
 * ------------------------------------------------------------------ */

function flattenChildren(input) {
  const out = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value === null || value === undefined || value === false || value === true) return;
    out.push(value);
  };
  walk(input);
  return out;
}

function createFakeReact(requires) {
  function createElement(type, props, ...rest) {
    const children = flattenChildren(rest);
    const merged = Object.assign({}, props || {});
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
    if (typeof type === 'function') return type(merged);
    return { type: typeof type === 'string' ? type : 'component', props: merged, children };
  }
  return {
    createElement,
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; }
  };
}

function createFakeDocument() {
  const created = [];
  const document = {
    head: {
      appendChild(element) {
        element.parentNode = {
          removeChild(node) {
            node.removed = true;
            node.parentNode = null;
            const index = created.indexOf(node);
            if (index >= 0) created.splice(index, 1);
          }
        };
        created.push(element);
        return element;
      }
    },
    body: { appendChild() {} },
    createElement(tagName) {
      return {
        tagName,
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; }
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };
  return { document, created };
}

function loadPlugin(options = {}) {
  const requires = [];
  const react = options.react || createFakeReact(requires);
  const dom = createFakeDocument();
  let moduleDef = null;
  const sandbox = {
    window: {
      navigator: { language: 'zh-CN' },
      __ModuleLoader__: { load(def) { moduleDef = def; } }
    },
    navigator: { language: 'zh-CN' },
    document: dom.document,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    fetch: options.fetch || function () { throw new Error('the render smoke tests must not call fetch'); }
  };
  if (options.localStorage) {
    sandbox.localStorage = options.localStorage;
    sandbox.window.localStorage = options.localStorage;
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: CLIENT_FILE });
  assert.ok(moduleDef, 'window.__ModuleLoader__.load must be called');
  const plugin = moduleDef.factory(function require(name) {
    requires.push(name);
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
  return { moduleDef, plugin, requires, dom };
}

function makeCtx() {
  const effects = [];
  const registrations = [];
  const ctx = {
    effect(fn, label) {
      effects.push({ fn, label });
      return { dispose() {} };
    },
    slots: {
      inject(name, callback) {
        const registration = callback();
        registrations.push({ name, registration });
        return {
          dispose() { registration.disposed = true; }
        };
      },
      register(options, component) {
        return { options, component, disposed: false };
      }
    },
    get() { return null; }
  };
  return { ctx, effects, registrations };
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  /* Icons are decoration: their SVG attribute strings are not UI text. */
  if (node.type === 'svg') return '';
  let text = '';
  if (node.props) {
    for (const value of Object.values(node.props)) {
      if (typeof value === 'string') text += ' ' + value;
    }
  }
  if (node.children) text += ' ' + textOf(node.children);
  return text;
}

function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const entry of node) findNodes(entry, predicate, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.props && predicate(node)) out.push(node);
  if (node.children) findNodes(node.children, predicate, out);
  return out;
}

function findNode(node, predicate) {
  return findNodes(node, predicate)[0] || null;
}

const loaded = loadPlugin();
const plugin = loaded.plugin;
const helpers = plugin.helpers;

/* ------------------------------------------------------------------ *
 * Bundle contract
 * ------------------------------------------------------------------ */

test('module loader receives the documented module id and factory', () => {
  assert.equal(loaded.moduleDef.id, NS);
  assert.equal(typeof loaded.moduleDef.factory, 'function');
});

test('factory returns inject and apply, and requires only react', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout', 'contextMenus', 'uiWorkspace', 'remote', 'remote.session']);
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(loaded.requires, ['react']);
});

test('apply owns five effects: stylesheet, main, menu, row seats, sidebar slot', () => {
  const { ctx, effects, registrations } = makeCtx();
  plugin.apply(ctx);
  assert.deepEqual(effects.map((entry) => entry.label), [
    'dsh-session-studio:style',
    'dsh-session-studio:main',
    'dsh-session-studio:session-tags-menu',
    'dsh-session-studio:sidebar-rows',
    'dsh-session-studio:sidebar'
  ]);

  const disposers = effects.map((entry) => entry.fn());
  assert.equal(loaded.dom.created.length, 1);
  const style = loaded.dom.created[0];
  assert.equal(style.attributes['data-plugin'], NS);
  assert.ok(style.textContent.includes('.sm-page'), 'stylesheet body is installed');

  assert.equal(registrations.length, 4, 'main, two row seats and the sidebar entry');
  const main = registrations.find((entry) => entry.name === 'main');
  const sidebar = registrations.find((entry) => entry.name === 'sidebar.panellist');
  const trailing = registrations.find((entry) => entry.name === 'sidebar.session.row.trailing');
  const hover = registrations.find((entry) => entry.name === 'sidebar.session.row.hover');
  assert.ok(trailing && hover, 'both native row seats are claimed');
  assert.equal(trailing.registration.options.id, 'dsh-session-studio.row-status');
  assert.equal(trailing.registration.options.order, 20);
  assert.equal(typeof trailing.registration.component, 'function');
  assert.equal(hover.registration.options.id, 'dsh-session-studio.row-hover');
  assert.equal(typeof hover.registration.component, 'function');
  assert.equal(main.name, 'main');
  assert.equal(main.registration.options.name, 'main');
  assert.equal(main.registration.options.key, 'session-studio');
  assert.equal(main.registration.options.locale, NS);
  assert.equal(typeof main.registration.component, 'function');

  assert.equal(sidebar.name, 'sidebar.panellist');
  assert.equal(sidebar.registration.options.id, 'session-studio');
  assert.equal(sidebar.registration.options.order, 40);
  assert.equal(sidebar.registration.options.locale, NS);
  assert.equal(typeof sidebar.registration.options.label, 'function');
  assert.equal(sidebar.registration.options.label(), '会话管理');
  assert.equal(typeof sidebar.registration.component, 'function');

  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose();
    else if (dispose && typeof dispose.dispose === 'function') dispose.dispose();
  }
  assert.equal(style.removed, true, 'unload removes the stylesheet');
  assert.equal(main.registration.disposed, true);
  assert.equal(sidebar.registration.disposed, true);
  assert.equal(trailing.registration.disposed, true);
  assert.equal(hover.registration.disposed, true);
});

test('apply contributes the tag submenu to the native session menu', () => {
  const registered = [];
  const { ctx, effects } = makeCtx();
  ctx.get = (name) => (name === 'contextMenus' ? {
    register(contribution) {
      registered.push(contribution);
      return function dispose() { contribution.disposed = true; };
    }
  } : null);
  plugin.apply(ctx);

  const effect = effects.find((entry) => entry.label === 'dsh-session-studio:session-tags-menu');
  assert.ok(effect, 'the session menu effect is registered');
  const dispose = effect.fn();
  assert.equal(registered.length, 2);
  const tags = registered.find((entry) => entry.id === 'dsh-session-studio.tags');
  const panel = registered.find((entry) => entry.id === 'dsh-session-studio.panel-actions');
  assert.ok(tags && panel, 'both contributions are registered');
  assert.equal(tags.target, 'session');
  assert.equal(tags.order, 500);
  assert.equal(panel.order, 550);
  assert.equal(typeof tags.resolve, 'function');
  assert.equal(typeof panel.resolve, 'function');

  dispose();
  assert.equal(tags.disposed, true, 'unload withdraws the tag contribution');
  assert.equal(panel.disposed, true, 'unload withdraws the panel contribution');
});

test('the native menu is the first choice for a row right-click', () => {
  const opened = [];
  const menus = { open(target, point) { opened.push({ target, point }); } };
  const ok = helpers.openNativeSessionMenu(menus, { id: 's1', title: 'Hello world' }, { x: 5, y: 6 });
  assert.equal(ok, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].target.kind, 'session');
  assert.equal(opened[0].target.value.sessionId, 's1');
  assert.equal(opened[0].target.value.displayTitle, 'Hello world');
  assert.equal(opened[0].point.x, 5);
  assert.equal(opened[0].point.y, 6);

  assert.equal(helpers.openNativeSessionMenu(null, { id: 's1' }, { x: 0, y: 0 }), false, 'no capability means the in-panel menu');
  const broken = { open() { throw new Error('popup unavailable'); } };
  assert.equal(helpers.openNativeSessionMenu(broken, { id: 's1' }, { x: 0, y: 0 }), false, 'a throwing popup falls back');
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text() { return Promise.resolve(JSON.stringify(body)); }
  };
}

/** Route table for the tag-menu tests; unmatched requests fail the test. */
function createFetchStub(routes) {
  const calls = [];
  const fetch = (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url, method, body: init && init.body });
    for (const route of routes) {
      if (!url.endsWith(route.path)) continue;
      if (route.method && route.method !== method) continue;
      if (route.status && route.status !== 200) {
        return Promise.resolve({
          ok: false,
          status: route.status,
          statusText: 'ERR',
          text() { return Promise.resolve(JSON.stringify(route.body)); }
        });
      }
      return Promise.resolve(jsonResponse(route.body));
    }
    return Promise.reject(new Error('unexpected fetch: ' + method + ' ' + url));
  };
  return { fetch, calls };
}

test('sessionTagMenuActions checks existing tags and toggles them', async () => {
  const { fetch, calls } = createFetchStub([
    { path: '/state', body: { tagDefs: [{ name: 'bug' }, { name: 'idea' }] } },
    { path: '/sessions/s1/value', body: { id: 's1', tags: ['bug'] } },
    { path: '/tags', method: 'POST', body: { updated: 1 } }
  ]);
  const tagPlugin = loadPlugin({ fetch }).plugin;
  const notices = [];
  const menus = { notify(text, success) { notices.push({ text, success }); } };

  const actions = await tagPlugin.helpers.sessionTagMenuActions({ sessionId: 's1', displayTitle: 'T' }, menus);
  assert.equal(actions.length, 1);
  const parent = actions[0];
  assert.ok(parent.label === '标签' || parent.label === 'Tags', 'the submenu label is localized');
  assert.ok(Array.isArray(parent.children), 'tags live in a submenu');
  assert.equal(parent.children.length, 2);
  assert.equal(parent.children[0].label, '✓ bug', 'a tag the session has is checked');
  assert.equal(parent.children[1].label, 'idea');

  await parent.children[1].run();
  const post = calls.find((call) => call.method === 'POST');
  assert.ok(post, 'adding a tag writes through the host');
  const payload = JSON.parse(post.body);
  assert.deepEqual(payload.sessionIds, ['s1']);
  assert.equal(payload.op, 'replace');
  assert.deepEqual(payload.tags, ['bug', 'idea']);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].success, true);
  assert.ok(notices[0].text.includes('idea'), 'the notice names the tag');
});

test('sessionTagMenuActions removes a tag the session already has', async () => {
  const { fetch, calls } = createFetchStub([
    { path: '/state', body: { tagDefs: ['bug'] } },
    { path: '/sessions/s1/value', body: { id: 's1', tags: ['bug'] } },
    { path: '/tags', method: 'POST', body: { updated: 1 } }
  ]);
  const tagPlugin = loadPlugin({ fetch }).plugin;
  const notices = [];
  const actions = await tagPlugin.helpers.sessionTagMenuActions({ sessionId: 's1' }, { notify(text, success) { notices.push({ text, success }); } });
  await actions[0].children[0].run();
  const payload = JSON.parse(calls.find((call) => call.method === 'POST').body);
  assert.deepEqual(payload, { sessionIds: ['s1'], op: 'replace', tags: [] });
  assert.ok(notices[0].text.includes('bug'), 'removal reports its own notice');
});

test('sessionTagMenuActions degrades when there are no tags or the host fails', async () => {
  const empty = createFetchStub([
    { path: '/state', body: { tagDefs: [] } },
    { path: '/sessions/s1/value', body: { id: 's1', tags: [] } }
  ]);
  const emptyPlugin = loadPlugin({ fetch: empty.fetch }).plugin;
  const emptyActions = await emptyPlugin.helpers.sessionTagMenuActions({ sessionId: 's1' }, {});
  assert.equal(emptyActions.length, 1);
  assert.equal(emptyActions[0].children[0].disabled, true, 'the empty state is a disabled hint');

  const broken = createFetchStub([{ path: '/state', status: 500, body: { error: { code: 'boom', message: 'boom' } } }]);
  const brokenPlugin = loadPlugin({ fetch: broken.fetch }).plugin;
  const brokenActions = await brokenPlugin.helpers.sessionTagMenuActions({ sessionId: 's1' }, {});
  assert.deepEqual(brokenActions, [], 'a failing host contributes no actions instead of breaking the menu');
});

test('session meta probes batch by id and cache their answer', async () => {
  const calls = [];
  const fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve(jsonResponse({
      items: {
        s1: { id: 's1', lastTurnEnd: 'error', tags: ['bug'], running: false, archived: false, updatedAt: 1 },
        s2: { id: 's2', lastTurnEnd: null, tags: [], running: true, archived: false, updatedAt: 2 }
      }
    }));
  };
  const metaPlugin = loadPlugin({ fetch }).plugin;
  const h = metaPlugin.helpers;
  let notified = 0;
  const unsubscribe = h.subscribeSessionMeta(() => { notified += 1; });

  h.requestSessionMeta('s1');
  h.requestSessionMeta('s2');
  assert.equal(calls.length, 0, 'a visible page of rows is coalesced, not fetched one by one');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 1, 'both rows travel in one batch');
  assert.ok(calls[0].includes('/session-meta?ids=s1%2Cs2'), 'the ids travel as one query: ' + calls[0]);
  assert.equal(notified, 1, 'subscribers repaint once');

  assert.deepEqual(h.metaOf('s1').tags, ['bug']);
  assert.equal(h.metaStatus(h.metaOf('s1')), 'failed');
  assert.equal(h.metaStatus(h.metaOf('s2')), 'running');
  assert.equal(h.metaOf('nope'), null, 'unknown rows simply have no meta');

  h.requestSessionMeta('s1');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 1, 'a cached row is not probed again');
  unsubscribe();
});

test('a tag written from the native menu wakes the panel up (v0.3.2 stale-rows fix)', async () => {
  const harness = createRuntimeHarness();
  const { plugin: runtimePlugin, runtime } = harness;
  runtime.renderComponent(runtimePlugin.components.Page, {});
  await runtime.settle();
  const before = harness.sessionsCalls();

  const seen = [];
  const off = runtimePlugin.helpers.subscribeTagWrite((ids) => seen.push(ids));
  runtimePlugin.helpers.notifyTagWrite(['s-a']);
  assert.deepEqual(seen, [['s-a']], 'every listener hears the written ids');
  off();
  runtimePlugin.helpers.notifyTagWrite(['s-b']);
  assert.deepEqual(seen, [['s-a']], 'unsubscribing stops the delivery');

  // The page listens too, but its reload is debounced so a burst of toggles
  // costs one round trip.
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.ok(harness.sessionsCalls() > before, 'the panel reloaded its rows after the write');
});

test('TagManagerDialog lists the vocabulary and drives create, rename and delete', async () => {
  const runtime = createMiniRuntime();
  const calls = [];
  let defs = [
    { name: '华为', source: 'manual', createdAt: '2026-11-01T00:00:00Z', sessions: 3, suggested: 1 },
    { name: 'bug', source: 'rule', createdAt: '2026-11-02T00:00:00Z', sessions: 0, suggested: 0 }
  ];
  const respond = (body) => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(body)) });
  const fetch = (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ method, body: init && init.body });
    if (method === 'GET') return respond({ tagDefs: defs });
    const payload = JSON.parse(init.body);
    if (payload.op === 'create') defs = defs.concat([{ name: payload.name, source: 'manual', createdAt: null, sessions: 0, suggested: 0 }]);
    if (payload.op === 'rename') defs = defs.map((def) => (def.name === payload.name ? { ...def, name: payload.to } : def));
    if (payload.op === 'remove') defs = defs.filter((def) => def.name !== payload.name);
    return respond({ tagDefs: defs });
  };
  const loadedTagPlugin = loadPlugin({ react: runtime.react, fetch }).plugin;
  // A fresh instance starts in English; applying it once picks the sandbox locale (zh-CN).
  loadedTagPlugin.apply({ effect() { return { dispose() {} }; }, get() { return null; } });
  let changed = 0;
  runtime.renderComponent(loadedTagPlugin.components.TagManagerDialog, { busy: false, onClose() {}, onChanged() { changed += 1; } });
  let tree = await runtime.settle();

  assert.ok(textOf(tree).includes('标签管理'), 'the dialog names itself');
  assert.ok(textOf(tree).includes('华为'));
  assert.ok(textOf(tree).includes('3 个会话'), 'usage counts are shown');
  assert.ok(textOf(tree).includes('规则'), 'the source badge is localized');
  assert.equal(runtime.instancesOf(loadedTagPlugin.components.TagManagerDialog).length, 1);

  const items = findNodes(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('sm-tagmanage-item'));
  assert.equal(items.length, 2);

  const buttonLabelled = (root, label) =>
    findNode(root, (node) => node.type === 'button' && textOf(node.children || null).trim() === label);

  const input = findNode(tree, (node) => node.type === 'input' && node.props.placeholder === '标签名…');
  input.props.onChange({ target: { value: '紫霄V3.5' } });
  tree = await runtime.settle();
  const createButton = buttonLabelled(tree, '新建');
  createButton.props.onClick();
  tree = await runtime.settle();
  assert.deepEqual(JSON.parse(calls.find((call) => call.method === 'POST').body), { op: 'create', name: '紫霄V3.5' });
  assert.ok(textOf(tree).includes('紫霄V3.5'), 'the list adopts the response');
  assert.equal(changed, 1, 'the panel is told to refresh');

  // Rename the first word: the row swaps to an input, Enter commits.
  const renameButton = buttonLabelled(tree, '改名');
  renameButton.props.onClick();
  tree = await runtime.settle();
  const editInput = findNode(tree, (node) => node.type === 'input' && node.props.value === '华为');
  assert.ok(editInput, 'the row turns into an input holding the current name');
  editInput.props.onChange({ target: { value: '华为项目' } });
  tree = await runtime.settle();
  const save = buttonLabelled(tree, '保存');
  save.props.onClick();
  tree = await runtime.settle();
  assert.deepEqual(JSON.parse(calls.filter((call) => call.method === 'POST')[1].body), { op: 'rename', name: '华为', to: '华为项目' });
  assert.ok(textOf(tree).includes('华为项目'));

  // Delete asks once, then removes.
  const deleteButton = buttonLabelled(tree, '删除');
  deleteButton.props.onClick();
  tree = await runtime.settle();
  assert.ok(textOf(tree).includes('删除标签「华为项目」？'), 'deleting is a two-step action');
  const confirm = buttonLabelled(tree, '确认');
  confirm.props.onClick();
  tree = await runtime.settle();
  assert.deepEqual(JSON.parse(calls.filter((call) => call.method === 'POST')[2].body), { op: 'remove', name: '华为项目' });
  const remaining = findNodes(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('sm-tagmanage-item'));
  const names = remaining.map((node) => {
    const label = findNode(node, (child) => String(child.props.className || '') === 'sm-tagmanage-name');
    const text = findNode(label, (child) => child.type === 'span' && child.props && !child.props.className);
    return String(text.children);
  });
  assert.deepEqual(names, ['bug', '紫霄V3.5'], 'only the deleted word is gone');
  assert.ok(textOf(tree).includes('已删除标签「华为项目」'), 'the status line reports what was removed');
});

test('panel-only menu entries appear only while the panel is on screen', () => {
  const opened = [];
  const uiWorkspace = { openSession(id) { opened.push(id); } };
  const closed = helpers.panelSessionMenuActions({ sessionId: 's1' }, { uiWorkspace });
  assert.deepEqual(closed, [], 'the native sidebar sees no panel entries');

  helpers.setPanelActive(true);
  try {
    const seen = [];
    const unsubscribe = helpers.subscribePanelDetail((id) => seen.push(id));
    const actions = helpers.panelSessionMenuActions({ sessionId: 's1' }, { uiWorkspace });
    assert.equal(actions.length, 2);
    assert.equal(actions[0].label, '查看详情');
    actions[0].run();
    assert.deepEqual(seen, ['s1'], 'the detail entry drives the panel split');
    actions[1].run();
    assert.deepEqual(opened, ['s1'], 'the open entry delegates to the workspace service');
    unsubscribe();

    const detailOnly = helpers.panelSessionMenuActions({ sessionId: 's2' }, {});
    assert.equal(detailOnly.length, 1, 'without uiWorkspace only the detail entry remains');
  } finally {
    helpers.setPanelActive(false);
  }
});

test('apply is a no-op when the context has no effect()', () => {
  assert.equal(plugin.apply(null), undefined);
  assert.equal(plugin.apply({}), undefined);
});

/* ------------------------------------------------------------------ *
 * Status derivation — PRD §3 is the single source
 * ------------------------------------------------------------------ */

test('deriveStatus follows the PRD priority: pending > running > blocked > failed > unread > completed > interrupted', () => {
  const base = { running: false, lastTurnEnd: null };
  assert.equal(helpers.deriveStatus(base, { pendingInteraction: { kind: 'approval' }, running: true }), 'pending');
  assert.equal(helpers.deriveStatus(base, { pendingInteraction: { kind: 'question' }, completionUnread: true }), 'pending');
  assert.equal(helpers.deriveStatus(base, { running: true, completionUnread: true }), 'running');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { running: true }), {}), 'running', 'host running is the fallback');
  assert.equal(helpers.deriveStatus({ running: true, lastTurnEnd: 'blocked' }, { running: false }), 'blocked', 'live running overrides blocked');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'blocked' }), {}), 'blocked');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'error' }), {}), 'failed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'max-tokens' }), {}), 'failed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'aborted' }), { completionUnread: true }), 'unread');
  // v0.2: only interrupted/aborted count as an interruption.
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'interrupted' }), {}), 'interrupted');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'aborted' }), {}), 'interrupted', 'a user cancel is an interruption, not a failure');
  // Everything else has no evidence of an interruption, so it is completed.
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'completed' }), {}), 'completed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'forked' }), {}), 'completed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: 'an-unknown-reason' }), {}), 'completed', 'unknown values fall through to completed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: null }), {}), 'completed');
  assert.equal(helpers.deriveStatus(Object.assign({}, base, { lastTurnEnd: undefined }), {}), 'completed');
});

test('pending interactions from any domain stay pending', () => {
  assert.equal(helpers.isPendingInteraction(null), false);
  assert.equal(helpers.isPendingInteraction(undefined), false);
  assert.equal(helpers.isPendingInteraction({ kind: 'approval' }), true);
  assert.equal(helpers.isPendingInteraction({ kind: 'plan-review' }), true);
  assert.equal(helpers.isPendingInteraction({ kind: 'question' }), true);
  assert.equal(helpers.isPendingInteraction({ kind: 'future-domain-kind' }), true);
});

/* ------------------------------------------------------------------ *
 * Time buckets and relative time
 * ------------------------------------------------------------------ */

test('bucketOf uses local calendar days and puts missing time in earlier', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const at = (days, hours) => new Date(2026, 0, 15 - days, hours, 0, 0).getTime();
  assert.equal(helpers.bucketOf(at(0, 9), now), 'today');
  assert.equal(helpers.bucketOf(at(1, 9), now), 'week');
  assert.equal(helpers.bucketOf(at(6, 9), now), 'week');
  assert.equal(helpers.bucketOf(at(7, 9), now), 'month');
  assert.equal(helpers.bucketOf(at(29, 9), now), 'month');
  assert.equal(helpers.bucketOf(at(30, 9), now), 'earlier');
  assert.equal(helpers.bucketOf(0, now), 'earlier');
  assert.equal(helpers.bucketOf(undefined, now), 'earlier');
});

test('relativeTime maps to the units the panel localizes', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  assert.deepEqual(helpers.relativeTime(now - 10 * 1000, now), { unit: 'now', value: 0 });
  assert.deepEqual(helpers.relativeTime(now - 5 * 60000, now), { unit: 'minute', value: 5 });
  assert.deepEqual(helpers.relativeTime(now - 3 * 3600000, now), { unit: 'hour', value: 3 });
  assert.deepEqual(helpers.relativeTime(now - 2 * 86400000, now), { unit: 'day', value: 2 });
  assert.deepEqual(helpers.relativeTime(now - 65 * 86400000, now), { unit: 'month', value: 2 });
  assert.deepEqual(helpers.relativeTime(now - 400 * 86400000, now), { unit: 'year', value: 1 });
  assert.deepEqual(helpers.relativeTime(null, now), { unit: 'unknown', value: 0 });
});

/* ------------------------------------------------------------------ *
 * Filtering, searching, grouping
 * ------------------------------------------------------------------ */

const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();

function fixtureRows() {
  return [
    {
      id: 's-login-1', title: 'Fix Login bug', updatedAt: NOW, running: false, blank: false,
      subagent: false, archived: false, pinned: false, tags: ['bug', '华为'], suggestedTags: [],
      note: '华为 项目', titleLocked: false, lastTurnEnd: null, cwd: '/work/alpha', workspaceTitle: 'alpha'
    },
    {
      id: 's-docs-2', title: 'Write docs', updatedAt: NOW - 10 * 86400000, running: false, blank: false,
      subagent: false, archived: true, pinned: false, tags: [], suggestedTags: [], note: '',
      titleLocked: false, lastTurnEnd: null, cwd: '/work/beta', workspaceTitle: 'beta'
    },
    {
      id: 's-sub-3', title: 'Subagent helper', updatedAt: NOW, running: false, blank: false,
      subagent: true, archived: false, pinned: false, tags: [], suggestedTags: [], note: '',
      titleLocked: false, lastTurnEnd: null
    },
    {
      id: 's-blank-4', title: '', updatedAt: NOW, running: false, blank: true,
      subagent: false, archived: false, pinned: false, tags: [], suggestedTags: [], note: '',
      titleLocked: false, lastTurnEnd: null
    },
    {
      id: 's-failed-5', title: 'Broken deploy', updatedAt: NOW - 2 * 3600000, running: false, blank: false,
      subagent: false, archived: false, pinned: false, tags: ['ops'], suggestedTags: [],
      note: '', titleLocked: true, lastTurnEnd: 'error'
    },
    {
      id: 's-completed-6', title: 'Chat about nothing', updatedAt: NOW - 40 * 86400000, running: false, blank: false,
      subagent: false, archived: false, pinned: false, tags: [], suggestedTags: [],
      note: '', titleLocked: false, lastTurnEnd: 'completed'
    },
    {
      id: 's-interrupted-7', title: 'Cancelled chat', updatedAt: NOW - 3 * 3600000, running: false, blank: false,
      subagent: false, archived: false, pinned: false, tags: [], suggestedTags: [],
      note: '', titleLocked: false, lastTurnEnd: 'aborted'
    }
  ];
}

const DECORATED = helpers.decorateRows(fixtureRows(), {}, NOW);

function ids(rows) { return rows.map((row) => row.id); }

test('decorateRows normalizes tags and derives status/bucket without mutating input', () => {
  const input = fixtureRows();
  const rows = helpers.decorateRows(input, {}, NOW);
  assert.equal(input[0].status, undefined, 'input row is untouched');
  assert.deepEqual(rows[0].tags, ['bug', '华为']);
  assert.equal(rows[0].status, 'completed', 'null lastTurnEnd means "no evidence of interruption"');
  assert.equal(rows[0].bucket, 'today');
  assert.equal(rows[4].status, 'failed');
  assert.equal(rows[5].bucket, 'earlier');
  assert.equal(rows[5].status, 'completed');
  assert.equal(rows[6].status, 'interrupted', 'aborted maps to interrupted');
});

test('decorateRows drops suggestions that are already real tags (v0.3.2)', () => {
  const rows = helpers.decorateRows([
    { id: 'a', tags: ['dsh插件'], suggestedTags: ['dsh插件', 'DTS'], title: '', updatedAt: NOW, blank: false },
  ], {}, NOW);
  assert.deepEqual(rows[0].tags, ['dsh插件']);
  assert.deepEqual(rows[0].suggestedTags, ['DTS'], 'only the unrelated suggestion survives');
  assert.deepEqual(helpers.withoutAcceptedTags(['A', 'b'], ['a']), ['b'], 'the match is case-insensitive');
});

test('filterRows hides blank and subagent rows, and applies the archive view', () => {
  assert.deepEqual(ids(helpers.filterRows(DECORATED, {})), ['s-login-1', 's-failed-5', 's-completed-6', 's-interrupted-7']);
  assert.deepEqual(ids(helpers.filterRows(DECORATED, { showSubagents: true })), ['s-login-1', 's-sub-3', 's-failed-5', 's-completed-6', 's-interrupted-7']);
  assert.deepEqual(ids(helpers.filterRows(DECORATED, { archiveView: 'include' })), ['s-login-1', 's-docs-2', 's-failed-5', 's-completed-6', 's-interrupted-7']);
  assert.deepEqual(ids(helpers.filterRows(DECORATED, { archiveView: 'only' })), ['s-docs-2']);
  assert.deepEqual(ids(helpers.filterRows(DECORATED, { showBlank: true })), ['s-login-1', 's-blank-4', 's-failed-5', 's-completed-6', 's-interrupted-7']);
});

test('search covers title, id prefix, note and tags case-insensitively', () => {
  const visible = (query) => ids(helpers.filterRows(DECORATED, { query }));
  assert.deepEqual(visible('LOGIN'), ['s-login-1']);
  assert.deepEqual(visible('s-login'), ['s-login-1']);
  assert.deepEqual(visible('login-1'), [], 'id matching is a prefix of the whole id, not a substring');
  assert.deepEqual(visible('华为'), ['s-login-1']);
  assert.deepEqual(visible('ops'), ['s-failed-5']);
  assert.deepEqual(visible('alpha'), ['s-login-1'], 'workspace title is searchable too');
  assert.deepEqual(visible('no-such-session'), []);
  assert.deepEqual(visible('   '), ['s-login-1', 's-failed-5', 's-completed-6', 's-interrupted-7']);
});

test('status, bucket and tag filters combine with search', () => {
  const byStatus = ids(helpers.filterRows(DECORATED, { filters: { statuses: ['failed'] } }));
  assert.deepEqual(byStatus, ['s-failed-5']);
  const byBucket = ids(helpers.filterRows(DECORATED, { filters: { buckets: ['today'] } }));
  assert.deepEqual(byBucket, ['s-login-1', 's-failed-5', 's-interrupted-7']);
  const byTag = ids(helpers.filterRows(DECORATED, { filters: { tags: ['华为'] } }));
  assert.deepEqual(byTag, ['s-login-1']);
  const combined = ids(helpers.filterRows(DECORATED, {
    query: 'deploy',
    filters: { statuses: ['failed'], buckets: ['today'], tags: ['ops'] }
  }));
  assert.deepEqual(combined, ['s-failed-5']);
  const miss = ids(helpers.filterRows(DECORATED, { query: 'login', filters: { statuses: ['failed'] } }));
  assert.deepEqual(miss, []);
});

test('statusCounts counts all seven PRD states', () => {
  const counts = helpers.statusCounts(DECORATED);
  assert.deepEqual(helpers.STATUS_IDS, ['pending', 'running', 'blocked', 'failed', 'unread', 'completed', 'interrupted']);
  assert.equal(counts.failed, 1);
  assert.equal(counts.completed, 5);
  assert.equal(counts.interrupted, 1);
  assert.equal(counts.pending, 0);
  assert.equal(counts.running, 0);
  assert.equal(counts.blocked, 0);
  assert.equal(counts.unread, 0);
  assert.equal(Object.keys(counts).length, 7, 'counts always carries every bucket');
});

test('groupRows by status keeps the seven-bucket order, skips empty groups and summarizes', () => {
  const groups = helpers.groupRows(DECORATED, 'status');
  assert.deepEqual(groups.map((group) => group.key), ['status:failed', 'status:completed', 'status:interrupted']);
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['s-failed-5']);
  assert.equal(groups[0].total, 1);
  assert.equal(groups[0].counts.failed, 1);
  assert.equal(groups[1].total, 5);
  assert.equal(groups[1].labelKey, 'status.completed');
  assert.equal(groups[1].counts.completed, 5);
  assert.deepEqual(groups[2].rows.map((row) => row.id), ['s-interrupted-7']);
  assert.equal(groups[2].labelKey, 'status.interrupted');
  assert.deepEqual(groups[2].counts, {
    pending: 0, running: 0, blocked: 0, failed: 0, unread: 0, completed: 0, interrupted: 1
  }, 'every group header counts all seven buckets');
});

test('groupRows by time follows today/week/month/earlier order', () => {
  const groups = helpers.groupRows(DECORATED, 'time');
  assert.deepEqual(groups.map((group) => group.key), ['time:today', 'time:month', 'time:earlier']);
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['s-login-1', 's-sub-3', 's-blank-4', 's-failed-5', 's-interrupted-7']);
  assert.deepEqual(groups[1].rows.map((row) => row.id), ['s-docs-2']);
  assert.deepEqual(groups[2].rows.map((row) => row.id), ['s-completed-6']);
});

test('groupRows by tag repeats multi-tag sessions and puts untagged last', () => {
  const groups = helpers.groupRows(DECORATED, 'tag');
  const keys = groups.map((group) => group.key);
  // zh collation sorts 华为 before the ASCII tags; the exact order is not a contract.
  assert.deepEqual(keys.sort(), ['tag:bug', 'tag:ops', 'tag:华为', 'untagged'].sort());
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  assert.deepEqual(byKey['tag:bug'].rows.map((row) => row.id), ['s-login-1']);
  assert.deepEqual(byKey['tag:华为'].rows.map((row) => row.id), ['s-login-1']);
  assert.equal(groups[groups.length - 1].key, 'untagged', 'untagged is always last');
  assert.equal(byKey.untagged.labelKey, 'group.untagged');
  assert.deepEqual(byKey.untagged.rows.map((row) => row.id), ['s-docs-2', 's-sub-3', 's-blank-4', 's-completed-6', 's-interrupted-7']);
});

test('applyGroupOrder honours the saved order and keeps unknown groups at the end', () => {
  const groups = helpers.groupRows(DECORATED, 'status');
  const saved = ['status:interrupted', 'status:failed'];
  const ordered = helpers.applyGroupOrder(groups, saved);
  assert.deepEqual(
    ordered.map((group) => group.key),
    ['status:interrupted', 'status:failed', 'status:completed'],
    'saved keys first, unsaved ones keep their natural order after them'
  );
  assert.deepEqual(helpers.applyGroupOrder(groups, []).map((group) => group.key), groups.map((group) => group.key), 'an empty order is a no-op');
  assert.deepEqual(helpers.applyGroupOrder(groups, null).map((group) => group.key), groups.map((group) => group.key), 'null is a no-op');
  assert.equal(groups[0].key, 'status:failed', 'the input array is not mutated');
});

test('moveGroupKey drops a group onto its neighbour and ignores unknown keys', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(helpers.moveGroupKey(order, 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(helpers.moveGroupKey(order, 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(helpers.moveGroupKey(order, 'a', 'a'), ['a', 'b', 'c'], 'dropping on itself changes nothing');
  assert.deepEqual(helpers.moveGroupKey(order, 'zz', 'a'), ['a', 'b', 'c'], 'an unknown source is a no-op');
  assert.deepEqual(order, ['a', 'b', 'c'], 'the input array is not mutated');
});

test('moveGroupBy is the keyboard equivalent of one drag step', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(helpers.moveGroupBy(order, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(helpers.moveGroupBy(order, 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(helpers.moveGroupBy(order, 'a', -1), ['a', 'b', 'c'], 'the first group cannot move up');
  assert.deepEqual(helpers.moveGroupBy(order, 'c', 1), ['a', 'b', 'c'], 'the last group cannot move down');
});

test('group order memory round-trips through localStorage and survives garbage', () => {
  assert.deepEqual(helpers.readGroupOrder(), {}, 'a host without storage degrades to the default order');
  assert.equal(helpers.writeGroupOrder({ status: ['status:completed'] }), false, 'no storage, nothing written');

  const store = new Map();
  const pluginWithStorage = loadPlugin({
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); }
    }
  }).plugin.helpers;
  assert.deepEqual(pluginWithStorage.readGroupOrder(), {}, 'nothing saved yet');
  assert.equal(pluginWithStorage.writeGroupOrder({ status: ['status:completed'] }), true);
  assert.deepEqual(pluginWithStorage.readGroupOrder(), { status: ['status:completed'] });
  store.set(pluginWithStorage.GROUP_ORDER_STORAGE_KEY, '{not json');
  assert.deepEqual(pluginWithStorage.readGroupOrder(), {}, 'unparsable memory degrades to the default order');
  store.set(pluginWithStorage.GROUP_ORDER_STORAGE_KEY, '[1,2]');
  assert.deepEqual(pluginWithStorage.readGroupOrder(), {}, 'an array is not an order map');
  store.set(pluginWithStorage.GROUP_ORDER_STORAGE_KEY, '{"time":["time:today"]}');
  assert.deepEqual(pluginWithStorage.readGroupOrder(), { time: ['time:today'] });
});

test('groupRows without a dimension returns one group', () => {
  const groups = helpers.groupRows(DECORATED, 'none');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'all');
  assert.equal(groups[0].total, DECORATED.length);
});

test('sortRows is newest first and stable on id', () => {
  const rows = [
    { id: 'b', updatedAt: 10 },
    { id: 'a', updatedAt: 10 },
    { id: 'c', updatedAt: 20 }
  ];
  assert.deepEqual(helpers.sortRows(rows).map((row) => row.id), ['c', 'a', 'b']);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a', 'c'], 'input is not mutated');
});

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

test('toggleValue adds and removes without mutating', () => {
  const list = ['a'];
  assert.deepEqual(helpers.toggleValue(list, 'b'), ['a', 'b']);
  assert.deepEqual(helpers.toggleValue(list, 'a'), []);
  assert.deepEqual(list, ['a']);
});

test('parseTagInput splits commas and newlines and trims', () => {
  assert.deepEqual(helpers.parseTagInput('bug, 华为\nops,  '), ['bug', '华为', 'ops']);
  assert.deepEqual(helpers.parseTagInput(''), []);
  assert.deepEqual(helpers.parseTagInput(undefined), []);
});

test('basename of a workspace path', () => {
  assert.equal(helpers.basename('/work/alpha'), 'alpha');
  assert.equal(helpers.basename('C:\\work\\beta\\'), 'beta');
  assert.equal(helpers.basename(''), '');
});

test('skipReasonFor implements the PRD batch skip list', () => {
  const base = { running: false, blank: false, subagent: false, archived: false, titleLocked: false };
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { running: true })), 'running');
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { blank: true })), 'blank');
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { subagent: true })), 'subagent');
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { archived: true })), 'archived');
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { titleLocked: true }), { forRename: true }), 'titleLocked');
  assert.equal(helpers.skipReasonFor(Object.assign({}, base, { titleLocked: true })), null, 'lock only blocks renaming');
  assert.equal(helpers.skipReasonFor(base), null);
  assert.equal(helpers.isBatchable(base), true);
  assert.equal(helpers.isBatchable(Object.assign({}, base, { blank: true })), false);
});

/* ------------------------------------------------------------------ *
 * Dictionary and locale files stay in sync
 * ------------------------------------------------------------------ */

test('every copy key has both a Chinese and an English string', () => {
  const zhKeys = Object.keys(plugin.dictionary.zh).sort();
  const enKeys = Object.keys(plugin.dictionary.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length > 150, 'the panel ships a full dictionary');
  for (const key of zhKeys) {
    assert.ok(plugin.dictionary.zh[key].trim() !== '', key + ' has zh copy');
    assert.ok(plugin.dictionary.en[key].trim() !== '', key + ' has en copy');
  }
  assert.equal(plugin.dictionary.zh['status.pending'], '待处理');
  assert.equal(plugin.dictionary.en['status.pending'], 'Pending');
  assert.equal(plugin.dictionary.zh['group.untagged'], '未打标签');
  // host-ai-rules closed set: these keys must exist, not only the codes.
  for (const code of ['running', 'blank', 'subagent', 'titleLocked', 'archived', 'missing',
    'llm_failed', 'unparsable', 'timeout', 'missing_in_response', 'invalid_title', 'unchanged']) {
    assert.ok(plugin.dictionary.zh['skip.' + code], 'skip.' + code + ' is translated');
    assert.ok(plugin.dictionary.en['skip.' + code], 'skip.' + code + ' is translated');
  }
});

test('locale files expose plugin display metadata', () => {
  // The release step generates locale/*.json from plugin.dictionary; the client
  // only owns TEXT. Here we only require the display metadata to be present.
  for (const language of ['zh', 'en']) {
    const parsed = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'locale', language + '.json'), 'utf8'));
    assert.equal(typeof parsed.meta.title, 'string');
    assert.ok(parsed.meta.title.trim() !== '');
    assert.equal(typeof parsed.meta.description, 'string');
  }
});

test('locale JSON client maps mirror the runtime dictionary', () => {
  for (const language of ['zh', 'en']) {
    const parsed = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'locale', language + '.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(parsed.client).sort(),
      Object.keys(plugin.dictionary[language]).sort(),
      language + ' key set'
    );
    for (const key of Object.keys(plugin.dictionary[language])) {
      assert.equal(parsed.client[key], plugin.dictionary[language][key], language + ' ' + key);
    }
    // v0.2 status vocabulary: idle is gone, completed/interrupted are in.
    assert.equal('status.idle' in parsed.client, false);
    assert.equal(parsed.client['status.completed'], language === 'zh' ? '完成' : 'Completed');
    assert.equal(parsed.client['status.interrupted'], language === 'zh' ? '中断' : 'Interrupted');
  }
});

test('API path table covers every host route the panel calls', () => {
  assert.equal(plugin.api.prefix, '/api/dsh-session-studio');
  const paths = plugin.api.paths;
  const expected = {
    state: '/state',
    sessions: '/sessions',
    tags: '/tags',
    tagDefs: '/tag-defs',
    fillMissing: '/tags/fill-missing',
    notes: '/notes',
    rename: '/rename',
    rules: '/rules',
    rulePreview: '/rules/preview',
    ruleApply: '/rules/apply',
    archive: '/archive',
    unarchive: '/unarchive',
    trash: '/trash',
    trashRestore: '/trash/restore',
    aiRenamePreview: '/ai/rename/preview',
    aiRenameApply: '/ai/rename/apply',
    aiTagsPreview: '/ai/tags/preview',
    aiTagsApply: '/ai/tags/apply',
    jobs: '/jobs'
  };
  assert.deepEqual(Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, value])), expected);
  for (const [key, value] of Object.entries(paths)) {
    assert.ok(value.startsWith('/'), key + ' path is absolute under the plugin prefix');
    assert.ok(!value.startsWith(plugin.api.prefix), key + ' path is relative to the prefix');
  }
  // The single rules-by-id route is built as rules + '/' + id.
  assert.equal(paths.rules + '/' + encodeURIComponent('r-1'), '/rules/r-1');
});


/* ------------------------------------------------------------------ *
 * v0.2 — context menu (PRD §7.2)
 * ------------------------------------------------------------------ */

const FULL_CAPS = {
  pin: true, fork: true, open: true, archive: true, unarchive: true,
  clipboard: true, reveal: true, restore: true, trash: true
};

test('menuCapabilities treats every client service as optional', () => {
  const none = helpers.menuCapabilities({});
  assert.deepEqual(none, {
    pin: false, fork: false, open: false, archive: false, unarchive: false,
    clipboard: false, reveal: false, restore: false, trash: false
  });

  const workspace = {
    openSession() {}, forkSession() {}, pinSession() {}, unpinSession() {},
    archiveSession() {}, unarchiveSession() {}
  };
  const remote = { session: { openWorkspacePath() {} } };
  const clipboard = { writeText() {} };
  const all = helpers.menuCapabilities({ uiWorkspace: workspace, remote, clipboard, restore: true, trash: true });
  assert.deepEqual(all, FULL_CAPS);

  // A partial face only enables the methods it really has.
  const partial = helpers.menuCapabilities({ uiWorkspace: { openSession() {} }, clipboard: {}, remote: { session: {} } });
  assert.equal(partial.open, true);
  assert.equal(partial.fork, false);
  assert.equal(partial.pin, false);
  assert.equal(partial.clipboard, false);
  assert.equal(partial.reveal, false);
});

test('menuItemsFor keeps the native order and explains every disabled entry', () => {
  const row = { id: 's1', cwd: '/work/alpha', pinned: false, archived: false, blank: false };
  const items = helpers.menuItemsFor(row, FULL_CAPS);
  assert.deepEqual(items.map((item) => item.id), ['pin', 'rename', 'fork', 'copyId', 'reveal', 'archive', 'detail', 'open']);
  assert.ok(items.every((item) => item.enabled));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.equal(byId.rename.shortcut, 'Ctrl+Alt+G');
  assert.equal(byId.fork.shortcut, 'Ctrl+Shift+F');
  assert.equal(byId.archive.shortcut, 'Ctrl+Alt+A');
  assert.equal(byId.open.shortcut, null);

  const bare = Object.fromEntries(helpers.menuItemsFor({ id: 's1', cwd: '' }, {}).map((item) => [item.id, item]));
  assert.equal(bare.pin.enabled, false);
  assert.equal(bare.pin.reasonKey, 'menu.reason.noService');
  assert.equal(bare.rename.enabled, true, 'renaming only needs the plugin API');
  assert.equal(bare.rename.reasonKey, null);
  assert.equal(bare.fork.reasonKey, 'menu.reason.noService');
  assert.equal(bare.copyId.reasonKey, 'menu.reason.noClipboard');
  assert.equal(bare.reveal.reasonKey, 'menu.reason.noCwd', 'a missing cwd is the more specific reason');
  assert.equal(bare.detail.enabled, true, 'the detail split ships inside this panel');
  assert.equal(bare.detail.reasonKey, null);
  assert.equal(bare.open.reasonKey, 'menu.reason.noService');

  const noRemote = Object.fromEntries(helpers.menuItemsFor({ id: 's1', cwd: '/w' }, Object.assign({}, FULL_CAPS, { reveal: false }))
    .map((item) => [item.id, item]));
  assert.equal(noRemote.reveal.reasonKey, 'menu.reason.noRemote');
});

test('menuItemsFor disables what archived and blank sessions cannot do', () => {
  const archived = Object.fromEntries(helpers.menuItemsFor({ id: 's1', cwd: '/w', archived: true }, FULL_CAPS)
    .map((item) => [item.id, item]));
  assert.equal(archived.pin.enabled, false);
  assert.equal(archived.pin.reasonKey, 'menu.reason.archived');
  assert.equal(archived.fork.enabled, false);
  assert.equal(archived.open.enabled, false);
  assert.equal(archived.open.reasonKey, 'menu.reason.archived');
  assert.ok(archived.unarchive, 'an archived row offers unarchive instead of archive');
  assert.equal(archived.unarchive.enabled, true);
  assert.equal(archived.archive, undefined);

  const blank = Object.fromEntries(helpers.menuItemsFor({ id: 's2', cwd: '/w', blank: true }, FULL_CAPS)
    .map((item) => [item.id, item]));
  assert.equal(blank.open.enabled, false);
  assert.equal(blank.open.reasonKey, 'menu.reason.blank');
  assert.equal(blank.fork.reasonKey, 'menu.reason.blank');

  const pinned = helpers.menuItemsFor({ id: 's3', pinned: true }, FULL_CAPS);
  assert.equal(pinned[0].id, 'unpin');
  assert.equal(pinned[0].labelKey, 'menu.unpin');
});

test('menuItemsFor in the trash view only offers restore and permanent delete', () => {
  const items = helpers.menuItemsFor({ id: 's1' }, FULL_CAPS, { view: 'trash' });
  assert.deepEqual(items.map((item) => item.id), ['restore', 'purge']);
  assert.equal(items[0].enabled, true);
  assert.equal(items[1].enabled, false);
  assert.equal(items[1].reasonKey, 'menu.reason.purgeUnsupported');
  assert.equal(items[1].danger, true);
  assert.deepEqual(helpers.TRASH_MENU_ITEM_IDS, ['restore', 'purge']);
  const noRestore = helpers.menuItemsFor({ id: 's1' }, Object.assign({}, FULL_CAPS, { restore: false }), { view: 'trash' });
  assert.equal(noRestore[0].reasonKey, 'menu.reason.noService');
});

test('the "⋯" menu keeps native parity and adds the plugin-only actions', () => {
  const row = { id: 's1', title: 'T', tags: [], archived: false, blank: false, cwd: '/repo' };
  const caps = { pin: true, fork: true, clipboard: true, reveal: true, archive: true, unarchive: true, open: true };
  const nativeIds = helpers.menuItemsFor(row, caps).map((item) => item.id);
  const pluginIds = helpers.pluginMenuItemsFor(row, caps).map((item) => item.id);
  assert.deepEqual(pluginIds.slice(0, nativeIds.length), nativeIds, 'native entries keep their order');
  assert.deepEqual(pluginIds.slice(nativeIds.length), ['tags', 'note', 'trash']);
  assert.equal(helpers.pluginMenuItemsFor(row, caps).find((item) => item.id === 'trash').danger, true);
});

test('menu keyboard skips disabled entries and closes on Esc', () => {
  const items = [
    { id: 'a', enabled: false },
    { id: 'b', enabled: true },
    { id: 'c', enabled: false },
    { id: 'd', enabled: true }
  ];
  assert.equal(helpers.firstEnabledIndex(items), 1);
  assert.equal(helpers.nextEnabledIndex(items, 1, 1), 3);
  assert.equal(helpers.nextEnabledIndex(items, 3, 1), 3, 'arrows clamp at the ends');
  assert.equal(helpers.nextEnabledIndex(items, 1, -1), 1);
  assert.deepEqual(helpers.menuKeyAction(items, 1, 'ArrowDown'), { kind: 'move', index: 3 });
  assert.deepEqual(helpers.menuKeyAction(items, 3, 'ArrowUp'), { kind: 'move', index: 1 });
  assert.deepEqual(helpers.menuKeyAction(items, 1, 'Enter'), { kind: 'activate', index: 1 });
  assert.deepEqual(helpers.menuKeyAction(items, 0, 'Enter'), { kind: 'none' }, 'a disabled entry cannot be activated');
  assert.deepEqual(helpers.menuKeyAction(items, 1, 'Escape'), { kind: 'close' });
  assert.deepEqual(helpers.menuKeyAction(items, 1, 'Tab'), { kind: 'close' });
  assert.deepEqual(helpers.menuKeyAction(items, 1, 'x'), { kind: 'none' });
});

test('menuPlacement flips inside the viewport instead of overflowing', () => {
  assert.deepEqual(
    helpers.menuPlacement({ x: 10, y: 20 }, { width: 800, height: 600 }, { width: 216, height: 320 }),
    { left: 10, top: 20, flippedX: false, flippedY: false }
  );
  const flipped = helpers.menuPlacement({ x: 780, y: 590 }, { width: 800, height: 600 }, { width: 216, height: 320 });
  assert.equal(flipped.flippedX, true);
  assert.equal(flipped.flippedY, true);
  assert.equal(flipped.left, 564);
  assert.equal(flipped.top, 270);
  const unknown = helpers.menuPlacement({ x: 5, y: 6 }, null, { width: 100, height: 100 });
  assert.deepEqual(unknown, { left: 5, top: 6, flippedX: false, flippedY: false });
});

/* ------------------------------------------------------------------ *
 * v0.2 — selection and panel-scoped shortcuts (PRD §7.1, D10)
 * ------------------------------------------------------------------ */

test('moveSelection walks the visible order and clamps at both ends', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(helpers.moveSelection(order, null, 1), 'a');
  assert.equal(helpers.moveSelection(order, null, -1), 'c');
  assert.equal(helpers.moveSelection(order, 'a', 1), 'b');
  assert.equal(helpers.moveSelection(order, 'b', -1), 'a');
  assert.equal(helpers.moveSelection(order, 'a', -1), 'a', 'the first row stays selected');
  assert.equal(helpers.moveSelection(order, 'c', 1), 'c', 'the last row stays selected');
  assert.equal(helpers.moveSelection(order, 'gone', 1), 'a');
  assert.equal(helpers.moveSelection([], null, 1), null);
  assert.equal(helpers.moveSelection(order, 'b', 0), 'c', 'a non-negative delta steps forward');
});

test('shortcutActionFor maps only the three documented chords', () => {
  assert.equal(helpers.shortcutActionFor({ key: 'g', ctrlKey: true, altKey: true }), 'rename');
  assert.equal(helpers.shortcutActionFor({ key: 'G', ctrlKey: true, altKey: true }), 'rename');
  assert.equal(helpers.shortcutActionFor({ key: 'a', ctrlKey: true, altKey: true }), 'archive');
  assert.equal(helpers.shortcutActionFor({ key: 'f', ctrlKey: true, shiftKey: true }), 'fork');
  assert.equal(helpers.shortcutActionFor({ code: 'KeyA', ctrlKey: true, altKey: true }), 'archive', 'code is the fallback');
  assert.equal(helpers.shortcutActionFor({ key: 'g', metaKey: true, altKey: true }), 'rename', 'Cmd works like Ctrl');
  assert.equal(helpers.shortcutActionFor({ key: 'g', ctrlKey: true }), null, 'the alt modifier is required');
  assert.equal(helpers.shortcutActionFor({ key: 'g', altKey: true }), null, 'the primary modifier is required');
  assert.equal(helpers.shortcutActionFor({ key: 'f', ctrlKey: true, shiftKey: true, altKey: true }), null);
  assert.equal(helpers.shortcutActionFor({ key: 'x', ctrlKey: true, altKey: true }), null);
  assert.deepEqual(helpers.SHORTCUT_KEYS, { rename: 'Ctrl+Alt+G', fork: 'Ctrl+Shift+F', archive: 'Ctrl+Alt+A' });
});

test('shortcutFor only fires while the panel is focused with a selected row', () => {
  const chord = { key: 'g', ctrlKey: true, altKey: true };
  assert.equal(helpers.shortcutFor(chord, { panelFocused: true, selectedId: 's1' }), 'rename');
  assert.equal(helpers.shortcutFor(chord, { panelFocused: false, selectedId: 's1' }), null);
  assert.equal(helpers.shortcutFor(chord, { panelFocused: true, selectedId: null }), null);
  assert.equal(helpers.shortcutFor(chord, null), null);
});

/* ------------------------------------------------------------------ *
 * v0.2 — task normalization (PRD §7.4 / §8.1)
 * ------------------------------------------------------------------ */

test('normalizeJob maps every state and caps in-flight progress at 99', () => {
  assert.deepEqual(helpers.JOB_STATES, ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
  for (const state of helpers.JOB_STATES) {
    const job = helpers.normalizeJob({ id: 'j-' + state, type: 'ai.rename', state });
    assert.equal(job.state, state);
    assert.equal(job.active, state === 'queued' || state === 'running', state + ' activity');
    assert.equal(job.type, 'ai.rename');
  }

  assert.equal(helpers.normalizeJob({ id: 'j1', state: 'queued' }).percent, 0);
  assert.equal(helpers.normalizeJob({ id: 'j2', state: 'running', total: 3, done: 1 }).percent, 33);
  assert.equal(helpers.normalizeJob({ id: 'j3', state: 'running', total: 3, done: 3 }).percent, 99, 'running never reads 100');
  assert.equal(helpers.normalizeJob({ id: 'j4', state: 'succeeded', total: 3, done: 3 }).percent, 100);
  assert.equal(helpers.normalizeJob({ id: 'j5', state: 'failed', total: 4, done: 1 }).percent, 25);
  assert.equal(helpers.normalizeJob({ id: 'j6', state: 'cancelled', total: 10, done: 4 }).percent, 40);
  assert.equal(helpers.normalizeJob({ id: 'j7', state: 'interrupted', percent: 100 }).percent, 99);

  const unknown = helpers.normalizeJob({ id: 'j8', state: 'bogus' });
  assert.equal(unknown.state, 'queued', 'unknown states degrade to queued');
  assert.equal(helpers.normalizeJob(null).state, 'queued');
  assert.equal(helpers.normalizeJob({ id: 'j9', state: 'running', total: 2, done: 2, percent: 140 }).percent, 99);
});

test('normalizeJob folds errors and per-item detail', () => {
  const failed = helpers.normalizeJob({
    id: 'j1', type: 'rename.apply', state: 'failed', total: 2, done: 1, failed: 1, skipped: 2,
    error: { code: 'write_failed', message: 'disk full' },
    items: [{ key: 's1', state: 'failed', message: 'disk full' }], itemsTruncated: true
  });
  assert.equal(failed.errorCode, 'write_failed');
  assert.equal(failed.errorText, 'disk full');
  assert.equal(failed.failed, 1);
  assert.equal(failed.skipped, 2);
  assert.equal(failed.items.length, 1);
  assert.equal(failed.itemsTruncated, true);
  assert.equal(helpers.normalizeJob({ id: 'j2', state: 'failed', error: 'plain' }).errorText, 'plain');
});

test('sortJobs puts active tasks first and finished ones newest first', () => {
  const sorted = helpers.sortJobs([
    { id: 'old', state: 'succeeded', createdAt: 1, finishedAt: 2 },
    { id: 'running', state: 'running', createdAt: 3 },
    { id: 'new', state: 'failed', createdAt: 5, finishedAt: 6 },
    { id: 'queued', state: 'queued', createdAt: 4 }
  ]);
  assert.deepEqual(sorted.map((job) => job.id), ['running', 'queued', 'new', 'old']);
  assert.equal(helpers.activeJobCount(sorted), 2);
  assert.equal(helpers.latestFinishedJob(sorted).id, 'new');
  assert.deepEqual(sorted.slice(0, 1).map((job) => job.id), helpers.sortJobs(sorted, 1).map((job) => job.id));
});

test('mergeJobList keeps history while updating the same task id', () => {
  const merged = helpers.mergeJobList(
    [{ id: 'a', state: 'running', total: 3, done: 1 }, { id: 'b', state: 'succeeded', createdAt: 1 }],
    [{ id: 'a', state: 'succeeded', total: 3, done: 3 }]
  );
  assert.equal(merged.length, 2);
  const byId = Object.fromEntries(merged.map((job) => [job.id, job]));
  assert.equal(byId.a.state, 'succeeded');
  assert.equal(byId.a.percent, 100);
  assert.equal(byId.b.state, 'succeeded');
  assert.equal(helpers.isActiveJob(byId.a), false);
});

/* ------------------------------------------------------------------ *
 * v0.2 — detail params and row folding (PRD §7.3)
 * ------------------------------------------------------------------ */

test('panelEscapeAction gives Esc to the topmost panel layer', () => {
  assert.equal(helpers.panelEscapeAction({}), 'none');
  assert.equal(helpers.panelEscapeAction(null), 'none');
  assert.equal(helpers.panelEscapeAction({ detailId: 's1' }), 'detail');
  assert.equal(helpers.panelEscapeAction({ detailId: 's1', menu: true }), 'menu');
  assert.equal(helpers.panelEscapeAction({ detailId: 's1', menu: true, dialog: true }), 'dialog');
});

test('isJobUnavailable parks the task UI on hosts without the job runner', () => {
  assert.equal(helpers.isJobUnavailable({ status: 503, code: 'unavailable' }), true);
  assert.equal(helpers.isJobUnavailable({ status: 404, code: 'not_found' }), true);
  assert.equal(helpers.isJobUnavailable({ code: 'unavailable' }), true);
  assert.equal(helpers.isJobUnavailable({ code: 'http_503' }), true);
  assert.equal(helpers.isJobUnavailable({ code: 'http_404' }), true);
  assert.equal(helpers.isJobUnavailable({ status: 500, code: 'internal' }), false);
  assert.equal(helpers.isJobUnavailable({ status: 0, code: 'network' }), false);
  assert.equal(helpers.isJobUnavailable(new Error('boom')), false);
  assert.equal(helpers.isJobUnavailable(null), false);
});

test('rememberPanel keeps the last good payload for a first-frame repaint', () => {
  helpers.forgetPanelCache();
  assert.deepEqual(helpers.readPanelCache().rows, []);
  assert.equal(helpers.readPanelCache().meta, null);

  helpers.rememberPanel([{ id: 's1', title: 'Cached' }], { rules: [] }, { running: true, processed: 1, total: 4 });
  const cache = helpers.readPanelCache();
  assert.equal(cache.rows.length, 1);
  assert.deepEqual(cache.meta, { rules: [] });
  assert.equal(cache.indexing.total, 4);

  helpers.forgetPanelCache();
  assert.equal(helpers.readPanelCache().rows.length, 0);
});

test('mergeDetailRow folds GET value into the cached row without losing live state', () => {
  const merged = helpers.mergeDetailRow(
    { id: 's1', status: 'blocked', tags: ['a'], note: 'old', cwd: '/w', title: 'T' },
    { title: 'New title', firstMessage: 'hi', cwd: '/x', updatedAt: NOW, tags: ['b', 'a'], note: 'n' },
    's1'
  );
  assert.equal(merged.title, 'New title');
  assert.equal(merged.firstMessage, 'hi');
  assert.equal(merged.cwd, '/x');
  assert.deepEqual(merged.tags, ['b', 'a']);
  assert.equal(merged.note, 'n');
  assert.equal(merged.status, 'blocked', 'the derived live status survives the fold');

  const fresh = helpers.mergeDetailRow(null, {}, 's9');
  assert.equal(fresh.id, 's9');
  assert.equal(fresh.status, 'completed');
  assert.deepEqual(fresh.tags, []);
});

test('cacheRows and rowFromCache back the detail pane with loaded rows', () => {
  helpers.cacheRows([{ id: 'cache-test-1', title: 'Cached' }, { id: 'cache-test-2', title: 'Second' }]);
  assert.equal(helpers.rowFromCache('cache-test-1').title, 'Cached');
  assert.equal(helpers.rowFromCache('cache-test-2').title, 'Second');
  assert.equal(helpers.rowFromCache('missing'), null);
  assert.equal(helpers.rowFromCache(null), null);
  helpers.cacheRows([]);
  assert.equal(helpers.rowFromCache('cache-test-1'), null, 'a refresh replaces the cache');
});

/* ------------------------------------------------------------------ *
 * v0.2 — render smoke for the new surfaces
 * ------------------------------------------------------------------ */

test('RowMenu renders native entries, disable reasons and shortcut hints', () => {
  const items = helpers.menuItemsFor({ id: 's1', cwd: '', pinned: false }, helpers.menuCapabilities({}));
  const tree = plugin.components.RowMenu({ items, anchor: { x: 10, y: 10 }, viewport: { width: 800, height: 600 } });
  const text = textOf(tree);
  for (const label of ['置顶会话', '重命名', '分叉会话', '复制 Session ID', '在文件夹显示', '归档会话', '查看详情', '打开会话']) {
    assert.ok(text.includes(label), 'menu entry ' + label);
  }
  assert.ok(text.includes('当前客户端不支持这个操作'), 'disabled entries carry the reason inline');
  assert.ok(text.includes('Ctrl+Alt+G'), 'the rename shortcut is shown');
  assert.ok(text.includes('Ctrl+Shift+F'), 'the fork shortcut is shown');
});

test('JobsIndicator shows running progress and the latest result otherwise', () => {
  const running = helpers.normalizeJob({ id: 'j1', type: 'ai.rename', state: 'running', total: 4, done: 1 });
  const busy = plugin.components.JobsIndicator({ activeJobs: [running], latest: null, open: false, onToggle() {} });
  let text = textOf(busy);
  assert.ok(text.includes('任务'));
  assert.ok(text.includes('1/4'), 'progress reads done/total');

  const done = helpers.normalizeJob({ id: 'j2', type: 'ai.tags', state: 'succeeded', total: 2, done: 2 });
  const idle = plugin.components.JobsIndicator({ activeJobs: [], latest: done, open: false, onToggle() {} });
  text = textOf(idle);
  assert.ok(text.includes('任务'));
  assert.ok(text.includes('成功'), 'the idle indicator shows the last result state');
});

test('JobsIndicator parks itself when the host has no job runner', () => {
  const parked = plugin.components.JobsIndicator({ activeJobs: [], latest: null, unavailable: true });
  const text = textOf(parked);
  assert.equal(parked.props.disabled, true, 'the trigger cannot be opened');
  assert.ok(text.includes('任务不可用'));
  assert.ok(text.includes('宿主未启用任务'), 'the tooltip explains the parked host');
  assert.equal(parked.props.onClick, undefined, 'a parked trigger has no toggle handler');
});

test('SkeletonList paints grey rows plus the indexing hint', () => {
  const tree = plugin.components.SkeletonList({ hint: '正在索引 2/9' });
  const text = textOf(tree);
  assert.ok(text.includes('正在索引 2/9'));
  assert.equal(findNodes(tree, (node) => node.props.className === 'sm-skeleton-row').length, 8);
  assert.equal(findNodes(tree, (node) => node.props.className === 'sm-skeleton sm-skeleton-title').length, 8);
  const custom = plugin.components.SkeletonList({ count: 3 });
  assert.equal(findNodes(custom, (node) => node.props.className === 'sm-skeleton-row').length, 3);
});

test('JobsPanel exposes cancel for active tasks and failure details', () => {
  const running = helpers.normalizeJob({ id: 'j-run', type: 'ai.rename', state: 'running', total: 4, done: 1 });
  const failed = helpers.normalizeJob({
    id: 'j-fail', type: 'rename.apply', state: 'failed', total: 2, done: 1, failed: 1,
    error: { code: 'write_failed', message: 'disk full' }
  });
  const tree = plugin.components.JobsPanel({
    jobs: helpers.sortJobs([failed, running]),
    expandedId: 'j-fail',
    itemsById: { 'j-fail': [{ key: 's1', state: 'failed', message: 'disk full' }] },
    cancellingIds: [],
    onCancel() {},
    onToggle() {}
  });
  const text = textOf(tree);
  assert.ok(text.includes('AI 重命名预览'));
  assert.ok(text.includes('应用重命名'));
  assert.ok(text.includes('取消'), 'active tasks offer cancel');
  assert.ok(text.includes('disk full'), 'failure detail is visible');
  assert.ok(text.includes('收起'), 'the expanded task can collapse');
  assert.ok(text.includes('进行中'));
});

test('DetailPane renders the loaded row, its editors and a close button', () => {
  const row = {
    id: 's-login-1', title: 'Fix Login bug', status: 'completed', cwd: '/work/alpha',
    workspaceTitle: 'alpha', updatedAt: NOW, tags: ['bug'], note: 'remember this',
    lastTurnEnd: 'completed', intent: '开发', archived: false, blank: false, running: false,
    firstMessage: 'hello there'
  };
  helpers.cacheRows([row]);
  let closed = 0;
  const tree = plugin.components.DetailPane({
    sessionId: 's-login-1',
    row,
    onClose() { closed += 1; },
    onChanged() {}
  });
  const text = textOf(tree);
  assert.ok(text.includes('Fix Login bug'));
  assert.ok(text.includes('完成'), 'the status shows its seven-bucket label');
  assert.ok(text.includes('/work/alpha'));
  assert.ok(text.includes('bug'));
  assert.ok(text.includes('remember this'));
  assert.ok(text.includes('Session ID'));
  assert.ok(text.includes('移入回收站'));
  assert.ok(text.includes('打开会话'));
  assert.ok(text.includes('最近一轮结束原因'));

  const pane = findNode(tree, (node) => node.props.className === 'sm-detail-pane');
  assert.ok(pane, 'the pane owns a controlled shell');
  assert.equal(pane.props['data-session-id'], 's-login-1');
  const close = findNode(tree, (node) => node.props.className === 'sm-icon-btn sm-detail-close');
  assert.ok(close, 'the pane header carries a close button');
  close.props.onClick();
  assert.equal(closed, 1, 'the close button calls onClose instead of closing a tab');
});

/* ------------------------------------------------------------------ *
 * Render smoke tests
 * ------------------------------------------------------------------ */

test('Page renders its header, overview, toolbar and loading state', () => {
  helpers.forgetPanelCache();
  const tree = plugin.components.Page({});
  const text = textOf(tree);
  assert.ok(text.includes('会话管理'), 'app title');
  assert.ok(text.includes('待处理'), 'overview pending');
  assert.ok(text.includes('已完成未读'), 'overview unread');
  assert.ok(text.includes('AI 重命名'), 'toolbar rename');
  assert.ok(text.includes('加载中…'), 'loading phase');
});

test('Page paints skeleton rows instead of a blank panel on a cold start', () => {
  helpers.forgetPanelCache();
  const tree = plugin.components.Page({});
  assert.ok(findNode(tree, (node) => node.props.className === 'sm-skeleton-list'), 'the loading body is a skeleton');
  assert.equal(findNodes(tree, (node) => node.props.className === 'sm-skeleton-row').length, 8);
  const hint = findNode(tree, (node) => node.props.className === 'sm-skeleton-hint');
  assert.ok(hint && textOf(hint).includes('加载中…'));
  assert.ok(!findNode(tree, (node) => node.props.className === 'sm-split-detail'), 'no detail split without a selection');
});

test('Page repaints cached rows first and opens the in-panel split', () => {
  const rowA = {
    id: 's-a', title: 'Cached A', tags: [], cwd: '/w/a', updatedAt: NOW, archived: false,
    blank: false, running: false, lastTurnEnd: 'completed', pinned: false
  };
  const rowB = {
    id: 's-b', title: 'Cached B', tags: [], cwd: '/w/b', updatedAt: NOW - 1000, archived: false,
    blank: false, running: false, lastTurnEnd: 'completed', pinned: false
  };
  helpers.cacheRows([rowA, rowB]);
  helpers.rememberPanel([rowA, rowB], { rules: [], tagDefs: [] }, null);

  const tree = plugin.components.Page({ initialDetailId: 's-a' });
  const text = textOf(tree);
  assert.ok(text.includes('Cached A') && text.includes('Cached B'), 'cached rows paint on the first frame');
  assert.ok(!text.includes('加载中…'), 'a cached first frame is not a loading screen');
  assert.ok(!findNode(tree, (node) => node.props.className === 'sm-skeleton-list'));

  const split = findNode(tree, (node) => node.props.className === 'sm-split sm-split-open');
  assert.ok(split, 'the detail split shares the page with the list');
  assert.ok(findNode(tree, (node) => node.props.className === 'sm-split-list'), 'the list keeps its own column');
  const detail = findNode(tree, (node) => node.props.className === 'sm-split-detail');
  assert.ok(detail, 'the detail column is a sibling of the list');
  const pane = findNode(tree, (node) => node.props.className === 'sm-detail-pane');
  assert.ok(pane, 'the controlled pane renders inside the detail column');
  assert.equal(pane.props['data-session-id'], 's-a');
  assert.ok(text.includes('会话详情'));
  assert.ok(findNode(tree, (node) => node.props.className === 'sm-icon-btn sm-detail-close'));
  assert.ok(findNode(tree, (node) => node.props['data-session-id'] === 's-a'), 'the active row is still listed');
  assert.ok(findNode(tree, (node) => node.props['data-session-id'] === 's-b'));
  helpers.forgetPanelCache();
});

test('the group head offers a drag handle and ↑/↓ per group (v0.3.1 拖动排序)', () => {
  const rowA = {
    id: 's-a', title: 'Grouped A', tags: [], cwd: '/w/a', updatedAt: NOW, archived: false,
    blank: false, running: false, lastTurnEnd: 'completed', pinned: false
  };
  const rowB = {
    id: 's-b', title: 'Grouped B', tags: ['bug'], cwd: '/w/b', updatedAt: NOW - 1000, archived: false,
    blank: false, running: false, lastTurnEnd: 'interrupted', pinned: false
  };
  helpers.forgetPanelCache();
  helpers.cacheRows([rowA, rowB]);
  helpers.rememberPanel([rowA, rowB], { rules: [], tagDefs: [] }, null);

  const tree = plugin.components.Page({});
  const heads = findNodes(tree, (node) => node.props.className === 'sm-group-head-row');
  assert.ok(heads.length >= 2, 'one head row per group');
  const handles = findNodes(tree, (node) => node.props.className === 'sm-group-drag');
  assert.equal(handles.length, heads.length, 'every group can be dragged');
  assert.equal(handles[0].props.draggable, 'true');
  assert.equal(handles[0].children[0], '⠿');
  const ups = findNodes(tree, (node) => node.props.className === 'sm-group-move' && node.children[0] === '↑');
  const downs = findNodes(tree, (node) => node.props.className === 'sm-group-move' && node.children[0] === '↓');
  assert.equal(ups.length, heads.length, 'each group gets an ↑');
  assert.equal(downs.length, heads.length, 'each group gets a ↓');
  assert.equal(ups[0].props.disabled, true, 'the first group cannot move up');
  assert.equal(downs[downs.length - 1].props.disabled, true, 'the last group cannot move down');
  const sections = findNodes(tree, (node) => node.type === 'section' && /^sm-group(\s|$)/.test(String(node.props.className)));
  assert.ok(sections.length >= 2);
  assert.equal(typeof sections[0].props.onDrop, 'function', 'the section accepts a drop');
  assert.equal(typeof sections[0].props.onDragOver, 'function');
  helpers.forgetPanelCache();
});

test('Row renders title, tags, suggested tags, time and badges', () => {
  const row = DECORATED[0];
  row.suggestedTags = ['排查'];
  const tree = plugin.components.Row({
    row,
    selected: false,
    menuOpen: true,
    onSelect() {},
    onMenu() {},
    onAction() {}
  });
  const text = textOf(tree);
  assert.ok(text.includes('Fix Login bug'));
  assert.ok(text.includes('bug'));
  assert.ok(text.includes('排查'));
  assert.ok(text.includes('重命名'));
  assert.ok(text.includes('删除'));
  assert.ok(text.includes('alpha'));
});

test('SidebarIcon renders an svg at the requested size', () => {
  const tree = plugin.components.SidebarIcon({ size: 20, active: false });
  assert.equal(tree.type, 'svg');
  assert.equal(tree.props.width, 20);
  assert.equal(tree.props.height, 20);
});

test('RenamePreviewDialog lists current/proposed/reason and skip reasons', () => {
  const tree = plugin.components.RenamePreviewDialog({
    items: [
      { sessionId: 's1', currentTitle: 'Old title', proposed: 'New title', reason: 'first message' },
      { sessionId: 's2', currentTitle: 'Busy', proposed: 'Nope', reason: '', skipReason: 'running' }
    ],
    model: 'test-model',
    busy: false,
    onClose() {},
    onApply() {}
  });
  const text = textOf(tree);
  assert.ok(text.includes('Old title'));
  assert.ok(text.includes('New title'));
  assert.ok(text.includes('first message'));
  assert.ok(text.includes('运行中'));
  assert.ok(text.includes('test-model'));
});

test('TagsPreviewDialog renders editable suggestion chips and intent', () => {
  const tree = plugin.components.TagsPreviewDialog({
    items: [{ sessionId: 's1', title: 'A session', suggestions: ['bug'], intent: '开发', reason: 'r' }],
    vocabulary: ['bug', 'ops'],
    busy: false,
    onClose() {},
    onApply() {}
  });
  const text = textOf(tree);
  assert.ok(text.includes('A session'));
  assert.ok(text.includes('bug'));
  assert.ok(text.includes('开发'));
});

test('TagEditorDialog supports append, replace and clear modes', () => {
  const modes = [
    ['append', ['已选 1', '追加标签']],
    ['replace', ['替换标签']],
    ['clear', ['清空标签', '全部标签']]
  ];
  for (const [mode, needles] of modes) {
    const tree = plugin.components.TagEditorDialog({
      ids: ['s1'], mode, initial: [], tagDefs: [{ name: 'bug' }], busy: false, onClose() {}, onCommit() {}
    });
    const text = textOf(tree);
    for (const needle of needles) assert.ok(text.includes(needle), mode + ' should mention ' + needle);
  }
});

test('RenameOneDialog, NoteDialog and DeleteDialog render', () => {
  const rename = textOf(plugin.components.RenameOneDialog({ row: { id: 's1', title: 'A' }, busy: false, onClose() {}, onCommit() {} }));
  assert.ok(rename.includes('重命名会话'));
  assert.ok(rename.includes('锁定'));
  const note = textOf(plugin.components.NoteDialog({ row: { id: 's1', title: 'A', note: 'hello' }, busy: false, onClose() {}, onCommit() {} }));
  assert.ok(note.includes('备注'));
  const del = textOf(plugin.components.DeleteDialog({ ids: ['s1', 's2'], busy: false, onClose() {}, onConfirm() {} }));
  assert.ok(del.includes('删除 2 个会话'));
  assert.ok(del.includes('回收站'));
});

test('TrashDialog renders its loading state before the list arrives', () => {
  const text = textOf(plugin.components.TrashDialog({ busy: false, onClose() {}, onRestored() {} }));
  assert.ok(text.includes('回收站'));
  assert.ok(text.includes('加载中'));
});

test('FillMissingDialog lists candidates and the empty state', () => {
  const text = textOf(plugin.components.FillMissingDialog({
    candidates: [{ sessionId: 's1', title: 'No tags yet', tags: ['建议'] }],
    busy: false,
    onClose() {},
    onApply() {}
  }));
  assert.ok(text.includes('No tags yet'));
  assert.ok(text.includes('建议'));
  const empty = textOf(plugin.components.FillMissingDialog({ candidates: [], busy: false, onClose() {}, onApply() {} }));
  assert.ok(empty.includes('所有会话都已有标签'));
});

test('RulesDialog renders existing rules with their action tags', () => {
  const tree = plugin.components.RulesDialog({
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
  const text = textOf(tree);
  assert.ok(text.includes('标签规则'));
  assert.ok(text.includes('华为项目'));
  assert.ok(text.includes('华为'));
  assert.ok(text.includes('只给建议'));
});

test('every closed-set skip reason renders a localized label and its detail', () => {
  const expected = {
    running: '运行中',
    blank: '空白会话',
    subagent: '子代理会话',
    titleLocked: '标题已锁定',
    archived: '已归档',
    missing: '会话不存在',
    llm_failed: 'AI 调用失败',
    unparsable: '模型输出无法解析',
    timeout: 'AI 调用超时',
    missing_in_response: '模型输出缺少该会话',
    invalid_title: '生成的标题不合法',
    unchanged: '标题没有变化'
  };
  for (const reason of Object.keys(expected)) {
    const text = textOf(plugin.components.RenamePreviewDialog({
      items: [{
        sessionId: 's1',
        title: 'T',
        currentTitle: 'Old',
        proposed: 'New',
        reason: '',
        skipReason: reason,
        detail: 'detail-' + reason
      }],
      model: '',
      busy: false,
      onClose() {},
      onApply() {}
    }));
    assert.ok(text.includes(expected[reason]), reason + ' should have copy');
    assert.ok(text.includes('detail-' + reason), reason + ' should show detail');
    assert.ok(!text.includes('skip.' + reason), 'a missing skip.* key would fall back to the raw key');
  }
});

test('TrashRow marks a tombstone and explains what restoring does', () => {
  const tombstone = textOf(plugin.components.TrashRow({
    item: { sessionId: 's1', title: 'Gone session', cwd: '/work/gone', deletedAt: Date.now(), tombstone: true },
    checked: false,
    onToggle() {}
  }));
  assert.ok(tombstone.includes('Gone session'));
  assert.ok(tombstone.includes('仅记录'));
  assert.ok(tombstone.includes('原始数据已不在磁盘上，恢复只会撤销删除记录'));
  const normal = textOf(plugin.components.TrashRow({
    item: { sessionId: 's2', title: 'Kept session', cwd: '/work/kept', deletedAt: Date.now(), tombstone: false },
    checked: true,
    onToggle() {}
  }));
  assert.ok(normal.includes('Kept session'));
  assert.ok(!normal.includes('原始数据已不在磁盘上'));
});

/* ------------------------------------------------------------------ *
 * v0.2 fix — in-panel detail and parked tasks, with a tiny hook runtime
 * ------------------------------------------------------------------ */

/**
 * A minimal hook-capable React stand-in: components are real function
 * components, state survives re-renders through fiber slots, effects run on
 * demand. The smoke harness above deliberately never updates state; behaviour
 * cases such as opening the split, switching rows, Esc and onChanged need it.
 */
function createMiniRuntime() {
  const fibers = new Map();
  let queue = [];
  let dirty = false;
  let current = null;
  let instances = [];
  let element = null;
  let tree = null;

  function isElement(value) {
    return Boolean(value) && typeof value === 'object' && value.__element === true;
  }

  const react = {
    createElement(type, props, ...rest) {
      const children = flattenChildren(rest);
      const merged = Object.assign({}, props || {});
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { __element: true, type, props: merged };
    },
    useState(initial) {
      const fiber = current;
      const index = fiber.cursor++;
      if (!(index in fiber.states)) fiber.states[index] = typeof initial === 'function' ? initial() : initial;
      const setState = (next) => {
        const value = typeof next === 'function' ? next(fiber.states[index]) : next;
        if (Object.is(value, fiber.states[index])) return;
        fiber.states[index] = value;
        dirty = true;
      };
      return [fiber.states[index], setState];
    },
    useEffect(effect, deps) {
      const fiber = current;
      const index = fiber.cursor++;
      const previous = fiber.effects[index];
      const same = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, slot) => Object.is(value, previous.deps[slot]));
      if (same) return;
      fiber.effects[index] = { deps: deps || null, cleanup: previous ? previous.cleanup : null, run: effect };
      queue.push({ fiber, index });
    },
    useMemo(factory, deps) {
      const fiber = current;
      const index = fiber.cursor++;
      const previous = fiber.memos[index];
      const same = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, slot) => Object.is(value, previous.deps[slot]));
      if (!same) fiber.memos[index] = { deps: deps || null, value: factory() };
      return fiber.memos[index].value;
    },
    useCallback(callback, deps) {
      const fiber = current;
      const index = fiber.cursor++;
      const previous = fiber.memos['cb' + index];
      const same = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, slot) => Object.is(value, previous.deps[slot]));
      if (!same) fiber.memos['cb' + index] = { deps: deps || null, value: callback };
      return fiber.memos['cb' + index].value;
    },
    useRef(initial) {
      const fiber = current;
      const index = fiber.cursor++;
      if (!(index in fiber.refs)) fiber.refs[index] = { current: initial };
      return fiber.refs[index];
    }
  };

  function fiberFor(key, type) {
    let fiber = fibers.get(key);
    if (!fiber) {
      fiber = { key, type, states: {}, effects: {}, memos: {}, refs: {}, cursor: 0 };
      fibers.set(key, fiber);
    }
    return fiber;
  }

  function renderValue(value, key) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (Array.isArray(value)) {
      const out = [];
      for (let index = 0; index < value.length; index += 1) {
        const child = value[index];
        const childKey = isElement(child) && child.props.key !== undefined && child.props.key !== null
          ? key + '/' + child.props.key
          : key + '#' + index;
        const rendered = renderValue(child, childKey);
        if (rendered !== null) out.push(rendered);
      }
      return out;
    }
    if (!isElement(value)) return value;
    const node = value;
    if (typeof node.type === 'function') {
      const fiber = fiberFor(key, node.type);
      fiber.cursor = 0;
      current = fiber;
      let output;
      try {
        output = node.type(node.props);
      } finally {
        current = null;
      }
      instances.push({ type: node.type, props: node.props, fiber });
      return renderValue(output, key + '>');
    }
    const children = node.props && node.props.children !== undefined
      ? renderValue(node.props.children, key + '>')
      : null;
    return { type: node.type, props: Object.assign({}, node.props), children };
  }

  function render(nextElement) {
    element = nextElement;
    instances = [];
    queue = [];
    dirty = false;
    tree = renderValue(element, 'root');
    return tree;
  }

  async function drain() {
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function settle() {
    for (let round = 0; round < 24; round += 1) {
      if (dirty) tree = render(element);
      if (queue.length === 0) {
        await drain();
        if (!dirty && queue.length === 0) return tree;
        continue;
      }
      const pending = queue;
      queue = [];
      dirty = false;
      for (const entry of pending) {
        const slot = entry.fiber.effects[entry.index];
        if (slot && typeof slot.cleanup === 'function') {
          try { slot.cleanup(); } catch (error) { /* ignore */ }
        }
        let cleanup = null;
        if (slot && typeof slot.run === 'function') cleanup = slot.run();
        if (slot && typeof cleanup === 'function') slot.cleanup = cleanup;
      }
      await drain();
    }
    return tree;
  }

  return {
    react,
    renderComponent(component, props) { return render(react.createElement(component, props || {})); },
    tree() { return tree; },
    instancesOf(component) { return instances.filter((entry) => entry.type === component); },
    settle
  };
}

/** A plugin instance wired to the hook runtime, a temp host and fake services. */
function createRuntimeHarness() {
  const runtime = createMiniRuntime();
  const fetchCalls = [];
  const openedSessions = [];
  const now = Date.now();
  const rows = [
    {
      id: 's-a', title: 'First session', tags: [], cwd: '/work/a', updatedAt: now, archived: false,
      blank: false, running: false, lastTurnEnd: 'completed', pinned: false
    },
    {
      id: 's-b', title: 'Second session', tags: [], cwd: '/work/b', updatedAt: now - 5000, archived: false,
      blank: false, running: false, lastTurnEnd: 'completed', pinned: false
    }
  ];
  const workspace = {
    openSession(id) { openedSessions.push(id); return Promise.resolve(); },
    forkSession() { return Promise.resolve(); },
    pinSession() { return Promise.resolve(); },
    unpinSession() { return Promise.resolve(); },
    archiveSession() { return Promise.resolve(); },
    unarchiveSession() { return Promise.resolve(); }
  };
  const services = { uiWorkspace: workspace };

  function respond(body, status) {
    const code = typeof status === 'number' ? status : 200;
    return Promise.resolve({
      ok: code >= 200 && code < 300,
      status: code,
      statusText: 'HTTP ' + code,
      text: () => Promise.resolve(JSON.stringify(body))
    });
  }

  function fetchImpl(url, init) {
    fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET' });
    const prefix = '/api/dsh-session-studio';
    const raw = String(url);
    const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (path === '/jobs' || path.startsWith('/jobs?')) {
      return respond({ error: { code: 'unavailable', message: 'job runner disabled' } }, 503);
    }
    if (path === '/sessions?includeArchived=true&includeSubagents=true') {
      return respond({ rows, indexing: { running: false } });
    }
    if (path === '/state') return respond({ rules: [], tagDefs: [], indexing: { running: false } });
    if (/^\/sessions\/[^/]+\/value$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2]);
      return respond({ id, title: 'Value title', firstMessage: 'hello', cwd: '/work', updatedAt: now, tags: [], note: '' });
    }
    return respond({}, 200);
  }

  const loadedRuntime = loadPlugin({ react: runtime.react, fetch: fetchImpl });
  const ctx = {
    effect(effect) { effect(); return { dispose() {} }; },
    slots: {
      inject(name, callback) { callback(); return { dispose() {} }; },
      register(options, component) { return { options, component, disposed: false }; }
    },
    get(name) { return services[name] || null; }
  };
  loadedRuntime.plugin.apply(ctx);
  return {
    plugin: loadedRuntime.plugin,
    runtime,
    fetchCalls,
    openedSessions,
    sessionsCalls() { return fetchCalls.filter((call) => call.url.includes('/sessions?includeArchived')).length; }
  };
}

test('the in-panel split opens from a row, switches rows and closes with Esc or its button', async () => {
  const harness = createRuntimeHarness();
  const { plugin: runtimePlugin, runtime } = harness;
  runtime.renderComponent(runtimePlugin.components.Page, {});
  await runtime.settle();

  let tree = runtime.tree();
  assert.ok(!findNode(tree, (node) => node.props.className === 'sm-split-detail'), 'the split starts closed');

  const firstRow = runtime.instancesOf(runtimePlugin.components.Row).find((entry) => entry.props.row.id === 's-a');
  assert.ok(firstRow, 'the fixture rows rendered');
  firstRow.props.onOpenDetail(firstRow.props.row);
  tree = await runtime.settle();
  let pane = findNode(tree, (node) => node.props.className === 'sm-detail-pane');
  assert.ok(pane, 'the detail opens inside the panel, not in the right sidebar');
  assert.equal(pane.props['data-session-id'], 's-a');

  const secondRow = runtime.instancesOf(runtimePlugin.components.Row).find((entry) => entry.props.row.id === 's-b');
  secondRow.props.onOpenDetail(secondRow.props.row);
  tree = await runtime.settle();
  pane = findNode(tree, (node) => node.props.className === 'sm-detail-pane');
  assert.equal(pane.props['data-session-id'], 's-b', 'another row switches the same split');

  const pageNode = findNode(tree, (node) => node.props.className === 'sm-page');
  pageNode.props.onKeyDown({ key: 'Escape', preventDefault() {}, target: null });
  tree = await runtime.settle();
  assert.ok(!findNode(tree, (node) => node.props.className === 'sm-split-detail'), 'Esc closes the split');

  const reopen = runtime.instancesOf(runtimePlugin.components.Row).find((entry) => entry.props.row.id === 's-a');
  reopen.props.onOpenDetail(reopen.props.row);
  tree = await runtime.settle();
  const close = findNode(tree, (node) => node.props.className === 'sm-icon-btn sm-detail-close');
  close.props.onClick();
  tree = await runtime.settle();
  assert.ok(!findNode(tree, (node) => node.props.className === 'sm-split-detail'), 'the close button collapses the split');
});

test('a successful detail action refreshes the list silently', async () => {
  const harness = createRuntimeHarness();
  const { plugin: runtimePlugin, runtime } = harness;
  runtime.renderComponent(runtimePlugin.components.Page, {});
  await runtime.settle();

  const row = runtime.instancesOf(runtimePlugin.components.Row).find((entry) => entry.props.row.id === 's-a');
  row.props.onOpenDetail(row.props.row);
  const tree = await runtime.settle();
  const before = harness.sessionsCalls();
  const openButton = findNode(tree, (node) => node.type === 'button' && textOf(node).includes('打开会话'));
  assert.ok(openButton, 'the split offers the open action');
  openButton.props.onClick();
  await runtime.settle();

  assert.deepEqual(harness.openedSessions, ['s-a']);
  assert.ok(harness.sessionsCalls() > before, 'onChanged ran the silent list load');
});

test('a 503 from /jobs parks polling and the toolbar trigger', async () => {
  const harness = createRuntimeHarness();
  const { plugin: runtimePlugin, runtime } = harness;
  runtime.renderComponent(runtimePlugin.components.Page, {});
  await runtime.settle();

  const tree = runtime.tree();
  const trigger = findNode(tree, (node) => node.props.className === 'sm-jobs-trigger sm-jobs-trigger-disabled');
  assert.ok(trigger, 'the task trigger renders parked');
  assert.equal(trigger.props.disabled, true);
  assert.ok(textOf(trigger).includes('任务不可用'));
  assert.ok(!harness.fetchCalls.some((call) => call.url.includes('/jobs?active=1')), 'polling never starts after the 503');
});
