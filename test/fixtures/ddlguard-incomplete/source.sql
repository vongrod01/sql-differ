-- What the source has and the target does not: an index, a procedure and four database triggers.
-- And two database triggers the target has as well, with its own text: the test hides those from
-- the comparison (see target.sql), so they read as "only in source" too.
CREATE INDEX IX_Items_Name ON dbo.Items (Name);
GO
CREATE PROCEDURE dbo.pItems AS SELECT Id, Name FROM dbo.Items;
GO
-- By name these sort before and after the one that refuses statements.
CREATE TRIGGER trAaa ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
CREATE TRIGGER trZeta ON DATABASE FOR DROP_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
CREATE TRIGGER trNewOff ON DATABASE FOR DROP_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
DISABLE TRIGGER trNewOff ON DATABASE;
GO
CREATE TRIGGER trHiddenOff ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; /* (source) */ END
GO
CREATE TRIGGER trHiddenOn ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; /* (source) */ END
GO
DISABLE TRIGGER trHiddenOn ON DATABASE;
GO
ALTER TRIGGER trOld ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; /* (source) */ END
GO
-- Last: from here on no trigger is created, altered or dropped in this database, and no index
-- is dropped.
CREATE TRIGGER trBlock ON DATABASE FOR CREATE_TRIGGER, ALTER_TRIGGER, DROP_TRIGGER, DROP_INDEX
AS
BEGIN
    RAISERROR('trBlock: no trigger is created, altered or dropped here, and no index dropped', 16, 1);
    ROLLBACK;
END
GO
