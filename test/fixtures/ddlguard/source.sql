-- What the source has and the target does not: an index, a procedure, three database triggers
-- (one of them refuses CREATE TRIGGER and DROP TRIGGER), another text for trSelf and for trNoDrop,
-- trGuard enabled, and trHold disabled.
-- First of all: nothing below would run while trHold is enabled.
DISABLE TRIGGER trHold ON DATABASE;
GO
CREATE INDEX IX_Items_Name ON dbo.Items (Name);
GO
CREATE PROCEDURE dbo.pItems AS SELECT Id, Name, Qty FROM dbo.Items;
GO
-- By name these two sort before and after the two triggers that refuse statements.
CREATE TRIGGER trAaa ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
CREATE TRIGGER trZeta ON DATABASE FOR DROP_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
-- Created after them: from here on no trigger is created or dropped in this database.
CREATE TRIGGER trBlock ON DATABASE FOR CREATE_TRIGGER, DROP_TRIGGER
AS
BEGIN
    RAISERROR('trBlock: no trigger is created or dropped here', 16, 1);
    ROLLBACK;
END
GO
-- A trigger fires on its own ALTER: trSelf is disabled while its text is changed, and that of
-- trNoDrop.
DISABLE TRIGGER trSelf ON DATABASE;
GO
ALTER TRIGGER trNoDrop ON DATABASE FOR DROP_PROCEDURE, DROP_INDEX
AS
BEGIN
    RAISERROR('trNoDrop: nothing is dropped here (source)', 16, 1);
    ROLLBACK;
END
GO
ALTER TRIGGER trSelf ON DATABASE FOR ALTER_TRIGGER
AS
BEGIN
    RAISERROR('trSelf: triggers are not altered here (source)', 16, 1);
    ROLLBACK;
END
GO
ENABLE TRIGGER trSelf ON DATABASE;
GO
-- Last: from here on no DDL statement runs in this database at all.
ENABLE TRIGGER trGuard ON DATABASE;
GO
