// The web app's modules (app/, CommonJS), loaded into the test process. DATABASE_DIFF_DATA and
// DATABASE_DIFF_MCP_PROFILES are set before the first require: these tests must never see the real
// data folder (run history, server profiles) nor the mssql-mcp profiles of this machine (real
// servers), only scratch folders under test/.out. The processes the tests start (app/cli.js,
// app/server.js) get both from this environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { OUT, ROOT, childEnv, compare } from './support/engine.js';
import { DB_PREFIX, TEST_SERVER, USER_OBJECT_COUNT, dropDatabase, query, recreateDatabase, runScriptFile, skipWithoutServer } from './support/sql.js';

const DATA = path.join(OUT, 'app-data');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DATABASE_DIFF_DATA = DATA;
const NO_PROFILES = path.join(DATA, 'no-mcp-profiles');
process.env.DATABASE_DIFF_MCP_PROFILES = NO_PROFILES;

interface HttpError extends Error {
  status?: number;
}

interface Spec {
  kind: string;
  categories: string[];
  options: Record<string, boolean>;
  trigger: string;
  source: { serverId: string; serverLabel: string; database: string | null };
  databases?: string[];
  allDatabases?: boolean;
}

interface RunRecord {
  id: string;
  status: string;
  exitCode: number;
  errors: number;
  counts: Record<string, number>;
  spec: { jobId: string | null; trigger: string };
  databases: { database: string; error: string }[];
}

// The run records of a job, read from the scratch run folders.
function runsOfJob<T extends { spec: { jobId: string | null } }>(jobId: string): T[] {
  if (!existsSync(config.RUNS)) return [];
  return readdirSync(config.RUNS)
    .filter((id) => existsSync(path.join(config.RUNS, id, 'run.json')))
    .map((id) => JSON.parse(readFileSync(path.join(config.RUNS, id, 'run.json'), 'utf8')) as T)
    .filter((r) => r.spec.jobId === jobId);
}

// A saved server profile of the web app (Windows authentication, never connected to here).
function writeProfile(slug: string, server: string): void {
  mkdirSync(config.SERVERS, { recursive: true });
  writeFileSync(path.join(config.SERVERS, `${slug}.json`), JSON.stringify({
    name: slug, server, port: null, user: '', password: '', encrypt: false, trustServerCertificate: false,
  }), 'utf8');
}

// A job as jobs.json holds it. Disabled: a job saved through the app would be registered with
// Task Scheduler.
function job(id: string, name: string, spec: Record<string, unknown>): Record<string, unknown> {
  return { id, name, enabled: false, schedule: { type: 'daily', time: '02:00', days: [] }, spec };
}

const skip = skipWithoutServer();
const require = createRequire(import.meta.url);
const config = require('../app/lib/config.js') as { DATA: string; RUNS: string; SERVERS: string; JOBS_FILE: string; MCP_PROFILES: string };
const store = require('../app/lib/store.js') as { safeJoin(dir: string, name: string): string };
const runs = require('../app/lib/runs.js') as {
  normalizeSpec(spec: unknown): Spec;
  combinedScript(id: string, kind: string): { name: string; text: string };
  CATEGORIES: string[];
  DEFAULT_CATEGORIES: string[];
};
const jobs = require('../app/lib/jobs.js') as {
  list(): Promise<{ id: string; lastRun: { id: string; status: string; errors: number } | null }[]>;
  usingServer(id: string): { id: string; name: string }[];
};
const { runPowerShell } = require('../app/lib/powershell.js') as {
  runPowerShell(args: string[], options?: { input?: string; env?: Record<string, string> }): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return (err as HttpError).status;
  }
  return undefined;
}

test('app: the modules under test use the scratch data folder', () => {
  assert.equal(config.DATA, DATA);
  assert.ok(config.RUNS.startsWith(DATA + path.sep));
  assert.ok(config.SERVERS.startsWith(DATA + path.sep));
  assert.equal(config.MCP_PROFILES, NO_PROFILES);
});

