'use strict';

// Automatic clean-up of the run history. Every run keeps its reports, scripts and two snapshots of
// the whole schema, so the data folder only grows. Runs older than config.RETENTION_DAYS are
// deleted, counted back from the newest run (see prune), except:
// - the newest config.RETENTION_KEEP runs, whatever their age;
// - a run that is still in progress;
// - a run whose snapshot a scheduled job reads, or that is the baseline of a drift run that is
//   itself kept (deleting it would leave that run pointing at nothing);
// - anything that is not clearly a run of this app: a folder with another kind of name, a link, a
//   run.json that cannot be read, names another run or has no date as the app writes one.
// Deleting is final, so every doubt means "keep", and when the folder or the job list cannot be
// read nothing is deleted at all.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const runs = require('./runs');

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_CACHE_MS = 5 * 60 * 1000;

// How the app writes the date of a run (toISOString): 2026-06-01T12:00:00.000Z. Date.parse reads
// much more than that as a date ("1" is the year 2001, "Jan 5" a day of that year): text of
// another shape is not a date of this app, and its folder is left alone.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

// The runs whose snapshot files a spec reads (a drift run compares a saved snapshot).
function snapshotRunIds(spec) {
  const ids = [];
  for (const side of [spec && spec.source, spec && spec.target]) {
    const id = side && side.snapshot && side.snapshot.runId;
    if (typeof id === 'string' && runs.RUN_ID.test(id)) ids.push(id);
  }
  return ids;
}

// Deletes the runs that are old enough and returns { deleted: [ids], kept, skipped, reason }.
// `reason` says why nothing was looked at ('off', or what could not be read); '' otherwise.
// now: the time to measure ages from (ms). Nothing outside config.RUNS is ever touched.
function prune({ now = Date.now(), days = config.RETENTION_DAYS, keep = config.RETENTION_KEEP } = {}) {
  const result = { deleted: [], kept: 0, skipped: 0, reason: '' };
  if (!Number.isFinite(days) || days <= 0) return { ...result, reason: 'off' };
  if (!Number.isInteger(keep) || keep < 0) return { ...result, reason: 'invalid keep count' };

  let entries;
  try {
    entries = fs.readdirSync(config.RUNS, { withFileTypes: true });
  } catch (err) {
    // No folder yet: no history. Anything else: do not guess.
    return { ...result, reason: err.code === 'ENOENT' ? '' : `the runs folder cannot be read (${err.code || err.message})` };
  }
  let jobs;
  try {
    jobs = store.readJson(config.JOBS_FILE, []);
  } catch (err) {
    return { ...result, reason: `the job list cannot be read (${err.code || err.message})` };
  }
  if (!Array.isArray(jobs)) return { ...result, reason: 'the job list is not a list' };

  // What is clearly a run of this app, newest first.
  const found = [];
  for (const entry of entries) {
    const id = entry.name;
    if (!runs.RUN_ID.test(id)) { result.skipped++; continue; }
    let meta;
    let created;
    try {
      const dir = store.safeJoin(config.RUNS, id);
      // A link or junction is somebody's own arrangement, and deleting through it would delete
      // what it points at.
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { result.skipped++; continue; }
      meta = runs.readMeta(id);
      created = meta && meta.id === id && typeof meta.createdAt === 'string' && ISO_DATE.test(meta.createdAt) ? Date.parse(meta.createdAt) : NaN;
    } catch {
      result.skipped++;
      continue;
    }
    if (!Number.isFinite(created)) { result.skipped++; continue; }
    found.push({ id, created, meta });
  }
  found.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));

  // Kept by the rules, before anything is known about who reads whose snapshot.
  // Age is counted back from the newest run when the clock is later than that: time in which
  // nothing was run is not age. Counted from the clock, a server that had not been used for a
  // few months (or whose clock jumped forward) deleted everything but the newest runs the
  // moment it was started again.
  const newest = found.length ? found[0].created : now;
  const limit = Math.min(now, newest) - days * DAY_MS;
  const byId = new Map(found.map((run) => [run.id, run]));
  const kept = new Set();
  found.forEach((run, index) => {
    if (index < keep || run.created >= limit || run.meta.status === 'running') kept.add(run.id);
  });
  // Then kept because something that stays reads its snapshot: a scheduled job, or a kept run
  // (which may itself be kept only for that reason, so this goes on until nothing is added).
  const queue = [];
  for (const job of jobs) queue.push(...snapshotRunIds(job && job.spec));
  for (const id of kept) queue.push(...snapshotRunIds(byId.get(id).meta.spec));
  while (queue.length) {
    const id = queue.pop();
    if (kept.has(id) || !byId.has(id)) continue;
    kept.add(id);
    queue.push(...snapshotRunIds(byId.get(id).meta.spec));
  }

  // Oldest first, one line per run in the log and on the console. A run is deleted whole or not
  // at all (runs.remove): one that has a file in use is kept as it is, and tried again next time.
  for (const run of found.filter((r) => !kept.has(r.id)).reverse()) {
    try {
      runs.remove(run.id);
    } catch (err) {
      // The message of a delete that was refused is for the page (Thai): its detail is the
      // English of it.
      console.error(`retention: run ${run.id} was not deleted: ${err.detail || err.message}`);
      kept.add(run.id);
      continue;
    }
    result.deleted.push(run.id);
    const line = `${new Date(now).toISOString()} deleted run ${run.id} (created ${run.meta.createdAt}, older than ${days} days)`;
    console.log(`retention: ${line}`);
    try {
      fs.appendFileSync(config.RETENTION_LOG, `${line}\n`, 'utf8');
    } catch (err) {
      console.error(`retention: could not write ${config.RETENTION_LOG}: ${err.message}`);
    }
  }
  result.kept = kept.size;
  if (result.deleted.length) usageCache = null;
  return result;
}

