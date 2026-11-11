-- safety fixture, source side. target.sql says what the sync script must do with each pair.
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Fact ON dbo.Fact (Id, A, B);
GO
CREATE NONCLUSTERED COLUMNSTORE INDEX IX_FactToColumnstore ON dbo.FactToColumnstore (Id, A);
GO
CREATE NONCLUSTERED INDEX IX_FactToRowstore ON dbo.FactToRowstore (Id);
GO
CREATE UNIQUE INDEX IX_Stock_Code ON dbo.Stock (Code);
GO
ALTER TABLE dbo.Stock ADD CONSTRAINT CK_StateOnly CHECK (Qty >= 0);
ALTER TABLE dbo.Stock ADD CONSTRAINT CK_Changed CHECK (Price > 0);
ALTER TABLE dbo.Stock ADD CHECK (Size > 0);
GO
ALTER TABLE dbo.Child NOCHECK CONSTRAINT FK_Child_Parent;
GO
-- Another type for a column with a default and an index: both have to go first.
DROP INDEX IX_Typed_Amount ON dbo.Typed;
ALTER TABLE dbo.Typed DROP CONSTRAINT DF_Typed_Amount;
ALTER TABLE dbo.Typed ALTER COLUMN Amount bigint NOT NULL;
ALTER TABLE dbo.Typed ADD CONSTRAINT DF_Typed_Amount DEFAULT (1) FOR Amount;
CREATE INDEX IX_Typed_Amount ON dbo.Typed (Amount);
GO
-- Comes after everything that fails in the sync script: it is created only when no failed
-- statement left a transaction open.
CREATE PROCEDURE dbo.pAfter AS SELECT 1 AS One;
GO
