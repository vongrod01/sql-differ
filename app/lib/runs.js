'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const store = require('./store');
const servers = require('./servers');
const { runPowerShell } = require('./powershell');

const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const SNAPSHOT_FILE = /^[^\\/]+\.snapshot\.json$/;
const CATEGORIES = ['Database', 'Schema', 'Table', 'Column', 'Index', 'Foreign key', 'Check constraint',
  'View', 'Stored procedure', 'Function', 'Trigger', 'User-defined type', 'Sequence', 'Synonym'];
const DEFAULT_CATEGORIES = ['Table', 'Column', 'View', 'Stored procedure', 'Function'];
const OPTION_SWITCHES = {
  ignoreWhitespace: '-IgnoreWhitespace',
  ignoreCase: '-IgnoreCase',
  ignoreCollation: '-IgnoreCollation',
  compareColumnOrder: '-CompareColumnOrder',
};

// Live runs of this process: id -> { emitter ('line', 'end'), lines }. The lines are kept in memory
// so a viewer that joins late gets every line, including ones the log file has not flushed yet.
// Finished runs are read from disk.
const live = new Map();
// The process running a job touches this file; a stale one means the process is gone even when
// its PID now belongs to another program.
const HEARTBEAT_FILE = 'heartbeat';
const HEARTBEAT_MS = 30000;
const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function runDir(id) {
  if (!RUN_ID.test(id)) throw httpError(400, 'Invalid run id');
  return path.join(config.RUNS, id);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A run left "running" by a process that no longer exists (server restarted or closed, machine
// shut down) would stay that way forever; record it as interrupted instead.
function heartbeatStale(id) {
  try {
    return Date.now() - fs.statSync(path.join(config.RUNS, id, HEARTBEAT_FILE)).mtimeMs > HEARTBEAT_STALE_MS;
  } catch {
    return false; // runs started before heartbeats existed: decide by PID only
  }
}

function reconcile(meta) {
  if (meta.status !== 'running' || live.has(meta.id)) return meta;
  if (isAlive(meta.ownerPid) && !heartbeatStale(meta.id)) return meta;
  // The owner may have finished between the first read and now; never overwrite its result.
  const file = path.join(config.RUNS, meta.id, 'run.json');
  const current = store.readJson(file, meta);
  if (current.status !== 'running') return current;
  current.status = 'failed';
  current.finishedAt = current.finishedAt || new Date().toISOString();
  current.resultError = 'Interrupted: the process running it stopped before it finished (server restarted or closed).';
  store.writeJson(file, current);
  return current;
}

function readMeta(id) {
  const meta = store.readJson(path.join(runDir(id), 'run.json'), null);
  if (!meta) throw httpError(404, `Unknown run: ${id}`);
  return reconcile(meta);
}

function list() {
  let ids = [];
  try {
    ids = fs.readdirSync(config.RUNS).filter((d) => RUN_ID.test(d));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return ids
    .map((id) => store.readJson(path.join(config.RUNS, id, 'run.json'), null))
    .filter(Boolean)
    .map(reconcile)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// A file that is open for a moment only (a virus scanner looking at it, a report this server is
// sending to a browser) is tried a few more times before a delete gives up.
const REMOVE_RETRIES = 3;
const REMOVE_RETRY_MS = 100;
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_MS };
// What Windows answers when a file or folder is in use by a program.
const IN_USE = ['EPERM', 'EBUSY', 'EACCES'];

// A run on its way out: its folder under a name that is not a run id, so nothing lists it,
// serves its files, offers its snapshots or prunes it. sweepDeleted removes what is left of one.
const DELETED_PREFIX = 'deleted-';
const DELETED_FOLDER = /^deleted-\d{8}-\d{6}-[a-f0-9]{4}$/;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Deletes a run, whole or not at all. Both ways of calling it (remove, removeWhenFree) return
// { leftover }: true when the run is gone from the history but files of it are still on disk
// for sweepDeleted to remove.
//
// A file that another program has open cannot be deleted on Windows, and a delete that goes file
// by file stops there: the run stayed in the history as "done" with its report, scripts and
// snapshots gone (dead links, a drift baseline that was no longer there), or, deleted in another
// order, as a folder without a run.json that nothing recognised any more.
// So the folder is renamed first. Windows refuses to rename a folder while any file in it is
// open, whatever way it was opened, and refuses as a whole: nothing changes (checked on Windows
// 11: a file opened with every sharing mode, also by this process itself, EPERM at once). A
// rename that fails therefore leaves the run exactly as it was, and the caller is told why.
// Once renamed, the run is gone for every reader in one step, and its files are deleted. Should
// that fail (a program opened a file at that moment, the process was stopped), the folder keeps
// its other name: putting the run back would bring back a run with files missing. sweepDeleted
// removes it when the server starts and with the daily clean-up (not under npm run dev, where
// nothing is deleted: see retention.schedule).

// What the page is told when a delete does not go through: Thai, as the page is, short, with the
// code of the error and without a path. What happened, in English and in full, is for the console
// of the server: the error carries it as "detail" where the caller prints it (an "in use" is
// tried again first), and it is printed here where the error is not expected.
const DELETE_MESSAGES = {
  inUse: (code) => `ลบ run นี้ไม่ได้ และยังไม่มีอะไรถูกลบ: มีโปรแกรมอื่นเปิดไฟล์ใน folder ของ run นี้อยู่ (${code}) ปิดรายงาน script หรือ log ของ run นี้ที่เปิดค้างไว้ แล้วกดลบอีกครั้ง`,
  leftoverInUse: (folder, code) => `ลบ run นี้ไม่ได้ และยังไม่มีอะไรถูกลบ: folder ${folder} ที่การลบครั้งก่อนทิ้งไว้ถูกโปรแกรมอื่นเปิดใช้อยู่ (${code}) จึงขวางการลบ ปิดโปรแกรมที่เปิดไฟล์ใน folder นั้น แล้วกดลบอีกครั้ง`,
  running: 'ลบ run นี้ยังไม่ได้: run ยังทำงานอยู่ รอให้เสร็จก่อนแล้วกดลบอีกครั้ง',
  unknown: 'ไม่พบ run นี้ อาจถูกลบไปแล้ว โหลดหน้าประวัติใหม่เพื่อดูรายการล่าสุด',
  failed: (code) => `ลบ run นี้ไม่สำเร็จ (${code || 'UNKNOWN'}) ดูรายละเอียดได้ที่ console ของ server`,
};

// The first step, tried once: the folder of the run gets its other name. Returns that folder.
// Throws an error for the page: "not there", "in progress", "in use" (marked inUse: worth
// another try a moment later; its detail is the English of it), or a short one without the
// paths that the real error names, which goes to the console instead.
function renameAway(id) {
  // readMeta also covers runs of other processes (scheduled jobs) and marks dead ones interrupted.
  // A run that is not there (deleted in another tab, or by the clean-up, since the page was
  // loaded) gets the answer of this route, not the English one that readMeta has for the others.
  let meta;
  try {
    meta = readMeta(id);
  } catch (err) {
    if (err.status === 404) throw Object.assign(httpError(404, DELETE_MESSAGES.unknown), { detail: 'there is no such run' });
    throw err;
  }
  if (live.has(id) || meta.status === 'running') throw Object.assign(httpError(409, DELETE_MESSAGES.running), { detail: 'the run is still in progress' });
  const dir = runDir(id);
  const gone = path.join(config.RUNS, DELETED_PREFIX + id);
  // What an earlier delete of a folder of this id left (a delete that could not finish, under
  // npm run dev where nothing sweeps; a run folder copied back by hand): it would be in the way
  // of the rename. When it cannot go, that is what the page is told: it is not the run that has
  // a file open, and looking for an open report of the run would find none.
  if (fs.existsSync(gone)) {
    try {
      // One try, without the waits of REMOVE_OPTIONS: the callers come back for more (remove,
      // removeWhenFree), and a request must not keep the server waiting in between.
      fs.rmSync(gone, { recursive: true, force: true });
    } catch (err) {
      if (IN_USE.includes(err.code)) {
        throw Object.assign(httpError(409, DELETE_MESSAGES.leftoverInUse(path.basename(gone), err.code)), {
          inUse: true,
          detail: `the folder ${path.basename(gone)}, which an earlier delete left behind, is in use by another program (${err.code}) and is in the way`,
        });
      }
      console.error(`run ${id} could not be deleted, ${path.basename(gone)} is in the way: ${err.stack || err.message}`);
      throw httpError(500, DELETE_MESSAGES.failed(err.code));
    }
  }
  try {
    fs.renameSync(dir, gone);
  } catch (err) {
    if (IN_USE.includes(err.code)) {
      throw Object.assign(httpError(409, DELETE_MESSAGES.inUse(err.code)), { inUse: true, detail: `a file in its folder is in use by another program (${err.code})` });
    }
    console.error(`run ${id} could not be deleted: ${err.stack || err.message}`);
    throw httpError(500, DELETE_MESSAGES.failed(err.code));
  }
  return gone;
}

// The second step: the files go. It does not throw: the run is gone already.
function deleteRenamed(id, gone) {
  try {
    fs.rmSync(gone, REMOVE_OPTIONS);
  } catch (err) {
    console.error(`run ${id} is deleted, but not all of its files yet (${err.code || err.message}): ${path.basename(gone)} is removed when the server starts or with the daily clean-up (not under npm run dev)`);
    return { leftover: true };
  }
  return { leftover: false };
}

// For the clean-up of old runs, which is not asynchronous. Between tries this process waits and
// does nothing else: time for another program to let go of a file. Not for a file this server is
// sending itself, which it cannot finish sending while it waits here (a request uses
// removeWhenFree). A run that stays in use is kept, and the next clean-up tries again.
function remove(id) {
  for (let attempt = 0; ; attempt++) {
    try {
      return deleteRenamed(id, renameAway(id));
    } catch (err) {
      if (!err.inUse || attempt >= REMOVE_RETRIES) throw err;
      sleepSync(REMOVE_RETRY_MS);
    }
  }
}

// For a request (the delete button of the history page). Between tries the server goes on with
// its other work, so a report or a script of this run that it is sending at that moment can be
// sent to its end and closed. (With a wait that blocks, the folder stayed in use for as long as
// the wait lasted: about 430 ms, then "in use", for a file that was free a moment later.)
async function removeWhenFree(id) {
  for (let attempt = 0; ; attempt++) {
    try {
      return deleteRenamed(id, renameAway(id));
    } catch (err) {
      // Given up: what the page gets is Thai, the console gets the English of it, once.
      if (err.inUse && attempt >= REMOVE_RETRIES) console.error(`run ${id} was not deleted: ${err.detail}`);
      if (!err.inUse || attempt >= REMOVE_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS));
    }
  }
}

// Removes the folders that a delete left under their "deleted-" name (see remove). Returns the
// names it removed. Only a real folder of exactly that kind of name: a link or a junction is
// somebody's own arrangement. One that still cannot be deleted stays for the next time.
function sweepDeleted() {
  let entries = [];
  try {
    entries = fs.readdirSync(config.RUNS, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const removed = [];
  for (const entry of entries) {
    if (!DELETED_FOLDER.test(entry.name)) continue;
    const dir = path.join(config.RUNS, entry.name);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      fs.rmSync(dir, REMOVE_OPTIONS);
      removed.push(entry.name);
    } catch (err) {
      console.error(`${entry.name} (what is left of a deleted run) could not be removed yet: ${err.code || err.message}`);
    }
  }
  return removed;
}

function snapshotPath(ref) {
  if (!ref || !SNAPSHOT_FILE.test(String(ref.file || ''))) throw httpError(400, 'Invalid snapshot reference');
  const file = store.safeJoin(runDir(String(ref.runId)), ref.file);
  if (!fs.existsSync(file)) throw httpError(404, 'Snapshot file not found');
  return file;
}

function checkDatabaseName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 128 || /[\u0000-\u001f,]/.test(value)) throw httpError(400, `Invalid database name: ${name}`);
  return value;
}

// Validates a run spec from the UI or a scheduled job and fills in display labels.
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') throw httpError(400, 'Missing run spec');
  const kind = spec.kind;
  if (!['compare', 'batch', 'drift'].includes(kind)) throw httpError(400, 'Unknown run kind');
  const options = {};
  for (const key of Object.keys(OPTION_SWITCHES)) options[key] = Boolean(spec.options && spec.options[key]);
  // Specs saved before categories existed (old jobs) get the default set.
  const requested = Array.isArray(spec.categories) && spec.categories.length ? spec.categories : DEFAULT_CATEGORIES;
  const unknown = requested.filter((c) => !CATEGORIES.includes(c));
  if (unknown.length) throw httpError(400, `Unknown category: ${unknown.join(', ')}`);
  const categories = CATEGORIES.filter((c) => requested.includes(c));
  const out = { kind, options, categories, trigger: spec.trigger === 'schedule' ? 'schedule' : 'manual', jobId: spec.jobId || null, jobName: spec.jobName || null };

  const side = (s, name, allowSnapshot) => {
    if (!s) throw httpError(400, `Missing ${name}`);
    if (s.snapshot) {
      if (!allowSnapshot) throw httpError(400, `${name} cannot be a snapshot here`);
      snapshotPath(s.snapshot);
      return { snapshot: { runId: s.snapshot.runId, file: s.snapshot.file }, label: s.label || 'snapshot', serverId: s.serverId || null, database: s.database || null };
    }
    const serverId = String(s.serverId || '');
    return { serverId, serverLabel: servers.label(serverId), database: kind === 'batch' ? null : checkDatabaseName(s.database) };
  };

  out.source = side(spec.source, 'source', kind === 'drift');
  out.target = side(spec.target, 'target', kind === 'drift');
  if (kind === 'drift' && !out.source.snapshot) throw httpError(400, 'Drift needs a snapshot as the source');
  if (kind === 'batch') {
    out.allDatabases = Boolean(spec.allDatabases);
    out.databases = out.allDatabases ? [] : (Array.isArray(spec.databases) ? spec.databases : []).map(checkDatabaseName);
    if (!out.allDatabases && out.databases.length === 0) throw httpError(400, 'Pick at least one database');
  }
  return out;
}

