-- safety fixture, target side, with what the sync script must do for each pair:
-- - NCCI_Fact: columnstore with other columns -> the script cannot write a columnstore index, so
--   it must not drop the existing one either
-- - IX_FactToColumnstore: rowstore here, columnstore in source -> same: kept, and the rollback
--   script has nothing to undo
-- - IX_FactToRowstore: columnstore here, rowstore in source -> replaced; the rollback script cannot
--   write the columnstore index back and says so
-- - IX_Stock_Code: unique in source, and the rows here repeat a code -> the create fails
--   (Msg 1505) and the existing index must still be there
-- - CK_StateOnly: disabled here, and a row breaks it -> enabling fails (Msg 547), the constraint
--   stays, disabled
-- - CK_Changed: other expression, and a row breaks the new one -> the add fails (Msg 547) and the
--   existing constraint must still be there
-- - the unnamed check on Size: disabled here only -> enabled under the name it has here
-- - FK_Child_Parent: disabled in source only -> disabled, not rebuilt
-- - Typed.Amount: bigint in source, with a default and an index on it -> the script drops the
--   default to change the type, the index makes the change fail (Msg 5074, 4922), and the default
--   must still be there
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_Fact ON dbo.Fact (Id, A);
GO
CREATE NONCLUSTERED INDEX IX_FactToColumnstore ON dbo.FactToColumnstore (Id);
GO
CREATE NONCLUSTERED COLUMNSTORE INDEX IX_FactToRowstore ON dbo.FactToRowstore (Id, A);
GO
CREATE INDEX IX_Stock_Code ON dbo.Stock (Code);
GO
ALTER TABLE dbo.Stock ADD CONSTRAINT CK_StateOnly CHECK (Qty >= 0);
ALTER TABLE dbo.Stock ADD CONSTRAINT CK_Changed CHECK (Price >= 0);
ALTER TABLE dbo.Stock ADD CHECK (Size > 0);
GO
ALTER TABLE dbo.Stock NOCHECK CONSTRAINT CK_StateOnly;
DECLARE @unnamed sysname = (SELECT name FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.Stock') AND is_system_named = 1);
DECLARE @disable nvarchar(max) = N'ALTER TABLE dbo.Stock NOCHECK CONSTRAINT ' + QUOTENAME(@unnamed);
EXEC (@disable);
GO
-- Row 1 breaks the source's rules: Qty below 0 (CK_StateOnly is off here), Price 0 (allowed by
-- this side's CK_Changed, not by the source's), and both rows share a code.
INSERT INTO dbo.Stock (Id, Qty, Price, Code, Size) VALUES (1, -1, 0, 'a', 1), (2, 5, 10, 'a', 2);
GO
