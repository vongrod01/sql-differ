// Runs Compare-Database.ps1 the way the web app does (Windows PowerShell 5.1, no profile).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_SERVER } from './sql.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENGINE = path.join(ROOT, 'Compare-Database.ps1');
export const OUT = path.join(ROOT, 'test', '.out');

export interface EngineRun {
  exitCode: number | null;
  stdout: string;
  // stdout and stderr together, for failure messages.
  log: string;
}

export function runEngine(args: string[]): EngineRun {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ENGINE, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env: { ...process.env, DATABASE_DIFF_UTF8: '1' },
  });
  const stdout = run.stdout ?? '';
  return { exitCode: run.status, stdout, log: `${stdout}${run.stderr ?? ''}${run.error ? String(run.error) : ''}` };
}

export interface Comparison extends EngineRun {
  // The parsed <name>.json result.
  result: Record<string, unknown>;
  files: {
    html: string;
    json: string;
    sync: string;
    rollback: string;
    sourceSnapshot: string;
    targetSnapshot: string;
  };
}

export interface CompareOptions {
  // Output folder under test/.out and base name of the files.
  dir: string;
  name: string;
  source?: string;
  sourceSnapshot?: string;
  target: string;
  options?: string[];
}

// One single-database comparison on the test server with every category and saved snapshots.
export function compare(o: CompareOptions): Comparison {
  const dir = path.join(OUT, o.dir);
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, o.name);
  const sourceArgs = o.sourceSnapshot ? ['-SourceSnapshot', o.sourceSnapshot] : ['-SourceDatabase', o.source ?? ''];
  const run = runEngine([
    '-SourceServer', TEST_SERVER, ...sourceArgs, '-TargetDatabase', o.target,
    '-Categories', 'All', '-SaveSnapshots', '-OutputPath', `${base}.html`, ...(o.options ?? []),
  ]);
  const files = {
    html: `${base}.html`,
    json: `${base}.json`,
    sync: `${base}.sync.sql`,
    rollback: `${base}.rollback.sql`,
    sourceSnapshot: `${base}.source.snapshot.json`,
    targetSnapshot: `${base}.target.snapshot.json`,
  };
  if (!existsSync(files.json)) throw new Error(`engine wrote no result (exit ${run.exitCode}):\n${run.log}`);
  return { ...run, result: JSON.parse(readFileSync(files.json, 'utf8')) as Record<string, unknown>, files };
}

export interface Counts {
  onlyInSource: number;
  onlyInTarget: number;
  different: number;
  unverified: number;
}

export function counts(c: Comparison): Counts {
  return c.result['counts'] as Counts;
}
