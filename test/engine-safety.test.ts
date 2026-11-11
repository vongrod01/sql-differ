// What the sync script does with a change that cannot be made: an index it cannot write, a
// constraint or unique index the existing rows break. Statements of the script are meant to fail
// here, so this is not a round trip: the point is that the target comes out no worse than it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixture, compare } from './support/engine.js';
import { matchComparisonGoldens } from './support/golden.js';
import { DB_PREFIX, query, runScriptFile, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const source = `${DB_PREFIX}safety_src`;
const target = `${DB_PREFIX}safety_tgt`;

// One line per index (primary keys left out), check constraint, foreign key and procedure, and
// one for the column whose type the source changes: its type and its default.
const STATE = [
  "SELECT CONCAT('index ', t.name, '.', i.name, ': ', i.type_desc COLLATE DATABASE_DEFAULT, CASE WHEN i.is_unique = 1 THEN ' UNIQUE' ELSE '' END, ' (',",
  '  (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id), \' columns)\')',
  'FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE i.type > 0 AND i.is_primary_key = 0',
  'UNION ALL',
  "SELECT CONCAT('check ', OBJECT_NAME(parent_object_id), '.', CASE WHEN is_system_named = 1 THEN '(unnamed)' ELSE name END, ': ', definition,",
  "  CASE WHEN is_disabled = 1 THEN ' DISABLED' ELSE ' ENABLED' END) FROM sys.check_constraints",
  'UNION ALL',
  "SELECT CONCAT('foreign key ', name, CASE WHEN is_disabled = 1 THEN ': DISABLED' ELSE ': ENABLED' END) FROM sys.foreign_keys",
  'UNION ALL',
  "SELECT CONCAT('procedure ', name) FROM sys.procedures",
  'UNION ALL',
  "SELECT CONCAT('column ', OBJECT_NAME(c.object_id), '.', c.name, ': ', TYPE_NAME(c.user_type_id), ', default ', ISNULL(dc.name + ' ' + dc.definition, '(none)'))",
  "FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id WHERE c.object_id = OBJECT_ID(N'dbo.Typed') AND c.name = N'Amount'",
].join(' ');

function state(): string[] {
  const run = query(STATE, target);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

function messageNumbers(output: string): string[] {
  return [...output.matchAll(/^Msg (\d+),/gm)].map((m) => m[1] ?? '');
}

test('engine: safety (a change that cannot be made leaves the existing object in place)', { skip }, async (t) => {
  buildFixture('safety', source, target);
  const initial = [
    'check Stock.(unnamed): ([Size]>(0)) DISABLED',
    'check Stock.CK_Changed: ([Price]>=(0)) ENABLED',
    'check Stock.CK_StateOnly: ([Qty]>=(0)) DISABLED',
    'column Typed.Amount: int, default DF_Typed_Amount ((1))',
    'foreign key FK_Child_Parent: ENABLED',
    'index Fact.NCCI_Fact: NONCLUSTERED COLUMNSTORE (2 columns)',
    'index FactToColumnstore.IX_FactToColumnstore: NONCLUSTERED (1 columns)',
    'index FactToRowstore.IX_FactToRowstore: NONCLUSTERED COLUMNSTORE (2 columns)',
    'index Stock.IX_Stock_Code: NONCLUSTERED (1 columns)',
    'index Typed.IX_Typed_Amount: NONCLUSTERED (1 columns)',
  ];
  assert.deepEqual(state(), initial, 'the fixture is not what this test expects');

  const before = compare({ dir: 'safety', name: 'before', source, target });
  assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');

  await t.test('output matches the golden files', () => {
    matchComparisonGoldens('safety', before, { snapshots: false });
  });

  await t.test('the sync script fails only where the rows forbid the change', () => {
    // Every batch runs, as in SSMS. The type change that the index on the column forbids (two
    // messages), the unique index over repeated codes, then the two checks.
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(run.output), ['5074', '4922', '1505', '547', '547'], run.output);
  });

  await t.test('what could not be replaced is still there, and the rest is changed', () => {
    assert.deepEqual(state(), [
      'check Stock.(unnamed): ([Size]>(0)) ENABLED', // switched on, under the name it has here
      'check Stock.CK_Changed: ([Price]>=(0)) ENABLED', // the add failed: the earlier one is back
      'check Stock.CK_StateOnly: ([Qty]>=(0)) DISABLED', // enabling failed: still there
      // The script dropped the default to change the type; the change failed, and the drop went with it.
      'column Typed.Amount: int, default DF_Typed_Amount ((1))',
      'foreign key FK_Child_Parent: DISABLED', // switched off, not rebuilt
      'index Fact.NCCI_Fact: NONCLUSTERED COLUMNSTORE (2 columns)', // no replacement scripted: kept
      'index FactToColumnstore.IX_FactToColumnstore: NONCLUSTERED (1 columns)', // same
      'index FactToRowstore.IX_FactToRowstore: NONCLUSTERED (1 columns)', // replaced
      'index Stock.IX_Stock_Code: NONCLUSTERED (1 columns)', // the unique create failed: the earlier one is back
      'index Typed.IX_Typed_Amount: NONCLUSTERED (1 columns)',
      // Created after every failure: a transaction left open by one of them (@@TRANCOUNT above 0)
      // would hold this too, and lose it when the session ends.
      'procedure pAfter',
    ]);
  });

  await t.test('rollback script runs without errors after the partly applied sync', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
  });

  await t.test('after rollback the target is as it was, except the index rollback cannot write', () => {
    const expected = initial.map((line) => (line.startsWith('index FactToRowstore.') ? 'index FactToRowstore.IX_FactToRowstore: NONCLUSTERED (1 columns)' : line));
    assert.deepEqual(state(), expected);
  });
});
