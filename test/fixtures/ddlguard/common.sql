-- A database whose DDL is watched by database triggers that refuse a statement: RAISERROR, then
-- ROLLBACK, which ends the batch with Msg 3609. Both sides start with the two below.
CREATE TABLE dbo.Items (
    Id int NOT NULL CONSTRAINT PK_Items PRIMARY KEY,
    Name nvarchar(50) NOT NULL,
    Qty int NOT NULL
);
GO
INSERT INTO dbo.Items (Id, Name, Qty) VALUES (1, N'a', 1);
GO
-- Refuses every DDL statement of the database while it is enabled. Disabled here, on both sides:
-- the source enables it at its very end.
CREATE TRIGGER trGuard ON DATABASE FOR DDL_DATABASE_LEVEL_EVENTS
AS
BEGIN
    RAISERROR('trGuard: DDL is frozen in this database', 16, 1);
    ROLLBACK;
END
GO
DISABLE TRIGGER trGuard ON DATABASE;
GO
-- Refuses the drop of a procedure or an index. Enabled on both sides; the source has another
-- text. A rollback script has to drop the index and the procedure the sync script created: it
-- must not enable this one again before it has.
CREATE TRIGGER trNoDrop ON DATABASE FOR DROP_PROCEDURE, DROP_INDEX
AS
BEGIN
    RAISERROR('trNoDrop: nothing is dropped here', 16, 1);
    ROLLBACK;
END
GO
-- Refuses ALTER TRIGGER, its own included. Enabled on both sides; the source has another text.
CREATE TRIGGER trSelf ON DATABASE FOR ALTER_TRIGGER
AS
BEGIN
    RAISERROR('trSelf: triggers are not altered here', 16, 1);
    ROLLBACK;
END
GO
-- The target's own hold on DDL: refuses every DDL statement, and is enabled, on both sides, from
-- here on (so it is the last statement of this file). The source disables it with its first
-- statement and leaves it so: it differs in nothing but its state, and it is the TARGET that has
-- it enabled. A sync script must disable it before its first statement, not with the other
-- database triggers at its end; and a rollback script, which enables it again with its last
-- statement, must disable it first when it is run a second time.
CREATE TRIGGER trHold ON DATABASE FOR DDL_DATABASE_LEVEL_EVENTS
AS
BEGIN
    RAISERROR('trHold: this database takes no DDL', 16, 1);
    ROLLBACK;
END
GO
