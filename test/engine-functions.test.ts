// Single functions of the engine, called through test/support/Invoke-EngineFunction.ps1 (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './support/engine.js';
import { callEngineFunction, engineValues } from './support/ps.js';

test('engine function harness: arguments and results keep their text, errors come back per case', () => {
  assert.deepEqual(
    engineValues('Get-QuotedName', [['Orders'], ['we]ird'], ['ลูกค้า'], ['a<b>&c']]),
    ['[Orders]', '[we]]ird]', '[ลูกค้า]', '[a<b>&c]'],
  );
  // A JSON object arrives as a dictionary, as the items of a snapshot loaded from a file do.
  assert.deepEqual(
    engineValues('Get-SqlPart', [[{ Sql: { Name: 'x' } }, 'Name'], [{ Sql: { Name: 'x' } }, 'Missing'], [{ Sql: null }, 'Name']]),
    ['x', null, null],
  );
  const [known, unknown] = callEngineFunction('Resolve-Categories', [[['sp', 'table']], [['nope']]]);
  assert.deepEqual(known, { ok: true, value: ['Table', 'Stored procedure'] });
  assert.equal(unknown?.ok, false);
  assert.match(unknown?.ok === false ? unknown.error : '', /Unknown category 'nope'/);
});

test('engine function harness: engine switches can be set per call', () => {
  const cases = [['Select', 'select']];
  assert.deepEqual(engineValues('Test-SameText', cases), [false]);
  assert.deepEqual(engineValues('Test-SameText', cases, { variables: { IgnoreCase: true } }), [true]);
});

// ---------------------------------------------------------------------------------------------
// Module headers. The name in a module's stored text is whatever its last CREATE or ALTER said:
// sp_rename and ALTER SCHEMA ... TRANSFER leave it, and a name written without a schema says
// nothing about where the object is. The sync script writes the catalog name instead.
// ---------------------------------------------------------------------------------------------

// The engine's marker for a definition that exists but cannot be read ($HiddenDefinition).
const HIDDEN = '-- definition not available (encrypted, CLR, or no VIEW DEFINITION permission)';

interface ModuleItem {
  Definition: string;
  Sql: Record<string, string> | null;
  Props: Record<string, string>;
}

// A module as a live snapshot has it: `parent` is the table of a trigger.
function moduleItem(definition: string, schema: string, name: string, parent?: [string, string]): ModuleItem {
  return {
    Definition: definition,
    Sql: { Schema: schema, Name: name, ObjectType: parent ? 'TR' : 'P', ParentSchema: parent?.[0] ?? '', ParentObject: parent?.[1] ?? '' },
    Props: parent ? { Table: `${parent[0]}.${parent[1]}` } : {},
  };
}

// A module of a snapshot saved before the engine kept name parts: only its key says what it is.
function oldModuleItem(definition: string, table?: string): ModuleItem {
  return { Definition: definition, Sql: null, Props: table ? { Table: table } : {} };
}

type ModuleCase = [what: string, item: ModuleItem, key: string, expected: string | RegExp];

// A string is the script expected; a pattern is the "-- Not scripted" comment expected instead.
function checkModuleScripts(cases: ModuleCase[], createOnly: boolean): void {
  const results = engineValues('ConvertTo-ModuleScript', cases.map(([, item, key]) => [item, key, createOnly])) as { Script?: string; Comment?: string }[];
  cases.forEach(([what, , , expected], i) => {
    const result = results[i] ?? {};
    if (typeof expected === 'string') assert.deepEqual(result, { Script: expected }, what);
    else {
      assert.equal(result.Script, undefined, `${what}: must not be scripted`);
      assert.match(result.Comment ?? '', expected, what);
      assert.match(result.Comment ?? '', /^-- Not scripted: [^\r\n]+$/, what);
    }
  });
}

