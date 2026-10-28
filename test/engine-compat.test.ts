// Snapshots saved by older engine versions (data/ keeps them for drift checks) must still compare
// cleanly after the engine starts reading more properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, compare, counts } from './support/engine.js';
import { DB_PREFIX, mustRunScriptFile, recreateDatabase, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const database = `${DB_PREFIX}compat`;
const same = { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 };

interface SnapshotItem {
  Props?: Record<string, string>;
  Sql?: Record<string, unknown>;
}

test('engine: a snapshot without Persisted and default names (before 2026-10-28) still matches', { skip }, async (t) => {
  recreateDatabase(database);
  for (const file of ['common.sql', 'source.sql']) mustRunScriptFile(path.join(ROOT, 'test', 'fixtures', 'core', file), database);

  // The database against itself saves its live snapshot; take out what older engines did not write.
  const live = compare({ dir: 'compat', name: 'live', source: database, target: database });
  assert.deepEqual(counts(live), same, live.log);
  const snapshot = JSON.parse(readFileSync(live.files.sourceSnapshot, 'utf8')) as { categories: { Column: Record<string, SnapshotItem> } };
  const removed: string[] = [];
  for (const [key, item] of Object.entries(snapshot.categories.Column)) {
    if (item.Props && 'Persisted' in item.Props) { delete item.Props['Persisted']; removed.push(`${key} Persisted`); }
    if (item.Sql && 'DefaultName' in item.Sql) { delete item.Sql['DefaultName']; removed.push(`${key} DefaultName`); }
  }
  // Two persisted computed columns and four named defaults in the core source.
  assert.ok(removed.includes('dbo.AllTypes.cComputed Persisted') && removed.includes('dbo.Orders.Amount DefaultName'), removed.join('\n'));
  const oldSnapshot = path.join(path.dirname(live.files.sourceSnapshot), 'old-format.snapshot.json');
  writeFileSync(oldSnapshot, JSON.stringify(snapshot), 'utf8');

  await t.test('old snapshot as the source (drift)', () => {
    const c = compare({ dir: 'compat', name: 'old-to-live', sourceSnapshot: oldSnapshot, target: database });
    assert.deepEqual(counts(c), same, c.log);
  });

  await t.test('old snapshot as the target', () => {
    const c = compare({ dir: 'compat', name: 'live-to-old', source: database, targetSnapshot: oldSnapshot });
    assert.deepEqual(counts(c), same, c.log);
  });
});
