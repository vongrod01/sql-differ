// Scratch databases for engine tests. Every database a test creates is named ddtest_*, and only
// those are ever dropped. The server is LocalDB unless DATABASE_DIFF_TEST_SERVER says otherwise;
// it must accept Windows authentication.
import { spawnSync } from 'node:child_process';

export const TEST_SERVER = process.env.DATABASE_DIFF_TEST_SERVER || '(localdb)\\MSSQLLocalDB';
export const DB_PREFIX = 'ddtest_';

const isLocalDb = TEST_SERVER.toLowerCase().startsWith('(localdb)\\');

export interface SqlRun {
  ok: boolean;
  output: string;
}

function sqlcmd(args: string[], { stopOnError = true } = {}): SqlRun {
  // -b: stop at the first failing batch with exit code 1; -I: QUOTED_IDENTIFIER ON like SSMS;
  // -f: scripts and output are UTF-8 (fixtures and generated scripts carry Thai text). A bare
  // "-f 65001" sets the input code page only; output would stay in the console code page (874).
  const run = spawnSync('sqlcmd', ['-S', TEST_SERVER, '-E', ...(stopOnError ? ['-b'] : []), '-I', '-f', 'i:65001,o:65001', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`;
  return { ok: run.status === 0, output };
}

let available: string | true | undefined;

// true when the test server answers, else the reason to skip.
export function serverAvailable(): string | true {
  if (available !== undefined) return available;
  if (isLocalDb) {
    const instance = TEST_SERVER.slice('(localdb)\\'.length);
    spawnSync('sqllocaldb', ['start', instance], { windowsHide: true, timeout: 60_000 });
  }
  const run = sqlcmd(['-Q', 'SET NOCOUNT ON; SELECT 1']);
  available = run.ok ? true : `test SQL Server ${TEST_SERVER} is not reachable: ${run.output.trim()}`;
  return available;
}

// The `skip` option for tests that need the server. With DATABASE_DIFF_REQUIRE_DB=1 (CI) a missing
// server fails the run instead, so a green run always means the database tests ran.
export function skipWithoutServer(): false | string {
  const state = serverAvailable();
  if (state === true) return false;
  if (process.env.DATABASE_DIFF_REQUIRE_DB === '1') throw new Error(state);
  return state;
}

function assertScratchName(name: string): void {
  if (!name.startsWith(DB_PREFIX) || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to touch database ${name}: test databases must be named ${DB_PREFIX}*`);
  }
}

// sqlcmd's output conversion is unreliable through a pipe: the same call returns Thai text in
// code page 874 on some runs. Select non-ASCII values with unicodeHex() and decode them here.
export function query(sql: string, database = 'master'): SqlRun {
  return sqlcmd(['-d', database, '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${sql}`]);
}

// Runs batches that must not appear on a command line (they hold a password): the text goes to
// sqlcmd over stdin. Batches are separated by GO lines. `secret` is taken out of the output that
// comes back, so a message built from it cannot show the password either.
export function runSqlFromStdin(sql: string, secret: string, database = 'master'): SqlRun {
  const run = spawnSync('sqlcmd', ['-S', TEST_SERVER, '-E', '-b', '-I', '-d', database, '-f', 'i:65001,o:65001'], {
    input: `${sql}\nGO\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`;
  return { ok: run.status === 0, output: secret ? output.split(secret).join('<secret>') : output };
}

// SQL expression: an nvarchar value as the hex of its UTF-16LE bytes.
export function unicodeHex(expression: string): string {
  return `CONVERT(varchar(max), CAST(${expression} AS varbinary(max)), 2)`;
}

export function fromUnicodeHex(hex: string): string {
  return Buffer.from(hex.trim(), 'hex').toString('utf16le');
}

// A plain DROP first, retried for a while: SET SINGLE_USER WITH ROLLBACK IMMEDIATE kills every
// session that uses the database at that moment, and test files run in parallel. Seen once
// (2026-11-11, LocalDB starting cold): the engine run of another test file was listing databases
// (HAS_DBACCESS and HAS_PERMS_BY_NAME open every one of them, seconds when LocalDB has to start
// them up) and failed with "the session is in the kill state" at the moment a database it had
// just opened was dropped this way. The kill stays as the last resort for a database in use.
function dropStatements(name: string): string[] {
  return [
    'DECLARE @try int = 0;',
    `WHILE DB_ID(N'${name}') IS NOT NULL AND @try < 20 BEGIN`,
    `  BEGIN TRY DROP DATABASE [${name}]; END TRY`,
    "  BEGIN CATCH SET @try += 1; WAITFOR DELAY '00:00:00.500'; END CATCH",
    'END;',
    `IF DB_ID(N'${name}') IS NOT NULL BEGIN`,
    `  ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
    `  DROP DATABASE [${name}];`,
    'END;',
  ];
}

// Drops and recreates a scratch database with a fixed collation and compatibility level, so the
// results do not depend on the server defaults (LocalDB is SQL_Latin1_General, Pylon is Thai_CI_AS).
export function recreateDatabase(name: string): void {
  assertScratchName(name);
  const run = sqlcmd(['-d', 'master', '-Q', [
    ...dropStatements(name),
    `CREATE DATABASE [${name}] COLLATE Thai_CI_AS;`,
    `ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL = 140;`,
    // LocalDB creates databases with AUTO_CLOSE ON: one is shut down when its last connection
    // closes and started again at the next look, and while it starts it reads as RECOVERING. A
    // test file that lists databases at that moment (the test files run in parallel) then finds
    // another file's database "not accessible" (seen 2026-11-11: -ListDatabases and a batch).
    `ALTER DATABASE [${name}] SET AUTO_CLOSE OFF;`,
  ].join('\n')]);
  if (!run.ok) throw new Error(`could not create ${name}:\n${run.output}`);
}

// For tests that need a database name nothing answers to.
export function dropDatabase(name: string): void {
  assertScratchName(name);
  const run = sqlcmd(['-d', 'master', '-Q', dropStatements(name).join('\n')]);
  if (!run.ok) throw new Error(`could not drop ${name}:\n${run.output}`);
}

// What a script that ran in the wrong database leaves there: objects, schemas, types, and
// database triggers (which are not in sys.objects).
export const USER_OBJECT_COUNT = [
  'SELECT (SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped = 0)',
  '+ (SELECT COUNT(*) FROM sys.schemas WHERE schema_id > 4 AND schema_id < 16384)',
  '+ (SELECT COUNT(*) FROM sys.types WHERE is_user_defined = 1)',
  '+ (SELECT COUNT(*) FROM sys.triggers WHERE parent_class = 0)',
].join(' ');

export interface ScriptOptions {
  // Run the batches after a failing one too, as SSMS does when a script is run with F5. `ok` is
  // then true even when batches failed (sqlcmd exits 0): look for "Msg " in the output instead.
  continueOnError?: boolean;
}

export function runScriptFile(file: string, database?: string, { continueOnError = false }: ScriptOptions = {}): SqlRun {
  if (database !== undefined) assertScratchName(database);
  return sqlcmd([...(database ? ['-d', database] : []), '-i', file], { stopOnError: !continueOnError });
}

export function mustRunScriptFile(file: string, database?: string): void {
  const run = runScriptFile(file, database);
  if (!run.ok) throw new Error(`${file} failed on ${database ?? 'its own USE'}:\n${run.output}`);
}
