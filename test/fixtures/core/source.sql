-- core fixture, source side (development): everything here is newer than the target.
CREATE SCHEMA rpt;
GO
CREATE TYPE dbo.tPhone FROM varchar(20) NULL;
GO
-- A table type with more than column names and types: IDENTITY, a default, a computed column, a
-- primary key (that ignores duplicate keys), a unique constraint, a check, and a column with a
-- collation of its own next to one with the database's. The sync script must write them all.
CREATE TYPE dbo.tRows AS TABLE (
    Id int IDENTITY(10,5) NOT NULL PRIMARY KEY WITH (IGNORE_DUP_KEY = ON),
    Code varchar(10) COLLATE Latin1_General_BIN NOT NULL,
    Qty int NOT NULL DEFAULT (1) CHECK (Qty > 0),
    Twice AS (Qty * 2) PERSISTED NOT NULL,
    Note nvarchar(20) NULL,
    UNIQUE (Code DESC, Qty)
);
GO
CREATE SEQUENCE dbo.seqShipment AS bigint START WITH 1000;
GO
-- A sequence of a decimal type: the precision is part of the type. Written without it ("decimal"
-- alone is decimal(18,0)) the limits of this one do not fit, and CREATE SEQUENCE fails (Msg 11708).
CREATE SEQUENCE dbo.seqBig AS decimal(28,0) START WITH 1;
GO
-- New tables: one with a foreign key to an existing table, a column of the new type and a default
-- that takes its value from the new sequence (a comparison of tables and columns only still has
-- to create that type and that sequence), one with most column types the sync script has to
-- write out.
CREATE TABLE dbo.Shipments (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Shipments PRIMARY KEY,
    OrderId int NOT NULL CONSTRAINT FK_Shipments_Orders REFERENCES dbo.Orders (Id),
    Phone dbo.tPhone NULL,
    Note nvarchar(200) NULL,
    Seq bigint NOT NULL CONSTRAINT DF_Shipments_Seq DEFAULT (NEXT VALUE FOR dbo.seqShipment)
);
GO
CREATE TABLE dbo.AllTypes (
    Id bigint IDENTITY(100,5) NOT NULL CONSTRAINT PK_AllTypes PRIMARY KEY,
    cBit bit NOT NULL CONSTRAINT DF_AllTypes_cBit DEFAULT (0),
    cTiny tinyint NULL,
    cSmall smallint NULL,
    cDec decimal(18,4) NULL,
    cNum numeric(9,2) NULL,
    cMoney money NULL,
    cFloat float NULL,
    cReal real NULL,
    cDate date NULL,
    cDateTime datetime NULL,
    cDateTime2 datetime2(7) NULL,
    cOffset datetimeoffset(3) NULL,
    cTime time(0) NULL,
    cChar char(10) NULL,
    cVarMax varchar(max) NULL,
    cNChar nchar(5) COLLATE Thai_BIN NULL,
    cNVarMax nvarchar(max) NULL,
    cBin binary(8) NULL,
    cVarBin varbinary(max) NULL,
    cGuid uniqueidentifier NOT NULL CONSTRAINT DF_AllTypes_cGuid DEFAULT (newsequentialid()),
    cXml xml NULL,
    cVariant sql_variant NULL,
    cRowVersion rowversion NOT NULL,
    cComputed AS (cTiny * 2) PERSISTED,
    cComputedNN AS (Id + 1) PERSISTED NOT NULL
);
GO
-- Changed columns: wider and NOT NULL, another collation, another default, a new column, a column
-- of an alias type that allows NULL now.
ALTER TABLE dbo.Orders ALTER COLUMN Name nvarchar(100) NOT NULL;
ALTER TABLE dbo.Customers ALTER COLUMN Email varchar(100) COLLATE SQL_Latin1_General_CP1_CI_AS NULL;
ALTER TABLE dbo.Orders DROP CONSTRAINT DF_Orders_Amount;
ALTER TABLE dbo.Orders ADD CONSTRAINT DF_Orders_Amount DEFAULT (1) FOR Amount;
ALTER TABLE dbo.Customers ADD Phone dbo.tPhone NULL;
ALTER TABLE dbo.Orders ALTER COLUMN AmountWithVat ADD PERSISTED;
ALTER TABLE dbo.Codes ALTER COLUMN Code dbo.tCode NULL;
-- Another type for a column with a default: the default is in the way (Msg 5074) and has to be
-- dropped first, here and in the scripts.
ALTER TABLE dbo.Orders DROP CONSTRAINT DF_Orders_Qty;
ALTER TABLE dbo.Orders ALTER COLUMN Qty bigint NOT NULL;
ALTER TABLE dbo.Orders ADD CONSTRAINT DF_Orders_Qty DEFAULT (1) FOR Qty;
GO
-- A changed index (INCLUDE), a new index, a new foreign key, new checks (one unnamed).
DROP INDEX IX_Orders_CustomerId ON dbo.Orders;
CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId) INCLUDE (Amount);
CREATE INDEX IX_Orders_CreatedAt ON dbo.Orders (CreatedAt DESC);
ALTER TABLE dbo.Orders ADD CONSTRAINT FK_Orders_Customers FOREIGN KEY (CustomerId) REFERENCES dbo.Customers (Id);
ALTER TABLE dbo.Orders ADD CONSTRAINT CK_Orders_Amount CHECK (Amount >= 0);
ALTER TABLE dbo.Customers ADD CHECK (LEN(Name) > 0);
GO
ALTER VIEW dbo.vOrders
AS
SELECT o.Id, o.CustomerId, o.Name, o.Amount FROM dbo.Orders AS o;
GO
-- A Thai column alias in a string literal (Bytebase's parser fails on this).
ALTER PROCEDURE dbo.pGetOrder @Id int
AS
SELECT Id, Name AS 'ชื่อรายการ', Amount FROM dbo.Orders WHERE Id = @Id;
GO
CREATE PROCEDURE dbo.pNewOrder @Id int, @CustomerId int, @Name nvarchar(100)
AS
INSERT INTO dbo.Orders (Id, CustomerId, Name) VALUES (@Id, @CustomerId, @Name);
GO
ALTER FUNCTION dbo.fOrderTotal (@CustomerId int)
RETURNS decimal(18,2)
AS
BEGIN
    RETURN ISNULL((SELECT SUM(Amount) FROM dbo.Orders WHERE CustomerId = @CustomerId), 0);
END;
GO
CREATE FUNCTION dbo.fOrdersOf (@CustomerId int)
RETURNS TABLE
AS
RETURN SELECT Id, Name, Amount FROM dbo.Orders WHERE CustomerId = @CustomerId;
GO
CREATE VIEW rpt.vDailyTotal
AS
SELECT CAST(CreatedAt AS date) AS OrderDate, SUM(Amount) AS Total
FROM dbo.Orders
GROUP BY CAST(CreatedAt AS date);
GO
DISABLE TRIGGER dbo.trOrders_Insert ON dbo.Orders;
GO
ALTER SEQUENCE dbo.seqInvoice INCREMENT BY 10;
GO
DROP SYNONYM dbo.synOrders;
CREATE SYNONYM dbo.synOrders FOR dbo.vOrders;
GO
-- Modules whose stored text does not say what the catalog says: sp_rename and ALTER SCHEMA ...
-- TRANSFER leave sys.sql_modules as it was written. The sync script must create each one under
-- its catalog name (pRenamed, rpt.vMoved) and the trigger on the table as it is called now.
CREATE PROCEDURE dbo.pOldName
AS
SELECT 1 AS One;
GO
EXEC sp_rename 'dbo.pOldName', 'pRenamed';
GO
CREATE VIEW vMoved
AS
SELECT 1 AS One;
GO
ALTER SCHEMA rpt TRANSFER dbo.vMoved;
GO
CREATE TABLE dbo.AuditOld (
    Id int NOT NULL CONSTRAINT PK_Audit PRIMARY KEY,
    Note nvarchar(100) NULL
);
GO
CREATE TRIGGER dbo.trAudit ON dbo.AuditOld AFTER INSERT
AS
SET NOCOUNT ON;
GO
EXEC sp_rename 'dbo.AuditOld', 'Audit';
GO
-- Modules created under other SET options than the scripts' own (ANSI_NULLS ON, QUOTED_IDENTIFIER
-- ON). The options are stored with the module and change how it runs (@Name = NULL finds rows
-- under ANSI_NULLS OFF; "..." is a string under QUOTED_IDENTIFIER OFF), so the sync script must
-- create each one under the options it has here. pAnsiOff has the same text in the target, where
-- it was created under ANSI_NULLS ON.
SET ANSI_NULLS OFF;
GO
CREATE PROCEDURE dbo.pAnsiOffNew @Name nvarchar(50)
AS
SELECT Id FROM dbo.Orders WHERE Name = @Name;
GO
CREATE PROCEDURE dbo.pAnsiOff @Name nvarchar(50)
AS
SELECT Id FROM dbo.Orders WHERE Name = @Name;
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER OFF;
GO
CREATE PROCEDURE dbo.pQuotedOff
AS
SELECT "a double-quoted string" AS Txt;
GO
SET QUOTED_IDENTIFIER ON;
GO
-- Indexed views. ALTER VIEW (and so CREATE OR ALTER VIEW) drops every index of the view, without
-- a word: a script that alters a view has to create its indexes again, the clustered one first.
-- vSalesTotals: another definition, the same clustered index as the target and a new nonclustered
-- one. vSalesByRegion: the view is the same; one index has another column list and one is new.
-- vSalesBig: a new view with its clustered index.
ALTER VIEW dbo.vSalesTotals WITH SCHEMABINDING
AS
SELECT Id, Region, Amount FROM dbo.Sales WHERE Amount >= 0;
GO
CREATE UNIQUE CLUSTERED INDEX CIX_vSalesTotals ON dbo.vSalesTotals (Id);
CREATE NONCLUSTERED INDEX IX_vSalesTotals_Region ON dbo.vSalesTotals (Region);
CREATE UNIQUE CLUSTERED INDEX CIX_vSalesByRegion ON dbo.vSalesByRegion (Region);
CREATE NONCLUSTERED INDEX IX_vSalesByRegion_Total ON dbo.vSalesByRegion (Total) INCLUDE (Cnt);
CREATE NONCLUSTERED INDEX IX_vSalesByRegion_Cnt ON dbo.vSalesByRegion (Cnt);
GO
CREATE VIEW dbo.vSalesBig WITH SCHEMABINDING
AS
SELECT Id, Amount FROM dbo.Sales WHERE Amount > 1000;
GO
CREATE UNIQUE CLUSTERED INDEX CIX_vSalesBig ON dbo.vSalesBig (Id);
GO
-- Database triggers: one for more events than in the target, one that is disabled here and
-- otherwise the same, one that is new. The sync script writes them after everything else.
ALTER TRIGGER trDdlChanged ON DATABASE FOR CREATE_SYNONYM, DROP_SYNONYM
AS
SET NOCOUNT ON;
GO
DISABLE TRIGGER trDdlState ON DATABASE;
GO
CREATE TRIGGER trDdlNew ON DATABASE FOR DROP_SYNONYM
AS
SET NOCOUNT ON;
GO