// Values use the -Name:value form: with -File, PowerShell reads a separate value that starts with
// "-" (a database named "-x") as another parameter name.
function buildArgs(spec, dir) {
  const args = ['-File', config.ENGINE];
  const report = path.join(dir, 'report.html');
  if (spec.kind === 'batch') {
    args.push(...servers.engineArgs(spec.source.serverId, 'Source'), ...servers.engineArgs(spec.target.serverId, 'Target'));
    if (spec.allDatabases) args.push('-AllDatabases');
    else args.push(`-Databases:${spec.databases.join(',')}`);
    args.push(`-OutputPath:${dir}`);
  } else {
    if (spec.source.snapshot) args.push(`-SourceSnapshot:${snapshotPath(spec.source.snapshot)}`);
    else args.push(...servers.engineArgs(spec.source.serverId, 'Source'), `-SourceDatabase:${spec.source.database}`);
    if (spec.target.snapshot) args.push(`-TargetSnapshot:${snapshotPath(spec.target.snapshot)}`);
    else args.push(...servers.engineArgs(spec.target.serverId, 'Target'), `-TargetDatabase:${spec.target.database}`);
    args.push(`-OutputPath:${report}`);
  }
  args.push('-SaveSnapshots', `-Categories:${spec.categories.join(',')}`);
  for (const [key, flag] of Object.entries(OPTION_SWITCHES)) if (spec.options[key]) args.push(flag);
  return args;
}

