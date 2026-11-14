/**
 * dsh-session-manager — client half.
 *
 * Hand-written browser bundle, no build step. The DSH Web app evaluates this
 * file and \`window.__ModuleLoader__.load\` collects the { inject, apply } plugin
 * the loader installs on the client root context.
 *
 * Contract (docs/CONTRACTS.md, docs/PRD.md §7):
 *   - only \`require('react')\`; no JSX, no imports, every element through h();
 *   - \`main\` (key 'session-manager') is the page, \`sidebar.panellist\`
 *     (id 'session-manager', order 40) is its sidebar icon; both registrations
 *     and the <style data-plugin="dsh-session-manager"> element are owned by
 *     ctx.effect(...), so plugin unload removes them;
 *   - all data arrives over the same-origin JSON channel
 *     \`/api/dsh-session-manager/...\`;
 *   - live status (running / pendingInteraction / completionUnread) comes from
 *     the slot props \`useSessionStatus\` / \`useSessions\` when the runtime
 *     provides them, and degrades to host rows (lastTurnEnd + running) when it
 *     does not. PRD §3 is the single source of the status vocabulary.
 *
 * The pure helpers (status derivation, filtering, grouping) are exported on
 * \`helpers\` so tests can exercise them without a browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory: function (require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useRef = React.useRef;

    /* ------------------------------------------------------------------ *
     * Constants — PRD §3 is the only source of these names.
     * ------------------------------------------------------------------ */

    var NS = 'dsh-session-manager';
    var PANEL_ID = 'session-manager';
    var API_PREFIX = '/api/dsh-session-manager';
    /**
     * Every host route this panel calls (docs/PRD.md §8). One map keeps the
     * client side of the HTTP contract greppable and directly testable.
     */
    var API_PATHS = {
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
    var SIDEBAR_ORDER = 40;

    /** PRD §3 priority order, top wins. One dot per row, never a combination. */
    var STATUS_IDS = ['pending', 'running', 'blocked', 'failed', 'unread', 'completed', 'interrupted'];
    /** PRD §3 overview strip: the four actionable buckets, in priority order. */
    var OVERVIEW_IDS = ['pending', 'blocked', 'failed', 'unread'];
    /** CONTEXT "组头汇总": total plus every status count, in STATUS_IDS order. */
    var GROUP_COUNT_IDS = STATUS_IDS.slice();
    /** CONTEXT "时间桶": local calendar days. */
    var BUCKET_IDS = ['today', 'week', 'month', 'earlier'];
    var GROUP_IDS = ['status', 'time', 'tag', 'none'];
    var ARCHIVE_VIEWS = ['hide', 'include', 'only'];
    var RULE_FIELDS = ['title', 'firstMessage', 'cwd', 'note'];
    /** PRD §3 lists the shipped interaction kinds; other domains stay pending. */
    var PENDING_KINDS = ['approval', 'plan-review', 'question'];

    /* ---------------- v0.2 contract constants (PRD §7.2–§7.4, §8.1) ---------------- */

    /** Native-aligned context-menu entries, in the PRD §7.2 table order. */
    var MENU_ITEM_IDS = ['pin', 'rename', 'fork', 'copyId', 'reveal', 'archive', 'detail', 'open'];
    var TRASH_MENU_ITEM_IDS = ['restore', 'purge'];
    /** Panel-scoped shortcuts (PRD D10): never registered globally. */
    var SHORTCUT_KEYS = { rename: 'Ctrl+Alt+G', fork: 'Ctrl+Shift+F', archive: 'Ctrl+Alt+A' };
    /** PRD §8.1 job state machine and the task types the host can run. */
    var JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
    var JOB_ACTIVE_STATES = ['queued', 'running'];
    var JOB_TYPE_IDS = ['ai.rename', 'rename.apply', 'ai.tags', 'tags.fillMissing'];
    var JOB_POLL_MS = 800;
    var REFRESH_MERGE_MS = 1500;

    /** Job and value routes carry an id, so they are built rather than tabled. */
    function jobPath(id) { return API_PATHS.jobs + '/' + encodeURIComponent(String(id)); }
    function jobCancelPath(id) { return jobPath(id) + '/cancel'; }
    function activeJobsPath() { return API_PATHS.jobs + '?active=1'; }
    function sessionValuePath(id) { return API_PATHS.sessions + '/' + encodeURIComponent(String(id)) + '/value'; }

    /* ------------------------------------------------------------------ *
     * Pure helpers — every one is deterministic and side-effect free.
     * ------------------------------------------------------------------ */

    function isPendingInteraction(value) {
      if (value === undefined || value === null) return false;
      // PRD §3 names approval / plan-review / question. A domain that publishes
      // another kind is still "waiting for the user", so it stays pending.
      return typeof value === 'object' ? true : Boolean(value);
    }

    /** PRD §3: pending > running > blocked > failed > unread > completed > interrupted. */
    function deriveStatus(row, live) {
      var source = row || {};
      var status = live || {};
      if (isPendingInteraction(status.pendingInteraction)) return 'pending';
      var running = status.running === undefined ? source.running : status.running;
      if (running) return 'running';
      if (source.lastTurnEnd === 'blocked') return 'blocked';
      if (source.lastTurnEnd === 'error' || source.lastTurnEnd === 'max-tokens') return 'failed';
      if (status.completionUnread) return 'unread';
      // PRD §3 v0.2: only interrupted/aborted count as an interruption; any other
      // value (completed, forked, null, unknown) means "no evidence of one".
      if (source.lastTurnEnd === 'interrupted' || source.lastTurnEnd === 'aborted') return 'interrupted';
      return 'completed';
    }

    function startOfDay(value) {
      var date = new Date(value);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    /** Calendar-day bucket of a timestamp (CONTEXT "时间桶"). Missing time is "earlier". */
    function bucketOf(updatedAt, now) {
      if (typeof updatedAt !== 'number' || !isFinite(updatedAt) || updatedAt <= 0) return 'earlier';
      var reference = typeof now === 'number' && isFinite(now) ? now : Date.now();
      var days = Math.round((startOfDay(reference) - startOfDay(updatedAt)) / 86400000);
      if (days <= 0) return 'today';
      if (days < 7) return 'week';
      if (days < 30) return 'month';
      return 'earlier';
    }

    function asTags(value) {
      return Array.isArray(value) ? value.filter(function (tag) { return typeof tag === 'string' && tag !== ''; }) : [];
    }

    /**
     * v0.3.2: a suggestion that is already a real tag renders as a second, greyed-out
     * chip for the same word. The host strips those on read, but an older host can
     * still send the pair, so the view defends itself too.
     */
    function withoutAcceptedTags(suggestions, tags) {
      var accepted = {};
      for (var index = 0; index < tags.length; index += 1) accepted[tags[index].toLowerCase()] = true;
      return suggestions.filter(function (tag) { return !accepted[tag.toLowerCase()]; });
    }

    /** Host row + live status -> the row the UI renders. Never mutates the input. */
    function decorateRows(rows, liveById, now) {
      var map = liveById || {};
      return (Array.isArray(rows) ? rows : []).map(function (row) {
        var live = map[row.id] || null;
        var tags = asTags(row.tags);
        var next = Object.assign({}, row, {
          title: typeof row.title === 'string' ? row.title : '',
          tags: tags,
          suggestedTags: withoutAcceptedTags(asTags(row.suggestedTags), tags),
          note: typeof row.note === 'string' ? row.note : '',
          status: deriveStatus(row, live),
          bucket: bucketOf(row.updatedAt, now)
        });
        return next;
      });
    }

    function matchesSearch(row, query) {
      var needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (!needle) return true;
      var title = (row.title || '').toLowerCase();
      if (title.indexOf(needle) >= 0) return true;
      // PRD US13: id supports prefix matching.
      if ((row.id || '').toLowerCase().indexOf(needle) === 0) return true;
      if ((row.note || '').toLowerCase().indexOf(needle) >= 0) return true;
      var tags = asTags(row.tags).concat(asTags(row.suggestedTags));
      for (var index = 0; index < tags.length; index += 1) {
        if (tags[index].toLowerCase().indexOf(needle) >= 0) return true;
      }
      if ((row.workspaceTitle || '').toLowerCase().indexOf(needle) >= 0) return true;
      return false;
    }

    /** Search + status/time/tag filters + archive view + subagent/blank visibility. */
    function filterRows(rows, options) {
      var opts = options || {};
      var filters = opts.filters || {};
      var statuses = Array.isArray(filters.statuses) ? filters.statuses : [];
      var buckets = Array.isArray(filters.buckets) ? filters.buckets : [];
      var tags = Array.isArray(filters.tags) ? filters.tags : [];
      var archiveView = opts.archiveView || 'hide';
      var showSubagents = Boolean(opts.showSubagents);
      var showBlank = Boolean(opts.showBlank);
      return (Array.isArray(rows) ? rows : []).filter(function (row) {
        if (row.blank && !showBlank) return false;
        if (row.subagent && !showSubagents) return false;
        if (archiveView === 'hide' && row.archived) return false;
        if (archiveView === 'only' && !row.archived) return false;
        if (statuses.length > 0 && statuses.indexOf(row.status) < 0) return false;
        if (buckets.length > 0 && buckets.indexOf(row.bucket) < 0) return false;
        if (tags.length > 0) {
          var hit = false;
          for (var index = 0; index < tags.length; index += 1) {
            if (row.tags.indexOf(tags[index]) >= 0) { hit = true; break; }
          }
          if (!hit) return false;
        }
        return matchesSearch(row, opts.query);
      });
    }

    function statusCounts(rows) {
      var counts = {};
      for (var index = 0; index < STATUS_IDS.length; index += 1) counts[STATUS_IDS[index]] = 0;
      for (var rowIndex = 0; rowIndex < (rows || []).length; rowIndex += 1) {
        var status = rows[rowIndex] && rows[rowIndex].status;
        if (status && counts[status] !== undefined) counts[status] += 1;
      }
      return counts;
    }

    function makeGroup(key, labelKey, label, rows) {
      return { key: key, labelKey: labelKey, label: label, rows: rows, total: rows.length, counts: statusCounts(rows) };
    }

    /**
     * Groups are a display projection only; filtering never changes the
     * dimension. PRD §2 US3/D3: a multi-tag session appears in each tag group.
     */
    function groupRows(rows, dimension) {
      var list = Array.isArray(rows) ? rows : [];
      if (dimension === 'none') return [makeGroup('all', 'group.all', null, list)];
      if (dimension === 'time') {
        var groups = [];
        for (var bucketIndex = 0; bucketIndex < BUCKET_IDS.length; bucketIndex += 1) {
          var bucket = BUCKET_IDS[bucketIndex];
          var bucketRows = list.filter(function (row) { return row.bucket === bucket; });
          if (bucketRows.length > 0) groups.push(makeGroup('time:' + bucket, 'bucket.' + bucket, null, bucketRows));
        }
        return groups;
      }
      if (dimension === 'tag') {
        var byTag = {};
        var untagged = [];
        for (var rowIndex = 0; rowIndex < list.length; rowIndex += 1) {
          var row = list[rowIndex];
          if (!row.tags || row.tags.length === 0) { untagged.push(row); continue; }
          for (var tagIndex = 0; tagIndex < row.tags.length; tagIndex += 1) {
            var tag = row.tags[tagIndex];
            if (!byTag[tag]) byTag[tag] = [];
            byTag[tag].push(row);
          }
        }
        var names = Object.keys(byTag).sort(function (left, right) {
          return left.localeCompare(right, 'zh-Hans-CN');
        });
        var tagGroups = names.map(function (name) {
          return makeGroup('tag:' + name, null, name, byTag[name]);
        });
        if (untagged.length > 0) tagGroups.push(makeGroup('untagged', 'group.untagged', null, untagged));
        return tagGroups;
      }
      var statusGroups = [];
      for (var statusIndex = 0; statusIndex < STATUS_IDS.length; statusIndex += 1) {
        var status = STATUS_IDS[statusIndex];
        var statusRows = list.filter(function (entry) { return entry.status === status; });
        if (statusRows.length > 0) statusGroups.push(makeGroup('status:' + status, 'status.' + status, null, statusRows));
      }
      return statusGroups;
    }

    /** v0.3.1: where the user's own group order is remembered (PRD §7.1 拖动排序). */
    var GROUP_ORDER_STORAGE_KEY = 'dsh-session-manager.group-order';

    /**
     * Sort groups by a remembered key order (v0.3.1 拖动排序). Keys that the
     * memory does not mention keep their relative order at the end, so a new
     * status or tag never disappears just because it is not in the saved list.
     */
    function applyGroupOrder(groups, order) {
      var list = Array.isArray(groups) ? groups.slice() : [];
      var keys = Array.isArray(order) ? order : [];
      if (keys.length === 0) return list;
      var rank = {};
      for (var index = 0; index < keys.length; index += 1) rank[keys[index]] = index;
      return list.sort(function (left, right) {
        var leftRank = rank[left.key];
        var rightRank = rank[right.key];
        if (leftRank === undefined && rightRank === undefined) return 0;
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
      });
    }

    /**
     * Drop `key` onto `targetKey`: the dragged group lands on the side it came
     * from, which is what a drag gesture looks like to the user.
     */
    function moveGroupKey(order, key, targetKey) {
      var list = Array.isArray(order) ? order.slice() : [];
      var from = list.indexOf(key);
      var to = list.indexOf(targetKey);
      if (from < 0 || to < 0 || from === to) return list;
      list.splice(from, 1);
      list.splice(to, 0, key);
      return list;
    }

    /** Keyboard equivalent of a drag: one slot up (-1) or down (+1). */
    function moveGroupBy(order, key, delta) {
      var list = Array.isArray(order) ? order.slice() : [];
      var at = list.indexOf(key);
      if (at < 0) return list;
      var to = at + (delta < 0 ? -1 : 1);
      if (to < 0 || to >= list.length) return list;
      list.splice(at, 1);
      list.splice(to, 0, key);
      return list;
    }

    /** localStorage when the host has one, otherwise null (private modes, tests). */
    function groupOrderStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
      } catch (error) { /* access can throw when storage is blocked */ }
      try {
        if (typeof window !== 'undefined' && window && window.localStorage) return window.localStorage;
      } catch (error) { /* same */ }
      return null;
    }

    function readGroupOrder() {
      try {
        var storage = groupOrderStorage();
        var raw = storage ? storage.getItem(GROUP_ORDER_STORAGE_KEY) : null;
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function writeGroupOrder(order) {
      try {
        var storage = groupOrderStorage();
        if (!storage) return false;
        storage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(order || {}));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Newest first; stable on id so groups do not reshuffle between refreshes. */
    function sortRows(rows) {
      return (Array.isArray(rows) ? rows.slice() : []).sort(function (left, right) {
        var delta = (right.updatedAt || 0) - (left.updatedAt || 0);
        if (delta !== 0) return delta;
        return (left.id || '') < (right.id || '') ? -1 : 1;
      });
    }

    function relativeTime(timestamp, now) {
      var reference = typeof now === 'number' ? now : Date.now();
      if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return { unit: 'unknown', value: 0 };
      var minutes = Math.floor(Math.max(0, reference - timestamp) / 60000);
      if (minutes < 1) return { unit: 'now', value: 0 };
      if (minutes < 60) return { unit: 'minute', value: minutes };
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return { unit: 'hour', value: hours };
      var days = Math.floor(hours / 24);
      if (days < 30) return { unit: 'day', value: days };
      var months = Math.floor(days / 30);
      if (months < 12) return { unit: 'month', value: months };
      return { unit: 'year', value: Math.floor(months / 12) };
    }

    function toggleValue(list, value) {
      var source = Array.isArray(list) ? list : [];
      var index = source.indexOf(value);
      if (index >= 0) {
        var next = source.slice();
        next.splice(index, 1);
        return next;
      }
      return source.concat([value]);
    }

    function parseTagInput(text) {
      if (typeof text !== 'string') return [];
      return text.split(/[,，;；\n]/).map(function (part) {
        return part.trim();
      }).filter(function (part) { return part !== ''; });
    }

    function basename(value) {
      if (typeof value !== 'string' || value === '') return '';
      var parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
      return parts[parts.length - 1] || value;
    }

    /** Why a Session is excluded from a batch; PRD §6 "跳过". */
    function skipReasonFor(row, options) {
      var opts = options || {};
      if (!row) return 'missing';
      if (row.blank) return 'blank';
      if (row.subagent) return 'subagent';
      if (row.running || row.status === 'running') return 'running';
      if (row.archived) return 'archived';
      if (opts.forRename && row.titleLocked) return 'titleLocked';
      return null;
    }

    function isBatchable(row) {
      return Boolean(row) && !row.blank && !row.subagent;
    }


    /* ------------------------------------------------------------------ *
     * v0.2 pure helpers — context menu, shortcuts, selection, jobs, detail.
     * Each is deterministic and side-effect free so tests cover the rules
     * without a browser (PRD §7.1–§7.4).
     * ------------------------------------------------------------------ */

    /** Read an optional client service; a missing service never throws here. */
    /**
     * Optional service lookup.
     *
     * The client sandbox wraps every service in a guard that throws on any member
     * read the plugin did not declare in `inject` ("cannot get property
     * remote.session without inject"). A single such read used to escape a
     * render and blank the whole panel, so every member read here is defensive:
     * an undeclared or absent member simply reads as undefined.
     */
    function optionalService(ctx, name) {
      try {
        if (!ctx || typeof ctx.get !== 'function') return null;
        var service = ctx.get(name) || null;
        if (!service || (typeof service !== 'object' && typeof service !== 'function')) return service;
        return new Proxy(service, {
          get: function (target, property) {
            try {
              var value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            } catch (error) {
              return undefined;
            }
          }
        });
      } catch (error) {
        return null;
      }
    }

    function hasMethod(target, method) {
      try {
        return Boolean(target) && typeof target[method] === 'function';
      } catch (error) {
        return false;
      }
    }

    function clipboardOf() {
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard;
        }
      } catch (error) {
        return null;
      }
      return null;
    }

    /**
     * Which context-menu entries the current client can run (PRD §7.2).
     * Every dependency is optional: absence disables its entries with a reason.
     */
    function menuCapabilities(services) {
      var source = services || {};
      try {
        var workspace = source.uiWorkspace || null;
        var remote = source.remote || null;
        var remoteSession = null;
        try { remoteSession = remote ? remote.session : null; } catch (error) { remoteSession = null; }
        return {
          pin: hasMethod(workspace, 'pinSession') && hasMethod(workspace, 'unpinSession'),
          fork: hasMethod(workspace, 'forkSession'),
          open: hasMethod(workspace, 'openSession'),
          archive: hasMethod(workspace, 'archiveSession'),
          unarchive: hasMethod(workspace, 'unarchiveSession'),
          clipboard: hasMethod(source.clipboard, 'writeText'),
          reveal: hasMethod(remoteSession, 'openWorkspacePath'),
          restore: Boolean(source.restore),
          trash: Boolean(source.trash)
        };
      } catch (error) {
        return { pin: false, fork: false, open: false, archive: false, unarchive: false, clipboard: false, reveal: false, restore: false, trash: false };
      }
    }

    var MENU_LABEL_KEYS = {
      pin: 'menu.pin',
      unpin: 'menu.unpin',
      rename: 'menu.rename',
      fork: 'menu.fork',
      copyId: 'menu.copyId',
      reveal: 'menu.reveal',
      archive: 'menu.archive',
      unarchive: 'menu.unarchive',
      detail: 'menu.detail',
      open: 'menu.open',
      restore: 'menu.restore',
      purge: 'menu.purge',
      tags: 'menu.tags',
      note: 'menu.note',
      trash: 'menu.trash'
    };

    function menuEntry(id, enabled, reasonKey, extra) {
      var entry = {
        id: id,
        labelKey: MENU_LABEL_KEYS[id] || id,
        enabled: Boolean(enabled),
        reasonKey: enabled ? null : (reasonKey || 'menu.reason.noService'),
        shortcut: SHORTCUT_KEYS[id] || null
      };
      if (extra && extra.danger) entry.danger = true;
      return entry;
    }

    /**
     * The row context menu and whether each entry is runnable (PRD §7.2).
     * Disabled entries stay visible and carry the key of the reason to show.
     */
    function menuItemsFor(row, caps, options) {
      var source = row || {};
      var abilities = caps || {};
      var view = options && options.view ? options.view : 'list';
      if (view === 'trash') {
        return [
          menuEntry('restore', abilities.restore, 'menu.reason.noService'),
          menuEntry('purge', false, 'menu.reason.purgeUnsupported', { danger: true })
        ];
      }
      var archived = Boolean(source.archived);
      var blank = Boolean(source.blank);
      var hasCwd = typeof source.cwd === 'string' && source.cwd !== '';
      var unableToOpen = blank ? 'menu.reason.blank' : (archived ? 'menu.reason.archived' : 'menu.reason.noService');
      var items = [];
      items.push(menuEntry(source.pinned ? 'unpin' : 'pin', abilities.pin && !archived, archived ? 'menu.reason.archived' : 'menu.reason.noService'));
      items.push(menuEntry('rename', true, null));
      items.push(menuEntry('fork', abilities.fork && !archived && !blank, blank ? 'menu.reason.blank' : (archived ? 'menu.reason.archived' : 'menu.reason.noService')));
      items.push(menuEntry('copyId', abilities.clipboard, 'menu.reason.noClipboard'));
      items.push(menuEntry('reveal', abilities.reveal && hasCwd, hasCwd ? 'menu.reason.noRemote' : 'menu.reason.noCwd'));
      items.push(menuEntry(archived ? 'unarchive' : 'archive', archived ? abilities.unarchive : abilities.archive, 'menu.reason.noService'));
      // The detail split is part of this panel, so it is always available.
      items.push(menuEntry('detail', true, null));
      items.push(menuEntry('open', abilities.open && !archived && !blank, unableToOpen));
      return items;
    }

    /**
     * The plugin's own row menu (the "⋯" button). Native parity first, then the
     * actions only this panel can host: edit tags, edit the note, move to trash.
     * Right-click keeps the shared native menu (PRD §7.2); this menu is the
     * home for plugin-only row actions.
     */
    function pluginMenuItemsFor(row, caps) {
      return menuItemsFor(row, caps).concat([
        menuEntry('tags', true, null),
        menuEntry('note', true, null),
        menuEntry('trash', true, null, { danger: true })
      ]);
    }

    function findMenuItem(items, id) {
      for (var index = 0; index < (items || []).length; index += 1) {
        if (items[index] && items[index].id === id) return items[index];
      }
      return null;
    }

    function enabledMenuIndexes(items) {
      var list = [];
      for (var index = 0; index < (items || []).length; index += 1) {
        if (items[index] && items[index].enabled) list.push(index);
      }
      return list;
    }

    /** Next enabled entry; menu arrow keys skip disabled items without wrapping. */
    function nextEnabledIndex(items, from, delta) {
      var indexes = enabledMenuIndexes(items);
      if (indexes.length === 0) return -1;
      var step = delta < 0 ? -1 : 1;
      var position = indexes.indexOf(from);
      if (position < 0) return step < 0 ? indexes[indexes.length - 1] : indexes[0];
      var next = position + step;
      if (next < 0) return indexes[0];
      if (next >= indexes.length) return indexes[indexes.length - 1];
      return indexes[next];
    }

    function firstEnabledIndex(items) { return nextEnabledIndex(items, -1, 1); }

    /** What a key press inside the open row menu does (PRD §7.2 keyboard rules). */
    function menuKeyAction(items, activeIndex, key) {
      var name = typeof key === 'string' ? key : '';
      if (name === 'Escape' || name === 'Esc' || name === 'Tab') return { kind: 'close' };
      if (name === 'ArrowDown' || name === 'Down') return { kind: 'move', index: nextEnabledIndex(items, activeIndex, 1) };
      if (name === 'ArrowUp' || name === 'Up') return { kind: 'move', index: nextEnabledIndex(items, activeIndex, -1) };
      if (name === 'Home') return { kind: 'move', index: nextEnabledIndex(items, -1, 1) };
      if (name === 'End') return { kind: 'move', index: nextEnabledIndex(items, Number.MAX_SAFE_INTEGER, -1) };
      if (name === 'Enter' || name === ' ' || name === 'Spacebar') {
        var item = (items || [])[activeIndex];
        return item && item.enabled ? { kind: 'activate', index: activeIndex } : { kind: 'none' };
      }
      return { kind: 'none' };
    }

    /** Flip the menu back inside the viewport instead of letting it overflow. */
    function menuPlacement(anchor, viewport, size) {
      var point = anchor || {};
      var box = viewport || {};
      var menu = size || {};
      var margin = typeof menu.margin === 'number' ? menu.margin : 8;
      var width = typeof menu.width === 'number' ? menu.width : 0;
      var height = typeof menu.height === 'number' ? menu.height : 0;
      var left = typeof point.x === 'number' ? point.x : 0;
      var top = typeof point.y === 'number' ? point.y : 0;
      var flippedX = false;
      var flippedY = false;
      if (typeof box.width === 'number' && box.width > 0 && left + width + margin > box.width) {
        left = Math.max(margin, left - width);
        flippedX = true;
      }
      if (typeof box.height === 'number' && box.height > 0 && top + height + margin > box.height) {
        top = Math.max(margin, top - height);
        flippedY = true;
      }
      return { left: left, top: top, flippedX: flippedX, flippedY: flippedY };
    }

    /** Move the single row selection by one step; clamp at both ends. */
    function moveSelection(orderedIds, currentId, delta) {
      var list = Array.isArray(orderedIds) ? orderedIds.filter(function (id) { return typeof id === 'string' && id !== ''; }) : [];
      if (list.length === 0) return null;
      var step = delta < 0 ? -1 : 1;
      var index = currentId ? list.indexOf(currentId) : -1;
      if (index < 0) return step < 0 ? list[list.length - 1] : list[0];
      var next = index + step;
      if (next < 0 || next >= list.length) return list[index];
      return list[next];
    }

    /** Shortcut chord -> action; returns null when the chord is not one of ours. */
    function shortcutActionFor(input) {
      var source = input || {};
      var primary = Boolean(source.ctrlKey || source.ctrl || source.metaKey || source.meta);
      if (!primary) return null;
      var alt = Boolean(source.altKey || source.alt);
      var shift = Boolean(source.shiftKey || source.shift);
      if (alt && shift) return null;
      var key = typeof source.key === 'string' ? source.key.toLowerCase() : '';
      if (!key && typeof source.code === 'string') key = source.code.replace(/^Key/, '').toLowerCase();
      if (alt) {
        if (key === 'g') return 'rename';
        if (key === 'a') return 'archive';
        return null;
      }
      if (shift) {
        if (key === 'f') return 'fork';
        return null;
      }
      return null;
    }

    /** Shortcuts only act while the panel has focus and a row is selected (PRD D10). */
    function shortcutFor(input, scope) {
      var state = scope || {};
      if (!state.panelFocused || !state.selectedId) return null;
      return shortcutActionFor(input);
    }

    /* ------------------------------- jobs ------------------------------- */

    function isActiveJob(job) {
      return Boolean(job) && JOB_ACTIVE_STATES.indexOf(job.state) >= 0;
    }

    function safeNumber(value, fallback) {
      if (typeof value === 'string' && value !== '') {
        var parsed = Date.parse(value);
        if (isFinite(parsed)) return parsed;
      }
      var number = typeof value === 'number' ? value : Number(value);
      return isFinite(number) ? number : (fallback || 0);
    }

    /** Server job -> the normalized shape the task UI renders (PRD §8.1). */
    function normalizeJob(job) {
      var source = job || {};
      var state = JOB_STATES.indexOf(source.state) >= 0 ? source.state : 'queued';
      var total = Math.max(0, Math.floor(safeNumber(source.total)));
      var done = Math.max(0, Math.floor(safeNumber(source.done)));
      var failed = Math.max(0, Math.floor(safeNumber(source.failed)));
      var skipped = Math.max(0, Math.floor(safeNumber(source.skipped)));
      var percent = typeof source.percent === 'number' ? safeNumber(source.percent) : (total > 0 ? Math.floor(100 * done / total) : 0);
      // PRD §8.1: an in-flight job never reads 100; only success does.
      percent = state === 'succeeded' ? 100 : Math.max(0, Math.min(99, Math.floor(percent)));
      var error = source.error;
      var errorText = '';
      var errorCode = null;
      if (error && typeof error === 'object') {
        errorText = typeof error.message === 'string' ? error.message : '';
        errorCode = typeof error.code === 'string' ? error.code : null;
      } else if (typeof error === 'string') {
        errorText = error;
      }
      return {
        id: typeof source.id === 'string' ? source.id : '',
        type: typeof source.type === 'string' ? source.type : 'unknown',
        state: state,
        active: JOB_ACTIVE_STATES.indexOf(state) >= 0,
        total: total,
        done: done,
        failed: failed,
        skipped: skipped,
        percent: percent,
        createdAt: safeNumber(source.createdAt),
        startedAt: safeNumber(source.startedAt),
        finishedAt: safeNumber(source.finishedAt),
        errorText: errorText,
        errorCode: errorCode,
        result: source.result === undefined ? null : source.result,
        items: Array.isArray(source.items) ? source.items.slice() : [],
        itemsTruncated: Boolean(source.itemsTruncated),
        params: source.params || null
      };
    }

    function jobOrderValue(job) {
      return job.finishedAt || job.startedAt || job.createdAt || 0;
    }

    /** Active jobs first in queue order, then finished jobs newest first. */
    function sortJobs(jobs, limit) {
      var list = (Array.isArray(jobs) ? jobs : []).map(normalizeJob).filter(function (job) { return job.id !== ''; });
      list.sort(function (left, right) {
        if (left.active !== right.active) return left.active ? -1 : 1;
        if (left.active) return (left.createdAt || 0) - (right.createdAt || 0);
        return jobOrderValue(right) - jobOrderValue(left);
      });
      return typeof limit === 'number' ? list.slice(0, limit) : list;
    }

    function activeJobCount(jobs) {
      var count = 0;
      for (var index = 0; index < (jobs || []).length; index += 1) {
        if (isActiveJob(jobs[index])) count += 1;
      }
      return count;
    }

    function latestFinishedJob(jobs) {
      var list = (jobs || []).filter(function (job) { return !isActiveJob(job); });
      if (list.length === 0) return null;
      return sortJobs(list, 1)[0] || null;
    }

    /** Merge a polled page of jobs into the local list without dropping history. */
    function mergeJobList(previous, incoming) {
      var map = {};
      var order = [];
      var add = function (job) {
        var normalized = normalizeJob(job);
        if (normalized.id === '') return;
        if (!map[normalized.id]) order.push(normalized.id);
        map[normalized.id] = normalized;
      };
      (Array.isArray(previous) ? previous : []).forEach(add);
      (Array.isArray(incoming) ? incoming : []).forEach(add);
      return order.map(function (id) { return map[id]; });
    }

    /* ------------------------------ detail ------------------------------ */

    function turnEndKey(reason) {
      if (typeof reason !== 'string' || reason === '') return 'turnEnd.none';
      return TEXT['turnEnd.' + reason] ? 'turnEnd.' + reason : 'turnEnd.none';
    }

    /** Fold GET /sessions/:id/value into a loaded row without losing live fields. */
    function mergeDetailRow(row, value, sessionId) {
      var base = row || { id: sessionId, tags: [], suggestedTags: [], note: '', status: 'completed' };
      var source = value || {};
      var merged = Object.assign({}, base);
      merged.id = base.id || sessionId;
      if (typeof source.title === 'string' && source.title !== '') merged.title = source.title;
      if (typeof source.firstMessage === 'string') merged.firstMessage = source.firstMessage;
      if (typeof source.cwd === 'string' && source.cwd !== '') merged.cwd = source.cwd;
      if (typeof source.updatedAt === 'number' && source.updatedAt > 0) merged.updatedAt = source.updatedAt;
      if (Array.isArray(source.tags)) merged.tags = asTags(source.tags);
      if (typeof source.note === 'string') merged.note = source.note;
      if (!merged.status) merged.status = 'completed';
      return merged;
    }

    /** Row data shared with the in-panel detail split (PRD §7.3 "优先用已加载的行"). */
    var rowCache = new Map();
    var jobWaiters = {};

    function cacheRows(rows) {
      rowCache.clear();
      for (var index = 0; index < (rows || []).length; index += 1) {
        var row = rows[index];
        if (row && typeof row.id === 'string') rowCache.set(row.id, row);
      }
    }

    function rowFromCache(id) {
      if (typeof id !== 'string' || id === '') return null;
      return rowCache.get(id) || null;
    }

    /**
     * Stale-while-revalidate cache: the last successful /sessions payload.
     * Reopening the panel renders it on the first frame, then refreshes behind
     * the scenes (PRD v0.2 fix: no blank first paint).
     */
    var panelCache = { rows: [], meta: null, indexing: null, at: 0 };

    function rememberPanel(rows, meta, indexing) {
      panelCache = {
        rows: Array.isArray(rows) ? rows : [],
        meta: meta || null,
        indexing: indexing || null,
        at: Date.now()
      };
    }

    function readPanelCache() {
      return panelCache;
    }

    function forgetPanelCache() {
      panelCache = { rows: [], meta: null, indexing: null, at: 0 };
    }

    /**
     * Which layer owns Esc (panel root): a dialog first, then the row menu,
     * then the detail split (PRD v0.2 in-panel detail).
     */
    function panelEscapeAction(state) {
      var source = state || {};
      if (source.dialog) return 'dialog';
      if (source.menu) return 'menu';
      if (source.detailId) return 'detail';
      return 'none';
    }

    /** Capabilities the menu and the detail split probe, all read defensively. */
    function serviceCaps() {
      return menuCapabilities({
        uiWorkspace: optionalService(pageCtx, 'uiWorkspace'),
        remote: optionalService(pageCtx, 'remote'),
        clipboard: clipboardOf()
      });
    }

    /* ------------------------------------------------------------------ *
     * v0.3 native integration (PRD §7.5): the tag submenu contributed to
     * every native Session context menu. Menu providers resolve outside
     * React, so these are plain promise helpers and never touch hooks.
     * ------------------------------------------------------------------ */

    var tagMenuCache = { defs: null, at: 0 };
    var TAG_MENU_TTL_MS = 30000;

    function sessionValuePath(id) {
      return '/sessions/' + encodeURIComponent(id) + '/value';
    }

    /** Tag definitions arrive either as strings or as `{name}` records. */
    function toTagNames(value) {
      var list = Array.isArray(value) ? value : [];
      var names = [];
      for (var index = 0; index < list.length; index += 1) {
        var entry = list[index];
        var name = typeof entry === 'string' ? entry : (entry && typeof entry.name === 'string' ? entry.name : '');
        if (name && names.indexOf(name) < 0) names.push(name);
      }
      return names;
    }

    /** Tag definitions for the submenu, cached briefly (menu opens are cheap). */
    function tagDefsForMenu() {
      var now = Date.now();
      if (tagMenuCache.defs && now - tagMenuCache.at < TAG_MENU_TTL_MS) return Promise.resolve(tagMenuCache.defs);
      return request(API_PATHS.state).then(function (state) {
        var defs = toTagNames(state && state.tagDefs);
        tagMenuCache = { defs: defs, at: Date.now() };
        return defs;
      });
    }

    function sessionTagsOf(id) {
      return request(sessionValuePath(id)).then(function (value) {
        return toTagNames(value && value.tags);
      });
    }

    function writeSessionTags(id, tags) {
      return postJson(API_PATHS.tags, { sessionIds: [id], op: 'replace', tags: tags });
    }

    /* ------------------------------------------------------------------ *
     * A tag written from the shared popup bypasses React: the panel would
     * keep showing the old chips until it remounted. Writers therefore
     * announce themselves, and the panel refreshes behind the pointer.
     * ------------------------------------------------------------------ */

    var tagWriteListeners = [];

    function subscribeTagWrite(listener) {
      if (typeof listener !== 'function') return function () {};
      tagWriteListeners.push(listener);
      return function () {
        var index = tagWriteListeners.indexOf(listener);
        if (index >= 0) tagWriteListeners.splice(index, 1);
      };
    }

    /** Tell every listener that Session ids just changed tags, then forget stale caches. */
    function notifyTagWrite(ids) {
      var list = Array.isArray(ids) ? ids.filter(function (id) { return typeof id === 'string' && id !== ''; }) : [];
      for (var index = 0; index < list.length; index += 1) {
        delete metaCache[list[index]];
        tagMenuCache = { defs: null, at: 0 };
      }
      for (var probe = 0; probe < list.length; probe += 1) requestSessionMeta(list[probe]);
      var listeners = tagWriteListeners.slice();
      for (var cursor = 0; cursor < listeners.length; cursor += 1) {
        try { listeners[cursor](list); } catch (error) { /* one bad listener must not stop the rest */ }
      }
    }

    /** Add or remove one tag; the host only knows append/replace/clear. */
    function toggleSessionTag(id, tag, add) {
      return sessionTagsOf(id).then(function (tags) {
        var next = tags.filter(function (name) { return name !== tag; });
        if (add) next.push(tag);
        return writeSessionTags(id, next);
      }).then(function (body) {
        notifyTagWrite([id]);
        return body;
      });
    }

    function tagMenuChild(sessionId, tag, has, menus) {
      return {
        id: 'dsh-session-manager.tag.' + tag,
        label: (has ? '✓ ' : '') + tag,
        failureLabel: t('menu.tagFailed'),
        run: function () {
          return toggleSessionTag(sessionId, tag, !has).then(function () {
            try {
              if (hasMethod(menus, 'notify')) menus.notify(has ? tf('menu.tagRemoved', { tag: tag }) : tf('menu.tagAdded', { tag: tag }), true);
            } catch (error) { /* feedback is best effort */ }
          });
        }
      };
    }

    /**
     * Native Session menu actions for tagging (PRD §7.5).
     * @param target - captured `{sessionId, displayTitle}` menu target.
     * @param menus - the contextMenus capability, used for notify() feedback.
     * @returns actions for the shared popup; [] when the host cannot answer.
     */
    /* ------------------------------------------------------------------ *
     * v0.3: the shared popup belongs to the whole app, so the panel-only
     * entries ("查看详情" / "打开会话") publish themselves only while the
     * panel is on screen. The panel owns that flag and the detail request.
     * ------------------------------------------------------------------ */

    var panelBridge = { active: false, detailId: null, detailListeners: [] };

    function setPanelActive(active) {
      panelBridge.active = Boolean(active);
    }

    function subscribePanelDetail(listener) {
      if (typeof listener !== 'function') return function () {};
      panelBridge.detailListeners.push(listener);
      return function () {
        var index = panelBridge.detailListeners.indexOf(listener);
        if (index >= 0) panelBridge.detailListeners.splice(index, 1);
      };
    }

    function requestPanelDetail(id) {
      if (typeof id !== 'string' || id === '') return;
      panelBridge.detailId = id;
      var listeners = panelBridge.detailListeners.slice();
      for (var index = 0; index < listeners.length; index += 1) {
        try { listeners[index](id); } catch (error) { /* one bad listener must not stop the rest */ }
      }
    }

    /** Entries that need the panel on screen (they open its split or a session). */
    function panelSessionMenuActions(target, services) {
      if (!panelBridge.active) return [];
      var id = target && typeof target.sessionId === 'string' ? target.sessionId : '';
      if (!id) return [];
      var servicesValue = services || {};
      var actions = [{
        id: 'dsh-session-manager.detail',
        label: t('menu.detail'),
        failureLabel: t('notice.failed'),
        run: function () { requestPanelDetail(id); }
      }];
      if (hasMethod(servicesValue.uiWorkspace, 'openSession')) {
        actions.push({
          id: 'dsh-session-manager.open',
          label: t('menu.open'),
          failureLabel: t('notice.failed'),
          run: function () { servicesValue.uiWorkspace.openSession(id); }
        });
      }
      return actions;
    }

    /** The native menu target for one panel row. */
    function nativeSessionMenuTarget(row) {
      return {
        kind: 'session',
        value: {
          sessionId: row && row.id ? row.id : '',
          displayTitle: row && typeof row.title === 'string' ? row.title : ''
        }
      };
    }

    /**
     * Open the shared native Session popup for one row (PRD §7.2).
     * @returns true when the native popup took the gesture.
     */
    function openNativeSessionMenu(menus, row, point) {
      if (!row || !hasMethod(menus, 'open')) return false;
      try {
        menus.open(nativeSessionMenuTarget(row), point || { x: 0, y: 0 });
        return true;
      } catch (error) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * v0.3 P2: ambient row metadata. The native sidebar rows carry a seat for
     * a non-interactive status badge and a hover-card section; both address
     * their data by Session id and never bind the Session. One batched probe
     * answers for every visible row, and the result is cached for a while.
     * ------------------------------------------------------------------ */

    var META_TTL_MS = 30000;
    var META_BATCH_MS = 60;
    var META_BATCH_MAX = 300;

    var metaCache = Object.create(null);
    var metaQueue = Object.create(null);
    var metaTimer = 0;
    var metaListeners = [];

    function sessionMetaPath(ids) {
      return '/session-meta?ids=' + encodeURIComponent(ids.join(','));
    }

    /** The cached meta of one Session, or null when nothing is known yet. */
    function metaOf(id) {
      return typeof id === 'string' && metaCache[id] ? metaCache[id] : null;
    }

    function subscribeSessionMeta(listener) {
      if (typeof listener !== 'function') return function () {};
      metaListeners.push(listener);
      return function () {
        var index = metaListeners.indexOf(listener);
        if (index >= 0) metaListeners.splice(index, 1);
      };
    }

    function notifySessionMeta() {
      var listeners = metaListeners.slice();
      for (var index = 0; index < listeners.length; index += 1) {
        try { listeners[index](); } catch (error) { /* one bad row must not stop the rest */ }
      }
    }

    function mergeSessionMeta(items) {
      var byId = items && typeof items === 'object' ? items : {};
      var changed = false;
      var at = Date.now();
      var keys = Object.keys(byId);
      for (var index = 0; index < keys.length; index += 1) {
        var entry = byId[keys[index]];
        if (!entry || typeof entry !== 'object') continue;
        metaCache[keys[index]] = Object.assign({ at: at }, entry);
        changed = true;
      }
      if (changed) notifySessionMeta();
      return changed;
    }

    function flushSessionMeta() {
      metaTimer = 0;
      var ids = Object.keys(metaQueue).slice(0, META_BATCH_MAX);
      metaQueue = Object.create(null);
      if (ids.length === 0) return;
      request(sessionMetaPath(ids)).then(function (body) {
        mergeSessionMeta(body && body.items);
      }, function () {
        /* decorations are best effort: a failed probe just leaves them empty */
      });
    }

    /** Ask for one row's meta; the 60 ms window coalesces a visible page of rows. */
    function requestSessionMeta(id) {
      if (typeof id !== 'string' || id === '') return;
      var cached = metaCache[id];
      if (cached && Date.now() - cached.at < META_TTL_MS) return;
      metaQueue[id] = true;
      if (metaTimer) return;
      metaTimer = setTimeout(flushSessionMeta, META_BATCH_MS);
    }

    /** Status of a native row, derived from the indexed facts (PRD §3 order). */
    function metaStatus(meta) {
      if (!meta) return null;
      return deriveStatus({ running: meta.running === true, lastTurnEnd: meta.lastTurnEnd }, null);
    }

    /** Non-interactive status badge for `sidebar.session.row.trailing`. */
    function RowStatusBadge(props) {
      var id = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      var state = useState(metaOf(id));
      var meta = state[0] || metaOf(id);
      useEffect(function () {
        if (!id) return undefined;
        requestSessionMeta(id);
        var unsubscribe = subscribeSessionMeta(function () { state[1](metaOf(id)); });
        return unsubscribe;
      }, [id]);
      if (!meta) return null;
      var status = metaStatus(meta);
      var tags = asTags(meta.tags);
      return h('span', {
        className: 'sm-native-badge',
        title: tags.length > 0 ? t('menu.tagsWith', { tags: tags.join('、') }) : statusLabel(status)
      }, [
        h('span', { key: 'dot', className: 'sm-native-badge-dot sm-dot-' + status }),
        tags.length > 0 ? h('span', { key: 'count', className: 'sm-native-badge-count' }, String(tags.length)) : null
      ]);
    }

    /** Section of the native hover card: our status and tags for this Session. */
    function RowHoverSection(props) {
      var id = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      var state = useState(metaOf(id));
      var meta = state[0] || metaOf(id);
      useEffect(function () {
        if (!id) return undefined;
        requestSessionMeta(id);
        var unsubscribe = subscribeSessionMeta(function () { state[1](metaOf(id)); });
        return unsubscribe;
      }, [id]);
      if (!meta) return null;
      var status = metaStatus(meta);
      var tags = asTags(meta.tags);
      return h('div', { className: 'sm-native-hover' }, [
        h('div', { key: 'status', className: 'sm-native-hover-row' }, [
          h(StatusDot, { key: 'dot', status: status }),
          h('span', { key: 'label', className: 'sm-native-hover-status' }, statusLabel(status))
        ]),
        tags.length > 0 ? h('div', { key: 'tags', className: 'sm-native-hover-tags' }, tags.map(function (tag) {
          return h('span', { key: tag, className: 'sm-native-hover-tag' }, tag);
        })) : null
      ]);
    }

    function sessionTagMenuActions(target, menus) {
      var id = target && typeof target.sessionId === 'string' ? target.sessionId : '';
      if (!id) return Promise.resolve([]);
      return Promise.all([tagDefsForMenu(), sessionTagsOf(id)]).then(function (pair) {
        var defs = pair[0] || [];
        var current = pair[1] || [];
        if (defs.length === 0) {
          return [{
            id: 'dsh-session-manager.tags',
            label: t('menu.tags'),
            children: [{ id: 'dsh-session-manager.tags.empty', label: t('menu.tagsEmpty'), disabled: true }]
          }];
        }
        var children = [];
        for (var index = 0; index < defs.length; index += 1) {
          children.push(tagMenuChild(id, defs[index], current.indexOf(defs[index]) >= 0, menus));
        }
        return [{ id: 'dsh-session-manager.tags', label: t('menu.tags'), children: children }];
      }, function () {
        return [];
      });
    }

    /** A host without the job runner answers 503/404; the task UI then parks itself. */
    function isJobUnavailable(cause) {
      if (!cause) return false;
      if (cause.status === 503 || cause.status === 404) return true;
      var code = typeof cause.code === 'string' ? cause.code : '';
      return code === 'unavailable' || code === 'not_found' || code === 'jobs_unavailable'
        || code === 'http_503' || code === 'http_404';
    }

    function whenJobDone(id, callback) {
      if (typeof id !== 'string' || id === '' || typeof callback !== 'function') return;
      jobWaiters[id] = callback;
    }

    function settleJob(job) {
      if (!job || typeof job.id !== 'string') return;
      var callback = jobWaiters[job.id];
      if (!callback) return;
      delete jobWaiters[job.id];
      try { callback(job); } catch (error) { /* the UI reports failures itself */ }
    }

    function clearJobWaiters() { jobWaiters = {}; }

    /* ------------------------------------------------------------------ *
     * Copy — every UI string lives here, in both locales. locale/zh.json and
     * locale/en.json carry the same catalog for translators; the bundle cannot
     * import JSON, so this table is the runtime copy.
     * ------------------------------------------------------------------ */

    var TEXT = {};

    function defineText(key, zh, en) {
      TEXT[key] = [zh, en];
    }

    defineText('app.title', '会话管理', 'Session Manager');
    defineText('app.subtitle', '按状态、时间与标签整理你的会话', 'Organize sessions by status, time and tags');
    defineText('panel', '会话管理', 'Session Manager');
    defineText('action.refresh', '刷新', 'Refresh');
    defineText('action.retry', '重试', 'Retry');
    defineText('action.close', '关闭', 'Close');
    defineText('action.cancel', '取消', 'Cancel');
    defineText('action.confirm', '确认', 'Confirm');
    defineText('action.apply', '应用', 'Apply');
    defineText('action.save', '保存', 'Save');
    defineText('action.delete', '删除', 'Delete');
    defineText('action.clear', '清除', 'Clear');
    defineText('action.edit', '编辑', 'Edit');
    defineText('action.preview', '预览', 'Preview');
    defineText('action.done', '知道了', 'Got it');

    defineText('status.pending', '待处理', 'Pending');
    defineText('status.running', '运行中', 'Running');
    defineText('status.blocked', '阻塞', 'Blocked');
    defineText('status.failed', '失败', 'Failed');
    defineText('status.unread', '已完成未读', 'Completed unread');
    defineText('status.completed', '完成', 'Completed');
    defineText('status.interrupted', '中断', 'Interrupted');

    defineText('overview.hint', '点一下按状态筛选', 'Click to filter by status');
    defineText('overview.clear', '清除状态筛选', 'Clear status filter');

    defineText('group.all', '全部会话', 'All sessions');
    defineText('group.untagged', '未打标签', 'Untagged');
    defineText('group.total', '共 {n} 个', '{n} sessions');
    defineText('group.duplicateHint', '按标签分组时，会话可能出现在多个组里', 'With tag grouping a session can appear in several groups');
    defineText('group.dragHint', '拖动调整顺序，或用 ↑/↓', 'Drag to reorder, or use ↑/↓');
    defineText('group.dragAria', '拖动 {name} 调整顺序', 'Reorder {name} by dragging');
    defineText('group.moveUp', '上移一组', 'Move group up');
    defineText('group.moveDown', '下移一组', 'Move group down');
    defineText('group.resetOrder', '恢复默认顺序', 'Reset order');

    defineText('toolbar.search', '搜索标题、ID、备注或标签', 'Search title, ID, note or tags');
    defineText('toolbar.groupBy', '分组', 'Group');
    defineText('groupBy.status', '状态', 'Status');
    defineText('groupBy.time', '时间', 'Time');
    defineText('groupBy.tag', '标签', 'Tag');
    defineText('groupBy.none', '不分组', 'None');
    defineText('toolbar.archive', '归档视图', 'Archive view');
    defineText('archive.hide', '隐藏归档', 'Hide archived');
    defineText('archive.include', '一起显示', 'Include archived');
    defineText('archive.only', '只看归档', 'Only archived');
    defineText('toolbar.showSubagents', '显示子代理', 'Show subagents');
    defineText('toolbar.aiRename', 'AI 重命名', 'AI rename');
    defineText('toolbar.aiTags', 'AI 补齐标签', 'AI fill tags');
    defineText('toolbar.rules', '规则', 'Rules');
    defineText('toolbar.trash', '回收站', 'Trash');

    defineText('filter.title', '筛选', 'Filters');
    defineText('filter.status', '状态', 'Status');
    defineText('filter.bucket', '时间', 'Time');
    defineText('filter.tag', '标签', 'Tag');
    defineText('filter.addTag', '添加标签…', 'Add tag…');
    defineText('filter.clear', '清除筛选', 'Clear filters');
    defineText('bucket.today', '今天', 'Today');
    defineText('bucket.week', '近 7 天', 'Last 7 days');
    defineText('bucket.month', '近 30 天', 'Last 30 days');
    defineText('bucket.earlier', '更早', 'Earlier');

    defineText('list.empty.title', '还没有会话', 'No sessions yet');
    defineText('list.empty.body', '运行一次对话后，这里会出现它的状态、标签与备注。', 'Start a conversation and its status, tags and note will show up here.');
    defineText('list.filtered.title', '没有匹配的会话', 'No matching sessions');
    defineText('list.filtered.body', '调整搜索或筛选条件再试。', 'Adjust the search or filters and try again.');
    defineText('error.title', '无法加载会话', 'Could not load sessions');
    defineText('error.host', '宿主接口不可用：插件服务可能未启动或版本不匹配。', 'The host API is unavailable: the plugin service may be stopped or mismatched.');
    defineText('error.code', '错误码：{code}', 'Error code: {code}');
    defineText('index.running', '正在索引 {done}/{total}', 'Indexing {done}/{total}');
    defineText('index.idle', '索引就绪', 'Index ready');
    defineText('index.note', '索引进度不阻塞浏览', 'Browsing does not wait for indexing');

    defineText('batch.selected', '已选 {n}', '{n} selected');
    defineText('batch.rename', 'AI 重命名', 'AI rename');
    defineText('batch.appendTags', '追加标签', 'Append tags');
    defineText('batch.replaceTags', '替换标签', 'Replace tags');
    defineText('batch.clearTags', '清空标签', 'Clear tags');
    defineText('batch.archive', '归档', 'Archive');
    defineText('batch.unarchive', '恢复归档', 'Unarchive');
    defineText('batch.trash', '删除', 'Delete');
    defineText('batch.clearSelection', '清空选择', 'Clear selection');
    defineText('batch.skipHint', '运行中、空白与子代理会话不参与批量操作', 'Running, blank and subagent sessions are skipped in batches');

    defineText('row.menu', '行菜单', 'Row menu');
    defineText('row.rename', '重命名', 'Rename');
    defineText('row.tags', '标签', 'Tags');
    defineText('row.note', '备注', 'Note');
    defineText('row.archive', '归档', 'Archive');
    defineText('row.unarchive', '恢复归档', 'Unarchive');
    defineText('row.trash', '删除', 'Delete');
    defineText('row.locked', '标题已锁定（AI 不会覆盖）', 'Title locked (AI will not overwrite)');
    defineText('row.archived', '已归档', 'Archived');
    defineText('row.pinned', '已固定', 'Pinned');
    defineText('row.subagent', '子代理', 'Subagent');
    defineText('row.note.present', '有备注', 'Has note');
    defineText('row.noTitle', '（无标题）', '(untitled)');
    defineText('chip.suggested', '建议标签（未采纳）', 'Suggested tag (not applied)');

    defineText('rename.title', 'AI 批量重命名', 'AI batch rename');
    defineText('rename.subtitle', '预览不写入任何数据；应用只改剩余条目。', 'Preview writes nothing; applying only touches the remaining entries.');
    defineText('rename.current', '当前标题', 'Current title');
    defineText('rename.proposed', '建议标题', 'Proposed title');
    defineText('rename.reason', '依据', 'Basis');
    defineText('rename.model', '模型：{name}', 'Model: {name}');
    defineText('rename.keep', '保留', 'Keep');
    defineText('rename.remove', '取消', 'Remove');
    defineText('rename.removed', '已取消', 'Removed');
    defineText('rename.empty', '没有可重命名的会话', 'No sessions to rename');
    defineText('rename.apply', '应用 {n} 条', 'Apply {n}');
    defineText('skip.running', '运行中', 'Running');
    defineText('skip.blank', '空白会话', 'Blank session');
    defineText('skip.subagent', '子代理会话', 'Subagent session');
    defineText('skip.titleLocked', '标题已锁定', 'Title locked');
    defineText('skip.archived', '已归档', 'Archived');
    defineText('skip.missing', '会话不存在', 'Session missing');
    defineText('skip.llm_failed', 'AI 调用失败', 'AI call failed');
    defineText('skip.unparsable', '模型输出无法解析', 'Unparsable model output');
    defineText('skip.timeout', 'AI 调用超时', 'AI call timed out');
    defineText('skip.missing_in_response', '模型输出缺少该会话', 'Missing from the model response');
    defineText('skip.invalid_title', '生成的标题不合法', 'Generated title is invalid');
    defineText('skip.unchanged', '标题没有变化', 'Title unchanged');

    defineText('tagsPreview.title', 'AI 建议标签', 'AI suggested tags');
    defineText('tagsPreview.subtitle', '采纳后只写入你保留的标签与意图，建议不会自动落库。', 'Only the tags and intents you keep are written; suggestions never apply themselves.');
    defineText('tagsPreview.suggestions', '建议', 'Suggestions');
    defineText('tagsPreview.intent', '意图', 'Intent');
    defineText('tagsPreview.reason', '依据', 'Basis');
    defineText('tagsPreview.empty', '没有可打标签的会话', 'No sessions to tag');
    defineText('tagsPreview.apply', '采纳 {n} 条', 'Apply {n}');
    defineText('tagsPreview.remove', '移除', 'Remove');
    defineText('tagsPreview.addPlaceholder', '添加标签…', 'Add a tag…');

    defineText('tagEditor.title.append', '追加标签', 'Append tags');
    defineText('tagEditor.title.replace', '替换标签', 'Replace tags');
    defineText('tagEditor.title.clear', '清空标签', 'Clear tags');
    defineText('tagEditor.body', '输入标签，用逗号或换行分隔；也可从已有词表点选。', 'Enter tags separated by commas or newlines, or pick from the vocabulary.');
    defineText('tagEditor.placeholder', '输入标签…', 'Enter a tag…');
    defineText('tagEditor.clearWarning', '这会移除 {n} 个会话上的全部标签。', 'This removes every tag from {n} sessions.');
    defineText('tagEditor.vocabulary', '标签词表', 'Tag vocabulary');
    defineText('tagEditor.empty', '还没有标签词表', 'No tag vocabulary yet');
    defineText('tagEditor.tagsLabel', '标签', 'Tags');

    defineText('toolbar.tagManager', '标签管理', 'Tags');
    defineText('tagManager.title', '标签管理', 'Tag manager');
    defineText('tagManager.subtitle', '标签词表是全局的：这里新建、改名、删除的词，会话、规则与右键菜单会一起更新。', 'The vocabulary is global: creating, renaming or deleting a word here updates sessions, rules and the context menu.');
    defineText('tagManager.new', '新建标签', 'New tag');
    defineText('tagManager.newPlaceholder', '标签名…', 'Tag name…');
    defineText('tagManager.create', '新建', 'Create');
    defineText('tagManager.empty', '还没有任何标签', 'No tags yet');
    defineText('tagManager.emptyHint', '新建一个标签，或在会话上打标签时自动进入词表。', 'Create one, or tag a session and it joins the vocabulary.');
    defineText('tagManager.usage', '{n} 个会话', '{n} sessions');
    defineText('tagManager.suggestedUsage', '{n} 条建议', '{n} suggestions');
    defineText('tagManager.source.manual', '手动', 'Manual');
    defineText('tagManager.source.rule', '规则', 'Rule');
    defineText('tagManager.source.ai', 'AI', 'AI');
    defineText('tagManager.rename', '改名', 'Rename');
    defineText('tagManager.renameTitle', '把「{tag}」改成', 'Rename "{tag}" to');
    defineText('tagManager.renameHint', '改名会同步到使用它的 {n} 个会话与 {rules} 条规则；若新名字已存在，两者合并。', 'Renaming updates {n} sessions and {rules} rules; an existing name is merged instead.');
    defineText('tagManager.remove', '删除', 'Delete');
    defineText('tagManager.removeTitle', '删除标签「{tag}」？', 'Delete the tag "{tag}"?');
    defineText('tagManager.removeHint', '会从 {n} 个会话和引用它的规则上移除；会话本身不受影响。', 'It is removed from {n} sessions and from the rules that use it; the sessions themselves stay.');
    defineText('tagManager.count', '{n} 个标签', '{n} tags');
    defineText('tagManager.created', '创建于', 'Created');
    defineText('tagManager.search', '搜索标签', 'Search tags');
    defineText('tagManager.mergeHint', '已有同名标签，保存后会合并为一个。', 'A tag with that name exists; saving merges them.');
    defineText('notice.tagCreated', '已新建标签「{tag}」', 'Created tag "{tag}"');
    defineText('notice.tagRenamed', '已改名为「{tag}」，同步 {n} 个会话', 'Renamed to "{tag}", {n} sessions updated');
    defineText('notice.tagRemoved', '已删除标签「{tag}」，同步 {n} 个会话', 'Deleted tag "{tag}", {n} sessions updated');

    defineText('note.title', '备注', 'Note');
    defineText('note.placeholder', '为这个会话写一段备注（参与搜索）', 'Write a note for this session (searchable)');
    defineText('note.save', '保存备注', 'Save note');

    defineText('renameOne.title', '重命名会话', 'Rename session');
    defineText('renameOne.titleLabel', '标题', 'Title');
    defineText('renameOne.lockHint', '手动改名会把标题锁定，AI 之后不再覆盖。', 'A manual rename locks the title; AI will not overwrite it.');

    defineText('delete.title', '删除 {n} 个会话？', 'Delete {n} sessions?');
    defineText('delete.body', '会话会被移入回收站而不是抹掉，可以随时恢复。', 'Sessions move to the trash instead of being erased and can be restored.');
    defineText('delete.confirm', '移入回收站', 'Move to trash');

    defineText('trash.title', '回收站', 'Trash');
    defineText('trash.empty', '回收站是空的', 'The trash is empty');
    defineText('trash.deletedAt', '删除于', 'Deleted');
    defineText('trash.origin', '原路径', 'Original path');
    defineText('trash.tombstone', '原始数据已不在磁盘上，恢复只会撤销删除记录', 'The original data is gone from disk; restoring only removes the delete record');
    defineText('trash.tombstoneBadge', '仅记录', 'Record only');
    defineText('trash.restore', '恢复 {n} 个', 'Restore {n}');
    defineText('trash.refresh', '刷新列表', 'Refresh list');

    defineText('rules.title', '标签规则', 'Tag rules');
    defineText('rules.subtitle', '规则只给建议或追加标签，从不删除已有标签。', 'Rules only suggest or append tags; they never delete existing ones.');
    defineText('rules.empty', '还没有规则', 'No rules yet');
    defineText('rules.new', '新建规则', 'New rule');
    defineText('rules.name', '规则名', 'Name');
    defineText('rules.namePlaceholder', '例如：华为项目', 'e.g. Huawei project');
    defineText('rules.enabled', '启用', 'Enabled');
    defineText('rules.keywords', '关键词', 'Keywords');
    defineText('rules.keywordsPlaceholder', '逗号分隔，大小写不敏感', 'Comma separated, case-insensitive');
    defineText('rules.fields', '匹配字段', 'Fields');
    defineText('rules.field.title', '标题', 'Title');
    defineText('rules.field.firstMessage', '首条消息', 'First message');
    defineText('rules.field.cwd', '工作目录', 'Working directory');
    defineText('rules.field.note', '备注', 'Note');
    defineText('rules.matchMode', '匹配方式', 'Match mode');
    defineText('rules.matchMode.any', '任一命中', 'Any');
    defineText('rules.matchMode.all', '全部命中', 'All');
    defineText('rules.actionMode', '动作', 'Action');
    defineText('rules.actionMode.suggest', '只给建议', 'Suggest only');
    defineText('rules.actionMode.apply', '直接加标签', 'Apply tags');
    defineText('rules.actionTags', '动作标签', 'Action tags');
    defineText('rules.preview', '命中预览', 'Preview matches');
    defineText('rules.previewScanned', '扫描了 {n} 个会话', 'Scanned {n} sessions');
    defineText('rules.previewEmpty', '没有命中', 'No matches');
    defineText('rules.apply', '应用规则', 'Apply rule');
    defineText('rules.save', '保存规则', 'Save rule');
    defineText('rules.cancelEdit', '取消编辑', 'Cancel edit');
    defineText('rules.deleteConfirm', '删除规则“{name}”？', 'Delete rule "{name}"?');
    defineText('rules.edit', '编辑', 'Edit');
    defineText('rules.delete', '删除', 'Delete');
    defineText('rules.hits', '命中 {n}', '{n} matches');
    defineText('rules.untitled', '未命名规则', 'Untitled rule');

    defineText('fill.title', 'AI 补齐缺失标签', 'AI fill missing tags');
    defineText('fill.subtitle', '只处理没有任何标签的会话，只写建议标签，不覆盖已有标签。', 'Only sessions with no tags get suggestions; existing tags are never overwritten.');
    defineText('fill.candidates', '可补齐 {n} 个会话', '{n} sessions can be filled');
    defineText('fill.none', '所有会话都已有标签', 'Every session already has tags');
    defineText('fill.apply', '写入建议', 'Write suggestions');
    defineText('fill.loading', '正在统计…', 'Counting…');

    defineText('time.now', '刚刚', 'just now');
    defineText('time.minute', '{n} 分钟前', '{n} min ago');
    defineText('time.hour', '{n} 小时前', '{n} h ago');
    defineText('time.day', '{n} 天前', '{n} d ago');
    defineText('time.month', '{n} 个月前', '{n} mo ago');
    defineText('time.year', '{n} 年前', '{n} y ago');
    defineText('time.unknown', '时间未知', 'Unknown time');

    defineText('common.loading', '加载中…', 'Loading…');
    defineText('common.refreshing', '正在刷新…', 'Refreshing…');
    defineText('common.none', '无', 'None');
    defineText('common.of', '{done}/{total}', '{done}/{total}');
    defineText('common.dismiss', '关闭提示', 'Dismiss');
    defineText('common.locked', '已锁定', 'Locked');
    defineText('common.archivedOnly', '仅归档', 'Archived only');

    defineText('notice.renamed', '已重命名 {n} 条会话', 'Renamed {n} sessions');
    defineText('notice.tagged', '已更新 {n} 条标签', 'Updated tags on {n} sessions');
    defineText('notice.archived', '已归档 {n} 条', 'Archived {n}');
    defineText('notice.unarchived', '已恢复 {n} 条', 'Unarchived {n}');
    defineText('notice.trashed', '已移入回收站 {n} 条', 'Moved {n} to trash');
    defineText('notice.restored', '已恢复 {n} 条', 'Restored {n}');
    defineText('notice.notes', '备注已保存', 'Note saved');
    defineText('notice.ruleSaved', '规则已保存', 'Rule saved');
    defineText('notice.ruleDeleted', '规则已删除', 'Rule deleted');
    defineText('notice.ruleApplied', '已建议 {suggested} 条，已加标签 {updated} 条', 'Suggested on {suggested}, tagged {updated}');
    defineText('notice.filled', '已写入 {n} 条建议', 'Wrote {n} suggestions');
    defineText('notice.failed', '操作失败：{message}', 'Failed: {message}');
    defineText('notice.refused', '部分操作被拒绝：{message}', 'Some operations were refused: {message}');
    defineText('notice.aiUnavailable', 'AI 不可用：{reason}', 'AI unavailable: {reason}');
    defineText('notice.previewEmpty', '没有可用的预览结果', 'No preview result');
    defineText('notice.selectedNone', '先勾选会话', 'Select sessions first');
    defineText('notice.partial', '已完成 {done} 条，失败 {failed} 条', 'Done {done}, failed {failed}');

    /* v0.2 — row selection, context menu, detail pane, jobs (PRD §7.1–§7.4) */
    defineText('row.detail', '详情', 'Details');
    defineText('row.more', '更多操作', 'More actions');
    defineText('menu.pin', '置顶会话', 'Pin session');
    defineText('menu.unpin', '取消置顶', 'Unpin session');
    defineText('menu.rename', '重命名', 'Rename');
    defineText('menu.fork', '分叉会话', 'Fork session');
    defineText('menu.copyId', '复制 Session ID', 'Copy Session ID');
    defineText('menu.reveal', '在文件夹显示', 'Reveal in folder');
    defineText('menu.archive', '归档会话', 'Archive session');
    defineText('menu.unarchive', '取消归档', 'Unarchive session');
    defineText('menu.detail', '查看详情', 'View details');
    defineText('menu.open', '打开会话', 'Open session');
    defineText('menu.restore', '恢复', 'Restore');
    defineText('menu.purge', '彻底删除', 'Delete permanently');
    defineText('menu.reason.noService', '当前客户端不支持这个操作', 'This client does not support this action');
    defineText('menu.reason.noClipboard', '浏览器不允许写剪贴板', 'The clipboard is unavailable');
    defineText('menu.reason.noRemote', '当前客户端无法打开文件夹', 'This client cannot reveal folders');
    defineText('menu.reason.noCwd', '这个会话没有工作目录', 'This session has no working directory');
    defineText('menu.reason.archived', '已归档的会话不能这样操作', 'Archived sessions cannot do this');
    defineText('menu.reason.blank', '空白会话不能这样操作', 'Blank sessions cannot do this');
    defineText('menu.reason.purgeUnsupported', 'DSH 没有彻底删除接口，请手工清理回收站目录', 'DSH has no permanent-delete API; clean the trash directory manually');
    /* v0.3 native integration: the session context-menu tag submenu. */
    defineText('menu.tags', '标签', 'Tags');
    defineText('menu.note', '备注', 'Note');
    defineText('menu.trash', '移入回收站', 'Move to trash');
    defineText('menu.tagsWith', '标签：{tags}', 'Tags: {tags}');
    defineText('menu.tagsNone', '标签：无', 'Tags: none');
    defineText('menu.tagsEmpty', '还没有标签（在会话管理面板里创建）', 'No tags yet (create them in Session Manager)');
    defineText('menu.tagAdded', '已添加标签 {tag}', 'Tag added: {tag}');
    defineText('menu.tagRemoved', '已移除标签 {tag}', 'Tag removed: {tag}');
    defineText('menu.tagFailed', '标签操作失败', 'Tag action failed');
    defineText('shortcut.rename', 'Ctrl+Alt+G', 'Ctrl+Alt+G');
    defineText('shortcut.fork', 'Ctrl+Shift+F', 'Ctrl+Shift+F');
    defineText('shortcut.archive', 'Ctrl+Alt+A', 'Ctrl+Alt+A');
    defineText('archiveConfirm.title', '停止并归档？', 'Stop and archive?');
    defineText('archiveConfirm.body', '“{title}”仍在运行。归档会先停止它的工作，已产生的输出保留。', '"{title}" is still running. Archiving stops its work; existing output is kept.');
    defineText('archiveConfirm.confirm', '停止并归档', 'Stop and archive');
    defineText('notice.pinned', '已置顶会话', 'Session pinned');
    defineText('notice.unpinned', '已取消置顶', 'Session unpinned');
    defineText('notice.forked', '已创建分叉会话', 'Fork created');
    defineText('notice.copiedId', '已复制 Session ID', 'Session ID copied');
    defineText('detail.title', '会话详情', 'Session details');
    defineText('detail.close', '关闭详情', 'Close details');
    defineText('detail.loading', '正在读取会话详情…', 'Loading session details…');
    defineText('detail.stale', '这个会话已被归档或移入回收站，详情不再可用。', 'This session was archived or moved to the trash; its details are no longer available.');
    defineText('detail.status', '状态', 'Status');
    defineText('detail.cwd', '工作目录', 'Working directory');
    defineText('detail.updatedAt', '更新时间', 'Updated');
    defineText('detail.createdAt', '创建时间', 'Created');
    defineText('detail.tags', '标签', 'Tags');
    defineText('detail.intent', '意图', 'Intent');
    defineText('detail.note', '备注', 'Note');
    defineText('detail.firstMessage', '首条消息', 'First message');
    defineText('detail.lastTurnEnd', '最近一轮结束原因', 'Last turn ended');
    defineText('detail.sessionId', 'Session ID', 'Session ID');
    defineText('detail.open', '打开会话', 'Open session');
    defineText('detail.fork', '分叉会话', 'Fork session');
    defineText('detail.archive', '归档', 'Archive');
    defineText('detail.unarchive', '取消归档', 'Unarchive');
    defineText('detail.trash', '移入回收站', 'Move to trash');
    defineText('detail.copyId', '复制', 'Copy');
    defineText('detail.addTag', '添加标签…', 'Add a tag…');
    defineText('detail.saveNote', '保存备注', 'Save note');
    defineText('detail.noFirstMessage', '没有可读的首条消息', 'No readable first message');
    defineText('detail.noNote', '没有备注', 'No note');
    defineText('detail.noTags', '没有标签', 'No tags');
    defineText('detail.renameHint', '就地重命名会把标题锁定。', 'Renaming here locks the title.');
    defineText('detail.saved', '已保存', 'Saved');
    defineText('detail.missingTitle', '（无标题）', '(untitled)');
    defineText('detail.archiveHint', '归档后会话仍可恢复。', 'Archived sessions can be restored.');
    defineText('turnEnd.completed', '已完成', 'Completed');
    defineText('turnEnd.aborted', '已中止', 'Aborted');
    defineText('turnEnd.blocked', '阻塞', 'Blocked');
    defineText('turnEnd.error', '失败', 'Failed');
    defineText('turnEnd.max-tokens', '超出令牌上限', 'Hit the token limit');
    defineText('turnEnd.interrupted', '被中断', 'Interrupted');
    defineText('turnEnd.forked', '已分叉', 'Forked');
    defineText('turnEnd.none', '无记录', 'None');
    defineText('job.title', '任务', 'Tasks');
    defineText('job.empty', '还没有后台任务', 'No background tasks yet');
    defineText('job.unavailable', '任务不可用', 'Tasks unavailable');
    defineText('job.unavailableHint', '宿主未启用任务', 'This host has no task runner');
    defineText('job.activeCount', '{n} 个进行中', '{n} running');
    defineText('job.indicatorActiveTitle', '{n} 个后台任务正在运行', '{n} background task(s) running');
    defineText('job.cancel', '取消', 'Cancel');
    defineText('job.cancelHint', '正在进行的单条请求会完成；已应用的条目不会撤回。', 'The running item finishes; already-applied items are not reverted.');
    defineText('job.expand', '明细', 'Details');
    defineText('job.collapse', '收起', 'Collapse');
    defineText('job.progressLine', '进度 {done}/{total}（{percent}%）', 'Progress {done}/{total} ({percent}%)');
    defineText('job.summary', '成功 {done} / 失败 {failed} / 跳过 {skipped}', 'Done {done} / failed {failed} / skipped {skipped}');
    defineText('job.cancelledHint', '任务已取消；已应用的条目不会撤回', 'Task cancelled; applied items are not reverted');
    defineText('job.interruptedHint', '宿主重启导致任务中断，不会自动重跑', 'The host restarted, so the task was interrupted and will not rerun');
    defineText('job.itemsTruncated', '只保留最近 200 条明细', 'Only the latest 200 items are kept');
    defineText('job.noItems', '没有逐条明细', 'No per-item details');
    defineText('job.state.queued', '排队中', 'Queued');
    defineText('job.state.running', '进行中', 'Running');
    defineText('job.state.succeeded', '成功', 'Succeeded');
    defineText('job.state.failed', '失败', 'Failed');
    defineText('job.state.cancelled', '已取消', 'Cancelled');
    defineText('job.state.interrupted', '已中断', 'Interrupted');
    defineText('job.type.ai.rename', 'AI 重命名预览', 'AI rename preview');
    defineText('job.type.rename.apply', '应用重命名', 'Apply rename');
    defineText('job.type.ai.tags', 'AI 标签/意图预览', 'AI tag preview');
    defineText('job.type.tags.fillMissing', '补齐缺失标签', 'Fill missing tags');
    defineText('job.type.other', '后台任务', 'Background task');
    defineText('notice.jobStarted', '已创建任务：{name}', 'Task created: {name}');
    defineText('notice.jobFailed', '任务失败：{message}', 'Task failed: {message}');
    defineText('notice.jobCancelled', '任务已取消', 'Task cancelled');
    defineText('notice.jobInterrupted', '任务被宿主重启中断', 'The task was interrupted by a host restart');


    /* ------------------------------------------------------------------ *
     * Translation
     * ------------------------------------------------------------------ */

    var active = { zh: false };

    function format(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, key) {
        return params[key] === undefined || params[key] === null ? match : String(params[key]);
      });
    }

    function t(key, params) {
      var pair = TEXT[key];
      var value = pair ? (active.zh ? pair[0] : pair[1]) : key;
      return format(value, params);
    }

    function tf(key, params) {
      return t(key, params);
    }

    /** Picks the active language from the host locale service, then the browser. */
    function setActiveLanguage(ctx) {
      active.zh = detectChinese(ctx);
    }

    function detectChinese(ctx) {
      var id = null;
      try {
        var locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        if (locale) {
          if (typeof locale.getLocale === 'function') id = locale.getLocale();
          else if (typeof locale.getSnapshot === 'function') id = locale.getSnapshot();
          if (id && typeof id === 'object') id = id.id || id.locale || id.language || null;
        }
      } catch (error) {
        id = null;
      }
      if (typeof id !== 'string') {
        try {
          if (typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string') id = navigator.language;
        } catch (error) {
          id = null;
        }
      }
      return typeof id === 'string' && /^zh/i.test(id);
    }

    function useLocaleSync(ctx) {
      var state = useState(0);
      var force = state[1];
      useEffect(function () {
        setActiveLanguage(ctx);
        force(function (value) { return value + 1; });
        var locale = null;
        try {
          locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
        } catch (error) {
          locale = null;
        }
        if (!locale) return undefined;
        var bump = function () {
          setActiveLanguage(ctx);
          force(function (value) { return value + 1; });
        };
        var dispose = null;
        if (typeof locale.subscribe === 'function') dispose = locale.subscribe(bump);
        else if (typeof locale.onChange === 'function') dispose = locale.onChange(bump);
        return function () {
          if (typeof dispose === 'function') dispose();
        };
      }, [ctx]);
    }

    /* ------------------------------------------------------------------ *
     * HTTP — same-origin JSON only.
     * ------------------------------------------------------------------ */

    function ApiError(code, message, status) {
      this.name = 'ApiError';
      this.code = code;
      this.message = message;
      this.status = status;
    }
    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    function request(path, options) {
      var init = options || {};
      var headers = { accept: 'application/json' };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      var merged = {
        method: init.method || 'GET',
        headers: headers,
        cache: 'no-store'
      };
      if (init.body !== undefined) merged.body = init.body;
      return fetch(API_PREFIX + path, merged).then(function (response) {
        return response.text().then(function (text) {
          var body = null;
          if (text) {
            try { body = JSON.parse(text); } catch (error) { body = null; }
          }
          if (!response.ok) {
            var detail = body && body.error ? body.error : {};
            throw new ApiError(detail.code || 'http_' + response.status, detail.message || response.statusText || 'HTTP ' + response.status, response.status);
          }
          return body || {};
        });
      }, function (error) {
        throw new ApiError('network', error && error.message ? error.message : String(error), 0);
      });
    }

    function postJson(path, payload) {
      return request(path, { method: 'POST', body: JSON.stringify(payload || {}) });
    }


    /* ------------------------------------------------------------------ *
     * Live status: slot props when available, host rows otherwise.
     * ------------------------------------------------------------------ */

    function identitySelector(value) { return value; }
    function useNoopSelector() { return null; }

    function useLiveSnapshot(props) {
      var useStatus = props && typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoopSelector;
      var useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : useNoopSelector;
      var statusMap = useStatus(identitySelector);
      var sessionsState = useSessions(identitySelector);
      return { statusMap: statusMap || null, sessionsState: sessionsState || null };
    }

    /* ------------------------------------------------------------------ *
     * Small presentational atoms
     * ------------------------------------------------------------------ */

    function cx() {
      var out = [];
      for (var index = 0; index < arguments.length; index += 1) {
        var value = arguments[index];
        if (value) out.push(value);
      }
      return out.join(' ');
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        className: cx('sm-btn', props.variant ? 'sm-btn-' + props.variant : '', props.className),
        disabled: Boolean(props.disabled),
        title: props.title,
        onClick: props.disabled ? undefined : props.onClick
      }, props.children);
    }

    function StatusDot(props) {
      return h('span', {
        className: 'sm-dot sm-dot-' + props.status,
        title: t('status.' + props.status),
        'aria-label': t('status.' + props.status)
      });
    }

    function Chip(props) {
      return h('span', {
        className: cx('sm-chip', props.muted && 'sm-chip-muted', props.removable && 'sm-chip-removable'),
        title: props.title || props.label
      }, [
        h('span', { key: 'label', className: 'sm-chip-label' }, props.label),
        props.removable ? h('button', {
          key: 'x',
          type: 'button',
          className: 'sm-chip-x',
          title: t('action.clear'),
          onClick: function (event) { event.stopPropagation(); if (props.onRemove) props.onRemove(); }
        }, '×') : null
      ]);
    }

    function Notice(props) {
      if (!props.notice) return null;
      return h('div', { className: 'sm-notice sm-notice-' + (props.notice.kind || 'info'), role: 'status' }, [
        h('span', { key: 'text', className: 'sm-notice-text' }, props.notice.text),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'sm-icon-btn',
          title: t('common.dismiss'),
          onClick: function () { if (props.onClose) props.onClose(); }
        }, '×')
      ]);
    }

    function DialogShell(props) {
      useEffect(function () {
        function onKey(event) {
          if (event.key === 'Escape' && props.onClose && !props.busy) props.onClose();
        }
        if (typeof document !== 'undefined') document.addEventListener('keydown', onKey);
        return function () {
          if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
        };
      }, [props.onClose, props.busy]);
      return h('div', {
        className: 'sm-overlay',
        role: 'presentation',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && props.onClose && !props.busy) props.onClose();
        }
      }, [
        h('div', {
          key: 'dialog',
          className: cx('sm-dialog', props.wide && 'sm-dialog-wide'),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title
        }, [
          h('div', { key: 'head', className: 'sm-dialog-head' }, [
            h('div', { key: 'titles', className: 'sm-dialog-titles' }, [
              h('h2', { key: 'title', className: 'sm-dialog-title' }, props.title),
              props.subtitle ? h('p', { key: 'sub', className: 'sm-dialog-sub' }, props.subtitle) : null
            ]),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'sm-icon-btn sm-dialog-close',
              title: t('action.close'),
              disabled: Boolean(props.busy),
              onClick: function () { if (props.onClose && !props.busy) props.onClose(); }
            }, '×')
          ]),
          h('div', { key: 'body', className: 'sm-dialog-body' }, props.children),
          props.footer ? h('div', { key: 'foot', className: 'sm-dialog-foot' }, props.footer) : null
        ])
      ]);
    }

    function EmptyState(props) {
      return h('div', { className: 'sm-empty' }, [
        h('span', { key: 'icon', className: 'sm-empty-icon', 'aria-hidden': 'true' }, props.icon || '○'),
        h('h3', { key: 'title', className: 'sm-empty-title' }, props.title),
        props.body ? h('p', { key: 'body', className: 'sm-empty-body' }, props.body) : null,
        props.action ? h('div', { key: 'action', className: 'sm-empty-action' }, props.action) : null
      ]);
    }

    function relativeLabel(timestamp) {
      var value = relativeTime(timestamp);
      if (value.unit === 'unknown') return t('time.unknown');
      if (value.unit === 'now') return t('time.now');
      return tf('time.' + value.unit, { n: value.value });
    }

    function groupLabel(group) {
      return group.labelKey ? t(group.labelKey) : group.label;
    }

    function statusLabel(status) {
      return t('status.' + status);
    }

    function skipLabel(reason) {
      return TEXT['skip.' + reason] ? t('skip.' + reason) : reason;
    }

    /* ------------------------------------------------------------------ *
     * Row
     * ------------------------------------------------------------------ */

    /** True when a click landed on a control inside the row, not on the row body. */
    function rowIsControl(target) {
      if (!target) return false;
      var tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
      return tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'LABEL';
    }

    function Row(props) {
      var row = props.row;
      var selected = props.selected;
      var active = Boolean(props.active);
      var disabled = !isBatchable(row);
      var title = row.title || t('row.noTitle');
      var cwd = row.workspaceTitle || basename(row.cwd);
      var tags = row.tags || [];
      var suggested = row.suggestedTags || [];
      var menuItems = [
        { id: 'rename', label: t('row.rename') },
        { id: 'tags', label: t('row.tags') },
        { id: 'note', label: t('row.note') },
        { id: row.archived ? 'unarchive' : 'archive', label: row.archived ? t('row.unarchive') : t('row.archive') },
        { id: 'trash', label: t('row.trash'), danger: true }
      ];
      return h('div', {
        className: cx('sm-row', selected && 'sm-row-selected', active && 'sm-row-active', row.archived && 'sm-row-archived'),
        'data-session-id': row.id,
        tabIndex: -1,
        onClick: function (event) {
          if (rowIsControl(event && event.target)) return;
          if (props.onActivate) props.onActivate(row.id);
        },
        onDoubleClick: function (event) {
          if (rowIsControl(event && event.target)) return;
          if (props.onOpenSession) props.onOpenSession(row);
        },
        onContextMenu: function (event) {
          if (props.onContextMenu) {
            event.preventDefault();
            props.onContextMenu(row, event);
          }
        }
      }, [
        h('input', {
          key: 'check',
          type: 'checkbox',
          className: 'sm-check',
          checked: selected,
          disabled: disabled,
          'aria-label': title,
          title: disabled ? t('batch.skipHint') : title,
          onChange: function () { if (props.onSelect) props.onSelect(row.id); }
        }),
        h('span', { key: 'dot', className: 'sm-row-dot' }, h(StatusDot, { status: row.status })),
        h('div', { key: 'main', className: 'sm-row-main' }, [
          h('div', { key: 'top', className: 'sm-row-top' }, [
            h('span', { key: 'title', className: 'sm-row-title', title: title }, title),
            row.titleLocked ? h('span', { key: 'lock', className: 'sm-badge', title: t('row.locked') }, t('common.locked')) : null,
            row.archived ? h('span', { key: 'arch', className: 'sm-badge' }, t('row.archived')) : null,
            row.pinned ? h('span', { key: 'pin', className: 'sm-badge' }, t('row.pinned')) : null,
            row.subagent ? h('span', { key: 'sub', className: 'sm-badge' }, t('row.subagent')) : null
          ]),
          (cwd || row.note || row.intent) ? h('div', { key: 'sub', className: 'sm-row-sub' }, [
            cwd ? h('span', { key: 'cwd', className: 'sm-row-ws', title: row.cwd || cwd }, cwd) : null,
            row.note ? h('span', { key: 'note', className: 'sm-row-note', title: row.note }, t('row.note.present')) : null,
            row.intent ? h('span', { key: 'intent', className: 'sm-row-intent' }, row.intent) : null
          ]) : null,
          (tags.length > 0 || suggested.length > 0) ? h('div', { key: 'tags', className: 'sm-row-tags' },
            tags.map(function (tag) {
              return h(Chip, { key: 'tag:' + tag, label: tag });
            }).concat(suggested.map(function (tag) {
              return h(Chip, { key: 'suggested:' + tag, label: tag, muted: true, title: t('chip.suggested') });
            }))) : null
        ]),
        h('span', {
          key: 'time',
          className: 'sm-row-time',
          title: row.updatedAt ? new Date(row.updatedAt).toLocaleString() : ''
        }, relativeLabel(row.updatedAt)),
        h('div', { key: 'actions', className: 'sm-row-actions' }, [
          h('button', {
            key: 'detail',
            type: 'button',
            className: 'sm-icon-btn sm-row-detail-btn',
            title: t('row.detail'),
            onClick: function (event) {
              event.stopPropagation();
              if (props.onOpenDetail) props.onOpenDetail(row);
            }
          }, t('row.detail')),
          h('button', {
            key: 'more',
            type: 'button',
            className: 'sm-icon-btn sm-row-more-btn',
            title: t('row.more'),
            'aria-label': t('row.more'),
            onClick: function (event) {
              event.stopPropagation();
              if (props.onPluginMenu) props.onPluginMenu(row, event);
            }
          }, '⋯'),
          /* v0.1 controlled inline menu: the page now opens the self-drawn
             context menu (PRD §7.2); this path stays for embedders/tests. */
          props.menuOpen ? h('div', {
            key: 'items',
            className: 'sm-menu sm-menu-inline',
            role: 'menu',
            onClick: function (event) { event.stopPropagation(); }
          }, menuItems.map(function (item) {
            return h('button', {
              key: item.id,
              type: 'button',
              role: 'menuitem',
              className: cx('sm-menu-item', item.danger && 'sm-menu-item-danger'),
              onClick: function () {
                if (props.onMenu) props.onMenu(null);
                if (props.onAction) props.onAction(item.id, row);
              }
            }, item.label);
          })) : null
        ])
      ]);
    }

    /* ------------------------------------------------------------------ *
     * v0.2 UI — self-drawn row menu, task indicator/list, detail pane.
     * ------------------------------------------------------------------ */

    function menuItemTitle(item) {
      var label = t(item.labelKey);
      return item.enabled ? label : label + ' — ' + t(item.reasonKey || 'menu.reason.noService');
    }

    /**
     * The self-drawn row context menu (PRD §7.2 / D7). Absolute positioning with
     * viewport flipping; arrow keys/Enter/Esc; disabled entries explain why.
     */
    function RowMenu(props) {
      var items = Array.isArray(props.items) ? props.items : [];
      var state = useState(function () { return firstEnabledIndex(items); });
      var activeIndex = state[0];
      var setActiveIndex = state[1];
      var listRef = useRef(null);
      var anchor = props.anchor || { x: 0, y: 0 };
      var placement = menuPlacement(anchor, props.viewport || null, {
        width: props.width || 216,
        height: Math.max(40, items.length * 32 + 8)
      });

      function focusIndex(index) {
        try {
          var node = listRef.current;
          if (node && typeof node.querySelector === 'function') {
            var target = node.querySelector('[data-menu-index="' + index + '"]');
            if (target && typeof target.focus === 'function') target.focus();
          }
        } catch (error) { /* focus is best effort */ }
      }

      useEffect(function () {
        focusIndex(activeIndex);
        return undefined;
      }, []);

      function activate(index) {
        var item = items[index];
        if (!item || !item.enabled) return;
        if (props.onPick) props.onPick(item.id, item);
      }

      function onKeyDown(event) {
        var action = menuKeyAction(items, activeIndex, event && event.key);
        if (action.kind === 'close') {
          event.preventDefault();
          event.stopPropagation();
          if (props.onClose) props.onClose();
          return;
        }
        if (action.kind === 'move') {
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex(action.index);
          focusIndex(action.index);
          return;
        }
        if (action.kind === 'activate') {
          event.preventDefault();
          event.stopPropagation();
          activate(action.index);
        }
      }

      return h('div', {
        className: 'sm-menu sm-row-menu',
        role: 'menu',
        'aria-label': t('row.menu'),
        ref: listRef,
        tabIndex: -1,
        style: { left: placement.left + 'px', top: placement.top + 'px' },
        onKeyDown: onKeyDown,
        onClick: function (event) { event.stopPropagation(); },
        onContextMenu: function (event) { event.preventDefault(); }
      }, items.map(function (item, index) {
        return h('button', {
          key: item.id,
          type: 'button',
          role: 'menuitem',
          'data-menu-index': index,
          'aria-disabled': item.enabled ? 'false' : 'true',
          disabled: !item.enabled,
          className: cx(
            'sm-menu-item',
            'sm-menu-item-entry',
            index === activeIndex && item.enabled && 'sm-menu-item-active',
            !item.enabled && 'sm-menu-item-disabled',
            item.danger && 'sm-menu-item-danger'
          ),
          title: menuItemTitle(item),
          onMouseEnter: function () { if (item.enabled) setActiveIndex(index); },
          onClick: function () { activate(index); }
        }, [
          h('span', { key: 'label', className: 'sm-menu-label' }, t(item.labelKey)),
          !item.enabled ? h('span', { key: 'reason', className: 'sm-menu-reason' }, t(item.reasonKey || 'menu.reason.noService')) : null,
          item.shortcut ? h('span', { key: 'shortcut', className: 'sm-menu-shortcut' }, item.shortcut) : null
        ]);
      }));
    }

    function ArchiveConfirmDialog(props) {
      var row = props.row || {};
      return h(DialogShell, {
        title: t('archiveConfirm.title'),
        busy: props.busy,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
          h(Btn, { key: 'confirm', variant: 'danger', disabled: props.busy, onClick: props.onConfirm }, t('archiveConfirm.confirm'))
        ]
      }, h('p', { key: 'body', className: 'sm-dialog-warning' }, tf('archiveConfirm.body', { title: row.title || row.id || '' })));
    }

    /* ------------------------------ tasks ------------------------------ */

    function jobTypeLabel(type) {
      return TEXT['job.type.' + type] ? t('job.type.' + type) : t('job.type.other');
    }

    function jobStateLabel(state) {
      return TEXT['job.state.' + state] ? t('job.state.' + state) : state;
    }

    function jobSummaryText(job) {
      if (job.active) return tf('job.progressLine', { done: job.done, total: job.total, percent: job.percent });
      if (job.state === 'cancelled') return t('job.cancelledHint');
      if (job.state === 'interrupted') return t('job.interruptedHint');
      return tf('job.summary', { done: job.done, failed: job.failed, skipped: job.skipped });
    }

    /** Toolbar task indicator (PRD §7.4): spinner+progress while busy, result dot when idle. */
    function JobsIndicator(props) {
      var active = Array.isArray(props.activeJobs) ? props.activeJobs : [];
      var latest = props.latest || null;
      if (props.unavailable) {
        // Old host without host/jobs.js: a disabled parked trigger, never an error loop.
        return h('button', {
          type: 'button',
          className: 'sm-jobs-trigger sm-jobs-trigger-disabled',
          title: t('job.unavailableHint'),
          disabled: true
        }, [
          h('span', { key: 'dot', className: 'sm-job-dot sm-job-dot-idle' }),
          h('span', { key: 'label', className: 'sm-jobs-label' }, t('job.unavailable'))
        ]);
      }
      if (active.length > 0) {
        var running = active[0];
        return h('button', {
          type: 'button',
          className: 'sm-jobs-trigger sm-jobs-trigger-active',
          title: tf('job.indicatorActiveTitle', { n: active.length }),
          'aria-expanded': props.open ? 'true' : 'false',
          onClick: props.onToggle
        }, [
          h('span', { key: 'spinner', className: 'sm-spinner', 'aria-hidden': 'true' }),
          h('span', { key: 'label', className: 'sm-jobs-label' }, t('job.title')),
          h('span', { key: 'count', className: 'sm-jobs-count' }, String(active.length)),
          h('span', { key: 'progress', className: 'sm-jobs-progress-text' }, tf('common.of', { done: running.done, total: running.total }))
        ]);
      }
      return h('button', {
        type: 'button',
        className: 'sm-jobs-trigger',
        title: latest ? jobStateLabel(latest.state) : t('job.empty'),
        'aria-expanded': props.open ? 'true' : 'false',
        onClick: props.onToggle
      }, [
        h('span', { key: 'dot', className: cx('sm-job-dot', latest ? 'sm-job-dot-' + latest.state : 'sm-job-dot-idle') }),
        h('span', { key: 'label', className: 'sm-jobs-label' }, t('job.title')),
        latest ? h('span', { key: 'state', className: 'sm-jobs-state' }, jobStateLabel(latest.state)) : null
      ]);
    }

    function JobDetailList(props) {
      var job = props.job;
      var items = Array.isArray(props.items) ? props.items : job.items;
      var rows = [];
      if (job.errorText) rows.push(h('p', { key: 'error', className: 'sm-status-text sm-status-error' }, job.errorText));
      if (job.state === 'cancelled') rows.push(h('p', { key: 'cancel', className: 'sm-hint' }, t('job.cancelHint')));
      if (job.state === 'interrupted') rows.push(h('p', { key: 'interrupted', className: 'sm-hint' }, t('job.interruptedHint')));
      if (items.length === 0) {
        rows.push(h('p', { key: 'none', className: 'sm-hint' }, t('job.noItems')));
      } else {
        rows.push(h('ul', { key: 'items', className: 'sm-job-items' }, items.map(function (item, index) {
          var key = item && typeof item.key === 'string' ? item.key : String(index);
          var itemState = item && typeof item.state === 'string' ? item.state : 'done';
          return h('li', { key: key + ':' + index, className: 'sm-job-item sm-job-item-' + itemState }, [
            h('span', { key: 'key', className: 'sm-job-item-key', title: key }, key),
            h('span', { key: 'state', className: 'sm-job-item-state' }, itemState),
            item && item.message ? h('span', { key: 'message', className: 'sm-hint' }, item.message) : null
          ]);
        })));
        if (job.itemsTruncated) rows.push(h('p', { key: 'truncated', className: 'sm-hint' }, t('job.itemsTruncated')));
      }
      return h('div', { className: 'sm-job-detail' }, rows);
    }

    function JobRow(props) {
      var job = props.job;
      var expanded = Boolean(props.expanded);
      var canExpand = !job.active && (job.failed > 0 || Boolean(job.errorText) || job.items.length > 0 || job.state === 'cancelled' || job.state === 'interrupted');
      return h('div', { className: cx('sm-job', 'sm-job-' + job.state) }, [
        h('div', { key: 'row', className: 'sm-job-row' }, [
          h('span', { key: 'dot', className: cx('sm-job-dot', 'sm-job-dot-' + job.state), 'aria-hidden': 'true' }),
          h('div', { key: 'main', className: 'sm-job-main' }, [
            h('div', { key: 'top', className: 'sm-job-top' }, [
              h('span', { key: 'type', className: 'sm-job-type' }, jobTypeLabel(job.type)),
              h('span', { key: 'state', className: 'sm-job-state' }, jobStateLabel(job.state)),
              h('span', {
                key: 'time',
                className: 'sm-hint sm-job-time',
                title: job.createdAt ? new Date(job.createdAt).toLocaleString() : ''
              }, relativeLabel(job.createdAt))
            ]),
            job.active ? h('div', { key: 'bar', className: 'sm-bar', role: 'progressbar', 'aria-valuenow': job.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [
              h('span', { key: 'fill', className: 'sm-bar-fill', style: { width: job.percent + '%' } })
            ]) : null,
            h('p', { key: 'summary', className: 'sm-hint' }, jobSummaryText(job)),
            job.active ? h('p', { key: 'cancel-hint', className: 'sm-hint' }, t('job.cancelHint')) : null
          ]),
          job.active ? h(Btn, {
            key: 'cancel',
            variant: 'danger',
            disabled: Boolean(props.cancelling),
            onClick: function () { if (props.onCancel) props.onCancel(job.id); }
          }, t('job.cancel')) : null,
          canExpand ? h(Btn, {
            key: 'expand',
            disabled: Boolean(props.loading),
            onClick: function () { if (props.onToggle) props.onToggle(job.id); }
          }, expanded ? t('job.collapse') : t('job.expand')) : null
        ]),
        expanded ? h(JobDetailList, { key: 'detail', job: job, items: props.items }) : null
      ]);
    }

    function JobsPanel(props) {
      var jobs = Array.isArray(props.jobs) ? props.jobs : [];
      var active = jobs.filter(isActiveJob);
      var finished = jobs.filter(function (job) { return !isActiveJob(job); }).slice(0, 20);
      var rows = [];
      if (jobs.length === 0) {
        rows.push(h('p', { key: 'empty', className: 'sm-hint' }, t('job.empty')));
      }
      if (active.length > 0) {
        rows.push(h('div', { key: 'active-head', className: 'sm-jobs-subhead' }, tf('job.activeCount', { n: active.length })));
        rows.push(h('div', { key: 'active', className: 'sm-jobs-list' }, active.map(function (job) {
          return h(JobRow, {
            key: job.id,
            job: job,
            expanded: props.expandedId === job.id,
            items: props.itemsById ? props.itemsById[job.id] : null,
            loading: props.loadingId === job.id,
            cancelling: props.cancellingIds && props.cancellingIds.indexOf(job.id) >= 0,
            onCancel: props.onCancel,
            onToggle: props.onToggle
          });
        })));
      }
      if (finished.length > 0) {
        rows.push(h('div', { key: 'done', className: 'sm-jobs-list' }, finished.map(function (job) {
          return h(JobRow, {
            key: job.id,
            job: job,
            expanded: props.expandedId === job.id,
            items: props.itemsById ? props.itemsById[job.id] : null,
            loading: props.loadingId === job.id,
            cancelling: false,
            onCancel: props.onCancel,
            onToggle: props.onToggle
          });
        })));
      }
      return h('div', { className: 'sm-jobs-panel', role: 'dialog', 'aria-label': t('job.title') }, [
        h('div', { key: 'head', className: 'sm-jobs-head' }, [
          h('span', { key: 'title', className: 'sm-jobs-title' }, t('job.title')),
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h('span', { key: 'hint', className: 'sm-hint' }, t('job.cancelHint'))
        ]),
        rows
      ]);
    }

    /* ------------------------------ detail ------------------------------ */

    /** Skeleton first paint: grey rows instead of a blank panel (v0.2 fix). */
    function SkeletonList(props) {
      var count = typeof props.count === 'number' ? props.count : 8;
      var rows = [];
      for (var index = 0; index < count; index += 1) {
        rows.push(h('div', { key: 'sk' + index, className: 'sm-skeleton-row', 'aria-hidden': 'true' }, [
          h('span', { key: 'dot', className: 'sm-skeleton sm-skeleton-dot' }),
          h('span', { key: 'main', className: 'sm-skeleton-main' }, [
            h('span', { key: 'title', className: 'sm-skeleton sm-skeleton-title' }),
            h('span', { key: 'sub', className: 'sm-skeleton sm-skeleton-sub' })
          ]),
          h('span', { key: 'time', className: 'sm-skeleton sm-skeleton-time' })
        ]));
      }
      return h('div', {
        className: 'sm-skeleton-list',
        'aria-busy': 'true',
        'aria-label': t('common.loading')
      }, [props.hint ? h('p', { key: 'hint', className: 'sm-skeleton-hint' }, props.hint) : null].concat(rows));
    }

    /**
     * The in-panel detail split (PRD §7.3, v0.2 fix). The plugin panel is itself
     * the mounted session surface here, so the details column lives inside it
     * instead of asking the right sidebar (which has no surface while this panel
     * owns the main column). Controlled by sessionId; closes through onClose;
     * every successful action calls onChanged for a silent refresh.
     */
    function DetailPane(props) {
      var sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null;
      var initialRow = props.row || rowFromCache(sessionId) || null;
      var rowState = useState(initialRow);
      var row = rowState[0];
      var setRow = rowState[1];
      var valueState = useState(props.value || null);
      var value = valueState[0];
      var setValue = valueState[1];
      var phaseState = useState(initialRow ? 'ready' : 'loading');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var tickState = useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var feedbackState = useState(null);
      var feedback = feedbackState[0];
      var setFeedback = feedbackState[1];
      var titleEditState = useState(null);
      var titleDraft = titleEditState[0];
      var setTitleDraft = titleEditState[1];
      var noteState = useState(initialRow && typeof initialRow.note === 'string' ? initialRow.note : '');
      var noteDraft = noteState[0];
      var setNoteDraft = noteState[1];
      var tagState = useState('');
      var tagDraft = tagState[0];
      var setTagDraft = tagState[1];
      var confirmState = useState(false);
      var confirmTrash = confirmState[0];
      var setConfirmTrash = confirmState[1];

      useEffect(function () {
        if (!sessionId) { setPhase('missing'); return undefined; }
        var alive = true;
        var cached = rowFromCache(sessionId);
        if (cached) { setRow(cached); setPhase('ready'); }
        request(sessionValuePath(sessionId)).then(function (body) {
          if (!alive) return;
          setValue(body || null);
          setRow(mergeDetailRow(rowFromCache(sessionId) || cached, body || {}, sessionId));
          setPhase('ready');
        }, function (cause) {
          if (!alive) return;
          if (cause && (cause.status === 404 || cause.code === 'not_found')) { setPhase('missing'); return; }
          setError(cause && cause.message ? cause.message : String(cause));
          setPhase(cached ? 'ready' : 'error');
        });
        return function () { alive = false; };
      }, [sessionId, tick]);

      /* A different row starts clean: no feedback, editor or confirm from the last one. */
      useEffect(function () {
        setFeedback(null);
        setError(null);
        setTitleDraft(null);
        setConfirmTrash(false);
      }, [sessionId]);

      /* The list owns the row; a refresh replaces it without losing inline edits. */
      useEffect(function () {
        if (props.row) setRow(props.row);
      }, [props.row]);

      var rowNote = row && typeof row.note === 'string' ? row.note : '';
      useEffect(function () { setNoteDraft(rowNote); }, [rowNote]);

      function report(cause) {
        setBusy(false);
        setFeedback({ kind: 'error', text: cause && cause.message ? cause.message : String(cause) });
      }
      function announce(key, params) {
        setBusy(false);
        setFeedback({ kind: 'info', text: tf(key, params) });
      }
      function reload() {
        setTick(function (current) { return current + 1; });
        if (props.onChanged) props.onChanged();
      }
      function saveTitle() {
        var title = typeof titleDraft === 'string' ? titleDraft.trim() : '';
        if (!sessionId || title === '') return;
        setBusy(true);
        postJson(API_PATHS.rename, { sessionId: sessionId, title: title }).then(function () {
          setTitleDraft(null);
          announce('detail.saved');
          reload();
        }, report);
      }
      function saveNote() {
        if (!sessionId) return;
        setBusy(true);
        postJson(API_PATHS.notes, { sessionId: sessionId, note: noteDraft }).then(function () {
          announce('detail.saved');
          reload();
        }, report);
      }
      function commitTags(next) {
        if (!sessionId) return;
        setBusy(true);
        postJson(API_PATHS.tags, { sessionIds: [sessionId], op: 'replace', tags: next }).then(function () {
          setTagDraft('');
          announce('detail.saved');
          reload();
        }, report);
      }
      function addTag() {
        var raw = typeof tagDraft === 'string' ? tagDraft.trim() : '';
        if (raw === '') return;
        commitTags(mergeTagList(row && row.tags ? row.tags : [], raw));
      }
      function workspaceAction(method, extraArgs) {
        var workspace = optionalService(pageCtx, 'uiWorkspace');
        if (!sessionId) return;
        if (!hasMethod(workspace, method)) {
          setFeedback({ kind: 'error', text: t('menu.reason.noService') });
          return;
        }
        setBusy(true);
        try {
          var args = [sessionId].concat(Array.isArray(extraArgs) ? extraArgs : []);
          Promise.resolve(workspace[method].apply(workspace, args)).then(function () {
            setBusy(false);
            reload();
          }, report);
        } catch (cause) {
          report(cause);
        }
      }
      function archiveDetail() {
        if (!row) return;
        if (row.archived) { workspaceAction('unarchiveSession'); return; }
        workspaceAction('archiveSession', [{ stopActivity: Boolean(row.running) }]);
      }
      function trashDetail() {
        if (!sessionId) return;
        setBusy(true);
        postJson(API_PATHS.trash, { sessionIds: [sessionId] }).then(function () {
          setBusy(false);
          setConfirmTrash(false);
          setPhase('missing');
          reload();
        }, report);
      }
      function copyId() {
        var clipboard = clipboardOf();
        if (!sessionId) return;
        if (!clipboard) { setFeedback({ kind: 'error', text: t('menu.reason.noClipboard') }); return; }
        try {
          Promise.resolve(clipboard.writeText(sessionId)).then(function () {
            setFeedback({ kind: 'info', text: t('notice.copiedId') });
          }, report);
        } catch (cause) {
          report(cause);
        }
      }
      function revealCwd() {
        var remote = optionalService(pageCtx, 'remote');
        var cwd = row && typeof row.cwd === 'string' ? row.cwd : '';
        if (cwd === '') return;
        var remoteSession = null;
        try { remoteSession = remote ? remote.session : null; } catch (cause) { remoteSession = null; }
        if (!hasMethod(remoteSession, 'openWorkspacePath')) return;
        try {
          Promise.resolve(remoteSession.openWorkspacePath({ path: cwd, action: 'reveal' })).then(null, report);
        } catch (cause) {
          report(cause);
        }
      }

      function closeButton() {
        return h('button', {
          key: 'close',
          type: 'button',
          className: 'sm-icon-btn sm-detail-close',
          title: t('detail.close'),
          'aria-label': t('detail.close'),
          onClick: function () { if (props.onClose) props.onClose(); }
        }, '×');
      }
      var paneHead = h('div', { key: 'pane-head', className: 'sm-detail-pane-head' }, [
        h('span', { key: 'label', className: 'sm-detail-pane-label' }, t('detail.title')),
        h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
        closeButton()
      ]);
      function pane(children) {
        return h('div', {
          key: 'pane',
          className: 'sm-detail-pane',
          'data-session-id': sessionId || undefined,
          onKeyDown: function (event) {
            // A local confirm dialog owns Esc; the page keeps the split open.
            if (event && event.key === 'Escape' && confirmTrash) event.stopPropagation();
          }
        }, [paneHead, h('div', { key: 'scroll', className: 'sm-detail sm-detail-scroll' }, children)]);
      }

      if (!sessionId) {
        return pane([h('p', { key: 'text', className: 'sm-hint' }, t('detail.stale'))]);
      }
      if (phase === 'loading') {
        return pane([h('p', { key: 'text', className: 'sm-hint' }, t('detail.loading'))]);
      }
      if (phase === 'error') {
        return pane([
          h('p', { key: 'text', className: 'sm-dialog-warning' }, error || t('error.host')),
          h('div', { key: 'actions', className: 'sm-detail-actions' }, [
            h(Btn, { key: 'retry', onClick: function () { setTick(function (current) { return current + 1; }); } }, t('action.retry')),
            h(Btn, { key: 'close', onClick: function () { if (props.onClose) props.onClose(); } }, t('action.close'))
          ])
        ]);
      }
      if (phase === 'missing') {
        return pane([
          h('p', { key: 'text', className: 'sm-dialog-warning' }, t('detail.stale')),
          h('div', { key: 'actions', className: 'sm-detail-actions' }, h(Btn, {
            key: 'close',
            onClick: function () { if (props.onClose) props.onClose(); }
          }, t('action.close')))
        ]);
      }

      var doc = row || { id: sessionId, tags: [], note: '', status: 'completed' };
      var caps = serviceCaps();
      var menu = menuItemsFor(doc, caps);
      var openItem = findMenuItem(menu, 'open');
      var forkItem = findMenuItem(menu, 'fork');
      var archiveItem = findMenuItem(menu, doc.archived ? 'unarchive' : 'archive');
      var title = doc.title || t('detail.missingTitle');
      var tags = asTags(doc.tags);
      var firstMessage = value && typeof value.firstMessage === 'string' ? value.firstMessage : (typeof doc.firstMessage === 'string' ? doc.firstMessage : '');
      var cwd = typeof doc.cwd === 'string' ? doc.cwd : '';
      var status = doc.status || 'completed';

      function metaRow(key, label, content, titleText) {
        return h('div', { key: key, className: 'sm-detail-meta-row' }, [
          h('dt', { key: 'label', className: 'sm-detail-label' }, label),
          h('dd', { key: 'value', className: 'sm-detail-value', title: titleText }, content)
        ]);
      }
      function disabledTitle(item) {
        return item && !item.enabled ? t(item.reasonKey || 'menu.reason.noService') : undefined;
      }

      return pane([
        h('div', { key: 'head', className: 'sm-detail-head' }, [
          titleDraft === null
            ? h('h2', {
              key: 'title',
              className: 'sm-detail-title',
              title: t('detail.renameHint'),
              onClick: function () { setTitleDraft(title); }
            }, title)
            : h('div', { key: 'title-edit', className: 'sm-detail-title-edit' }, [
              h('input', {
                key: 'input',
                type: 'text',
                className: 'sm-input',
                value: titleDraft,
                maxLength: 120,
                autoFocus: true,
                onChange: function (event) { setTitleDraft(event.target.value); },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') saveTitle();
                  else if (event.key === 'Escape') setTitleDraft(null);
                }
              }),
              h(Btn, { key: 'save', variant: 'primary', disabled: busy, onClick: saveTitle }, t('action.save')),
              h(Btn, { key: 'cancel', disabled: busy, onClick: function () { setTitleDraft(null); } }, t('action.cancel'))
            ]),
          h('div', { key: 'status', className: 'sm-detail-status' }, [
            h(StatusDot, { key: 'dot', status: status }),
            h('span', { key: 'label' }, statusLabel(status))
          ])
        ]),
        feedback ? h('p', {
          key: 'feedback',
          className: cx('sm-status-text', feedback.kind === 'error' && 'sm-status-error')
        }, feedback.text) : null,
        h('dl', { key: 'meta', className: 'sm-detail-meta' }, [
          metaRow('cwd', t('detail.cwd'), cwd === ''
            ? h('span', { className: 'sm-hint' }, t('common.none'))
            : h('button', {
              key: 'reveal',
              type: 'button',
              className: 'sm-link-btn',
              disabled: !caps.reveal,
              title: caps.reveal ? t('menu.reveal') : t('menu.reason.noRemote'),
              onClick: revealCwd
            }, cwd), cwd),
          metaRow('updated', t('detail.updatedAt'), doc.updatedAt
            ? new Date(doc.updatedAt).toLocaleString() + ' · ' + relativeLabel(doc.updatedAt)
            : t('time.unknown')),
          metaRow('turnEnd', t('detail.lastTurnEnd'), t(turnEndKey(doc.lastTurnEnd))),
          metaRow('intent', t('detail.intent'), doc.intent || t('common.none'))
        ]),
        h('div', { key: 'tags', className: 'sm-detail-section' }, [
          h('span', { key: 'label', className: 'sm-detail-label' }, t('detail.tags')),
          h('div', { key: 'chips', className: 'sm-detail-chips' }, tags.length === 0
            ? h('span', { key: 'empty', className: 'sm-hint' }, t('detail.noTags'))
            : tags.map(function (tag) {
              return h(Chip, {
                key: 'tag:' + tag,
                label: tag,
                removable: !busy,
                onRemove: function () {
                  commitTags(tags.filter(function (entry) { return entry !== tag; }));
                }
              });
            })),
          h('div', { key: 'add', className: 'sm-detail-tag-add' }, [
            h('input', {
              key: 'input',
              type: 'text',
              className: 'sm-input sm-input-inline',
              value: tagDraft,
              placeholder: t('detail.addTag'),
              onChange: function (event) { setTagDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }
            }),
            h(Btn, { key: 'add-btn', disabled: busy || String(tagDraft).trim() === '', onClick: addTag }, t('action.apply'))
          ])
        ]),
        h('div', { key: 'note', className: 'sm-detail-section' }, [
          h('span', { key: 'label', className: 'sm-detail-label' }, t('detail.note')),
          h('textarea', {
            key: 'textarea',
            className: 'sm-textarea',
            rows: 4,
            maxLength: 2000,
            value: noteDraft,
            placeholder: t('note.placeholder'),
            onChange: function (event) { setNoteDraft(event.target.value); }
          }),
          h('div', { key: 'save-row', className: 'sm-detail-actions' }, h(Btn, {
            key: 'save',
            variant: 'primary',
            disabled: busy,
            onClick: saveNote
          }, t('detail.saveNote')))
        ]),
        h('div', { key: 'first', className: 'sm-detail-section' }, [
          h('span', { key: 'label', className: 'sm-detail-label' }, t('detail.firstMessage')),
          h('p', { key: 'text', className: 'sm-detail-first' }, firstMessage || t('detail.noFirstMessage'))
        ]),
        h('div', { key: 'sid', className: 'sm-detail-section' }, [
          h('span', { key: 'label', className: 'sm-detail-label' }, t('detail.sessionId')),
          h('div', { key: 'value', className: 'sm-detail-sid' }, [
            h('code', { key: 'id', className: 'sm-detail-code' }, doc.id),
            h(Btn, {
              key: 'copy',
              disabled: !caps.clipboard,
              title: caps.clipboard ? t('notice.copiedId') : t('menu.reason.noClipboard'),
              onClick: copyId
            }, t('detail.copyId'))
          ])
        ]),
        h('div', { key: 'actions', className: 'sm-detail-actions' }, [
          h(Btn, {
            key: 'open',
            disabled: !openItem || !openItem.enabled,
            title: disabledTitle(openItem),
            onClick: function () { workspaceAction('openSession'); }
          }, t('detail.open')),
          h(Btn, {
            key: 'fork',
            disabled: !forkItem || !forkItem.enabled,
            title: disabledTitle(forkItem),
            onClick: function () { workspaceAction('forkSession'); }
          }, t('detail.fork')),
          h(Btn, {
            key: 'archive',
            disabled: !archiveItem || !archiveItem.enabled,
            title: disabledTitle(archiveItem),
            onClick: archiveDetail
          }, doc.archived ? t('detail.unarchive') : t('detail.archive')),
          h(Btn, {
            key: 'trash',
            variant: 'danger',
            disabled: busy,
            onClick: function () { setConfirmTrash(true); }
          }, t('detail.trash'))
        ]),
        confirmTrash ? h(DialogShell, {
          key: 'confirm',
          title: tf('delete.title', { n: 1 }),
          busy: busy,
          onClose: function () { setConfirmTrash(false); },
          footer: [
            h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
            h(Btn, { key: 'cancel', disabled: busy, onClick: function () { setConfirmTrash(false); } }, t('action.cancel')),
            h(Btn, { key: 'confirm', variant: 'danger', disabled: busy, onClick: trashDetail }, t('delete.confirm'))
          ]
        }, h('p', { key: 'body', className: 'sm-dialog-warning' }, t('delete.body'))) : null
      ]);
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    var pageCtx = null;

    function Page(props) {
      useLocaleSync(pageCtx);

      var live = useLiveSnapshot(props);
      /* Stale-while-revalidate: the last good payload paints the first frame. */
      var bootCache = readPanelCache();
      var bootRows = bootCache.rows.length > 0 ? bootCache.rows : [];
      var rowsState = useState(bootRows);
      var rowsRaw = rowsState[0];
      var setRowsRaw = rowsState[1];
      var metaState = useState(bootCache.meta);
      var meta = metaState[0];
      var setMeta = metaState[1];
      var indexingState = useState(bootCache.indexing);
      var indexing = indexingState[0];
      var setIndexing = indexingState[1];
      var phaseState = useState(bootRows.length > 0 ? 'ready' : 'loading');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var refreshingState = useState(false);
      var refreshing = refreshingState[0];
      var setRefreshing = refreshingState[1];
      var queryState = useState('');
      var query = queryState[0];
      var setQuery = queryState[1];
      var groupState = useState('status');
      var groupBy = groupState[0];
      var setGroupBy = groupState[1];
      var archiveState = useState('hide');
      var archiveView = archiveState[0];
      var setArchiveView = archiveState[1];
      var subagentState = useState(false);
      var showSubagents = subagentState[0];
      var setShowSubagents = subagentState[1];
      var filtersState = useState({ statuses: [], buckets: [], tags: [] });
      var filters = filtersState[0];
      var setFilters = filtersState[1];
      var selectedState = useState([]);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var collapsedState = useState([]);
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];
      /* v0.3.1 拖动排序: the user's own group order, per grouping dimension. */
      var groupOrderState = useState(readGroupOrder);
      var groupOrder = groupOrderState[0];
      var setGroupOrder = groupOrderState[1];
      var dragGroupState = useState(null);
      var dragGroup = dragGroupState[0];
      var setDragGroup = dragGroupState[1];
      var dropGroupState = useState(null);
      var dropGroup = dropGroupState[0];
      var setDropGroup = dropGroupState[1];
      var dialogState = useState(null);
      var dialog = dialogState[0];
      var setDialog = dialogState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var noticeState = useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var rowFocusState = useState(null);
      var rowFocus = rowFocusState[0];
      var setRowFocus = rowFocusState[1];
      /* The in-panel detail split (PRD §7.3 v0.2 fix): a row id, never a tab. */
      var detailIdState = useState(typeof props.initialDetailId === 'string' ? props.initialDetailId : null);
      var detailId = detailIdState[0];
      var setDetailId = detailIdState[1];
      var rowMenuState = useState(null);
      var rowMenu = rowMenuState[0];
      var setRowMenu = rowMenuState[1];
      var jobsState = useState([]);
      var jobs = jobsState[0];
      var setJobs = jobsState[1];
      var jobsOpenState = useState(false);
      var jobsOpen = jobsOpenState[0];
      var setJobsOpen = jobsOpenState[1];
      var jobsExpandedState = useState(null);
      var jobsExpanded = jobsExpandedState[0];
      var setJobsExpanded = jobsExpandedState[1];
      var jobItemsState = useState({});
      var jobItems = jobItemsState[0];
      var setJobItems = jobItemsState[1];
      var jobLoadingState = useState(null);
      var jobLoading = jobLoadingState[0];
      var setJobLoading = jobLoadingState[1];
      var cancellingState = useState([]);
      var cancelling = cancellingState[0];
      var setCancelling = cancellingState[1];
      /* A host without the job runner parks the task UI instead of erroring. */
      var jobsUnavailableState = useState(false);
      var jobsUnavailable = jobsUnavailableState[0];
      var setJobsUnavailable = jobsUnavailableState[1];
      var aiDownState = useState(null);
      var aiDown = aiDownState[0];
      var setAiDown = aiDownState[1];
      var pageRef = useRef(null);
      var refreshTimerRef = useRef(null);
      var handledJobsRef = useRef({});
      var jobsRef = useRef(jobs);
      jobsRef.current = jobs;

      function messageOf(cause) {
        if (!cause) return t('common.none');
        if (cause.code === 'llm_unavailable') return tf('notice.aiUnavailable', { reason: cause.message || t('common.none') });
        return cause.message || String(cause);
      }

      function fail(cause) {
        if (cause && cause.code === 'llm_unavailable') setAiDown(cause.message || 'unavailable');
        setNotice({ kind: 'error', text: tf('notice.failed', { message: messageOf(cause) }) });
      }

      function load(options) {
        var silent = Boolean(options && options.silent);
        if (!silent) setRefreshing(true);
        var sessionsPath = API_PATHS.sessions + '?includeArchived=true&includeSubagents=true';
        return Promise.all([request(sessionsPath), request(API_PATHS.state)]).then(function (pair) {
          var sessionBody = pair[0] || {};
          var nextRows = Array.isArray(sessionBody.rows) ? sessionBody.rows : [];
          var nextIndexing = sessionBody.indexing || (pair[1] && pair[1].indexing) || null;
          var nextMeta = pair[1] || null;
          rememberPanel(nextRows, nextMeta, nextIndexing);
          setRowsRaw(nextRows);
          setIndexing(nextIndexing);
          setMeta(nextMeta);
          setError(null);
          setPhase('ready');
          setRefreshing(false);
        }, function (cause) {
          setRefreshing(false);
          var message = cause && cause.message ? cause.message : String(cause);
          if (silent) { setIndexing(null); return; }
          // A background refresh must not wipe rows the panel is already showing.
          if (rowsRaw.length > 0) {
            setNotice({ kind: 'error', text: tf('notice.failed', { message: message }) });
            return;
          }
          setError({ code: cause && cause.code ? cause.code : 'error', message: message, status: cause && cause.status ? cause.status : 0 });
          setPhase('error');
        });
      }

      useEffect(function () { load(); }, []);

      /* Publish "the panel is on screen" so the shared menu can offer its entries. */
      useEffect(function () {
        setPanelActive(true);
        var unsubscribe = subscribePanelDetail(function (id) { setDetailId(id); });
        return function () {
          unsubscribe();
          setPanelActive(false);
        };
      }, []);

      /* A tag written from the shared popup must show up without reopening the panel. */
      useEffect(function () {
        return subscribeTagWrite(function () { scheduleRefresh(); });
      }, []);

      /* Safety net: a detail request that landed before this panel mounted still opens. */
      useEffect(function () {
        if (panelBridge.detailId && panelBridge.detailId !== detailId) setDetailId(panelBridge.detailId);
      });

      /* Indexing is non-blocking: poll quietly while it runs, then stop. */
      useEffect(function () {
        if (!indexing || !indexing.running) return undefined;
        var timer = setTimeout(function () { load({ silent: true }); }, 1500);
        return function () { clearTimeout(timer); };
      }, [indexing]);

      /* The row context menu closes on any click outside it and hands focus back. */
      useEffect(function () {
        if (!rowMenu) return undefined;
        var timer = setTimeout(function () {
          if (typeof document !== 'undefined') document.addEventListener('click', closeRowMenuOnOutsideClick);
        }, 0);
        return function () {
          clearTimeout(timer);
          if (typeof document !== 'undefined') document.removeEventListener('click', closeRowMenuOnOutsideClick);
        };
      }, [rowMenu]);

      /* Opening the panel refreshes the stored list, not just the active page. */
      useEffect(function () {
        if (!jobsOpen) return undefined;
        loadJobList();
        return undefined;
      }, [jobsOpen]);

      /* The task panel closes when the click lands outside it. */
      useEffect(function () {
        if (!jobsOpen) return undefined;
        function close(event) {
          try {
            if (event && event.target && typeof event.target.closest === 'function' && event.target.closest('.sm-jobs')) return;
          } catch (error) { /* ignore */ }
          setJobsOpen(false);
        }
        var timer = setTimeout(function () {
          if (typeof document !== 'undefined') document.addEventListener('click', close);
        }, 0);
        return function () {
          clearTimeout(timer);
          if (typeof document !== 'undefined') document.removeEventListener('click', close);
        };
      }, [jobsOpen]);

      var liveById = useMemo(function () {
        var map = {};
        var statusMap = live.statusMap;
        if (statusMap && typeof statusMap.forEach === 'function') {
          statusMap.forEach(function (value, id) { map[id] = value; });
        }
        return map;
      }, [live.statusMap]);

      var sessionsById = live.sessionsState && live.sessionsState.byId ? live.sessionsState.byId : null;

      var rows = useMemo(function () {
        var now = Date.now();
        var merged = rowsRaw.map(function (row) {
          var summary = sessionsById ? sessionsById[row.id] : null;
          if (!summary) return row;
          return Object.assign({}, row, {
            title: summary.title || row.title,
            updatedAt: summary.updatedAt || row.updatedAt,
            running: summary.running === undefined ? row.running : summary.running,
            blank: Boolean(summary.blank) || Boolean(row.blank),
            cwd: summary.cwd || row.cwd
          });
        });
        return decorateRows(merged, liveById, now);
      }, [rowsRaw, liveById, sessionsById]);

      var baseRows = useMemo(function () {
        return filterRows(rows, { archiveView: archiveView, showSubagents: showSubagents, filters: {} });
      }, [rows, archiveView, showSubagents]);

      var visible = useMemo(function () {
        return sortRows(filterRows(rows, {
          query: query,
          filters: filters,
          archiveView: archiveView,
          showSubagents: showSubagents
        }));
      }, [rows, query, filters, archiveView, showSubagents]);

      var groups = useMemo(function () {
        return applyGroupOrder(groupRows(visible, groupBy), groupOrder[groupBy]);
      }, [visible, groupBy, groupOrder]);
      var overview = useMemo(function () { return statusCounts(baseRows); }, [baseRows]);

      var rowById = useMemo(function () {
        var map = {};
        for (var index = 0; index < rows.length; index += 1) map[rows[index].id] = rows[index];
        return map;
      }, [rows]);

      /* Share the loaded rows with the in-panel detail split (PRD §7.3). */
      useEffect(function () {
        cacheRows(rows);
      }, [rows]);

      useEffect(function () {
        setRowFocus(function (previous) {
          return previous && rowById[previous] ? previous : null;
        });
      }, [rowById]);

      /* Flattened keyboard order across visible, expanded groups. */
      var navOrder = useMemo(function () {
        var ids = [];
        for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          var group = groups[groupIndex];
          if (collapsed.indexOf(group.key) >= 0) continue;
          for (var rowIndex = 0; rowIndex < group.rows.length; rowIndex += 1) ids.push(group.rows[rowIndex].id);
        }
        return ids;
      }, [groups, collapsed]);

      var jobsSorted = useMemo(function () { return sortJobs(jobs, 20); }, [jobs]);
      var activeJobs = useMemo(function () { return jobsSorted.filter(isActiveJob); }, [jobsSorted]);
      var latestJob = useMemo(function () {
        for (var index = 0; index < jobsSorted.length; index += 1) {
          if (!isActiveJob(jobsSorted[index])) return jobsSorted[index];
        }
        return null;
      }, [jobsSorted]);

      /* Load the recent task list once; tasks survive leaving the panel. */
      useEffect(function () {
        request(API_PATHS.jobs).then(function (body) {
          var list = sortJobs(body && Array.isArray(body.jobs) ? body.jobs : [], 20);
          // History loaded at mount is not news: mark it settled so opening the
          // panel never replays old failures as fresh notices.
          for (var index = 0; index < list.length; index += 1) {
            if (!isActiveJob(list[index])) handledJobsRef.current[list[index].id + ':' + list[index].state] = true;
          }
          setJobs(list);
        }, function (cause) {
          // Old hosts answer 503 before host/jobs.js loads: park the task UI.
          if (isJobUnavailable(cause)) setJobsUnavailable(true);
        });
        return undefined;
      }, []);

      /* PRD §7.4: poll active jobs every 800ms while any task is in flight.
         A host without the job runner (503/404) parks polling for good. */
      useEffect(function () {
        if (jobsUnavailable) return undefined;
        if (activeJobs.length === 0 && !jobsExpanded) return undefined;
        var timer = setInterval(function () { pollJobs(); }, JOB_POLL_MS);
        pollJobs();
        return function () { clearInterval(timer); };
      }, [activeJobs.length, jobsExpanded, jobsUnavailable]);

      /* Settle finished tasks exactly once: resolve waiters and refresh rows. */
      useEffect(function () {
        for (var index = 0; index < jobsSorted.length; index += 1) {
          var job = jobsSorted[index];
          if (isActiveJob(job)) continue;
          var key = job.id + ':' + job.state;
          if (handledJobsRef.current[key]) continue;
          handledJobsRef.current[key] = true;
          settleJob(job);
          if (job.state === 'failed') setNotice({ kind: 'error', text: tf('notice.jobFailed', { message: job.errorText || jobStateLabel(job.state) }) });
          else if (job.state === 'cancelled') setNotice({ kind: 'info', text: t('notice.jobCancelled') });
          else if (job.state === 'interrupted') setNotice({ kind: 'error', text: t('notice.jobInterrupted') });
          scheduleRefresh();
        }
      }, [jobsSorted]);

      useEffect(function () {
        return function () {
          if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
          }
          clearJobWaiters();
        };
      }, []);

      var tagOptions = useMemo(function () {
        var seen = {};
        var list = [];
        var add = function (tag) {
          if (!tag || seen[tag]) return;
          if (filterHasTag(tag)) return;
          seen[tag] = true;
          list.push(tag);
        };
        for (var index = 0; index < rows.length; index += 1) {
          var tags = rows[index].tags || [];
          for (var tagIndex = 0; tagIndex < tags.length; tagIndex += 1) add(tags[tagIndex]);
        }
        var defs = meta && Array.isArray(meta.tagDefs) ? meta.tagDefs : [];
        for (var defIndex = 0; defIndex < defs.length; defIndex += 1) add(defs[defIndex] && defs[defIndex].name);
        return list.sort(function (left, right) { return left.localeCompare(right, 'zh-Hans-CN'); });
      }, [rows, meta, filters.tags]);

      function filterHasTag(tag) {
        return (filters.tags || []).indexOf(tag) >= 0;
      }

      useEffect(function () {
        setSelected(function (previous) {
          var next = previous.filter(function (id) { return Boolean(rowById[id]); });
          return next.length === previous.length ? previous : next;
        });
      }, [rowById]);

      var selectedRows = useMemo(function () {
        var list = [];
        for (var index = 0; index < selected.length; index += 1) {
          var row = rowById[selected[index]];
          if (row) list.push(row);
        }
        return list;
      }, [selected, rowById]);

      var selectedActionable = selectedRows.filter(isBatchable);
      var visibleActionable = visible.filter(isBatchable);

      function batchTargets() {
        if (selectedActionable.length > 0) return selectedActionable.map(function (row) { return row.id; });
        return visibleActionable.map(function (row) { return row.id; });
      }

      function toggleSelected(id) {
        setSelected(function (previous) { return toggleValue(previous, id); });
      }

      function toggleFilter(kind, value) {
        setFilters(function (previous) {
          var next = Object.assign({}, previous, { statuses: previous.statuses.slice(), buckets: previous.buckets.slice(), tags: previous.tags.slice() });
          next[kind] = toggleValue(next[kind], value);
          return next;
        });
      }

      function clearFilters() {
        setFilters({ statuses: [], buckets: [], tags: [] });
      }

      function toggleCollapsedGroup(key) {
        setCollapsed(function (previous) { return toggleValue(previous, key); });
      }

      /* PRD §7.1 拖动排序 (v0.3.1): commit one new order for the current dimension. */
      function commitGroupOrder(nextKeys) {
        var dimension = groupBy;
        var next = {};
        for (var key in groupOrder) {
          if (Object.prototype.hasOwnProperty.call(groupOrder, key)) next[key] = groupOrder[key];
        }
        next[dimension] = nextKeys;
        setGroupOrder(next);
        writeGroupOrder(next);
      }

      /** Every group key in its current on-screen order, so a drag can be total. */
      function currentGroupKeys() {
        var keys = [];
        for (var index = 0; index < groups.length; index += 1) keys.push(groups[index].key);
        return keys;
      }

      function moveGroupTo(key, targetKey) {
        commitGroupOrder(moveGroupKey(currentGroupKeys(), key, targetKey));
        setDragGroup(null);
        setDropGroup(null);
      }

      function nudgeGroup(key, delta) {
        commitGroupOrder(moveGroupBy(currentGroupKeys(), key, delta));
      }

      function resetGroupOrder() {
        var next = {};
        for (var key in groupOrder) {
          if (Object.prototype.hasOwnProperty.call(groupOrder, key)) next[key] = groupOrder[key];
        }
        delete next[groupBy];
        setGroupOrder(next);
        writeGroupOrder(next);
      }

      function refreshSilently() { load({ silent: true }); }

      function aiBlocked() {
        if (aiDown) return true;
        return Boolean(meta && meta.ai && meta.ai.ok === false);
      }

      function aiReason() {
        if (aiDown) return tf('notice.aiUnavailable', { reason: aiDown });
        if (meta && meta.ai && meta.ai.ok === false) return tf('notice.aiUnavailable', { reason: meta.ai.reason || t('common.none') });
        return undefined;
      }

      function readContentSetting() {
        if (meta && meta.settings && meta.settings.ai && typeof meta.settings.ai.readContent === 'boolean') return meta.settings.ai.readContent;
        return true;
      }

      /* ---------------- actions ---------------- */

      /* ---------- background tasks (PRD §7.4 / §8.1) ---------- */

      function mergeJobs(incoming) {
        setJobs(function (previous) { return sortJobs(mergeJobList(previous, incoming), 20); });
      }

      function scheduleRefresh() {
        if (refreshTimerRef.current) return;
        refreshTimerRef.current = setTimeout(function () {
          refreshTimerRef.current = null;
          load({ silent: true });
        }, REFRESH_MERGE_MS);
      }

      function loadJobDetail(id) {
        setJobLoading(id);
        request(jobPath(id)).then(function (body) {
          setJobLoading(null);
          if (!body || !body.job) return;
          mergeJobs([body.job]);
          setJobItems(function (previous) {
            var next = Object.assign({}, previous);
            next[id] = Array.isArray(body.job.items) ? body.job.items : [];
            return next;
          });
        }, function () { setJobLoading(null); });
      }

      /** Read the stored task list once (panel open, page mount) so history is not missing. */
      function loadJobList() {
        request(API_PATHS.jobs).then(function (body) {
          mergeJobs(body && Array.isArray(body.jobs) ? body.jobs : []);
        }, function (cause) {
          if (isJobUnavailable(cause)) setJobsUnavailable(true);
        });
      }

      /** Poll active jobs; a vanished task gets one detail read to learn its final state. */
      function pollJobs() {
        request(activeJobsPath()).then(function (body) {
          var active = body && Array.isArray(body.jobs) ? body.jobs : [];
          var activeIds = {};
          for (var index = 0; index < active.length; index += 1) activeIds[active[index].id] = true;
          var current = jobsRef.current || [];
          var vanished = [];
          for (var currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
            var job = current[currentIndex];
            if (isActiveJob(job) && !activeIds[job.id]) vanished.push(job.id);
          }
          mergeJobs(active);
          for (var vanishedIndex = 0; vanishedIndex < vanished.length; vanishedIndex += 1) {
            (function (id) {
              request(jobPath(id)).then(function (detail) {
                if (detail && detail.job) mergeJobs([detail.job]);
              }, function (cause) {
                // A pruned task would otherwise poll forever: record it as interrupted.
                if (!cause || cause.status !== 404) return;
                var known = null;
                for (var index = 0; index < (jobsRef.current || []).length; index += 1) {
                  if (jobsRef.current[index].id === id) { known = jobsRef.current[index]; break; }
                }
                if (!known) return;
                mergeJobs([Object.assign({}, known, { state: 'interrupted', finishedAt: Date.now() })]);
              });
            })(vanished[vanishedIndex]);
          }
        }, function (cause) {
          // The host does not expose /jobs: stop polling and show the parked state.
          if (isJobUnavailable(cause)) setJobsUnavailable(true);
        });
        if (jobsExpanded) loadJobDetail(jobsExpanded);
      }

      /**
       * Create a task and track it. The host answers 202 {job}; a build without
       * the job runner answers with the plain result, which is treated as done.
       */
      function startJob(path, payload, onDone) {
        return postJson(path, payload).then(function (body) {
          if (!body || !body.job) {
            if (onDone) {
              onDone({ id: '', type: 'unknown', state: 'succeeded', active: false, done: 0, total: 0, failed: 0, skipped: 0, percent: 100, errorText: '', items: [], result: body || null });
            }
            return null;
          }
          var job = normalizeJob(body.job);
          mergeJobs([job]);
          if (job.active) whenJobDone(job.id, onDone);
          else if (onDone) onDone(job);
          if (job.active) {
            setJobsOpen(true);
            setNotice({ kind: 'info', text: tf('notice.jobStarted', { name: jobTypeLabel(job.type) }) });
          }
          return job;
        }, function (cause) {
          if (isJobUnavailable(cause)) {
            setJobsUnavailable(true);
            setNotice({ kind: 'info', text: t('job.unavailableHint') });
            return null;
          }
          fail(cause);
          return null;
        });
      }

      function cancelJob(id) {
        setCancelling(function (previous) { return previous.concat([id]); });
        postJson(jobCancelPath(id), {}).then(function (body) {
          setCancelling(function (previous) { return previous.filter(function (entry) { return entry !== id; }); });
          if (body && body.job) mergeJobs([body.job]);
        }, function (cause) {
          setCancelling(function (previous) { return previous.filter(function (entry) { return entry !== id; }); });
          if (isJobUnavailable(cause)) { setJobsUnavailable(true); return; }
          fail(cause);
        });
      }

      function toggleJobDetail(id) {
        var next = jobsExpanded === id ? null : id;
        setJobsExpanded(next);
        if (next) loadJobDetail(next);
      }

      function startRenamePreview(chosen) {
        var ids = Array.isArray(chosen) && chosen.length > 0 ? chosen : batchTargets();
        if (ids.length === 0) { setNotice({ kind: 'info', text: t('notice.selectedNone') }); return; }
        setBusy(true);
        startJob(API_PATHS.aiRenamePreview, { sessionIds: ids, readContent: readContentSetting() }, function (job) {
          if (job.state !== 'succeeded') return;
          var result = job.result || {};
          var items = Array.isArray(result.items) ? result.items : [];
          if (items.length === 0) { setNotice({ kind: 'info', text: t('notice.previewEmpty') }); return; }
          setDialog({
            type: 'renamePreview',
            items: items,
            model: result.model || '',
            modelSelection: result.modelSelection || null
          });
        }).then(function () { setBusy(false); });
      }

      function applyRename(items) {
        if (!items || items.length === 0) { setDialog(null); return; }
        setBusy(true);
        setDialog(null);
        startJob(API_PATHS.aiRenameApply, { items: items }, function (job) {
          if (job.state !== 'succeeded') return;
          var result = job.result || {};
          var applied = Array.isArray(result.applied) ? result.applied.length : 0;
          setNotice({ kind: 'info', text: tf('notice.renamed', { n: applied }) });
        }).then(function () { setBusy(false); });
      }

      function startTagsPreview(chosen) {
        var ids = Array.isArray(chosen) && chosen.length > 0 ? chosen : batchTargets();
        if (ids.length === 0) { setNotice({ kind: 'info', text: t('notice.selectedNone') }); return; }
        setBusy(true);
        startJob(API_PATHS.aiTagsPreview, { sessionIds: ids, mode: 'suggest' }, function (job) {
          if (job.state !== 'succeeded') return;
          var result = job.result || {};
          setDialog({
            type: 'tagsPreview',
            items: Array.isArray(result.items) ? result.items : [],
            vocabulary: Array.isArray(result.vocabulary) ? result.vocabulary : []
          });
        }).then(function () { setBusy(false); });
      }

      function applyTagsPreview(items) {
        if (!items || items.length === 0) { setDialog(null); return; }
        setBusy(true);
        postJson(API_PATHS.aiTagsApply, { items: items }).then(function (body) {
          setBusy(false);
          setDialog(null);
          var applied = body && body.applied ? body.applied.length : 0;
          setNotice({ kind: 'info', text: tf('notice.tagged', { n: applied }) });
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function startFillMissing() {
        setBusy(true);
        startJob(API_PATHS.fillMissing, { dryRun: true }, function (job) {
          if (job.state !== 'succeeded') return;
          var result = job.result || {};
          setDialog({
            type: 'fillMissing',
            candidates: Array.isArray(result.candidates) ? result.candidates : [],
            updated: result.updated || 0
          });
        }).then(function () { setBusy(false); });
      }

      function applyFillMissing() {
        setBusy(true);
        setDialog(null);
        startJob(API_PATHS.fillMissing, { dryRun: false }, function (job) {
          if (job.state !== 'succeeded') return;
          var result = job.result || {};
          setNotice({ kind: 'info', text: tf('notice.filled', { n: typeof result.updated === 'number' ? result.updated : 0 }) });
        }).then(function () { setBusy(false); });
      }

      function commitTags(mode, tags) {
        var ids = dialog && dialog.ids ? dialog.ids : [];
        if (ids.length === 0) { setDialog(null); return; }
        setBusy(true);
        postJson(API_PATHS.tags, { sessionIds: ids, op: mode, tags: mode === 'clear' ? [] : tags }).then(function (body) {
          setBusy(false);
          setDialog(null);
          setNotice({ kind: 'info', text: tf('notice.tagged', { n: body && typeof body.updated === 'number' ? body.updated : ids.length }) });
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function commitRename(id, title) {
        setBusy(true);
        postJson(API_PATHS.rename, { sessionId: id, title: title }).then(function () {
          setBusy(false);
          setDialog(null);
          setNotice({ kind: 'info', text: t('notice.renamed', { n: 1 }) });
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function commitNote(id, note) {
        setBusy(true);
        postJson(API_PATHS.notes, { sessionId: id, note: note }).then(function () {
          setBusy(false);
          setDialog(null);
          setNotice({ kind: 'info', text: t('notice.notes') });
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function archiveRows(ids, unarchive) {
        if (!ids || ids.length === 0) return;
        setBusy(true);
        postJson(unarchive ? API_PATHS.unarchive : API_PATHS.archive, unarchive ? { sessionIds: ids } : { sessionIds: ids, stopActivity: true }).then(function (body) {
          setBusy(false);
          var done = body && (unarchive ? body.unarchived : body.archived);
          var count = Array.isArray(done) ? done.length : ids.length;
          setNotice({ kind: 'info', text: tf(unarchive ? 'notice.unarchived' : 'notice.archived', { n: count }) });
          if (body && Array.isArray(body.refused) && body.refused.length > 0) {
            setNotice({ kind: 'error', text: tf('notice.refused', { message: refusedText(body.refused) }) });
          }
          setSelected([]);
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function trashRows(ids) {
        if (!ids || ids.length === 0) return;
        setBusy(true);
        postJson(API_PATHS.trash, { sessionIds: ids }).then(function (body) {
          setBusy(false);
          setDialog(null);
          var moved = body && Array.isArray(body.trashed) ? body.trashed.length : 0;
          var tombstones = body && Array.isArray(body.tombstones) ? body.tombstones.length : 0;
          var count = moved + tombstones > 0 ? moved + tombstones : ids.length;
          setNotice({ kind: 'info', text: tf('notice.trashed', { n: count }) });
          if (body && Array.isArray(body.refused) && body.refused.length > 0) {
            setNotice({ kind: 'error', text: tf('notice.refused', { message: refusedText(body.refused) }) });
          }
          setSelected([]);
          refreshSilently();
        }, function (cause) { setBusy(false); fail(cause); });
      }

      function refusedText(list) {
        return list.map(function (entry) {
          return (entry.sessionId || '') + ': ' + (entry.message || entry.code || '');
        }).join('; ');
      }

      function handleRowAction(action, row) {
        if (action === 'rename') setDialog({ type: 'renameOne', row: row });
        else if (action === 'tags') setDialog({ type: 'tags', ids: [row.id], mode: 'replace', initial: row.tags || [] });
        else if (action === 'note') setDialog({ type: 'note', row: row });
        else if (action === 'archive') archiveRows([row.id], false);
        else if (action === 'unarchive') archiveRows([row.id], true);
        else if (action === 'trash') setDialog({ type: 'delete', ids: [row.id] });
        else if (action === 'detail') openDetail(row);
        else if (action === 'open') jumpToSession(row);
      }

      /* ---------- native-aligned row actions (PRD §7.1 / §7.2) ---------- */

      function withWorkspace(method, args, success) {
        var workspace = optionalService(pageCtx, 'uiWorkspace');
        if (!hasMethod(workspace, method)) {
          setNotice({ kind: 'error', text: t('menu.reason.noService') });
          return Promise.resolve(false);
        }
        return Promise.resolve().then(function () {
          return workspace[method].apply(workspace, args || []);
        }).then(function (value) {
          if (success) success(value);
          return true;
        }, function (cause) {
          fail(cause);
          return false;
        });
      }

      function jumpToSession(row) {
        if (!row) return;
        withWorkspace('openSession', [row.id], function () { setRowFocus(row.id); });
      }

      function forkSession(row) {
        if (!row) return;
        setBusy(true);
        withWorkspace('forkSession', [row.id], function () {
          setNotice({ kind: 'info', text: t('notice.forked') });
          scheduleRefresh();
        }).then(function () { setBusy(false); });
      }

      function togglePin(row) {
        if (!row) return;
        setBusy(true);
        var pinned = Boolean(row.pinned);
        withWorkspace(pinned ? 'unpinSession' : 'pinSession', [row.id], function () {
          setNotice({ kind: 'info', text: t(pinned ? 'notice.unpinned' : 'notice.pinned') });
          scheduleRefresh();
        }).then(function () { setBusy(false); });
      }

      function copySessionId(row) {
        var clipboard = clipboardOf();
        if (!row) return;
        if (!clipboard) { setNotice({ kind: 'error', text: t('menu.reason.noClipboard') }); return; }
        try {
          Promise.resolve(clipboard.writeText(row.id)).then(function () {
            setNotice({ kind: 'info', text: t('notice.copiedId') });
          }, fail);
        } catch (cause) {
          fail(cause);
        }
      }

      function revealSession(row) {
        var remote = optionalService(pageCtx, 'remote');
        if (!row) return;
        if (!row.cwd) { setNotice({ kind: 'error', text: t('menu.reason.noCwd') }); return; }
        var remoteSession = null;
        try { remoteSession = remote ? remote.session : null; } catch (cause) { remoteSession = null; }
        if (!hasMethod(remoteSession, 'openWorkspacePath')) {
          setNotice({ kind: 'error', text: t('menu.reason.noRemote') });
          return;
        }
        try {
          Promise.resolve(remoteSession.openWorkspacePath({ path: row.cwd, action: 'reveal' })).then(null, fail);
        } catch (cause) {
          fail(cause);
        }
      }

      function requestArchive(row) {
        if (!row) return;
        if (row.running) { setDialog({ type: 'archiveConfirm', row: row }); return; }
        archiveSession(row, false);
      }

      function archiveSession(row, stopActivity) {
        if (!row) return;
        setBusy(true);
        withWorkspace('archiveSession', [row.id, { stopActivity: Boolean(stopActivity) }], function () {
          setNotice({ kind: 'info', text: tf('notice.archived', { n: 1 }) });
          scheduleRefresh();
        }).then(function () { setBusy(false); });
      }

      function unarchiveSession(row) {
        if (!row) return;
        setBusy(true);
        withWorkspace('unarchiveSession', [row.id], function () {
          setNotice({ kind: 'info', text: tf('notice.unarchived', { n: 1 }) });
          scheduleRefresh();
        }).then(function () { setBusy(false); });
      }

      /** Open the in-panel detail split for one row (the panel is the surface). */
      function openDetail(row) {
        if (!row) return;
        setRowFocus(row.id);
        setDetailId(row.id);
      }

      function closeDetail() {
        var id = detailId;
        setDetailId(null);
        if (id) focusRowElement(id);
      }

      /* ---------- self-drawn context menu plumbing ---------- */

      function menuViewport() {
        var node = pageRef.current;
        try {
          if (node && typeof node.getBoundingClientRect === 'function') {
            var rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }
        } catch (error) { /* fall through */ }
        try {
          if (typeof window !== 'undefined' && window) return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
        } catch (error) { /* ignore */ }
        return null;
      }

      function menuAnchorFromEvent(event) {
        var x = event && typeof event.clientX === 'number' ? event.clientX : 0;
        var y = event && typeof event.clientY === 'number' ? event.clientY : 0;
        try {
          var node = pageRef.current;
          if (node && typeof node.getBoundingClientRect === 'function') {
            var rect = node.getBoundingClientRect();
            x -= rect.left;
            y -= rect.top;
          }
        } catch (error) { /* fall back to viewport coordinates */ }
        return { x: x, y: y };
      }

      /** Viewport point under a row, for keyboard-opened menus. */
      function viewportPointForRow(id) {
        try {
          if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            var node = document.querySelector('[data-session-id="' + String(id).replace(/"/g, '\\"') + '"]');
            if (node && typeof node.getBoundingClientRect === 'function') {
              var rect = node.getBoundingClientRect();
              return { x: rect.left + 24, y: rect.top + Math.max(0, rect.height) };
            }
          }
        } catch (error) { /* fall back to the corner */ }
        return { x: 12, y: 12 };
      }

      /**
       * Row right-click opens the shared native Session menu (PRD §7.2), so the
       * panel and the native sidebar offer the same entries and our own tag
       * submenu appears in both. The in-panel menu stays as the fallback for a
       * client without the contextMenus capability.
       */
      function openRowMenu(row, event) {
        if (!row) return;
        setRowFocus(row.id);
        var point = event && typeof event.clientX === 'number' && typeof event.clientY === 'number'
          ? { x: event.clientX, y: event.clientY }
          : viewportPointForRow(row.id);
        if (openNativeSessionMenu(optionalService(pageCtx, 'contextMenus'), row, point)) return;
        setRowMenu({ rowId: row.id, anchor: menuAnchorFromEvent(event), viewport: menuViewport() });
      }

      /** The "⋯" button opens the plugin menu (right-click stays native). */
      function openPluginRowMenu(row, event) {
        if (!row) return;
        setRowFocus(row.id);
        setRowMenu({
          rowId: row.id,
          plugin: true,
          anchor: menuAnchorFromEvent(event),
          viewport: menuViewport()
        });
      }

      function closeRowMenuOnOutsideClick() {
        closeRowMenu(true);
      }

      function focusRowElement(id) {
        if (typeof id !== 'string' || id === '') return;
        try {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          var node = document.querySelector('[data-session-id="' + id.replace(/"/g, '\\"') + '"]');
          if (node && typeof node.focus === 'function') node.focus();
        } catch (error) { /* focus is best effort */ }
      }

      function closeRowMenu(restoreFocus) {
        var menu = rowMenu;
        setRowMenu(null);
        if (menu && restoreFocus !== false) focusRowElement(menu.rowId);
      }

      function anchorForRow(id) {
        try {
          if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            var node = document.querySelector('[data-session-id="' + String(id).replace(/"/g, '\\"') + '"]');
            if (node && typeof node.getBoundingClientRect === 'function') {
              var rect = node.getBoundingClientRect();
              var base = { left: 0, top: 0 };
              var pageNode = pageRef.current;
              if (pageNode && typeof pageNode.getBoundingClientRect === 'function') base = pageNode.getBoundingClientRect();
              return { x: rect.left - base.left + 24, y: rect.top - base.top + Math.max(0, rect.height) };
            }
          }
        } catch (error) { /* ignore */ }
        return { x: 12, y: 12 };
      }

      function pickMenuItem(action) {
        var menu = rowMenu;
        var row = menu ? rowById[menu.rowId] : null;
        closeRowMenu(true);
        if (!row) return;
        if (action === 'pin' || action === 'unpin') togglePin(row);
        else if (action === 'rename') setDialog({ type: 'renameOne', row: row });
        else if (action === 'fork') forkSession(row);
        else if (action === 'copyId') copySessionId(row);
        else if (action === 'reveal') revealSession(row);
        else if (action === 'archive') requestArchive(row);
        else if (action === 'unarchive') unarchiveSession(row);
        else if (action === 'detail') openDetail(row);
        else if (action === 'open') jumpToSession(row);
        else if (action === 'tags') setDialog({ type: 'tags', ids: [row.id], mode: 'replace', initial: row.tags || [] });
        else if (action === 'note') setDialog({ type: 'note', row: row });
        else if (action === 'trash') setDialog({ type: 'delete', ids: [row.id] });
      }

      function isEditableTarget(target) {
        if (!target) return false;
        var tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return target.isContentEditable === true;
      }

      /** Panel-scoped keyboard: selection, open detail, jump, shortcuts (PRD §7.1/§7.2). */
      function handlePanelKeyDown(event) {
        if (!event) return;
        if (dialog) return; // an open dialog owns the keyboard (PRD §7.1 scoping)
        if (rowMenu) {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeRowMenu(true);
          }
          return;
        }
        if (event.key === 'Escape') {
          // Esc closes the in-panel detail split; inputs keep their own Escape.
          var escapeOwner = panelEscapeAction({ dialog: Boolean(dialog), menu: Boolean(rowMenu), detailId: detailId });
          if (escapeOwner === 'detail' && !isEditableTarget(event.target)) {
            event.preventDefault();
            closeDetail();
          }
          return;
        }
        if (isEditableTarget(event.target)) return;
        var selectedRow = rowFocus ? rowById[rowFocus] : null;
        var shortcut = shortcutFor(event, { panelFocused: true, selectedId: selectedRow ? rowFocus : null });
        if (shortcut && selectedRow) {
          event.preventDefault();
          if (shortcut === 'rename') setDialog({ type: 'renameOne', row: selectedRow });
          else if (shortcut === 'fork') forkSession(selectedRow);
          else if (shortcut === 'archive') requestArchive(selectedRow);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (navOrder.length === 0) return;
          event.preventDefault();
          var nextId = moveSelection(navOrder, rowFocus, event.key === 'ArrowDown' ? 1 : -1);
          if (nextId) {
            setRowFocus(nextId);
            focusRowElement(nextId);
          }
          return;
        }
        if (event.key === 'Enter') {
          if (!selectedRow) return;
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) jumpToSession(selectedRow);
          else openDetail(selectedRow);
          return;
        }
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          if (!selectedRow) return;
          event.preventDefault();
          setRowMenu({ rowId: selectedRow.id, anchor: anchorForRow(selectedRow.id), viewport: menuViewport() });
        }
      }

      /* ---------------- render ---------------- */

      var indexText = t('index.idle');
      if (indexing && indexing.running) {
        indexText = tf('index.running', { done: indexing.processed || 0, total: indexing.total || 0 });
      }

      var header = h('header', { key: 'head', className: 'sm-head' }, [
        h('div', { key: 'titles', className: 'sm-head-titles' }, [
          h('h1', { key: 'title', className: 'sm-head-title' }, t('app.title')),
          h('p', { key: 'sub', className: 'sm-head-sub' }, t('app.subtitle'))
        ]),
        h('div', { key: 'actions', className: 'sm-head-actions' }, [
          h('span', {
            key: 'index',
            className: cx('sm-index', indexing && indexing.running && 'sm-index-running'),
            title: t('index.note')
          }, indexText),
          h(Btn, {
            key: 'refresh',
            variant: 'primary',
            disabled: refreshing,
            onClick: function () { load(); }
          }, t('action.refresh'))
        ])
      ]);

      var overviewBar = h('div', { key: 'overview', className: 'sm-overview', role: 'group', 'aria-label': t('overview.hint') }, OVERVIEW_IDS.map(function (id) {
        var activeFilter = filters.statuses.indexOf(id) >= 0;
        return h('button', {
          key: id,
          type: 'button',
          className: cx('sm-overview-card', 'sm-overview-' + id, activeFilter && 'sm-overview-active'),
          title: t('overview.hint'),
          'aria-pressed': activeFilter ? 'true' : 'false',
          onClick: function () { toggleFilter('statuses', id); }
        }, [
          h('span', { key: 'num', className: 'sm-overview-num' }, String(overview[id] || 0)),
          h('span', { key: 'label', className: 'sm-overview-label' }, statusLabel(id))
        ]);
      }));

      var toolbar = h('div', { key: 'toolbar', className: 'sm-toolbar' }, [
        h('input', {
          key: 'search',
          type: 'search',
          className: 'sm-search',
          value: query,
          placeholder: t('toolbar.search'),
          'aria-label': t('toolbar.search'),
          onChange: function (event) { setQuery(event.target.value); }
        }),
        h('div', { key: 'group', className: 'sm-seg', role: 'group', 'aria-label': t('toolbar.groupBy') }, GROUP_IDS.map(function (id) {
          return h('button', {
            key: id,
            type: 'button',
            className: cx('sm-seg-btn', groupBy === id && 'sm-seg-btn-active'),
            'aria-pressed': groupBy === id ? 'true' : 'false',
            onClick: function () { setGroupBy(id); }
          }, t('groupBy.' + id));
        })),
        Array.isArray(groupOrder[groupBy]) && groupOrder[groupBy].length > 0 ? h(Btn, {
          key: 'resetOrder',
          className: 'sm-reset-order',
          title: t('group.resetOrder'),
          onClick: resetGroupOrder
        }, t('group.resetOrder')) : null,
        h('label', { key: 'archive', className: 'sm-select' }, [
          h('span', { key: 'label', className: 'sm-select-label' }, t('toolbar.archive')),
          h('select', {
            key: 'control',
            value: archiveView,
            onChange: function (event) { setArchiveView(event.target.value); }
          }, ARCHIVE_VIEWS.map(function (id) {
            return h('option', { key: id, value: id }, t('archive.' + id));
          }))
        ]),
        h('label', { key: 'subagents', className: 'sm-check-label' }, [
          h('input', {
            key: 'input',
            type: 'checkbox',
            checked: showSubagents,
            onChange: function (event) { setShowSubagents(event.target.checked); }
          }),
          h('span', { key: 'text' }, t('toolbar.showSubagents'))
        ]),
        h('span', { key: 'spacer', className: 'sm-toolbar-spacer' }),
        h('div', { key: 'jobs', className: 'sm-jobs' }, [
          h(JobsIndicator, {
            key: 'trigger',
            activeJobs: activeJobs,
            latest: latestJob,
            open: jobsOpen,
            unavailable: jobsUnavailable,
            onToggle: function () { setJobsOpen(!jobsOpen); }
          }),
          jobsOpen && !jobsUnavailable ? h(JobsPanel, {
            key: 'panel',
            jobs: jobsSorted,
            expandedId: jobsExpanded,
            itemsById: jobItems,
            loadingId: jobLoading,
            cancellingIds: cancelling,
            onCancel: cancelJob,
            onToggle: toggleJobDetail
          }) : null
        ]),
        h(Btn, {
          key: 'aiRename',
          disabled: busy || aiBlocked(),
          title: aiReason(),
          onClick: function () { startRenamePreview(); }
        }, t('toolbar.aiRename')),
        h(Btn, {
          key: 'fill',
          disabled: busy || aiBlocked(),
          title: aiReason(),
          onClick: startFillMissing
        }, t('toolbar.aiTags')),
        h(Btn, { key: 'rules', onClick: function () { setDialog({ type: 'rules' }); } }, t('toolbar.rules')),
        h(Btn, { key: 'tagManager', onClick: function () { setDialog({ type: 'tagManager' }); } }, t('toolbar.tagManager')),
        h(Btn, { key: 'trash', disabled: busy, onClick: function () { setDialog({ type: 'trash' }); } }, t('toolbar.trash'))
      ]);

      var filterBar = h('div', { key: 'filters', className: 'sm-filters' }, [
        h('span', { key: 'title', className: 'sm-filters-title' }, t('filter.title')),
        h('div', { key: 'status', className: 'sm-filter-group' }, STATUS_IDS.map(function (id) {
          var activeFilter = filters.statuses.indexOf(id) >= 0;
          return h('button', {
            key: id,
            type: 'button',
            className: cx('sm-filter-chip', activeFilter && 'sm-filter-chip-active'),
            'aria-pressed': activeFilter ? 'true' : 'false',
            onClick: function () { toggleFilter('statuses', id); }
          }, [h(StatusDot, { key: 'dot', status: id }), h('span', { key: 'label' }, statusLabel(id))]);
        })),
        h('div', { key: 'bucket', className: 'sm-filter-group' }, BUCKET_IDS.map(function (id) {
          var activeFilter = filters.buckets.indexOf(id) >= 0;
          return h('button', {
            key: id,
            type: 'button',
            className: cx('sm-filter-chip', activeFilter && 'sm-filter-chip-active'),
            'aria-pressed': activeFilter ? 'true' : 'false',
            onClick: function () { toggleFilter('buckets', id); }
          }, t('bucket.' + id));
        })),
        h('div', { key: 'tags', className: 'sm-filter-group sm-filter-tags' }, [
          h('select', {
            key: 'select',
            className: 'sm-tag-select',
            value: '',
            'aria-label': t('filter.addTag'),
            onChange: function (event) {
              var value = event.target.value;
              if (value) toggleFilter('tags', value);
              event.target.value = '';
            }
          }, [h('option', { key: '', value: '' }, t('filter.addTag'))].concat(tagOptions.map(function (tag) {
            return h('option', { key: tag, value: tag }, tag);
          }))),
          filters.tags.map(function (tag) {
            return h(Chip, {
              key: 'tag:' + tag,
              label: tag,
              removable: true,
              onRemove: function () { toggleFilter('tags', tag); }
            });
          })
        ]),
        h('span', { key: 'spacer', className: 'sm-toolbar-spacer' }),
        h(Btn, {
          key: 'clear',
          disabled: filters.statuses.length === 0 && filters.buckets.length === 0 && filters.tags.length === 0,
          onClick: clearFilters
        }, t('filter.clear'))
      ]);

      var body = null;
      if (phase === 'loading') {
        body = h('div', { key: 'loading', className: 'sm-body-loading' }, h(SkeletonList, {
          hint: indexing && indexing.running ? indexText : t('common.loading')
        }));
      } else if (phase === 'error') {
        body = h('div', { key: 'error', className: 'sm-error-wrap' }, h(EmptyState, {
          icon: '!',
          title: t('error.title'),
          body: [
            error && error.message ? error.message : '',
            ' ',
            t('error.host')
          ].join(' ').trim(),
          action: h('div', { key: 'actions', className: 'sm-error-actions' }, [
            h(Btn, { key: 'retry', variant: 'primary', onClick: function () { load(); } }, t('action.retry')),
            error ? h('span', { key: 'code', className: 'sm-error-code' }, tf('error.code', { code: error.code })) : null
          ])
        }));
      } else if (rows.length === 0) {
        body = h('div', { key: 'empty', className: 'sm-empty-wrap' }, h(EmptyState, {
          icon: '○',
          title: t('list.empty.title'),
          body: t('list.empty.body')
        }));
      } else if (visible.length === 0) {
        body = h('div', { key: 'filtered', className: 'sm-empty-wrap' }, h(EmptyState, {
          icon: '○',
          title: t('list.filtered.title'),
          body: t('list.filtered.body'),
          action: h(Btn, { key: 'clear', onClick: function () { clearFilters(); setQuery(''); } }, t('filter.clear'))
        }));
      } else {
        body = h('div', { key: 'groups', className: 'sm-groups' }, [
          groupBy === 'tag' ? h('p', { key: 'hint', className: 'sm-groups-hint' }, t('group.duplicateHint')) : null
        ].concat(groups.map(function (group, groupIndex) {
          var isCollapsed = collapsed.indexOf(group.key) >= 0;
          var isDragging = dragGroup === group.key;
          var isDropTarget = Boolean(dragGroup) && dragGroup !== group.key && dropGroup === group.key;
          var reorderable = groups.length > 1;
          /* PRD §7.1 拖动排序 (v0.3.1): drag the ⠿ handle, or use ↑/↓ for keyboard. */
          var dragHandle = reorderable ? h('button', {
            key: 'drag',
            type: 'button',
            className: 'sm-group-drag',
            draggable: 'true',
            title: t('group.dragHint'),
            'aria-label': tf('group.dragAria', { name: groupLabel(group) }),
            onDragStart: function (event) {
              setDragGroup(group.key);
              setDropGroup(null);
              if (event && event.dataTransfer) {
                try {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', group.key);
                } catch (error) { /* older engines */ }
              }
            },
            onDragEnd: function () { setDragGroup(null); setDropGroup(null); }
          }, '⠿') : null;
          var moveButtons = reorderable ? h('span', { key: 'moves', className: 'sm-group-moves' }, [
            h('button', {
              key: 'up',
              type: 'button',
              className: 'sm-group-move',
              disabled: groupIndex === 0,
              title: t('group.moveUp'),
              'aria-label': t('group.moveUp'),
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
                nudgeGroup(group.key, -1);
              }
            }, '↑'),
            h('button', {
              key: 'down',
              type: 'button',
              className: 'sm-group-move',
              disabled: groupIndex === groups.length - 1,
              title: t('group.moveDown'),
              'aria-label': t('group.moveDown'),
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
                nudgeGroup(group.key, 1);
              }
            }, '↓')
          ]) : null;
          return h('section', {
            key: group.key,
            className: cx('sm-group', isDragging && 'sm-group-dragging', isDropTarget && 'sm-group-drop'),
            onDragOver: function (event) {
              if (!dragGroup || dragGroup === group.key) return;
              if (event && event.preventDefault) event.preventDefault();
              if (event && event.dataTransfer) {
                try { event.dataTransfer.dropEffect = 'move'; } catch (error) { /* ignore */ }
              }
              if (dropGroup !== group.key) setDropGroup(group.key);
            },
            onDragLeave: function () {
              if (dropGroup === group.key) setDropGroup(null);
            },
            onDrop: function (event) {
              if (event && event.preventDefault) event.preventDefault();
              if (dragGroup && dragGroup !== group.key) moveGroupTo(dragGroup, group.key);
              else setDropGroup(null);
            }
          }, [
            h('div', { key: 'headrow', className: 'sm-group-head-row' }, [
              dragHandle,
              h('button', {
                key: 'head',
                type: 'button',
                className: 'sm-group-head',
                'aria-expanded': isCollapsed ? 'false' : 'true',
                onClick: function () { toggleCollapsedGroup(group.key); }
              }, [
              h('span', { key: 'caret', className: cx('sm-caret', !isCollapsed && 'sm-caret-open'), 'aria-hidden': 'true' }, '›'),
              h('span', { key: 'name', className: 'sm-group-name' }, groupLabel(group)),
              h('span', { key: 'total', className: 'sm-group-total' }, tf('group.total', { n: group.total })),
              h('span', { key: 'counts', className: 'sm-group-counts' }, GROUP_COUNT_IDS.map(function (id) {
                if (!group.counts[id]) return null;
                return h('span', { key: id, className: 'sm-group-count', title: statusLabel(id) }, [
                  h(StatusDot, { key: 'dot', status: id }),
                  h('span', { key: 'n', className: 'sm-group-count-n' }, String(group.counts[id]))
                ]);
              }))
            ]),
              moveButtons
            ]),
            isCollapsed ? null : h('div', { key: 'rows', className: 'sm-group-rows' }, group.rows.map(function (row) {
              return h(Row, {
                key: row.id,
                row: row,
                selected: selected.indexOf(row.id) >= 0,
                active: rowFocus === row.id,
                onSelect: toggleSelected,
                onActivate: setRowFocus,
                onOpenSession: jumpToSession,
                onOpenDetail: openDetail,
                onContextMenu: openRowMenu,
                onPluginMenu: openPluginRowMenu,
                onAction: handleRowAction
              });
            }))
          ]);
        })));
      }

      var batchBar = selected.length > 0 ? h('div', { key: 'batch', className: 'sm-batch' }, [
        h('span', { key: 'count', className: 'sm-batch-count' }, tf('batch.selected', { n: selected.length })),
        h('span', { key: 'hint', className: 'sm-batch-hint' }, t('batch.skipHint')),
        h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
        h(Btn, {
          key: 'rename',
          disabled: busy || aiBlocked() || selectedActionable.length === 0,
          title: aiReason(),
          onClick: function () { startRenamePreview(selectedActionable.map(function (row) { return row.id; })); }
        }, t('batch.rename')),
        h(Btn, {
          key: 'aiTags',
          disabled: busy || aiBlocked() || selectedActionable.length === 0,
          title: aiReason(),
          onClick: function () { startTagsPreview(selectedActionable.map(function (row) { return row.id; })); }
        }, t('toolbar.aiTags')),
        h(Btn, { key: 'append', disabled: busy || selectedActionable.length === 0, onClick: function () { setDialog({ type: 'tags', ids: selectedActionable.map(function (row) { return row.id; }), mode: 'append' }); } }, t('batch.appendTags')),
        h(Btn, { key: 'replace', disabled: busy || selectedActionable.length === 0, onClick: function () { setDialog({ type: 'tags', ids: selectedActionable.map(function (row) { return row.id; }), mode: 'replace' }); } }, t('batch.replaceTags')),
        h(Btn, { key: 'clearTags', disabled: busy || selectedActionable.length === 0, onClick: function () { setDialog({ type: 'tags', ids: selectedActionable.map(function (row) { return row.id; }), mode: 'clear' }); } }, t('batch.clearTags')),
        h(Btn, {
          key: 'archive',
          disabled: busy || selectedActionable.filter(function (row) { return !row.archived; }).length === 0,
          onClick: function () {
            archiveRows(selectedActionable.filter(function (row) { return !row.archived; }).map(function (row) { return row.id; }), false);
          }
        }, t('batch.archive')),
        h(Btn, {
          key: 'unarchive',
          disabled: busy || selectedActionable.filter(function (row) { return row.archived; }).length === 0,
          onClick: function () {
            archiveRows(selectedActionable.filter(function (row) { return row.archived; }).map(function (row) { return row.id; }), true);
          }
        }, t('batch.unarchive')),
        h(Btn, { key: 'trash', variant: 'danger', disabled: busy, onClick: function () { setDialog({ type: 'delete', ids: selectedRows.map(function (row) { return row.id; }) }); } }, t('batch.trash')),
        h(Btn, { key: 'clearSel', disabled: busy, onClick: function () { setSelected([]); } }, t('batch.clearSelection'))
      ]) : null;

      var dialogs = null;
      if (dialog) {
        if (dialog.type === 'renamePreview') {
          dialogs = h(RenamePreviewDialog, {
            key: 'dialog',
            items: dialog.items,
            model: dialog.model,
            modelSelection: dialog.modelSelection,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onApply: applyRename
          });
        } else if (dialog.type === 'tagsPreview') {
          dialogs = h(TagsPreviewDialog, {
            key: 'dialog',
            items: dialog.items,
            vocabulary: dialog.vocabulary,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onApply: applyTagsPreview
          });
        } else if (dialog.type === 'tags') {
          dialogs = h(TagEditorDialog, {
            key: 'dialog',
            ids: dialog.ids,
            mode: dialog.mode,
            initial: dialog.initial || [],
            tagDefs: meta && Array.isArray(meta.tagDefs) ? meta.tagDefs : [],
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onCommit: commitTags
          });
        } else if (dialog.type === 'renameOne') {
          dialogs = h(RenameOneDialog, {
            key: 'dialog',
            row: dialog.row,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onCommit: commitRename
          });
        } else if (dialog.type === 'note') {
          dialogs = h(NoteDialog, {
            key: 'dialog',
            row: dialog.row,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onCommit: commitNote
          });
        } else if (dialog.type === 'delete') {
          dialogs = h(DeleteDialog, {
            key: 'dialog',
            ids: dialog.ids,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onConfirm: trashRows
          });
        } else if (dialog.type === 'trash') {
          dialogs = h(TrashDialog, {
            key: 'dialog',
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onRestored: function () { refreshSilently(); }
          });
        } else if (dialog.type === 'fillMissing') {
          dialogs = h(FillMissingDialog, {
            key: 'dialog',
            candidates: dialog.candidates,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onApply: applyFillMissing
          });
        } else if (dialog.type === 'archiveConfirm') {
          dialogs = h(ArchiveConfirmDialog, {
            key: 'dialog',
            row: dialog.row,
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onConfirm: function () {
              var target = dialog.row;
              setDialog(null);
              archiveSession(target, true);
            }
          });
        } else if (dialog.type === 'rules') {
          dialogs = h(RulesDialog, {
            key: 'dialog',
            rules: meta && Array.isArray(meta.rules) ? meta.rules : [],
            tagDefs: meta && Array.isArray(meta.tagDefs) ? meta.tagDefs : [],
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onChanged: function () { refreshSilently(); },
            onError: fail
          });
        } else if (dialog.type === 'tagManager') {
          dialogs = h(TagManagerDialog, {
            key: 'dialog',
            busy: busy,
            onClose: function () { if (!busy) setDialog(null); },
            onChanged: function () { refreshSilently(); }
          });
        }
      }

      var contextMenu = rowMenu && rowById[rowMenu.rowId] ? h(RowMenu, {
        key: 'row-menu',
        items: rowMenu.plugin
          ? pluginMenuItemsFor(rowById[rowMenu.rowId], serviceCaps())
          : menuItemsFor(rowById[rowMenu.rowId], serviceCaps()),
        anchor: rowMenu.anchor,
        viewport: rowMenu.viewport,
        onPick: pickMenuItem,
        onClose: function () { closeRowMenu(true); }
      }) : null;

      var detailRow = detailId ? (rowById[detailId] || rowFromCache(detailId)) : null;
      var detailPane = detailId ? h('div', {
        key: 'detail',
        className: 'sm-split-detail',
        role: 'complementary',
        'aria-label': t('detail.title')
      }, h(DetailPane, {
        sessionId: detailId,
        row: detailRow,
        onClose: closeDetail,
        onChanged: function () { load({ silent: true }); }
      })) : null;
      var listColumn = h('div', { key: 'list', className: 'sm-split-list' }, [
        h('div', { key: 'body', className: 'sm-body' }, body),
        batchBar
      ]);
      var split = h('div', {
        key: 'split',
        className: cx('sm-split', detailPane && 'sm-split-open')
      }, detailPane ? [listColumn, detailPane] : [listColumn]);

      return h('div', { className: 'sm-page', tabIndex: 0, ref: pageRef, onKeyDown: handlePanelKeyDown }, [
        header,
        overviewBar,
        toolbar,
        filterBar,
        h(Notice, { key: 'notice', notice: notice, onClose: function () { setNotice(null); } }),
        refreshing && phase === 'ready' ? h('div', { key: 'refreshing', className: 'sm-refresh-bar', role: 'status' }, t('common.refreshing')) : null,
        split,
        dialogs,
        contextMenu
      ]);
    }

    function SidebarIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 20;
      return h('svg', {
        className: 'sm-panel-icon',
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        'aria-hidden': 'true'
      }, [
        h('rect', { key: 'r1', x: '2.75', y: '2.75', width: '14.5', height: '14.5', rx: '3.5', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', { key: 'l1', d: 'M2.75 7.25h14.5', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', { key: 'l2', d: 'M7.25 7.25v10', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', { key: 't1', d: 'M9.75 10.5h4.5', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }),
        h('path', { key: 't2', d: 'M9.75 13.5h2.75', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' })
      ]);
    }


    /* ------------------------------------------------------------------ *
     * Tag input helpers shared by the tag dialogs
     * ------------------------------------------------------------------ */

    function mergeTagList(list, raw) {
      var next = Array.isArray(list) ? list.slice() : [];
      var seen = {};
      for (var index = 0; index < next.length; index += 1) seen[next[index].toLowerCase()] = true;
      var candidates = parseTagInput(raw);
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var tag = candidates[candidateIndex];
        var key = tag.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        next.push(tag);
      }
      return next;
    }

    function TagPicker(props) {
      var value = props.value || [];
      var state = useState('');
      var draft = state[0];
      var setDraft = state[1];
      var vocabulary = props.vocabulary || [];
      var suggestions = vocabulary.filter(function (tag) { return value.indexOf(tag) < 0; }).slice(0, 24);
      function add(raw) {
        var next = mergeTagList(value, raw);
        if (next.length !== value.length && props.onChange) props.onChange(next);
        setDraft('');
      }
      return h('div', { className: 'sm-tag-picker' }, [
        h('div', { key: 'chips', className: 'sm-tag-picker-chips' }, value.length > 0
          ? value.map(function (tag) {
            return h(Chip, {
              key: 'tag:' + tag,
              label: tag,
              removable: true,
              onRemove: function () {
                if (props.onChange) props.onChange(value.filter(function (entry) { return entry !== tag; }));
              }
            });
          })
          : h('span', { key: 'empty', className: 'sm-hint' }, t('tagEditor.empty'))),
        h('div', { key: 'input-row', className: 'sm-tag-input-row' }, [
          h('input', {
            key: 'input',
            type: 'text',
            className: 'sm-input',
            value: draft,
            placeholder: props.placeholder || t('tagEditor.placeholder'),
            onChange: function (event) { setDraft(event.target.value); },
            onKeyDown: function (event) {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                add(event.target.value);
              } else if (event.key === 'Backspace' && event.target.value === '' && value.length > 0) {
                if (props.onChange) props.onChange(value.slice(0, -1));
              }
            },
            onBlur: function (event) { if (event.target.value.trim()) add(event.target.value); }
          }),
          h(Btn, {
            key: 'add',
            disabled: !draft.trim(),
            onClick: function () { add(draft); }
          }, t('action.apply'))
        ]),
        suggestions.length > 0 ? h('div', { key: 'suggestions', className: 'sm-tag-suggestions' }, [
          h('span', { key: 'label', className: 'sm-hint' }, t('tagEditor.vocabulary')),
          suggestions.map(function (tag) {
            return h('button', {
              key: 's:' + tag,
              type: 'button',
              className: 'sm-suggestion',
              onClick: function () { add(tag); }
            }, tag);
          })
        ]) : null
      ]);
    }

    /* ------------------------------------------------------------------ *
     * AI rename preview — zero writes; per-item removal; apply leftovers.
     * ------------------------------------------------------------------ */

    function RenamePreviewDialog(props) {
      var removedState = useState([]);
      var removed = removedState[0];
      var setRemoved = removedState[1];
      var items = Array.isArray(props.items) ? props.items : [];
      var candidates = items.filter(function (item) { return !item.skipReason; });
      var kept = candidates.filter(function (item) { return removed.indexOf(item.sessionId) < 0; });

      function toggle(id) { setRemoved(function (previous) { return toggleValue(previous, id); }); }
      function apply() {
        props.onApply(kept.map(function (item) { return { sessionId: item.sessionId, title: item.proposed }; }));
      }

      var footer = [
        h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('batch.selected', { n: kept.length })),
        h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
        h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
        h(Btn, { key: 'apply', variant: 'primary', disabled: props.busy || kept.length === 0, onClick: apply }, tf('rename.apply', { n: kept.length }))
      ];

      var content;
      if (items.length === 0) {
        content = h(EmptyState, { key: 'empty', icon: '○', title: t('rename.empty') });
      } else {
        content = h('div', { key: 'list', className: 'sm-preview-list' }, items.map(function (item) {
          var isRemoved = removed.indexOf(item.sessionId) >= 0;
          var skipped = Boolean(item.skipReason);
          return h('div', {
            key: item.sessionId,
            className: cx('sm-preview-item', skipped && 'sm-preview-item-skipped', isRemoved && 'sm-preview-item-removed')
          }, [
            h('div', { key: 'main', className: 'sm-preview-main' }, [
              h('div', { key: 'titles', className: 'sm-preview-title' }, [
                h('span', { key: 'old', className: 'sm-preview-old' }, item.currentTitle || t('row.noTitle')),
                h('span', { key: 'arrow', className: 'sm-preview-arrow', 'aria-hidden': 'true' }, '→'),
                h('span', { key: 'new', className: 'sm-preview-new' }, item.proposed || t('common.none'))
              ]),
              item.reason ? h('p', { key: 'reason', className: 'sm-preview-reason' }, item.reason) : null,
              item.detail && !skipped ? h('p', { key: 'detail', className: 'sm-hint' }, item.detail) : null,
              skipped ? h('span', {
                key: 'skip',
                className: 'sm-skip-badge',
                title: item.detail || ''
              }, t('rename.skip') + ': ' + skipLabel(item.skipReason)) : null,
              skipped && item.detail ? h('p', { key: 'skip-detail', className: 'sm-hint' }, item.detail) : null
            ]),
            h('div', { key: 'actions', className: 'sm-preview-actions' }, skipped ? null : h(Btn, {
              key: 'toggle',
              disabled: props.busy,
              onClick: function () { toggle(item.sessionId); }
            }, isRemoved ? t('rename.keep') : t('rename.remove')))
          ]);
        }));
      }

      return h(DialogShell, {
        title: t('rename.title'),
        subtitle: t('rename.subtitle'),
        busy: props.busy,
        wide: true,
        onClose: props.onClose,
        footer: footer
      }, [
        content,
        props.model ? h('p', {
          key: 'model',
          className: 'sm-dialog-note',
          title: props.modelSelection ? props.modelSelection.provider + '/' + props.modelSelection.model : ''
        }, tf('rename.model', { name: props.model })) : null
      ]);
    }

    /* ------------------------------------------------------------------ *
     * AI tag preview — suggestions are editable before apply.
     * ------------------------------------------------------------------ */

    function TagsPreviewDialog(props) {
      var items = Array.isArray(props.items) ? props.items : [];
      var initial = useState(function () {
        var map = {};
        for (var index = 0; index < items.length; index += 1) {
          var item = items[index];
          map[item.sessionId] = Array.isArray(item.suggestions) ? item.suggestions.slice() : [];
        }
        return map;
      });
      var edits = initial[0];
      var setEdits = initial[1];
      var draftState = useState({});
      var drafts = draftState[0];
      var setDrafts = draftState[1];

      function update(id, tags) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous);
          next[id] = tags;
          return next;
        });
      }
      function addTag(id, raw) {
        var next = mergeTagList(edits[id] || [], raw);
        update(id, next);
        setDrafts(function (previous) {
          var nextDrafts = Object.assign({}, previous);
          nextDrafts[id] = '';
          return nextDrafts;
        });
      }
      var payable = items.filter(function (item) {
        return !item.skipReason && (edits[item.sessionId] || []).length > 0;
      });
      function apply() {
        props.onApply(payable.map(function (item) {
          return { sessionId: item.sessionId, tags: edits[item.sessionId], intent: item.intent || null };
        }));
      }

      var content;
      if (items.length === 0) {
        content = h(EmptyState, { key: 'empty', icon: '○', title: t('tagsPreview.empty') });
      } else {
        content = h('div', { key: 'list', className: 'sm-preview-list' }, items.map(function (item) {
          var skipped = Boolean(item.skipReason);
          var tags = edits[item.sessionId] || [];
          return h('div', {
            key: item.sessionId,
            className: cx('sm-preview-item', skipped && 'sm-preview-item-skipped')
          }, [
            h('div', { key: 'main', className: 'sm-preview-main' }, [
              h('div', { key: 'title', className: 'sm-preview-title' }, item.title || item.currentTitle || item.sessionId),
              item.reason ? h('p', { key: 'reason', className: 'sm-preview-reason' }, item.reason) : null,
              item.detail && !skipped ? h('p', { key: 'detail', className: 'sm-hint' }, item.detail) : null,
              skipped ? h('span', {
                key: 'skip',
                className: 'sm-skip-badge',
                title: item.detail || ''
              }, t('rename.skip') + ': ' + skipLabel(item.skipReason)) : null,
              skipped && item.detail ? h('p', { key: 'skip-detail', className: 'sm-hint' }, item.detail) : null,
              skipped ? null : h('div', { key: 'tags', className: 'sm-preview-tags' }, [
                h('div', { key: 'chips', className: 'sm-preview-chips' }, tags.map(function (tag) {
                  return h(Chip, {
                    key: 'tag:' + tag,
                    label: tag,
                    removable: true,
                    onRemove: function () { update(item.sessionId, tags.filter(function (entry) { return entry !== tag; })); }
                  });
                })),
                h('input', {
                  key: 'input',
                  type: 'text',
                  className: 'sm-input sm-input-inline',
                  value: drafts[item.sessionId] || '',
                  placeholder: t('tagsPreview.addPlaceholder'),
                  onChange: function (event) {
                    var value = event.target.value;
                    setDrafts(function (previous) {
                      var next = Object.assign({}, previous);
                      next[item.sessionId] = value;
                      return next;
                    });
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (event.target.value.trim()) addTag(item.sessionId, event.target.value);
                    }
                  }
                })
              ])
            ]),
            h('div', { key: 'side', className: 'sm-preview-side' }, [
              item.intent ? h('span', { key: 'intent', className: 'sm-intent' }, t('tagsPreview.intent') + ': ' + item.intent) : null
            ])
          ]);
        }));
      }

      var footer = [
        h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('tagsPreview.apply', { n: payable.length })),
        h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
        h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
        h(Btn, { key: 'apply', variant: 'primary', disabled: props.busy || payable.length === 0, onClick: apply }, t('action.apply'))
      ];

      return h(DialogShell, {
        title: t('tagsPreview.title'),
        subtitle: t('tagsPreview.subtitle'),
        busy: props.busy,
        wide: true,
        onClose: props.onClose,
        footer: footer
      }, content);
    }

    /* ------------------------------------------------------------------ *
     * Tag editor (append / replace / clear)
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * v0.3.2 tag manager — the vocabulary is user data, so it gets its own
     * CRUD surface: create, rename (merging onto an existing word) and delete
     * all propagate to Sessions and rules in one host call.
     * ------------------------------------------------------------------ */

    function tagDefUsageLabel(def) {
      var parts = [];
      if (def.sessions > 0) parts.push(tf('tagManager.usage', { n: def.sessions }));
      if (def.suggested > 0) parts.push(tf('tagManager.suggestedUsage', { n: def.suggested }));
      return parts.join(' · ');
    }

    function TagManagerDialog(props) {
      var defsState = useState([]);
      var defs = defsState[0];
      var setDefs = defsState[1];
      var queryState = useState('');
      var query = queryState[0];
      var setQuery = queryState[1];
      var draftState = useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];
      var editingState = useState(null);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var editValueState = useState('');
      var editValue = editValueState[0];
      var setEditValue = editValueState[1];
      var confirmingState = useState(null);
      var confirming = confirmingState[0];
      var setConfirming = confirmingState[1];
      var busyState = useState(false);
      var localBusy = busyState[0];
      var setLocalBusy = busyState[1];
      var statusState = useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var loadedState = useState(false);
      var loaded = loadedState[0];
      var setLoaded = loadedState[1];

      function adopt(body) {
        if (body && Array.isArray(body.tagDefs)) setDefs(body.tagDefs);
      }

      function load() {
        request(API_PATHS.tagDefs).then(function (body) {
          adopt(body);
          setLoaded(true);
        }, function (cause) {
          setLoaded(true);
          setStatus({ kind: 'error', text: cause && cause.message ? cause.message : String(cause) });
        });
      }

      useEffect(function () { load(); }, []);

      function report(cause) {
        setLocalBusy(false);
        setStatus({ kind: 'error', text: cause && cause.message ? cause.message : String(cause) });
      }

      function changed() {
        if (props.onChanged) props.onChanged();
      }

      function submit(op, payload, done) {
        setLocalBusy(true);
        setStatus(null);
        postJson(API_PATHS.tagDefs, Object.assign({ op: op }, payload)).then(function (body) {
          setLocalBusy(false);
          adopt(body);
          if (done) done(body);
          changed();
        }, report);
      }

      function create() {
        var name = draft.trim();
        if (!name) return;
        submit('create', { name: name }, function () {
          setDraft('');
          setStatus({ kind: 'info', text: tf('notice.tagCreated', { tag: name }) });
        });
      }

      function startRename(def) {
        setEditing(def.name);
        setEditValue(def.name);
        setConfirming(null);
        setStatus(null);
      }

      function commitRename(def) {
        var to = editValue.trim();
        if (!to || to === def.name) { setEditing(null); return; }
        submit('rename', { name: def.name, to: to }, function () {
          setEditing(null);
          setStatus({ kind: 'info', text: tf('notice.tagRenamed', { tag: to, n: def.sessions }) });
        });
      }

      function remove(def) {
        submit('remove', { name: def.name }, function () {
          setConfirming(null);
          setStatus({ kind: 'info', text: tf('notice.tagRemoved', { tag: def.name, n: def.sessions }) });
        });
      }

      var needle = query.trim().toLowerCase();
      var visible = defs.filter(function (def) {
        return needle === '' || String(def.name).toLowerCase().indexOf(needle) >= 0;
      });
      var names = {};
      for (var index = 0; index < defs.length; index += 1) names[String(defs[index].name).toLowerCase()] = true;
      var mergeWarning = draft.trim() !== '' && Boolean(names[draft.trim().toLowerCase()]);

      var createRow = h('div', { key: 'create', className: 'sm-tagmanage-create' }, [
        h('input', {
          key: 'input',
          type: 'text',
          className: 'sm-input',
          value: draft,
          maxLength: 24,
          placeholder: t('tagManager.newPlaceholder'),
          'aria-label': t('tagManager.new'),
          onChange: function (event) { setDraft(event.target.value); },
          onKeyDown: function (event) { if (event.key === 'Enter') create(); }
        }),
        h(Btn, { key: 'add', variant: 'primary', disabled: localBusy || draft.trim() === '', onClick: create }, t('tagManager.create'))
      ]);

      var listBody;
      if (!loaded) {
        listBody = h('p', { key: 'loading', className: 'sm-hint' }, t('common.loading'));
      } else if (visible.length === 0) {
        listBody = h(EmptyState, {
          key: 'empty',
          icon: '○',
          title: needle === '' ? t('tagManager.empty') : t('tagManager.search'),
          body: needle === '' ? t('tagManager.emptyHint') : undefined
        });
      } else {
        listBody = h('ul', { key: 'list', className: 'sm-tagmanage-list' }, visible.map(function (def) {
          var isEditing = editing === def.name;
          var isConfirming = confirming === def.name;
          var usage = tagDefUsageLabel(def);
          return h('li', { key: def.name, className: 'sm-tagmanage-item' }, [
            h('div', { key: 'main', className: 'sm-tagmanage-main' }, [
              isEditing
                ? h('div', { key: 'edit', className: 'sm-tagmanage-edit' }, [
                  h('input', {
                    key: 'input',
                    type: 'text',
                    className: 'sm-input',
                    value: editValue,
                    maxLength: 24,
                    autoFocus: true,
                    'aria-label': t('tagManager.rename'),
                    onChange: function (event) { setEditValue(event.target.value); },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') commitRename(def);
                      else if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); }
                    }
                  }),
                  h(Btn, { key: 'save', variant: 'primary', disabled: localBusy, onClick: function () { commitRename(def); } }, t('action.save')),
                  h(Btn, { key: 'cancel', disabled: localBusy, onClick: function () { setEditing(null); } }, t('action.cancel'))
                ])
                : h('div', { key: 'head', className: 'sm-tagmanage-head' }, [
                  h('span', { key: 'name', className: 'sm-tagmanage-name' }, def.name),
                  h('span', { key: 'source', className: 'sm-badge' }, t('tagManager.source.' + (def.source || 'manual'))),
                  usage ? h('span', { key: 'usage', className: 'sm-hint' }, usage) : h('span', { key: 'unused', className: 'sm-hint' }, t('common.none'))
                ]),
              isConfirming ? h('p', { key: 'confirm', className: 'sm-dialog-warning' }, [
                h('strong', { key: 'title', className: 'sm-tagmanage-confirm-title' }, tf('tagManager.removeTitle', { tag: def.name })),
                ' ',
                tf('tagManager.removeHint', { n: def.sessions }),
                ' ',
                h('button', { key: 'go', type: 'button', className: 'sm-link-btn', disabled: localBusy, onClick: function () { remove(def); } }, t('action.confirm')),
                ' ',
                h('button', { key: 'no', type: 'button', className: 'sm-link-btn', disabled: localBusy, onClick: function () { setConfirming(null); } }, t('action.cancel'))
              ]) : null
            ]),
            h('div', { key: 'actions', className: 'sm-tagmanage-actions' }, [
              h(Btn, { key: 'rename', disabled: localBusy || isEditing, onClick: function () { startRename(def); } }, t('tagManager.rename')),
              h(Btn, {
                key: 'remove',
                variant: 'danger',
                disabled: localBusy || isConfirming,
                onClick: function () { setConfirming(def.name); setEditing(null); }
              }, t('tagManager.remove'))
            ])
          ]);
        }));
      }

      return h(DialogShell, {
        title: t('tagManager.title'),
        subtitle: t('tagManager.subtitle'),
        busy: props.busy || localBusy,
        wide: true,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('tagManager.count', { n: defs.length })),
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'close', disabled: props.busy, onClick: props.onClose }, t('action.close'))
        ]
      }, [
        h('div', { key: 'head', className: 'sm-tagmanage-toolbar' }, [
          createRow,
          h('input', {
            key: 'search',
            type: 'text',
            className: 'sm-search sm-tagmanage-search',
            value: query,
            placeholder: t('tagManager.search'),
            'aria-label': t('tagManager.search'),
            onChange: function (event) { setQuery(event.target.value); }
          })
        ]),
        mergeWarning ? h('p', { key: 'merge', className: 'sm-hint' }, t('tagManager.mergeHint')) : null,
        status ? h('p', { key: 'status', className: cx('sm-status-text', status.kind === 'error' && 'sm-status-error') }, status.text) : null,
        listBody
      ]);
    }

    function TagEditorDialog(props) {
      var state = useState(function () { return Array.isArray(props.initial) ? props.initial.slice() : []; });
      var tags = state[0];
      var setTags = state[1];
      var mode = props.mode;
      var vocabulary = (props.tagDefs || []).map(function (def) { return def && def.name; }).filter(Boolean);
      var count = Array.isArray(props.ids) ? props.ids.length : 0;

      var footer = [
        h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('batch.selected', { n: count })),
        h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
        h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
        h(Btn, {
          key: 'confirm',
          variant: mode === 'clear' ? 'danger' : 'primary',
          disabled: props.busy || (mode !== 'clear' && tags.length === 0),
          onClick: function () { props.onCommit(mode, tags); }
        }, mode === 'clear' ? t('action.confirm') : t('action.apply'))
      ];

      return h(DialogShell, {
        title: t('tagEditor.title.' + mode),
        subtitle: mode === 'clear' ? tf('tagEditor.clearWarning', { n: count }) : t('tagEditor.body'),
        busy: props.busy,
        onClose: props.onClose,
        footer: footer
      }, mode === 'clear'
        ? h('p', { key: 'warn', className: 'sm-dialog-warning' }, tf('tagEditor.clearWarning', { n: count }))
        : h(TagPicker, { key: 'picker', value: tags, onChange: setTags, vocabulary: vocabulary }));
    }

    /* ------------------------------------------------------------------ *
     * Manual rename / note
     * ------------------------------------------------------------------ */

    function RenameOneDialog(props) {
      var row = props.row || {};
      var state = useState(row.title || '');
      var title = state[0];
      var setTitle = state[1];
      var trimmed = title.trim();
      return h(DialogShell, {
        title: t('renameOne.title'),
        subtitle: t('renameOne.lockHint'),
        busy: props.busy,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
          h(Btn, {
            key: 'save',
            variant: 'primary',
            disabled: props.busy || trimmed === '' || trimmed === (row.title || ''),
            onClick: function () { props.onCommit(row.id, trimmed); }
          }, t('action.save'))
        ]
      }, h('label', { key: 'field', className: 'sm-form-row' }, [
        h('span', { key: 'label', className: 'sm-form-label' }, t('renameOne.titleLabel')),
        h('input', {
          key: 'input',
          type: 'text',
          className: 'sm-input',
          value: title,
          maxLength: 120,
          autoFocus: true,
          onChange: function (event) { setTitle(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && trimmed !== '') props.onCommit(row.id, trimmed);
          }
        })
      ]));
    }

    function NoteDialog(props) {
      var row = props.row || {};
      var state = useState(typeof row.note === 'string' ? row.note : '');
      var note = state[0];
      var setNote = state[1];
      return h(DialogShell, {
        title: t('note.title'),
        subtitle: row.title || row.id,
        busy: props.busy,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
          h(Btn, {
            key: 'save',
            variant: 'primary',
            disabled: props.busy,
            onClick: function () { props.onCommit(row.id, note); }
          }, t('note.save'))
        ]
      }, h('textarea', {
        key: 'textarea',
        className: 'sm-textarea',
        value: note,
        rows: 6,
        maxLength: 2000,
        placeholder: t('note.placeholder'),
        onChange: function (event) { setNote(event.target.value); }
      }));
    }

    function DeleteDialog(props) {
      var count = Array.isArray(props.ids) ? props.ids.length : 0;
      return h(DialogShell, {
        title: tf('delete.title', { n: count }),
        busy: props.busy,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
          h(Btn, {
            key: 'confirm',
            variant: 'danger',
            disabled: props.busy,
            onClick: function () { props.onConfirm(props.ids); }
          }, t('delete.confirm'))
        ]
      }, h('p', { key: 'body', className: 'sm-dialog-warning' }, t('delete.body')));
    }

    /* ------------------------------------------------------------------ *
     * Trash
     * ------------------------------------------------------------------ */

    function TrashRow(props) {
      var item = props.item || {};
      return h('label', { className: 'sm-trash-item' }, [
        h('input', {
          key: 'check',
          type: 'checkbox',
          className: 'sm-check',
          checked: Boolean(props.checked),
          onChange: props.onToggle
        }),
        h('div', { key: 'main', className: 'sm-trash-main' }, [
          h('span', { key: 'title', className: 'sm-trash-title' }, [
            item.title || item.sessionId,
            item.tombstone ? h('span', { key: 'tombstone', className: 'sm-badge' }, t('trash.tombstoneBadge')) : null
          ]),
          h('span', { key: 'meta', className: 'sm-hint' }, [
            t('trash.deletedAt') + ': ' + relativeLabel(item.deletedAt),
            item.cwd ? ' · ' + t('trash.origin') + ': ' + item.cwd : ''
          ].join('')),
          item.tombstone ? h('span', { key: 'tombstone-note', className: 'sm-hint sm-tombstone-note' }, t('trash.tombstone')) : null
        ])
      ]);
    }

    function TrashDialog(props) {
      var itemsState = useState(null);
      var items = itemsState[0];
      var setItems = itemsState[1];
      var selectedState = useState([]);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var localBusyState = useState(false);
      var localBusy = localBusyState[0];
      var setLocalBusy = localBusyState[1];

      function refresh() {
        setError(null);
        setLocalBusy(true);
        request(API_PATHS.trash).then(function (body) {
          setItems(Array.isArray(body.items) ? body.items : []);
          setLocalBusy(false);
        }, function (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
          setItems([]);
          setLocalBusy(false);
        });
      }
      useEffect(function () { refresh(); }, []);

      function restore() {
        if (selected.length === 0) return;
        setLocalBusy(true);
        postJson(API_PATHS.trashRestore, { sessionIds: selected }).then(function () {
          setLocalBusy(false);
          setSelected([]);
          refresh();
          if (props.onRestored) props.onRestored();
        }, function (cause) {
          setLocalBusy(false);
          setError(cause && cause.message ? cause.message : String(cause));
        });
      }

      var content;
      if (items === null) content = h('p', { key: 'loading', className: 'sm-hint' }, t('common.loading'));
      else if (items.length === 0) content = h(EmptyState, { key: 'empty', icon: '○', title: t('trash.empty') });
      else content = h('div', { key: 'list', className: 'sm-trash-list' }, items.map(function (item) {
        return h(TrashRow, {
          key: item.sessionId,
          item: item,
          checked: selected.indexOf(item.sessionId) >= 0,
          onToggle: function () { setSelected(function (previous) { return toggleValue(previous, item.sessionId); }); }
        });
      }));

      return h(DialogShell, {
        title: t('trash.title'),
        busy: props.busy || localBusy,
        wide: true,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('batch.selected', { n: selected.length })),
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'refresh', disabled: localBusy, onClick: refresh }, t('trash.refresh')),
          h(Btn, { key: 'close', disabled: props.busy, onClick: props.onClose }, t('action.close')),
          h(Btn, { key: 'restore', variant: 'primary', disabled: localBusy || selected.length === 0, onClick: restore }, tf('trash.restore', { n: selected.length }))
        ]
      }, [
        error ? h('p', { key: 'error', className: 'sm-dialog-warning' }, error) : null,
        content
      ]);
    }

    /* ------------------------------------------------------------------ *
     * Fill missing tags (dry run first)
     * ------------------------------------------------------------------ */

    function FillMissingDialog(props) {
      var candidates = Array.isArray(props.candidates) ? props.candidates : [];
      return h(DialogShell, {
        title: t('fill.title'),
        subtitle: t('fill.subtitle'),
        busy: props.busy,
        wide: true,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'count', className: 'sm-dialog-foot-note' }, tf('fill.candidates', { n: candidates.length })),
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'cancel', disabled: props.busy, onClick: props.onClose }, t('action.cancel')),
          h(Btn, { key: 'apply', variant: 'primary', disabled: props.busy || candidates.length === 0, onClick: props.onApply }, t('fill.apply'))
        ]
      }, candidates.length === 0
        ? h(EmptyState, { key: 'empty', icon: '○', title: t('fill.none') })
        : h('ul', { key: 'list', className: 'sm-fill-list' }, candidates.map(function (item) {
          return h('li', { key: item.sessionId, className: 'sm-fill-item' }, [
            h('span', { key: 'title', className: 'sm-trash-title' }, item.title || item.sessionId),
            Array.isArray(item.tags) && item.tags.length > 0
              ? h('span', { key: 'tags', className: 'sm-preview-chips' }, item.tags.map(function (tag) {
                return h(Chip, { key: 'tag:' + tag, label: tag, muted: true });
              }))
              : null
          ]);
        })));
    }

    /* ------------------------------------------------------------------ *
     * Tag rules — list, form, hit preview, apply.
     * ------------------------------------------------------------------ */

    function evidenceTooltip(detail) {
      if (!Array.isArray(detail) || detail.length === 0) return '';
      return detail.map(function (entry) {
        if (!entry) return '';
        return (entry.field ? entry.field + ': ' : '') + (entry.keyword || '');
      }).filter(Boolean).join('; ');
    }

    function emptyRuleDraft() {
      return {
        id: null,
        name: '',
        enabled: true,
        keywords: '',
        fields: ['title', 'firstMessage'],
        matchMode: 'any',
        actionTags: [],
        actionMode: 'suggest'
      };
    }

    function ruleToDraft(rule) {
      var source = rule || {};
      var match = source.match || {};
      var action = source.action || {};
      return {
        id: source.id || null,
        name: source.name || '',
        enabled: source.enabled !== false,
        keywords: Array.isArray(match.keywords) ? match.keywords.join(', ') : '',
        fields: Array.isArray(match.fields) && match.fields.length > 0 ? match.fields.slice() : ['title', 'firstMessage'],
        matchMode: match.mode === 'all' ? 'all' : 'any',
        actionTags: Array.isArray(action.tags) ? action.tags.slice() : [],
        actionMode: action.mode === 'apply' ? 'apply' : 'suggest'
      };
    }

    function draftToRule(draft) {
      return {
        id: draft.id || undefined,
        name: draft.name.trim(),
        enabled: Boolean(draft.enabled),
        match: {
          keywords: parseTagInput(draft.keywords),
          fields: draft.fields.slice(),
          mode: draft.matchMode
        },
        action: {
          tags: draft.actionTags.slice(),
          mode: draft.actionMode
        }
      };
    }

    function RulesDialog(props) {
      var listState = useState(Array.isArray(props.rules) ? props.rules : []);
      var rules = listState[0];
      var setRules = listState[1];
      var draftState = useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var matchesState = useState(null);
      var preview = matchesState[0];
      var setPreview = matchesState[1];
      var statusState = useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var localBusyState = useState(false);
      var localBusy = localBusyState[0];
      var setLocalBusy = localBusyState[1];

      function report(cause) {
        setLocalBusy(false);
        if (props.onError) props.onError(cause);
        else setStatus({ kind: 'error', text: cause && cause.message ? cause.message : String(cause) });
      }

      function startNew() {
        setDraft(emptyRuleDraft());
        setPreview(null);
        setStatus(null);
      }

      function startEdit(rule) {
        setDraft(ruleToDraft(rule));
        setPreview(null);
        setStatus(null);
      }

      function save() {
        if (!draft) return;
        var rule = draftToRule(draft);
        if (!rule.name || rule.match.keywords.length === 0 || rule.action.tags.length === 0) {
          setStatus({ kind: 'error', text: t('rules.keywordsPlaceholder') });
          return;
        }
        setLocalBusy(true);
        postJson(API_PATHS.rules, rule).then(function (body) {
          setLocalBusy(false);
          setRules(Array.isArray(body.rules) ? body.rules : rules);
          setDraft(null);
          setPreview(null);
          setStatus({ kind: 'info', text: t('notice.ruleSaved') });
          if (props.onChanged) props.onChanged();
        }, report);
      }

      function remove(rule) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(tf('rules.deleteConfirm', { name: rule.name || t('rules.untitled') }))) return;
        }
        setLocalBusy(true);
        request(API_PATHS.rules + '/' + encodeURIComponent(rule.id), { method: 'DELETE' }).then(function (body) {
          setLocalBusy(false);
          setRules(Array.isArray(body.rules) ? body.rules : rules.filter(function (entry) { return entry.id !== rule.id; }));
          setStatus({ kind: 'info', text: t('notice.ruleDeleted') });
          if (props.onChanged) props.onChanged();
        }, report);
      }

      function runPreview() {
        if (!draft) return;
        setLocalBusy(true);
        postJson(API_PATHS.rulePreview, { rule: draftToRule(draft) }).then(function (body) {
          setLocalBusy(false);
          setPreview({ matches: Array.isArray(body.matches) ? body.matches : [], scanned: body.scanned || 0 });
        }, report);
      }

      function applyRule(rule) {
        setLocalBusy(true);
        postJson(API_PATHS.ruleApply, { ruleId: rule.id, mode: rule.action && rule.action.mode ? rule.action.mode : 'suggest' }).then(function (body) {
          setLocalBusy(false);
          setStatus({ kind: 'info', text: tf('notice.ruleApplied', { suggested: body.suggested || 0, updated: body.updated || 0 }) });
          if (props.onChanged) props.onChanged();
        }, report);
      }

      var vocabulary = (props.tagDefs || []).map(function (def) { return def && def.name; }).filter(Boolean);

      var form = null;
      if (draft) {
        form = h('div', { key: 'form', className: 'sm-rule-form' }, [
          h('div', { key: 'header', className: 'sm-rule-form-head' }, [
            h('h3', { key: 'title', className: 'sm-dialog-title' }, draft.id ? t('rules.edit') : t('rules.new')),
            h('label', { key: 'enabled', className: 'sm-check-label' }, [
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: draft.enabled,
                onChange: function (event) { setDraft(Object.assign({}, draft, { enabled: event.target.checked })); }
              }),
              h('span', { key: 'text' }, t('rules.enabled'))
            ])
          ]),
          h('label', { key: 'name', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.name')),
            h('input', {
              key: 'input',
              type: 'text',
              className: 'sm-input',
              value: draft.name,
              placeholder: t('rules.namePlaceholder'),
              onChange: function (event) { setDraft(Object.assign({}, draft, { name: event.target.value })); }
            })
          ]),
          h('label', { key: 'keywords', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.keywords')),
            h('input', {
              key: 'input',
              type: 'text',
              className: 'sm-input',
              value: draft.keywords,
              placeholder: t('rules.keywordsPlaceholder'),
              onChange: function (event) { setDraft(Object.assign({}, draft, { keywords: event.target.value })); }
            })
          ]),
          h('div', { key: 'fields', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.fields')),
            h('div', { key: 'options', className: 'sm-radio-row' }, RULE_FIELDS.map(function (field) {
              var checked = draft.fields.indexOf(field) >= 0;
              return h('label', { key: field, className: 'sm-check-label' }, [
                h('input', {
                  key: 'input',
                  type: 'checkbox',
                  checked: checked,
                  onChange: function () {
                    var fields = checked
                      ? draft.fields.filter(function (entry) { return entry !== field; })
                      : draft.fields.concat([field]);
                    setDraft(Object.assign({}, draft, { fields: fields }));
                  }
                }),
                h('span', { key: 'text' }, t('rules.field.' + field))
              ]);
            }))
          ]),
          h('div', { key: 'matchMode', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.matchMode')),
            h('div', { key: 'options', className: 'sm-radio-row' }, ['any', 'all'].map(function (mode) {
              return h('label', { key: mode, className: 'sm-check-label' }, [
                h('input', {
                  key: 'input',
                  type: 'radio',
                  name: 'sm-rule-match-mode',
                  checked: draft.matchMode === mode,
                  onChange: function () { setDraft(Object.assign({}, draft, { matchMode: mode })); }
                }),
                h('span', { key: 'text' }, t('rules.matchMode.' + mode))
              ]);
            }))
          ]),
          h('div', { key: 'actionMode', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.actionMode')),
            h('select', {
              key: 'select',
              className: 'sm-input',
              value: draft.actionMode,
              onChange: function (event) { setDraft(Object.assign({}, draft, { actionMode: event.target.value })); }
            }, ['suggest', 'apply'].map(function (mode) {
              return h('option', { key: mode, value: mode }, t('rules.actionMode.' + mode));
            }))
          ]),
          h('div', { key: 'actionTags', className: 'sm-form-row' }, [
            h('span', { key: 'label', className: 'sm-form-label' }, t('rules.actionTags')),
            h(TagPicker, {
              key: 'picker',
              value: draft.actionTags,
              onChange: function (tags) { setDraft(Object.assign({}, draft, { actionTags: tags })); },
              vocabulary: vocabulary
            })
          ]),
          h('div', { key: 'actions', className: 'sm-rule-form-actions' }, [
            h(Btn, { key: 'preview', disabled: localBusy, onClick: runPreview }, t('rules.preview')),
            h(Btn, { key: 'save', variant: 'primary', disabled: localBusy, onClick: save }, t('rules.save')),
            h(Btn, { key: 'cancel', disabled: localBusy, onClick: function () { setDraft(null); setPreview(null); } }, t('rules.cancelEdit'))
          ]),
          preview ? h('div', { key: 'preview', className: 'sm-rule-preview' }, [
            h('p', { key: 'scanned', className: 'sm-hint' }, tf('rules.previewScanned', { n: preview.scanned })),
            preview.matches.length === 0
              ? h('p', { key: 'none', className: 'sm-hint' }, t('rules.previewEmpty'))
              : h('ul', { key: 'matches', className: 'sm-fill-list' }, preview.matches.map(function (match) {
                return h('li', { key: match.sessionId, className: 'sm-fill-item' }, [
                  h('span', { key: 'title', className: 'sm-trash-title' }, match.title || match.sessionId),
                  h('span', { key: 'side', className: 'sm-preview-side' }, [
                    Array.isArray(match.tags) && match.tags.length > 0
                      ? h('span', { key: 'tags', className: 'sm-preview-chips' }, match.tags.map(function (tag) {
                        return h(Chip, { key: 'tag:' + tag, label: tag, muted: true });
                      }))
                      : null,
                    match.evidence ? h('span', {
                      key: 'evidence',
                      className: 'sm-hint',
                      title: evidenceTooltip(match.evidenceDetail)
                    }, match.evidence) : null
                  ])
                ]);
              }))
          ]) : null,
          status ? h('p', { key: 'status', className: cx('sm-status-text', status.kind === 'error' && 'sm-status-error') }, status.text) : null
        ]);
      }

      var listView = h('div', { key: 'list', className: 'sm-rules' }, [
        h('div', { key: 'actions', className: 'sm-rule-form-actions' }, [
          h(Btn, { key: 'new', variant: 'primary', onClick: startNew }, t('rules.new'))
        ]),
        status ? h('p', { key: 'status', className: cx('sm-status-text', status.kind === 'error' && 'sm-status-error') }, status.text) : null,
        rules.length === 0
          ? h(EmptyState, { key: 'empty', icon: '○', title: t('rules.empty'), body: t('rules.subtitle') })
          : h('ul', { key: 'items', className: 'sm-rule-list' }, rules.map(function (rule) {
            var action = rule.action || {};
            var match = rule.match || {};
            return h('li', { key: rule.id, className: 'sm-rule' }, [
              h('div', { key: 'main', className: 'sm-rule-main' }, [
                h('div', { key: 'head', className: 'sm-rule-head' }, [
                  h('span', { key: 'name', className: 'sm-rule-name' }, rule.name || t('rules.untitled')),
                  h('span', { key: 'mode', className: 'sm-badge' }, t('rules.actionMode.' + (action.mode === 'apply' ? 'apply' : 'suggest'))),
                  rule.enabled === false ? h('span', { key: 'off', className: 'sm-badge' }, t('rules.enabled') + ': ' + t('common.none')) : null
                ]),
                h('div', { key: 'meta', className: 'sm-rule-meta' }, [
                  h('span', { key: 'keywords', className: 'sm-hint' }, (Array.isArray(match.keywords) ? match.keywords : []).join(' / ')),
                  h('span', { key: 'tags', className: 'sm-preview-chips' }, (Array.isArray(action.tags) ? action.tags : []).map(function (tag) {
                    return h(Chip, { key: 'tag:' + tag, label: tag, muted: true });
                  }))
                ])
              ]),
              h('div', { key: 'actions', className: 'sm-rule-actions' }, [
                h(Btn, { key: 'preview', disabled: localBusy, onClick: function () { runPreviewFor(rule); } }, t('rules.preview')),
                h(Btn, { key: 'apply', disabled: localBusy || rule.enabled === false, onClick: function () { applyRule(rule); } }, t('rules.apply')),
                h(Btn, { key: 'edit', disabled: localBusy, onClick: function () { startEdit(rule); } }, t('action.edit')),
                h(Btn, { key: 'delete', variant: 'danger', disabled: localBusy, onClick: function () { remove(rule); } }, t('action.delete'))
              ])
            ]);
          })),
        preview ? h('div', { key: 'list-preview', className: 'sm-rule-preview' }, [
          h('p', { key: 'scanned', className: 'sm-hint' }, tf('rules.previewScanned', { n: preview.scanned })),
          preview.matches.length === 0
            ? h('p', { key: 'none', className: 'sm-hint' }, t('rules.previewEmpty'))
            : h('ul', { key: 'matches', className: 'sm-fill-list' }, preview.matches.slice(0, 20).map(function (match) {
              return h('li', { key: match.sessionId, className: 'sm-fill-item' }, [
                h('span', { key: 'title', className: 'sm-trash-title' }, match.title || match.sessionId),
                h('span', { key: 'side', className: 'sm-preview-side' }, [
                  Array.isArray(match.tags) && match.tags.length > 0
                    ? h('span', { key: 'tags', className: 'sm-preview-chips' }, match.tags.map(function (tag) {
                      return h(Chip, { key: 'tag:' + tag, label: tag, muted: true });
                    }))
                    : null,
                  match.evidence ? h('span', {
                    key: 'evidence',
                    className: 'sm-hint',
                    title: evidenceTooltip(match.evidenceDetail)
                  }, match.evidence) : null
                ])
              ]);
            }))
        ]) : null
      ]);

      function runPreviewFor(rule) {
        setLocalBusy(true);
        postJson(API_PATHS.rulePreview, { rule: rule }).then(function (body) {
          setLocalBusy(false);
          setPreview({ matches: Array.isArray(body.matches) ? body.matches : [], scanned: body.scanned || 0 });
        }, report);
      }

      return h(DialogShell, {
        title: t('rules.title'),
        subtitle: t('rules.subtitle'),
        busy: props.busy || localBusy,
        wide: true,
        onClose: props.onClose,
        footer: [
          h('span', { key: 'spacer', className: 'sm-batch-spacer' }),
          h(Btn, { key: 'close', disabled: props.busy, onClick: props.onClose }, t('action.close'))
        ]
      }, form || listView);
    }


    /* ------------------------------------------------------------------ *
     * Stylesheet — owned by ctx.effect, removed on unload.
     * ------------------------------------------------------------------ */

    var CSS = [
      '.sm-page{position:relative;display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;padding:20px 24px 0;color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-page:focus{outline:none;}',
      '.sm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
      '.sm-head-titles{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.sm-head-title{margin:0;font-size:20px;line-height:1.3;font-weight:600;}',
      '.sm-head-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-head-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}',
      '.sm-index{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);display:inline-flex;align-items:center;gap:6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sm-index-running::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3b82f6);animation:sm-pulse 1.2s ease-in-out infinite;}',
      '@keyframes sm-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.sm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:inherit;border-radius:6px;font-size:12px;line-height:1;padding:7px 10px;cursor:pointer;white-space:nowrap;}',
      '.sm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));}',
      '.sm-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.sm-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;}',
      '.sm-btn-primary:hover:not(:disabled){filter:brightness(1.05);background:var(--dsw-alias-brand-primary,#3b82f6);}',
      '.sm-btn-danger{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);background:transparent;}',
      '.sm-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);}',
      '.sm-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}',
      '.sm-overview-card{appearance:none;text-align:left;display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));color:inherit;cursor:pointer;}',
      '.sm-overview-card:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));}',
      '.sm-overview-active{border-color:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#3b82f6);}',
      '.sm-overview-num{font-size:20px;font-weight:600;line-height:1.1;}',
      '.sm-overview-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-overview-pending .sm-overview-num{color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.sm-overview-blocked .sm-overview-num{color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.sm-overview-failed .sm-overview-num{color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.sm-overview-unread .sm-overview-num{color:var(--dsw-alias-state-success-primary,#16a34a);}',
      '.sm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sm-search{flex:1 1 220px;min-width:180px;max-width:420px;padding:7px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px;}',
      '.sm-search:focus{outline:1px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:0;}',
      '.sm-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:6px;overflow:hidden;}',
      '.sm-seg-btn{appearance:none;border:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;padding:7px 9px;cursor:pointer;}',
      '.sm-seg-btn:last-child{border-right:0;}',
      '.sm-seg-btn-active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;}',
      '.sm-select{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-select select,.sm-tag-select{padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px;}',
      '.sm-check-label{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap;}',
      '.sm-toolbar-spacer,.sm-batch-spacer{flex:1 1 auto;}',
      '.sm-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.sm-filters-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-filter-group{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;padding-right:6px;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.sm-filter-group:last-of-type{border-right:0;}',
      '.sm-filter-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;padding:4px 7px;border-radius:999px;cursor:pointer;}',
      '.sm-filter-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));}',
      '.sm-filter-chip-active{border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-primary,#1f2328);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 10%,transparent);}',
      '.sm-filter-tags{gap:6px;}',
      '.sm-tag-select{max-width:150px;}',
      '.sm-notice{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));}',
      '.sm-notice-error{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.sm-notice-text{flex:1 1 auto;min-width:0;}',
      '.sm-icon-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:14px;line-height:1;width:24px;height:24px;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.sm-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-icon-btn:disabled{opacity:.4;cursor:not-allowed;}',
      '.sm-body{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:16px;}',
      '.sm-groups{display:flex;flex-direction:column;gap:10px;}',
      '.sm-groups-hint{margin:0 0 2px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-group{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:10px;overflow:visible;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03));transition:opacity .12s ease,box-shadow .12s ease;}',
      '.sm-group-dragging{opacity:.55;}',
      '.sm-group-drop{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary,#3b82f6);}',
      '.sm-group-head-row{display:flex;align-items:center;gap:2px;padding-right:10px;}',
      '.sm-group-drag{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:13px;line-height:1;padding:0 2px 0 8px;cursor:grab;flex:0 0 auto;}',
      '.sm-group-drag:active{cursor:grabbing;}',
      '.sm-group-drag:hover{color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-group-moves{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;}',
      '.sm-group-move{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1;width:20px;height:20px;border-radius:4px;cursor:pointer;}',
      '.sm-group-move:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-group-move:disabled{opacity:.25;cursor:default;}',
      '.sm-group-head{appearance:none;flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 4px 8px 6px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;}',
      '.sm-group-head:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border-radius:8px;}',
      '.sm-caret{display:inline-block;font-size:14px;color:var(--dsw-alias-label-secondary,#6b7280);transform:rotate(0deg);transition:transform .12s ease;}',
      '.sm-caret-open{transform:rotate(90deg);}',
      '.sm-group-name{font-size:13px;font-weight:600;}',
      '.sm-group-total{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-group-counts{display:inline-flex;align-items:center;gap:10px;margin-left:auto;}',
      '.sm-group-count{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-group-count-n{font-variant-numeric:tabular-nums;}',
      '.sm-group-rows{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}',
      '.sm-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));position:relative;}',
      '.sm-row:last-child{border-bottom:0;}',
      '.sm-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));}',
      '.sm-row-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 8%,transparent);}',
      '.sm-row-archived{opacity:.72;}',
      '.sm-check{margin:0;accent-color:var(--dsw-alias-brand-primary,#3b82f6);flex-shrink:0;}',
      '.sm-row-dot{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.sm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-idle-primary,#9ca3af);}',
      '.sm-dot-pending{background:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.sm-dot-running{background:var(--dsw-alias-brand-primary,#3b82f6);animation:sm-pulse 1.2s ease-in-out infinite;}',
      '.sm-dot-blocked{background:var(--dsw-alias-state-warn-primary,#d97706);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 25%,transparent);}',
      '.sm-dot-failed{background:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.sm-dot-unread{background:var(--dsw-alias-state-success-primary,#16a34a);}',
      '.sm-dot-completed{background:var(--dsw-alias-state-success-primary,#16a34a);opacity:.55;}',
      '.sm-dot-interrupted{background:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-native-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-native-badge-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-idle-primary,#9ca3af);}',
      '.sm-native-badge-count{font-variant-numeric:tabular-nums;}',
      '.sm-native-hover{display:flex;flex-direction:column;gap:4px;padding:2px 0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-native-hover-row{display:flex;align-items:center;gap:5px;}',
      '.sm-native-hover-status{color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-native-hover-tags{display:flex;flex-wrap:wrap;gap:4px;}',
      '.sm-native-hover-tag{padding:0 5px;height:16px;line-height:16px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sm-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.sm-row-top{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.sm-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sm-badge{font-size:10px;line-height:1.4;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;flex-shrink:0;}',
      '.sm-row-sub{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);min-width:0;}',
      '.sm-row-ws{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;}',
      '.sm-row-note{flex-shrink:0;}',
      '.sm-row-intent{flex-shrink:0;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));}',
      '.sm-row-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px;}',
      '.sm-chip{display:inline-flex;align-items:center;gap:3px;padding:0 6px;height:18px;border-radius:4px;font-size:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);max-width:160px;}',
      '.sm-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sm-chip-muted{background:transparent;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-chip-x{appearance:none;border:0;background:transparent;color:inherit;padding:0;margin-left:2px;cursor:pointer;font-size:11px;line-height:1;}',
      '.sm-row-time{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0;white-space:nowrap;}',
      '.sm-row-actions{position:relative;flex-shrink:0;}',
      '.sm-menu{position:absolute;right:0;top:26px;z-index:20;min-width:132px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column;}',
      '.sm-menu-item{appearance:none;border:0;background:transparent;text-align:left;padding:6px 9px;border-radius:5px;font-size:12px;color:inherit;cursor:pointer;}',
      '.sm-menu-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));}',
      '.sm-menu-item-danger{color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.sm-batch{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin:0 -4px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 -8px 20px rgba(0,0,0,.08);border-radius:10px 10px 0 0;}',
      '.sm-batch-count{font-size:12px;font-weight:600;white-space:nowrap;}',
      '.sm-batch-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.34);}',
      '.sm-dialog{width:min(560px,100%);max-height:min(84vh,760px);display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 24px 64px rgba(0,0,0,.28);}',
      '.sm-dialog-wide{width:min(760px,100%);}',
      '.sm-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}',
      '.sm-dialog-titles{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.sm-dialog-title{margin:0;font-size:15px;font-weight:600;}',
      '.sm-dialog-sub{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-dialog-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.sm-dialog-foot{display:flex;align-items:center;gap:8px;padding:10px 16px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}',
      '.sm-dialog-foot-note{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-dialog-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-dialog-warning{margin:0;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;}',
      '.sm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:40px 16px;text-align:center;}',
      '.sm-empty-icon{font-size:22px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-empty-title{margin:0;font-size:14px;font-weight:600;}',
      '.sm-empty-body{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);max-width:420px;}',
      '.sm-empty-action{margin-top:8px;}',
      '.sm-empty-wrap,.sm-error-wrap{display:flex;align-items:center;justify-content:center;min-height:280px;}',
      '.sm-error-actions{display:flex;align-items:center;gap:10px;}',
      '.sm-error-code{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-loading{display:flex;align-items:center;justify-content:center;min-height:240px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-preview-list{display:flex;flex-direction:column;gap:6px;}',
      '.sm-preview-item{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03));}',
      '.sm-preview-item-skipped{opacity:.62;}',
      '.sm-preview-item-removed{opacity:.5;text-decoration:line-through;}',
      '.sm-preview-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.sm-preview-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;min-width:0;}',
      '.sm-preview-old{color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
      '.sm-preview-arrow{color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-preview-new{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
      '.sm-preview-reason{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-preview-actions{display:flex;align-items:center;gap:6px;flex-shrink:0;}',
      '.sm-preview-side{display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:flex-end;}',
      '.sm-preview-tags{display:flex;flex-direction:column;gap:4px;}',
      '.sm-preview-chips{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;}',
      '.sm-intent{font-size:10px;padding:0 6px;height:18px;line-height:18px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-skip-badge{font-size:10px;color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.sm-form{display:flex;flex-direction:column;gap:10px;}',
      '.sm-form-row{display:flex;flex-direction:column;gap:4px;}',
      '.sm-form-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-input{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px;}',
      '.sm-input:focus{outline:1px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:0;}',
      '.sm-input-inline{width:180px;padding:3px 6px;font-size:11px;}',
      '.sm-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit;font-size:12px;resize:vertical;font-family:inherit;}',
      '.sm-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:0;}',
      '.sm-tag-picker{display:flex;flex-direction:column;gap:8px;}',
      '.sm-tag-picker-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-height:20px;}',
      '.sm-tag-input-row{display:flex;align-items:center;gap:6px;}',
      '.sm-tag-suggestions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}',
      '.sm-suggestion{appearance:none;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;}',
      '.sm-suggestion:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328);}',
      '.sm-tagmanage-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sm-tagmanage-create{display:flex;align-items:center;gap:6px;flex:1 1 260px;min-width:220px;}',
      '.sm-tagmanage-create .sm-input{flex:1 1 auto;min-width:120px;}',
      '.sm-tagmanage-search{flex:1 1 180px;max-width:240px;}',
      '.sm-tagmanage-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;max-height:46vh;overflow-y:auto;}',
      '.sm-tagmanage-item{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));background:var(--dsw-alias-bg-base,#fff);}',
      '.sm-tagmanage-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));}',
      '.sm-tagmanage-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.sm-tagmanage-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0;}',
      '.sm-tagmanage-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;}',
      '.sm-tagmanage-edit{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-tagmanage-edit .sm-input{flex:1 1 160px;min-width:120px;width:auto;}',
      '.sm-tagmanage-actions{display:flex;align-items:center;gap:6px;flex-shrink:0;}',
      '.sm-trash-list,.sm-fill-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.sm-trash-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));cursor:pointer;}',
      '.sm-trash-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));}',
      '.sm-trash-main{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.sm-trash-title{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;}',
      '.sm-tombstone-note{color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.sm-fill-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));font-size:12px;}',
      '.sm-rules{display:flex;flex-direction:column;gap:10px;}',
      '.sm-rule-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}',
      '.sm-rule{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.sm-rule-main{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.sm-rule-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-rule-name{font-size:12px;font-weight:600;}',
      '.sm-rule-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sm-rule-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap;}',
      '.sm-rule-form{display:flex;flex-direction:column;gap:10px;}',
      '.sm-rule-form-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.sm-rule-form-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-rule-preview{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}',
      '.sm-radio-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.sm-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-status-text{margin:0;font-size:11px;color:var(--dsw-alias-state-success-primary,#16a34a);}',
      '.sm-status-error{color:var(--dsw-alias-state-error-primary,#dc2626);}',
      /* ---------------- v0.2: selection, menu, tasks, detail ---------------- */
      '.sm-row-active{outline:1px dashed var(--dsw-alias-state-info-primary,#2563eb);outline-offset:-2px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.08));}',
      '.sm-row:focus{outline:1px dashed var(--dsw-alias-state-info-primary,#2563eb);outline-offset:-2px;}',
      '.sm-row-detail-btn{font-size:10px;line-height:18px;padding:0 6px;white-space:nowrap;flex:0 0 auto;min-width:38px;}',
      '.sm-row-more-btn{font-size:13px;line-height:18px;padding:0 4px;flex:0 0 auto;}',
      '.sm-row-menu{right:auto;top:auto;z-index:40;min-width:216px;max-height:calc(100% - 16px);overflow:auto;gap:0;}',
      '.sm-menu-item-entry{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;}',
      '.sm-menu-label{flex:1 1 auto;min-width:0;}',
      '.sm-menu-reason{flex:1 1 100%;font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);font-weight:400;}',
      '.sm-menu-shortcut{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);opacity:.85;}',
      '.sm-menu-item-active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));}',
      '.sm-menu-item-disabled{opacity:.62;cursor:default;}',
      '.sm-jobs{position:relative;display:flex;align-items:center;}',
      '.sm-jobs-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:inherit;font-size:12px;cursor:pointer;}',
      '.sm-jobs-trigger-active{border-color:var(--dsw-alias-state-info-primary,#2563eb);}',
      '.sm-jobs-count{min-width:14px;padding:0 4px;border-radius:7px;background:var(--dsw-alias-state-info-primary,#2563eb);color:#fff;font-size:10px;text-align:center;}',
      '.sm-jobs-progress-text{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-jobs-panel{position:fixed;right:16px;z-index:45;width:min(360px,calc(100vw - 32px));max-height:min(440px,calc(100vh - 120px));overflow:auto;padding:8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:8px;}',
      '.sm-jobs-head{display:flex;align-items:center;gap:8px;}',
      '.sm-jobs-title{font-size:12px;font-weight:600;}',
      '.sm-jobs-subhead{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-jobs-list{display:flex;flex-direction:column;gap:6px;}',
      '.sm-job{display:flex;flex-direction:column;gap:4px;padding:7px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.sm-job-row{display:flex;align-items:flex-start;gap:8px;}',
      '.sm-job-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;flex-shrink:0;background:var(--dsw-alias-label-secondary,#a1a1aa);}',
      '.sm-job-dot-queued{background:#a1a1aa;}',
      '.sm-job-dot-running{background:#2563eb;}',
      '.sm-job-dot-succeeded{background:#16a34a;}',
      '.sm-job-dot-failed{background:#dc2626;}',
      '.sm-job-dot-cancelled{background:#a1a1aa;}',
      '.sm-job-dot-interrupted{background:#d97706;}',
      '.sm-job-dot-idle{background:#a1a1aa;}',
      '.sm-job-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}',
      '.sm-job-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-job-type{font-size:12px;font-weight:600;}',
      '.sm-job-state{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-job-time{margin-left:auto;}',
      '.sm-bar{height:4px;border-radius:2px;background:rgba(127,127,127,.18);overflow:hidden;}',
      '.sm-bar-fill{display:block;height:100%;background:#2563eb;transition:width .2s ease;}',
      '.sm-job-detail{display:flex;flex-direction:column;gap:4px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.2));}',
      '.sm-job-items{margin:0;padding:0 0 0 12px;display:flex;flex-direction:column;gap:2px;max-height:200px;overflow:auto;}',
      '.sm-job-item{font-size:11px;display:flex;gap:6px;align-items:baseline;}',
      '.sm-job-item-key{font-family:ui-monospace,monospace;color:var(--dsw-alias-label-secondary,#6b7280);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sm-job-item-failed{color:#dc2626;}',
      '.sm-spinner{width:10px;height:10px;border-radius:50%;border:1.5px solid rgba(37,99,235,.3);border-top-color:#2563eb;animation:sm-spin .8s linear infinite;}',
      '@keyframes sm-spin{to{transform:rotate(360deg);}}',
      '.sm-detail{display:flex;flex-direction:column;gap:12px;padding:10px 12px 16px;font-size:12px;}',
      '.sm-detail-head{display:flex;flex-direction:column;gap:6px;}',
      '.sm-detail-title{margin:0;font-size:14px;font-weight:600;cursor:text;word-break:break-word;}',
      '.sm-detail-title-edit{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-detail-status{display:flex;align-items:center;gap:6px;}',
      '.sm-detail-meta{margin:0;display:flex;flex-direction:column;gap:6px;}',
      '.sm-detail-meta-row{display:grid;grid-template-columns:104px minmax(0,1fr);gap:8px;align-items:start;}',
      '.sm-detail-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sm-detail-value{margin:0;word-break:break-word;overflow-wrap:anywhere;}',
      '.sm-detail-section{display:flex;flex-direction:column;gap:6px;}',
      '.sm-detail-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.sm-detail-tag-add{display:flex;gap:6px;}',
      '.sm-detail-first{margin:0;white-space:pre-wrap;word-break:break-word;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.08);max-height:160px;overflow:auto;}',
      '.sm-detail-sid{display:flex;align-items:center;gap:8px;}',
      '.sm-detail-code{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;}',
      '.sm-detail-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.sm-link-btn{border:0;background:transparent;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline dotted;word-break:break-all;}',
      '.sm-link-btn:disabled{opacity:.6;text-decoration:none;cursor:default;}',
      /* v0.3: in-panel master/detail split, skeleton first paint, parked tasks */
      '.sm-split{position:relative;display:flex;flex:1 1 auto;min-height:0;gap:12px;}',
      '.sm-split-list{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}',
      '.sm-split-list>.sm-body{flex:1 1 auto;min-height:0;}',
      '.sm-split-detail{flex:0 0 340px;width:340px;max-width:340px;min-height:0;display:flex;flex-direction:column;padding-left:12px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}',
      '.sm-detail-pane{display:flex;flex-direction:column;min-height:0;height:100%;}',
      '.sm-detail-pane-head{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.sm-detail-pane-label{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-detail-close{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;}',
      '.sm-detail-close:hover{background:rgba(127,127,127,.14);}',
      '.sm-detail-scroll{flex:1 1 auto;min-height:0;overflow:auto;}',
      '.sm-body-loading{display:block;min-height:240px;}',
      '.sm-skeleton-list{display:flex;flex-direction:column;gap:8px;padding:4px 0;}',
      '.sm-skeleton-hint{margin:0 0 4px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.sm-skeleton-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.08));}',
      '.sm-skeleton{display:block;border-radius:4px;background:linear-gradient(90deg,rgba(127,127,127,.1),rgba(127,127,127,.2),rgba(127,127,127,.1));background-size:200% 100%;animation:sm-shimmer 1.2s ease-in-out infinite;}',
      '.sm-skeleton-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}',
      '.sm-skeleton-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '.sm-skeleton-title{height:10px;width:52%;}',
      '.sm-skeleton-sub{height:8px;width:30%;}',
      '.sm-skeleton-time{width:44px;height:8px;flex-shrink:0;}',
      '@keyframes sm-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}',
      '.sm-refresh-bar{height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,var(--dsw-alias-state-info-primary,#2563eb),transparent);background-size:50% 100%;animation:sm-shimmer-bar 1.1s linear infinite;}',
      '@keyframes sm-shimmer-bar{0%{background-position:-50% 0;}100%{background-position:150% 0;}}',
      '.sm-jobs-trigger-disabled{opacity:.55;cursor:default;}',
      '@media (max-width:820px){.sm-split-detail{position:absolute;top:0;right:0;bottom:0;z-index:30;width:min(360px,92%);max-width:none;padding:10px 12px;background:var(--dsw-alias-bg-overlay,#fff);border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));box-shadow:0 12px 32px rgba(0,0,0,.18);}}',
      '.sm-panel-icon{display:block;color:currentColor;}'
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Plugin assembly
     * ------------------------------------------------------------------ */

    function ownedCleanup(fn) {
      var disposer = function () { fn(); };
      disposer.dispose = disposer;
      return disposer;
    }

    function apply(ctx) {
      if (!ctx || typeof ctx.effect !== 'function') return undefined;
      pageCtx = ctx;
      setActiveLanguage(ctx);

      ctx.effect(function () {
        if (typeof document === 'undefined') return null;
        var style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-session-manager');
        style.textContent = CSS;
        document.head.appendChild(style);
        return function () {
          if (style.parentNode) style.parentNode.removeChild(style);
        };
      }, 'dsh-session-manager:style');

      /**
       * The main page registration. The detail split lives inside Page, so no
       * right-pane tab registration is attempted: a plugin that owns the main
       * column has no mounted session surface for sidebar-right (v0.2 fix).
       */
      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return null;
        var owned = [];
        var registration = ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: function () { return {}; }
          }, Page);
        });
        if (registration) owned.push(registration);
        return ownedCleanup(function () {
          for (var index = 0; index < owned.length; index += 1) {
            try { owned[index].dispose(); } catch (error) { /* keep unloading */ }
          }
          owned = [];
        });
      }, 'dsh-session-manager:main');

      /**
       * v0.3: contribute the tag submenu to every native Session context menu
       * (the sidebar rows and our own rows, which open the same popup).
       */
      ctx.effect(function () {
        var menus = optionalService(ctx, 'contextMenus');
        if (!hasMethod(menus, 'register')) return null;
        var workspace = optionalService(ctx, 'uiWorkspace');
        var disposeTags = menus.register({
          id: 'dsh-session-manager.tags',
          target: 'session',
          order: 500,
          resolve: function (target) { return sessionTagMenuActions(target, menus); }
        });
        var disposePanel = menus.register({
          id: 'dsh-session-manager.panel-actions',
          target: 'session',
          order: 550,
          resolve: function (target) { return panelSessionMenuActions(target, { uiWorkspace: workspace }); }
        });
        return function () {
          try { if (typeof disposeTags === 'function') disposeTags(); } catch (error) { /* keep unloading */ }
          try { if (typeof disposePanel === 'function') disposePanel(); } catch (error) { /* keep unloading */ }
        };
      }, 'dsh-session-manager:session-tags-menu');

      /**
       * v0.3 P2: ambient decorations on the native Session rows. Both seats are
       * additive and non-interactive: the trailing badge sits beside the time,
       * the hover section under the relative time. Neither binds the Session.
       */
      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return null;
        var owned = [];
        var trailing = ctx.slots.inject('sidebar.session.row.trailing', function () {
          return ctx.slots.register({
            name: 'sidebar.session.row.trailing',
            id: 'dsh-session-manager.row-status',
            order: 20,
            locale: NS
          }, RowStatusBadge);
        });
        if (trailing) owned.push(trailing);
        var hover = ctx.slots.inject('sidebar.session.row.hover', function () {
          return ctx.slots.register({
            name: 'sidebar.session.row.hover',
            id: 'dsh-session-manager.row-hover',
            order: 20,
            locale: NS
          }, RowHoverSection);
        });
        if (hover) owned.push(hover);
        return ownedCleanup(function () {
          for (var index = 0; index < owned.length; index += 1) {
            try { if (owned[index] && typeof owned[index].dispose === 'function') owned[index].dispose(); } catch (error) { /* keep unloading */ }
          }
          owned = [];
        });
      }, 'dsh-session-manager:sidebar-rows');

      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return null;
        var registration = ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: SIDEBAR_ORDER,
            locale: NS,
            label: function () { return t('panel'); }
          }, SidebarIcon);
        });
        return ownedCleanup(function () {
          if (registration && typeof registration.dispose === 'function') registration.dispose();
        });
      }, 'dsh-session-manager:sidebar');

      return undefined;
    }

    function buildDictionary() {
      var dictionary = { zh: {}, en: {} };
      var keys = Object.keys(TEXT);
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index];
        dictionary.zh[key] = TEXT[key][0];
        dictionary.en[key] = TEXT[key][1];
      }
      return dictionary;
    }

    return {
      // The client sandbox denies member reads on services a plugin did not
      // declare ("cannot get property remote.session without inject"), so every
      // capability the panel probes must be declared here. All four are core web
      // services; a missing one parks the panel instead of crashing it, and the
      // optionalService() wrappers still degrade individual actions gracefully.
      // Nested services need their dotted path declared too ("remote.session"),
      // exactly like the open-in-app plugin does; cordis gates every member read.
      inject: ['slots', 'locale', 'layout', 'contextMenus', 'uiWorkspace', 'remote', 'remote.session'],
      apply: apply,
      helpers: {
        STATUS_IDS: STATUS_IDS,
        OVERVIEW_IDS: OVERVIEW_IDS,
        BUCKET_IDS: BUCKET_IDS,
        GROUP_IDS: GROUP_IDS,
        ARCHIVE_VIEWS: ARCHIVE_VIEWS,
        RULE_FIELDS: RULE_FIELDS,
        deriveStatus: deriveStatus,
        isPendingInteraction: isPendingInteraction,
        bucketOf: bucketOf,
        decorateRows: decorateRows,
        withoutAcceptedTags: withoutAcceptedTags,
        matchesSearch: matchesSearch,
        filterRows: filterRows,
        statusCounts: statusCounts,
        groupRows: groupRows,
        applyGroupOrder: applyGroupOrder,
        moveGroupKey: moveGroupKey,
        moveGroupBy: moveGroupBy,
        readGroupOrder: readGroupOrder,
        writeGroupOrder: writeGroupOrder,
        GROUP_ORDER_STORAGE_KEY: GROUP_ORDER_STORAGE_KEY,
        sortRows: sortRows,
        relativeTime: relativeTime,
        toggleValue: toggleValue,
        parseTagInput: parseTagInput,
        basename: basename,
        skipReasonFor: skipReasonFor,
        isBatchable: isBatchable,
        /* v0.2 pure surface (PRD §7.1–§7.4) */
        optionalService: optionalService,
        clipboardOf: clipboardOf,
        menuCapabilities: menuCapabilities,
        sessionTagMenuActions: sessionTagMenuActions,
        nativeSessionMenuTarget: nativeSessionMenuTarget,
        openNativeSessionMenu: openNativeSessionMenu,
        tagDefsForMenu: tagDefsForMenu,
        sessionTagsOf: sessionTagsOf,
        toggleSessionTag: toggleSessionTag,
        toTagNames: toTagNames,
        panelSessionMenuActions: panelSessionMenuActions,
        subscribeTagWrite: subscribeTagWrite,
        notifyTagWrite: notifyTagWrite,
        requestSessionMeta: requestSessionMeta,
        mergeSessionMeta: mergeSessionMeta,
        metaOf: metaOf,
        metaStatus: metaStatus,
        subscribeSessionMeta: subscribeSessionMeta,
        requestPanelDetail: requestPanelDetail,
        setPanelActive: setPanelActive,
        subscribePanelDetail: subscribePanelDetail,
        menuItemsFor: menuItemsFor,
        pluginMenuItemsFor: pluginMenuItemsFor,
        findMenuItem: findMenuItem,
        enabledMenuIndexes: enabledMenuIndexes,
        nextEnabledIndex: nextEnabledIndex,
        firstEnabledIndex: firstEnabledIndex,
        menuKeyAction: menuKeyAction,
        menuPlacement: menuPlacement,
        moveSelection: moveSelection,
        shortcutActionFor: shortcutActionFor,
        shortcutFor: shortcutFor,
        isActiveJob: isActiveJob,
        normalizeJob: normalizeJob,
        sortJobs: sortJobs,
        activeJobCount: activeJobCount,
        latestFinishedJob: latestFinishedJob,
        mergeJobList: mergeJobList,
        mergeDetailRow: mergeDetailRow,
        turnEndKey: turnEndKey,
        cacheRows: cacheRows,
        rowFromCache: rowFromCache,
        jobPath: jobPath,
        jobCancelPath: jobCancelPath,
        activeJobsPath: activeJobsPath,
        sessionValuePath: sessionValuePath,
        GROUP_COUNT_IDS: GROUP_COUNT_IDS,
        MENU_ITEM_IDS: MENU_ITEM_IDS,
        TRASH_MENU_ITEM_IDS: TRASH_MENU_ITEM_IDS,
        JOB_STATES: JOB_STATES,
        JOB_ACTIVE_STATES: JOB_ACTIVE_STATES,
        JOB_TYPE_IDS: JOB_TYPE_IDS,
        SHORTCUT_KEYS: SHORTCUT_KEYS,
        rememberPanel: rememberPanel,
        readPanelCache: readPanelCache,
        forgetPanelCache: forgetPanelCache,
        panelEscapeAction: panelEscapeAction,
        isJobUnavailable: isJobUnavailable
      },
      dictionary: buildDictionary(),
      api: { prefix: API_PREFIX, paths: API_PATHS },
      /* Headless test surface: the page and its dialogs render from pure props. */
      components: {
        Page: Page,
        Row: Row,
        SidebarIcon: SidebarIcon,
        RenamePreviewDialog: RenamePreviewDialog,
        TagsPreviewDialog: TagsPreviewDialog,
        TagEditorDialog: TagEditorDialog,
        TagManagerDialog: TagManagerDialog,
        tagDefUsageLabel: tagDefUsageLabel,
        RenameOneDialog: RenameOneDialog,
        NoteDialog: NoteDialog,
        DeleteDialog: DeleteDialog,
        TrashDialog: TrashDialog,
        TrashRow: TrashRow,
        FillMissingDialog: FillMissingDialog,
        RulesDialog: RulesDialog,
        RowMenu: RowMenu,
        ArchiveConfirmDialog: ArchiveConfirmDialog,
        JobsIndicator: JobsIndicator,
        JobsPanel: JobsPanel,
        JobRow: JobRow,
        DetailPane: DetailPane,
        SkeletonList: SkeletonList
      }
    };



  }
});
