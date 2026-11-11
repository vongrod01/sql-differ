// A target read by a real SQL login that has no VIEW DEFINITION permission: the case that
// engine-incomplete.test.ts builds by hand (it takes objects out of a snapshot), here as SQL
// Server really answers such a login. The login is created on the test server for this run, with
// SELECT on every table of the target except dbo.Hidden, and dropped again at the end. Its
// password is made here at random: it goes to sqlcmd over stdin and to the profile through
// servers.save (DPAPI), and never into a command line, an output or a message.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { OUT, ROOT, buildFixture, compare } from './support/engine.js';
import { CHILDREN_UNTOUCHED, UNTOUCHED, hiddenChildren, hiddenObjects, messageNumbers } from './support/incomplete.js';
import { DB_PREFIX, TEST_SERVER, mustRunScriptFile, query, runScriptFile, runSqlFromStdin, skipWithoutServer } from './support/sql.js';

// A data folder of its own, set before the app's modules are loaded: the profile of the login is
// written there, never into the real data folder.
const DATA = path.join(OUT, 'restricted-data');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DATABASE_DIFF_DATA = DATA;
process.env.DATABASE_DIFF_MCP_PROFILES = path.join(DATA, 'no-mcp-profiles');

const require = createRequire(import.meta.url);
const config = require('../app/lib/config.js') as { DATA: string; SERVERS: string };
const servers = require('../app/lib/servers.js') as {
  save(def: Record<string, unknown>): Promise<{ id: string; auth: string; hasPassword: boolean }>;
  remove(id: string): void;
};

const skip = skipWithoutServer();
const source = `${DB_PREFIX}restricted_src`;
const target = `${DB_PREFIX}restricted_tgt`;
const LOGIN = `${DB_PREFIX}restricted_login`;

interface SnapshotItem {
  Name: string;
  Parent: string;
  Props: Record<string, string>;
}

interface Snapshot {
  login: string;
  canViewDefinition: boolean;
  categories: Record<string, Record<string, SnapshotItem>>;
}

interface Diff {
  Category: string;
  Object: string;
  Status: string;
  Detail: string;
  SourceKey: string | null;
}

function readSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
}

const DROP_LOGIN = `IF SUSER_ID(N'${LOGIN}') IS NOT NULL DROP LOGIN [${LOGIN}];`;
let profileId = '';

// The login first: it is an account on the server, with a password, and must not outlive the
// test whatever happens to the rest of the clean-up. Then the profile that holds its password.
after(() => {
  try {
    if (skip === false) {
      const dropped = query(DROP_LOGIN);
      assert.ok(dropped.ok, dropped.output);
      const left = query(`SELECT COUNT(*) FROM sys.server_principals WHERE name = N'${LOGIN}'`);
      assert.equal(left.output.trim(), '0', `the login ${LOGIN} is gone`);
    }
  } finally {
    if (profileId) servers.remove(profileId);
  }
});

