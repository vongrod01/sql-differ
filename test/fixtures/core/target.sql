-- core fixture, target side (production): objects that exist only here. The sync script must
-- leave them alone (its DROPs are commented out).
CREATE TABLE dbo.LegacyLog (
    Id int NOT NULL CONSTRAINT PK_LegacyLog PRIMARY KEY,
    Message nvarchar(400) NULL
);
GO
ALTER TABLE dbo.Orders ADD LegacyCode varchar(10) NULL;
GO
CREATE INDEX IX_Customers_Name ON dbo.Customers (Name);
GO
CREATE PROCEDURE dbo.pLegacyCleanup
AS
DELETE FROM dbo.LegacyLog WHERE Id < 0;
GO