// app/cli.js and app/server.js are started as processes of their own: an override made in this
// process would not reach them, and they would read the real profiles of this machine.
test('app: a child process uses the scratch folders too', () => {
  const child = spawnSync(process.execPath, ['-e', "const c = require('./app/lib/config'); console.log(JSON.stringify([c.DATA, c.MCP_PROFILES]))"], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [DATA, NO_PROFILES]);
});

test('app: store.safeJoin keeps a path inside its folder', () => {
  const dir = path.join(DATA, 'runs', 'x');
  assert.equal(store.safeJoin(dir, 'report.html'), path.join(dir, 'report.html'));
  assert.equal(store.safeJoin(dir, 'sub/a.sql'), path.join(dir, 'sub', 'a.sql'));
  for (const name of ['..', '../other/run.json', '..\\other\\run.json', 'a/../../b', 'C:\\Windows\\win.ini', '/etc/passwd', '']) {
    assert.equal(status(() => store.safeJoin(dir, name)), 400, `"${name}" must be refused`);
  }
  // A sibling folder that starts with the same name is outside.
  assert.equal(status(() => store.safeJoin(dir, '../x2/run.json')), 400);
});

test('app: runs.normalizeSpec validates a run spec', async (t) => {
  const side = (database?: string) => ({ serverId: 'local', database });
  const compare = { kind: 'compare', source: side('a'), target: side('b') };

  await t.test('fills in defaults', () => {
    const spec = runs.normalizeSpec(compare);
    assert.deepEqual(spec.categories, runs.DEFAULT_CATEGORIES);
    assert.deepEqual(spec.options, { ignoreWhitespace: false, ignoreCase: false, ignoreCollation: false, compareColumnOrder: false });
    assert.equal(spec.trigger, 'manual');
    assert.deepEqual(spec.source, { serverId: 'local', serverLabel: 'localhost', database: 'a' });
    // An empty list is a spec saved before categories existed.
    assert.deepEqual(runs.normalizeSpec({ ...compare, categories: [] }).categories, runs.DEFAULT_CATEGORIES);
  });

  await t.test('keeps the engine order of the categories', () => {
    assert.deepEqual(runs.normalizeSpec({ ...compare, categories: ['Synonym', 'Table', 'Database'] }).categories, ['Database', 'Table', 'Synonym']);
  });

  await t.test('refuses what the engine would not understand', () => {
    assert.throws(() => runs.normalizeSpec(null), /Missing run spec/);
    assert.throws(() => runs.normalizeSpec({ ...compare, kind: 'drop' }), /Unknown run kind/);
    assert.throws(() => runs.normalizeSpec({ ...compare, categories: ['Table', 'Nope'] }), /Unknown category: Nope/);
    assert.throws(() => runs.normalizeSpec({ ...compare, target: undefined }), /Missing target/);
    assert.throws(() => runs.normalizeSpec({ ...compare, source: { serverId: 'app:missing', database: 'a' } }), /Unknown server: app:missing/);
    for (const name of ['', '   ', 'a,b', 'a\nb', 'x'.repeat(129)]) {
      assert.throws(() => runs.normalizeSpec({ ...compare, source: side(name) }), /Invalid database name/, JSON.stringify(name));
    }
    assert.equal(status(() => runs.normalizeSpec({ ...compare, kind: 'drop' })), 400);
  });

  await t.test('batch needs databases or allDatabases', () => {
    const batch = { kind: 'batch', source: side(), target: side() };
    assert.throws(() => runs.normalizeSpec(batch), /Pick at least one database/);
    assert.throws(() => runs.normalizeSpec({ ...batch, databases: [] }), /Pick at least one database/);
    assert.throws(() => runs.normalizeSpec({ ...batch, databases: ['ok', 'not,ok'] }), /Invalid database name/);
    assert.deepEqual(runs.normalizeSpec({ ...batch, databases: ['a', ' b '] }).databases, ['a', 'b']);
    const all = runs.normalizeSpec({ ...batch, allDatabases: true, databases: ['ignored'] });
    assert.equal(all.allDatabases, true);
    assert.deepEqual(all.databases, []);
    assert.equal(all.source.database, null);
  });

  await t.test('drift needs a snapshot as the source, and only drift takes one', () => {
    assert.throws(() => runs.normalizeSpec({ ...compare, kind: 'drift' }), /Drift needs a snapshot as the source/);
    const snapshot = { snapshot: { runId: '20260101-000000-abcd', file: 'report.source.snapshot.json' } };
    assert.throws(() => runs.normalizeSpec({ ...compare, source: snapshot }), /source cannot be a snapshot here/);
    // The run id and file name are checked before the file is looked for.
    assert.throws(() => runs.normalizeSpec({ ...compare, kind: 'drift', source: { snapshot: { runId: '..', file: 'x.snapshot.json' } } }), /Invalid run id/);
    assert.throws(() => runs.normalizeSpec({ ...compare, kind: 'drift', source: { snapshot: { runId: '20260101-000000-abcd', file: '../run.json' } } }), /Invalid snapshot reference/);
    assert.throws(() => runs.normalizeSpec({ ...compare, kind: 'drift', source: snapshot }), /Snapshot file not found/);
  });
});

