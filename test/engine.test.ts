// Golden and round-trip tests of Compare-Database.ps1 against scratch databases on the test server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CASES } from './cases.js';
import { buildFixture, compare, counts, type Comparison } from './support/engine.js';
import { matchComparisonGoldens, matchGolden, scrubJsonFile } from './support/golden.js';
import {
  DB_PREFIX, USER_OBJECT_COUNT, dropDatabase, fromUnicodeHex, query, recreateDatabase, runScriptFile, skipWithoutServer, unicodeHex,
} from './support/sql.js';

const skip = skipWithoutServer();

function noScriptErrors(c: Comparison): void {
  assert.equal(c.result['syncError'], '', 'sync script generation failed');
  assert.equal(c.result['rollbackError'], '', 'rollback script generation failed');
}

// The SET options stored with the procedures of the core fixture that this is about (see its
// source.sql), and with pGetOrder, which the scripts write after one of them.
function moduleSetOptions(database: string): string[] {
  const run = query([
    "SELECT CONCAT(OBJECT_NAME(object_id), ': ANSI_NULLS ', CASE uses_ansi_nulls WHEN 1 THEN 'ON' ELSE 'OFF' END,",
    "', QUOTED_IDENTIFIER ', CASE uses_quoted_identifier WHEN 1 THEN 'ON' ELSE 'OFF' END)",
    "FROM sys.sql_modules WHERE OBJECT_NAME(object_id) IN (N'pAnsiOff', N'pAnsiOffNew', N'pQuotedOff', N'pGetOrder') ORDER BY 1",
  ].join(' '), database);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/);
}

