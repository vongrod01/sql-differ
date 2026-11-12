// Automatic clean-up of the run history (app/lib/retention.js). What it deletes cannot be brought
// back, so every scenario here has a scratch data folder of its own under test/.out/retention-*,
// and the clean-up runs in a child process that is given that folder (the app reads its data
// folder from the environment when it is loaded). Nothing here loads the app into this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// Another process that has a file open for itself, as an editor or a viewer has: it lets go when
// release() is called.
async function holdFile(file: string): Promise<{ release(): Promise<void> }> {
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:HOLD_FILE, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()",
  ], { env: { ...childEnv(), HOLD_FILE: file }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const closed = once(holder, 'close');
  let released = false;
  const release = async (): Promise<void> => {
    if (!released) holder.stdin.end('\n');
    released = true;
    await closed;
  };
  const said = await Promise.race([
    once(holder.stdout, 'data').then(([chunk]) => String(chunk)),
    closed.then(() => 'the process ended before it held the file'),
  ]);
  if (!/^held/.test(said)) {
    await release();
    assert.fail(said);
  }
  return { release };
}

// Every file of a folder with what it holds, to see that nothing of it changed. `held`: a file
// that another process has open for itself alone, which cannot be read meanwhile.
function contents(dir: string, held = ''): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, path.join(dir, name) === held ? '(in use)' : readFileSync(path.join(dir, name), 'utf8')]));
}

// A file of a run that another program has open cannot be deleted on Windows. A delete that went
// file by file stopped part way: first with run.json gone (the folder was no run to anyone any
// more, and stayed for ever), later with run.json as the last file left (a run in the history
// whose report and scripts were gone). A run is now deleted whole or not at all: its folder is
// renamed first, which Windows refuses while any file in it is open, and refuses as a whole.
test('retention: a run with a file in use is not touched at all, and goes at the next clean-up', async () => {
  const data = dataFolder('locked');
  const now = Date.UTC(2026, 5, 1, 12);
  const fresh = fakeRun(data, now);
  const old = fakeRun(data, now - 200 * DAY);
  const dir = path.join(data, 'runs', old);
  // A run folder holds more than two files; the one in use sorts after run.json.
  writeFileSync(path.join(dir, 'report.sync.sql'), '-- script', 'utf8');
  const held = path.join(dir, 'run.log');
  writeFileSync(held, 'log', 'utf8');
  const whole = contents(dir, held);
  assert.deepEqual(Object.keys(whole), ['report.html', 'report.sync.sql', 'run.json', 'run.log']);

  const holder = await holdFile(held);
  try {
    const out = prune(data, { now, keep: 1 });
    assert.deepEqual(out.result?.deleted, [], out.log);
    assert.match(out.log, new RegExp(`retention: run ${old} was not deleted: .*in use`));
    // Still the run it was: every file is there, as it was, and it counts as kept.
    assert.deepEqual(contents(dir, held), whole);
    assert.equal(out.result?.kept, 2);
    assert.deepEqual(runFolders(data), [fresh, old].sort(), 'nothing else is left in the runs folder');
    assert.deepEqual(loggedIds(data), [], 'nothing is logged as deleted');
  } finally {
    await holder.release();
  }

  // The file is free again: the next clean-up takes the run, and says so.
  const again = prune(data, { now, keep: 1 });
  assert.deepEqual(again.result?.deleted, [old], again.log);
  assert.deepEqual(runFolders(data), [fresh]);
  assert.deepEqual(loggedIds(data), [old]);
});

interface RunRecord {
  id: string;
  status: string;
  report?: string;
}

interface SnapshotRecord {
  runId: string;
  file: string;
}

