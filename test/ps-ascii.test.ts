// Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so a non-ASCII character in the
// engine changes meaning silently (it once disabled the </script> escaping). Keep them ASCII.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './support/engine.js';

function powershellFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'reports') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return powershellFiles(full);
    return entry.name.endsWith('.ps1') ? [full] : [];
  });
}

test('PowerShell sources are pure ASCII', () => {
  const files = powershellFiles(ROOT);
  assert.ok(files.length >= 3, `expected the engine scripts, found ${files.length}`);
  for (const file of files) {
    const bytes = readFileSync(file);
    const at = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d));
    assert.equal(at, -1, `${path.relative(ROOT, file)} has a non-ASCII byte at offset ${at}`);
  }
});