// Reads the engine's JSON output into the run record: counts, warnings, snapshots for drift.
function collectResults(meta, dir) {
  const snapshots = [];
  const addSnapshot = (file, side, database) => {
    const sideSpec = meta.spec[side];
    if (!file || !sideSpec.serverId || !fs.existsSync(path.join(dir, file))) return;
    snapshots.push({ file, side, serverId: sideSpec.serverId, serverLabel: sideSpec.serverLabel, database });
  };

  if (meta.spec.kind === 'batch') {
    const index = store.readJson(path.join(dir, 'index.json'), null);
    if (!index) return;
    meta.report = 'index.html';
    meta.databases = index.databases.map((d) => ({
      database: d.database,
      report: d.report,
      syncScript: d.syncScript || '',
      rollbackScript: d.rollbackScript || '',
      error: d.error || '',
      counts: { onlyInSource: d.onlyInSource, onlyInTarget: d.onlyInTarget, different: d.different, unverified: d.unverified },
      incomplete: (d.warnings || []).length > 0,
    }));
    meta.counts = meta.databases.reduce((sum, d) => {
      for (const k of Object.keys(sum)) sum[k] += d.counts[k] || 0;
      return sum;
    }, { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 });
    meta.incomplete = meta.databases.some((d) => d.incomplete);
    meta.errors = meta.databases.filter((d) => d.error).length;
    meta.onlyOnSource = index.onlyOnSource || [];
    meta.onlyOnTarget = index.onlyOnTarget || [];
    meta.noAccess = index.noAccess || [];
    for (const d of index.databases) {
      addSnapshot(d.sourceSnapshot, 'source', d.database);
      addSnapshot(d.targetSnapshot, 'target', d.database);
    }
  } else {
    const result = store.readJson(path.join(dir, 'report.json'), null);
    if (!result) return;
    meta.report = 'report.html';
    meta.syncScript = result.syncScript || '';
    meta.syncError = result.syncError || '';
    meta.rollbackScript = result.rollbackScript || '';
    meta.rollbackError = result.rollbackError || '';
    meta.counts = result.counts;
    meta.warnings = result.warnings;
    meta.incomplete = result.warnings.length > 0;
    meta.sourceLabel = result.source.label;
    meta.targetLabel = result.target.label;
    addSnapshot('report.source.snapshot.json', 'source', meta.spec.source.database);
    addSnapshot('report.target.snapshot.json', 'target', meta.spec.target.database);
  }
  meta.snapshots = snapshots;
}

