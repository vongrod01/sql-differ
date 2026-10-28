-- core fixture, source side (development): everything here is newer than the target.
CREATE SCHEMA rpt;
GO
CREATE TYPE dbo.tPhone FROM varchar(20) NULL;
GO
-- New tables: one with a foreign key to an existing table and a column of the new type, one with
-- most column types the sync script has to write out.
CREATE TABLE dbo.Shipments (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Shipments PRIMARY KEY,
    OrderId int NOT NULL CONSTRAINT FK_Shipments_Orders REFERENCES dbo.Orders (Id),
    Phone dbo.tPhone NULL,
    Note nvarchar(200) NULL
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
    cComputed AS (cTiny * 2) PERSISTED
);
GO
-- Changed columns: wider and NOT NULL, another collation, another default, a new column.
ALTER TABLE dbo.Orders ALTER COLUMN Name nvarchar(100) NOT NULL;
ALTER TABLE dbo.Customers ALTER COLUMN Email varchar(100) COLLATE SQL_Latin1_General_CP1_CI_AS NULL;
ALTER TABLE dbo.Orders DROP CONSTRAINT DF_Orders_Amount;
ALTER TABLE dbo.Orders ADD CONSTRAINT DF_Orders_Amount DEFAULT (1) FOR Amount;
ALTER TABLE dbo.Customers ADD Phone dbo.tPhone NULL;
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
CREATE SEQUENCE dbo.seqShipment AS bigint START WITH 1000;
GO
DROP SYNONYM dbo.synOrders;
CREATE SYNONYM dbo.synOrders FOR dbo.vOrders;
GO
