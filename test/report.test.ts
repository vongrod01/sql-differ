// The HTML report (templates/report.html) and the index of a batch (templates/index.html). The
// part of their script that does not touch the page (the words, the reading of the engine's detail
// text, the grouping by table, the line diff) is run here without a browser: the script of a page
// is taken out of the HTML and run in a context that has no document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ENGINE, OUT, ROOT, buildFixture, compare, runEngine, type Comparison } from './support/engine.js';
import { DB_PREFIX, TEST_SERVER, skipWithoutServer } from './support/sql.js';

interface Row {
  id: number;
  cat: string;
  obj: string;
  status: string;
  detail: string;
  a: string | null;
  b: string | null;
  group: { kind: string; key: string } | null;
}

interface Parsed {
  code: boolean;
  changes: { key: string; label: string; from: string; to: string }[];
  facts: { key: string; label: string; value: string }[];
  notes: { key: string; side: string; text: string }[];
  raw: string[];
}

interface Group {
  kind: string;
  cat: string;
  key: string;
  name: string;
  self: Row | null;
  items: Row[];
}

interface Core {
  TIMELINE: boolean;
  KIND: Record<string, { cls: string; sym: string; t: string; d: string }>;
  HIDDEN_DEFINITION: string;
  propLabel(category: string, key: string): string;
  val(key: string, value: string): string;
  toRows(data: unknown[][]): Row[];
  parseDetail(row: Row): Parsed;
  leafOf(row: Row): { name: string; kind: string; pk: boolean };
  sentence(row: Row, parsed: Parsed, ctx?: { self: Row | null }): string;
  setOptionsHint(parsed: Parsed): string[];
  shownFacts(row: Row, parsed: Parsed): Parsed['facts'];
  groupRows(rows: Row[], order: string[]): { tables: Group[]; others: Group[] };
  groupStatus(group: Group): { cls: string; sym: string; text: string };
  lineKey(line: string): string;
  diffLines(a: string[], b: string[]): [string, string][];
  renderDiff(row: Row): string;
  renderPlain(row: Row): string;
}

interface Meta {
  source: string;
  target: string;
  generated: string;
  perspective: string;
  categories: string[];
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
  ignoreCollation: boolean;
  compareColumnOrder: boolean;
  warnings: string[];
  noViewDefinition: [string, string][];
  summary: unknown[][];
}

interface ReportScript {
  META: Meta;
  DATA: unknown[][];
  createReportCore(meta: Partial<Meta>): Core;
}

const ALL_CATEGORIES = [
  'Database', 'Schema', 'Table', 'Column', 'Index', 'Foreign key', 'Check constraint',
  'View', 'Stored procedure', 'Function', 'Trigger', 'User-defined type', 'Sequence', 'Synonym',
];

// Runs the one script of a page and returns the value of `expression` in it. The context has no
// document, so the script only defines its functions.
function runScript<T>(html: string, expression: string): T {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'a page has one script element');
  return vm.runInContext(`${scripts[0]?.[1] ?? ''}\n;(${expression})`, vm.createContext({})) as T;
}

// Values made inside the script's context have that context's prototypes: copied here so that
// they compare with the ones written in a test.
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// The replacement character: what a decoder writes for bytes it cannot read.
const LOST_CHARACTER = String.fromCharCode(0xfffd);

// From the first Thai letter to the last Thai sign.
const hasThai = (text: string): boolean => /[ก-๛]/.test(text);

