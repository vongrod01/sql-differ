// Automatic clean-up of the run history (app/lib/retention.js). What it deletes cannot be brought
// back, so every scenario here has a scratch data folder of its own under test/.out/retention-*,
// and the clean-up runs in a child process that is given that folder (the app reads its data
// folder from the environment when it is loaded). Nothing here loads the app into this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, ROOT, childEnv } from './support/engine.js';
import { withServer } from './support/server.js';

const DAY = 24 * 60 * 60 * 1000;
const CHILD = path.join(ROOT, 'test', 'support', 'prune-child.cjs');

function dataFolder(name: string): string {
  const dir = path.join(OUT, `retention-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}

let sequence = 0;

// A run id as the app makes them: local date and time, then four hex digits.
function runId(created: number): string {
  const d = new Date(created);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${(++sequence).toString(16).padStart(4, '0')}`;
}

const COMPARE_SPEC = { kind: 'compare', source: { serverId: 'local', database: 'a' }, target: { serverId: 'local', database: 'b' } };

// The spec of a drift run: it reads the snapshot that the run `baseline` saved.
function driftSpec(baseline: string): Record<string, unknown> {
  return { kind: 'drift', source: { snapshot: { runId: baseline, file: 'report.target.snapshot.json' }, label: 'snapshot' }, target: { serverId: 'local', database: 'b' } };
}

interface FakeRun {
  id?: string;
  status?: string;
  spec?: Record<string, unknown>;
  ownerPid?: number;
  heartbeat?: boolean;
  // Written as run.json instead of a record made from the fields above.
  json?: string;
}

// A run folder as the app leaves one, created `created` (ms). Returns its id.
function fakeRun(data: string, created: number, extra: FakeRun = {}): string {
  const id = extra.id ?? runId(created);
  const dir = path.join(data, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'run.json'), extra.json ?? JSON.stringify({
    id, createdAt: new Date(created).toISOString(), status: extra.status ?? 'done', ownerPid: extra.ownerPid ?? 0, spec: extra.spec ?? COMPARE_SPEC,
  }), 'utf8');
  writeFileSync(path.join(dir, 'report.html'), '<!doctype html><title>report</title>', 'utf8');
  if (extra.heartbeat) writeFileSync(path.join(dir, 'heartbeat'), new Date().toISOString(), 'utf8');
  return id;
}

interface PruneOutput {
  result: { deleted: string[]; kept: number; skipped: number; reason: string } | null;
  days: number;
  invalid: string;
  keep: number;
  log: string;
}

// Runs the clean-up on `data` in a process of its own. `days`: the value of
// DATABASE_DIFF_RETENTION_DAYS there (not set when undefined).
function prune(data: string, options: Record<string, unknown>, days?: string): PruneOutput {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'DATABASE_DIFF_RETENTION_DAYS') delete env[key];
  if (days !== undefined) env['DATABASE_DIFF_RETENTION_DAYS'] = days;
  const run = spawnSync(process.execPath, [CHILD, JSON.stringify(options)], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env });
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, log);
  const line = (run.stdout ?? '').split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
  assert.ok(line, log);
  return { ...(JSON.parse(line.slice('RESULT:'.length)) as Omit<PruneOutput, 'log'>), log };
}

function runFolders(data: string): string[] {
  return readdirSync(path.join(data, 'runs')).sort();
}