// The same from the history page, where a person clicks "delete". The run used to lose its
// report, its scripts and its snapshots while it stayed in the history as "done": the link to its
// report was dead, and the drift page still offered a snapshot that was no longer there.
test('retention: a run deleted on the history page with a file in use stays whole, and the page is told', async () => {
  const data = dataFolder('server-locked');
  const id = fakeRun(data, Date.now());
  const other = fakeRun(data, Date.now() - DAY);
  const dir = path.join(data, 'runs', id);
  // A finished comparison as the app records it: a report, a script, a log and a snapshot that
  // the drift page offers as a baseline.
  const snapshot = 'report.target.snapshot.json';
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    id, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'done', ownerPid: 0, exitCode: 1, spec: COMPARE_SPEC,
    report: 'report.html', syncScript: 'report.sync.sql', counts: { onlyInSource: 1, onlyInTarget: 0, different: 0, unverified: 0 }, warnings: [],
    snapshots: [{ file: snapshot, side: 'target', serverId: 'local', serverLabel: 'local', database: 'b' }],
  }), 'utf8');
  writeFileSync(path.join(dir, 'report.sync.sql'), '-- script', 'utf8');
  writeFileSync(path.join(dir, snapshot), '{}', 'utf8');
  const held = path.join(dir, 'run.log');
  writeFileSync(held, 'log', 'utf8');
  const whole = contents(dir, held);

  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  const log = path.join(data, 'server.log');
  await withServer(async (base) => {
    const headers = { 'x-database-diff': '1' };
    const history = async (): Promise<RunRecord[]> => await (await fetch(`${base}/api/runs`, { headers })).json() as RunRecord[];
    const baselines = async (): Promise<SnapshotRecord[]> => await (await fetch(`${base}/api/snapshots`, { headers })).json() as SnapshotRecord[];
    const reportStatus = async (): Promise<number> => (await fetch(`${base}/runs/${id}/report.html`)).status;
    assert.deepEqual((await history()).map((r) => r.id).sort(), [id, other].sort());
    assert.deepEqual((await baselines()).map((s) => s.runId), [id]);

    const holder = await holdFile(held);
    try {
      const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
      // Refused, and said in words a person can act on: Thai, as the page is, with the code of
      // the error and no path. The answer is UTF-8, and says so.
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string };
      assert.match(res.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/i);
      assert.match(body.error, /^ลบ run นี้ไม่ได้ และยังไม่มีอะไรถูกลบ: มีโปรแกรมอื่นเปิดไฟล์ใน folder ของ run นี้อยู่ \(E[A-Z]+\) ปิดรายงาน script หรือ log ของ run นี้ที่เปิดค้างไว้ แล้วกดลบอีกครั้ง$/);
      assert.ok(!body.error.includes(data), 'the message names no path of the server');
      // Nothing went: the run is in the history with a report that opens, and the snapshot the
      // drift page offers is there.
      assert.deepEqual(contents(dir, held), whole);
      const listed = (await history()).find((r) => r.id === id);
      assert.deepEqual([listed?.status, listed?.report], ['done', 'report.html']);
      assert.equal(await reportStatus(), 200);
      assert.deepEqual(await baselines().then((list) => list.map((s) => [s.runId, s.file])), [[id, snapshot]]);
      assert.ok(existsSync(path.join(dir, snapshot)));
    } finally {
      await holder.release();
    }

    // The file is free: the same click deletes the run, all of it.
    const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual((await history()).map((r) => r.id), [other]);
    assert.deepEqual(await baselines(), []);
    assert.equal(await reportStatus(), 404);
  }, env, { log });
  assert.deepEqual(runFolders(data), [other], 'the folder is gone, and nothing is left in its place');
  // The console of the server has it in English, once, for whoever looks after the server.
  const said = readFileSync(log, 'utf8').split(/\r?\n/).filter((line) => line.includes('was not deleted'));
  assert.deepEqual(said.map((line) => line.replace(/\(E[A-Z]+\)/, '(code)')), [`run ${id} was not deleted: a file in its folder is in use by another program (code)`]);
});

// A finished comparison as the app records it, in a folder of `data`: a report, a script, a log and
// a snapshot that the drift page offers as a baseline.
const SNAPSHOT = 'report.target.snapshot.json';
function finishedRun(data: string, created: number): { id: string; dir: string } {
  const id = fakeRun(data, created);
  const dir = path.join(data, 'runs', id);
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    id, createdAt: new Date(created).toISOString(), finishedAt: new Date(created).toISOString(), status: 'done', ownerPid: 0, exitCode: 1, spec: COMPARE_SPEC,
    report: 'report.html', syncScript: 'report.sync.sql', counts: { onlyInSource: 1, onlyInTarget: 0, different: 0, unverified: 0 }, warnings: [],
    snapshots: [{ file: SNAPSHOT, side: 'target', serverId: 'local', serverLabel: 'local', database: 'b' }],
  }), 'utf8');
  writeFileSync(path.join(dir, 'report.sync.sql'), '-- script', 'utf8');
  writeFileSync(path.join(dir, SNAPSHOT), '{}', 'utf8');
  writeFileSync(path.join(dir, 'run.log'), 'log', 'utf8');
  return { id, dir };
}

