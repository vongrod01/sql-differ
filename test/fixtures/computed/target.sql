-- computed fixture, target side: see source.sql.
CREATE TABLE dbo.Calc (
    Id int NOT NULL CONSTRAINT PK_Calc PRIMARY KEY,
    Amount decimal(10,2) NOT NULL,
    WithVat AS (Amount * 1.07)
);
GO
CREATE TABLE dbo.CalcP (
    Id int NOT NULL CONSTRAINT PK_CalcP PRIMARY KEY,
    Qty int NOT NULL CONSTRAINT DF_CalcP_Qty DEFAULT (1),
    Twice AS (Qty * 2) PERSISTED NOT NULL,
    Label varchar(10) NULL,
    LabelUp AS (UPPER(Label)),
    Flag int NULL,
    FlagPlus AS (Flag + 1) PERSISTED,
    -- Only here: the sync script leaves it, and it uses Qty too.
    Half AS (Qty / 2)
);
GO
CREATE TABLE dbo.CalcNew (
    Id int NOT NULL CONSTRAINT PK_CalcNew PRIMARY KEY,
    Amount decimal(10,2) NOT NULL,
    Note varchar(10) NULL
);
GO
-- Rows that must still be there after the by-hand lines have dropped and added computed columns.
INSERT INTO dbo.Calc (Id, Amount) VALUES (1, 100.00);
INSERT INTO dbo.CalcP (Id, Qty, Label, Flag) VALUES (1, 21, 'abc', 7);
INSERT INTO dbo.CalcNew (Id, Amount, Note) VALUES (1, 50.00, 'kept');
GO