// The ids in the lines of retention.log, in the order they were written.
function loggedIds(data: string): string[] {
  const file = path.join(data, 'retention.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => / deleted run (\S+) /.exec(line)?.[1] ?? line);
}

test('retention: a run is deleted only when it is old, not among the newest, not in progress and not needed', () => {
  const data = dataFolder('rules');
  // A fixed "now", so no age here depends on the day the test runs.
  const now = Date.UTC(2026, 5, 1, 12);
  const ago = (days: number): number => now - days * DAY;

  // The newest twenty: sixteen recent runs, a recent drift run, and three that are older than 90
  // days but still among the newest twenty.
  const recent = Array.from({ length: 16 }, (_, i) => fakeRun(data, ago(i + 1)));
  const baseline = fakeRun(data, ago(220));
  const recentDrift = fakeRun(data, ago(20), { spec: driftSpec(baseline) });
  const oldAmongNewest = [fakeRun(data, ago(100)), fakeRun(data, ago(120)), fakeRun(data, ago(130))];
  // Everything below is older than all of those, and older than 90 days.
  const oldA = fakeRun(data, ago(200));
  const oldB = fakeRun(data, ago(201));
  // In progress: its process is alive (this one) and its heartbeat is fresh.
  const running = fakeRun(data, ago(210), { status: 'running', ownerPid: process.pid, heartbeat: true });
  // Left "running" by a process that is gone: the app records it as interrupted, and it goes.
  const interrupted = fakeRun(data, ago(211), { status: 'running', ownerPid: 0 });
  // A scheduled job reads the snapshot of `chain`, which is itself a drift run of `baseline2`.
  const baseline2 = fakeRun(data, ago(230));
  const chain = fakeRun(data, ago(225), { spec: driftSpec(baseline2) });
  writeFileSync(path.join(data, 'jobs.json'), JSON.stringify([
    { id: 'aaaaaaaa', name: 'reads a snapshot', enabled: false, schedule: { type: 'daily', time: '02:00', days: [] }, spec: driftSpec(chain) },
  ]), 'utf8');
  // The baseline of a drift run that is deleted itself: nothing kept reads it.
  const orphanBaseline = fakeRun(data, ago(240));
  const oldDrift = fakeRun(data, ago(235), { spec: driftSpec(orphanBaseline) });

  // Not clearly a run of the app, all "old": never deleted.
  const otherName = fakeRun(data, ago(300), { id: 'not-a-run' });
  const almostName = fakeRun(data, ago(300), { id: '20250101-000000-zzzz' });
  const otherId = fakeRun(data, ago(300), { id: '20250102-000000-aaaa', json: JSON.stringify({ id: '20250103-000000-bbbb', createdAt: new Date(ago(300)).toISOString(), status: 'done', spec: COMPARE_SPEC }) });
  const unreadable = fakeRun(data, ago(300), { id: '20250104-000000-aaaa', json: '{ "id": "20250104-000000-aaaa", "createdAt": ' });
  const noDate = fakeRun(data, ago(300), { id: '20250105-000000-aaaa', json: JSON.stringify({ id: '20250105-000000-aaaa', createdAt: 'last year', status: 'done', spec: COMPARE_SPEC }) });
  const noDateAtAll = fakeRun(data, ago(300), { id: '20250106-000000-aaaa', json: JSON.stringify({ id: '20250106-000000-aaaa', status: 'done', spec: COMPARE_SPEC }) });
  // Text that Date.parse reads as a date (the year 2001, 5 January 2001) but that the app never
  // writes: a date of a run is ISO, 2026-06-01T12:00:00.000Z.
  const looseDates = ['1', 'Jan 5'].map((createdAt, i) => {
    const id = `2025010${8 + i}-000000-aaaa`;
    return fakeRun(data, ago(300), { id, json: JSON.stringify({ id, createdAt, status: 'done', spec: COMPARE_SPEC }) });
  });
  // A junction named like a run, to a folder elsewhere that holds what looks like an old run.
  const linked = '20250107-000000-aaaa';
  const elsewhere = path.join(data, 'elsewhere', linked);
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, 'run.json'), JSON.stringify({ id: linked, createdAt: new Date(ago(300)).toISOString(), status: 'done', spec: COMPARE_SPEC }), 'utf8');
  symlinkSync(elsewhere, path.join(data, 'runs', linked), 'junction');

  const before = runFolders(data);
  const out = prune(data, { now });
  const expected = [oldA, oldB, interrupted, orphanBaseline, oldDrift].sort();

  assert.equal(out.days, 90, 'the default is 90 days');
  assert.equal(out.keep, 20);
  assert.deepEqual([...(out.result?.deleted ?? [])].sort(), expected, out.log);
  assert.deepEqual(runFolders(data), before.filter((id) => !expected.includes(id)));
  // Named one by one, so a mistake in the list above cannot hide a deletion.
  for (const [what, id] of [
    ['recent', recent[0]], ['recent', recent[15]], ['a recent drift run', recentDrift], ['the baseline of a kept drift run', baseline],
    ['old, among the newest twenty', oldAmongNewest[0]], ['old, among the newest twenty', oldAmongNewest[2]],
    ['in progress', running], ['read by a scheduled job', chain], ['the baseline of a run a job reads', baseline2],
    ['a folder with another name', otherName], ['a folder with almost a run name', almostName], ['a run.json for another run', otherId],
    ['a run.json that is not JSON', unreadable], ['a date that is not one', noDate], ['no date', noDateAtAll], ['a junction', linked],
    ['a date that is only a number', looseDates[0]], ['a date that is not ISO', looseDates[1]],
  ] as const) {
    assert.ok(existsSync(path.join(data, 'runs', String(id))), `${what} is kept (${id})`);
  }
  assert.ok(existsSync(path.join(elsewhere, 'run.json')), 'what a junction points at is not touched');
  assert.equal(out.result?.skipped, 9, 'the nine folders that are not clearly runs');
  // The 29 runs above, less the five.
  assert.equal(out.result?.kept, 24);

  // One line per deleted run, oldest first, in the log file and on the console.
  assert.deepEqual(loggedIds(data), [orphanBaseline, oldDrift, interrupted, oldB, oldA]);
  for (const id of expected) assert.match(out.log, new RegExp(`retention: .* deleted run ${id} `));
  assert.equal(out.log.split('deleted run').length - 1, expected.length);

  // Run again: nothing more goes, and the log is not written again.
  const again = prune(data, { now });
  assert.deepEqual(again.result?.deleted, []);
  assert.equal(loggedIds(data).length, expected.length);
});

