'use strict';

const { spawn } = require('child_process');

// Runs Windows PowerShell 5.1 without a profile. `onLine` receives stdout/stderr line by line.
function runPowerShell(args, { input, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
      env: { ...process.env, DATABASE_DIFF_UTF8: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    let pending = '';

    const emit = (chunk) => {
      if (!onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLine(line);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; emit(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; emit(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (onLine && pending) onLine(pending);
      resolve({ code, stdout, stderr, pid: child.pid });
    });

    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

module.exports = { runPowerShell };
