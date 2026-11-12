-- Two database triggers that are in the target before any script runs, with a text of their own
-- and the other state than the source has. The test takes them out of the target snapshot, as a
-- login without VIEW DEFINITION would not see them: no script may change, enable, disable or
-- drop them.
CREATE TRIGGER trHiddenOff ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; /* target */ END
GO
DISABLE TRIGGER trHiddenOff ON DATABASE;
GO
CREATE TRIGGER trHiddenOn ON DATABASE FOR CREATE_SYNONYM AS BEGIN SET NOCOUNT ON; /* target */ END
GO
