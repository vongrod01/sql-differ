// A target read by a login without VIEW DEFINITION: the catalog views hide objects from it, so an
// object that exists in the target can show as "only in source". The scripts must not treat such
// an object as theirs: the sync script must not replace it or add to it, the rollback script must
// not drop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, buildFixture, compare } from './support/engine.js';
import { matchGolden, scrubFile } from './support/golden.js';
import { DB_PREFIX, mustRunScriptFile, query, runScriptFile, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const source = `${DB_PREFIX}incomplete_src`;
const target = `${DB_PREFIX}incomplete_tgt`;

interface SnapshotItem {
  Name: string;
  Parent: string;
  Props: Record<string, string>;
  Sql: Record<string, unknown>;
}

interface Snapshot {
  canViewDefinition: boolean;
  categories: Record<string, Record<string, SnapshotItem>>;
}

// The three target objects the comparison does not see. dbo.pGetOrder: has it its own text (from
// the fixture's common.sql), the source's, or is it gone? dbo.trOrders_Insert, which is disabled
// in the source: is it still enabled here? dbo.synOrders, which is for dbo.vOrders in the source:
// is it still for dbo.Orders?
function hiddenObjects(): string {
  const run = query([
    "SELECT CONCAT('pGetOrder: ', ISNULL((SELECT CASE WHEN definition LIKE '%SELECT Id, Name, Amount FROM dbo.Orders%' THEN 'its own text' ELSE 'the text of the source' END",
    "FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.pGetOrder')), 'dropped'),",
    "'; trOrders_Insert: ', ISNULL((SELECT CASE WHEN is_disabled = 1 THEN 'disabled' ELSE 'enabled' END FROM sys.triggers WHERE name = N'trOrders_Insert'), 'dropped'),",
    "'; synOrders: ', ISNULL((SELECT base_object_name FROM sys.synonyms WHERE name = N'synOrders'), 'dropped'))",
  ].join(' '), target);
  assert.ok(run.ok, run.output);
  return run.output.trim();
}

const UNTOUCHED = 'pGetOrder: its own text; trOrders_Insert: enabled; synOrders: [dbo].[Orders]';

// What is on the two target tables whose contents the comparison cannot see: the check
// constraints of dbo.Customers (its unnamed check reads without an expression) and everything on
// dbo.Hidden (the whole table is invisible).
function hiddenChildren(): string[] {
  const run = query([
    "SELECT CONCAT('check ', OBJECT_NAME(parent_object_id), '.', CASE WHEN is_system_named = 1 THEN '(unnamed)' ELSE name END, ': ', definition)",
    "FROM sys.check_constraints WHERE parent_object_id IN (OBJECT_ID(N'dbo.Customers'), OBJECT_ID(N'dbo.Hidden'))",
    "UNION ALL SELECT CONCAT('index ', OBJECT_NAME(object_id), '.', name) FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Hidden') AND type > 0",
  ].join(' '), target);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

const CHILDREN_UNTOUCHED = ['check Customers.(unnamed): (len([Name])>(0))', 'check Hidden.(unnamed): ([V]>(0))', 'index Hidden.PK_Hidden'];

function messageNumbers(output: string): string[] {
  return [...output.matchAll(/^Msg (\d+),/gm)].map((m) => m[1] ?? '');
}

test('engine: incomplete (a target object the login cannot see is neither replaced nor dropped)', { skip }, async (t) => {
  buildFixture('core', source, target);
  for (const [file, database] of [['source.sql', source], ['target.sql', target]] as const) {
    mustRunScriptFile(path.join(ROOT, 'test', 'fixtures', 'incomplete', file), database);
  }
  assert.equal(hiddenObjects(), UNTOUCHED, 'the fixture is not what this test expects');
  assert.deepEqual(hiddenChildren(), CHILDREN_UNTOUCHED, 'the fixture is not what this test expects');

  // The target as a login without VIEW DEFINITION reads it: flagged, and without a procedure, a
  // trigger and a synonym that are really there (and differ from the source's).
  const live = compare({ dir: 'incomplete', name: 'live', source, target });
  const snapshot = JSON.parse(readFileSync(live.files.targetSnapshot, 'utf8')) as Snapshot;
  for (const [category, key] of [['Stored procedure', 'dbo.pGetOrder'], ['Trigger', 'dbo.trOrders_Insert'], ['Synonym', 'dbo.synOrders']] as const) {
    assert.ok(snapshot.categories[category]?.[key], `the target snapshot has ${key}`);
    delete snapshot.categories[category]?.[key];
  }
  // Without a table that is there, and everything on it.
  assert.ok(snapshot.categories['Table']?.['dbo.Hidden'], 'the target snapshot has dbo.Hidden');
  delete snapshot.categories['Table']?.['dbo.Hidden'];
  const hiddenWithTable: string[] = [];
  for (const category of ['Column', 'Index', 'Check constraint', 'Foreign key']) {
    for (const [key, item] of Object.entries(snapshot.categories[category] ?? {})) {
      if (item.Parent === 'dbo.Hidden') { delete snapshot.categories[category]?.[key]; hiddenWithTable.push(`${category} ${item.Name}`); }
    }
  }
  assert.ok(hiddenWithTable.includes('Index dbo.Hidden (primary key)') && hiddenWithTable.some((name) => name.startsWith('Check constraint dbo.Hidden (check: ')), hiddenWithTable.join('\n'));
  // And with the unnamed check of dbo.Customers as such a login reads it: no expression, so it is
  // known by its generated name only, where the source's is known by its expression.
  const checks = snapshot.categories['Check constraint'] ?? {};
  const [checkKey, check] = Object.entries(checks).find(([key]) => key.startsWith('dbo.Customers|CK:')) ?? [];
  assert.ok(checkKey && check, 'the target snapshot has the unnamed check of dbo.Customers');
  const checkName = String(check.Sql['Name']);
  delete checks[checkKey];
  checks[`dbo.Customers|${checkName}`] = { ...check, Name: `dbo.Customers.${checkName}`, Props: { ...check.Props, Expression: '(not readable)' } };
  snapshot.canViewDefinition = false;
  const hidden = path.join(path.dirname(live.files.targetSnapshot), 'hidden.target.snapshot.json');
  writeFileSync(hidden, JSON.stringify(snapshot), 'utf8');

  const before = compare({ dir: 'incomplete', name: 'before', source, targetSnapshot: hidden });
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const diffs = before.result['diffs'] as { Object: string; Status: string }[];
  for (const name of ['dbo.pGetOrder', 'dbo.trOrders_Insert', 'dbo.synOrders', 'dbo.Hidden', 'dbo.Customers (check: (len([Name])>(0)))']) {
    assert.equal(diffs.find((d) => d.Object === name)?.Status, 'OnlyInSource', `the hidden ${name} reads as only in source`);
  }

  await t.test('output matches the golden files', () => {
    matchGolden('incomplete', 'sync.sql', scrubFile(before.files.sync));
    matchGolden('incomplete', 'rollback.sql', scrubFile(before.files.rollback));
  });

  await t.test('the sync script fails on the objects that are already there and leaves them as they are', () => {
    // Every batch runs, as in SSMS. Msg 2714: There is already an object named ... (the table,
    // the procedure, then the trigger, whose state must not follow the source's either, then the
    // synonym, which CREATE SYNONYM does not replace).
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(run.output), ['2714', '2714', '2714', '2714'], run.output);
    assert.equal(hiddenObjects(), UNTOUCHED);
  });

  // The CREATE TABLE of dbo.Hidden failed, and the source's index and checks must not land on the
  // table that is there instead. The unnamed check of dbo.Customers must not be added a second
  // time (it would be, at every run: nothing can pair it with the one that is there).
  await t.test('the sync script adds nothing to a table it did not create, and no second copy of an unnamed check', () => {
    assert.deepEqual(hiddenChildren(), CHILDREN_UNTOUCHED);
  });

  await t.test('the rollback script runs without errors and does not drop them', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.equal(hiddenObjects(), UNTOUCHED);
    assert.deepEqual(hiddenChildren(), CHILDREN_UNTOUCHED);
  });
});
