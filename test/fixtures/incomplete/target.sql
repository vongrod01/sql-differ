-- incomplete fixture, target side, run after the core fixture (test/engine-incomplete.test.ts).
-- The table the comparison will not see (the test takes it out of the target snapshot): it is
-- here already, without the source's index and named check.
CREATE TABLE dbo.Hidden (
    Id int NOT NULL CONSTRAINT PK_Hidden PRIMARY KEY,
    V int NULL,
    W int NULL
);
GO
ALTER TABLE dbo.Hidden ADD CHECK (V > 0);
GO
-- The unnamed check the source has on dbo.Customers (core fixture) is here as well. Read without
-- VIEW DEFINITION its expression is NULL, so the comparison cannot pair it with the source's.
ALTER TABLE dbo.Customers ADD CHECK (LEN(Name) > 0);
GO