// A report is opened offline: it must load nothing from outside itself. Its one link is an empty
// icon (so that a browser does not ask the web app for one), which is taken out before looking.
// What the engine fills in is data (a definition may well hold a URL), so a generated page is
// looked at up to its script; the script itself is the template's, checked as a file below.
function loadsNothing(html: string, { template = false } = {}): void {
  const script = html.indexOf('<script>');
  assert.ok(script > 0);
  const page = (template ? html : html.slice(0, script)).replace('<link rel="icon" href="data:,">', '');
  // The only url() is an SVG that is written out in the page itself (the backdrop, checked below).
  assert.doesNotMatch(page, /<link|<script src|@import|url\((?!"data:image\/svg\+xml,)|https?:\/\/|fonts\.|cdn/i);
}

test('report: the templates are Thai pages that load nothing from outside', () => {
  for (const name of ['report.html', 'index.html']) {
    const template = readFileSync(path.join(ROOT, 'templates', name), 'utf8');
    assert.match(template, /<html lang="th">/, name);
    assert.match(template, /<meta charset="utf-8">/, name);
    // The whole file, script included.
    loadsNothing(template, { template: true });
    // System fonts only, as palm asked: a Thai face first, and a code face for definitions.
    assert.match(template, /--font-body: "Leelawadee UI", "Segoe UI", Tahoma, sans-serif;/, name);
    assert.match(template, /--font-code: Consolas, "Cascadia Mono", /, name);
    // Text is never set smaller than 14px.
    const sizes = [...template.matchAll(/font(?:-size)?:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 5 && Math.min(...sizes) >= 14, `${name}: ${sizes.join(', ')}`);
  }
});

// The dark backdrop is a circuit layer and a code layer, two SVG images written out inside the CSS
// (data, not files), so a report is still one file that opens offline. They are drawn once and do not
// move. The web app's stylesheet carries the same two layers and is held to the same rule.
test('report: the circuit and the code backdrop are inline images that load nothing from outside', () => {
  for (const file of [['templates', 'report.html'], ['templates', 'index.html'], ['app', 'public', 'app.css']]) {
    const name = file.join('/');
    const css = readFileSync(path.join(ROOT, ...file), 'utf8');
    assert.equal(css.match(/url\("data:image\/svg\+xml,/g)?.length, 2, `${name}: one circuit and one code image`);
    assert.doesNotMatch(css, /url\((?!"data:image\/svg\+xml,)/, name);
    assert.doesNotMatch(css, /@import|https?:\/\/|fonts\./i, name);
    assert.match(css, /body::after, html::after \{[^}]*content: ""/, `${name}: the two layers`);
    // Not printed, and gone for a person who asked for more contrast.
    assert.match(css, /@media print, \(prefers-contrast: more\), \(forced-colors: active\) \{\s*body::after, html::after \{ display: none; \}/, name);
  }
});

// The report script as the template has it, with the engine's two values filled in by hand.
function templateScript(meta: Partial<Meta> = {}, data: unknown[][] = []): ReportScript {
  const template = readFileSync(path.join(ROOT, 'templates', 'report.html'), 'utf8');
  const full = { source: 'srv / a', target: 'srv / b', generated: '2026-01-01 00:00:00', perspective: 'sync', categories: ALL_CATEGORIES, warnings: [], noViewDefinition: [], summary: [], ...meta };
  const html = template.replace('__META_JSON__', () => JSON.stringify(full)).replace('__DATA_JSON__', () => JSON.stringify(data));
  return runScript<ReportScript>(html, '{ META, DATA, createReportCore }');
}

function coreFor(meta: Partial<Meta> = {}): Core {
  const script = templateScript(meta);
  return script.createReportCore(script.META);
}

const sync = coreFor();
const drift = coreFor({ perspective: 'timeline' });

// One row as the engine writes it: category, object, status, detail, definitions, group.
function row(core: Core, cat: string, obj: string, status: string, detail = '', group: [string, string] | null = null, a: string | null = null, b: string | null = null): Row {
  const made = core.toRows([[cat, obj, status, detail, a, b, group]])[0];
  assert.ok(made);
  return made;
}

// ---------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------

test('report: the four kinds say what happens to the target, and a drift report uses time words', () => {
  const words = (core: Core) => Object.fromEntries(Object.entries(plain(core.KIND)).map(([status, k]) => [status, `${k.cls} ${k.sym} ${k.t}`]));
  assert.deepEqual(words(sync), {
    OnlyInSource: 'add + ต้องเพิ่ม',
    OnlyInTarget: 'del − มีเกิน',
    Different: 'chg ~ ต้องแก้',
    Unverified: 'unk ? ตรวจไม่ได้',
  });
  // A sync never deletes: the card of what is extra says so. And it does not create or change
  // everything: both cards say that some of it is written as a comment to run by hand.
  assert.match(sync.KIND['OnlyInSource']?.d ?? '', /sync จะสร้างให้ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง$/);
  assert.match(sync.KIND['Different']?.d ?? '', /sync จะแก้ปลายทางให้ตรงต้นแบบ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง$/);
  assert.match(sync.KIND['OnlyInTarget']?.d ?? '', /sync ไม่ลบให้/);
  // Drift reads from the older side to the later one: the colours flip with the words.
  assert.deepEqual(words(drift), {
    OnlyInSource: 'del − หายไป',
    OnlyInTarget: 'add + เพิ่มขึ้นมา',
    Different: 'chg ~ ถูกแก้',
    Unverified: 'unk ? ตรวจไม่ได้',
  });
  for (const k of Object.values(drift.KIND)) assert.doesNotMatch(k.d, /sync/);
});

test('report: values are worded plainly, and what the engine calls "(none)" depends on the property', () => {
  assert.equal(sync.val('Nullable', 'NULL'), 'ได้ (NULL)');
  assert.equal(sync.val('Nullable', 'NOT NULL'), 'ไม่ได้ (NOT NULL)');
  assert.equal(sync.val('State', 'DISABLED'), 'ปิดอยู่');
  assert.equal(sync.val('Default', '(none)'), 'ไม่มี');
  // No SET option that is OFF: the normal setting.
  assert.equal(sync.val('SetOptions', '(none)'), 'ปกติ (ON)');
  assert.equal(sync.val('SetOptions', 'QUOTED_IDENTIFIER OFF'), 'QUOTED_IDENTIFIER OFF');
  assert.equal(sync.val('Persisted', '(none)'), 'ไม่เก็บ');
  assert.equal(sync.val('OnDelete', 'SET_NULL'), 'ใส่ NULL (SET NULL)');
  assert.equal(sync.val('OnUpdate', 'CASCADE'), 'ทำตามแถวแม่ (CASCADE)');
  assert.equal(sync.val('Type', '(not readable)'), 'อ่านไม่ได้');
  // Anything else is shown as it is, also a value that looks like a property of the page.
  assert.equal(sync.val('Default', '((0))'), '((0))');
  assert.equal(sync.val('Name', 'constructor'), 'constructor');
  // The same property name means another thing in another category.
  assert.equal(sync.propLabel('Column', 'Type'), 'ชนิดข้อมูล');
  assert.equal(sync.propLabel('Index', 'Type'), 'แบบ index');
  assert.equal(sync.propLabel('Stored procedure', 'Type'), 'ประเภท object');
  assert.equal(sync.propLabel('Column', 'NotKnownYet'), 'NotKnownYet');
});

// ---------------------------------------------------------------------------------------------
// The detail text of the engine
// ---------------------------------------------------------------------------------------------

test('report: a difference reads from what is there now to what it becomes', () => {
  const detail = 'Nullable: source NULL, target NOT NULL\nDefault: source ((0)), target (none)';
  const column = (core: Core) => plain(core.parseDetail(row(core, 'Column', 'dbo.T.C', 'Different', detail, ['table', 'dbo.T'])));
  // Sync: the target's value is struck through, the model's is what it becomes.
  assert.deepEqual(column(sync).changes, [
    { key: 'Nullable', label: 'ยอมให้ว่าง (NULL)', from: 'ไม่ได้ (NOT NULL)', to: 'ได้ (NULL)' },
    { key: 'Default', label: 'ค่าเริ่มต้น', from: 'ไม่มี', to: '((0))' },
  ]);
  // Drift: from the older side (source) to the later one (target).
  assert.deepEqual(column(drift).changes.map((c) => `${c.from} -> ${c.to}`), ['ได้ (NULL) -> ไม่ได้ (NOT NULL)', '((0)) -> ไม่มี']);

  // A module: the definition line means "there is code to look at", the rest are properties.
  const module = plain(sync.parseDetail(row(sync, 'Trigger', 'dbo.tr', 'Different', 'Definition differs\nState: source ENABLED, target DISABLED')));
  assert.equal(module.code, true);
  assert.deepEqual(module.changes, [{ key: 'State', label: 'สถานะ', from: 'ปิดอยู่', to: 'เปิดใช้' }]);

  // A list of column names holds ", " itself.
  const index = plain(sync.parseDetail(row(sync, 'Index', 'dbo.v.IX', 'Different', 'Columns: source Cnt, target Cnt, Region', ['view', 'dbo.v'])));
  assert.deepEqual(index.changes, [{ key: 'Columns', label: 'คอลัมน์', from: 'Cnt, Region', to: 'Cnt' }]);

  // A value that could not be read on one side is said, not shown as a change.
  const hidden = plain(sync.parseDetail(row(sync, 'Column', 'dbo.T.C', 'Different', 'Nullable: source NULL, target NOT NULL\nType: not readable on target (not compared)')));
  assert.equal(hidden.changes.length, 1);
  assert.deepEqual(hidden.notes, [{ key: 'Type', side: 'target', text: 'ชนิดข้อมูล: อ่านไม่ได้ในฝั่งปลายทาง จึงไม่ได้เทียบส่วนนี้' }]);
  const unverified = plain(drift.parseDetail(row(drift, 'View', 'dbo.v', 'Unverified', 'Definition: not readable on either side')));
  assert.deepEqual(unverified.notes, [{ key: 'Definition', side: 'either side', text: 'โค้ด: อ่านไม่ได้ในทั้งสองจุด' }]);
  assert.deepEqual([unverified.code, unverified.changes, unverified.raw], [false, [], []]);
});

test('report: a detail line that cannot be split with certainty is shown as the engine wrote it', () => {
  // A value with a line break in it stays one value.
  const multi = plain(sync.parseDetail(row(sync, 'Column', 'dbo.T.C', 'Different', "Default: source ('a\nb'), target (none)\nNullable: source NULL, target NOT NULL")));
  assert.deepEqual(multi.changes.map((c) => [c.key, c.from, c.to]), [['Default', 'ไม่มี', "('a\nb')"], ['Nullable', 'ไม่ได้ (NOT NULL)', 'ได้ (NULL)']]);
  assert.deepEqual(multi.raw, []);
  // ", target " inside a value: which part belongs to which side is not known. No guess.
  const text = "Expression: source ([k]='x, target y'), target ([k]='z')";
  const ambiguous = plain(sync.parseDetail(row(sync, 'Check constraint', 'dbo.T.CK', 'Different', `${text}\nState: source ENABLED, target DISABLED`)));
  assert.deepEqual(ambiguous.raw, [text]);
  assert.deepEqual(ambiguous.changes.map((c) => c.key), ['State']);
  // Something the page does not know at all.
  assert.deepEqual(plain(sync.parseDetail(row(sync, 'Column', 'dbo.T.C', 'Different', 'something new'))).raw, ['something new']);
});

test('report: the properties of an object on one side only become facts', () => {
  const facts = (cat: string, detail: string) => plain(sync.parseDetail(row(sync, cat, 'x', 'OnlyInSource', detail))).facts.map((f) => `${f.key}=${f.value}`);
  assert.deepEqual(facts('Index', 'Kind: UNIQUE INDEX; Type: CLUSTERED; Columns: Region, Id DESC'), ['Kind=UNIQUE INDEX', 'Type=CLUSTERED', 'Columns=Region, Id DESC']);
  assert.deepEqual(facts('Column', 'Type: varchar(20); Nullable: NOT NULL; Default: (\'a; b\'); Collation: Thai_CI_AS'), [
    'Type=varchar(20)', 'Nullable=ไม่ได้ (NOT NULL)', "Default=('a; b')", 'Collation=Thai_CI_AS',
  ]);
  // The details of a table type are a list with "; " in it: one fact, not three.
  assert.deepEqual(facts('User-defined type', 'Kind: table type; Spec: (Id int NOT NULL); Details: Id IDENTITY(1,1); PRIMARY KEY CLUSTERED (Id); Collation: Code Thai_CI_AS; Note Thai_BIN'), [
    'Kind=type แบบตาราง', 'Spec=(Id int NOT NULL)', 'Details=Id IDENTITY(1,1); PRIMARY KEY CLUSTERED (Id)', 'Collation=Code Thai_CI_AS; Note Thai_BIN',
  ]);
  assert.deepEqual(facts('Sequence', 'DataType: decimal; Precision: 28; Start: 1; Increment: 1; Min: 1; Max: 9; Cycle: NO CYCLE; Cache: NO CACHE'), [
    'DataType=decimal', 'Precision=28', 'Start=1', 'Increment=1', 'Min=1', 'Max=9', 'Cycle=ไม่วน (NO CYCLE)', 'Cache=ไม่ใช้ (NO CACHE)',
  ]);
  assert.deepEqual(facts('Schema', ''), []);

  // What is shown of a module: not its object type, nor the table of a trigger (the card says it).
  const trigger = row(sync, 'Trigger', 'dbo.tr', 'OnlyInTarget', 'Type: SQL_TRIGGER; Table: dbo.Orders; State: DISABLED; SetOptions: QUOTED_IDENTIFIER OFF', ['table', 'dbo.Orders']);
  assert.deepEqual(plain(sync.shownFacts(trigger, sync.parseDetail(trigger))).map((f) => `${f.label}=${f.value}`), ['สถานะ=ปิดอยู่', 'ค่า SET ตอนสร้าง=QUOTED_IDENTIFIER OFF']);
  const column = row(sync, 'Column', 'dbo.T.C', 'OnlyInSource', 'Type: int; Nullable: NULL', ['table', 'dbo.T']);
  assert.equal(sync.shownFacts(column, sync.parseDetail(column)).length, 2);
});

test('report: a row whose only difference is the SET options says what that means', () => {
  // The case palm asked about: QUOTED_IDENTIFIER OFF in the source, nothing in the target.
  const only = sync.parseDetail(row(sync, 'Stored procedure', 'dbo.p', 'Different', 'SetOptions: source QUOTED_IDENTIFIER OFF, target (none)'));
  assert.deepEqual(plain(only.changes), [{ key: 'SetOptions', label: 'ค่า SET ตอนสร้าง', from: 'ปกติ (ON)', to: 'QUOTED_IDENTIFIER OFF' }]);
  const hint = plain(sync.setOptionsHint(only));
  assert.equal(hint.length, 2, hint.join('\n'));
  // The code is the same; "(none)" is the normal setting, ON.
  assert.match(hint[0] ?? '', /โค้ดเหมือนกัน/);
  assert.match(hint[0] ?? '', /"ปกติ" คือ ON/);
  // What OFF means, what it stops, and where it usually comes from.
  for (const said of ['QUOTED_IDENTIFIER OFF', '"..."', 'filtered index', 'indexed view', 'sqlcmd', '-I']) assert.ok((hint[1] ?? '').includes(said), `${said} in: ${hint[1]}`);
  for (const line of hint) assert.ok(line.length <= 200, line);

  const ansi = plain(sync.setOptionsHint(sync.parseDetail(row(sync, 'View', 'dbo.v', 'Different', 'SetOptions: source (none), target ANSI_NULLS OFF'))));
  assert.equal(ansi.length, 2);
  assert.match(ansi[1] ?? '', /^ANSI_NULLS OFF/);
  assert.doesNotMatch(ansi[1] ?? '', /QUOTED_IDENTIFIER/);
  const both = plain(sync.setOptionsHint(sync.parseDetail(row(sync, 'View', 'dbo.v', 'Different', 'SetOptions: source ANSI_NULLS OFF, QUOTED_IDENTIFIER OFF, target (none)'))));
  assert.equal(both.length, 2);
  assert.match(both[1] ?? '', /QUOTED_IDENTIFIER OFF.*ANSI_NULLS OFF/);

  // Not when something else differs too, or when the code could not be read.
  for (const detail of [
    'Definition differs\nSetOptions: source QUOTED_IDENTIFIER OFF, target (none)',
    'State: source ENABLED, target DISABLED\nSetOptions: source QUOTED_IDENTIFIER OFF, target (none)',
    'SetOptions: source QUOTED_IDENTIFIER OFF, target (none)\nDefinition: not readable on target (not compared)',
    'State: source ENABLED, target DISABLED',
  ]) assert.deepEqual(plain(sync.setOptionsHint(sync.parseDetail(row(sync, 'Trigger', 'dbo.tr', 'Different', detail)))), [], detail);
});

test('report: each row says in one line what the sync script does with it', () => {
  const say = (cat: string, obj: string, status: string, detail = '', group: [string, string] | null = null, self: Row | null = null, core = sync): string => {
    const r = row(core, cat, obj, status, detail, group);
    return core.sentence(r, core.parseDetail(r), { self });
  };
  const T: [string, string] = ['table', 'dbo.T'];

  assert.equal(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: int', T), 'ปลายทางยังไม่มีคอลัมน์นี้ sync จะสร้างให้');
  assert.equal(say('Index', 'dbo.T.IX', 'OnlyInSource', 'Kind: INDEX', T), 'ปลายทางยังไม่มี index นี้ sync จะสร้างให้');
  assert.match(say('Column', 'dbo.T.C', 'OnlyInTarget', 'Type: int', T), /^มีแค่ในปลายทาง sync ไม่ลบให้/);
  assert.match(say('View', 'dbo.v', 'Unverified', 'Definition: not readable on target'), /ไม่เขียนคำสั่งให้/);
  // A new table comes with what the script creates with it.
  assert.match(say('Table', 'dbo.T', 'OnlyInSource', '', T), /สร้างทั้งตาราง.*รวมทั้ง index, check และ foreign key/);
  const fewer = coreFor({ categories: ['Table', 'Column', 'View'] });
  assert.match(say('Table', 'dbo.T', 'OnlyInSource', '', T, null, fewer), /ไม่รวม index, check constraint, foreign key/);

  // Different: what can be changed by a statement, and what the script leaves to do by hand.
  // A type, NULL / NOT NULL or collation is changed with ALTER COLUMN, which the script writes
  // as a comment when the column is computed or a computed column uses it. The row does not
  // say whether that is so (it has only what differs), so the sentence says it.
  const ALTERED = 'sync จะแก้ปลายทางจากค่าที่ขีดฆ่าเป็นค่าใหม่';
  const UNLESS_COMPUTED = ' (ถ้าเป็นคอลัมน์คำนวณ หรือมีคอลัมน์คำนวณใช้คอลัมน์นี้ sync จะเขียนเป็นหมายเหตุให้ทำเองแทน)';
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Type: source bigint, target int', T), ALTERED + UNLESS_COMPUTED);
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Nullable: source NOT NULL, target NULL', T), ALTERED + UNLESS_COMPUTED);
  // A collation alone is not changed on a column of a user-defined type either.
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Collation: source Thai_CI_AS, target Thai_BIN', T),
    ALTERED + ' (ถ้าเป็นคอลัมน์คำนวณ หรือมีคอลัมน์คำนวณใช้คอลัมน์นี้ หรือเป็นคอลัมน์ของ type ที่สร้างเอง sync จะเขียนเป็นหมายเหตุให้ทำเองแทน)');
  // A default, or PERSISTED, is changed without ALTER COLUMN of the type: always a statement.
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Default: source ((1)), target ((0))', T), ALTERED);
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Persisted: source PERSISTED, target (none)', T), ALTERED);
  // PERSISTED among the differences says the column is computed: the rest of it is a comment.
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Nullable: source NOT NULL, target NULL\nPersisted: source PERSISTED, target (none)', T),
    'เป็นคอลัมน์คำนวณ: sync จะแก้ให้เฉพาะการเก็บค่า (PERSISTED) ส่วนชนิดข้อมูล, NULL และ collation แก้ด้วยคำสั่งไม่ได้ sync เขียนเป็นหมายเหตุให้ทำเอง');
  // A type change needs the default dropped first, and a default nobody could read is not dropped.
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Type: source bigint, target int\nDefault: not readable on target (not compared)', T),
    'จะเปลี่ยนชนิดข้อมูลต้องลบค่าเริ่มต้นก่อน แต่ค่าเริ่มต้นของปลายทางอ่านไม่ได้ sync จึงเขียนเป็นหมายเหตุให้ทำเอง');
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Type: source bigint, target int\nDefault: not readable on source (not compared)', T), /หรือปลายทางมีค่าเริ่มต้นอยู่ sync จะเขียนเป็นหมายเหตุให้ทำเองแทน\)$/);
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Identity: source IDENTITY(1,1), target (none)', T), /เป็นหมายเหตุให้ทำเอง/);
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Computed: source ([a]+(1)), target ([a]+(2))', T), /เป็นหมายเหตุให้ทำเอง/);
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Ordinal: source 2, target 3', T), /sync ไม่ย้ายให้/);
  // The type is changed, the place of the column is not.
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Default: source ((1)), target ((0))\nOrdinal: source 2, target 3', T), /^sync จะแก้ปลายทางจากค่าที่ขีดฆ่าเป็นค่าใหม่ ยกเว้นลำดับคอลัมน์ ซึ่ง sync ไม่ย้ายให้$/);
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Type: source bigint, target int\nOrdinal: source 2, target 3', T), /^sync จะแก้ปลายทางจากค่าที่ขีดฆ่าเป็นค่าใหม่ ยกเว้นลำดับคอลัมน์/);
  // No line could be read as from -> to, so nothing is struck through: the sentence does not say so.
  assert.equal(say('Column', 'dbo.T.C', 'Different', "Default: source (N'x, target y'), target (N'z')", T), 'sync จะแก้ปลายทางให้ตรงต้นแบบ');
  // A module that is only in the source, with a text nobody can read: nothing to create it from.
  const encrypted = row(sync, 'Stored procedure', 'dbo.p', 'OnlyInSource', 'Type: SQL_STORED_PROCEDURE', null, sync.HIDDEN_DEFINITION, null);
  assert.match(sync.sentence(encrypted, sync.parseDetail(encrypted), { self: null }), /โค้ดของต้นแบบอ่านไม่ได้ sync จึงสร้างให้ไม่ได้/);
  // The page knows that text by the words the engine writes for it.
  assert.ok(readFileSync(ENGINE, 'utf8').includes(`$HiddenDefinition = '${sync.HIDDEN_DEFINITION}'`), 'the engine and the report agree on the text of a hidden definition');
  assert.match(say('Index', 'dbo.T (primary key)', 'Different', 'Columns: source Id, target Code', T), /primary key ต่างกัน.*เป็นหมายเหตุให้ทำเอง/);
  assert.match(say('Index', 'dbo.T (primary key)', 'Different', 'Name: source PK_T, target (system-named)', T), /primary key ต่างกัน/);
  assert.match(say('Foreign key', 'dbo.T.FK_a', 'Different', 'Name: source FK_a, target FK_b', T), /ต่างกันแค่ชื่อ sync จะเปลี่ยนชื่อ/);
  assert.match(say('Check constraint', 'dbo.T.CK', 'Different', 'State: source ENABLED, target DISABLED', T), /sync จะเปิดหรือปิด/);
  assert.match(say('Index', 'dbo.T.IX', 'Different', 'Include: source A, target (none)', T), /ลบของเดิมแล้วสร้างใหม่/);
  assert.match(say('Stored procedure', 'dbo.p', 'Different', 'Definition differs'), /โค้ดข้างในต่างกัน sync จะแทนด้วยโค้ดของต้นแบบ/);
  assert.match(say('Stored procedure', 'dbo.p', 'Different', 'SetOptions: source QUOTED_IDENTIFIER OFF, target (none)'), /สร้างซ้ำด้วยโค้ดเดิม/);
  assert.match(say('Function', 'dbo.f', 'Different', 'Definition differs\nType: source SQL_SCALAR_FUNCTION, target SQL_INLINE_TABLE_VALUED_FUNCTION'), /ต้องลบแล้วสร้างใหม่.*ทำเอง/);
  assert.match(say('Trigger', 'dbo.tr', 'Different', 'Table: source dbo.A, target dbo.B', ['table', 'dbo.A']), /ต้องลบแล้วสร้างใหม่.*ทำเอง/);
  assert.match(say('Trigger', 'dbo.tr', 'Different', 'State: source DISABLED, target ENABLED\nDefinition: not readable on target (not compared)', T), /sync จะเปิดหรือปิด/);
  assert.match(say('View', 'dbo.v', 'Different', 'SetOptions: source ANSI_NULLS OFF, target (none)\nDefinition: not readable on target (not compared)'), /sync จึงไม่เขียนคำสั่งให้/);
  assert.match(say('User-defined type', 'dbo.t', 'Different', 'Spec: source varchar(10) NULL, target varchar(20) NULL'), /ทำเอง/);
  assert.match(say('Sequence', 'dbo.s', 'Different', 'Increment: source 1, target 2'), /ยกเว้นชนิดข้อมูลและค่าเริ่มที่/);
  assert.match(say('Synonym', 'dbo.s', 'Different', 'BaseObject: source [dbo].[a], target [dbo].[b]'), /ลบแล้วสร้างใหม่/);
  assert.match(say('Database', '(database)', 'Different', 'Collation: source Thai_CI_AS, target Thai_BIN'), /sync ไม่แก้/);
  // A value that could not be read can stand in the way of the statement that makes the change.
  // The type of a column: ALTER COLUMN has to say it. A default needs no type.
  assert.match(say('Column', 'dbo.T.C', 'Different', 'Nullable: source NULL, target NOT NULL\nType: not readable on target (not compared)', T), /ชนิดข้อมูลอ่านไม่ได้.*sync จึงไม่เขียนคำสั่งให้/);
  assert.equal(say('Column', 'dbo.T.C', 'Different', 'Default: source ((1)), target (none)\nType: not readable on source (not compared)', T), 'sync จะแก้ปลายทางจากค่าที่ขีดฆ่าเป็นค่าใหม่');
  // The filter of the model's index: what would replace the existing index cannot be written.
  assert.match(say('Index', 'dbo.T.IX', 'Different', 'Columns: source A, target B\nFilter: not readable on source (not compared)', T), /sync จึงไม่แก้ให้/);
  assert.match(say('Index', 'dbo.T.IX', 'Different', 'Columns: source A, target B\nFilter: not readable on target (not compared)', T), /ลบของเดิมแล้วสร้างใหม่/);

  // ---- what the script writes as a comment, where the row itself shows it ----
  const NOTE = /เขียน[^ ]*เป็นหมายเหตุให้ทำเอง|มีแต่หมายเหตุ/;
  // A new column whose type or computed definition could not be read: nothing to add it with.
  assert.match(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: (not readable); Nullable: NULL', T), /อ่านไม่ได้ sync จึงสร้างให้ไม่ได้ มีแต่หมายเหตุ$/);
  assert.match(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: int; Nullable: NULL; Computed: (not readable)', T), /อ่านไม่ได้ sync จึงสร้างให้ไม่ได้ มีแต่หมายเหตุ$/);
  // A computed column is added with its formula alone: a type that could not be read is not in
  // the way (the script writes the ADD), and the page must not say it is.
  assert.equal(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: (not readable); Nullable: NULL; Computed: ([a]+(1))', T), 'ปลายทางยังไม่มีคอลัมน์นี้ sync จะสร้างให้');
  assert.equal(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: (not readable); Nullable: NOT NULL; Computed: ([a]+(1)); Persisted: PERSISTED', T), 'ปลายทางยังไม่มีคอลัมน์นี้ sync จะสร้างให้');
  assert.match(say('Column', 'dbo.T.C', 'OnlyInSource', 'Type: (not readable); Nullable: NULL; Computed: (not readable)', T), /อ่านไม่ได้ sync จึงสร้างให้ไม่ได้ มีแต่หมายเหตุ$/);
  // An index of a kind the script cannot write (columnstore, XML, spatial): new, or as what
  // would replace the one that is there. A changed index that does not say its kind may be one.
  assert.match(say('Index', 'dbo.T.IX', 'OnlyInSource', 'Kind: INDEX; Type: NONCLUSTERED COLUMNSTORE; Columns: A', T), /^ปลายทางยังไม่มี index นี้ แต่ index แบบ NONCLUSTERED COLUMNSTORE sync เขียนคำสั่งสร้างไม่ได้ มีแต่หมายเหตุให้ทำเอง$/);
  assert.match(say('Index', 'dbo.T.IX', 'OnlyInSource', 'Kind: INDEX; Type: NONCLUSTERED; Columns: A; Filter: (not readable)', T), /เงื่อนไขกรองของต้นแบบอ่านไม่ได้ sync จึงสร้างให้ไม่ได้ มีแต่หมายเหตุ$/);
  assert.match(say('Index', 'dbo.T.IX', 'Different', 'Type: source CLUSTERED COLUMNSTORE, target CLUSTERED', T), /^index แบบ CLUSTERED COLUMNSTORE sync เขียนคำสั่งสร้างไม่ได้ จึงไม่ลบของเดิม มีแต่หมายเหตุให้ทำเอง$/);
  assert.equal(say('Index', 'dbo.T.IX', 'Different', 'Type: source CLUSTERED, target NONCLUSTERED', T), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ');
  assert.equal(say('Index', 'dbo.T.IX', 'Different', 'Include: source A, target (none)', T), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ (ถ้าเป็น index แบบ columnstore, XML หรือ spatial sync จะเขียนเป็นหมายเหตุให้ทำเองแทน)');
  // A constraint is always replaced by a statement.
  assert.equal(say('Check constraint', 'dbo.T.CK', 'Different', 'Expression: source ([a]>(0)), target ([a]>(1))', T), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ');
  assert.equal(say('Foreign key', 'dbo.T.FK', 'Different', 'OnDelete: source CASCADE, target NO_ACTION', T), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ');
  assert.match(say('Check constraint', 'dbo.T.CK', 'OnlyInSource', 'Expression: (not readable); State: ENABLED', T), /เงื่อนไขของต้นแบบอ่านไม่ได้ sync จึงสร้างให้ไม่ได้ มีแต่หมายเหตุ$/);
  // A synonym for an object in another database or on another server (a name of 3 or 4 parts,
  // dots inside brackets not counted): a comment, new or changed, whichever side names it.
  assert.equal(say('Synonym', 'dbo.s', 'OnlyInSource', 'BaseObject: [dbo].[a.b]'), 'ปลายทางยังไม่มี synonym นี้ sync จะสร้างให้');
  assert.match(say('Synonym', 'dbo.s', 'OnlyInSource', 'BaseObject: [other].[dbo].[a]'), /^synonym นี้ชี้ไปฐานอื่นหรือ server อื่น .*sync จึงเขียนคำสั่งสร้างไว้เป็นหมายเหตุให้ตรวจแล้วทำเอง$/);
  assert.equal(say('Synonym', 'dbo.s', 'Different', 'BaseObject: source [dbo].[a], target [dbo].[b]'), 'sync จะลบแล้วสร้างใหม่ให้ชี้ตามต้นแบบ');
  for (const detail of ['BaseObject: source [other].[dbo].[a], target [dbo].[b]', 'BaseObject: source [dbo].[a], target [srv].[other].[dbo].[b]', 'BaseObject: source other..a, target [dbo].[b]']) {
    assert.match(say('Synonym', 'dbo.s', 'Different', detail), /^synonym นี้ชี้ไปฐานอื่นหรือ server อื่น .*sync จึงเขียนคำสั่งไว้เป็นหมายเหตุให้ตรวจแล้วทำเอง$/, detail);
  }

  // ---- a target read without VIEW DEFINITION: what is "only in source" may be there, hidden ----
  const hiddenTarget = coreFor({ noViewDefinition: [['target', 'someone']] });
  const sayHidden = (cat: string, obj: string, status: string, detail = '', group: [string, string] | null = null, self: Row | null = null) => say(cat, obj, status, detail, group, self, hiddenTarget);
  // A new table: its CREATE TABLE is a statement, what stands on it waits as comments.
  const newTable = sayHidden('Table', 'dbo.T', 'OnlyInSource', '', T);
  assert.match(newTable, /^ปลายทางยังไม่มีตารางนี้ sync จะสร้างทั้งตาราง พร้อมคอลัมน์และ primary key ส่วน index, check constraint, foreign key ของมัน sync เขียนเป็นหมายเหตุให้ทำเอง/);
  assert.doesNotMatch(newTable, /รวมทั้ง index/);
  // Only the categories that were compared are written at all.
  const fewerHidden = coreFor({ categories: ['Table', 'Column', 'Index'], noViewDefinition: [['target', 'someone']] });
  const newTableFewer = say('Table', 'dbo.T', 'OnlyInSource', '', T, null, fewerHidden);
  assert.match(newTableFewer, /ส่วน index ของมัน sync เขียนเป็นหมายเหตุให้ทำเอง/);
  assert.match(newTableFewer, /ไม่รวม check constraint, foreign key เพราะไม่ได้เลือกเทียบหมวดนั้น/);
  // A check without a name cannot be paired with one the login could not read.
  assert.match(sayHidden('Check constraint', 'dbo.T (check: ([a]>(0)))', 'OnlyInSource', 'Expression: ([a]>(0)); State: ENABLED', T), /^check นี้ไม่มีชื่อ .*sync จึงเขียนคำสั่งสร้างไว้เป็นหมายเหตุให้ทำเอง$/);
  assert.equal(sayHidden('Check constraint', 'dbo.T.CK', 'OnlyInSource', 'Expression: ([a]>(0)); State: ENABLED', T), 'ปลายทางยังไม่มี check constraint นี้ sync จะสร้างให้');
  assert.equal(say('Check constraint', 'dbo.T (check: ([a]>(0)))', 'OnlyInSource', 'Expression: ([a]>(0)); State: ENABLED', T), 'ปลายทางยังไม่มี check constraint นี้ sync จะสร้างให้');
  // A module is a plain CREATE, which fails instead of replacing one that is there.
  assert.match(sayHidden('Stored procedure', 'dbo.p', 'OnlyInSource', 'Type: SQL_STORED_PROCEDURE'), /sync จะสร้างด้วย CREATE ธรรมดา ถ้ามีอยู่แล้วแต่มองไม่เห็น คำสั่งจะ fail โดยไม่เขียนทับ$/);
  // The index of a view that is itself new waits for its CREATE VIEW.
  const newView = row(hiddenTarget, 'View', 'dbo.v', 'OnlyInSource', 'Type: VIEW', ['view', 'dbo.v'], 'a', null);
  assert.match(sayHidden('Index', 'dbo.v.IX', 'OnlyInSource', 'Kind: UNIQUE INDEX; Type: CLUSTERED; Columns: A', ['view', 'dbo.v'], newView), NOTE);
  assert.equal(say('Index', 'dbo.v.IX', 'OnlyInSource', 'Kind: UNIQUE INDEX; Type: CLUSTERED; Columns: A', ['view', 'dbo.v'], newView), 'ปลายทางยังไม่มี index นี้ sync จะสร้างให้');
  // The other side read without it changes nothing in what the sync script writes.
  const hiddenSource = coreFor({ noViewDefinition: [['source', 'someone']] });
  assert.match(say('Table', 'dbo.T', 'OnlyInSource', '', T, null, hiddenSource), /รวมทั้ง index, check และ foreign key ของมัน$/);

  // An index that is only in the target, on a view the script writes again: ALTER VIEW drops it.
  const V: [string, string] = ['view', 'dbo.v'];
  const rewritten = row(sync, 'View', 'dbo.v', 'Different', 'Definition differs', V, 'a', 'b');
  const kept = row(sync, 'View', 'dbo.v', 'Different', 'Definition differs\nType: source VIEW, target SQL_STORED_PROCEDURE', V);
  assert.match(say('Index', 'dbo.v.IX', 'OnlyInTarget', 'Kind: INDEX', V, rewritten), /ทำให้ index นี้หายไปด้วย/);
  assert.match(say('Index', 'dbo.v.IX', 'OnlyInTarget', 'Kind: INDEX', V, kept), /sync ไม่ลบให้/);
  assert.match(say('Index', 'dbo.v.IX', 'OnlyInTarget', 'Kind: INDEX', V, null), /sync ไม่ลบให้/);
  assert.match(say('Index', 'dbo.T.IX', 'OnlyInTarget', 'Kind: INDEX', T, rewritten), /sync ไม่ลบให้/);
  // A changed index of a view. On a view the script writes again it is created with the view.
  // On another view its clustered index is a comment (dropping it drops the others): said when
  // the row shows the kind, and as a reservation when it does not.
  assert.equal(say('Index', 'dbo.v.IX', 'Different', 'Include: source A, target (none)', V, rewritten), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ');
  assert.equal(say('Index', 'dbo.v.IX', 'Different', 'Include: source A, target (none)', V, null), 'sync จะลบของเดิมแล้วสร้างใหม่ตามต้นแบบ (ถ้าเป็น clustered index ของ view sync จะเขียนเป็นหมายเหตุให้ทำเองแทน)');
  assert.match(say('Index', 'dbo.v.IX', 'Different', 'Type: source CLUSTERED, target NONCLUSTERED', V, kept), /^clustered index ของ view ต่างกัน .*sync จึงเขียนเป็นหมายเหตุให้ทำเอง$/);

  // A drift report says what changed, and nothing about a sync.
  for (const [status, detail] of [['OnlyInSource', 'Type: int'], ['OnlyInTarget', 'Type: int'], ['Different', 'Type: source int, target bigint'], ['Unverified', 'Type: not readable on source']] as const) {
    const text = say('Column', 'dbo.T.C', status, detail, T, null, drift);
    assert.ok(hasThai(text), text);
    assert.doesNotMatch(text, /sync|ต้นแบบ|ปลายทาง/, text);
  }
});

// ---------------------------------------------------------------------------------------------
// Grouping by table
// ---------------------------------------------------------------------------------------------

test('report: a name inside a card is the object name without its table, whatever dots it holds', () => {
  const leaf = (cat: string, obj: string, group: [string, string] | null) => plain(sync.leafOf(row(sync, cat, obj, 'Different', '', group)));
  // The table is dbo."My.Table" and the column "Col.With.Dots": only the group key can tell.
  assert.deepEqual(leaf('Column', 'dbo.My.Table.Col.With.Dots', ['table', 'dbo.My.Table']), { name: 'Col.With.Dots', kind: 'คอลัมน์', pk: false });
  assert.deepEqual(leaf('Index', 'dbo.T]x.[IX.a]', ['table', 'dbo.T]x']), { name: '[IX.a]', kind: 'index', pk: false });
  assert.deepEqual(leaf('Index', 'dbo.T (primary key)', ['table', 'dbo.T']), { name: 'ของตารางนี้', kind: 'primary key', pk: true });
  assert.deepEqual(leaf('Index', 'dbo.T (unique: Code, Name)', ['table', 'dbo.T']), { name: 'ไม่มีชื่อ: Code, Name', kind: 'unique', pk: false });
  assert.deepEqual(leaf('Foreign key', 'dbo.T (foreign key: A -> dbo.P (Id))', ['table', 'dbo.T']), { name: 'ไม่มีชื่อ: A -> dbo.P (Id)', kind: 'foreign key', pk: false });
  assert.deepEqual(leaf('Check constraint', 'dbo.T (check: ([V]>(0)))', ['table', 'dbo.T']), { name: 'ไม่มีชื่อ: ([V]>(0))', kind: 'check constraint', pk: false });
  // A trigger has a name of its own (schema.name), which may even start like its table's.
  assert.deepEqual(leaf('Trigger', 'dbo.T.audit', ['table', 'dbo.T']), { name: 'dbo.T.audit', kind: 'trigger', pk: false });
  assert.deepEqual(leaf('Stored procedure', 'dbo.p', null), { name: 'dbo.p', kind: 'stored procedure', pk: false });
});

test('report: rows are grouped by the table or view the engine names, never by the dots of a name', () => {
  const data: unknown[][] = [
    ['Table', 'dbo.New', 'OnlyInSource', '', null, null, ['table', 'dbo.New']],
    // The same table under another spelling on the other side: one card.
    ['Column', 'dbo.Orders.A', 'OnlyInSource', 'Type: int', null, null, ['table', 'dbo.Orders']],
    ['Column', 'DBO.ORDERS.B', 'OnlyInTarget', 'Type: int', null, null, ['table', 'DBO.ORDERS']],
    // A table and a column with dots in their names.
    ['Column', 'dbo.My.Table.Col.x', 'Different', 'Type: source int, target bigint', null, null, ['table', 'dbo.My.Table']],
    ['Index', 'dbo.Orders.IX_a', 'Different', 'Columns: source A, target B', null, null, ['table', 'dbo.Orders']],
    // The index of a view goes with its view; this view has no difference of its own.
    ['Index', 'dbo.vTotals.CIX', 'OnlyInSource', 'Kind: UNIQUE INDEX', null, null, ['view', 'dbo.vTotals']],
    ['View', 'dbo.vOther', 'Different', 'Definition differs', 'a', 'b', ['view', 'dbo.vOther']],
    ['Index', 'dbo.vOther.IX', 'OnlyInTarget', 'Kind: INDEX', null, null, ['view', 'dbo.vOther']],
    ['Stored procedure', 'dbo.Orders.proc', 'OnlyInSource', 'Type: SQL_STORED_PROCEDURE', 'x', null, null],
    ['Trigger', 'dbo.trOrders', 'Different', 'Definition differs', 'a', 'b', ['table', 'dbo.Orders']],
    ['Trigger', 'trDdl (database trigger)', 'OnlyInSource', 'Type: SQL_TRIGGER; Table: DATABASE; State: ENABLED', 'x', null, null],
    ['Schema', 'rpt', 'OnlyInSource', '', null, null, null],
    ['Database', '(database)', 'Different', 'Collation: source a, target b', null, null, null],
  ];
  const rows = sync.toRows(data);
  const groups = sync.groupRows(rows, ALL_CATEGORIES);
  const names = (g: Group) => `${g.name}: ${g.self ? `[${g.self.status}] ` : ''}${g.items.map((r) => r.obj).join(', ')}`;
  assert.deepEqual(plain(groups.tables.map(names)), [
    'dbo.My.Table: dbo.My.Table.Col.x',
    'dbo.New: [OnlyInSource] ',
    // Columns, then indexes, then triggers: the order of the categories.
    'dbo.Orders: dbo.Orders.A, DBO.ORDERS.B, dbo.Orders.IX_a, dbo.trOrders',
  ]);
  assert.deepEqual(plain(groups.others.map((g) => `${g.kind} ${g.cat} ${names(g)}`)), [
    'single Database (database): [Different] ',
    'single Schema rpt: [OnlyInSource] ',
    'view View dbo.vOther: [Different] dbo.vOther.IX',
    'view View dbo.vTotals: dbo.vTotals.CIX',
    // Looks like something of dbo.Orders by its name; it is a procedure.
    'single Stored procedure dbo.Orders.proc: [OnlyInSource] ',
    'single Trigger trDdl (database trigger): [OnlyInSource] ',
  ]);
  // Every row once.
  const seen = [...groups.tables, ...groups.others].flatMap((g) => [...(g.self ? [g.self.id] : []), ...g.items.map((r) => r.id)]).sort((a, b) => a - b);
  assert.deepEqual(seen, plain(rows.map((r) => r.id)));

  // The chip of a card.
  const status = (name: string, core = sync, list = groups) => {
    const group = [...list.tables, ...list.others].find((g) => g.name === name);
    assert.ok(group, name);
    return plain(core.groupStatus(group));
  };
  assert.deepEqual(status('dbo.New'), { cls: 'add', sym: '+', text: 'ตารางใหม่ทั้งตาราง' });
  assert.deepEqual(status('dbo.Orders'), { cls: 'chg', sym: '~', text: 'มีของข้างในต่างกัน' });
  assert.deepEqual(status('dbo.vTotals'), { cls: 'chg', sym: '~', text: 'มีของข้างในต่างกัน' });
  const extra = sync.groupRows(sync.toRows([
    ['Table', 'dbo.Old', 'OnlyInTarget', '', null, null, ['table', 'dbo.Old']],
    ['Column', 'dbo.T.C', 'Unverified', 'Type: not readable on target', null, null, ['table', 'dbo.T']],
  ]), ALL_CATEGORIES);
  assert.deepEqual(status('dbo.Old', sync, extra), { cls: 'del', sym: '−', text: 'ตารางเกินมาทั้งตาราง' });
  assert.deepEqual(status('dbo.T', sync, extra), { cls: 'unk', sym: '?', text: 'มีของที่ตรวจไม่ได้' });
  const later = drift.groupRows(drift.toRows(data), ALL_CATEGORIES);
  assert.deepEqual(status('dbo.New', drift, later), { cls: 'del', sym: '−', text: 'ตารางหายไปทั้งตาราง' });
  assert.deepEqual(status('dbo.Orders', drift, later), { cls: 'chg', sym: '~', text: 'ของข้างในเปลี่ยนไป' });
});

// ---------------------------------------------------------------------------------------------
// The line diff of a module
// ---------------------------------------------------------------------------------------------

test('report: the line diff keeps the rules of the comparison and stays fast on long texts', () => {
  // CREATE OR ALTER is stored as "CREATE   PROCEDURE": the same line.
  assert.equal(sync.lineKey('CREATE OR ALTER PROCEDURE dbo.p'), sync.lineKey('CREATE   PROCEDURE dbo.p'));
  assert.equal(sync.lineKey('  create or alter view v'), '  CREATE view v');
  assert.notEqual(sync.lineKey('SELECT  1'), sync.lineKey('SELECT 1'));
  assert.notEqual(sync.lineKey('select 1'), sync.lineKey('SELECT 1'));
  const loose = coreFor({ ignoreWhitespace: true, ignoreCase: true });
  assert.equal(loose.lineKey('  SELECT   1 '), loose.lineKey('select 1'));

  const ops = plain(sync.diffLines(['CREATE   PROCEDURE p', 'AS', 'SELECT 1', 'RETURN'], ['CREATE OR ALTER PROCEDURE p', 'AS', 'SELECT 2', 'RETURN']));
  assert.deepEqual(ops.map((o) => o[0]).join(''), '  -+ ');
  assert.deepEqual(plain(loose.diffLines(['select  1'], ['SELECT 1'])).map((o) => o[0]), [' ']);

  // Too much for the table of an LCS (more than 4,000,000 cells): every line of the one side,
  // then every line of the other, at once.
  const a = Array.from({ length: 2100 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 2100 }, (_, i) => `b${i}`);
  const start = Date.now();
  const big = sync.diffLines(a, b);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  assert.equal(big.length, 4200);
  assert.deepEqual([big[0]?.[0], big[2099]?.[0], big[2100]?.[0], big[4199]?.[0]], ['-', '-', '+', '+']);

  // The diff of a row: red is what the target has now, green what the model has. In a drift
  // report red is the older text. Text from a definition is escaped.
  const changed = (core: Core) => core.renderDiff(row(core, 'View', 'dbo.v', 'Different', 'Definition differs', null, 'CREATE VIEW v AS\nSELECT 1 AS <model>', 'CREATE VIEW v AS\nSELECT 2 AS <target>'));
  const cut = (html: string, cls: string) => (new RegExp(`<tr class="${cls}">.*?</tr>`).exec(html) ?? [''])[0];
  assert.match(cut(changed(sync), 'del'), /SELECT 2 AS &lt;target&gt;/);
  assert.match(cut(changed(sync), 'add'), /SELECT 1 AS &lt;model&gt;/);
  assert.match(changed(sync), /แดง<\/span> = บรรทัดในปลายทางตอนนี้ \(จะหายไป\)/);
  assert.match(changed(sync), /เขียว<\/span> = บรรทัดจากต้นแบบ \(จะใส่แทน\)/);
  assert.match(cut(changed(drift), 'del'), /SELECT 1 AS &lt;model&gt;/);
  assert.match(cut(changed(drift), 'add'), /SELECT 2 AS &lt;target&gt;/);
  assert.doesNotMatch(changed(drift), /ต้นแบบ|ปลายทาง/);
  const one = sync.renderPlain(row(sync, 'View', 'dbo.v', 'OnlyInSource', '', null, 'CREATE VIEW v AS SELECT \'<b>\'', null));
  assert.match(one, /โค้ดของต้นแบบ/);
  assert.match(one, /&lt;b&gt;/);
});

// ---------------------------------------------------------------------------------------------
// Real reports: what the engine writes for the fixture databases
// ---------------------------------------------------------------------------------------------

interface SnapshotItem {
  Name: string;
  Parent: string;
  Props: Record<string, string>;
  Sql: Record<string, unknown> | null;
}

interface SnapshotFile {
  canViewDefinition: boolean;
  categories: Record<string, Record<string, SnapshotItem>>;
}

interface Diff {
  Category: string;
  Object: string;
  Status: string;
  Detail: string;
  SourceKey: string | null;
  TargetKey: string | null;
}

function readSnapshot(file: string): SnapshotFile {
  return JSON.parse(readFileSync(file, 'utf8')) as SnapshotFile;
}

// Keys are matched ignoring case, as the engine does.
function itemOf(snapshot: SnapshotFile, category: string, key: string): SnapshotItem | undefined {
  const items = snapshot.categories[category] ?? {};
  return items[key] ?? Object.entries(items).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
}

const TABLE_CHILDREN = ['Column', 'Index', 'Foreign key', 'Check constraint'];
const MODULE_CATEGORIES = ['View', 'Stored procedure', 'Function', 'Trigger'];

interface Checked {
  script: ReportScript;
  core: Core;
  rows: Row[];
  groups: { tables: Group[]; others: Group[] };
  // What the page says of the row of this object, with the row of its table or view at hand.
  say(object: string): string;
  // How many rows were held against their block in the sync script, and how many of those
  // blocks hold nothing but comments.
  blocks: { checked: number; commented: number };
}

// Everything a report of the engine must hold, whatever was compared. Returns the report for
// what a test wants to say about this one in particular.
function checkReport(c: Comparison, source: SnapshotFile, target: SnapshotFile, ignoredProps = ['Ordinal']): Checked {
  const html = readFileSync(c.files.html, 'utf8');
  // The Thai text of the template came through the engine as it is.
  assert.match(html, /<html lang="th">/);
  assert.ok(html.includes('รายงานนี้บอกว่าปลายทางต่างจากต้นแบบตรงไหน'), 'the Thai text of the template is in the report');
  assert.ok(!html.includes('__META_JSON__') && !html.includes('__DATA_JSON__'), 'both placeholders are filled');
  assert.ok(!html.includes(LOST_CHARACTER), 'no character was lost to an encoding');
  loadsNothing(html);

  const script = runScript<ReportScript>(html, '{ META, DATA, createReportCore }');
  const core = script.createReportCore(script.META);
  const diffs = c.result['diffs'] as Diff[];
  const rows = core.toRows(script.DATA);

  // The rows are the differences of the result, in its order, each with its group at the end.
  assert.equal(rows.length, diffs.length);
  assert.ok(rows.length > 0, 'the comparison found differences');
  rows.forEach((r, i) => {
    const d = diffs[i];
    assert.ok(d);
    assert.deepEqual([r.cat, r.obj, r.status, r.detail], [d.Category, d.Object, d.Status, d.Detail]);
    assert.equal(script.DATA[i]?.length, 7, r.obj);
    assert.ok(!('Group' in d) && !('group' in d), 'the result file has no group');

    // The group is what the catalog says the object is on: the Parent of the snapshot item, or
    // the table of a trigger. Nothing for what stands on its own.
    const fromSource = d.SourceKey !== null;
    const own = fromSource ? source : target;
    const other = fromSource ? target : source;
    const key = (fromSource ? d.SourceKey : d.TargetKey) ?? '';
    const item = itemOf(own, d.Category, key);
    assert.ok(item, `${d.Category} ${key} is in the snapshot of its side`);
    let expected: string | null = null;
    if (d.Category === 'Table' || d.Category === 'View') expected = key;
    else if (TABLE_CHILDREN.includes(d.Category)) expected = item.Parent;
    else if (d.Category === 'Trigger' && item.Sql?.['Scope'] !== 'DATABASE') expected = item.Props['Table'] || null;
    if (expected === null) {
      assert.equal(r.group, null, `${r.cat} ${r.obj} belongs to no table or view`);
    } else {
      const isView = itemOf(own, 'Table', expected) ? false : Boolean(itemOf(own, 'View', expected) ?? (!itemOf(other, 'Table', expected) && itemOf(other, 'View', expected)));
      assert.deepEqual(plain(r.group), { kind: isView ? 'view' : 'table', key: expected }, `${r.cat} ${r.obj}`);
    }
  });

  // Every row lands in exactly one group.
  const groups = core.groupRows(rows, script.META.categories);
  const all = [...groups.tables, ...groups.others];
  const seen = all.flatMap((g) => [...(g.self ? [g.self.id] : []), ...g.items.map((r) => r.id)]).sort((a, b) => a - b);
  assert.deepEqual(seen, plain(rows.map((r) => r.id)), 'every row is in exactly one group');
  for (const g of groups.tables) {
    assert.equal(g.kind, 'table');
    // A card is a table of one of the two databases, never a view or a made-up name.
    assert.ok(itemOf(source, 'Table', g.key) ?? itemOf(target, 'Table', g.key), `${g.key} is a table`);
    for (const r of g.items) assert.equal(r.group?.key.toLowerCase(), g.key.toLowerCase());
    if (g.self) assert.equal(g.self.cat, 'Table');
  }
  for (const g of groups.others) {
    if (g.kind === 'view') {
      assert.ok(itemOf(source, 'View', g.key) ?? itemOf(target, 'View', g.key), `${g.key} is a view`);
      for (const r of g.items) assert.ok(r.cat === 'Index' || r.cat === 'Trigger', `${r.cat} ${r.obj} under view ${g.key}`);
    } else {
      assert.equal(g.kind, 'single');
      assert.equal(g.items.length, 0);
      assert.equal(g.self?.group, null);
    }
  }

  // Every row can be read: nothing is left as raw text, every property has a Thai name, and the
  // facts of a row that is on one side only are the properties of its snapshot item.
  rows.forEach((r, i) => {
    const parsed = plain(core.parseDetail(r));
    assert.deepEqual(parsed.raw, [], `${r.cat} ${r.obj}: ${r.detail}`);
    for (const entry of [...parsed.changes, ...parsed.facts]) assert.notEqual(entry.label, entry.key, `${r.cat}.${entry.key} has no Thai name`);
    const text = core.sentence(r, core.parseDetail(r), { self: null });
    assert.ok(hasThai(text), `${r.cat} ${r.obj}: ${text}`);
    assert.ok(hasThai(core.leafOf(r).kind) || /^[a-z ]+$/.test(core.leafOf(r).kind), core.leafOf(r).kind);
    const d = diffs[i];
    assert.ok(d);
    if (r.status === 'Different') {
      assert.ok(parsed.code || parsed.changes.length + parsed.notes.length > 0, `${r.obj}: ${r.detail}`);
      assert.equal(parsed.code, r.a !== null && r.b !== null, r.obj);
      assert.equal(parsed.changes.length + parsed.notes.length + (parsed.code ? 1 : 0), r.detail.split('\n').length, `${r.obj}: every line of the detail is read`);
    } else if (r.status === 'Unverified') {
      assert.ok(parsed.notes.length > 0 && parsed.changes.length === 0, r.detail);
    } else {
      const item = itemOf(r.status === 'OnlyInSource' ? source : target, d.Category, (r.status === 'OnlyInSource' ? d.SourceKey : d.TargetKey) ?? '');
      assert.ok(item);
      const expected = Object.entries(item.Props).filter(([key, value]) => value !== '' && !ignoredProps.includes(key)).map(([key]) => key);
      assert.deepEqual(parsed.facts.map((f) => f.key), expected, `${r.cat} ${r.obj}: ${r.detail}`);
    }
  });

  // What the page says of a row, against what the sync script of the same comparison does with
  // it. A changed column, index or constraint and every module that is not a database trigger
  // has a line in the script that names it, and its statements follow that line: for a column,
  // an index or a constraint up to the next GO, for a module up to the line of the next object
  // or the next section. (The other rows have no line of their own in the script.)
  // - A block that holds nothing but comments: the sentence must say so, or say that it may be.
  // - A sentence that says "by hand" without reservation: the block must hold no statement.
  const syncLines = readFileSync(c.files.sync, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const sectionLine = /^-- =+$/;
  const headOf = (r: Row): string | null => {
    if (r.obj.endsWith(' (database trigger)')) return null;
    const oneLine = (text: string) => `-- ${text.replace(/[\r\n]+/g, ' ')}`;
    if (r.status === 'Different' && (TABLE_CHILDREN.includes(r.cat) || MODULE_CATEGORIES.includes(r.cat))) return oneLine(`${r.obj}: ${r.detail}`);
    if (r.status === 'OnlyInSource' && MODULE_CATEGORIES.includes(r.cat)) return oneLine(`${r.obj}: only in source`);
    return null;
  };
  const heads = new Map<number, Row>();
  for (const r of rows) {
    const head = headOf(r);
    const at = head === null ? -1 : syncLines.indexOf(head);
    // Not every such row has a line: the index of a view the script writes again is created
    // with its view.
    if (at >= 0) heads.set(at, r);
  }
  assert.ok(heads.size > 0, 'the sync script names the objects it changes');
  const groupOf = (r: Row) => all.find((g) => g.self === r || g.items.includes(r));
  let commentedBlocks = 0;
  for (const [at, r] of heads) {
    let end = at + 1;
    if (TABLE_CHILDREN.includes(r.cat)) while (end < syncLines.length && syncLines[end] !== 'GO') end++;
    else while (end < syncLines.length && !heads.has(end) && !sectionLine.test(syncLines[end] ?? '')) end++;
    const active = syncLines.slice(at + 1, end).filter((l) => l.trim() !== '' && !l.startsWith('--') && l !== 'GO');
    const self = groupOf(r)?.self ?? null;
    const text = core.sentence(r, core.parseDetail(r), { self: self === r ? null : self });
    const where = `${r.cat} ${r.obj}: "${text}"\n${syncLines.slice(at, end).join('\n')}`;
    if (active.length === 0) {
      commentedBlocks++;
      assert.match(text, /หมายเหตุ|ไม่ย้ายให้|ไม่เขียนคำสั่ง/, `the script only has comments for ${where}`);
    }
    if (!text.includes('sync จะ')) assert.deepEqual(active, [], `the page says by hand, the script has statements for ${where}`);
  }

  // Every property the engine read, in either database, has a Thai name in its category.
  for (const snapshot of [source, target]) {
    for (const [category, items] of Object.entries(snapshot.categories)) {
      for (const item of Object.values(items)) {
        for (const key of Object.keys(item.Props)) assert.notEqual(core.propLabel(category, key), key, `${category}.${key} has no Thai name`);
      }
    }
  }
  const say = (object: string): string => {
    const r = rows.find((candidate) => candidate.obj === object);
    assert.ok(r, `the report has a row for ${object}`);
    const self = groupOf(r)?.self ?? null;
    return core.sentence(r, core.parseDetail(r), { self: self === r ? null : self });
  };
  return { script, core, rows, groups, say, blocks: { checked: heads.size, commented: commentedBlocks } };
}

const skip = skipWithoutServer();

test('report: every difference of a real comparison is shown once, under the table or view it is on', { skip }, async (t) => {
  const source = `${DB_PREFIX}report_core_src`;
  const target = `${DB_PREFIX}report_core_tgt`;
  buildFixture('core', source, target);
  const before = compare({ dir: 'report', name: 'core', source, target });
  assert.equal(before.exitCode, 1, before.log);
  const sourceSnapshot = readSnapshot(before.files.sourceSnapshot);
  const targetSnapshot = readSnapshot(before.files.targetSnapshot);

  await t.test('core: tables, the indexes of views and database triggers', () => {
    const { script, groups, rows, core, blocks } = checkReport(before, sourceSnapshot, targetSnapshot);
    assert.equal(script.META.perspective, 'sync');
    // The sentences of the changed columns, indexes and constraints and of the modules were
    // held against the sync script. In this fixture the script has a statement for each.
    assert.ok(blocks.checked >= 20, `${blocks.checked} rows were checked against the sync script`);
    assert.equal(blocks.commented, 0);
    assert.deepEqual(plain(script.META.noViewDefinition), []);
    assert.equal(core.TIMELINE, false);

    // The indexes of a view are under their view, in the second section: no card is made of a
    // view, and no index of a view is in a card.
    const viewIndexes = rows.filter((r) => r.cat === 'Index' && r.group?.kind === 'view');
    assert.ok(viewIndexes.length >= 2, 'the core fixture has differences in the indexes of its views');
    for (const r of viewIndexes) {
      const view = groups.others.find((g) => g.kind === 'view' && g.items.includes(r));
      assert.ok(view, `${r.obj} is under a view`);
      assert.ok(r.obj.startsWith(`${view.key}.`), `${r.obj} is an index of ${view.key}`);
      assert.equal(core.leafOf(r).name, r.obj.slice(view.key.length + 1));
    }
    assert.ok(groups.others.some((g) => g.kind === 'view' && g.name === 'dbo.vSalesByRegion' && g.items.length > 0));
    assert.ok(!groups.tables.some((g) => g.name.startsWith('dbo.v')), groups.tables.map((g) => g.name).join(', '));

    // Database triggers are in the second section, on their own.
    const databaseTriggers = rows.filter((r) => r.obj.endsWith(' (database trigger)'));
    assert.ok(databaseTriggers.length >= 3, 'the core fixture has differences in database triggers');
    for (const r of databaseTriggers) {
      assert.equal(r.cat, 'Trigger');
      assert.equal(r.group, null);
      assert.ok(groups.others.some((g) => g.kind === 'single' && g.self === r), r.obj);
    }
    // The trigger of a table is in the card of its table.
    const orders = groups.tables.find((g) => g.name === 'dbo.Orders');
    assert.ok(orders, 'dbo.Orders has a card');
    assert.ok(orders.items.some((r) => r.cat === 'Trigger' && r.obj === 'dbo.trOrders_Insert'), 'dbo.trOrders_Insert is in the card of dbo.Orders');
    assert.ok(orders.items.some((r) => r.cat === 'Column') && orders.items.some((r) => r.cat === 'Index'));
    // A table that is on one side only is a card of its own.
    const legacy = groups.tables.find((g) => g.name === 'dbo.LegacyLog');
    assert.ok(legacy, 'dbo.LegacyLog has a card');
    assert.equal(legacy.self?.status, 'OnlyInTarget');
    assert.equal(core.groupStatus(legacy).text, 'ตารางเกินมาทั้งตาราง');

    // The procedures that differ in their SET options only get the hint, and no other row does.
    const hinted = rows.filter((r) => core.setOptionsHint(core.parseDetail(r)).length > 0).map((r) => r.obj);
    assert.ok(hinted.includes('dbo.pAnsiOff'), hinted.join(', '));
    for (const name of hinted) assert.match(rows.find((r) => r.obj === name)?.detail ?? '', /^SetOptions: source [^\n]*$/);
  });

  await t.test('incomplete: the report says which side could not be read in full', () => {
    // The target as a login without VIEW DEFINITION reads it: flagged, and without some objects.
    const hidden = readSnapshot(before.files.targetSnapshot);
    hidden.canViewDefinition = false;
    for (const [category, key] of [['Stored procedure', 'dbo.pGetOrder'], ['View', 'dbo.vOrders'], ['Trigger', '(database trigger)|trDdlChanged']] as const) {
      assert.ok(hidden.categories[category]?.[key], `the target snapshot has ${key}`);
      delete hidden.categories[category]?.[key];
    }
    const file = path.join(path.dirname(before.files.targetSnapshot), 'hidden.target.snapshot.json');
    writeFileSync(file, JSON.stringify(hidden), 'utf8');
    const incomplete = compare({ dir: 'report', name: 'incomplete', source, targetSnapshot: file });
    const { script, rows, say } = checkReport(incomplete, sourceSnapshot, hidden);
    assert.equal(script.META.perspective, 'sync');
    assert.equal(script.META.noViewDefinition.length, 1);
    assert.equal(script.META.noViewDefinition[0]?.[0], 'target');
    assert.ok(script.META.noViewDefinition[0]?.[1], 'the login that read the target');
    assert.equal(script.META.warnings.length, 1);
    assert.equal(rows.find((r) => r.obj === 'dbo.pGetOrder')?.status, 'OnlyInSource');

    // What the sync script of this comparison writes as comments, the page says as such.
    const syncScript = readFileSync(incomplete.files.sync, 'utf8');
    // A new table: what stands on it waits for its CREATE TABLE.
    assert.equal(rows.find((r) => r.obj === 'dbo.Shipments')?.status, 'OnlyInSource');
    assert.match(syncScript, /^-- Run this only if the CREATE TABLE of dbo\.Shipments above succeeded: /m);
    assert.match(say('dbo.Shipments'), /sync จะสร้างทั้งตาราง พร้อมคอลัมน์และ primary key ส่วน index, check constraint, foreign key ของมัน sync เขียนเป็นหมายเหตุให้ทำเอง/);
    assert.doesNotMatch(say('dbo.Shipments'), /รวมทั้ง index/);
    // A check without a name: the same one may be there under a generated name.
    const unnamed = 'dbo.Customers (check: (len([Name])>(0)))';
    assert.equal(rows.find((r) => r.obj === unnamed)?.status, 'OnlyInSource');
    assert.match(syncScript, /^-- Run this only if dbo\.Customers does not have this check yet [^\n]*: ALTER TABLE \[dbo\]\.\[Customers\] WITH CHECK ADD CHECK /m);
    assert.doesNotMatch(syncScript, /^ALTER TABLE \[dbo\]\.\[Customers\] WITH CHECK ADD CHECK /m);
    assert.match(say(unnamed), /^check นี้ไม่มีชื่อ .*sync จึงเขียนคำสั่งสร้างไว้เป็นหมายเหตุให้ทำเอง$/);
    assert.doesNotMatch(say(unnamed), /sync จะสร้างให้/);
    // A check with a name is a statement, and said to be one.
    assert.match(syncScript, /^ALTER TABLE \[dbo\]\.\[Orders\] WITH CHECK ADD CONSTRAINT \[CK_Orders_Amount\] CHECK /m);
    assert.equal(say('dbo.Orders.CK_Orders_Amount'), 'ปลายทางยังไม่มี check constraint นี้ sync จะสร้างให้');
    // A hidden procedure reads as new: a plain CREATE, which fails when it is there.
    assert.match(say('dbo.pGetOrder'), /CREATE ธรรมดา/);
  });

  await t.test('drift: an older snapshot against a database is read as a timeline', () => {
    // The target as it was read, against the source database: every difference the other way round.
    const drifted = compare({ dir: 'report', name: 'drift', sourceSnapshot: before.files.targetSnapshot, target: source });
    const html = readFileSync(drifted.files.html, 'utf8');
    const script = runScript<ReportScript>(html, '{ META, DATA, createReportCore }');
    assert.equal(script.META.perspective, 'timeline');
    const core = script.createReportCore(script.META);
    assert.equal(core.TIMELINE, true);
    assert.equal(core.KIND['OnlyInSource']?.t, 'หายไป');
    const rows = core.toRows(script.DATA);
    const groups = core.groupRows(rows, script.META.categories);
    assert.equal([...groups.tables, ...groups.others].reduce((n, g) => n + g.items.length + (g.self ? 1 : 0), 0), rows.length);
    // What the sync report called extra in the target was there before and is gone now.
    assert.equal(rows.find((r) => r.obj === 'dbo.LegacyLog')?.status, 'OnlyInSource');
    for (const r of rows) assert.doesNotMatch(core.sentence(r, core.parseDetail(r), { self: null }), /sync|ต้นแบบ|ปลายทาง/, r.obj);
  });

  await t.test('edge: names and values that are hard to read', () => {
    const edgeSource = `${DB_PREFIX}report_edge_src`;
    const edgeTarget = `${DB_PREFIX}report_edge_tgt`;
    buildFixture('edge', edgeSource, edgeTarget);
    const edge = compare({ dir: 'report', name: 'edge', source: edgeSource, target: edgeTarget });
    assert.equal(edge.exitCode, 1, edge.log);
    const { groups, rows, say, blocks } = checkReport(edge, readSnapshot(edge.files.sourceSnapshot), readSnapshot(edge.files.targetSnapshot));
    assert.ok(groups.tables.length > 0 && groups.others.length > 0);
    // This fixture is the one with changes the script leaves to do by hand: a computed column
    // (twice), a primary key, a function of another type, a trigger on another table.
    assert.ok(blocks.checked >= 9 && blocks.commented >= 5, JSON.stringify(blocks));

    // dbo.Pnn.Twice is a computed column whose NOT NULL differs: the sync script cannot alter it
    // and writes a comment. The row holds nothing that says the column is computed, so the page
    // cannot know: it must not say flatly that the sync script changes it.
    const syncScript = readFileSync(edge.files.sync, 'utf8');
    assert.equal(rows.find((r) => r.obj === 'dbo.Pnn.Twice')?.detail, 'Nullable: source NOT NULL, target NULL');
    assert.match(syncScript, /^-- dbo\.Pnn\.Twice: [^\n]*\r?\n-- Not scripted: SQL Server cannot ALTER the type, collation or NULL \/ NOT NULL of a computed column/m);
    assert.doesNotMatch(syncScript, /^ALTER TABLE \[dbo\]\.\[Pnn\]/m);
    assert.match(say('dbo.Pnn.Twice'), /ถ้าเป็นคอลัมน์คำนวณ .*sync จะเขียนเป็นหมายเหตุให้ทำเองแทน\)$/);
    // The computed definition itself differs: that the page sees.
    assert.match(say('dbo.Items.Total'), /^IDENTITY และสูตรคำนวณแก้ด้วยคำสั่งไม่ได้ .*เป็นหมายเหตุให้ทำเอง$/);
    // A synonym for an object in another database: a comment, said without "if".
    assert.match(syncScript, /^-- Not run: dbo\.synRemote is a synonym for an object in another database or on another server/m);
    assert.match(say('dbo.synRemote'), /^synonym นี้ชี้ไปฐานอื่นหรือ server อื่น .*เป็นหมายเหตุให้ตรวจแล้วทำเอง$/);
    assert.doesNotMatch(say('dbo.synRemote'), /sync จะ/);
  });

  await t.test('batch: the index says the same four words', () => {
    const dir = path.join(OUT, 'report', 'batch');
    mkdirSync(dir, { recursive: true });
    // The same server on both sides: the database against itself, and one that is not there.
    const run = runEngine(['-SourceServer', TEST_SERVER, '-TargetServer', TEST_SERVER, '-Databases', `${source},${DB_PREFIX}report_missing`, '-OutputPath', dir]);
    assert.equal(run.exitCode, 2, run.log);
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /<html lang="th">/);
    assert.ok(!html.includes('__INDEX_JSON__') && !html.includes(LOST_CHARACTER));
    loadsNothing(html);
    const page = runScript<IndexScript>(html, '{ INDEX, createIndexCore }');
    assert.equal(page.INDEX.source, TEST_SERVER);
    assert.deepEqual(plain(page.INDEX.rows), [
      { database: source, report: `${source}.html`, error: '', onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0, incomplete: [] },
      { database: `${DB_PREFIX}report_missing`, report: '', error: 'database not found on the source server', onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0, incomplete: [] },
    ]);
    const core = page.createIndexCore();
    const [same, missing] = page.INDEX.rows.map((r) => core.rowHtml(r));
    // (A name may break after an underscore: the marks for that are not part of it.)
    assert.match((same ?? '').replace(/<wbr>/g, ''), new RegExp(`<a href="${source}\\.html">${source}</a>`));
    assert.match(same ?? '', /<span class="ok">ตรงกัน<\/span>/);
    assert.match(missing ?? '', /เทียบไม่สำเร็จ: database not found on the source server/);
    assert.doesNotMatch(missing ?? '', /<a /);
  });
});

// ---------------------------------------------------------------------------------------------
// The index of a batch
// ---------------------------------------------------------------------------------------------

interface IndexRow {
  database: string;
  report: string;
  error: string;
  onlyInSource: number;
  onlyInTarget: number;
  different: number;
  unverified: number;
  incomplete: string[];
}

interface IndexScript {
  INDEX: { source: string; target: string; rows: IndexRow[] };
  createIndexCore(): {
    KIND: { key: string; cls: string; sym: string; t: string; d: string }[];
    resultHtml(row: IndexRow): string;
    rowHtml(row: IndexRow): string;
  };
}

test('report: the index of a batch uses the words of the report, and "the same" only when everything was read', () => {
  const template = readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8');
  const page = runScript<IndexScript>(template.replace('__INDEX_JSON__', () => 'null'), '{ INDEX, createIndexCore }');
  const core = page.createIndexCore();
  // The same four words, colours and descriptions as the report of one database.
  assert.deepEqual(plain(core.KIND).map((k) => `${k.key} ${k.cls} ${k.sym} ${k.t}`), ['onlyInSource add + ต้องเพิ่ม', 'onlyInTarget del − มีเกิน', 'different chg ~ ต้องแก้', 'unverified unk ? ตรวจไม่ได้']);
  const statuses = ['OnlyInSource', 'OnlyInTarget', 'Different', 'Unverified'];
  core.KIND.forEach((k, i) => assert.equal(k.d, sync.KIND[statuses[i] ?? '']?.d, k.key));

  const zero: IndexRow = { database: 'a<b', report: 'a_b.html', error: '', onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0, incomplete: [] };
  assert.equal(core.resultHtml(zero), '<span class="ok">ตรงกัน</span>');
  assert.equal(core.resultHtml({ ...zero, onlyInSource: 2, different: 1, unverified: 4 }), 'ต่างกัน 3 รายการ');
  // Nothing differs in what could be compared: never "the same".
  assert.equal(core.resultHtml({ ...zero, unverified: 1 }), 'ไม่พบความต่างในส่วนที่ตรวจได้');
  const incomplete = core.resultHtml({ ...zero, incomplete: ['source', 'target'] });
  assert.doesNotMatch(incomplete, /ตรงกัน/);
  assert.match(incomplete, /ผลไม่ครบ: ไม่มีสิทธิ์ VIEW DEFINITION ฝั่งต้นแบบ และ ปลายทาง/);
  assert.match(core.resultHtml({ ...zero, onlyInTarget: 1, incomplete: ['target'] }), /^ต่างกัน 1 รายการ<span class="inc">ผลไม่ครบ: [^<]*ฝั่งปลายทาง<\/span>$/);
  // A database that could not be compared has no numbers and no link; its error is escaped.
  const failed = core.rowHtml({ ...zero, report: '', error: 'cannot open <db>' });
  assert.match(failed, /เทียบไม่สำเร็จ: cannot open &lt;db&gt;/);
  assert.doesNotMatch(failed, /<a |class="num /);
  // The counts carry their words; a name is escaped.
  const counted = core.rowHtml({ ...zero, onlyInSource: 3, unverified: 1 });
  assert.match(counted, /<a href="a_b\.html">a&lt;b<\/a>/);
  assert.match(counted, /<span class="num add"><b>3<\/b> ต้องเพิ่ม<\/span><span class="num zero"><b>0<\/b> มีเกิน<\/span><span class="num zero"><b>0<\/b> ต้องแก้<\/span><span class="num unk"><b>1<\/b> ตรวจไม่ได้<\/span>/);
});