test('retention: a recent run is kept however many newer ones there are', () => {
  const data = dataFolder('recent');
  const now = Date.UTC(2026, 5, 1, 12);
  // One run a day, the newest made just now.
  const recent = Array.from({ length: 6 }, (_, i) => fakeRun(data, now - i * DAY));
  // Exactly at the limit is not "older than".
  const atLimit = fakeRun(data, now - 90 * DAY);
  const justOver = fakeRun(data, now - 90 * DAY - 1000);
  const old = fakeRun(data, now - 200 * DAY);
  const out = prune(data, { now, keep: 2 });
  assert.deepEqual([...(out.result?.deleted ?? [])].sort(), [justOver, old].sort(), out.log);
  assert.deepEqual(runFolders(data), [...recent, atLimit].sort());

  // A shorter limit takes more: the runs older than three days (the one that is three days old
  // is at the limit), but never the newest two.
  const shorter = prune(data, { now, keep: 2, days: 3 });
  assert.deepEqual([...(shorter.result?.deleted ?? [])].sort(), [...recent.slice(4), atLimit].sort(), shorter.log);
  // The newest three are kept whatever their age: the run of two days ago is older than one day.
  const kept = prune(data, { now, keep: 3, days: 1 });
  assert.deepEqual(kept.result?.deleted, [recent[3]], kept.log);
  assert.deepEqual(runFolders(data), recent.slice(0, 3).sort());
});

// Age is counted back from the newest run, not from the clock: a server that was not used for a
// long time, or a clock that jumped forward, must not make the whole history "old" at once (all
// but the newest twenty runs were deleted at the next start, without a word).
test('retention: time in which nothing was run does not count as age', () => {
  const data = dataFolder('idle');
  const lastUse = Date.UTC(2026, 5, 1, 12);
  // 25 runs over the last 60 days in which the app was used.
  const used = Array.from({ length: 25 }, (_, i) => fakeRun(data, lastUse - i * 2.5 * DAY));
  const all = runFolders(data);
  // Nearly three years later.
  const later = prune(data, { now: lastUse + 1000 * DAY });
  assert.deepEqual(later.result?.deleted, [], later.log);
  assert.equal(later.result?.kept, 25);
  assert.deepEqual(runFolders(data), all);
  assert.ok(!existsSync(path.join(data, 'retention.log')));

  // What was old when the app was last used still goes: older than 90 days before the newest
  // run, and not among the newest twenty.
  const oldThen = [fakeRun(data, lastUse - 200 * DAY), fakeRun(data, lastUse - 300 * DAY)];
  const stillOld = prune(data, { now: lastUse + 1000 * DAY });
  assert.deepEqual([...(stillOld.result?.deleted ?? [])].sort(), [...oldThen].sort(), stillOld.log);
  assert.deepEqual(runFolders(data), all);
  // A clock that is behind the newest run measures from the clock, as before.
  const behind = prune(data, { now: lastUse - 30 * DAY, days: 10, keep: 20 });
  assert.deepEqual([...(behind.result?.deleted ?? [])].sort(), used.slice(20).sort(), behind.log);
});