// Size of the run history: { bytes, runs, days, keep, invalid }. Walking the folder takes a while
// on a long history, so the answer is kept for a few minutes (and forgotten when runs are deleted).
let usageCache = null;

async function folderSize(dir) {
  let bytes = 0;
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += await folderSize(full);
    else if (entry.isFile()) bytes += (await fs.promises.stat(full)).size;
  }
  return bytes;
}

async function measure() {
  let bytes = 0;
  let count = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(config.RUNS, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    if (!runs.RUN_ID.test(entry.name) || !entry.isDirectory()) continue;
    const dir = path.join(config.RUNS, entry.name);
    // A run is what the history page lists: a folder with its run.json. The space of a folder
    // without one still counts.
    if (fs.existsSync(path.join(dir, 'run.json'))) count++;
    try {
      bytes += await folderSize(dir);
    } catch {
      // A run that is being written or deleted right now: counted, its size left out.
    }
  }
  return { bytes, runs: count, days: config.RETENTION_DAYS, keep: config.RETENTION_KEEP, invalid: config.RETENTION_INVALID };
}

// For whoever deletes a run outside prune (the history page): the next answer is measured again.
function forgetUsage() {
  usageCache = null;
}

function usage() {
  if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.value;
  const entry = { at: Date.now(), value: measure() };
  // A failed walk is not kept: the next request tries again.
  entry.value.catch(() => { if (usageCache === entry) usageCache = null; });
  usageCache = entry;
  return entry.value;
}

// Called once when the server is up: cleans up now, then once a day while the server runs. (Runs
// of scheduled jobs are separate processes and never delete anything.)
function schedule() {
  // "npm run dev" runs the server under node --watch, which starts it again at every saved
  // change, and sets this variable in it. Nothing is deleted then: the code that decides what
  // goes may be half edited, and it would decide at every restart. That goes for what a delete
  // left behind under a "deleted-" name too (runs.sweepDeleted): it stays until the server is
  // started the usual way. The history page and the console say so where they speak of it.
  if (process.env.WATCH_REPORT_DEPENDENCIES) {
    console.log('retention: nothing is deleted while the server runs under node --watch (npm run dev): no old runs, and no "deleted-" folders that a delete left behind.');
    return;
  }
  if (config.RETENTION_INVALID) {
    console.warn(`DATABASE_DIFF_RETENTION_DAYS is "${config.RETENTION_INVALID}", which is not a number of days: old runs are NOT deleted automatically. Use a whole number (0 = keep everything).`);
  }
  const run = () => {
    // What a delete that was cut short left under its "deleted-" name (runs.remove). Not part of
    // the retention period: it goes also when old runs are kept for ever.
    try {
      const swept = runs.sweepDeleted();
      if (swept.length) console.log(`retention: removed what was left of ${swept.length} deleted run(s): ${swept.join(', ')}`);
    } catch (err) {
      console.error(`retention: ${err.message}`);
    }
    try {
      const result = prune();
      if (result.reason && result.reason !== 'off') console.error(`retention: nothing was deleted: ${result.reason}`);
    } catch (err) {
      console.error(`retention: ${err.message}`);
    }
  };
  run();
  setInterval(run, DAY_MS).unref();
}

module.exports = { prune, usage, forgetUsage, schedule };
