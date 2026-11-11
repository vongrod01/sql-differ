-- edge fixture, target side, with what the comparison should report for each pair:
-- - database: compatibility level 140 vs 150 -> different
-- - Items: PK named here, system-named in source, same columns -> index name change only
-- - Items.ID vs Items.Id: case only -> not reported
-- - Items.Status: other Thai default -> different
-- - Items.Total: other computed expression -> different
-- - CK_Items_Code: disabled here -> different state
-- - IX_Items_Title: no filter here -> different
-- - Pairs: other column order -> reported only with -CompareColumnOrder
-- - Pnn.Twice: PERSISTED NOT NULL in source, PERSISTED here -> different, and ALTER COLUMN cannot
--   change a computed column
-- - trMoved: on MoveA in source, on MoveB here, the same text otherwise -> different (Table), and
--   ALTER cannot move a trigger
-- - pSpaces: whitespace inside the text -> different unless -IgnoreWhitespace
-- - pCreateOrAlter: CREATE vs CREATE OR ALTER -> not reported
-- - pCase: case only -> different unless -IgnoreCase
-- - pSecret: encrypted on both sides -> cannot compare (unverified)
-- - fKind: scalar here, inline table-valued in source -> different, and ALTER cannot change it
-- - IdList: bigint vs int -> different
-- - KeyList: the same columns, but no primary key here and another default -> different
-- - synRemote: other database -> different
-- - sysdiagrams, sp_helpdiagrams (source only, SSMS objects) -> not reported
CREATE TABLE dbo.Items (
    ID int NOT NULL CONSTRAINT PK_Items PRIMARY KEY,
    Code varchar(20) NOT NULL,
    Title nvarchar(100) NULL,
    Status nvarchar(20) NOT NULL DEFAULT (N'เสร็จแล้ว'),
    Qty int NOT NULL,
    Price decimal(10,2) NOT NULL,
    Total AS (Qty * Price * 1),
    CONSTRAINT CK_Items_Code CHECK (LEN(Code) > 0)
);
GO
ALTER TABLE dbo.Items NOCHECK CONSTRAINT CK_Items_Code;
GO
CREATE INDEX IX_Items_Title ON dbo.Items (Title);
GO
CREATE TABLE dbo.Pairs (B int NULL, A int NULL);
GO
CREATE TABLE dbo.MoveA (Id int NOT NULL);
CREATE TABLE dbo.MoveB (Id int NOT NULL);
GO
CREATE TRIGGER dbo.trMoved ON dbo.MoveB AFTER INSERT AS SET NOCOUNT ON;
GO
CREATE TABLE dbo.Pnn (Qty int NOT NULL, Twice AS (Qty * 2) PERSISTED);
GO
CREATE PROCEDURE dbo.pSpaces AS SELECT 1 AS One;
GO
CREATE PROCEDURE dbo.pCreateOrAlter AS SELECT 1 AS One;
GO
CREATE PROCEDURE dbo.pCase AS select 1 as one;
GO
CREATE PROCEDURE dbo.pSecret WITH ENCRYPTION AS SELECT 2 AS Two;
GO
CREATE FUNCTION dbo.fKind () RETURNS int AS BEGIN RETURN 1; END;
GO
CREATE TYPE dbo.IdList AS TABLE (Id bigint NOT NULL PRIMARY KEY);
GO
CREATE TYPE dbo.KeyList AS TABLE (Id int NOT NULL, Qty int NOT NULL DEFAULT (2));
GO
CREATE SYNONYM dbo.synRemote FOR otherdb_prod.dbo.Orders;
GO
