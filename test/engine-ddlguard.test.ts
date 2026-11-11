// Database triggers that refuse DDL (RAISERROR and ROLLBACK in a trigger ON DATABASE). The
// scripts create, change and drop such triggers themselves, and an enabled one fires on every
// statement after it, also on the statements of the script that put it there:
// - a sync script that enabled the source's guard left a target on which its own rollback script
//   could drop nothing (every DROP ended with Msg 3609);
// - a trigger created enabled refused the CREATE of the next trigger in the same script;
// - CREATE OR ALTER of an enabled trigger that watches ALTER TRIGGER fired on itself.
// So the scripts keep the database triggers they touch disabled until all of them are in place,
// and a rollback starts by disabling them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixture, compare, counts } from './support/engine.js';
import { matchGolden, scrubFile } from './support/golden.js';
import { DB_PREFIX, query, runScriptFile, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const source = `${DB_PREFIX}ddlguard_src`;
const target = `${DB_PREFIX}ddlguard_tgt`;
const same = { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 };

// The database triggers of a database: name, state, and whether trSelf has the source's text.
function databaseTriggers(database: string): string[] {
  const run = query([
    "SELECT CONCAT(t.name, CASE WHEN t.is_disabled = 1 THEN ' DISABLED' ELSE ' ENABLED' END,",
    "CASE WHEN m.definition LIKE '%(source)%' THEN ' (text of the source)' ELSE '' END)",
    'FROM sys.triggers t JOIN sys.sql_modules m ON m.object_id = t.object_id WHERE t.parent_class = 0',
  ].join(' '), database);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

// The index and the procedure that only the source has.
function added(database: string): string {
  const run = query("SELECT CONCAT('index:', (SELECT COUNT(*) FROM sys.indexes WHERE name = N'IX_Items_Name'), ' procedure:', (SELECT COUNT(*) FROM sys.procedures WHERE name = N'pItems'))", database);
  assert.ok(run.ok, run.output);
  return run.output.trim();
}

const SOURCE_TRIGGERS = ['trAaa ENABLED', 'trBlock ENABLED', 'trGuard ENABLED', 'trSelf ENABLED (text of the source)', 'trZeta ENABLED'];
const TARGET_TRIGGERS = ['trGuard DISABLED', 'trSelf ENABLED'];

test('engine: ddlguard (database triggers that refuse DDL do not stop the scripts that write them)', { skip }, async (t) => {
  buildFixture('ddlguard', source, target);
  assert.deepEqual(databaseTriggers(source), SOURCE_TRIGGERS, 'the fixture is not what this test expects');
  assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS, 'the fixture is not what this test expects');
  assert.equal(added(target), 'index:0 procedure:0');

  const before = compare({ dir: 'ddlguard', name: 'before', source, target });
  assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const diffs = before.result['diffs'] as { Object: string; Status: string; Detail: string }[];
  // By name, the two that refuse statements stand between the two that do not.
  assert.deepEqual(diffs.filter((d) => d.Object.endsWith('(database trigger)')).map((d) => `${d.Object}: ${d.Status}`), [
    'trAaa (database trigger): OnlyInSource',
    'trBlock (database trigger): OnlyInSource',
    'trGuard (database trigger): Different',
    'trSelf (database trigger): Different',
    'trZeta (database trigger): OnlyInSource',
  ]);
  assert.equal(diffs.find((d) => d.Object === 'trGuard (database trigger)')?.Detail, 'State: source ENABLED, target DISABLED');

  await t.test('output matches the golden files', () => {
    matchGolden('ddlguard', 'sync.sql', scrubFile(before.files.sync));
    matchGolden('ddlguard', 'rollback.sql', scrubFile(before.files.rollback));
  });

  // As SSMS runs it: every batch, whatever failed before. Nothing may fail.
  await t.test('the sync script runs without a single error', () => {
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    assert.equal(added(target), 'index:1 procedure:1');
  });

  await t.test('nothing is left to compare after sync', () => {
    const after = compare({ dir: 'ddlguard', name: 'after-sync', source, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // The target now has the source's guard, enabled: it refuses every DROP the rollback has to make.
  await t.test('the rollback script runs at the first go and puts the target back as it was', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);
    assert.equal(added(target), 'index:0 procedure:0');
    const after = compare({ dir: 'ddlguard', name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  await t.test('a second run of the rollback script changes nothing', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);
  });
});