test('engine: restricted (a real login without VIEW DEFINITION reads the target)', { skip }, async (t) => {
  assert.equal(config.DATA, DATA, 'the profile goes into the scratch data folder');
  buildFixture('core', source, target);
  for (const [file, database] of [['source.sql', source], ['target.sql', target]] as const) {
    mustRunScriptFile(path.join(ROOT, 'test', 'fixtures', 'incomplete', file), database);
  }
  assert.equal(hiddenObjects(target), UNTOUCHED, 'the fixture is not what this test expects');
  assert.deepEqual(hiddenChildren(target), CHILDREN_UNTOUCHED, 'the fixture is not what this test expects');

  // The login: nothing but SELECT on the tables, and not on dbo.Hidden.
  const password = `Pw${randomBytes(18).toString('hex')}x`;
  const created = runSqlFromStdin([
    DROP_LOGIN,
    'GO',
    `CREATE LOGIN [${LOGIN}] WITH PASSWORD = N'${password}', CHECK_POLICY = OFF, DEFAULT_DATABASE = [${target}];`,
    'GO',
    `USE [${target}];`,
    'GO',
    `CREATE USER [${LOGIN}] FOR LOGIN [${LOGIN}];`,
    "DECLARE @grant nvarchar(max) = N'';",
    `SELECT @grant += N'GRANT SELECT ON ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N' TO [${LOGIN}];'`,
    "FROM sys.tables WHERE NOT (SCHEMA_NAME(schema_id) = N'dbo' AND name = N'Hidden');",
    'EXEC (@grant);',
  ].join('\n'), password);
  assert.ok(created.ok, created.output);
  const profile = await servers.save({ name: 'ddtest restricted', server: TEST_SERVER, auth: 'sql', user: LOGIN, password });
  profileId = profile.id;
  assert.equal(profile.auth, 'sql');
  assert.ok(profile.hasPassword);
  const profileFile = path.join(config.SERVERS, `${profile.id.slice('app:'.length)}.json`);
  assert.ok(!readFileSync(profileFile, 'utf8').includes(password), 'the profile holds the password encrypted, not as it is');

  // The same two databases twice: the target read in full (Windows authentication, as every other
  // test reads it), then by the login.
  const full = compare({ dir: 'restricted', name: 'full', source, target });
  const before = compare({ dir: 'restricted', name: 'before', source, target, targetProfile: profileFile });
  assert.ok(!before.log.includes(password) && !full.log.includes(password), 'the password is not in the output of the engine');
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const diffs = before.result['diffs'] as Diff[];
  const seen = readSnapshot(before.files.targetSnapshot);
  const all = readSnapshot(full.files.targetSnapshot);
  const model = readSnapshot(before.files.sourceSnapshot);

  await t.test('the comparison says that it is incomplete, and which side', () => {
    const side = before.result['target'] as { login: string; canViewDefinition: boolean };
    assert.equal(side.login, LOGIN);
    assert.equal(side.canViewDefinition, false);
    assert.equal(seen.canViewDefinition, false);
    assert.equal((before.result['source'] as { canViewDefinition: boolean }).canViewDefinition, true);
    const warnings = before.result['warnings'] as string[];
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] ?? '', new RegExp(`^Login ${LOGIN} has no VIEW DEFINITION permission in target database ${target}:`));
    assert.equal(before.exitCode, 1);
  });

  // What the login does not see. Every such object that the source has as well must read as
  // "only in source": that is the trap the scripts are careful about.
  const hidden: [category: string, key: string][] = [];
  for (const [category, items] of Object.entries(all.categories)) {
    for (const key of Object.keys(items)) if (!seen.categories[category]?.[key]) hidden.push([category, key]);
  }

  await t.test('objects the login cannot see read as only in the source', () => {
    const hiddenNames = hidden.map(([category, key]) => `${category} ${key}`);
    // Seen by nobody without permission on them: a table without SELECT, the modules, the
    // synonyms, the types, the sequences and the database triggers.
    for (const name of [
      'Table dbo.Hidden', 'Stored procedure dbo.pGetOrder', 'View dbo.vOrders', 'Function dbo.fOrderTotal', 'Synonym dbo.synOrders',
      'User-defined type dbo.tCode', 'Sequence dbo.seqInvoice', 'Trigger (database trigger)|trDdlChanged',
    ]) assert.ok(hiddenNames.includes(name), `${name} is hidden from the login:\n${hiddenNames.join('\n')}`);
    // Seen: the tables it may select from, with their columns, indexes and triggers.
    for (const [category, key] of [['Table', 'dbo.Orders'], ['Column', 'dbo.Orders.Amount'], ['Index', 'dbo.Orders|PK'], ['Trigger', 'dbo.trOrders_Insert']] as const) {
      assert.ok(seen.categories[category]?.[key], `${category} ${key} is visible to the login`);
    }

    let checked = 0;
    for (const [category, key] of hidden) {
      const item = model.categories[category]?.[key];
      if (!item) continue;
      // What belongs to a table or view is compared only when the login sees that one too; else
      // the table or view itself is the difference.
      if (item.Parent && !seen.categories['Table']?.[item.Parent] && !seen.categories['View']?.[item.Parent]) continue;
      const diff = diffs.find((d) => d.Category === category && d.SourceKey === key);
      assert.equal(diff?.Status, 'OnlyInSource', `${category} ${key} is in the target, hidden from the login`);
      checked++;
    }
    assert.ok(checked >= 10, `only ${checked} hidden objects checked`);
  });

  // dbo.Codes.Code is a dbo.tCode, a type the login cannot see. The catalog shows the login the
  // column all the same (it may select from the table), only not the row of its type: the column
  // must read as one whose type cannot be compared, not as one the target does not have (it was
  // "only in source" once, and the sync script's ADD then failed with Msg 2705).
  await t.test('a column of a type the login cannot see is there, with a type that is not readable', () => {
    assert.equal(model.categories['Column']?.['dbo.Codes.Code']?.Props['Type'], 'dbo.tCode');
    assert.equal(all.categories['Column']?.['dbo.Codes.Code']?.Props['Type'], 'dbo.tCode');
    const column = seen.categories['Column']?.['dbo.Codes.Code'];
    assert.ok(column, 'dbo.Codes.Code is visible to the login');
    assert.equal(column.Props['Type'], '(not readable)');
    // Every other column of the tables the login reads is there with its type.
    const unreadable = Object.entries(seen.categories['Column'] ?? {}).filter(([, item]) => item.Props['Type'] === '(not readable)').map(([key]) => key);
    assert.deepEqual(unreadable, ['dbo.Codes.Code']);
    // NULL in the source, NOT NULL in the target: that is compared, the type is not.
    const diff = diffs.find((d) => d.Category === 'Column' && d.Object === 'dbo.Codes.Code');
    assert.equal(diff?.Status, 'Different');
    assert.equal(diff?.Detail, 'Nullable: source NULL, target NOT NULL\nType: not readable on target (not compared)');
    // ALTER COLUMN has to say the type again, and the type the column has is not known: neither
    // script writes it as a statement.
    for (const file of [before.files.sync, before.files.rollback]) {
      const script = readFileSync(file, 'utf8');
      assert.doesNotMatch(script, /^ALTER TABLE \[dbo\]\.\[Codes\]/m, path.basename(file));
      assert.doesNotMatch(script, /\(not readable\) (?:NOT )?NULL/, path.basename(file));
      assert.match(script, /^-- Not scripted: the type of this column is not readable on one side/m, path.basename(file));
    }
  });

  await t.test('the sync script fails only on what is there already, and leaves it as it is', () => {
    // As an administrator runs it in SSMS: every batch. Every error is "that is there already":
    // - Msg 2714, there is already an object of that name: the table dbo.Hidden, a sequence, a
    //   function, three views, two procedures, a synonym and two database triggers;
    // - Msg 219, the type already exists: dbo.tCode.
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    const numbers = messageNumbers(run.output);
    assert.deepEqual(numbers.filter((n) => n !== '2714'), ['219'], run.output);
    assert.equal(numbers.filter((n) => n === '2714').length, 11, run.output);
    for (const name of ['Hidden', 'dbo.seqInvoice', 'dbo.synOrders', 'pGetOrder', 'vOrders', 'trDdlChanged']) {
      assert.ok(run.output.includes(`There is already an object named '${name}' in the database.`), `${name}:\n${run.output}`);
    }
    // dbo.trOrders_Insert is on a table the login reads, so it is seen, and its state is synced
    // (disabled, as in the source). The procedure and the synonym are hidden: untouched.
    assert.equal(hiddenObjects(target), UNTOUCHED.replace('trOrders_Insert: enabled', 'trOrders_Insert: disabled'));
    assert.deepEqual(hiddenChildren(target), CHILDREN_UNTOUCHED);
  });

  await t.test('the rollback script runs without errors and drops nothing that was there', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.equal(hiddenObjects(target), UNTOUCHED);
    assert.deepEqual(hiddenChildren(target), CHILDREN_UNTOUCHED);
    // Read in full again: every object the login could not see is still in the target.
    const after = compare({ dir: 'restricted', name: 'after-rollback', source, target });
    const left = readSnapshot(after.files.targetSnapshot);
    const gone = hidden.filter(([category, key]) => !left.categories[category]?.[key]).map(([category, key]) => `${category} ${key}`);
    assert.deepEqual(gone, []);
  });
});