// What the pages are told of a run: is it in the history, is its snapshot offered as a baseline,
// does its report open.
async function seenByPages(base: string, id: string): Promise<{ listed: boolean; baseline: boolean; report: number }> {
  const headers = { 'x-database-diff': '1' };
  const runs = await (await fetch(`${base}/api/runs`, { headers })).json() as RunRecord[];
  const snapshots = await (await fetch(`${base}/api/snapshots`, { headers })).json() as SnapshotRecord[];
  const report = await fetch(`${base}/runs/${id}/report.html`);
  await report.arrayBuffer();
  return { listed: runs.some((r) => r.id === id), baseline: snapshots.some((s) => s.runId === id), report: report.status };
}

// A file of the run that the server itself is sending (a report being opened, a script being
// downloaded) is open in the server, and Windows refuses the rename of the folder as long as it
// is. The delete waits a moment and tries again. It used to wait without letting the server do
// anything else, so the download it was waiting for could not end: the wait was for nothing,
// and the click was refused although the file was free a moment later.
test('retention: a run whose file the server is sending at that moment is deleted once that download ends', async () => {
  const data = dataFolder('server-own-stream');
  const { id, dir } = finishedRun(data, Date.now());
  // Far more than the server can hand to the network at once: it is still reading the file
  // while the reader of the download has not asked for more.
  const big = path.join(dir, 'big.log');
  writeFileSync(big, Buffer.alloc(48 * 1024 * 1024, 0x61));
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  await withServer(async (base) => {
    const headers = { 'x-database-diff': '1' };
    const download = await fetch(`${base}/runs/${id}/big.log`);
    assert.equal(download.status, 200);
    const reader = download.body?.getReader();
    assert.ok(reader);
    await reader.read();
    // The server has the file open: nobody can rename the folder now.
    assert.throws(() => renameSync(dir, `${dir}-probe`), /EPERM|EBUSY|EACCES/, 'the download keeps the file open in the server');

    const deleted = fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
    // The first try has met the open file by now. The download ends: the reader walks away.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await reader.cancel();
    const res = await deleted;
    assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
    assert.deepEqual(await seenByPages(base, id), { listed: false, baseline: false, report: 404 });
  }, env);
  assert.deepEqual(runFolders(data), []);
});

// The folder got its other name, and then its files could not all be deleted. No test can make
// Windows do that on demand (a file that is open stops the rename already), so the server of
// this test is started with a module that makes the delete fail (test/support/fs-fault.cjs).
// The run is gone for every page, the answer says that files are left, and the next start of
// the server removes them.
const FS_FAULT = path.join(ROOT, 'test', 'support', 'fs-fault.cjs');

test('retention: a run whose files cannot all be deleted is gone from the history all the same, and the answer says files are left', async () => {
  const data = dataFolder('server-leftover-route');
  const { id } = finishedRun(data, Date.now());
  const other = fakeRun(data, Date.now() - DAY);
  const leftover = path.join(data, 'runs', `deleted-${id}`);
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  const log = path.join(data, 'server.log');
  await withServer(async (base) => {
    assert.deepEqual(await seenByPages(base, id), { listed: true, baseline: true, report: 200 });
    const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers: { 'x-database-diff': '1' } });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, leftover: true }]);
    // No dead link, no baseline that is not there: the run is not a run any more.
    assert.deepEqual(await seenByPages(base, id), { listed: false, baseline: false, report: 404 });
    assert.deepEqual(runFolders(data), [other, `deleted-${id}`].sort());
    assert.deepEqual(readdirSync(leftover).sort(), ['report.html', 'report.sync.sql', SNAPSHOT, 'run.json', 'run.log'].sort(), 'its files are all still there, under the other name');
  }, { ...env, DATABASE_DIFF_TEST_FS_FAULT: 'delete' }, { log, preload: FS_FAULT });
  // The console of the server says what happened, for whoever looks after it.
  assert.match(readFileSync(log, 'utf8'), new RegExp(`run ${id} is deleted, but not all of its files yet \\(EPERM\\): deleted-${id} is removed `));

  // The next start of the server, with nothing in the way.
  await withServer(async (base) => {
    assert.deepEqual(await seenByPages(base, id), { listed: false, baseline: false, report: 404 });
  }, env);
  assert.deepEqual(runFolders(data), [other]);
});

