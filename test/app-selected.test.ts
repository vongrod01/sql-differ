// POST /api/runs/:id/script: the sync or rollback script of the rows a person ticked in a report. The
// server checks the request and has the engine build the script from the files the run kept; the
// engine's own tests are in engine-selected.test.ts. The runs here are made from the golden files of
// the "core" case, so none of this needs a SQL Server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OUT } from './support/engine.js';
import { GOLDEN } from './support/golden.js';
import { withServer } from './support/server.js';

const DATA = path.join(OUT, 'app-selected-data');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env['DATABASE_DIFF_DATA'] = DATA;
process.env['DATABASE_DIFF_MCP_PROFILES'] = path.join(DATA, 'no-mcp-profiles');
const require = createRequire(import.meta.url);
const config = require('../app/lib/config.js') as { RUNS: string; TMP: string };

interface Answer { status: number; body: Record<string, unknown> }
interface Made { name: string; text: string; selected: number; total: number; needs: { row: number; object: string; needsRow: number; needs: string }[] }

let counter = 0;

interface RunOptions {
  kind?: 'compare' | 'batch' | 'drift';
  status?: string;
  // Files of the golden case that the run does not keep.
  without?: string[];
}

// A finished run folder as the web app leaves it: the record, the report (a stub: only the files
// matter here), the result and the two snapshots. A compare run calls its report "report", a batch
// names it after the database ("core").
function makeRun({ kind = 'compare', status = 'done', without = [] }: RunOptions = {}): { id: string; report: string; dir: string } {
  // 20261114-120001-b001: the shape of a real run id (see RUN_ID in app/lib/runs.js).
  const id = `20261114-12${String(++counter).padStart(4, '0')}-b${counter.toString(16).padStart(3, '0')}`;
  const dir = path.join(config.RUNS, id);
  mkdirSync(dir, { recursive: true });
  const base = kind === 'batch' ? 'core' : 'report';
  const copies: [string, string][] = [['result.json', `${base}.json`], ['source.snapshot.json', `${base}.source.snapshot.json`], ['target.snapshot.json', `${base}.target.snapshot.json`]];
  for (const [from, to] of copies) if (!without.includes(to)) copyFileSync(path.join(GOLDEN, 'core', from), path.join(dir, to));
  writeFileSync(path.join(dir, `${base}.html`), '<!doctype html><title>report</title>', 'utf8');
  const meta: Record<string, unknown> = {
    id, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status, ownerPid: 0,
    spec: { kind, source: { serverLabel: 'a', database: 'core' }, target: { serverLabel: 'b', database: 'core' } },
  };
  if (kind === 'batch') meta['databases'] = [{ database: 'core', report: 'core.html', syncScript: 'core.sync.sql', rollbackScript: 'core.rollback.sql', error: '', counts: {} }];
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(meta), 'utf8');
  return { id, report: `${base}.html`, dir };
}

