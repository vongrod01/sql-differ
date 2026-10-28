// Golden and round-trip tests of Compare-Database.ps1 against scratch databases on the test server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CASES } from './cases.js';
import { ROOT, compare, counts, type Comparison } from './support/engine.js';
import { matchGolden, scrubFile, scrubJsonFile } from './support/golden.js';
import { DB_PREFIX, fromUnicodeHex, mustRunScriptFile, query, recreateDatabase, runScriptFile, skipWithoutServer, unicodeHex } from './support/sql.js';

const skip = skipWithoutServer();

function noScriptErrors(c: Comparison): void {
  assert.equal(c.result['syncError'], '', 'sync script generation failed');
  assert.equal(c.result['rollbackError'], '', 'rollback script generation failed');
}

function categoriesOf(c: Comparison, status: string): string[] {
  const diffs = c.result['diffs'] as { Category: string; Status: string }[];
  return [...new Set(diffs.filter((d) => d.Status === status).map((d) => d.Category))].sort();
}

for (const c of CASES) {
  test(`engine: ${c.name}`, { skip }, async (t) => {
    const db = DB_PREFIX + c.name.replace(/-/g, '_');
    const source = `${db}_src`;
    const target = `${db}_tgt`;
    const fixture = path.join(ROOT, 'test', 'fixtures', c.fixture);

    recreateDatabase(source);
    recreateDatabase(target);
    const steps: [string, string[]][] = [['common.sql', [source, target]], ['source.sql', [source]], ['target.sql', [target]]];
    for (const [file, databases] of steps) {
      const script = path.join(fixture, file);
      if (!existsSync(script)) continue;
      for (const database of databases) mustRunScriptFile(script, database);
    }

    const before = compare({ dir: c.name, name: 'before', source, target, options: c.options });
    assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
    noScriptErrors(before);

    await t.test('output matches the golden files', () => {
      matchGolden(c.name, 'result.json', scrubJsonFile(before.files.json));
      matchGolden(c.name, 'sync.sql', scrubFile(before.files.sync));
      matchGolden(c.name, 'rollback.sql', scrubFile(before.files.rollback));
      matchGolden(c.name, 'source.snapshot.json', scrubJsonFile(before.files.sourceSnapshot, { sortKeys: true }));
      matchGolden(c.name, 'target.snapshot.json', scrubJsonFile(before.files.targetSnapshot, { sortKeys: true }));
    });

    if (!c.roundTrip) return;

    await t.test('sync script runs on the target without errors', () => {
      const run = runScriptFile(before.files.sync);
      assert.ok(run.ok, run.output);
    });

    await t.test('after sync only the target-only objects differ', () => {
      const after = compare({ dir: c.name, name: 'after-sync', source, target, options: c.options });
      noScriptErrors(after);
      const k = counts(after);
      assert.equal(k.onlyInSource, 0, 'sync script left objects out');
      assert.equal(k.different, 0, 'sync script left differences');
      assert.equal(k.onlyInTarget, counts(before).onlyInTarget, 'sync script dropped or added target-only objects');
      matchGolden(c.name, 'after-sync.json', scrubJsonFile(after.files.json));
    });

    // Known gaps, found by this suite (2026-10-28). Remove `todo` once the engine is fixed.
    await t.test('sync keeps PERSISTED on computed columns', { todo: 'the snapshot does not read sys.computed_columns.is_persisted' }, () => {
      const run = query("SELECT is_persisted FROM sys.computed_columns WHERE object_id = OBJECT_ID(N'dbo.AllTypes') AND name = N'cComputed'", target);
      assert.equal(run.output.trim(), '1');
    });

    await t.test('sync keeps the names of named default constraints', { todo: 'the snapshot does not keep default constraint names, so the target gets DF__<table>__<column>__<hex>' }, () => {
      const run = query('SELECT name FROM sys.default_constraints WHERE is_system_named = 0 ORDER BY name', target);
      assert.deepEqual(run.output.trim().split(/\r?\n/), ['DF_AllTypes_cBit', 'DF_AllTypes_cGuid', 'DF_Orders_Amount', 'DF_Orders_CreatedAt']);
    });

    await t.test('rollback script runs on the target without errors', () => {
      const run = runScriptFile(before.files.rollback);
      assert.ok(run.ok, run.output);
    });

    await t.test('after rollback the target matches its snapshot, except what rollback keeps', () => {
      // Drift: the target as it was before the sync (snapshot) against the live target.
      const after = compare({ dir: c.name, name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target, options: c.options });
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
