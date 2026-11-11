-- core fixture, both sides: the schema of the last release.
CREATE TABLE dbo.Customers (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Customers PRIMARY KEY,
    Name nvarchar(100) NOT NULL,
    Email varchar(100) NULL
);
GO
CREATE TABLE dbo.Orders (
    Id int NOT NULL CONSTRAINT PK_Orders PRIMARY KEY,
    CustomerId int NULL,
    Name nvarchar(50) NULL,
    Amount decimal(10,2) NOT NULL CONSTRAINT DF_Orders_Amount DEFAULT (0),
    CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_Orders_CreatedAt DEFAULT (sysdatetime()),
    AmountWithVat AS (Amount * 1.07),
    Qty int NOT NULL CONSTRAINT DF_Orders_Qty DEFAULT (1)
);
GO
CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);
GO
-- A column of an alias type: COLLATE cannot be written for it (Msg 452).
CREATE TYPE dbo.tCode FROM varchar(20) NULL;
GO
CREATE TABLE dbo.Codes (
    Id int NOT NULL CONSTRAINT PK_Codes PRIMARY KEY,
    Code dbo.tCode NOT NULL
);
GO
CREATE VIEW dbo.vOrders
AS
SELECT o.Id, o.Name, o.Amount FROM dbo.Orders AS o;
GO
CREATE PROCEDURE dbo.pGetOrder @Id int
AS
SELECT Id, Name, Amount FROM dbo.Orders WHERE Id = @Id;
GO
CREATE FUNCTION dbo.fOrderTotal (@CustomerId int)
RETURNS decimal(18,2)
AS
BEGIN
    RETURN (SELECT SUM(Amount) FROM dbo.Orders WHERE CustomerId = @CustomerId);
END;
GO
CREATE TRIGGER dbo.trOrders_Insert ON dbo.Orders AFTER INSERT
AS
SET NOCOUNT ON;
GO
CREATE SEQUENCE dbo.seqInvoice AS int START WITH 1 INCREMENT BY 1;
GO
CREATE SYNONYM dbo.synOrders FOR dbo.Orders;
GO
-- Views that carry indexes (indexed views). The indexes themselves differ per side: see
-- source.sql and target.sql.
CREATE TABLE dbo.Sales (
    Id int NOT NULL CONSTRAINT PK_Sales PRIMARY KEY,
    Region varchar(10) NOT NULL,
    Amount int NOT NULL
);
GO
CREATE VIEW dbo.vSalesByRegion WITH SCHEMABINDING
AS
SELECT Region, SUM(Amount) AS Total, COUNT_BIG(*) AS Cnt FROM dbo.Sales GROUP BY Region;
GO
CREATE VIEW dbo.vSalesTotals WITH SCHEMABINDING
AS
SELECT Id, Region, Amount FROM dbo.Sales WHERE Amount > 0;
GO
-- Data that must survive sync + rollback.
INSERT INTO dbo.Customers (Name, Email) VALUES (N'ลูกค้า ทดสอบ', 'test@example.com');
INSERT INTO dbo.Orders (Id, CustomerId, Name, Amount) VALUES (1, 1, N'first', 5.00);
INSERT INTO dbo.Codes (Id, Code) VALUES (1, 'A1');
INSERT INTO dbo.Sales (Id, Region, Amount) VALUES (1, 'north', 10), (2, 'north', 5), (3, 'south', 2000);
GO
-- Database triggers (DDL triggers: ON DATABASE). They have no schema and are not in sys.objects.
-- These do nothing, and fire on the synonyms that the fixtures and the scripts create and drop.
CREATE TRIGGER trDdlChanged ON DATABASE FOR CREATE_SYNONYM
AS
SET NOCOUNT ON;
GO
CREATE TRIGGER trDdlState ON DATABASE FOR CREATE_SYNONYM
AS
SET NOCOUNT ON;
GO