function start(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const id = newRunId();
  const dir = runDir(id);
  // Before the folder exists: a spec that cannot be turned into arguments leaves nothing behind.
  const args = buildArgs(spec, dir);
  store.ensureDir(dir);
  const meta = { id, createdAt: new Date().toISOString(), status: 'running', ownerPid: process.pid, spec };
  store.writeJson(path.join(dir, 'run.json'), meta);

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const entry = { emitter, lines: [] };
  live.set(id, entry);
  const logFile = path.join(dir, 'run.log');
  const log = fs.createWriteStream(logFile, { encoding: 'utf8' });
  const heartbeat = path.join(dir, HEARTBEAT_FILE);
  const beat = () => { try { fs.writeFileSync(heartbeat, new Date().toISOString()); } catch { /* the next beat retries */ } };
  beat();
  const beatTimer = setInterval(beat, HEARTBEAT_MS);
  beatTimer.unref();

  const done = runPowerShell(args, {
    onLine: (line) => {
      log.write(line + '\n');
      // Blank lines are skipped here as in a replay of the file, so both views show the same.
      if (!line.trim()) return;
      entry.lines.push(line);
      emitter.emit('line', line);
    },
  }).then(({ code }) => {
    meta.exitCode = code;
    meta.finishedAt = new Date().toISOString();
    try {
      collectResults(meta, dir);
    } catch (err) {
      meta.resultError = err.message;
    }
    meta.status = meta.report ? 'done' : 'failed';
    return meta;
  }, (err) => {
    meta.status = 'failed';
    meta.finishedAt = new Date().toISOString();
    meta.resultError = err.message;
    return meta;
  }).then((final) => new Promise((resolve) => log.end(() => {
    clearInterval(beatTimer);
    store.writeJson(path.join(dir, 'run.json'), final);
    fs.rmSync(heartbeat, { force: true });
    live.delete(id);
    emitter.emit('end', final);
    resolve(final);
  })));

  return { id, done };
}