// The other two answers of the delete button, in the words of the page as well: a run that is
// still going, and a run that is not there (deleted in another tab, or by the clean-up).
test('retention: a run in progress or a run that is gone is not deleted, and the page is told in Thai', async () => {
  const data = dataFolder('server-not-deletable');
  // In progress: its process is alive (this one) and its heartbeat is fresh.
  const running = fakeRun(data, Date.now(), { status: 'running', ownerPid: process.pid, heartbeat: true });
  const gone = runId(Date.now() - DAY);
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  await withServer(async (base) => {
    const headers = { 'x-database-diff': '1' };
    const answer = async (id: string): Promise<[number, string]> => {
      const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
      return [res.status, (await res.json() as { error: string }).error];
    };
    assert.deepEqual(await answer(running), [409, 'ลบ run นี้ยังไม่ได้: run ยังทำงานอยู่ รอให้เสร็จก่อนแล้วกดลบอีกครั้ง']);
    assert.deepEqual(await answer(gone), [404, 'ไม่พบ run นี้ อาจถูกลบไปแล้ว โหลดหน้าประวัติใหม่เพื่อดูรายการล่าสุด']);
    // The page of a run that is not there is another matter: its answer is as it was.
    const page = await fetch(`${base}/api/runs/${gone}`, { headers });
    assert.deepEqual([page.status, (await page.json() as { error: string }).error], [404, `Unknown run: ${gone}`]);
  }, env);
  assert.deepEqual(runFolders(data), [running]);
});

// What an earlier delete of a folder of this id left behind is removed first: it would be in the
// way of the rename. When that folder is in use, the answer must say so, not "a file in its
// folder", which would send a person looking for an open report of the run.
test('retention: a leftover of an earlier delete that is in use is named as what it is', async () => {
  const data = dataFolder('server-leftover-in-use');
  const { id, dir } = finishedRun(data, Date.now());
  const whole = contents(dir);
  const leftover = path.join(data, 'runs', `deleted-${id}`);
  mkdirSync(leftover);
  const held = path.join(leftover, 'run.log');
  writeFileSync(held, 'log', 'utf8');
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles'), WATCH_REPORT_DEPENDENCIES: '1' };
  // As under npm run dev, where nothing sweeps such a folder when the server starts: it is
  // there when the delete comes.
  await withServer(async (base) => {
    const headers = { 'x-database-diff': '1' };
    const holder = await holdFile(held);
    try {
      const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string };
      assert.equal(body.error, `ลบ run นี้ไม่ได้ และยังไม่มีอะไรถูกลบ: folder deleted-${id} ที่การลบครั้งก่อนทิ้งไว้ถูกโปรแกรมอื่นเปิดใช้อยู่ (EPERM) จึงขวางการลบ ปิดโปรแกรมที่เปิดไฟล์ใน folder นั้น แล้วกดลบอีกครั้ง`);
      assert.ok(!body.error.includes(data), 'the message names no path of the server');
      assert.deepEqual(contents(dir), whole);
      assert.deepEqual(await seenByPages(base, id), { listed: true, baseline: true, report: 200 });
    } finally {
      await holder.release();
    }
    const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  }, env);
  assert.deepEqual(runFolders(data), []);
});

