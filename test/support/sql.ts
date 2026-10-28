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

function sqlcmd(args: string[]): SqlRun {
  // -b: stop at the first failing batch with exit code 1; -I: QUOTED_IDENTIFIER ON like SSMS;
  // -f: scripts and output are UTF-8 (fixtures and generated scripts carry Thai text). A bare
  // "-f 65001" sets the input code page only; output would stay in the console code page (874).
  const run = spawnSync('sqlcmd', ['-S', TEST_SERVER, '-E', '-b', '-I', '-f', 'i:65001,o:65001', ...args], {
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

// SQL expression: an nvarchar value as the hex of its UTF-16LE bytes.
export function unicodeHex(expression: string): string {
  return `CONVERT(varchar(max), CAST(${expression} AS varbinary(max)), 2)`;
}

export function fromUnicodeHex(hex: string): string {
  return Buffer.from(hex.trim(), 'hex').toString('utf16le');
}

// Drops and recreates a scratch database with a fixed collation and compatibility level, so the
// results do not depend on the server defaults (LocalDB is SQL_Latin1_General, Pylon is Thai_CI_AS).
export function recreateDatabase(name: string): void {
  assertScratchName(name);
  const run = sqlcmd(['-d', 'master', '-Q', [
    `IF DB_ID(N'${name}') IS NOT NULL BEGIN`,
    `  ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
    `  DROP DATABASE [${name}];`,
    'END;',
    `CREATE DATABASE [${name}] COLLATE Thai_CI_AS;`,
    `ALTER DATABASE [${name}] SET COMPATIBILITY_LEVEL = 140;`,
  ].join('\n')]);
  if (!run.ok) throw new Error(`could not create ${name}:\n${run.output}`);
}

export function runScriptFile(file: string, database?: string): SqlRun {
  if (database !== undefined) assertScratchName(database);
  return sqlcmd([...(database ? ['-d', database] : []), '-i', file]);
}

export function mustRunScriptFile(file: string, database?: string): void {
  const run = runScriptFile(file, database);
  if (!run.ok) throw new Error(`${file} failed on ${database ?? 'its own USE'}:\n${run.output}`);
}