// What the pages show of a spec, taken from one that did not pass normalizeSpec: texts only, and
// a label for each side even when its server profile is gone.
function displaySpec(rawSpec) {
  const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  const side = (raw) => {
    const s = raw && typeof raw === 'object' ? raw : {};
    const serverId = text(s.serverId);
    let serverLabel = serverId || '(none)';
    try {
      if (serverId) serverLabel = servers.label(serverId);
    } catch {
      // The profile does not exist (any more): its id is all there is to show.
    }
    return { serverId, serverLabel, database: text(s.database) || null };
  };
  const categories = CATEGORIES.filter((c) => Array.isArray(spec.categories) && spec.categories.includes(c));
  return {
    kind: ['compare', 'batch', 'drift'].includes(spec.kind) ? spec.kind : 'compare',
    options: {},
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    trigger: spec.trigger === 'schedule' ? 'schedule' : 'manual',
    jobId: text(spec.jobId) || null,
    jobName: text(spec.jobName) || null,
    source: side(spec.source),
    target: side(spec.target),
    allDatabases: Boolean(spec.allDatabases),
    databases: (Array.isArray(spec.databases) ? spec.databases : []).map(text).filter(Boolean),
  };
}

// Records a run that could not start as a failed run, with the reason. For a scheduled job whose
// spec no longer validates (its server profile was deleted, say): without a record the failure
// shows only in Task Scheduler, and the history page looks as if the job never ran.
function recordFailure(rawSpec, err) {
  const id = newRunId();
  const dir = store.ensureDir(runDir(id));
  const now = new Date().toISOString();
  const meta = {
    id,
    createdAt: now,
    finishedAt: now,
    status: 'failed',
    ownerPid: process.pid,
    spec: displaySpec(rawSpec),
    resultError: `The run could not start: ${err.message}`,
  };
  fs.writeFileSync(path.join(dir, 'run.log'), `Error: ${err.message}\n`, 'utf8');
  store.writeJson(path.join(dir, 'run.json'), meta);
  return meta;
}

