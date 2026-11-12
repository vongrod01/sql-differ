-- A target that is read without VIEW DEFINITION, and database triggers. Both sides start with a
-- table and one database trigger, which the source has with another text.
CREATE TABLE dbo.Items (
    Id int NOT NULL CONSTRAINT PK_Items PRIMARY KEY,
    Name nvarchar(50) NOT NULL
);
GO
CREATE TRIGGER trOld ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; END
GO