// An error of the delete that is not "a file is in use" is not one a person at the page can act
// on, and its message names folders of the server. The page gets a short answer without them;
// the whole error goes to the console of the server.
test('retention: a delete that fails for another reason tells the page no path of the server, and the console all of it', async () => {
  const data = dataFolder('server-rename-error');
  const { id, dir } = finishedRun(data, Date.now());
  const whole = contents(dir);
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  const log = path.join(data, 'server.log');
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/runs/${id}`, { method: 'DELETE', headers: { 'x-database-diff': '1' } });
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'ลบ run นี้ไม่สำเร็จ (EINVAL) ดูรายละเอียดได้ที่ console ของ server');
    assert.deepEqual(await seenByPages(base, id), { listed: true, baseline: true, report: 200 });
  }, { ...env, DATABASE_DIFF_TEST_FS_FAULT: 'rename' }, { log, preload: FS_FAULT });
  assert.deepEqual(contents(dir), whole);
  const console = readFileSync(log, 'utf8');
  assert.match(console, new RegExp(`run ${id} could not be deleted: .*EINVAL: invalid argument, rename `));
  assert.ok(console.includes(dir), 'the console has the path, the page has not');
});

// A delete that was cut short after the folder got its other name (the server was stopped, the
// machine went down, a scanner opened a file at that moment) leaves that folder: "deleted-" and
// the id of the run. It is no run to anyone, and the server removes it when it starts, also when
// the clean-up of old runs is turned off. Only a real folder of exactly that kind of name.
test('retention: what a delete that was cut short left behind is no run, and goes when the server starts', async () => {
  const data = dataFolder('server-leftover');
  const kept = fakeRun(data, Date.now());
  const goneId = runId(Date.now() - DAY);
  const leftover = path.join(data, 'runs', `deleted-${goneId}`);
  mkdirSync(leftover);
  const snapshot = 'report.target.snapshot.json';
  writeFileSync(path.join(leftover, 'run.json'), JSON.stringify({
    id: goneId, createdAt: new Date(Date.now() - DAY).toISOString(), status: 'done', ownerPid: 0, spec: COMPARE_SPEC, report: 'report.html',
    snapshots: [{ file: snapshot, side: 'target', serverId: 'local', serverLabel: 'local', database: 'b' }],
  }), 'utf8');
  writeFileSync(path.join(leftover, 'report.html'), '<!doctype html><title>report</title>', 'utf8');
  writeFileSync(path.join(leftover, snapshot), '{}', 'utf8');
  const held = path.join(leftover, 'run.log');
  writeFileSync(held, 'log', 'utf8');
  // Not the app's: another name, and a junction of that kind of name to a folder elsewhere.
  const otherName = path.join(data, 'runs', 'deleted-by-hand');
  mkdirSync(otherName);
  writeFileSync(path.join(otherName, 'keep.txt'), 'x', 'utf8');
  const elsewhere = path.join(data, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'keep.txt'), 'x', 'utf8');
  const linked = `deleted-${runId(Date.now() - 2 * DAY)}`;
  symlinkSync(elsewhere, path.join(data, 'runs', linked), 'junction');

  // Retention is off for a server of the tests (DATABASE_DIFF_RETENTION_DAYS=0): leftovers go all the same.
  const env = { DATABASE_DIFF_DATA: data, DATABASE_DIFF_MCP_PROFILES: path.join(data, 'no-mcp-profiles') };
  const look = async (base: string): Promise<{ runs: string[]; snapshots: number; storage: number }> => {
    const headers = { 'x-database-diff': '1' };
    const runs = await (await fetch(`${base}/api/runs`, { headers })).json() as RunRecord[];
    const snapshots = await (await fetch(`${base}/api/snapshots`, { headers })).json() as SnapshotRecord[];
    const storage = await (await fetch(`${base}/api/storage`, { headers })).json() as Storage;
    return { runs: runs.map((r) => r.id), snapshots: snapshots.length, storage: storage.runs };
  };

  // A file of the leftover is still open somewhere: it cannot go yet, and it is no run meanwhile.
  const holder = await holdFile(held);
  try {
    assert.deepEqual(await withServer(look, env), { runs: [kept], snapshots: 0, storage: 1 });
    assert.ok(existsSync(held), 'a leftover with a file in use stays for the next start');
  } finally {
    await holder.release();
  }
  // The next start takes it.
  assert.deepEqual(await withServer(look, env), { runs: [kept], snapshots: 0, storage: 1 });
  assert.deepEqual(runFolders(data), ['deleted-by-hand', kept, linked].sort());
  assert.ok(existsSync(path.join(otherName, 'keep.txt')), 'a folder of another name is not the app\'s to delete');
  assert.ok(existsSync(path.join(elsewhere, 'keep.txt')), 'what a junction points at is not touched');

  // Not under node --watch (npm run dev): nothing is deleted then.
  mkdirSync(leftover);
  writeFileSync(path.join(leftover, 'run.json'), '{}', 'utf8');
  await withServer(look, { ...env, WATCH_REPORT_DEPENDENCIES: '1' });
  assert.ok(existsSync(leftover), 'nothing is deleted under node --watch');
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