// A file of a run that another program has open cannot be deleted on Windows. The delete used to
// stop part way, with run.json gone already: the folder was no longer a run to the history page
// nor to the next clean-up, and stayed for ever.
test('retention: a run with a file in use stays a whole run, and goes at the next clean-up', async () => {
  const data = dataFolder('locked');
  const now = Date.UTC(2026, 5, 1, 12);
  const fresh = fakeRun(data, now);
  const old = fakeRun(data, now - 200 * DAY);
  const dir = path.join(data, 'runs', old);
  // A run folder holds more than two files; the one in use sorts after run.json.
  writeFileSync(path.join(dir, 'report.sync.sql'), '-- script', 'utf8');
  const held = path.join(dir, 'run.log');
  writeFileSync(held, 'log', 'utf8');

  // Another process opens the file for itself alone, and lets go when its input ends.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:HOLD_FILE, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()",
  ], { env: { ...childEnv(), HOLD_FILE: held }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const closed = once(holder, 'close');
  try {
    const said = await Promise.race([
      once(holder.stdout, 'data').then(([chunk]) => String(chunk)),
      closed.then(() => 'the process ended before it held the file'),
    ]);
    assert.match(said, /^held/);

    const out = prune(data, { now, keep: 1 });
    assert.deepEqual(out.result?.deleted, [], out.log);
    assert.match(out.log, new RegExp(`retention: run ${old} was not deleted`));
    // Still a run: its record is there, and it counts as kept.
    assert.ok(existsSync(path.join(dir, 'run.json')), 'run.json is the last file to go');
    assert.equal((JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as { id: string }).id, old);
    assert.equal(out.result?.kept, 2);
    assert.deepEqual(loggedIds(data), [], 'nothing is logged as deleted');
  } finally {
    holder.stdin.end('\n');
    await closed;
  }

  // The file is free again: the next clean-up takes the run, and says so.
  const again = prune(data, { now, keep: 1 });
  assert.deepEqual(again.result?.deleted, [old], again.log);
  assert.deepEqual(runFolders(data), [fresh]);
  assert.deepEqual(loggedIds(data), [old]);
});

test('retention: the number of days comes from DATABASE_DIFF_RETENTION_DAYS, and anything unclear turns it off', () => {
  const data = dataFolder('setting');
  const now = Date.UTC(2026, 5, 1, 12);
  // One run of today, and 25 of long ago.
  fakeRun(data, now);
  for (let i = 0; i < 25; i++) fakeRun(data, now - (200 + i) * DAY);
  const all = runFolders(data);
  assert.equal(all.length, 26);

  const read = (value?: string): [number, string] => {
    const out = prune(data, { skip: true }, value);
    return [out.days, out.invalid];
  };
  assert.deepEqual(read(), [90, '']);
  assert.deepEqual(read('30'), [30, '']);
  assert.deepEqual(read(' 365 '), [365, '']);
  assert.deepEqual(read('0'), [0, '']);
  // Not a whole number of days: off, and the text is kept to say so. Never a silent 90.
  for (const value of ['ninety', '-5', '1.5', '90 days', '9e1', '0x5A', '999999']) assert.deepEqual(read(value), [0, value], value);

  // Off: nothing is deleted, whatever is there.
  for (const value of ['0', 'ninety']) {
    const out = prune(data, { now }, value);
    assert.equal(out.result?.reason, 'off', value);
    assert.deepEqual(out.result?.deleted, [], value);
    assert.deepEqual(runFolders(data), all, value);
  }
  assert.ok(!existsSync(path.join(data, 'retention.log')));

  // And with the default the six beyond the newest twenty go.
  const out = prune(data, { now });
  assert.deepEqual([...(out.result?.deleted ?? [])].sort(), all.slice(0, 6));
});