// Log text from byte `from` and the offset to continue from. Unless `whole`, it stops after the
// last newline, so a line (or a UTF-8 character) still being written is left for the next read.
function readLog(id, from = 0, whole = false) {
  let data;
  try {
    data = fs.readFileSync(path.join(runDir(id), 'run.log'));
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', next: from };
    throw err;
  }
  let end = data.length;
  if (!whole) {
    const newline = data.lastIndexOf(0x0a);
    end = newline >= from ? newline + 1 : from;
  }
  return { text: data.subarray(from, end).toString('utf8'), next: end };
}

// { emitter, lines } of a run in this process, or null.
function subscribe(id) {
  return live.get(id) || null;
}

// Every saved snapshot, newest first, for the drift page.
function listSnapshots() {
  const out = [];
  for (const run of list()) {
    for (const s of run.snapshots || []) {
      out.push({ ...s, runId: run.id, capturedAt: run.createdAt });
    }
  }
  return out;
}

function file(id, name) {
  const full = store.safeJoin(runDir(id), name);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw httpError(404, 'Not found');
  return full;
}

const COMBINED_KEYS = { sync: 'syncScript', rollback: 'rollbackScript' };

// The last lines of a script written by lib/SyncScript.ps1 ($ScriptTrailerComment, then the batch
// that turns NOEXEC off). Anchored at the end only, so a script without them (run folders from
// before the engine wrote its own database check) stays as it is. It starts with fixed text: a
// pattern that starts with "any number of line breaks" is tried from every blank line of a script
// and reads on from each (seconds for a script with tens of thousands of them, in the request
// handler). The blank lines around it are taken off with trimEnd(), for the same reason.
const SCRIPT_TRAILER = /-- End of script: ends the NOEXEC [^\r\n]*\r?\nSET NOEXEC OFF;\r?\nGO$/;

