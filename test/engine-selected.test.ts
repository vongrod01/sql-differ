// The sync and rollback script of part of a comparison: Compare-Database.ps1 -ScriptFromResult builds
// them from the result file and the two snapshots that a run keeps, with no database. The golden
// files of test/golden/<case>/ stand in for the files of a run, so none of this needs a SQL Server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GOLDEN, scrubFile } from './support/golden.js';
import { OUT, runEngine } from './support/engine.js';

type Kind = 'sync' | 'rollback';
interface Need { row: number; object: string; needsRow: number; needs: string }
interface Info { selected: number; total: number; needs: Need[] }
interface Made { exitCode: number | null; log: string; text: string; info: Info | null }

const FILES = ['result.json', 'source.snapshot.json', 'target.snapshot.json', 'sync.sql', 'rollback.sql'];
const CASES = readdirSync(GOLDEN).filter((name) => FILES.every((file) => existsSync(path.join(GOLDEN, name, file))));

// What the web app keeps of a run next to its report: <base>.json and the two snapshots.
function runFolder(caseName: string): string {
  const dir = path.join(OUT, 'selected', caseName);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(GOLDEN, caseName, 'result.json'), path.join(dir, 'run.json'));
  copyFileSync(path.join(GOLDEN, caseName, 'source.snapshot.json'), path.join(dir, 'run.source.snapshot.json'));
  copyFileSync(path.join(GOLDEN, caseName, 'target.snapshot.json'), path.join(dir, 'run.target.snapshot.json'));
  return dir;
}

function diffCount(caseName: string): number {
  return (JSON.parse(readFileSync(path.join(GOLDEN, caseName, 'result.json'), 'utf8')) as { diffs: unknown[] }).diffs.length;
}

function make(caseName: string, kind: Kind, rows: unknown, { dir = runFolder(caseName), kindArg = kind as string } = {}): Made {
  const selection = path.join(dir, `selection-${kind}.json`);
  const output = path.join(dir, `selected.${kind}.sql`);
  rmSync(output, { force: true });
  writeFileSync(selection, JSON.stringify({ rows }), 'utf8');
  const run = runEngine(['-ScriptFromResult', path.join(dir, 'run.json'), '-ScriptSelection', selection, '-ScriptKind', kindArg, '-ScriptOutput', output]);
  let info: Info | null = null;
  try { info = JSON.parse(run.stdout) as Info; } catch { info = null; }
  return { exitCode: run.exitCode, log: run.log, text: existsSync(output) ? scrubFile(output) : '', info };
}

const golden = (caseName: string, kind: Kind): string => readFileSync(path.join(GOLDEN, caseName, `${kind}.sql`), 'utf8').replace(/\r\n/g, '\n');

test('selected script: there are golden cases to stand in for runs', () => {
  assert.ok(CASES.includes('core'), `cases with a result and both snapshots: ${CASES.join(', ')}`);
});

// The strongest check there is without a server: the selection runs through the same generator as the
// comparison, so choosing everything must give exactly what the comparison wrote.
for (const caseName of CASES) {
  for (const kind of ['sync', 'rollback'] as const) {
    test(`selected script: every row of "${caseName}" gives the ${kind} script the comparison wrote`, () => {
      const total = diffCount(caseName);
      const made = make(caseName, kind, Array.from({ length: total }, (_, i) => i));
      assert.equal(made.exitCode, 0, made.log);
      assert.deepEqual(made.info, { selected: total, total, needs: [] });
      assert.equal(made.text, golden(caseName, kind));
    });
  }
}

test('selected script: one row gives that object and no other, and says it is a selection', () => {
  // core: 31 = stored procedure dbo.pNewOrder (only in source), 29 = dbo.pGetOrder, 33 = dbo.pQuotedOff.
  const sync = make('core', 'sync', [31]);
  assert.equal(sync.exitCode, 0, sync.log);
  assert.deepEqual(sync.info, { selected: 1, total: 49, needs: [] });
  assert.match(sync.text, /dbo\]?\.\[?pNewOrder/);
  assert.doesNotMatch(sync.text, /pGetOrder|pQuotedOff|AllTypes|Shipments/);
  assert.match(sync.text, /Generated from a selection: 1 of 49 differences/);

  const rollback = make('core', 'rollback', [31]);
  assert.equal(rollback.exitCode, 0, rollback.log);
  assert.match(rollback.text, /pNewOrder/);
  assert.doesNotMatch(rollback.text, /pGetOrder|pQuotedOff|AllTypes|Shipments/);
  assert.match(rollback.text, /Generated from a selection: 1 of 49 differences/);

  const two = make('core', 'sync', [29, 31]);
  assert.deepEqual(two.info, { selected: 2, total: 49, needs: [] });
  assert.match(two.text, /pGetOrder/);
  assert.match(two.text, /pNewOrder/);
  assert.doesNotMatch(two.text, /pQuotedOff/);
});

test('selected script: rows chosen in another order give the same script', () => {
  assert.equal(make('core', 'sync', [31, 29, 33]).text, make('core', 'sync', [29, 33, 31]).text);
});

test('selected script: only a row that exists on the target alone still gives a valid file that names it', () => {
  // core: 30 = dbo.pLegacyCleanup, only in the target. The sync script does not drop it (the DROP is a comment).
  const made = make('core', 'sync', [30]);
  assert.equal(made.exitCode, 0, made.log);
  assert.deepEqual(made.info, { selected: 1, total: 49, needs: [] });
  assert.match(made.text, /pLegacyCleanup/);
  assert.doesNotMatch(made.text, /pNewOrder/);
});

test('selected script: rows that make no sense are refused and no file is written', () => {
  for (const rows of [[], [49], [-1], [1, 1], [1.5], ['1'], 'all', null]) {
    const made = make('core', 'sync', rows);
    assert.equal(made.exitCode, 2, `${JSON.stringify(rows)}\n${made.log}`);
    assert.match(made.log, /rows/i, JSON.stringify(rows));
    assert.equal(made.text, '', JSON.stringify(rows));
  }
});

test('selected script: a kind that is neither sync nor rollback is refused', () => {
  const made = make('core', 'sync', [31], { kindArg: 'drop' });
  assert.equal(made.exitCode, 2, made.log);
  assert.match(made.log, /-ScriptKind/);
});

test('selected script: a run without its snapshots is refused with a message that says so', () => {
  const dir = runFolder('core');
  rmSync(path.join(dir, 'run.target.snapshot.json'), { force: true });
  const made = make('core', 'sync', [31], { dir });
  assert.equal(made.exitCode, 2, made.log);
  assert.match(made.log, /snapshot/i);
  assert.equal(made.text, '');
});

// core: 37 = trigger dbo.trAudit (only in source) on dbo.Audit, a table that is new (row 2).
// 19 = foreign key on dbo.Orders, which both sides have.
test('selected script: a trigger of a new table that is not chosen too is reported as needing it', () => {
  const alone = make('core', 'sync', [37]);
  assert.equal(alone.exitCode, 0, alone.log);
  assert.deepEqual(alone.info?.needs, [{ row: 37, object: 'dbo.trAudit', needsRow: 2, needs: 'dbo.Audit' }]);
  // The file says it too: it may be taken without the page that warned.
  assert.match(alone.text, /WARNING:.*trAudit.*dbo\.Audit/);

  const both = make('core', 'sync', [2, 37]);
  assert.deepEqual(both.info?.needs, []);
  assert.doesNotMatch(both.text, /WARNING:/);

  const fk = make('core', 'sync', [19]);
  assert.deepEqual(fk.info?.needs, []);
});