test('retention: nothing is deleted when the job list cannot be read', () => {
  const data = dataFolder('jobs');
  const now = Date.UTC(2026, 5, 1, 12);
  // With a run of today, so that the others are old: six of them would go.
  fakeRun(data, now);
  for (let i = 0; i < 25; i++) fakeRun(data, now - (200 + i) * DAY);
  const all = runFolders(data);
  // Which runs the jobs still need is not known: so none goes.
  for (const jobs of ['[ { "id": ', '{ "jobs": [] }']) {
    writeFileSync(path.join(data, 'jobs.json'), jobs, 'utf8');
    const out = prune(data, { now });
    assert.match(out.result?.reason ?? '', /job list/, jobs);
    assert.deepEqual(out.result?.deleted, [], jobs);
    assert.deepEqual(runFolders(data), all, jobs);
  }
});

interface Storage {
  bytes: number;
  runs: number;
  days: number;
  keep: number;
  invalid: string;
}

// The server cleans up when it starts, and tells the history page what it keeps.
test('retention: the server cleans up at start and reports the size of the history', async () => {
  const scenarios: [name: string, days: string | undefined, left: number, storage: Partial<Storage>, more?: Record<string, string>][] = [
    ['server-default', undefined, 20, { runs: 20, days: 90, keep: 20, invalid: '' }],
    ['server-off', '0', 23, { runs: 23, days: 0, keep: 20, invalid: '' }],
    ['server-invalid', 'ninety', 23, { runs: 23, days: 0, keep: 20, invalid: 'ninety' }],
    // "npm run dev": node --watch restarts the server at every saved change, and sets this
    // variable in it. Code that is half edited must not get to delete history.
    ['server-watch', undefined, 23, { runs: 23, days: 90, keep: 20, invalid: '' }, { WATCH_REPORT_DEPENDENCIES: '1' }],
  ];
  for (const [name, days, left, expected, more] of scenarios) {
    const data = dataFolder(name);
    // One run of today and 22 of long ago: the three oldest are beyond the newest twenty.
    fakeRun(data, Date.now());
    for (let i = 0; i < 22; i++) fakeRun(data, Date.now() - (200 + i) * DAY);
    const all = runFolders(data);
    const env: Record<string, string> = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles'), DATABASE_DIFF_RETENTION_DAYS: days ?? '', ...more };
    const storage = await withServer(async (base) => {
      const res = await fetch(`${base}/api/storage`, { headers: { 'x-database-diff': '1' } });
      assert.equal(res.status, 200, name);
      return await res.json() as Storage;
    }, env);
    assert.equal(runFolders(data).length, left, name);
    // The three oldest went, or nothing did.
    assert.deepEqual(runFolders(data), left === 23 ? all : all.slice(3), name);
    assert.deepEqual(loggedIds(data), left === 23 ? [] : all.slice(0, 3), name);
    const { bytes, ...rest } = storage;
    assert.deepEqual(rest, expected, name);
    assert.ok(bytes > left * 30, `${name}: ${bytes} bytes for ${left} runs`);
  }
});

// The size of the history is measured once and kept for a few minutes. Deleting a run on the
// history page must not leave the line under the list saying what it said before.
test('retention: the size of the history follows a run deleted on the history page', async () => {
  const data = dataFolder('server-delete');
  const ids = Array.from({ length: 4 }, (_, i) => fakeRun(data, Date.now() - i * DAY));
  // A folder named like a run that holds no run.json is not a run of the history.
  mkdirSync(path.join(data, 'runs', '20250101-000000-aaaa'));
  writeFileSync(path.join(data, 'runs', '20250101-000000-aaaa', 'left.txt'), 'x'.repeat(1000), 'utf8');
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  await withServer(async (base) => {
    const headers = { 'x-database-diff': '1' };
    const storage = async (): Promise<Storage> => await (await fetch(`${base}/api/storage`, { headers })).json() as Storage;
    const before = await storage();
    assert.equal(before.runs, 4);
    // A server of the tests deletes nothing by itself unless a test says so.
    assert.equal(before.days, 0);
    const res = await fetch(`${base}/api/runs/${ids[3]}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    const after = await storage();
    assert.equal(after.runs, 3);
    assert.ok(after.bytes < before.bytes, `${after.bytes} < ${before.bytes}`);
  }, env);
  assert.deepEqual(runFolders(data), ['20250101-000000-aaaa', ...ids.slice(0, 3)].sort());
});
