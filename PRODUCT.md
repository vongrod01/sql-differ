# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers on one team who edit SQL Server schema and stored procedures together on shared databases, and need to carry only their own changes to another environment. They compare two databases (same server or across servers), look at what differs, and choose which differences go into a sync script. A DBA or release owner may review the result, but the primary user is the developer who made the change.

## Product Purpose

database-diff compares the schema of SQL Server databases (tables, columns, indexes, foreign keys, checks, views, stored procedures, functions, triggers, types, sequences, synonyms) and produces a report plus a sync script and a rollback script. It also compares one database against its own earlier snapshots (schema drift) and can run comparisons on a schedule. Success means a developer can see exactly what differs, pick the objects that are theirs, and leave a script they can review and run themselves, without touching what teammates are still working on.

## Positioning

An engine that only reads and only describes: it reads the `sys.*` catalog views, never writes to any database, and never runs the scripts it generates. The person reviews the script and runs it in SSMS. Selection is per object, so one developer's change set can be separated from a teammate's on the same database.

## Operating Context

- Runs on a Windows machine with Windows PowerShell 5.1 and Node.js 22+; the web app is a local server on 127.0.0.1:4870, started from `start.cmd` or `npm start`.
- Servers are either the built-in `localhost (Windows auth)`, profiles read from mssql-mcp `.env` files, or ones added in the app (passwords encrypted with Windows DPAPI, readable only by this Windows user on this machine).
- Scheduled comparisons run through Windows Task Scheduler while the user is logged in; results land in the run history.
- Every run leaves a self-contained HTML report that is opened from the app, from disk, or sent to a colleague, plus `.sync.sql` and rollback scripts to review in SSMS.

## Capabilities and Constraints

- Single-database and batch (many databases) comparison, a run history with automatic cleanup (90 days by default), schema drift between two points in time, and scheduled jobs.
- The report groups differences by table and shows what a sync would do; rows can be ticked to build a sync and rollback script from the selection only.
- Destructive statements (DROP TABLE / COLUMN / PROCEDURE ...) are commented out in the sync script, and `ALTER COLUMN` is left for the person to check for data loss.
- The interface is bilingual with Thai as the source language and English as the second. One language choice is shared by every page, including the reports, and is kept in the browser.
- Platform is Windows only; the app is not designed to be exposed on a network.

## Brand Commitments

- Name: database-diff.
- Thai is the primary language of all text; English is the secondary option and must be complete on every page, not partial.

## Evidence on Hand

- A working app with real run history under `data/` (git-ignored, local to the machine), `README.md` describing the behaviour, and 28 test files with SQL fixtures under `test/fixtures/`.
- No customer quotes, benchmarks, public pricing, or external users: the tool is used inside the team only. Future work must not invent any.

## Product Principles

1. **Read, never write.** The tool describes changes; a person runs them. Nothing in the interface should suggest that it will execute against a database.
2. **Selective over wholesale.** The unit of work is a chosen set of objects, not the whole difference list.
3. **Accurate before reassuring.** Say what is identical, what differs, and what could not be read (for example a missing VIEW DEFINITION permission) instead of rounding toward "all good".
4. **One report that travels.** A report is a single file that works without the app or a network, so it can be opened anywhere and sent to others.
5. **Thai first, English complete.** Any new text ships in both languages and follows the shared language setting.
