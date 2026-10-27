'use strict';

const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');
const store = require('./store');
const runs = require('./runs');

const JOB_ID = /^[a-f0-9]{8}$/;
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const LAUNCHER = path.join(__dirname, '..', 'run-job.ps1');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readAll() {
  return store.readJson(config.JOBS_FILE, []);
}

function writeAll(jobs) {
  store.writeJson(config.JOBS_FILE, jobs);
}

function taskName(id) {
  return `\\${config.TASK_FOLDER}\\job-${id}`;
}

function schtasks(args) {
  return new Promise((resolve) => {
    execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function validateSchedule(schedule) {
  const s = schedule || {};
  const type = s.type === 'weekly' ? 'weekly' : 'daily';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || ''))) throw httpError(400, 'Time must be HH:MM (24-hour)');
  const days = type === 'weekly' ? (s.days || []).filter((d) => DAYS.includes(d)) : [];
  if (type === 'weekly' && days.length === 0) throw httpError(400, 'Pick at least one day');
  return { type, time: s.time, days };
}

// Runs as the current user, only while that user is logged on: no stored Windows password, and
// the same user can decrypt the DPAPI-protected server passwords. A hidden PowerShell starts node
// so no console window stays open on the desktop during the run. The launcher is a -File script
// because schtasks turns single quotes in /TR into double quotes, which breaks -Command strings.
async function register(job) {
  const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${LAUNCHER}" "${process.execPath}" ${job.id}`;
  if (command.length > 261) throw httpError(500, 'Task command is longer than Task Scheduler allows (261 characters); move the project to a shorter path');
  const args = ['/Create', '/F', '/TN', taskName(job.id), '/TR', command, '/ST', job.schedule.time];
  if (job.schedule.type === 'weekly') args.push('/SC', 'WEEKLY', '/D', job.schedule.days.join(','));
  else args.push('/SC', 'DAILY');
  const { code, stdout, stderr } = await schtasks(args);
  if (code !== 0) throw httpError(500, `Task Scheduler: ${(stderr || stdout).trim()}`);
}

async function unregister(id) {
  const { code, stdout, stderr } = await schtasks(['/Delete', '/F', '/TN', taskName(id)]);
  if (code !== 0 && !/cannot find|does not exist/i.test(stderr + stdout)) {
    throw httpError(500, `Task Scheduler: ${(stderr || stdout).trim()}`);
  }
}

function parseCsvLine(line) {
  const out = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1].replace(/""/g, '"'));
  return out;
}

// Column positions of `schtasks /Query /V /FO CSV` do not depend on the Windows display language.
async function taskInfo(id) {
  const { code, stdout } = await schtasks(['/Query', '/TN', taskName(id), '/V', '/FO', 'CSV', '/NH']);
  if (code !== 0) return { registered: false };
  const cols = parseCsvLine(stdout.split(/\r?\n/).find((l) => l.trim()) || '');
  return { registered: true, nextRun: cols[2] || '', status: cols[3] || '', lastRun: cols[5] || '', lastResult: cols[6] || '' };
}

async function list() {
  const jobs = readAll();
  const history = runs.list();
  return Promise.all(jobs.map(async (job) => {
    const last = history.find((r) => r.spec && r.spec.jobId === job.id);
    return {
      ...job,
      task: job.enabled ? await taskInfo(job.id) : { registered: false },
      lastRun: last ? { id: last.id, createdAt: last.createdAt, status: last.status, counts: last.counts || null, incomplete: Boolean(last.incomplete) } : null,
    };
  }));
}

function get(id) {
  const job = readAll().find((j) => j.id === id);
  if (!job) throw httpError(404, `Unknown job: ${id}`);
  return job;
}

async function save(input) {
  const name = String(input.name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  const schedule = validateSchedule(input.schedule);
  if (!input.spec || input.spec.kind === 'drift') throw httpError(400, 'A schedule runs a compare or batch spec');
  const jobs = readAll();
  let job;
  if (input.id) {
    if (!JOB_ID.test(input.id)) throw httpError(400, 'Invalid job id');
    job = jobs.find((j) => j.id === input.id);
    if (!job) throw httpError(404, `Unknown job: ${input.id}`);
  } else {
    job = { id: crypto.randomBytes(4).toString('hex'), createdAt: new Date().toISOString() };
    jobs.push(job);
  }
  Object.assign(job, { name, schedule, enabled: input.enabled !== false, spec: input.spec, updatedAt: new Date().toISOString() });

  if (job.enabled) await register(job);
  else await unregister(job.id);
  writeAll(jobs);
  return job;
}

async function remove(id) {
  if (!JOB_ID.test(id)) throw httpError(400, 'Invalid job id');
  const jobs = readAll();
  const index = jobs.findIndex((j) => j.id === id);
  if (index < 0) throw httpError(404, `Unknown job: ${id}`);
  await unregister(id);
  jobs.splice(index, 1);
  writeAll(jobs);
}

function runNow(id) {
  const job = get(id);
  return runs.start({ ...job.spec, trigger: 'schedule', jobId: job.id, jobName: job.name });
}

module.exports = { list, get, save, remove, runNow, taskName };
