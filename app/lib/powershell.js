'use strict';

const { spawn } = require('child_process');

// Environment of the child: this process's, without PSModulePath. Started from PowerShell 7 (a
// pwsh terminal, or a tool that runs in one), this process carries PowerShell 7's module folders
// there; Windows PowerShell 5.1 would load PowerShell 7's Microsoft.PowerShell.Security from them
// and ConvertTo-SecureString fails, so no stored password could be read. Without the variable
// powershell.exe builds its own module path. Windows variable names ignore case.
function childEnv(extra) {
  const env = { ...process.env, DATABASE_DIFF_UTF8: '1', ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

// Runs Windows PowerShell 5.1 without a profile. `onLine` receives stdout/stderr line by line.
function runPowerShell(args, { input, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
      env: childEnv(env),
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
