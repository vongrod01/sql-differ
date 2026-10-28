-- edge fixture, source side. Every object here has a counterpart in target.sql, which says what
-- the comparison should make of the pair.
ALTER DATABASE CURRENT SET COMPATIBILITY_LEVEL = 150;
GO
CREATE TABLE dbo.Items (
    Id int NOT NULL PRIMARY KEY,
    Code varchar(20) NOT NULL,
    Title nvarchar(100) NULL,
    Status nvarchar(20) NOT NULL DEFAULT (N'รอดำเนินการ'),
    Qty int NOT NULL,
    Price decimal(10,2) NOT NULL,
    Total AS (Qty * Price),
    CONSTRAINT CK_Items_Code CHECK (LEN(Code) > 0)
);
GO
CREATE INDEX IX_Items_Title ON dbo.Items (Title) WHERE Title IS NOT NULL;
GO
CREATE TABLE dbo.Pairs (A int NULL, B int NULL);
GO
CREATE PROCEDURE dbo.pSpaces AS SELECT  1 AS  One;
GO
CREATE OR ALTER PROCEDURE dbo.pCreateOrAlter AS SELECT 1 AS One;
GO
CREATE PROCEDURE dbo.pCase AS SELECT 1 AS One;
GO
CREATE PROCEDURE dbo.pSecret WITH ENCRYPTION AS SELECT 1 AS One;
GO
CREATE FUNCTION dbo.fKind () RETURNS TABLE AS RETURN SELECT 1 AS One;
GO
CREATE TYPE dbo.IdList AS TABLE (Id int NOT NULL PRIMARY KEY);
GO
CREATE SYNONYM dbo.synRemote FOR otherdb_dev.dbo.Orders;
GO
-- What SSMS creates for database diagrams, marked with its extended property: never compared.
CREATE TABLE dbo.sysdiagrams (
    name sysname NOT NULL,
    principal_id int NOT NULL,
    diagram_id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    version int NULL,
    definition varbinary(max) NULL,
    CONSTRAINT UK_principal_name UNIQUE (principal_id, name)
);
GO
EXEC sys.sp_addextendedproperty @name = N'microsoft_database_tools_support', @value = 1,
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'sysdiagrams';
GO
CREATE PROCEDURE dbo.sp_helpdiagrams AS SELECT name FROM dbo.sysdiagrams;
GO
EXEC sys.sp_addextendedproperty @name = N'microsoft_database_tools_support', @value = 1,
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'PROCEDURE', @level1name = N'sp_helpdiagrams';
GO
