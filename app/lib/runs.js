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

function remove(id) {
  // readMeta also covers runs of other processes (scheduled jobs) and marks dead ones interrupted.
  if (live.has(id) || readMeta(id).status === 'running') throw httpError(409, 'The run is still in progress');
  fs.rmSync(runDir(id), { recursive: true, force: true });
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
  const dir = store.ensureDir(runDir(id));
  const args = buildArgs(spec, dir);
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

module.exports = { start, list, readMeta, remove, readLog, subscribe, listSnapshots, file, runDir, normalizeSpec, RUN_ID, CATEGORIES, DEFAULT_CATEGORIES };
