#!/usr/bin/env node
/**
 * Regenerate the `@icon-map` block inside client.js from
 * `icons/classification-icons.mjs` (the single authored source).
 *
 * The client half is a hand-written, no-build bundle: it cannot `import`, so the
 * canonical map is serialized verbatim into it. `tests/icons.test.js` re-runs the
 * same serialization and fails when the two sides drift — editing the block by
 * hand is therefore not a supported path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT = path.join(ROOT, 'client.js');
const MODULE = path.join(ROOT, 'icons', 'classification-icons.mjs');

export const BEGIN = '    /* @icon-map:begin — generated, do not edit. Source: icons/classification-icons.mjs */';
export const END = '    /* @icon-map:end */';

export async function renderBlock() {
  const mod = await import(pathToFileURL(MODULE).href);
  const lib = mod.iconLib();
  /* One entry per line: a compact JSON value is still a verbatim serialization,
     but the generated block stays reviewable and does not dwarf the bundle. */
  const lines = ['    var ICON_LIB = {'];
  const topKeys = Object.keys(lib);
  topKeys.forEach((key, index) => {
    const value = lib[key];
    const isTable = key === 'ICON_PATHS' || key === 'CATEGORY_ICONS';
    const comma = index === topKeys.length - 1 ? '' : ',';
    if (!isTable) {
      lines.push('      ' + JSON.stringify(key) + ': ' + JSON.stringify(value) + comma);
      return;
    }
    lines.push('      ' + JSON.stringify(key) + ': {');
    const entries = Object.keys(value);
    entries.forEach((entry, entryIndex) => {
      lines.push('        ' + JSON.stringify(entry) + ': ' + JSON.stringify(value[entry])
        + (entryIndex === entries.length - 1 ? '' : ','));
    });
    lines.push('      }' + comma);
  });
  lines.push('    };');
  return [BEGIN, lines.join('\n'), END].join('\n');
}

export async function sync({ write = false } = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const start = source.indexOf(BEGIN);
  const stop = source.indexOf(END);
  if (start < 0 || stop < 0 || stop < start) {
    throw new Error('client.js is missing the @icon-map markers');
  }
  const block = await renderBlock();
  const next = source.slice(0, start) + block + source.slice(stop + END.length);
  if (write && next !== source) fs.writeFileSync(CLIENT, next);
  return { block, changed: next !== source };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await sync({ write: true });
  console.log(result.changed ? 'icon map: regenerated client.js block' : 'icon map: already in sync');
}
