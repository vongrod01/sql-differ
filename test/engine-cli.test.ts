// Command-line behaviour of Compare-Database.ps1 outside the golden comparisons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, compare, runEngine } from './support/engine.js';
import { DB_PREFIX, TEST_SERVER, query, recreateDatabase, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const database = `${DB_PREFIX}cli`;

test('engine: an unknown category is an error (exit 2)', () => {
  const run = runEngine(['-SourceDatabase', 'any', '-Categories', 'table,nope']);
  assert.equal(run.exitCode, 2, run.log);
  assert.match(run.log, /Unknown category 'nope'/);
});

test('engine: -ListDatabases prints the server facts and databases as JSON', { skip }, () => {
  recreateDatabase(database);
  const run = runEngine(['-ListDatabases', '-SourceServer', TEST_SERVER]);
  assert.equal(run.exitCode, 0, run.log);
  const info = JSON.parse(run.stdout) as {
    server: string; serverName: string; instance: string; requestedInstance: string; instanceMismatch: boolean;
    databases: { name: string; hasAccess: boolean; canViewDefinition: boolean }[];
  };
  assert.equal(info.server, TEST_SERVER);
  assert.ok(info.serverName, 'serverName is the instance that answered');
  assert.ok(info.instance);
  // No port in the address, so the instance name cannot be bypassed.
  assert.equal(info.requestedInstance, '');
  assert.equal(info.instanceMismatch, false);
  assert.deepEqual(info.databases.find((d) => d.name === database), { name: database, hasAccess: true, canViewDefinition: true, state: 'ONLINE' });
});

// The label of a side is the address that was asked for. The result and the snapshots also say
// which server answered (the engine reads it to check a named instance, see Assert-RequestedInstance).
test('engine: the result and the snapshots record the server that answered', { skip }, () => {
  recreateDatabase(database);
  const answered = query("SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(128))").output.trim();
  assert.ok(answered, 'the test server has a name');
  const live = compare({ dir: 'cli-identity', name: 'live', source: database, target: database });
  assert.equal(live.exitCode, 0, live.log);
  const side = (name: string) => live.result[name] as { label: string; serverName: string };
  assert.equal(side('source').serverName, answered);
  assert.equal(side('target').serverName, answered);
  assert.equal(side('source').label, `${TEST_SERVER} / ${database}`);
  const snapshot = JSON.parse(readFileSync(live.files.sourceSnapshot, 'utf8')) as { server: string; serverName: string };
  assert.equal(snapshot.serverName, answered);
  assert.equal(snapshot.server, TEST_SERVER);

  // A side read from a snapshot keeps the name saved in it.
  const drift = compare({ dir: 'cli-identity', name: 'drift', sourceSnapshot: live.files.sourceSnapshot, target: database });
  assert.equal(drift.exitCode, 0, drift.log);
  assert.equal((drift.result['source'] as { serverName: string }).serverName, answered);
});

test('engine: batch mode compares each named database and writes index.json', { skip }, () => {
  recreateDatabase(database);
  const dir = path.join(OUT, 'cli-batch');
  // Same server on both sides: the database is compared with itself, so nothing differs.
  const run = runEngine(['-SourceServer', TEST_SERVER, '-TargetServer', TEST_SERVER, '-Databases', `${database},${DB_PREFIX}missing`, '-OutputPath', dir]);
  assert.equal(run.exitCode, 2, `a missing database makes the batch exit 2:\n${run.log}`);
  const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')) as { databases: Record<string, unknown>[] };
  const [found, missing] = index.databases;
  assert.equal(found?.['database'], database);
  assert.equal(found?.['error'], '');
  assert.equal(found?.['onlyInSource'], 0);
  assert.equal(found?.['different'], 0);
  assert.equal(found?.['syncScript'], `${database}.sync.sql`);
  assert.equal(missing?.['database'], `${DB_PREFIX}missing`);
  assert.equal(missing?.['error'], 'database not found on the source server');
});