// PowerShell 7 puts its own module folders in PSModulePath. Windows PowerShell 5.1 started with
// that value loads PowerShell 7's Microsoft.PowerShell.Security and ConvertTo-SecureString fails,
// so the stored password of a SQL-login profile cannot be read (the app started from a pwsh shell).
test('app: PowerShell children do not inherit PSModulePath', async () => {
  const marker = path.join(DATA, 'pwsh7-modules-marker');
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'psmodulepath') ?? 'PSModulePath';
  const before = process.env[key];
  process.env[key] = before ? `${marker};${before}` : marker;
  try {
    const inherited = await runPowerShell(['-Command', '$env:PSModulePath']);
    assert.equal(inherited.code, 0, inherited.stderr);
    assert.ok(inherited.stdout.trim(), 'Windows PowerShell builds its own module path');
    assert.ok(!inherited.stdout.includes(marker), `the parent's PSModulePath reached powershell.exe:\n${inherited.stdout}`);

    // Under any spelling, also when the caller passes one.
    const passed = await runPowerShell(['-Command', '$env:PSModulePath'], { env: { PSMODULEPATH: marker } });
    assert.ok(!passed.stdout.includes(marker), passed.stdout);

    // What it broke: decrypting a stored password.
    const secure = await runPowerShell(['-Command', "$s = ConvertTo-SecureString 'x' -AsPlainText -Force | ConvertFrom-SecureString; (ConvertTo-SecureString $s).Length"]);
    assert.equal(secure.stdout.trim(), '1', secure.stderr);

    // The engine tests start powershell.exe with the same rule.
    assert.deepEqual(Object.keys(childEnv()).filter((k) => k.toLowerCase() === 'psmodulepath'), []);
    assert.equal(childEnv()['DATABASE_DIFF_UTF8'], '1');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

// A batch in which one database cannot be compared still produces a report for the others, so the
// run is "done". It must not read as a clean result anywhere: the record counts the failures, the
// schedules page gets them, and Task Scheduler sees a failed task.
test('app: a scheduled batch with a failed database is done with errors, and its task exits 1', { skip }, async (t) => {
  const database = `${DB_PREFIX}app`;
  const missing = `${DB_PREFIX}app_missing`;
  recreateDatabase(database);
  // A Windows-authentication profile of the test server, and a disabled job: saving a job through
  // the app would register it with Task Scheduler.
  mkdirSync(config.SERVERS, { recursive: true });
  writeFileSync(path.join(config.SERVERS, 'testserver.json'), JSON.stringify({
    name: 'testserver', server: TEST_SERVER, port: null, user: '', password: '', encrypt: false, trustServerCertificate: false,
  }), 'utf8');
  const jobId = 'ab12cd34';
  writeFileSync(config.JOBS_FILE, JSON.stringify([{
    id: jobId,
    name: 'app test batch',
    enabled: false,
    schedule: { type: 'daily', time: '02:00', days: [] },
    spec: { kind: 'batch', source: { serverId: 'app:testserver' }, target: { serverId: 'app:testserver' }, databases: [database, missing], categories: ['Table'], options: {} },
  }]), 'utf8');

  const cli = spawnSync(process.execPath, [path.join(ROOT, 'app', 'cli.js'), 'run-job', jobId], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  const log = `${cli.stdout ?? ''}${cli.stderr ?? ''}`;
  const records = readdirSync(config.RUNS)
    .map((id) => JSON.parse(readFileSync(path.join(config.RUNS, id, 'run.json'), 'utf8')) as RunRecord)
    .filter((r) => r.spec.jobId === jobId);
  assert.equal(records.length, 1, `one run record of the job expected:\n${log}`);
  const record = records[0] as RunRecord;

  await t.test('the run record is done, with the engine exit code and the number of failed databases', () => {
    assert.equal(record.status, 'done', log);
    assert.equal(record.exitCode, 2);
    assert.equal(record.errors, 1);
    assert.deepEqual(record.databases.map((d) => [d.database, d.error]), [[database, ''], [missing, 'database not found on the source server']]);
    assert.deepEqual(record.counts, { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 });
    assert.deepEqual(record.spec.jobId, jobId);
    assert.equal(record.spec.trigger, 'schedule');
  });

  await t.test('cli.js exits 1, so Task Scheduler shows the task as failed', () => {
    assert.equal(cli.status, 1, log);
  });

  await t.test('the job list carries the failures of the last run', async () => {
    const [job] = await jobs.list();
    assert.equal(job?.lastRun?.id, record.id);
    assert.equal(job?.lastRun?.status, 'done');
    assert.equal(job?.lastRun?.errors, 1);
  });
});

// The combined script of a batch run promises that nothing runs after a database that cannot be
// used. Each database's own script ends by turning NOEXEC off again, which inside the combined
// file would let the next part run: the parts lose those lines and the file ends with its own.
test('app: the combined script stops at the first database that cannot be used', { skip }, async (t) => {
  const here = `${DB_PREFIX}combined`;
  const gone = `${DB_PREFIX}combined_gone`;
  recreateDatabase(here);
  dropDatabase(gone);

  // Part 1: a real script from the engine (nothing to apply, but with the frame every script has),
  // renamed to a database that does not exist. Part 2: a script for a database that does.
  const engine = compare({ dir: 'app-combined', name: 'part', source: here, target: here, categories: 'Table' });
  const first = readFileSync(engine.files.sync, 'utf8').split(here).join(gone);
  const second = '﻿CREATE TABLE dbo.CombinedMarker (Id int NOT NULL);\r\nGO\r\n';
  const id = '20260101-000000-abcd';
  const dir = path.join(config.RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'gone.sync.sql'), first, 'utf8');
  writeFileSync(path.join(dir, 'here.sync.sql'), second, 'utf8');
  const counts = { onlyInSource: 1, onlyInTarget: 0, different: 0, unverified: 0 };
  const side = { serverId: 'app:testserver', serverLabel: 'testserver' };
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'done',
    spec: { kind: 'batch', source: side, target: side, databases: [gone, here] },
    databases: [
      { database: gone, syncScript: 'gone.sync.sql', rollbackScript: '', error: '', counts },
      { database: here, syncScript: 'here.sync.sql', rollbackScript: '', error: '', counts },
    ],
  }), 'utf8');

  const combined = runs.combinedScript(id, 'sync');

  await t.test('NOEXEC is turned off once, by the last batch of the file', () => {
    assert.ok(first.replace(/\r\n/g, '\n').endsWith('\nSET NOEXEC OFF;\nGO\n'), 'the engine ends its script with SET NOEXEC OFF');
    assert.equal(combined.text.split('SET NOEXEC OFF;').length - 1, 1, combined.text);
    assert.ok(combined.text.endsWith('\r\nGO\r\n\r\nSET NOEXEC OFF;\r\nGO\r\n'), combined.text.slice(-200));
    // Both parts are there, each after its own USE and check.
    for (const name of [gone, here]) assert.ok(combined.text.includes(`USE [${name}];\r\nGO\r\nIF DB_ID(N'${name}') IS NULL`), name);
    assert.ok(combined.text.includes('CREATE TABLE dbo.CombinedMarker (Id int NOT NULL);\r\nGO'));
  });

  await t.test('run with every batch, as SSMS does, the part after the failed check changes nothing', () => {
    const file = path.join(OUT, 'app-combined', 'combined.sync.sql');
    writeFileSync(file, combined.text, 'utf8');
    const run = runScriptFile(file, undefined, { continueOnError: true });
    assert.match(run.output, new RegExp(`cannot use database ${gone}`), run.output);
    assert.equal(query(USER_OBJECT_COUNT, here).output.trim(), '0', `the part of ${here} ran:\n${run.output}`);
  });
});

