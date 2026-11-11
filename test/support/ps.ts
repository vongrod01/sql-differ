// Calls single functions of the PowerShell engine (Compare-Database.ps1 and lib/SyncScript.ps1)
// through Invoke-EngineFunction.ps1, without a database.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, ROOT, childEnv } from './engine.js';

const HARNESS = path.join(ROOT, 'test', 'support', 'Invoke-EngineFunction.ps1');

export type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface CallOptions {
  // Script-level engine variables, such as the switches of Compare-Database.ps1: { IgnoreCase: true }.
  variables?: Record<string, unknown>;
  // PowerShell text that runs after the engine is loaded: stubs for functions that need a server,
  // wrappers that call the function under test with values built in PowerShell.
  setup?: string;
}

let sequence = 0;

// One PowerShell process for all cases; each case is the positional argument list of one call.
// Objects reach the function as Dictionary[string, object], like a snapshot loaded from a file.
// A function that returns a one-element array yields the element, and an empty one yields null.
export function callEngineFunction(name: string, cases: unknown[][], options: CallOptions = {}): CallResult[] {
  const dir = path.join(OUT, 'functions');
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${name}-${process.pid}-${++sequence}`);
  const casesFile = `${base}.cases.json`;
  const resultFile = `${base}.result.json`;
  rmSync(resultFile, { force: true });
  writeFileSync(casesFile, JSON.stringify({ function: name, variables: options.variables ?? {}, setup: options.setup ?? '', cases }), 'utf8');

  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-CasesPath', casesFile, '-ResultPath', resultFile,
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: childEnv() });
  if (run.status !== 0) {
    throw new Error(`Invoke-EngineFunction.ps1 failed for ${name} (exit ${run.status}):\n${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`);
  }
  const results = JSON.parse(readFileSync(resultFile, 'utf8')) as CallResult[];
  if (results.length !== cases.length) throw new Error(`${name}: ${cases.length} cases sent, ${results.length} results returned`);
  return results;
}

// The values of calls that must all succeed.
export function engineValues(name: string, cases: unknown[][], options: CallOptions = {}): unknown[] {
  return callEngineFunction(name, cases, options).map((r, i) => {
    if (!r.ok) throw new Error(`${name} case ${i} failed: ${r.error}`);
    return r.value;
  });
}
