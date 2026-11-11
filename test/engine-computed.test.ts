// A column that a computed column uses cannot be altered: SQL Server answers Msg 5074 for every
// such computed column and then Msg 4922, whether the type, the length or NULL / NOT NULL changes
// and whether the computed column is persisted or not. The computed columns have to be dropped
// first and added again afterwards, and dropping a column is not for a script to do unasked: the
// scripts write the whole change as one group of comments to run by hand. A computed column that
// is new is added after the columns it uses have been changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildFixture, compare, counts, type Comparison } from './support/engine.js';
import { DB_PREFIX, mustRunScriptFile, query, runScriptFile, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const source = `${DB_PREFIX}computed_src`;
const target = `${DB_PREFIX}computed_tgt`;

function objectsWith(c: Comparison, status: string): string[] {
  const diffs = c.result['diffs'] as { Object: string; Status: string }[];
  return diffs.filter((d) => d.Status === status).map((d) => d.Object).sort();
}

// The groups a script leaves to run by hand because of computed columns: for every "-- Not run:"
// line that says so, the commented lines after it up to the GO of its batch, uncommented.
function byHandGroups(file: string): string[][] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const groups: string[][] = [];
  lines.forEach((line, i) => {
    if (!/^-- Not run: .*computed column/.test(line)) return;
    const group: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j] !== 'GO'; j++) {
      const text = lines[j] ?? '';
      assert.ok(text.startsWith('-- '), `a by-hand group holds only commented lines: ${text}`);
      group.push(text.slice(3));
    }
    groups.push(group);
  });
  return groups;
}

// One batch per group, as the script would run them were they not comments: after USE of the
// target, under the SET XACT_ABORT ON that every script starts with.
function runByHand(file: string, groups: string[][]): void {
  const batches = [`USE [${target}];`, 'SET XACT_ABORT ON;', ...groups.map((g) => g.join('\r\n'))];
  writeFileSync(file, `${batches.join('\r\nGO\r\n')}\r\nGO\r\n`, 'utf8');
  mustRunScriptFile(file);
}

// The rows of the fixture, with the values of their computed columns.
function rows(): string[] {
  const run = query([
    "SELECT CONCAT('Calc ', Id, ' ', Amount, ' ', WithVat) FROM dbo.Calc",
    "UNION ALL SELECT CONCAT('CalcP ', Id, ' ', Qty, ' ', Twice, ' ', Label, ' ', LabelUp, ' ', Flag, ' ', FlagPlus, ' ', Half) FROM dbo.CalcP",
    "UNION ALL SELECT CONCAT('CalcNew ', Id, ' ', Amount, ' ', Note) FROM dbo.CalcNew",
  ].join(' '), target);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

const ROWS = ['Calc 1 100.00 107.0000', 'CalcNew 1 50.00 kept', 'CalcP 1 21 42 abc ABC 7 8 10'];

test('engine: computed (a column that computed columns use is changed by hand, in one group)', { skip }, async (t) => {
  buildFixture('computed', source, target);
  assert.deepEqual(rows(), ROWS, 'the fixture is not what this test expects');

  const before = compare({ dir: 'computed', name: 'before', source, target });
  assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const changed = ['dbo.Calc.Amount', 'dbo.CalcP.Flag', 'dbo.CalcP.Label', 'dbo.CalcP.Qty'];
  for (const column of [...changed, 'dbo.CalcNew.Amount']) assert.ok(objectsWith(before, 'Different').includes(column), `${column} differs`);
  assert.deepEqual(objectsWith(before, 'OnlyInSource'), ['dbo.CalcNew.WithVat']);
  assert.deepEqual(objectsWith(before, 'OnlyInTarget'), ['dbo.CalcP.Half']);

  // Every batch, as SSMS runs a script. An active ALTER COLUMN on Calc.Amount fails with Msg 5074
  // and Msg 4922; so does the one on CalcNew.Amount when its new computed column is added first.
  await t.test('the sync script runs without errors, every batch', () => {
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.doesNotMatch(run.output, /^Msg /m, run.output);
  });

  await t.test('the sync script alone changes the column a new computed column uses, then adds that column', () => {
    const after = compare({ dir: 'computed', name: 'after-sync', source, target });
    assert.deepEqual(objectsWith(after, 'OnlyInSource'), []);
    const left = objectsWith(after, 'Different');
    assert.deepEqual(left.filter((o) => o.startsWith('dbo.CalcNew.')), [], 'CalcNew needs nothing by hand');
    // What is left is what the script wrote as comments: the four columns and the computed
    // columns whose type or nullability follows theirs.
    for (const column of changed) assert.ok(left.includes(column), `${column} is left for the by-hand lines: ${left.join(', ')}`);
    assert.deepEqual(left.filter((o) => !o.startsWith('dbo.Calc.') && !o.startsWith('dbo.CalcP.')), []);
    assert.deepEqual(rows(), ROWS);
  });

  await t.test('the lines to run by hand work as written and leave nothing to change', () => {
    const groups = byHandGroups(before.files.sync);
    assert.equal(groups.length, changed.length, `one group per column: ${JSON.stringify(groups, null, 2)}`);
    runByHand(before.files.sync.replace(/\.sql$/, '.by-hand.sql'), groups);
    const after = compare({ dir: 'computed', name: 'after-by-hand', source, target });
    const k = counts(after);
    assert.equal(k.different, 0, objectsWith(after, 'Different').join(', '));
    assert.equal(k.onlyInSource, 0);
    // Dropped and added again as it was: the script leaves what is only in the target.
    assert.deepEqual(objectsWith(after, 'OnlyInTarget'), ['dbo.CalcP.Half']);
    // The same rows; the computed column that is new has its value.
    assert.deepEqual(rows(), ROWS);
    const added = query("SELECT CONCAT(Amount, ' ', WithVat) FROM dbo.CalcNew", target);
    assert.equal(added.output.trim(), '50.00 53.5000');
  });

  // The rollback script has the same problem the other way round, with one more column in the
  // way: the computed column the sync script added to CalcNew, which a rollback does not drop.
  await t.test('the rollback script runs without errors, every batch', () => {
    const run = runScriptFile(before.files.rollback, undefined, { continueOnError: true });
    assert.doesNotMatch(run.output, /^Msg /m, run.output);
  });

  await t.test('the rollback lines to run by hand put the columns back as they were', () => {
    const groups = byHandGroups(before.files.rollback);
    assert.equal(groups.length, changed.length + 1, `one group per column, and CalcNew.Amount: ${JSON.stringify(groups, null, 2)}`);
    runByHand(before.files.rollback.replace(/\.sql$/, '.by-hand.sql'), groups);
    // Drift: the target as it was before the sync (snapshot) against the live target.
    const after = compare({ dir: 'computed', name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target });
    const k = counts(after);
    assert.equal(k.different, 0, objectsWith(after, 'Different').join(', '));
    assert.equal(k.onlyInSource, 0, objectsWith(after, 'OnlyInSource').join(', '));
    // Kept on purpose: a rollback drops no column.
    assert.deepEqual(objectsWith(after, 'OnlyInTarget'), ['dbo.CalcNew.WithVat']);
    assert.deepEqual(rows(), ROWS);
  });
});
