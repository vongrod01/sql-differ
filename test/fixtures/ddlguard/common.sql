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
-- Refuses ALTER TRIGGER, its own included. Enabled on both sides; the source has another text.
CREATE TRIGGER trSelf ON DATABASE FOR ALTER_TRIGGER
AS
BEGIN
    RAISERROR('trSelf: triggers are not altered here', 16, 1);
    ROLLBACK;
END
GO