// Only objects only in the source and changed objects become statements; a database with neither
// has a script of comments (items not compared, commented-out drops). The web page uses the same rule.
function hasChangesToApply(d) {
  return Boolean(d.counts) && (d.counts.onlyInSource || 0) + (d.counts.different || 0) > 0;
}

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// The sync (or rollback) scripts of a batch run joined into one file, for databases that have
// something to apply. Each part is preceded by its USE and a check that it took effect: a USE that
// fails (SSMS connected to another server, no access) only ends its own batch, and the next part
// would run in the database before it. The check turns on NOEXEC, so nothing after it executes.
// Scripts carry the same USE and check themselves now; the ones here stay for the run folders
// whose scripts were written before that.
function combinedScript(id, kind) {
  const key = COMBINED_KEYS[kind];
  if (!key) throw httpError(404, 'Not found');
  const meta = readMeta(id);
  if (meta.spec.kind !== 'batch' || meta.status !== 'done' || !Array.isArray(meta.databases)) throw httpError(404, 'Not found');

  // Line breaks inside a name would end a "--" comment and turn the rest into live SQL.
  const comment = (text) => '-- ' + String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ');
  const quoted = (name) => `[${name.replace(/]/g, ']]')}]`;
  const literal = (name) => `N'${name.replace(/'/g, "''")}'`;

  const parts = [];
  const nothingToApply = [];
  const noScript = [];
  for (const d of meta.databases) {
    if (d.error) { noScript.push(`${d.database} (not compared: ${d.error})`); continue; }
    if (!hasChangesToApply(d)) { nothingToApply.push(d.database); continue; }
    if (!d[key]) { noScript.push(`${d.database} (the ${kind} script could not be generated, see the run log)`); continue; }
    let text;
    try {
      text = fs.readFileSync(file(id, d[key]), 'utf8');
    } catch (err) {
      if (err.status !== 404 && err.code !== 'ENOENT') throw err;
      noScript.push(`${d.database} (${d[key]} is missing from the run folder)`);
      continue;
    }
    // A part that turned NOEXEC off at its end would let the parts after a failed check run.
    parts.push({ database: d.database, text: text.replace(/^\uFEFF/, '').trimEnd().replace(SCRIPT_TRAILER, '').trimEnd() });
  }

  const title = kind === 'rollback' ? 'Rollback' : 'Sync';
  const out = [
    comment(`Combined ${kind} script generated by database-diff on ${localStamp()}`),
    comment(`Batch run:      ${id}`),
    comment(`Source server:  ${meta.spec.source.serverLabel || meta.spec.source.serverId}`),
    comment(`Target server:  ${meta.spec.target.serverLabel || meta.spec.target.serverId}`),
    '--',
    comment(`The ${kind} scripts of ${parts.length} databases, one after another. Each part is the script of its`),
    comment('database without the SET NOEXEC OFF that ends it, and starts with USE of that database. If'),
    comment('the database cannot be used (SSMS is connected to another server, or the login has no'),
    comment('access), the rest of this file is not executed, so no part runs in the wrong database. An'),
    comment('error inside a part does not stop the file.'),
    comment(kind === 'rollback'
      ? 'Run it on the target server only after the combined sync script of the same run.'
      : 'Run it on the TARGET server. REVIEW EVERY PART BEFORE RUNNING and back up the databases first.'),
    '--',
    comment(`Included (${parts.length}): ${parts.map((p) => p.database).join(', ') || '(none)'}`),
  ];
  if (nothingToApply.length) {
    out.push(comment(`Not included, nothing to apply (${nothingToApply.length}): ${nothingToApply.join(', ')}`));
    out.push(comment('  Their scripts hold only comments: items not compared, and drops of objects only in the target.'));
  }
  if (noScript.length) {
    out.push(comment(`NOT INCLUDED, NO ${kind.toUpperCase()} SCRIPT (${noScript.length}):`));
    for (const line of noScript) out.push(comment(`  ${line}`));
  }
  if (!parts.length) out.push('', comment(`Nothing to ${kind === 'rollback' ? 'roll back' : 'apply'}.`));

  parts.forEach((p, i) => {
    out.push(
      'GO',
      '',
      '-- ' + '#'.repeat(90),
      comment(`${title} ${i + 1}/${parts.length}: ${p.database}`),
      '-- ' + '#'.repeat(90),
      `USE ${quoted(p.database)};`,
      'GO',
      `IF DB_ID(${literal(p.database)}) IS NULL OR DB_ID() <> DB_ID(${literal(p.database)})`,
      'BEGIN',
      `    RAISERROR(N'database-diff: cannot use database %s. The rest of this file is not executed.', 16, 1, ${literal(p.database)});`,
      '    SET NOEXEC ON;',
      'END',
      'GO',
      p.text,
    );
  });
  // Ends a NOEXEC set by a failed check, so the SSMS session works normally afterwards.
  if (parts.length) out.push('GO', '', 'SET NOEXEC OFF;', 'GO');

  // SSMS reads UTF-8 without a BOM as the ANSI code page, which breaks Thai text in definitions.
  return { name: `batch-${id}.${kind}.sql`, text: '\uFEFF' + out.join('\r\n') + '\r\n' };
}