// The indexes of the views of a database: view.index, its type and how many columns it names.
function viewIndexes(database: string): string[] {
  const run = query([
    "SELECT CONCAT(v.name, '.', i.name, ' ', i.type_desc COLLATE DATABASE_DEFAULT, ' (',",
    '(SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id), \')\')',
    'FROM sys.indexes i JOIN sys.views v ON v.object_id = i.object_id WHERE i.type > 0',
  ].join(' '), database);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

// As the core fixture's target.sql creates them.
const TARGET_VIEW_INDEXES = [
  'vSalesByRegion.CIX_vSalesByRegion CLUSTERED (1)',
  'vSalesByRegion.IX_vSalesByRegion_Total NONCLUSTERED (1)',
  'vSalesTotals.CIX_vSalesTotals CLUSTERED (1)',
];

// The database triggers (ON DATABASE) of a database: name, state and the events each fires on.
function databaseTriggers(database: string): string[] {
  const run = query([
    "SELECT CONCAT(t.name, ' ', CASE WHEN t.is_disabled = 1 THEN 'DISABLED' ELSE 'ENABLED' END, ' ',",
    "(SELECT STRING_AGG(te.type_desc COLLATE DATABASE_DEFAULT, ',') WITHIN GROUP (ORDER BY te.type_desc) FROM sys.trigger_events te WHERE te.object_id = t.object_id))",
    'FROM sys.triggers t WHERE t.parent_class = 0',
  ].join(' '), database);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

// As the core fixture's common.sql and target.sql create them.
const TARGET_DATABASE_TRIGGERS = ['trDdlChanged ENABLED CREATE_SYNONYM', 'trDdlLegacy ENABLED DROP_SYNONYM', 'trDdlState ENABLED CREATE_SYNONYM'];

function categoriesOf(c: Comparison, status: string): string[] {
  const diffs = c.result['diffs'] as { Category: string; Status: string }[];
  return [...new Set(diffs.filter((d) => d.Status === status).map((d) => d.Category))].sort();
}

for (const c of CASES) {
  test(`engine: ${c.name}`, { skip }, async (t) => {
    const db = DB_PREFIX + c.name.replace(/-/g, '_');
    const source = `${db}_src`;
    const target = `${db}_tgt`;
    buildFixture(c.fixture, source, target);

    const before = compare({ dir: c.name, name: 'before', source, target, options: c.options, categories: c.categories });
    assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
    noScriptErrors(before);

    await t.test('output matches the golden files', () => {
      matchComparisonGoldens(c.name, before);
    });

    // Differences no script can make (another computed definition, an object of another type, a
    // type that cannot be altered): no round trip, but the scripts must still run, every batch,
    // and what each leaves to compare is kept in the golden files.
    if (c.apply) {
      await t.test('sync script runs on the target without errors', () => {
        const run = runScriptFile(before.files.sync);
        assert.ok(run.ok, run.output);
      });

      await t.test('what is left to compare after sync matches the golden file', () => {
        const after = compare({ dir: c.name, name: 'after-sync', source, target, options: c.options, categories: c.categories });
        noScriptErrors(after);
        matchGolden(c.name, 'after-sync.json', scrubJsonFile(after.files.json));
      });

      await t.test('rollback script runs on the target without errors, twice', () => {
        for (let i = 0; i < 2; i++) {
          const run = runScriptFile(before.files.rollback);
          assert.ok(run.ok, run.output);
        }
      });

      await t.test('what is left to compare after rollback matches the golden file', () => {
        const after = compare({ dir: c.name, name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target, options: c.options, categories: c.categories });
        noScriptErrors(after);
        matchGolden(c.name, 'after-rollback.json', scrubJsonFile(after.files.json));
      });
    }

    if (!c.roundTrip) return;

    // A USE that fails (SSMS connected to another server, no access) ends only its own batch.
    // Without the check after it, every later batch runs in the database the session was in.
    await t.test('a script whose database cannot be used changes nothing', () => {
      const other = `${db}_other`;
      const gone = `${db}_gone`;
      recreateDatabase(other);
      dropDatabase(gone);
      for (const script of [before.files.sync, before.files.rollback]) {
        const name = path.basename(script);
        const text = readFileSync(script, 'utf8');
        const copy = script.replace(/\.sql$/, '.wrong-database.sql');
        writeFileSync(copy, text.split(target).join(gone), 'utf8');
        // As SSMS runs it: every batch, whatever failed before.
        const run = runScriptFile(copy, other, { continueOnError: true });
        assert.equal(query(USER_OBJECT_COUNT, other).output.trim(), '0', `${name} ran in another database:\n${run.output}`);
        assert.match(run.output, /cannot use database/, `${name}:\n${run.output}`);
        // The check stops the script with NOEXEC, which must not outlive it in the session.
        assert.ok(text.replace(/\r\n/g, '\n').endsWith('\nSET NOEXEC OFF;\nGO\n'), `${name} must end by turning NOEXEC off`);
      }
    });

    await t.test('sync script runs on the target without errors', () => {
      const run = runScriptFile(before.files.sync);
      assert.ok(run.ok, run.output);
    });

    await t.test('after sync only the target-only objects differ', () => {
      const after = compare({ dir: c.name, name: 'after-sync', source, target, options: c.options, categories: c.categories });
      noScriptErrors(after);
      const k = counts(after);
      assert.equal(k.onlyInSource, 0, 'sync script left objects out');
      assert.equal(k.different, 0, 'sync script left differences');
      assert.equal(k.onlyInTarget, counts(before).onlyInTarget, 'sync script dropped or added target-only objects');
      matchGolden(c.name, 'after-sync.json', scrubJsonFile(after.files.json));
    });

    // sp_rename and ALTER SCHEMA ... TRANSFER leave the earlier name in the stored text of a module.
    // Replayed as it is, pRenamed's text would overwrite the target's own pOldName, vMoved would
    // land in dbo, and trAudit would name a table that is called Audit now.
    await t.test('sync creates renamed and moved modules under their catalog names', () => {
      const run = query([
        "SELECT CONCAT('pRenamed:', CASE WHEN OBJECT_ID(N'dbo.pRenamed') IS NULL THEN 'missing' ELSE 'created' END,",
        "' pOldName:', (SELECT CASE WHEN definition LIKE '%target only%' THEN 'kept' ELSE 'overwritten' END FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.pOldName')),",
        "' rpt.vMoved:', CASE WHEN OBJECT_ID(N'rpt.vMoved') IS NULL THEN 'missing' ELSE 'created' END,",
        "' dbo.vMoved:', CASE WHEN OBJECT_ID(N'dbo.vMoved') IS NULL THEN 'absent' ELSE 'created' END,",
        "' trAudit on:', (SELECT OBJECT_NAME(parent_id) FROM sys.triggers WHERE name = N'trAudit'))",
      ].join(' '), target);
      assert.ok(run.ok, run.output);
      // The trigger only when triggers are compared (the table it is on is created either way).
      assert.equal(run.output.trim(), `pRenamed:created pOldName:kept rpt.vMoved:created dbo.vMoved:absent trAudit on:${c.categories ? '' : 'Audit'}`);
    });

    // ALTER VIEW drops every index of the view, and CREATE OR ALTER VIEW is an ALTER when the view
    // is there. The sync script alters vSalesTotals: without creating its indexes again, the
    // target would lose the clustered index it had and never get the new one.
    await t.test('sync leaves the views with the indexes they have in the source', () => {
      assert.deepEqual(viewIndexes(target), c.categories ? [
        // Indexes are not compared here: only the views the script wrote get theirs.
        'vSalesBig.CIX_vSalesBig CLUSTERED (1)',
        'vSalesByRegion.CIX_vSalesByRegion CLUSTERED (1)',
        'vSalesByRegion.IX_vSalesByRegion_Total NONCLUSTERED (1)',
        'vSalesTotals.CIX_vSalesTotals CLUSTERED (1)',
        'vSalesTotals.IX_vSalesTotals_Region NONCLUSTERED (1)',
      ] : [
        'vSalesBig.CIX_vSalesBig CLUSTERED (1)',
        'vSalesByRegion.CIX_vSalesByRegion CLUSTERED (1)',
        'vSalesByRegion.IX_vSalesByRegion_Cnt NONCLUSTERED (1)',
        'vSalesByRegion.IX_vSalesByRegion_Total NONCLUSTERED (2)',
        'vSalesTotals.CIX_vSalesTotals CLUSTERED (1)',
        'vSalesTotals.IX_vSalesTotals_Region NONCLUSTERED (1)',
      ]);
    });

    // Database triggers: one altered, one disabled, one created, and the target's own one left.
    // (Not when triggers are not compared: then the target's stay as they are.)
    await t.test('sync makes the database triggers as they are in the source', () => {
      assert.deepEqual(databaseTriggers(target), c.categories ? TARGET_DATABASE_TRIGGERS : [
        'trDdlChanged ENABLED CREATE_SYNONYM,DROP_SYNONYM',
        'trDdlLegacy ENABLED DROP_SYNONYM',
        'trDdlNew ENABLED DROP_SYNONYM',
        'trDdlState DISABLED CREATE_SYNONYM',
      ]);
    });

    // A new table or column can need a type or a sequence that the target does not have. When
    // types and sequences are not among the compared categories (the default), nothing else
    // creates them, and CREATE TABLE fails (Msg 2715: cannot find data type dbo.tPhone).
    await t.test('sync creates the types and sequences that new tables and columns use', () => {
      const run = query("SELECT CONCAT('tPhone:', CASE WHEN TYPE_ID(N'dbo.tPhone') IS NULL THEN 'missing' ELSE 'created' END, ' seqShipment:', CASE WHEN OBJECT_ID(N'dbo.seqShipment', N'SO') IS NULL THEN 'missing' ELSE 'created' END, ' Shipments.Seq:', (SELECT definition FROM sys.default_constraints WHERE name = N'DF_Shipments_Seq'))", target);
      assert.ok(run.ok, run.output);
      assert.equal(run.output.trim(), 'tPhone:created seqShipment:created Shipments.Seq:(NEXT VALUE FOR [dbo].[seqShipment])');
    });

    // "AS decimal" alone is decimal(18,0): the limits of seqBig, a decimal(28,0), do not fit it
    // (Msg 11708). Only when sequences are compared: no new table or column uses this one.
    if (!c.categories) {
      await t.test('sync creates a decimal sequence with its precision', () => {
        const run = query("SELECT CONCAT(TYPE_NAME(user_type_id), '(', precision, ',', scale, ') up to ', CAST(maximum_value AS varchar(50))) FROM sys.sequences WHERE name = N'seqBig'", target);
        assert.ok(run.ok, run.output);
        assert.equal(run.output.trim(), 'decimal(28,0) up to 9999999999999999999999999999');
      });
    }

    // A table type is more than its column names and types (all the engine read before 2026-11-11).
    if (!c.categories) {
      await t.test('sync creates a table type with its identity, default, computed column, keys, check and collation', () => {
        const of = (view: string, columns: string) => `(SELECT ${columns} FROM ${view} WHERE object_id = tt.type_table_object_id)`;
        const run = query([
          "SELECT CONCAT('identity:', " + of('sys.identity_columns', "CONCAT(CAST(seed_value AS varchar(20)), ',', CAST(increment_value AS varchar(20)))") + ',',
          "' default:', (SELECT definition FROM sys.default_constraints WHERE parent_object_id = tt.type_table_object_id),",
          "' computed:', " + of('sys.computed_columns', "CONCAT(definition, CASE WHEN is_persisted = 1 THEN ' PERSISTED' END, CASE WHEN is_nullable = 0 THEN ' NOT NULL' END)") + ',',
          "' primary keys:', (SELECT COUNT(*) FROM sys.indexes WHERE object_id = tt.type_table_object_id AND is_primary_key = 1),",
          "' unique constraints:', (SELECT COUNT(*) FROM sys.indexes WHERE object_id = tt.type_table_object_id AND is_unique_constraint = 1),",
          "' keys that ignore duplicates:', (SELECT COUNT(*) FROM sys.indexes WHERE object_id = tt.type_table_object_id AND ignore_dup_key = 1),",
          "' collations:', (SELECT STRING_AGG(CONCAT(name, ' ', collation_name), ', ') WITHIN GROUP (ORDER BY column_id) FROM sys.columns WHERE object_id = tt.type_table_object_id AND collation_name IS NOT NULL),",
          "' check:', (SELECT definition FROM sys.check_constraints WHERE parent_object_id = tt.type_table_object_id))",
          "FROM sys.table_types tt WHERE tt.name = N'tRows'",
        ].join(' '), target);
        assert.ok(run.ok, run.output);
        // With -IgnoreCollation a new column gets the collation of the target database, as a
        // table's does (the database is Thai_CI_AS; Note has that in the source as well).
        const code = c.options.includes('-IgnoreCollation') ? 'Thai_CI_AS' : 'Latin1_General_BIN';
        assert.equal(run.output.trim(), `identity:10,5 default:((1)) computed:([Qty]*(2)) PERSISTED NOT NULL primary keys:1 unique constraints:1 keys that ignore duplicates:1 collations:Code ${code}, Note Thai_CI_AS check:([Qty]>(0))`);
      });
    }

    // A module runs under the ANSI_NULLS and QUOTED_IDENTIFIER it was created with, not the
    // caller's. pAnsiOff differs from the target's in nothing else; pGetOrder comes after it in
    // the script and must still get the script's own options.
    await t.test('sync creates modules under the SET options they have in the source', () => {
      assert.deepEqual(moduleSetOptions(target), [
        'pAnsiOff: ANSI_NULLS OFF, QUOTED_IDENTIFIER ON',
        'pAnsiOffNew: ANSI_NULLS OFF, QUOTED_IDENTIFIER ON',
        'pGetOrder: ANSI_NULLS ON, QUOTED_IDENTIFIER ON',
        'pQuotedOff: ANSI_NULLS ON, QUOTED_IDENTIFIER OFF',
      ]);
    });

    // Both found by this suite on 2026-10-28: the scripts dropped PERSISTED and default names.
    await t.test('sync keeps PERSISTED on computed columns', () => {
      // Of tables: a table type has computed columns too (tRows).
      const run = query("SELECT CONCAT(t.name, '.', cc.name, '=', cc.is_persisted) FROM sys.computed_columns cc JOIN sys.tables t ON t.object_id = cc.object_id ORDER BY 1", target);
      assert.ok(run.ok, run.output);
      assert.deepEqual(run.output.trim().split(/\r?\n/), ['AllTypes.cComputed=1', 'AllTypes.cComputedNN=1', 'Orders.AmountWithVat=1']);
    });

    await t.test('sync keeps the names of named default constraints', () => {
      const run = query('SELECT name FROM sys.default_constraints WHERE is_system_named = 0 ORDER BY name', target);
      assert.deepEqual(run.output.trim().split(/\r?\n/), ['DF_AllTypes_cBit', 'DF_AllTypes_cGuid', 'DF_Orders_Amount', 'DF_Orders_CreatedAt', 'DF_Orders_Qty', 'DF_Shipments_Seq']);
    });

    await t.test('rollback script runs on the target without errors', () => {
      const run = runScriptFile(before.files.rollback);
      assert.ok(run.ok, run.output);
    });

    await t.test('after rollback the target matches its snapshot, except what rollback keeps', () => {
      // Drift: the target as it was before the sync (snapshot) against the live target.
      const after = compare({ dir: c.name, name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target, options: c.options, categories: c.categories });
      noScriptErrors(after);
      const k = counts(after);
      assert.equal(k.onlyInSource, 0, 'rollback did not restore objects');
      assert.equal(k.different, 0, 'rollback did not restore changed objects');
      // Kept on purpose (dropping them loses data written after the sync), plus the unnamed check,
      // which got a new system-generated name on the target and cannot be dropped by name.
      const kept = ['Check constraint', 'Column', 'Schema', 'Sequence', 'Table', 'User-defined type'];
      for (const category of categoriesOf(after, 'OnlyInTarget')) assert.ok(kept.includes(category), `rollback left ${category}`);
      matchGolden(c.name, 'after-rollback.json', scrubJsonFile(after.files.json));
    });

    await t.test('rollback script can run again', () => {
      const run = runScriptFile(before.files.rollback);
      assert.ok(run.ok, run.output);
    });

    // The rollback alters vSalesTotals back, which drops its indexes once more.
    await t.test('rollback puts back the indexes of the views', () => {
      assert.deepEqual(viewIndexes(target), TARGET_VIEW_INDEXES);
    });

    await t.test('rollback puts back the database triggers', () => {
      assert.deepEqual(databaseTriggers(target), TARGET_DATABASE_TRIGGERS);
    });

    await t.test('rollback puts back the SET options of a changed module', () => {
      assert.deepEqual(moduleSetOptions(target), ['pAnsiOff: ANSI_NULLS ON, QUOTED_IDENTIFIER ON', 'pGetOrder: ANSI_NULLS ON, QUOTED_IDENTIFIER ON']);
    });

    await t.test('rollback puts back PERSISTED and default names', () => {
      const persisted = query("SELECT is_persisted FROM sys.computed_columns WHERE object_id = OBJECT_ID(N'dbo.Orders') AND name = N'AmountWithVat'", target);
      assert.equal(persisted.output.trim(), '0');
      const defaults = query("SELECT CONCAT(name, '=', definition) FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.Orders') ORDER BY name", target);
      assert.deepEqual(defaults.output.trim().split(/\r?\n/), ['DF_Orders_Amount=((0))', 'DF_Orders_CreatedAt=(sysdatetime())', 'DF_Orders_Qty=((1))']);
    });

    await t.test('data survives sync and rollback', () => {
      const orders = query('SELECT CONCAT(Id, \'|\', Name, \'|\', Amount) FROM dbo.Orders ORDER BY Id', target);
      assert.ok(orders.ok, orders.output);
      assert.equal(orders.output.trim(), '1|first|5.00');
      const customers = query(`SELECT ${unicodeHex('Name')} FROM dbo.Customers WHERE Id = 1`, target);
      assert.ok(customers.ok, customers.output);
      assert.equal(fromUnicodeHex(customers.output), 'ลูกค้า ทดสอบ');
    });
  });
}