// A script with a long run of blank lines (a procedure text can hold anything) must not make the
// request hang: the pattern that takes the end of a script off tried every one of those lines as
// a possible start (3.3 s for 40,000 lines, in the request handler).
test('app: the combined script is built quickly from a script with many blank lines', () => {
  const id = '20260101-000001-abcd';
  const dir = path.join(config.RUNS, id);
  mkdirSync(dir, { recursive: true });
  const trailer = '\r\n-- End of script: ends the NOEXEC that a failed database check at the top turned on.\r\nSET NOEXEC OFF;\r\nGO\r\n';
  const blank = '\r\n'.repeat(100_000);
  writeFileSync(path.join(dir, 'a.sync.sql'), `CREATE TABLE dbo.BeforeBlank (Id int);\r\nGO${blank}CREATE TABLE dbo.AfterBlank (Id int);\r\nGO\r\n${trailer}`, 'utf8');
  // A script from before the engine wrote the trailer, ending in blank lines.
  writeFileSync(path.join(dir, 'b.sync.sql'), `CREATE TABLE dbo.Old (Id int);\r\nGO${blank}`, 'utf8');
  const counts = { onlyInSource: 1, onlyInTarget: 0, different: 0, unverified: 0 };
  const side = { serverId: 'app:testserver', serverLabel: 'testserver' };
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    id,
    createdAt: '2026-01-01T00:00:01.000Z',
    status: 'done',
    spec: { kind: 'batch', source: side, target: side, databases: ['a', 'b'] },
    databases: [
      { database: 'a', syncScript: 'a.sync.sql', rollbackScript: '', error: '', counts },
      { database: 'b', syncScript: 'b.sync.sql', rollbackScript: '', error: '', counts },
    ],
  }), 'utf8');

  const start = Date.now();
  const combined = runs.combinedScript(id, 'sync');
  const seconds = (Date.now() - start) / 1000;
  assert.ok(seconds < 3, `took ${seconds.toFixed(1)} s`);
  // Each part without its trailer and without the blank lines it ended in; one trailer for the file.
  assert.equal(combined.text.split('SET NOEXEC OFF;').length - 1, 1);
  assert.ok(combined.text.includes('CREATE TABLE dbo.AfterBlank (Id int);\r\nGO\r\nGO\r\n\r\n-- ###'), combined.text.slice(-600));
  assert.ok(combined.text.endsWith('CREATE TABLE dbo.Old (Id int);\r\nGO\r\nGO\r\n\r\nSET NOEXEC OFF;\r\nGO\r\n'), combined.text.slice(-200));
});