// The sync or rollback script of the rows a person ticked in the report of a run. The engine builds it from
// what the run kept (the result and the two snapshots next to the report), so no database is opened. A row
// is the position of a difference in that result, the same as the id of its row in the report. The request
// reaches the engine in files, not on its command line: thousands of rows do not fit in one (about 32,000
// characters on Windows).
const SELECTED_KINDS = ['sync', 'rollback'];
// What the engine says when the request itself is wrong (lib/SelectedScript.ps1), as against a failure.
const SELECTION_REFUSED = /^(The selection|The rows|Row \d)/;

async function selectedScript(id, request) {
  const { report, kind, rows } = request || {};
  const meta = readMeta(id);
  if (!SELECTED_KINDS.includes(kind)) throw httpError(400, 'kind must be "sync" or "rollback"');
  if (typeof report !== 'string' || !/^[^\\/]+\.html$/i.test(report)) throw httpError(400, 'report must be the file name of a report of this run');
  if (!Array.isArray(rows) || !rows.length || !rows.every((row) => Number.isInteger(row) && row >= 0)) {
    throw httpError(400, 'rows must be a list of row numbers (whole numbers from 0)');
  }
  if (meta.status !== 'done') throw httpError(409, 'This run has not finished.');
  if (meta.spec.kind === 'drift') throw httpError(409, 'A drift report has no selection: its script is already the way back.');
  const isReport = meta.spec.kind === 'batch' ? (meta.databases || []).some((d) => d.report === report) : report === 'report.html';
  if (!isReport) throw httpError(404, 'This run has no such report');

  const base = report.slice(0, -'.html'.length);
  const dir = runDir(id);
  const missing = [`${base}.json`, `${base}.source.snapshot.json`, `${base}.target.snapshot.json`].filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length) throw httpError(409, `This run no longer has ${missing.join(', ')}, so a script cannot be built from a selection. Compare again.`);

  store.ensureDir(config.TMP);
  const stem = path.join(config.TMP, `selected-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const selection = `${stem}.rows.json`;
  const output = `${stem}.sql`;
  try {
    fs.writeFileSync(selection, JSON.stringify({ rows: [...new Set(rows)].sort((a, b) => a - b) }), 'utf8');
    const run = await runPowerShell(['-File', config.ENGINE, `-ScriptFromResult:${path.join(dir, `${base}.json`)}`,
      `-ScriptSelection:${selection}`, `-ScriptKind:${kind}`, `-ScriptOutput:${output}`]);
    if (run.code !== 0) {
      const said = /^Error: (.*)$/m.exec(run.stdout);
      const message = said ? said[1].trim() : (run.stderr.trim() || `The engine stopped with exit code ${run.code}.`);
      throw httpError(SELECTION_REFUSED.test(message) ? 400 : 500, message);
    }
    let info;
    try { info = JSON.parse(run.stdout.trim()); } catch { throw httpError(500, 'The engine did not answer with JSON.'); }
    // The BOM the engine writes stays in the text: SSMS reads a file without one as ANSI, which breaks Thai text.
    return { name: `${base}.selected.${kind}.sql`, text: fs.readFileSync(output, 'utf8'), selected: info.selected, total: info.total, needs: info.needs };
  } finally {
    fs.rmSync(selection, { force: true });
    fs.rmSync(output, { force: true });
  }
}

module.exports = { start, recordFailure, selectedScript, list, readMeta, remove, removeWhenFree, sweepDeleted, readLog, subscribe, listSnapshots, file, combinedScript, runDir, normalizeSpec, RUN_ID, CATEGORIES, DEFAULT_CATEGORIES };
