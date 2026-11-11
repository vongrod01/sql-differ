// What the tests of an incomplete comparison look at in the target (the core fixture plus
// test/fixtures/incomplete): the objects a login without VIEW DEFINITION does not see, which the
// scripts must neither replace, add to, nor drop. Used with a snapshot made to look like such a
// login's (engine-incomplete.test.ts) and with a real one (engine-restricted.test.ts).
import assert from 'node:assert/strict';
import { query } from './sql.js';

// Three objects of the target. dbo.pGetOrder: has it its own text (from the fixture's common.sql),
// the source's, or is it gone? dbo.trOrders_Insert, which is disabled in the source: is it enabled
// here? dbo.synOrders, which is for dbo.vOrders in the source: is it still for dbo.Orders?
export function hiddenObjects(target: string): string {
  const run = query([
    "SELECT CONCAT('pGetOrder: ', ISNULL((SELECT CASE WHEN definition LIKE '%SELECT Id, Name, Amount FROM dbo.Orders%' THEN 'its own text' ELSE 'the text of the source' END",
    "FROM sys.sql_modules WHERE object_id = OBJECT_ID(N'dbo.pGetOrder')), 'dropped'),",
    "'; trOrders_Insert: ', ISNULL((SELECT CASE WHEN is_disabled = 1 THEN 'disabled' ELSE 'enabled' END FROM sys.triggers WHERE name = N'trOrders_Insert'), 'dropped'),",
    "'; synOrders: ', ISNULL((SELECT base_object_name FROM sys.synonyms WHERE name = N'synOrders'), 'dropped'))",
  ].join(' '), target);
  assert.ok(run.ok, run.output);
  return run.output.trim();
}

// As the fixtures leave them.
export const UNTOUCHED = 'pGetOrder: its own text; trOrders_Insert: enabled; synOrders: [dbo].[Orders]';

// What is on the two target tables whose contents the comparison cannot see: the check
// constraints of dbo.Customers (its unnamed check reads without an expression) and everything on
// dbo.Hidden (the whole table is invisible).
export function hiddenChildren(target: string): string[] {
  const run = query([
    "SELECT CONCAT('check ', OBJECT_NAME(parent_object_id), '.', CASE WHEN is_system_named = 1 THEN '(unnamed)' ELSE name END, ': ', definition)",
    "FROM sys.check_constraints WHERE parent_object_id IN (OBJECT_ID(N'dbo.Customers'), OBJECT_ID(N'dbo.Hidden'))",
    "UNION ALL SELECT CONCAT('index ', OBJECT_NAME(object_id), '.', name) FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Hidden') AND type > 0",
  ].join(' '), target);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

export const CHILDREN_UNTOUCHED = ['check Customers.(unnamed): (len([Name])>(0))', 'check Hidden.(unnamed): ([V]>(0))', 'index Hidden.PK_Hidden'];

// The numbers of the error messages in the output of a script run with sqlcmd.
export function messageNumbers(output: string): string[] {
  return [...output.matchAll(/^Msg (\d+),/gm)].map((m) => m[1] ?? '');
}