// The history and schedules pages show the result of a run through countsHtml (app/public/app.js,
// a browser script). Its text is taken from that file and run here, with the one function it calls.
function browserFunctions(names: string[]): Record<string, (...args: unknown[]) => string> {
  const source = readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
  const texts = names.map((name) => {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `function ${name} not found in app/public/app.js`);
    // To the brace that closes the function: braces inside its template strings come in pairs.
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`function ${name} does not end`);
  });
  const context = vm.createContext({});
  vm.runInContext(`${texts.join('\n')}\nthis.exported = { ${names.join(', ')} };`, context);
  return (context as { exported: Record<string, (...args: unknown[]) => string> }).exported;
}

test('app: a run with failed databases never reads as identical', () => {
  const { countsHtml } = browserFunctions(['onlyIn', 'countsHtml']);
  assert.ok(countsHtml);
  const tags = (html: string, cls: string): number => html.split(`class="tag ${cls}"`).length - 1;
  const zero = { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 };

  // Nothing differs and every database was compared: identical.
  for (const errors of [0, undefined]) {
    const clean = countsHtml(zero, false, 'batch', errors);
    assert.equal(tags(clean, 'ok'), 1, clean);
    assert.equal(tags(clean, 'err'), 0, clean);
  }
  // Nothing differs in what was compared, but two databases were not: no "identical", one error tag.
  const failed = countsHtml(zero, false, 'batch', 2);
  assert.equal(tags(failed, 'ok'), 0, failed);
  assert.equal(tags(failed, 'err'), 1, failed);
  assert.match(failed, /class="tag err">[^<]* 2 [^<]*</);
  // With differences as well: the counts and the error tag.
  const both = countsHtml({ ...zero, different: 3 }, false, 'batch', 1);
  assert.equal(tags(both, 'ok'), 0, both);
  assert.equal(tags(both, 'chg'), 1, both);
  assert.equal(tags(both, 'err'), 1, both);
  // Incomplete (no VIEW DEFINITION) is its own tag, next to the error tag.
  assert.equal(tags(countsHtml(zero, true, 'batch', 1), 'err'), 2);
});

