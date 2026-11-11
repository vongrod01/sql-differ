-- computed fixture, source side: columns that computed columns use get another type, length or
-- nullability. SQL Server does not alter a column a computed column depends on (Msg 5074, then
-- Msg 4922), so the sync script writes those changes as a group of comments to run by hand.

-- 1. A wider type; the computed column is the same on both sides (its type follows).
CREATE TABLE dbo.Calc (
    Id int NOT NULL CONSTRAINT PK_Calc PRIMARY KEY,
    Amount decimal(12,2) NOT NULL,
    WithVat AS (Amount * 1.07)
);
GO
-- 2. A persisted computed column declared NOT NULL, on a column with a default (the default has
--    to be dropped for the type change as well); a column that only gets longer; a column that
--    only becomes NOT NULL. The target has one more computed column on Qty that the source lacks.
CREATE TABLE dbo.CalcP (
    Id int NOT NULL CONSTRAINT PK_CalcP PRIMARY KEY,
    Qty bigint NOT NULL CONSTRAINT DF_CalcP_Qty DEFAULT (1),
    Twice AS (Qty * 2) PERSISTED NOT NULL,
    Label varchar(20) NULL,
    LabelUp AS (UPPER(Label)),
    Flag int NOT NULL,
    FlagPlus AS (Flag + 1) PERSISTED
);
GO
-- 3. A computed column the target does not have yet, on a column that changes: the sync script
--    must alter the column first and add the computed column after it.
CREATE TABLE dbo.CalcNew (
    Id int NOT NULL CONSTRAINT PK_CalcNew PRIMARY KEY,
    Amount decimal(12,2) NOT NULL,
    WithVat AS (Amount * 1.07),
    Note varchar(10) NULL
);
GO
