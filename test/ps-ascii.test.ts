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

// Files with the given extension under dir; folders named in `skip` (paths relative to the
// repository root, with forward slashes) are left out.
function sourceFiles(dir: string, extension: string, skip: string[] = []): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(path.relative(ROOT, full).replace(/\\/g, '/'))) return [];
      return sourceFiles(full, extension, skip);
    }
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

// A byte order mark, a line separator or a paragraph separator typed into a source file cannot be
// seen in an editor or a diff, and each means something: a BOM inside a regular expression literal
// is the character it matches, and U+2028 / U+2029 end a line in JavaScript. They are written as
// escapes instead. Built from code points here, so this file holds none of them itself.
test('JavaScript and TypeScript sources hold no invisible BOM or line separator characters', () => {
  const invisible = [0xfeff, 0x2028, 0x2029].map((code) => String.fromCharCode(code));
  const files = [
    ...sourceFiles(path.join(ROOT, 'app'), '.js'),
    ...sourceFiles(path.join(ROOT, 'test'), '.ts', ['test/golden', 'test/.out']),
    ...sourceFiles(path.join(ROOT, 'scripts'), '.ts'),
  ];
  assert.ok(files.length >= 20, `expected the app, test and script sources, found ${files.length}`);
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const character of invisible) {
      const at = text.indexOf(character);
      if (at !== -1) found.push(`${path.relative(ROOT, file)}: U+${character.charCodeAt(0).toString(16).toUpperCase()} at offset ${at}`);
    }
  }
  assert.deepEqual(found, []);
});