// A scheduled job whose spec no longer validates (the profile of its server was deleted, say) used
// to end before any run existed: Task Scheduler showed a failed task, the history page nothing.
test('app: a scheduled job that cannot start leaves a failed run, and its task exits 2', async (t) => {
  interface FailedRun {
    id: string;
    status: string;
    createdAt: string;
    finishedAt: string;
    resultError: string;
    spec: { kind: string; trigger: string; jobId: string | null; jobName: string | null; categories: string[]; databases: string[]; source: { serverId: string; serverLabel: string }; target: { serverLabel: string } };
  }
  const jobId = 'de56fa78';
  writeProfile('kept', 'kept.invalid');
  writeFileSync(config.JOBS_FILE, JSON.stringify([job(jobId, 'job without its server', {
    kind: 'batch', source: { serverId: 'app:kept' }, target: { serverId: 'app:gone' }, databases: ['one', 'two'], categories: ['Table', 'View'], options: {},
  })]), 'utf8');

  const cli = spawnSync(process.execPath, [path.join(ROOT, 'app', 'cli.js'), 'run-job', jobId], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const log = `${cli.stdout ?? ''}${cli.stderr ?? ''}`;
  const records = runsOfJob<FailedRun>(jobId);

  await t.test('cli.js exits 2 and says why', () => {
    assert.equal(cli.status, 2, log);
    assert.match(log, /Unknown server: app:gone/);
  });

  await t.test('the failure is a run record the history page can show', () => {
    assert.equal(records.length, 1, log);
    const record = records[0] as FailedRun;
    assert.equal(record.status, 'failed');
    assert.match(record.resultError, /Unknown server: app:gone/);
    assert.ok(record.createdAt && record.finishedAt);
    // What the pages read of a spec, with a label for each side even when its profile is gone.
    assert.deepEqual(record.spec, {
      kind: 'batch',
      options: {},
      categories: ['Table', 'View'],
      trigger: 'schedule',
      jobId,
      jobName: 'job without its server',
      source: { serverId: 'app:kept', serverLabel: 'kept (kept.invalid)', database: null },
      target: { serverId: 'app:gone', serverLabel: 'app:gone', database: null },
      allDatabases: false,
      databases: ['one', 'two'],
    });
    assert.match(readFileSync(path.join(config.RUNS, record.id, 'run.log'), 'utf8'), /Unknown server: app:gone/);
  });

  await t.test('the job list shows it as the last run', async () => {
    const [listed] = await jobs.list();
    assert.equal(listed?.lastRun?.id, records[0]?.id);
    assert.equal(listed?.lastRun?.status, 'failed');
  });

  await t.test('a job id that does not exist: exit 2, nothing recorded', () => {
    const unknown = spawnSync(process.execPath, [path.join(ROOT, 'app', 'cli.js'), 'run-job', '00000000'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(unknown.status, 2, unknown.stderr);
    assert.match(unknown.stderr, /Unknown job: 00000000/);
    assert.deepEqual(runsOfJob('00000000'), []);
  });
});

test('app: jobs.usingServer names the jobs that use a server on either side', () => {
  writeFileSync(config.JOBS_FILE, JSON.stringify([
    job('11111111', 'as source', { kind: 'compare', source: { serverId: 'app:one', database: 'a' }, target: { serverId: 'local', database: 'b' } }),
    job('22222222', 'as target', { kind: 'batch', source: { serverId: 'local' }, target: { serverId: 'app:one' }, databases: ['a'] }),
    job('33333333', 'another server', { kind: 'batch', source: { serverId: 'app:two' }, target: { serverId: 'app:two' }, allDatabases: true }),
  ]), 'utf8');
  assert.deepEqual(jobs.usingServer('app:one'), [{ id: '11111111', name: 'as source' }, { id: '22222222', name: 'as target' }]);
  assert.deepEqual(jobs.usingServer('app:two').map((j) => j.name), ['another server']);
  // The profile of a server is a file, found whatever the case of its name: so are its jobs.
  assert.deepEqual(jobs.usingServer('app:ONE').map((j) => j.name), ['as source', 'as target']);
  assert.deepEqual(jobs.usingServer('app:none'), []);
  writeFileSync(config.JOBS_FILE, '[]', 'utf8');
  assert.deepEqual(jobs.usingServer('app:one'), []);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

// Deleting the profile of a server would make every job that uses it fail at its next run.
test('app: a server that scheduled jobs use cannot be deleted', async () => {
  writeProfile('used', 'used.invalid');
  writeProfile('unused', 'unused.invalid');
  writeFileSync(config.JOBS_FILE, JSON.stringify([
    job('44444444', 'nightly compare', { kind: 'compare', source: { serverId: 'local', database: 'a' }, target: { serverId: 'app:used', database: 'a' } }),
    job('55555555', 'weekly batch', { kind: 'batch', source: { serverId: 'app:used' }, target: { serverId: 'local' }, allDatabases: true }),
  ]), 'utf8');

  // The real server, on a port of its own (never the app's 4870), over the scratch folders.
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-database-diff': '1' };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(`${base}/api/jobs`, { headers })).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(up, 'app/server.js did not start');
    const remove = async (id: string): Promise<{ status: number; body: { error?: string; ok?: boolean } }> => {
      const res = await fetch(`${base}/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      return { status: res.status, body: await res.json() as { error?: string; ok?: boolean } };
    };

    // Under another case first: the file system would find the profile, so the check must find the jobs.
    const otherCase = await remove('app:USED');
    assert.equal(otherCase.status, 409, JSON.stringify(otherCase.body));
    assert.ok(existsSync(path.join(config.SERVERS, 'used.json')), 'the profile must still be there');
    const refused = await remove('app:used');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error ?? '', /nightly compare/);
    assert.match(refused.body.error ?? '', /weekly batch/);
    assert.ok(existsSync(path.join(config.SERVERS, 'used.json')), 'the profile must still be there');

    // A server no job uses goes as before.
    assert.deepEqual(await remove('app:unused'), { status: 200, body: { ok: true } });
    assert.ok(!existsSync(path.join(config.SERVERS, 'unused.json')));

    // And the first one, once its jobs are gone.
    writeFileSync(config.JOBS_FILE, '[]', 'utf8');
    assert.deepEqual(await remove('app:used'), { status: 200, body: { ok: true } });
    assert.ok(!existsSync(path.join(config.SERVERS, 'used.json')));
  } finally {
    server.kill();
  }
});
