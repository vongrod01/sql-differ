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
-- Another procedure under the name the source's pRenamed had before sp_rename, which is still the
-- name in that procedure's stored text. The sync script must leave this one as it is.
CREATE PROCEDURE dbo.pOldName
AS
SELECT 'target only' AS Keep;
GO
-- The same text as the source's pAnsiOff, which was created under ANSI_NULLS OFF there: only the
-- SET option differs.
SET ANSI_NULLS ON;
GO
CREATE PROCEDURE dbo.pAnsiOff @Name nvarchar(50)
AS
SELECT Id FROM dbo.Orders WHERE Name = @Name;
GO
-- Indexed views as they are in production: both views of common.sql have their clustered index,
-- and vSalesByRegion a nonclustered one that the source has with another column list.
CREATE UNIQUE CLUSTERED INDEX CIX_vSalesByRegion ON dbo.vSalesByRegion (Region);
CREATE NONCLUSTERED INDEX IX_vSalesByRegion_Total ON dbo.vSalesByRegion (Total);
CREATE UNIQUE CLUSTERED INDEX CIX_vSalesTotals ON dbo.vSalesTotals (Id);
GO
-- A database trigger that is only here: the sync script leaves it (its drop is a comment).
CREATE TRIGGER trDdlLegacy ON DATABASE FOR DROP_SYNONYM
AS
SET NOCOUNT ON;
GO
