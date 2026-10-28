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
    CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_Orders_CreatedAt DEFAULT (sysdatetime())
);
GO
CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);
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
-- Data that must survive sync + rollback.
INSERT INTO dbo.Customers (Name, Email) VALUES (N'ลูกค้า ทดสอบ', 'test@example.com');
INSERT INTO dbo.Orders (Id, CustomerId, Name, Amount) VALUES (1, 1, N'first', 5.00);
GO
