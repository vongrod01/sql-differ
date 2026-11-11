// Runs Compare-Database.ps1 the way the web app does (Windows PowerShell 5.1, no profile).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_SERVER, mustRunScriptFile, recreateDatabase } from './sql.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENGINE = path.join(ROOT, 'Compare-Database.ps1');
export const OUT = path.join(ROOT, 'test', '.out');

// Creates the source and the target database of test/fixtures/<fixture>: common.sql runs on both,
// then source.sql / target.sql on its side.
export function buildFixture(fixture: string, source: string, target: string): void {
  recreateDatabase(source);
  recreateDatabase(target);
  const steps: [string, string[]][] = [['common.sql', [source, target]], ['source.sql', [source]], ['target.sql', [target]]];
  for (const [file, databases] of steps) {
    const script = path.join(ROOT, 'test', 'fixtures', fixture, file);
    if (!existsSync(script)) continue;
    for (const database of databases) mustRunScriptFile(script, database);
  }
}

export interface EngineRun {
  exitCode: number | null;
  stdout: string;
  // stdout and stderr together, for failure messages.
  log: string;
}

// Environment for the Windows PowerShell 5.1 child processes the tests start, built like the web
// app's (app/lib/powershell.js): no PSModulePath, which a PowerShell 7 parent fills with its own
// module folders and Windows PowerShell must not load from.
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_DIFF_UTF8: '1' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

export function runEngine(args: string[]): EngineRun {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ENGINE, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env: childEnv(),
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
  target?: string;
  targetSnapshot?: string;
  options?: string[];
  // Value of -Categories. Default: All.
  categories?: string;
}

// One single-database comparison on the test server with saved snapshots; every category unless
// `categories` says otherwise.
export function compare(o: CompareOptions): Comparison {
  const dir = path.join(OUT, o.dir);
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, o.name);
  const sourceArgs = o.sourceSnapshot ? ['-SourceSnapshot', o.sourceSnapshot] : ['-SourceDatabase', o.source ?? ''];
  const targetArgs = o.targetSnapshot ? ['-TargetSnapshot', o.targetSnapshot] : ['-TargetDatabase', o.target ?? ''];
  const files = {
    html: `${base}.html`,
    json: `${base}.json`,
    sync: `${base}.sync.sql`,
    rollback: `${base}.rollback.sql`,
    sourceSnapshot: `${base}.source.snapshot.json`,
    targetSnapshot: `${base}.target.snapshot.json`,
  };
  // What an earlier run left here must not stand in for the output of a run that failed (seen
  // 2026-11-11: an engine run that wrote nothing passed on the files of the run before it, and
  // those went into the golden files).
  for (const file of Object.values(files)) {
    if (file !== o.sourceSnapshot && file !== o.targetSnapshot) rmSync(file, { force: true });
  }
  const run = runEngine([
    '-SourceServer', TEST_SERVER, ...sourceArgs, ...targetArgs,
    '-Categories', o.categories ?? 'All', '-SaveSnapshots', '-OutputPath', `${base}.html`, ...(o.options ?? []),
  ]);
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