async function post(base: string, id: string, body: unknown, headers: Record<string, string> = { 'x-database-diff': '1' }): Promise<Answer> {
  const res = await fetch(`${base}/api/runs/${id}/script`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const made = (answer: Answer): Made => answer.body as unknown as Made;

test('selected script (server): the rows of a compare run give its script, named after the report', async () => {
  const { id, report } = makeRun();
  await withServer(async (base) => {
    const sync = await post(base, id, { report, kind: 'sync', rows: [31] });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(made(sync).name, 'report.selected.sync.sql');
    assert.deepEqual([made(sync).selected, made(sync).total, made(sync).needs], [1, 49, []]);
    // The BOM the engine writes stays: SSMS reads a file without one as ANSI, which breaks Thai text.
    assert.equal(made(sync).text.charCodeAt(0), 0xfeff);
    assert.match(made(sync).text, /pNewOrder/);
    assert.doesNotMatch(made(sync).text, /pGetOrder/);
    assert.match(made(sync).text, /Generated from a selection: 1 of 49 differences/);

    const rollback = await post(base, id, { report, kind: 'rollback', rows: [31, 29] });
    assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
    assert.equal(made(rollback).name, 'report.selected.rollback.sql');
    assert.equal(made(rollback).selected, 2);
  });
});

test('selected script (server): rows may come in any order and a row twice is the same as once', async () => {
  const { id, report } = makeRun();
  await withServer(async (base) => {
    const plain = await post(base, id, { report, kind: 'sync', rows: [29, 31, 33] });
    const messy = await post(base, id, { report, kind: 'sync', rows: [33, 31, 31, 29] });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(messy.status, 200, JSON.stringify(messy.body));
    assert.equal(made(messy).selected, 3);
    // Only the line that says when it was made may differ.
    const body = (a: Answer): string => made(a).text.replace(/generated by database-diff on [\d-]+ [\d:]+/, '');
    assert.equal(body(messy), body(plain));
  });
});

test('selected script (server): what a chosen row needs and is not chosen comes back, and the temporary files are gone', async () => {
  const { id, report } = makeRun();
  await withServer(async (base) => {
    const alone = await post(base, id, { report, kind: 'sync', rows: [37] });
    assert.equal(alone.status, 200, JSON.stringify(alone.body));
    assert.deepEqual(made(alone).needs, [{ row: 37, object: 'dbo.trAudit', needsRow: 2, needs: 'dbo.Audit' }]);
    assert.match(made(alone).text, /WARNING:.*trAudit.*dbo\.Audit/);
    const both = await post(base, id, { report, kind: 'sync', rows: [2, 37] });
    assert.deepEqual(made(both).needs, []);
    // A request leaves nothing behind in the temporary folder, an answered one or a refused one.
    await post(base, id, { report, kind: 'sync', rows: [49] });
  });
  let left: string[] = [];
  try { left = readdirSync(config.TMP).filter((name) => name.startsWith('selected-')); } catch { left = []; }
  assert.deepEqual(left, []);
});

test('selected script (server): a report of a batch is found by its name, and the index is not a report', async () => {
  const { id } = makeRun({ kind: 'batch' });
  await withServer(async (base) => {
    const ok = await post(base, id, { report: 'core.html', kind: 'sync', rows: [31] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(made(ok).name, 'core.selected.sync.sql');
    assert.equal((await post(base, id, { report: 'index.html', kind: 'sync', rows: [31] })).status, 404);
    assert.equal((await post(base, id, { report: 'nothing.html', kind: 'sync', rows: [31] })).status, 404);
  });
});

test('selected script (server): requests that are not right are refused with the reason', async () => {
  const { id, report } = makeRun();
  await withServer(async (base) => {
    const ok = { report, kind: 'sync', rows: [31] };
    const refused: [what: string, answer: Answer, status: number][] = [
      ['no header', await post(base, id, ok, {}), 403],
      ['a run id that is not one', await post(base, 'not-a-run', ok), 400],
      ['a run that does not exist', await post(base, '20200101-000000-aaaa', ok), 404],
      ['a kind that is neither', await post(base, id, { ...ok, kind: 'drop' }), 400],
      ['no kind', await post(base, id, { report, rows: [31] }), 400],
      ['a report with a path', await post(base, id, { ...ok, report: '../report.html' }), 400],
      ['a report that is not a page', await post(base, id, { ...ok, report: 'report.json' }), 400],
      ['no rows', await post(base, id, { ...ok, rows: [] }), 400],
      ['rows that are not a list', await post(base, id, { ...ok, rows: 'all' }), 400],
      ['a row that is not a number', await post(base, id, { ...ok, rows: ['31'] }), 400],
      ['a negative row', await post(base, id, { ...ok, rows: [-1] }), 400],
      ['a fractional row', await post(base, id, { ...ok, rows: [1.5] }), 400],
      ['a row the comparison does not have', await post(base, id, { ...ok, rows: [31, 49] }), 400],
    ];
    for (const [what, answer, status] of refused) {
      assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer.body)}`);
      assert.equal(typeof answer.body['error'], 'string', what);
    }
    // The reason of the last one says which row.
    assert.match(String(refused[refused.length - 1]?.[1].body['error']), /49/);
  });
});

test('selected script (server): a run that is not finished, a drift run, and a run without its files are told why', async () => {
  const running = makeRun({ status: 'running' });
  const drift = makeRun({ kind: 'drift' });
  const noTarget = makeRun({ without: ['report.target.snapshot.json'] });
  const noResult = makeRun({ without: ['report.json'] });
  await withServer(async (base) => {
    for (const [what, run, text] of [
      ['a run still running', running, /not finished/i],
      ['a drift run', drift, /drift/i],
      ['a run that kept no target snapshot', noTarget, /snapshot/i],
      ['a run that kept no result', noResult, /result|compare again/i],
    ] as const) {
      const answer = await post(base, run.id, { report: run.report, kind: 'sync', rows: [31] });
      assert.equal(answer.status, 409, `${what}: ${JSON.stringify(answer.body)}`);
      assert.match(String(answer.body['error']), text, what);
    }
  });
});

// A run can be large: thousands of rows ticked at once must not travel on the command line of the engine
// (about 32,000 characters on Windows), nor take the engine so long that the page seems stuck.
test('selected script (server): thousands of rows are answered', async () => {
  const { id, report, dir } = makeRun();
  const COUNT = 9000;
  const result = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as { diffs: Record<string, unknown>[] };
  const source = JSON.parse(readFileSync(path.join(dir, 'report.source.snapshot.json'), 'utf8')) as { categories: Record<string, Record<string, unknown>> };
  const procedures = source.categories['Stored procedure'] as Record<string, unknown>;
  const model = procedures['dbo.pNewOrder'] as Record<string, unknown>;
  const first = result.diffs.findIndex((d) => d['Object'] === 'dbo.pNewOrder');
  assert.ok(first >= 0 && model, 'the core case has dbo.pNewOrder');
  result.diffs = [];
  for (let i = 0; i < COUNT; i++) {
    const key = `dbo.pBulk${String(i).padStart(5, '0')}`;
    procedures[key] = { ...model, Name: key, ObjectName: `pBulk${String(i).padStart(5, '0')}` };
    result.diffs.push({ Category: 'Stored procedure', Object: key, Status: 'OnlyInSource', Detail: '', SourceDefinition: null, TargetDefinition: null, SourceKey: key, TargetKey: null });
  }
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(result), 'utf8');
  writeFileSync(path.join(dir, 'report.source.snapshot.json'), JSON.stringify(source), 'utf8');
  await withServer(async (base) => {
    const rows = Array.from({ length: COUNT }, (_, i) => i);
    const answer = await post(base, id, { report, kind: 'sync', rows });
    assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
    assert.deepEqual([made(answer).selected, made(answer).total], [COUNT, COUNT]);
    assert.match(made(answer).text, /pBulk08999/);
  });
});
