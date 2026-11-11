-- incomplete fixture, source side, run after the core fixture (test/engine-incomplete.test.ts).
-- A table the target has too, where the login that reads the target will not see it: with an
-- index and a named check the target's table lacks, and an unnamed check it has.
CREATE TABLE dbo.Hidden (
    Id int NOT NULL CONSTRAINT PK_Hidden PRIMARY KEY,
    V int NULL,
    W int NULL
);
GO
CREATE INDEX IX_Hidden_V ON dbo.Hidden (V);
ALTER TABLE dbo.Hidden ADD CHECK (V > 0);
ALTER TABLE dbo.Hidden ADD CONSTRAINT CK_Hidden_W CHECK (W > 0);
GO