test('engine: a module header that names the catalog object stays as it was written', () => {
  checkModuleScripts([
    ['plain', moduleItem('CREATE PROCEDURE dbo.p AS SELECT 1;', 'dbo', 'p'), 'dbo.p', 'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1;'],
    ['PROC, lower case', moduleItem('create proc dbo.p as select 1', 'dbo', 'p'), 'dbo.p', 'create OR ALTER proc dbo.p as select 1'],
    ['already CREATE OR ALTER, after a comment', moduleItem('-- note\r\n/* more */\r\nCREATE OR ALTER VIEW [dbo].[v] AS SELECT 1', 'dbo', 'v'), 'dbo.v',
      '-- note\r\n/* more */\r\nCREATE OR ALTER VIEW [dbo].[v] AS SELECT 1'],
    // What SQL Server stores for a module created with CREATE OR ALTER.
    ['stored form of CREATE OR ALTER', moduleItem('CREATE   FUNCTION dbo.f () RETURNS int AS BEGIN RETURN 1 END', 'dbo', 'f'), 'dbo.f',
      'CREATE OR ALTER   FUNCTION dbo.f () RETURNS int AS BEGIN RETURN 1 END'],
    ['double-quoted names', moduleItem('CREATE FUNCTION "dbo"."f ""g"""() RETURNS int AS BEGIN RETURN 1 END', 'dbo', 'f "g"'), 'dbo.f "g"',
      'CREATE OR ALTER FUNCTION "dbo"."f ""g"""() RETURNS int AS BEGIN RETURN 1 END'],
    ['a ] in the name', moduleItem("CREATE PROC [dbo].[we]]ird 'name] AS SELECT 1", 'dbo', "we]ird 'name"), "dbo.we]ird 'name",
      "CREATE OR ALTER PROC [dbo].[we]]ird 'name] AS SELECT 1"],
    ['a dot inside brackets', moduleItem('CREATE VIEW [dbo].[a.b] AS SELECT 1 AS x', 'dbo', 'a.b'), 'dbo.a.b', 'CREATE OR ALTER VIEW [dbo].[a.b] AS SELECT 1 AS x'],
    ['Thai name, bare', moduleItem('CREATE VIEW dbo.ลูกค้า AS SELECT 1 AS x', 'dbo', 'ลูกค้า'), 'dbo.ลูกค้า', 'CREATE OR ALTER VIEW dbo.ลูกค้า AS SELECT 1 AS x'],
    ['Thai name, bracketed', moduleItem('CREATE VIEW [dbo].[ลูกค้า ใหม่] AS SELECT 1 AS x', 'dbo', 'ลูกค้า ใหม่'), 'dbo.ลูกค้า ใหม่',
      'CREATE OR ALTER VIEW [dbo].[ลูกค้า ใหม่] AS SELECT 1 AS x'],
    ['name followed by its parameters', moduleItem('CREATE FUNCTION dbo.f(@a int) RETURNS int AS BEGIN RETURN @a END', 'dbo', 'f'), 'dbo.f',
      'CREATE OR ALTER FUNCTION dbo.f(@a int) RETURNS int AS BEGIN RETURN @a END'],
    ['trigger on its table', moduleItem('CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;', 'dbo', 'tr', ['dbo', 't']), 'dbo.tr',
      'CREATE OR ALTER TRIGGER dbo.tr ON dbo.t AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;'],
    ['trigger without any space', moduleItem('CREATE TRIGGER[dbo].[tr]ON[dbo].[t]AFTER INSERT AS RETURN', 'dbo', 'tr', ['dbo', 't']), 'dbo.tr',
      'CREATE OR ALTER TRIGGER[dbo].[tr]ON[dbo].[t]AFTER INSERT AS RETURN'],
    // T-SQL nests block comments: the first */ does not end the outer one.
    ['nested comments before and inside the header', moduleItem('/* a /* b */ c */\r\nCREATE /**** x /* y */ * / ****/ PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p',
      '/* a /* b */ c */\r\nCREATE OR ALTER /**** x /* y */ * / ****/ PROCEDURE dbo.p AS SELECT 1'],
  ], false);
});

test('engine: a module header that names something else gets the catalog name', () => {
  checkModuleScripts([
    ['renamed with sp_rename', moduleItem('CREATE PROCEDURE dbo.pOldName\r\nAS\r\nSELECT 1 AS One;', 'dbo', 'pRenamed'), 'dbo.pRenamed',
      'CREATE OR ALTER PROCEDURE [dbo].[pRenamed]\r\nAS\r\nSELECT 1 AS One;'],
    ['written without a schema, then moved', moduleItem('CREATE VIEW vMoved AS SELECT 1 AS One', 'rpt', 'vMoved'), 'rpt.vMoved', 'CREATE OR ALTER VIEW [rpt].[vMoved] AS SELECT 1 AS One'],
    ['written without a schema, in dbo', moduleItem('CREATE VIEW v AS SELECT 1 AS One', 'dbo', 'v'), 'dbo.v', 'CREATE OR ALTER VIEW [dbo].[v] AS SELECT 1 AS One'],
    ['no space before the name', moduleItem('CREATE PROCEDURE[dbo].[pOld]AS SELECT 1', 'dbo', 'pNew'), 'dbo.pNew', 'CREATE OR ALTER PROCEDURE[dbo].[pNew]AS SELECT 1'],
    ['comments between the tokens', moduleItem('CREATE/*a*/PROCEDURE /*b*/ dbo /*c*/ . --d\r\n pOld --e\r\nAS SELECT 1', 'dbo', 'pNew'), 'dbo.pNew',
      'CREATE OR ALTER/*a*/PROCEDURE /*b*/ [dbo].[pNew] --e\r\nAS SELECT 1'],
    ['another case than the catalog', moduleItem('CREATE PROCEDURE DBO.P AS SELECT 1', 'dbo', 'p'), 'dbo.p', 'CREATE OR ALTER PROCEDURE [dbo].[p] AS SELECT 1'],
    ['the catalog name needs quoting', moduleItem('CREATE PROCEDURE dbo.pOld AS SELECT 1', 'my schema', 'a]b'), 'my schema.a]b', 'CREATE OR ALTER PROCEDURE [my schema].[a]]b] AS SELECT 1'],
    // Only the header: the body may call the procedure by the name it had.
    ['the body is not touched', moduleItem('CREATE PROCEDURE dbo.pOld AS EXEC dbo.pOld; -- CREATE PROCEDURE dbo.pOld', 'dbo', 'pNew'), 'dbo.pNew',
      'CREATE OR ALTER PROCEDURE [dbo].[pNew] AS EXEC dbo.pOld; -- CREATE PROCEDURE dbo.pOld'],
    ['trigger on a renamed table', moduleItem('CREATE TRIGGER dbo.trAudit ON dbo.AuditOld AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;', 'dbo', 'trAudit', ['dbo', 'Audit']), 'dbo.trAudit',
      'CREATE OR ALTER TRIGGER dbo.trAudit ON [dbo].[Audit] AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;'],
    ['trigger and table both renamed', moduleItem('CREATE TRIGGER trOld ON AuditOld FOR INSERT AS RETURN', 'dbo', 'trNew', ['dbo', 'Audit']), 'dbo.trNew',
      'CREATE OR ALTER TRIGGER [dbo].[trNew] ON [dbo].[Audit] FOR INSERT AS RETURN'],
    ['renamed trigger without any space', moduleItem('CREATE TRIGGER[dbo].[trOld]ON[dbo].[t]AFTER INSERT AS RETURN', 'dbo', 'trNew', ['dbo', 't']), 'dbo.trNew',
      'CREATE OR ALTER TRIGGER[dbo].[trNew]ON[dbo].[t]AFTER INSERT AS RETURN'],
  ], false);
});

test('engine: a module that must not replace an existing one is written as a plain CREATE', () => {
  checkModuleScripts([
    ['CREATE stays', moduleItem('CREATE PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', 'CREATE PROCEDURE dbo.p AS SELECT 1'],
    ['OR ALTER is taken out', moduleItem('CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', 'CREATE PROCEDURE dbo.p AS SELECT 1'],
    ['with comments inside it, and the name fixed', moduleItem('CREATE /*x*/ OR --y\r\n ALTER VIEW v AS SELECT 1 AS One', 'rpt', 'v'), 'rpt.v', 'CREATE VIEW [rpt].[v] AS SELECT 1 AS One'],
    ['trigger on a renamed table', moduleItem('CREATE OR ALTER TRIGGER dbo.tr ON dbo.tOld AFTER INSERT AS RETURN', 'dbo', 'tr', ['dbo', 't']), 'dbo.tr',
      'CREATE TRIGGER dbo.tr ON [dbo].[t] AFTER INSERT AS RETURN'],
  ], true);
});

test('engine: a module whose header cannot be read is not scripted', () => {
  for (const createOnly of [false, true]) {
    checkModuleScripts([
      ['definition not readable', moduleItem(HIDDEN, 'dbo', 'p'), 'dbo.p', /the source definition is not readable/],
      ['ALTER, not CREATE', moduleItem('ALTER PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['only a comment', moduleItem('-- CREATE PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['not a module', moduleItem('CREATE TABLE dbo.p (a int)', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['no name', moduleItem('CREATE PROCEDURE', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['a keyword that only starts like one', moduleItem('CREATE PROCEDURES dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['empty', moduleItem('', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['trigger without ON', moduleItem('CREATE TRIGGER dbo.tr AFTER INSERT AS RETURN', 'dbo', 'tr', ['dbo', 't']), 'dbo.tr', /the table of the trigger/],
      ['a comment that never ends', moduleItem('/* CREATE PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
      ['the name inside a nested comment', moduleItem('CREATE PROCEDURE /* /* */ dbo.p AS SELECT 1', 'dbo', 'p'), 'dbo.p', /copy it from the report/],
    ], createOnly);
  }
});

// The catalog name is what goes into the header. An item that does not have all of it (a snapshot
// file someone edited, or of a format this engine does not know) must not become [].[] or keep the
// table its trigger text happens to name.
test('engine: a module whose name parts are incomplete is not scripted', () => {
  const item = (definition: string, sql: Record<string, string>): ModuleItem => ({ Definition: definition, Sql: sql, Props: {} });
  for (const createOnly of [false, true]) {
    checkModuleScripts([
      ['no schema', item('CREATE PROCEDURE dbo.p AS SELECT 1', { Schema: '', Name: 'p', ObjectType: 'P' }), 'dbo.p', /name of the object is missing/],
      ['no name', item('CREATE PROCEDURE dbo.p AS SELECT 1', { Schema: 'dbo', ObjectType: 'P' }), 'dbo.p', /name of the object is missing/],
      ['nothing', item('CREATE VIEW dbo.v AS SELECT 1 AS x', {}), 'dbo.v', /name of the object is missing/],
      ['trigger without its table', item('CREATE TRIGGER dbo.tr ON dbo.tOld AFTER INSERT AS RETURN', { Schema: 'dbo', Name: 'tr', ObjectType: 'TR', ParentSchema: '', ParentObject: '' }), 'dbo.tr', /table of the trigger is missing/],
      ['trigger with half its table', item('CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT AS RETURN', { Schema: 'dbo', Name: 'tr', ObjectType: 'TR', ParentSchema: 'dbo' }), 'dbo.tr', /table of the trigger is missing/],
    ], createOnly);
  }
});

// A header that cannot be read must be given up at once. Matched with a lazy "up to some later */",
// each of these comments could end at any of the ones after it, and the regex tried them all.
test('engine: reading a module header stays fast on a text full of comments', () => {
  const comments = Array.from({ length: 5000 }, (_, i) => `/* block ${i} */ -- line ${i}`).join('\r\n');
  const start = Date.now();
  checkModuleScripts([
    ['no header after the comments', moduleItem(`${comments}\r\nALTER PROCEDURE dbo.p AS SELECT 1`, 'dbo', 'p'), 'dbo.p', /copy it from the report/],
    ['a header after the comments', moduleItem(`${comments}\r\nCREATE PROCEDURE dbo.pOld AS SELECT 1`, 'dbo', 'pNew'), 'dbo.pNew', `${comments}\r\nCREATE OR ALTER PROCEDURE [dbo].[pNew] AS SELECT 1`],
  ], false);
  const seconds = (Date.now() - start) / 1000;
  assert.ok(seconds < 30, `took ${seconds.toFixed(1)} s`);
});

// The comparison reads the header of every module on both sides, and falls back to a second
// pattern (only CREATE [OR ALTER]) when the first does not fit. That one must give up as fast: it
// took minutes on the first of these texts while it still matched a comment up to "some later */".
test('engine: comparing definitions stays fast on a text full of comments', () => {
  const comments = Array.from({ length: 5000 }, (_, i) => `/* block ${i} */ -- line ${i}`).join('\r\n');
  const texts = [
    // No CREATE after the comments: neither pattern fits.
    `${comments}\r\nALTER PROCEDURE dbo.p AS SELECT 1`,
    // CREATE, but not of a module: only the fallback fits.
    `${comments}\r\nCREATE   OR ALTER TABLE dbo.t (a int)`,
    `${comments}\r\nCREATE PROCEDURE dbo.p AS SELECT 1`,
    // A comment that never ends.
    `${comments}\r\n/* CREATE PROCEDURE dbo.p AS SELECT 1`,
  ];
  const start = Date.now();
  const comparable = engineValues('Get-ComparableDefinition', texts.map((text) => [text])) as string[];
  const seconds = (Date.now() - start) / 1000;
  assert.ok(seconds < 30, `took ${seconds.toFixed(1)} s`);
  const lead = comments.replace(/\r\n/g, '\n');
  assert.deepEqual(comparable, [
    `${lead}\nALTER PROCEDURE dbo.p AS SELECT 1`,
    `${lead}\nCREATE TABLE dbo.t (a int)`,
    `${lead}\nCREATE PROCEDURE <name> AS SELECT 1`,
    `${lead}\n/* CREATE PROCEDURE dbo.p AS SELECT 1`,
  ]);
});

test('engine: a module of a snapshot without name parts is replayed only when its header names it', () => {
  checkModuleScripts([
    ['header is the key', oldModuleItem('CREATE PROCEDURE dbo.p AS SELECT 1'), 'dbo.p', 'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1'],
    ['quoted header is the key', oldModuleItem('CREATE VIEW [dbo].[a.b] AS SELECT 1 AS x'), 'dbo.a.b', 'CREATE OR ALTER VIEW [dbo].[a.b] AS SELECT 1 AS x'],
    // Keys are matched without regard to case, so this is the object the key names.
    ['another case than the key', oldModuleItem('CREATE PROCEDURE DBO.P AS SELECT 1'), 'dbo.p', 'CREATE OR ALTER PROCEDURE DBO.P AS SELECT 1'],
    ['renamed', oldModuleItem('CREATE PROCEDURE dbo.pOld AS SELECT 1'), 'dbo.pNew', /older version without name details/],
    ['no schema in the header', oldModuleItem('CREATE PROCEDURE p AS SELECT 1'), 'dbo.p', /older version without name details/],
    ['trigger on its table', oldModuleItem('CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT AS RETURN', 'dbo.t'), 'dbo.tr', 'CREATE OR ALTER TRIGGER dbo.tr ON dbo.t AFTER INSERT AS RETURN'],
    ['trigger on a renamed table', oldModuleItem('CREATE TRIGGER dbo.tr ON dbo.tOld AFTER INSERT AS RETURN', 'dbo.t'), 'dbo.tr', /older version without name details/],
    ['definition not readable', oldModuleItem(HIDDEN), 'dbo.p', /the source definition is not readable/],
  ], false);
});

// Both sides of a comparison are the same object by catalog name already, so the name written in
// the header (and the table a trigger names) must not make their definitions differ: after a sync
// the target's text carries the catalog name and the source's still the earlier one.
test('engine: the name in a module header is not part of the comparison', () => {
  const same: [string, string, string][] = [
    ['renamed', 'CREATE PROCEDURE dbo.pOldName\r\nAS\r\nSELECT 1 AS One;', 'CREATE   PROCEDURE [dbo].[pRenamed]\r\nAS\r\nSELECT 1 AS One;'],
    ['moved', 'CREATE VIEW vMoved\nAS SELECT 1 AS One', 'CREATE OR ALTER VIEW [rpt].[vMoved]\nAS SELECT 1 AS One'],
    ['quoting only', 'CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END', 'CREATE FUNCTION "dbo" . [f]() RETURNS int AS BEGIN RETURN 1 END'],
    ['trigger on a renamed table', 'CREATE TRIGGER dbo.trAudit ON dbo.AuditOld AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;', 'CREATE   TRIGGER dbo.trAudit ON [dbo].[Audit] AFTER INSERT\r\nAS\r\nSET NOCOUNT ON;'],
    // Also when it really is another table: that is reported as the trigger's Table property
    // (and the scripts act on that, see "a trigger that is on another table" in engine-script.test.ts).
    ['trigger on another table', 'CREATE TRIGGER dbo.tr ON dbo.A AFTER INSERT AS RETURN', 'CREATE TRIGGER dbo.tr ON dbo.B AFTER INSERT AS RETURN'],
    ['CREATE against CREATE OR ALTER, after a comment', '-- note\r\nCREATE PROCEDURE dbo.p AS SELECT 1', '-- note\nCREATE /*x*/ OR ALTER PROCEDURE dbo.p AS SELECT 1'],
    // A header the engine cannot read is still compared as before.
    ['unreadable header', 'ALTER PROCEDURE dbo.p AS SELECT 1  \r\n', 'ALTER PROCEDURE dbo.p AS SELECT 1'],
    // CREATE [OR ALTER] is still read as CREATE when the rest of the header is not a module's
    // (the fallback pattern), with nested comments and line comments between its words.
    ['CREATE OR ALTER without a name', '/* a /* b */ c */\r\nCREATE /* /* x */ */ OR -- y\r\n ALTER PROCEDURE', '/* a /* b */ c */\r\nCREATE PROCEDURE'],
    ['CREATE of something else', 'CREATE   TABLE dbo.t (a int)', 'CREATE OR ALTER TABLE dbo.t (a int)'],
  ];
  const different: [string, string, string][] = [
    ['body', 'CREATE PROCEDURE dbo.p AS SELECT 1', 'CREATE PROCEDURE dbo.p AS SELECT 2'],
    ['body that names the object', 'CREATE PROCEDURE dbo.a AS EXEC dbo.a', 'CREATE PROCEDURE dbo.b AS EXEC dbo.b'],
    ['kind of object', 'CREATE PROCEDURE dbo.p AS SELECT 1', 'CREATE VIEW dbo.p AS SELECT 1'],
    ['parameters', 'CREATE FUNCTION dbo.f(@a int) RETURNS int AS BEGIN RETURN 1 END', 'CREATE FUNCTION dbo.f(@a bigint) RETURNS int AS BEGIN RETURN 1 END'],
    ['trigger event', 'CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT AS RETURN', 'CREATE TRIGGER dbo.tr ON dbo.t AFTER UPDATE AS RETURN'],
    ['comment before the header', '-- one\r\nCREATE PROCEDURE dbo.p AS SELECT 1', '-- two\r\nCREATE PROCEDURE dbo.p AS SELECT 1'],
    ['unreadable header', 'ALTER PROCEDURE dbo.a AS SELECT 1', 'ALTER PROCEDURE dbo.b AS SELECT 1'],
  ];
  const texts = [...same, ...different].flatMap(([, a, b]) => [[a], [b]]);
  const comparable = engineValues('Get-ComparableDefinition', texts) as string[];
  [...same, ...different].forEach(([what], i) => {
    const equal = comparable[2 * i] === comparable[2 * i + 1];
    assert.equal(equal, i < same.length, `${what}: ${JSON.stringify(comparable[2 * i])} / ${JSON.stringify(comparable[2 * i + 1])}`);
  });
});

// ---------------------------------------------------------------------------------------------
// The instance named in an address. With a port ("host\DEMO,1433") SqlClient connects to whatever
// listens on that port and ignores the name, so the run must fail when another instance answers:
// its reports and scripts would carry the label of a server that was never read.
// ---------------------------------------------------------------------------------------------

test('engine: the instance name is read from an address only when a port can bypass it', () => {
  const cases: [string, string][] = [
    ['host\\DEMO,1433', 'DEMO'],
    ['tcp:host\\DEMO,1433', 'DEMO'],
    ['  192.168.1.10\\Demo_2 , 14330  ', 'Demo_2'],
    ['host.example.com\\SQL$EXPRESS,1433', 'SQL$EXPRESS'],
    // No port: SQL Browser resolves the name, so it cannot miss.
    ['host\\DEMO', ''],
    ['(localdb)\\MSSQLLocalDB', ''],
    // No instance name: nothing to check.
    ['host,1433', ''],
    ['tcp:host,1433', ''],
    ['host', ''],
    ['', ''],
    // Not a port.
    ['host\\DEMO,', ''],
    ['host\\DEMO,abc', ''],
  ];
  assert.deepEqual(engineValues('Get-RequestedInstance', cases.map(([server]) => [server])), cases.map(([, instance]) => instance));
});

test('engine: an address whose instance name another instance answered is an error', () => {
  const endpoint = (server: string) => ({ Name: 'demo', Server: server });
  const results = callEngineFunction('Assert-RequestedInstance', [
    [endpoint('host\\DEMO,1433'), 'EXAM', 'HOST\\EXAM'],
    // The default instance answered on the port.
    [endpoint('host\\DEMO,1433'), 'MSSQLSERVER', 'HOST'],
    [endpoint('host\\DEMO,1433'), 'DEMO', 'HOST\\DEMO'],
    // Instance names ignore case.
    [endpoint('host\\demo,1433'), 'DEMO', 'HOST\\DEMO'],
    [endpoint('host\\MSSQLSERVER,1433'), 'MSSQLSERVER', 'HOST'],
    // Nothing named, or no port: nothing to compare.
    [endpoint('host,1433'), 'EXAM', 'HOST\\EXAM'],
    [endpoint('host\\DEMO'), 'DEMO', 'HOST\\DEMO'],
    [endpoint('(localdb)\\MSSQLLocalDB'), 'LOCALDB#12345678', 'PC\\LOCALDB#12345678'],
  ]);
  const errors = results.map((r) => (r.ok ? '' : r.error));
  assert.match(errors[0] ?? '', /host\\DEMO,1433/);
  assert.match(errors[0] ?? '', /instance DEMO/);
  assert.match(errors[0] ?? '', /HOST\\EXAM/);
  assert.match(errors[0] ?? '', /port/);
  assert.match(errors[1] ?? '', /HOST \(instance MSSQLSERVER\)/);
  assert.deepEqual(errors.slice(2), ['', '', '', '', '', '']);
});

// ---------------------------------------------------------------------------------------------
// Synonyms. A base object named with three or four parts is in another database or on another
// server, and those names are usually different in every environment.
// ---------------------------------------------------------------------------------------------

test('engine: the parts of an object name are counted outside brackets and quotes', () => {
  const cases: [string, number][] = [
    ['[dbo].[Orders]', 2],
    ['dbo.Orders', 2],
    ['Orders', 1],
    ['[otherdb].[dbo].[Orders]', 3],
    ['otherdb.dbo.Orders', 3],
    // The schema left out: still another database.
    ['otherdb..Orders', 3],
    ['[srv].[otherdb].[dbo].[Orders]', 4],
    // Dots inside a name are not separators.
    ['[dbo].[a.b.c]', 2],
    ['[my.db].[dbo].[t]', 3],
    ['"dbo"."a.b"', 2],
    // An escaped bracket or quote does not end the name.
    ['[dbo].[a]].b]', 2],
    ['[a]]].[b]', 2],
    ['"a"".b"."c"', 2],
    ['', 1],
  ];
  assert.deepEqual(engineValues('Get-NamePartCount', cases.map(([name]) => [name])), cases.map(([, count]) => count));
});

// ---------------------------------------------------------------------------------------------
// Where the engine checks the instance. No test server listens on a TCP port (LocalDB does not), so
// the functions that open connections run here against stubs: every connection is answered by
// instance EXAM of HOST, and opening the databases named in $FailOpen fails.
// ---------------------------------------------------------------------------------------------

const INSTANCE_STUBS = `
$script:harnessFailOpen = @()
function Open-SqlConnection {
    param($Endpoint, $Database)
    if ($script:harnessFailOpen -contains $Database) { throw ('Cannot open database "{0}" requested by the login.' -f $Database) }
    $connection = New-Object PSObject
    Add-Member -InputObject $connection -MemberType ScriptMethod -Name Dispose -Value { }
    return $connection
}
function Get-ServerIdentity { param($Endpoint, $Connection) return @{ ServerName = 'HOST\\EXAM'; InstanceName = 'EXAM' } }
function Get-SchemaSnapshot { param($Connection) return @{ Meta = @{ ServerName = '' } } }
function Invoke-SqlQuery { param($Connection, $Query) return @() }
function Test-ReadSide($Server, $Database, $FailOpen) {
    $script:harnessFailOpen = @($FailOpen)
    try { [void](Read-SideSnapshot (New-Side (New-Endpoint -Server $Server) $Database)); return 'read' }
    catch { return $_.Exception.Message }
}
function Test-DatabaseList($Server) {
    $script:harnessFailOpen = @()
    try { [void]@(Get-DatabaseList (New-Endpoint -Server $Server)); return 'listed' }
    catch { return $_.Exception.Message }
}
`;

test('engine: reading a database and listing databases stop when another instance answered', () => {
  const wrongInstance = /^The address host\\DEMO,1433 names instance DEMO, but HOST\\EXAM \(instance EXAM\) answered/;
  const cannotOpen = 'Cannot open database "x" requested by the login.';

  const read = engineValues('Test-ReadSide', [
    ['host\\DEMO,1433', 'x', []],
    ['host\\EXAM,1433', 'x', []],
    ['(localdb)\\MSSQLLocalDB', 'x', []],
    // The database is not on the instance that answered (it is on DEMO): the reason to give is
    // the instance, not "cannot open database".
    ['host\\DEMO,1433', 'x', ['x']],
    // The right instance, no instance named, or a server that cannot be identified (master does
    // not open either): the error of the database itself.
    ['host\\EXAM,1433', 'x', ['x']],
    ['host,1433', 'x', ['x']],
    ['host\\DEMO,1433', 'x', ['x', 'master']],
  ], { setup: INSTANCE_STUBS }) as string[];
  assert.match(read[0] ?? '', wrongInstance);
  assert.deepEqual(read.slice(1, 3), ['read', 'read']);
  assert.match(read[3] ?? '', wrongInstance);
  assert.deepEqual(read.slice(4), [cannotOpen, cannotOpen, cannotOpen]);

  // A batch asks for the list of databases first.
  const listed = engineValues('Test-DatabaseList', [['host\\DEMO,1433'], ['host\\EXAM,1433'], ['host,1433']], { setup: INSTANCE_STUBS }) as string[];
  assert.match(listed[0] ?? '', wrongInstance);
  assert.deepEqual(listed.slice(1), ['listed', 'listed']);
});

// ---------------------------------------------------------------------------------------------
// Dates. Get-Date -Format follows the culture of the session: on a machine set to Thai, 'yyyy' is
// the Buddhist year (2569 for 2026), which went into report headers, script headers and the names
// of report folders. Every date the engine writes goes through Get-Timestamp, which does not.
// ---------------------------------------------------------------------------------------------

const THAI_CULTURE = `
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('th-TH')
function Test-Timestamp($Format) { return @{ engine = (Get-Timestamp $Format); control = (Get-Date -Format $Format) } }
`;

test('engine: dates are written in the Gregorian calendar whatever the culture of the session', () => {
  const formats = ['yyyy', 'yyyy-MM-dd HH:mm:ss', 'yyyyMMdd_HHmmss', 's'];
  const before = new Date().getFullYear();
  const results = engineValues('Test-Timestamp', formats.map((f) => [f]), { setup: THAI_CULTURE }) as { engine: string; control: string }[];
  const after = new Date().getFullYear();
  const [year, long, stamp, sortable] = results.map((r) => r.engine);
  // The control shows the session really is Thai: the same format through Get-Date is 543 years on.
  assert.ok([before + 543, after + 543].includes(Number(results[0]?.control)), `Get-Date under th-TH: ${results[0]?.control}`);
  assert.ok([before, after].includes(Number(year)), `Get-Timestamp 'yyyy': ${year}`);
  assert.match(long ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(stamp ?? '', /^\d{8}_\d{6}$/);
  assert.match(sortable ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  for (const value of [long, stamp, sortable]) assert.ok(value?.startsWith(String(year)), `${value} starts with the year ${year}`);
});

test('engine: no date is formatted with Get-Date', () => {
  for (const file of ['Compare-Database.ps1', path.join('lib', 'SyncScript.ps1')]) {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    const found = lines.flatMap((line, i) => (/Get-Date/i.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
    assert.deepEqual(found, [], 'use Get-Timestamp');
  }
});

// ---------------------------------------------------------------------------------------------
// Batch file names. Every database of a batch writes six files named after it into one folder,
// next to the batch's own index.html / index.json and the web app's run.json, run.log and
// heartbeat. A database called "index" used to overwrite the index of the batch, one called "run"
// the app's run record, and "a.source.snapshot" the snapshot of database "a".
// ---------------------------------------------------------------------------------------------

const BATCH_NAMES = `
$script:harnessUsed = New-BatchFileSet
function Test-BaseName($Database) { return Get-BatchBaseName $Database $script:harnessUsed }
function Test-UsedCount { return $script:harnessUsed.Count }
`;

test('engine: a batch numbers only the file names that would collide', () => {
  // One folder: the cases share the set of names taken, in this order.
  const cases: [database: string, baseName: string][] = [
    // As before: the name itself, with what a file name cannot hold replaced.
    ['report', 'report'],
    ['sales 2024', 'sales_2024'],
    ['ลูกค้า', 'ลูกค้า'],
    // The second database that comes to the same file name.
    ['sales_2024', 'sales_2024-2'],
    ['sales/2024', 'sales_2024-3'],
    // A database really called what an earlier one was numbered to.
    ['sales_2024-2', 'sales_2024-2-2'],
    // The files of the batch itself and of the web app (file names ignore case).
    ['index', 'index-2'],
    ['INDEX', 'INDEX-3'],
    ['run', 'run-2'],
    // Not taken: only heartbeat (no extension) and run.log are, and no database file is called that.
    ['heartbeat', 'heartbeat'],
    // "a.source.snapshot.json" is the snapshot of a, and would be the result of a.source.snapshot.
    ['a', 'a'],
    ['a.source.snapshot', 'a.source.snapshot-2'],
    // The other way round: the later one moves, whichever it is.
    ['b.target.snapshot', 'b.target.snapshot'],
    ['b', 'b-2'],
    // Windows device names, with any extension: a file called nul.html cannot be created.
    ['nul', 'nul-2'],
    ['COM1', 'COM1-2'],
    ['Lpt9', 'Lpt9-2'],
    // The device name is what stands before the first dot, so the number goes there.
    ['con.x', 'con-2.x'],
    ['aux.sales.2024', 'aux-2.sales.2024'],
    // Only the whole word is a device.
    ['console', 'console'],
    ['com10', 'com10'],
    ['null', 'null'],
  ];
  assert.deepEqual(engineValues('Test-BaseName', cases.map(([database]) => [database]), { setup: BATCH_NAMES }), cases.map(([, baseName]) => baseName));
  // Five names taken from the start, then six files per database.
  assert.deepEqual(engineValues('Test-UsedCount', [[]], { setup: BATCH_NAMES }), [5]);
  const taken = engineValues('Test-UsedCount', [[]], { setup: `${BATCH_NAMES}\n[void](Test-BaseName 'a'); [void](Test-BaseName 'A')` });
  assert.deepEqual(taken, [5 + 6 + 6]);
});

// ---------------------------------------------------------------------------------------------
// Database triggers (CREATE TRIGGER ... ON DATABASE). No schema, and ON DATABASE is a keyword, not
// a name: every statement about one is written differently from a table's trigger.
// ---------------------------------------------------------------------------------------------

// A database trigger as a snapshot has it.
function databaseTriggerItem(definition: string, name: string): ModuleItem {
  return {
    Definition: definition,
    Sql: { Schema: '', Name: name, ObjectType: 'TR', ParentSchema: '', ParentObject: '', Scope: 'DATABASE' },
    Props: { Table: 'DATABASE' },
  };
}

test('engine: the script of a database trigger keeps ON DATABASE and writes no schema', () => {
  const key = '(database trigger)|trDdl';
  checkModuleScripts([
    ['as written', databaseTriggerItem('CREATE TRIGGER trDdl ON DATABASE FOR CREATE_SYNONYM\r\nAS\r\nSET NOCOUNT ON;', 'trDdl'), key,
      'CREATE OR ALTER TRIGGER trDdl ON DATABASE FOR CREATE_SYNONYM\r\nAS\r\nSET NOCOUNT ON;'],
    ['lower case, bracketed name', databaseTriggerItem('create trigger [trDdl] on database for DROP_SYNONYM as return', 'trDdl'), key,
      'create OR ALTER trigger [trDdl] on database for DROP_SYNONYM as return'],
    ['comments around the keyword', databaseTriggerItem('CREATE TRIGGER trDdl /*a*/ ON --b\r\n DATABASE FOR CREATE_TABLE AS RETURN', 'trDdl'), key,
      'CREATE OR ALTER TRIGGER trDdl /*a*/ ON --b\r\n DATABASE FOR CREATE_TABLE AS RETURN'],
    ['a name that needs quoting', databaseTriggerItem('CREATE TRIGGER [my trigger] ON DATABASE FOR CREATE_TABLE AS RETURN', 'my trigger'), '(database trigger)|my trigger',
      'CREATE OR ALTER TRIGGER [my trigger] ON DATABASE FOR CREATE_TABLE AS RETURN'],
    // The header spells the name another way than the catalog: the catalog's, quoted, no schema.
    ['another case than the catalog', databaseTriggerItem('CREATE TRIGGER TRDDL ON DATABASE FOR CREATE_TABLE AS RETURN', 'trDdl'), key,
      'CREATE OR ALTER TRIGGER [trDdl] ON DATABASE FOR CREATE_TABLE AS RETURN'],
    ['a schema in the header', databaseTriggerItem('CREATE TRIGGER dbo.trDdl ON DATABASE FOR CREATE_TABLE AS RETURN', 'trDdl'), key,
      'CREATE OR ALTER TRIGGER [trDdl] ON DATABASE FOR CREATE_TABLE AS RETURN'],
    ['already CREATE OR ALTER', databaseTriggerItem('CREATE OR ALTER TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN', 'trDdl'), key,
      'CREATE OR ALTER TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN'],
  ], false);

  checkModuleScripts([
    ['plain CREATE', databaseTriggerItem('CREATE OR ALTER TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN', 'trDdl'), key,
      'CREATE TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN'],
  ], true);

  for (const createOnly of [false, true]) {
    checkModuleScripts([
      // A table that is called DATABASE: the header of a table's trigger, not of this one.
      ['a bracketed DATABASE', databaseTriggerItem('CREATE TRIGGER trDdl ON [DATABASE] AFTER INSERT AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['a quoted DATABASE', databaseTriggerItem('CREATE TRIGGER trDdl ON "DATABASE" AFTER INSERT AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['a schema before it', databaseTriggerItem('CREATE TRIGGER trDdl ON dbo.DATABASE AFTER INSERT AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['a server trigger', databaseTriggerItem('CREATE TRIGGER trDdl ON ALL SERVER FOR CREATE_DATABASE AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['no ON at all', databaseTriggerItem('CREATE TRIGGER trDdl FOR CREATE_TABLE AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['not a trigger', databaseTriggerItem('CREATE PROCEDURE trDdl AS RETURN', 'trDdl'), key, /does not read CREATE TRIGGER \.\.\. ON DATABASE/],
      ['definition not readable', databaseTriggerItem(HIDDEN, 'trDdl'), key, /the source definition is not readable/],
      ['no name', databaseTriggerItem('CREATE TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN', ''), key, /name of the object is missing/],
    ], createOnly);
  }
});

const DROP_WRAPPERS = `
function Test-DropModule($Item, $IfExists) { return Get-DropModuleSql $Item -IfExists:([bool]$IfExists) }
function Test-TriggerNames($Item) { return ('{0} ON {1}' -f (Get-ModuleName $Item), (Get-TriggerTarget $Item)) }
`;

test('engine: dropping, disabling and enabling a database trigger say ON DATABASE', () => {
  const ddl = databaseTriggerItem('CREATE TRIGGER trDdl ON DATABASE FOR CREATE_TABLE AS RETURN', 'we]ird');
  const onTable = moduleItem('CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT AS RETURN', 'dbo', 'tr', ['dbo', 't']);
  const procedure = moduleItem('CREATE PROCEDURE dbo.p AS SELECT 1', 'dbo', 'p');
  assert.deepEqual(engineValues('Test-DropModule', [[ddl, false], [ddl, true], [onTable, false], [onTable, true], [procedure, true]], { setup: DROP_WRAPPERS }), [
    'DROP TRIGGER [we]]ird] ON DATABASE;',
    'DROP TRIGGER IF EXISTS [we]]ird] ON DATABASE;',
    'DROP TRIGGER [dbo].[tr];',
    'DROP TRIGGER IF EXISTS [dbo].[tr];',
    'DROP PROCEDURE IF EXISTS [dbo].[p];',
  ]);
  assert.deepEqual(engineValues('Test-TriggerNames', [[ddl], [onTable]], { setup: DROP_WRAPPERS }), ['[we]]ird] ON DATABASE', '[dbo].[tr] ON [dbo].[t]']);
});
