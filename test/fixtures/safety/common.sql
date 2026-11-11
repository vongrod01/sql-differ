-- safety fixture, both sides: tables whose indexes and constraints differ between the sides in
-- ways a sync script must not apply blindly (see source.sql and target.sql).
CREATE TABLE dbo.Fact (Id int NOT NULL, A int NULL, B int NULL);
CREATE TABLE dbo.FactToColumnstore (Id int NOT NULL, A int NULL);
CREATE TABLE dbo.FactToRowstore (Id int NOT NULL, A int NULL);
GO
CREATE TABLE dbo.Stock (
    Id int NOT NULL CONSTRAINT PK_Stock PRIMARY KEY,
    Qty int NOT NULL,
    Price decimal(10,2) NOT NULL,
    Code varchar(10) NOT NULL,
    Size int NULL
);
GO
CREATE TABLE dbo.Parent (Id int NOT NULL CONSTRAINT PK_Parent PRIMARY KEY);
GO
-- A column with a default and an index on it; the source gives it another type.
CREATE TABLE dbo.Typed (
    Id int NOT NULL CONSTRAINT PK_Typed PRIMARY KEY,
    Amount int NOT NULL CONSTRAINT DF_Typed_Amount DEFAULT (1)
);
GO
CREATE INDEX IX_Typed_Amount ON dbo.Typed (Amount);
GO
CREATE TABLE dbo.Child (
    Id int NOT NULL CONSTRAINT PK_Child PRIMARY KEY,
    ParentId int NULL CONSTRAINT FK_Child_Parent FOREIGN KEY REFERENCES dbo.Parent (Id)
);
GO
