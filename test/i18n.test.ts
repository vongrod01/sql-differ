import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ROOT } from './support/engine.js';

const script = readFileSync(path.join(ROOT, 'app/public/i18n.js'), 'utf8');

function languageContext(saved = '', blocked = false): vm.Context {
  const storage = new Map([['database-diff.language', saved]]);
  const context = vm.createContext({
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error('blocked'); return storage.get(key); },
      setItem: (key: string, value: string) => { if (blocked) throw new Error('blocked'); storage.set(key, value); },
    },
  });
  vm.runInContext(script + '\nconst i18n = DatabaseDiffI18n; const t = i18n.t;', context);
  return context;
}

test('language: Thai default, English preference persists, unsupported values are ignored', () => {
  const context = languageContext();
  assert.equal(vm.runInContext("t('เปรียบเทียบ schema')", context), 'เปรียบเทียบ schema');
  vm.runInContext("i18n.setLanguage('en')", context);
  assert.equal(vm.runInContext("t('เปรียบเทียบ schema')", context), 'Compare schemas');
  assert.equal(vm.runInContext("localStorage.getItem('database-diff.language')", context), 'en');
  vm.runInContext("i18n.setLanguage('fr')", context);
  assert.equal(vm.runInContext('i18n.language', context), 'en');
  vm.runInContext("i18n.setLanguage('th')", context);
  assert.equal(vm.runInContext("t('รีเซต')", context), 'รีเซต');
  assert.equal(vm.runInContext('i18n.language', languageContext('en')), 'en');
  assert.equal(vm.runInContext('i18n.language', languageContext('fr')), 'th');
});

test('language: storage restrictions do not prevent switching', () => {
  const context = languageContext('', true);
  vm.runInContext("i18n.setLanguage('en')", context);
  assert.equal(vm.runInContext("t('เริ่มเปรียบเทียบ')", context), 'Start comparison');
});

test('language: HTML, spacing and interpolated names or SQL are preserved', () => {
  const context = languageContext('en');
  const actual = vm.runInContext('t`<h1>เปรียบเทียบ schema</h1> ${"รีเซต"}<button title="บันทึก">บันทึก</button>`', context);
  assert.equal(actual, '<h1>Compare schemas</h1> รีเซต<button title="Save">Save</button>');
  assert.equal(vm.runInContext('t`รายงาน ${"SELECT [ชื่อ] FROM [ประวัติ]"}`', context), 'Report SELECT [ชื่อ] FROM [ประวัติ]');
  assert.equal(vm.runInContext("t('  กำลังโหลด...  ')", context), '  Loading...  ');
});
