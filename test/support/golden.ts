// Golden files: the engine's output with everything that changes between runs replaced by a
// placeholder. `npm run test:update-golden` rewrites them; review the git diff before committing.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, type Comparison } from './engine.js';
import { TEST_SERVER, query } from './sql.js';

export const GOLDEN = path.join(ROOT, 'test', 'golden');
const updating = process.env.UPDATE_GOLDEN === '1';

let login: string | undefined;
function currentLogin(): string {
  if (login === undefined) {
    const run = query('SELECT SUSER_SNAME()');
    login = run.ok ? run.output.trim() : '';
  }
  return login;
}

function replaceAll(text: string, value: string, placeholder: string): string {
  return value ? text.split(value).join(placeholder) : text;
}

// Names SQL Server gives unnamed constraints end in random hex: PK__Orders__3214EC07B6C2F9A1.
const systemName = /\b((?:PK|UQ|DF|CK|FK)__\w*?__)[0-9A-F]{8,16}\b/g;
const timestamp = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g;

export function scrub(text: string): string {
  let out = text.replace(/\r\n/g, '\n');
  out = replaceAll(out, TEST_SERVER, '<server>');
  out = replaceAll(out, currentLogin(), '<login>');
  out = replaceAll(out, ROOT, '<root>');
  out = replaceAll(out, ROOT.replace(/\\/g, '/'), '<root>');
  out = out.replace(timestamp, '<time>');
  out = out.replace(systemName, '$1<id>');
  return out;
}

function scrubValue(value: unknown, sortKeys: boolean): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, sortKeys));
  if (value !== null && typeof value === 'object') {
    // Keys are scrubbed too: index and constraint keys can hold system-generated names.
    // "serverName" is what SERVERPROPERTY('ServerName') answered (on LocalDB the machine name and
    // a name with a hash that changes at every start of the instance): replaced by its key, not
    // as text wherever it stands, which would also hit logins, paths and labels with that name.
    const entries = Object.entries(value).map(([k, v]) => [
      scrub(k),
      k === 'serverName' && typeof v === 'string' && v !== '' ? '<servername>' : scrubValue(v, sortKeys),
    ] as const);
    if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

// Snapshot items come from hashtables, so their order is not meaningful: sort them.
export function scrubJson(value: unknown, { sortKeys = false } = {}): string {
  return `${JSON.stringify(scrubValue(value, sortKeys), null, 2)}\n`;
}

export function scrubFile(file: string): string {
  const text = scrub(readFileSync(file, 'utf8'));
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function scrubJsonFile(file: string, options?: { sortKeys?: boolean }): string {
  return scrubJson(JSON.parse(readFileSync(file, 'utf8')), options);
}

export function matchGolden(caseName: string, fileName: string, actual: string): void {
  const file = path.join(GOLDEN, caseName, fileName);
  if (updating) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, actual, 'utf8');
    return;
  }
  assert.ok(existsSync(file), `missing golden file ${path.relative(ROOT, file)}: run npm run test:update-golden`);
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, expected, `${path.relative(ROOT, file)} changed (npm run test:update-golden if intended)`);
}

// The files a comparison writes, against test/golden/<caseName>. Snapshots only when both sides
// were live databases (a side read from a snapshot file saves none).
export function matchComparisonGoldens(caseName: string, c: Comparison, { snapshots = true } = {}): void {
  matchGolden(caseName, 'result.json', scrubJsonFile(c.files.json));
  matchGolden(caseName, 'sync.sql', scrubFile(c.files.sync));
  matchGolden(caseName, 'rollback.sql', scrubFile(c.files.rollback));
  if (!snapshots) return;
  matchGolden(caseName, 'source.snapshot.json', scrubJsonFile(c.files.sourceSnapshot, { sortKeys: true }));
  matchGolden(caseName, 'target.snapshot.json', scrubJsonFile(c.files.targetSnapshot, { sortKeys: true }));
}
