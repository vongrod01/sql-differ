<#
.SYNOPSIS
    Compares the schema of two SQL Server databases and reports what differs.

.DESCRIPTION
    Reads the catalog views of a source and a target database (read-only: SELECT on sys.* only)
    and compares database settings, schemas, tables, columns, indexes / primary keys / unique
    constraints, foreign keys, check constraints, views, stored procedures, functions, triggers,
    user-defined types, sequences and synonyms. The indexes of views (indexed views) are compared
    as indexes, and database triggers (ON DATABASE) as triggers.

    Prints a summary per category, writes an HTML report (module definitions get a line diff),
    and sets the exit code: 0 = no differences, 1 = differences found, 2 = error.

    Constraints with system-generated names (PK__Orders__3214EC07...) are matched by table and
    definition instead of by name, so they do not show up as false differences. Default
    constraints are compared as part of their column.

.PARAMETER SourceProfile
    Connection profile for the source: a profile name (resolved to <ProfileDirectory>\<name>.env)
    or a path to an .env file. The file uses the mssql-mcp format:
        MSSQL_SERVER=192.168.1.10
        MSSQL_PORT=1433
        MSSQL_USER=reader          (omit or leave empty for Windows authentication)
        MSSQL_PASSWORD=...
        MSSQL_ENCRYPT=true
        MSSQL_TRUST_CERT=true
    Other keys (MSSQL_DATABASE, ...) are ignored. -SourceServer / -SourceCredential override it.

.PARAMETER SourceServer
    SQL Server instance of the source database. Default: localhost.

.PARAMETER SourceDatabase
    Source database name.

.PARAMETER SourceCredential
    SQL login for the source. Omit to use Windows authentication. Passing a user name
    (-SourceCredential sa) prompts for the password.

.PARAMETER TargetProfile
    Connection profile for the target; same format as -SourceProfile.

.PARAMETER TargetServer
    SQL Server instance of the target database. When neither -TargetProfile nor -TargetServer is
    given, the target uses the same connection as the source.

.PARAMETER TargetDatabase
    Target database name. Default: same as -SourceDatabase.

.PARAMETER TargetCredential
    SQL login for the target. Omit to use Windows authentication.

.PARAMETER ProfileDirectory
    Folder that profile names are resolved in. Default: ~\.config\mssql-mcp.

.PARAMETER Databases
    Batch mode: compare each of these databases (same name on source and target) and write one
    report per database plus index.html.

.PARAMETER AllDatabases
    Batch mode: compare every database that exists (and is accessible) on both servers under the
    same name. index.html also lists databases found on only one server.

.PARAMETER Categories
    What to compare and report, comma separated: Table, Column, View, StoredProcedure (or SP),
    Function, Index, ForeignKey (FK), Check, Trigger, Type, Sequence, Synonym, Schema, Database,
    or All. Default: Table, Column, View, Stored procedure, Function. Every category is still read,
    so saved snapshots stay complete.

.PARAMETER SourceSnapshot
    Single mode: read the source side from a snapshot file (saved with -SaveSnapshots) instead of
    a live database. Compare an old snapshot with the live database to see schema drift.

.PARAMETER TargetSnapshot
    Single mode: read the target side from a snapshot file.

.PARAMETER SaveSnapshots
    Also save each live side as <report>.source.snapshot.json / .target.snapshot.json.

.PARAMETER ListDatabases
    Print the server facts and accessible databases of the source as JSON, then exit.

.PARAMETER OutputPath
    Single mode: path of the HTML report. Default:
    reports\diff_<source>_<db>_vs_<target>_<db>_<timestamp>.html next to this script.
    Batch mode: folder for the reports. Default: reports\batch_<source>_vs_<target>_<timestamp>.

.PARAMETER IgnoreWhitespace
    Treat any run of whitespace as a single space when comparing definitions and properties.

.PARAMETER IgnoreCase
    Compare definitions and properties case-insensitively.

.PARAMETER IgnoreCollation
    Do not compare column and database collations (useful across servers with different
    default collations).

.PARAMETER CompareColumnOrder
    Also report columns whose ordinal position differs.

.PARAMETER TrustServerCertificate
    Trust the server certificate when the server forces encryption with a self-signed certificate.

.PARAMETER QueryTimeout
    Command timeout in seconds for each catalog query. Default: 120.

.PARAMETER Open
    Open the HTML report in the default browser when done.

.PARAMETER PassThru
    Also write the difference records to the pipeline (for Export-Csv, Where-Object, ...).

.EXAMPLE
    .\Compare-Database.ps1 -SourceDatabase plapp_dev -TargetDatabase plapp_prod

    Compares two databases on the local server with Windows authentication.

.EXAMPLE
    .\Compare-Database.ps1 -SourceDatabase plapp_prod -TargetProfile pylon-197 -IgnoreCollation

    Compares local plapp_prod with plapp_prod on the server in ~\.config\mssql-mcp\pylon-197.env.

.EXAMPLE
    .\Compare-Database.ps1 -TargetProfile pylon-197 -AllDatabases -Open

    Batch mode: compares every database that exists on both the local server and pylon-197, one
    report per database, and opens index.html.

.EXAMPLE
    .\Compare-Database.ps1 -SourceDatabase app -TargetServer 10.0.0.5 -TargetCredential sa

    Compares a local database with the same database on another server, using a SQL login
    (password prompt) for the target.

.EXAMPLE
    .\Compare-Database.ps1 -SourceDatabase a -TargetDatabase b -PassThru | Export-Csv diff.csv -NoTypeInformation -Encoding UTF8

    Exports the differences to CSV.
#>
[CmdletBinding()]
param(
    [string]$SourceProfile,

    [string]$SourceServer = 'localhost',

    [string]$SourceDatabase,

    [System.Management.Automation.PSCredential]
    [System.Management.Automation.Credential()]
    $SourceCredential = [System.Management.Automation.PSCredential]::Empty,

    [string]$TargetProfile,

    [string]$TargetServer,

    [string]$TargetDatabase,

    [System.Management.Automation.PSCredential]
    [System.Management.Automation.Credential()]
    $TargetCredential = [System.Management.Automation.PSCredential]::Empty,

    [string]$ProfileDirectory = (Join-Path $HOME '.config\mssql-mcp'),

    [string[]]$Databases,
    [switch]$AllDatabases,

    [string[]]$Categories = @('Table', 'Column', 'View', 'Stored procedure', 'Function'),

    [string]$SourceSnapshot,
    [string]$TargetSnapshot,
    [switch]$SaveSnapshots,
    [switch]$ListDatabases,

    [string]$OutputPath,

    [switch]$IgnoreWhitespace,
    [switch]$IgnoreCase,
    [switch]$IgnoreCollation,
    [switch]$CompareColumnOrder,
    [switch]$TrustServerCertificate,
    [int]$QueryTimeout = 120,
    [switch]$Open,
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

$CategoryOrder = @(
    'Database', 'Schema', 'Table', 'Column', 'Index', 'Foreign key', 'Check constraint',
    'View', 'Stored procedure', 'Function', 'Trigger', 'User-defined type', 'Sequence', 'Synonym'
)

# -Categories accepts these spellings (spaces, '-' and '_' ignored, any case) and 'All'.
$CategoryAliases = @{
    'database' = 'Database'; 'schema' = 'Schema'; 'table' = 'Table'; 'column' = 'Column'; 'index' = 'Index'
    'foreignkey' = 'Foreign key'; 'fk' = 'Foreign key'; 'checkconstraint' = 'Check constraint'; 'check' = 'Check constraint'
    'view' = 'View'; 'storedprocedure' = 'Stored procedure'; 'procedure' = 'Stored procedure'; 'proc' = 'Stored procedure'
    'sp' = 'Stored procedure'; 'function' = 'Function'; 'trigger' = 'Trigger'; 'userdefinedtype' = 'User-defined type'
    'type' = 'User-defined type'; 'sequence' = 'Sequence'; 'synonym' = 'Synonym'
}

function Resolve-Categories([string[]]$Names) {
    $wanted = @{}
    foreach ($part in @($Names | ForEach-Object { $_ -split ',' })) {
        $token = ($part -replace '[\s_-]', '').ToLowerInvariant()
        if (-not $token) { continue }
        if ($token -eq 'all') { foreach ($c in $CategoryOrder) { $wanted[$c] = $true }; continue }
        if (-not $CategoryAliases.ContainsKey($token)) { throw "Unknown category '$part'. Use: $($CategoryOrder -join ', '), or All" }
        $wanted[$CategoryAliases[$token]] = $true
    }
    if ($wanted.Count -eq 0) { throw 'No categories selected' }
    return @($CategoryOrder | Where-Object { $wanted.ContainsKey($_) })
}

# Every category is always read (snapshots stay complete for later drift checks and the sync
# script keeps primary keys in CREATE TABLE); only these are compared and reported. Set in main.
$SelectedCategories = $CategoryOrder

# How reports read a difference. 'sync': the source is the model and the target gets changed, so
# diffs read target -> source. 'timeline': an older snapshot against a later state (drift), so
# diffs read source (from) -> target (to). Set in main.
$Perspective = 'sync'

# Items of these categories belong to a table. They are compared only when the table exists in
# both databases; a missing table is already reported once under 'Table'.
$TableChildCategories = @('Column', 'Index', 'Foreign key', 'Check constraint')

# Items of these categories that exist on one side only are paired by table and definition, so a
# renamed constraint (or one system-named on one side only) shows as a name change.
$PairableCategories = @('Index', 'Foreign key', 'Check constraint')

$ModuleCategories = @{
    'P'  = 'Stored procedure'
    'PC' = 'Stored procedure'
    'V'  = 'View'
    'FN' = 'Function'
    'IF' = 'Function'
    'TF' = 'Function'
    'FS' = 'Function'
    'FT' = 'Function'
    'TR' = 'Trigger'
}

$HiddenDefinition = '-- definition not available (encrypted, CLR, or no VIEW DEFINITION permission)'

# Catalog queries return this for defaults, computed columns, filters and check expressions that
# exist but cannot be read (no VIEW DEFINITION permission).
$HiddenValue = '(not readable)'

# Properties skipped by the comparison options. Snapshots always keep every property, so a saved
# snapshot can be compared later with any options.
$IgnoredProps = @{}
if ($IgnoreCollation) { $IgnoredProps['Collation'] = $true }
if (-not $CompareColumnOrder) { $IgnoredProps['Ordinal'] = $true }

# What a snapshot of this engine holds. Version 2 (2026-11-11) added the indexes of views and
# database triggers. A snapshot file of version 1 does not have them, which is not the same as
# the database having none: they are compared only when both sides were read as version 2.
$SnapshotVersion = 2

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Every date the engine writes (reports, scripts, snapshots, the names of report files) goes
# through here. The date cmdlet with -Format follows the culture of the session: on a machine set
# to Thai, 'yyyy' is the Buddhist year (2569 for 2026).
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
function Get-Timestamp([string]$Format) { return [DateTime]::Now.ToString($Format, $Invariant) }

# The web app reads the console log as UTF-8.
if ($env:DATABASE_DIFF_UTF8 -eq '1') { [Console]::OutputEncoding = $Utf8NoBom }

# ---------------------------------------------------------------------------------------------
# Catalog queries
# ---------------------------------------------------------------------------------------------

# Objects created by SSMS database diagrams (sysdiagrams, sp_helpdiagrams, ...) are skipped.
$NotToolObject = @'
NOT EXISTS (SELECT 1 FROM sys.extended_properties ep
            WHERE ep.class = 1 AND ep.major_id = {0}.object_id AND ep.minor_id = 0
              AND ep.name = N'microsoft_database_tools_support')
'@

# Formats a column type the way it is written in DDL: varchar(50), nvarchar(max), decimal(18,2) ...
$ColumnTypeSql = @'
CASE WHEN ty.is_user_defined = 1 THEN SCHEMA_NAME(ty.schema_id) + '.' + ty.name ELSE ty.name END
+ CASE
    WHEN ty.is_user_defined = 1 THEN ''
    WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary')
        THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
    WHEN ty.name IN ('nvarchar', 'nchar')
        THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
    WHEN ty.name IN ('decimal', 'numeric')
        THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
    WHEN ty.name IN ('datetime2', 'time', 'datetimeoffset')
        THEN '(' + CAST(c.scale AS varchar(10)) + ')'
    ELSE ''
  END
'@

$Sql = @{}

$Sql.Database = @'
SELECT d.collation_name AS Collation,
       CAST(d.compatibility_level AS varchar(10)) AS CompatibilityLevel,
       HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS CanViewDefinition,
       SUSER_SNAME() AS LoginName
FROM sys.databases d
WHERE d.database_id = DB_ID()
'@

$Sql.Schemas = @'
SELECT s.name AS SchemaName
FROM sys.schemas s
WHERE s.schema_id > 4 AND s.schema_id < 16384
'@

$Sql.Tables = @'
SELECT s.name AS SchemaName, t.name AS TableName
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
  AND {0}
'@ -f ($NotToolObject -f 't')

# sys.types is joined with LEFT JOIN: a login without VIEW DEFINITION sees the columns of a table
# it may select from, but not the row of a user-defined type it has no permission on. With an
# inner join such a column disappeared, and read as a column the database does not have. Its type
# reads as not readable instead, so the column is compared without its type.
$Sql.Columns = @'
SELECT s.name AS SchemaName, t.name AS TableName, c.name AS ColumnName, c.column_id AS Ordinal,
       ISNULL({0}, '(not readable)') AS DataType,
       CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS Nullable,
       CASE WHEN c.is_identity = 1
            THEN 'IDENTITY(' + CAST(ic.seed_value AS varchar(40)) + ',' + CAST(ic.increment_value AS varchar(40)) + ')'
            ELSE '' END AS IdentitySpec,
       c.is_computed AS IsComputed,
       CASE WHEN c.is_computed = 1 AND cc.definition IS NULL THEN '(not readable)'
            ELSE ISNULL(cc.definition, '') END AS ComputedDefinition,
       CASE WHEN c.is_computed = 0 THEN ''
            WHEN cc.column_id IS NULL THEN '(not readable)'
            WHEN cc.is_persisted = 1 THEN 'PERSISTED'
            ELSE '' END AS Persisted,
       CASE WHEN c.default_object_id <> 0 AND dc.definition IS NULL THEN '(not readable)'
            ELSE ISNULL(dc.definition, '') END AS DefaultDefinition,
       CASE WHEN dc.is_system_named = 0 THEN dc.name ELSE '' END AS DefaultName,
       ISNULL(c.collation_name, '') AS Collation
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
WHERE t.is_ms_shipped = 0
  AND {1}
'@ -f $ColumnTypeSql, ($NotToolObject -f 't')

# The indexes of tables and of views (an indexed view: a unique clustered index, and nonclustered
# ones on top of it). A view's index is an item like a table's, with the view as its parent.
$Sql.Indexes = @'
SELECT s.name AS SchemaName, t.name AS TableName, i.name AS IndexName, i.type_desc AS IndexType,
       i.is_primary_key AS IsPrimaryKey, i.is_unique AS IsUnique, i.is_unique_constraint AS IsUniqueConstraint,
       ISNULL(kc.is_system_named, 0) AS IsSystemNamed,
       CASE WHEN i.has_filter = 1 AND i.filter_definition IS NULL THEN '(not readable)'
            ELSE ISNULL(i.filter_definition, '') END AS FilterDefinition,
       ISNULL(c.name, '') AS ColumnName,
       ISNULL(ic.key_ordinal, 0) AS KeyOrdinal,
       ISNULL(ic.is_descending_key, 0) AS IsDescending,
       ISNULL(ic.is_included_column, 0) AS IsIncluded
FROM sys.indexes i
JOIN sys.objects t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN sys.key_constraints kc ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.is_ms_shipped = 0 AND t.type IN ('U', 'V') AND i.type > 0 AND i.is_hypothetical = 0
  AND {0}
ORDER BY s.name, t.name, i.index_id, ic.key_ordinal, ic.index_column_id
'@ -f ($NotToolObject -f 't')

$Sql.ForeignKeys = @'
SELECT s.name AS SchemaName, t.name AS TableName, fk.name AS ForeignKeyName, fk.is_system_named AS IsSystemNamed,
       rs.name AS ReferencedSchema, rt.name AS ReferencedTable,
       pc.name AS ColumnName, rc.name AS ReferencedColumn,
       fk.delete_referential_action_desc AS OnDelete, fk.update_referential_action_desc AS OnUpdate,
       CASE WHEN fk.is_disabled = 1 THEN 'DISABLED' ELSE 'ENABLED' END AS State
FROM sys.foreign_keys fk
JOIN sys.tables t ON t.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE t.is_ms_shipped = 0
  AND {0}
ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id
'@ -f ($NotToolObject -f 't')

$Sql.CheckConstraints = @'
SELECT s.name AS SchemaName, t.name AS TableName, cc.name AS ConstraintName, cc.is_system_named AS IsSystemNamed,
       ISNULL(cc.definition, '(not readable)') AS Expression,
       CASE WHEN cc.is_disabled = 1 THEN 'DISABLED' ELSE 'ENABLED' END AS State
FROM sys.check_constraints cc
JOIN sys.tables t ON t.object_id = cc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
  AND {0}
'@ -f ($NotToolObject -f 't')

$Sql.Modules = @'
SELECT s.name AS SchemaName, o.name AS ObjectName, RTRIM(o.type) AS ObjectType, o.type_desc AS TypeDesc,
       ISNULL(OBJECT_SCHEMA_NAME(o.parent_object_id) + '.' + OBJECT_NAME(o.parent_object_id), '') AS ParentName,
       ISNULL(OBJECT_SCHEMA_NAME(o.parent_object_id), '') AS ParentSchema,
       ISNULL(OBJECT_NAME(o.parent_object_id), '') AS ParentObject,
       CASE WHEN tr.object_id IS NULL THEN '' WHEN tr.is_disabled = 1 THEN 'DISABLED' ELSE 'ENABLED' END AS TriggerState,
       m.definition AS Definition,
       CASE WHEN m.definition IS NULL THEN 1 ELSE 0 END AS IsHidden,
       CASE WHEN m.object_id IS NULL THEN NULL
            ELSE CASE WHEN m.uses_ansi_nulls = 0 THEN 'ANSI_NULLS OFF' ELSE '' END
               + CASE WHEN m.uses_ansi_nulls = 0 AND m.uses_quoted_identifier = 0 THEN ', ' ELSE '' END
               + CASE WHEN m.uses_quoted_identifier = 0 THEN 'QUOTED_IDENTIFIER OFF' ELSE '' END
       END AS SetOptions
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
LEFT JOIN sys.triggers tr ON tr.object_id = o.object_id
WHERE o.is_ms_shipped = 0
  AND o.type IN ('P', 'PC', 'V', 'FN', 'IF', 'TF', 'FS', 'FT', 'TR')
  AND {0}
'@ -f ($NotToolObject -f 'o')

# Database triggers (CREATE TRIGGER ... ON DATABASE: DDL triggers). They have no schema and no
# row in sys.objects, so the query above does not see them.
$Sql.DatabaseTriggers = @'
SELECT tr.name AS TriggerName, tr.type_desc AS TypeDesc,
       CASE WHEN tr.is_disabled = 1 THEN 'DISABLED' ELSE 'ENABLED' END AS TriggerState,
       m.definition AS Definition,
       CASE WHEN m.definition IS NULL THEN 1 ELSE 0 END AS IsHidden,
       CASE WHEN m.object_id IS NULL THEN NULL
            ELSE CASE WHEN m.uses_ansi_nulls = 0 THEN 'ANSI_NULLS OFF' ELSE '' END
               + CASE WHEN m.uses_ansi_nulls = 0 AND m.uses_quoted_identifier = 0 THEN ', ' ELSE '' END
               + CASE WHEN m.uses_quoted_identifier = 0 THEN 'QUOTED_IDENTIFIER OFF' ELSE '' END
       END AS SetOptions
FROM sys.triggers tr
LEFT JOIN sys.sql_modules m ON m.object_id = tr.object_id
WHERE tr.parent_class = 0 AND tr.is_ms_shipped = 0
'@

$Sql.AliasTypes = @'
SELECT s.name AS SchemaName, ty.name AS TypeName,
       TYPE_NAME(ty.system_type_id)
       + CASE
           WHEN TYPE_NAME(ty.system_type_id) IN ('varchar', 'char', 'varbinary', 'binary')
               THEN '(' + CASE WHEN ty.max_length = -1 THEN 'max' ELSE CAST(ty.max_length AS varchar(10)) END + ')'
           WHEN TYPE_NAME(ty.system_type_id) IN ('nvarchar', 'nchar')
               THEN '(' + CASE WHEN ty.max_length = -1 THEN 'max' ELSE CAST(ty.max_length / 2 AS varchar(10)) END + ')'
           WHEN TYPE_NAME(ty.system_type_id) IN ('decimal', 'numeric')
               THEN '(' + CAST(ty.precision AS varchar(10)) + ',' + CAST(ty.scale AS varchar(10)) + ')'
           WHEN TYPE_NAME(ty.system_type_id) IN ('datetime2', 'time', 'datetimeoffset')
               THEN '(' + CAST(ty.scale AS varchar(10)) + ')'
           ELSE ''
         END
       + CASE WHEN ty.is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END AS Spec
FROM sys.types ty
JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE ty.is_user_defined = 1 AND ty.is_table_type = 0
'@

$Sql.TableTypeColumns = @'
SELECT s.name AS SchemaName, tt.name AS TypeName, c.name AS ColumnName,
       {0} AS DataType,
       CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS Nullable,
       CASE WHEN c.is_identity = 1
            THEN 'IDENTITY(' + CAST(ic.seed_value AS varchar(40)) + ',' + CAST(ic.increment_value AS varchar(40)) + ')'
            ELSE '' END AS IdentitySpec,
       CASE WHEN c.is_computed = 1 AND cc.definition IS NULL THEN '(not readable)'
            ELSE ISNULL(cc.definition, '') END AS ComputedDefinition,
       CASE WHEN c.is_computed = 1 AND cc.is_persisted = 1 THEN 'PERSISTED' ELSE '' END AS Persisted,
       CASE WHEN c.default_object_id <> 0 AND dc.definition IS NULL THEN '(not readable)'
            ELSE ISNULL(dc.definition, '') END AS DefaultDefinition,
       ISNULL(c.collation_name, '') AS Collation
FROM sys.table_types tt
JOIN sys.schemas s ON s.schema_id = tt.schema_id
JOIN sys.columns c ON c.object_id = tt.type_table_object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
ORDER BY s.name, tt.name, c.column_id
'@ -f $ColumnTypeSql

# The PRIMARY KEY and UNIQUE constraints of table types, one row per key column. An index that is
# not a constraint (INDEX ... in the type's definition) is not read.
$Sql.TableTypeKeys = @'
SELECT s.name AS SchemaName, tt.name AS TypeName, i.index_id AS IndexId,
       CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS Kind,
       i.type_desc AS IndexType, i.ignore_dup_key AS IgnoreDupKey, c.name AS ColumnName, ic.is_descending_key AS IsDescending
FROM sys.table_types tt
JOIN sys.schemas s ON s.schema_id = tt.schema_id
JOIN sys.indexes i ON i.object_id = tt.type_table_object_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE (i.is_primary_key = 1 OR i.is_unique_constraint = 1) AND ic.key_ordinal > 0
ORDER BY s.name, tt.name, i.index_id, ic.key_ordinal
'@

$Sql.TableTypeChecks = @'
SELECT s.name AS SchemaName, tt.name AS TypeName, ISNULL(ck.definition, '(not readable)') AS Expression
FROM sys.table_types tt
JOIN sys.schemas s ON s.schema_id = tt.schema_id
JOIN sys.check_constraints ck ON ck.parent_object_id = tt.type_table_object_id
ORDER BY s.name, tt.name, ck.object_id
'@

# Precision: only for a sequence of the built-in decimal or numeric type, where it is part of the
# type (the scale of a sequence is always 0). NULL for every other type, also for an alias type.
$Sql.Sequences = @'
SELECT s.name AS SchemaName, sq.name AS SequenceName, TYPE_NAME(sq.user_type_id) AS DataType,
       CASE WHEN sq.user_type_id = sq.system_type_id AND TYPE_NAME(sq.system_type_id) IN ('decimal', 'numeric')
            THEN sq.precision END AS Precision,
       CAST(sq.start_value AS varchar(50)) AS StartValue,
       CAST(sq.increment AS varchar(50)) AS Increment,
       CAST(sq.minimum_value AS varchar(50)) AS MinValue,
       CAST(sq.maximum_value AS varchar(50)) AS MaxValue,
       CASE WHEN sq.is_cycling = 1 THEN 'CYCLE' ELSE 'NO CYCLE' END AS Cycle,
       CASE WHEN sq.is_cached = 0 THEN 'NO CACHE'
            ELSE 'CACHE ' + ISNULL(CAST(sq.cache_size AS varchar(20)), '(default)') END AS Cache
FROM sys.sequences sq
JOIN sys.schemas s ON s.schema_id = sq.schema_id
'@

$Sql.ServerInfo = @'
SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS Version,
       CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS Edition,
       CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS Collation,
       CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS ServerName,
       CAST(ISNULL(SERVERPROPERTY('InstanceName'), 'MSSQLSERVER') AS nvarchar(128)) AS InstanceName,
       SUSER_SNAME() AS LoginName,
       HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW ANY DEFINITION') AS ViewAnyDefinition
'@

# Which instance answered: asked once per endpoint, before anything is read from it.
$Sql.ServerIdentity = @'
SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS ServerName,
       CAST(ISNULL(SERVERPROPERTY('InstanceName'), 'MSSQLSERVER') AS nvarchar(128)) AS InstanceName
'@

# Every user database, including those the login cannot open: they must show up as "no access",
# not disappear (and not look like they exist on one server only).
$Sql.DatabaseList = @'
SELECT d.name AS DatabaseName,
       CASE WHEN d.state_desc = 'ONLINE' AND HAS_DBACCESS(d.name) = 1 THEN 1 ELSE 0 END AS HasAccess,
       ISNULL(HAS_PERMS_BY_NAME(d.name, 'DATABASE', 'VIEW DEFINITION'), 0) AS CanViewDefinition,
       d.state_desc AS State
FROM sys.databases d
WHERE d.database_id > 4
ORDER BY d.name
'@

$Sql.Synonyms = @'
SELECT s.name AS SchemaName, sn.name AS SynonymName, sn.base_object_name AS BaseObject
FROM sys.synonyms sn
JOIN sys.schemas s ON s.schema_id = sn.schema_id
'@

# ---------------------------------------------------------------------------------------------
# Database access
# ---------------------------------------------------------------------------------------------

function New-Endpoint {
    param([string]$Name = '', [string]$Server)
    @{
        Name                   = $Name
        Server                 = $Server
        Credential             = [System.Management.Automation.PSCredential]::Empty
        Encrypt                = $false
        TrustServerCertificate = $false
    }
}

function Read-ConnectionProfile([string]$Name) {
    $path = $null
    foreach ($candidate in @($Name, (Join-Path $ProfileDirectory ($Name + '.json')), (Join-Path $ProfileDirectory ($Name + '.env')))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $path = $candidate; break }
    }
    if (-not $path) { throw "Connection profile not found: $Name (looked in $ProfileDirectory)" }
    if ($path -like '*.json') { return Read-JsonProfile $path }

    $values = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { continue }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { $value = $Matches[1] }
        $values[$key] = $value
    }
    if (-not $values['MSSQL_SERVER']) { throw "MSSQL_SERVER is missing in $path" }

    $server = $values['MSSQL_SERVER']
    if ($values['MSSQL_PORT']) { $server = '{0},{1}' -f $server, $values['MSSQL_PORT'] }
    $endpoint = New-Endpoint ([System.IO.Path]::GetFileNameWithoutExtension($path)) $server
    if ($values['MSSQL_USER']) {
        $password = New-Object System.Security.SecureString
        foreach ($ch in ([string]$values['MSSQL_PASSWORD']).ToCharArray()) { $password.AppendChar($ch) }
        $endpoint.Credential = New-Object System.Management.Automation.PSCredential($values['MSSQL_USER'], $password)
    }
    $endpoint.Encrypt = $values['MSSQL_ENCRYPT'] -eq 'true'
    $endpoint.TrustServerCertificate = $values['MSSQL_TRUST_CERT'] -eq 'true'
    return $endpoint
}

# JSON profile written by the web app. The password is a DPAPI string (ConvertFrom-SecureString),
# readable only by the same Windows user on the same machine.
function Read-JsonProfile([string]$Path) {
    $p = Read-JsonFile $Path
    if (-not $p['server']) { throw "server is missing in $Path" }
    $server = [string]$p['server']
    if ($p['port']) { $server = '{0},{1}' -f $server, $p['port'] }
    $name = [string]$p['name']
    if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($Path) }
    $endpoint = New-Endpoint $name $server
    if ($p['user']) {
        $password = New-Object System.Security.SecureString
        if ($p['password']) { $password = ConvertTo-SecureString ([string]$p['password']) }
        $endpoint.Credential = New-Object System.Management.Automation.PSCredential([string]$p['user'], $password)
    }
    $endpoint.Encrypt = [bool]$p['encrypt']
    $endpoint.TrustServerCertificate = [bool]$p['trustServerCertificate']
    return $endpoint
}

function Get-ServerLabel([hashtable]$Endpoint) {
    if ($Endpoint.Name) { return '{0} ({1})' -f $Endpoint.Name, $Endpoint.Server }
    return $Endpoint.Server
}

function Get-EndpointLabel([hashtable]$Endpoint, [string]$Database) {
    return '{0} / {1}' -f (Get-ServerLabel $Endpoint), $Database
}

# Short name for report file names: the profile name, else the server.
function Get-EndpointTag([hashtable]$Endpoint) {
    if ($Endpoint.Name) { return $Endpoint.Name }
    return $Endpoint.Server
}

function Open-SqlConnection {
    param(
        [hashtable]$Endpoint,
        [string]$Database
    )

    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = $Endpoint.Server
    $builder['Initial Catalog'] = $Database
    $builder['Application Name'] = 'database-diff'
    $builder['Connect Timeout'] = 15
    if ($Endpoint.Encrypt) { $builder['Encrypt'] = $true }
    if ($Endpoint.TrustServerCertificate) { $builder['TrustServerCertificate'] = $true }

    $credential = $Endpoint.Credential
    $connection = New-Object System.Data.SqlClient.SqlConnection
    if ($credential -and $credential -ne [System.Management.Automation.PSCredential]::Empty) {
        # SqlCredential keeps the password out of the connection string.
        $password = $credential.Password.Copy()
        $password.MakeReadOnly()
        $connection.ConnectionString = $builder.ConnectionString
        $connection.Credential = New-Object System.Data.SqlClient.SqlCredential($credential.UserName, $password)
    }
    else {
        $builder['Integrated Security'] = $true
        $connection.ConnectionString = $builder.ConnectionString
    }

    $connection.Open()
    return $connection
}

function Invoke-SqlQuery {
    param(
        [System.Data.SqlClient.SqlConnection]$Connection,
        [string]$Query
    )

    $command = $Connection.CreateCommand()
    $command.CommandText = $Query
    $command.CommandTimeout = $QueryTimeout
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $command
    $table = New-Object System.Data.DataTable
    try {
        [void]$adapter.Fill($table)
    }
    finally {
        $adapter.Dispose()
        $command.Dispose()
    }
    return $table.Rows
}

# ---------------------------------------------------------------------------------------------
# Snapshot: category -> @{ key -> item }
# ---------------------------------------------------------------------------------------------

function New-SchemaItem {
    param(
        [string]$Name,
        [System.Collections.IDictionary]$Props = @{},
        [string]$Parent = '',
        $Definition = $null,
        [string]$ObjectName = '',
        # Unquoted name parts for the sync script; never compared.
        [System.Collections.IDictionary]$Sql = $null
    )
    @{ Name = $Name; Props = $Props; Parent = $Parent; Definition = $Definition; ObjectName = $ObjectName; Sql = $Sql }
}

# Keys for named indexes and constraints. A real name that looks like one of the generated keys
# (PK, UQ(...), FK(...), CK:...) gets a "=" prefix so it cannot overwrite that key.
function Get-NameKey([string]$Name) {
    if ($Name -eq 'PK' -or $Name -match '^(UQ\(|FK\(|CK:|=)') { return '=' + $Name }
    return $Name
}

# Normalized text for comparison and the report; $null (no definition) stays $null.
function Get-ShownDefinition($Text) {
    if ($null -eq $Text) { return $null }
    return Get-DisplayDefinition ([string]$Text)
}

function Get-DisplayDefinition([string]$Text) {
    # Line endings and trailing spaces are noise between environments; the report shows this form.
    $normalized = $Text -replace "`r`n?", "`n"
    $normalized = $normalized -replace '[ \t\xA0]+(?=\n)', ''
    return $normalized.Trim()
}

function Get-SchemaSnapshot {
    param([System.Data.SqlClient.SqlConnection]$Connection)

    $snap = @{}
    foreach ($category in $CategoryOrder) { $snap[$category] = @{} }
    # ServerName is filled in by Read-SideSnapshot, which knows the endpoint.
    $snap['Meta'] = @{ CanViewDefinition = $true; LoginName = ''; ServerName = ''; Version = $SnapshotVersion }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Database)) {
        $snap['Meta'] = @{ CanViewDefinition = ([int]$r.CanViewDefinition -eq 1); LoginName = [string]$r.LoginName; ServerName = ''; Version = $SnapshotVersion }
        $props = [ordered]@{ CompatibilityLevel = [string]$r.CompatibilityLevel; Collation = [string]$r.Collation }
        $snap['Database']['(database)'] = New-SchemaItem '(database)' $props
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Schemas)) {
        $snap['Schema'][[string]$r.SchemaName] = New-SchemaItem ([string]$r.SchemaName) -Sql @{ Schema = [string]$r.SchemaName }
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Tables)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.TableName
        $snap['Table'][$key] = New-SchemaItem $key -Sql @{ Schema = [string]$r.SchemaName; Name = [string]$r.TableName }
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Columns)) {
        $table = '{0}.{1}' -f $r.SchemaName, $r.TableName
        $key = '{0}.{1}' -f $table, $r.ColumnName
        $props = [ordered]@{
            Type      = [string]$r.DataType
            Nullable  = [string]$r.Nullable
            Identity  = [string]$r.IdentitySpec
            Computed  = [string]$r.ComputedDefinition
        }
        # Computed columns only, so snapshots taken before 2026-10-28 (no Persisted) still compare
        # cleanly: a prop missing on one side is not compared.
        if ([int]$r.IsComputed -eq 1) { $props['Persisted'] = [string]$r.Persisted }
        $props['Default'] = [string]$r.DefaultDefinition
        $props['Collation'] = [string]$r.Collation
        $props['Ordinal'] = [string]$r.Ordinal
        $sqlParts = @{ Schema = [string]$r.SchemaName; Table = [string]$r.TableName; Name = [string]$r.ColumnName }
        # A default's own name is not compared (system-generated names differ per database), but
        # the scripts keep a name someone chose.
        if ([string]$r.DefaultName) { $sqlParts['DefaultName'] = [string]$r.DefaultName }
        $snap['Column'][$key] = New-SchemaItem $key $props $table -Sql $sqlParts
    }

    # Index rows come one per column; group them per index first.
    $indexes = @{}
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Indexes)) {
        $table = '{0}.{1}' -f $r.SchemaName, $r.TableName
        $id = '{0}|{1}' -f $table, $r.IndexName
        $ix = $indexes[$id]
        if ($null -eq $ix) {
            $ix = @{
                Table          = $table
                Row            = $r
                KeyColumns     = New-Object System.Collections.Generic.List[string]
                KeyParts       = New-Object System.Collections.Generic.List[object]
                IncludeColumns = New-Object System.Collections.Generic.List[string]
            }
            $indexes[$id] = $ix
        }
        $column = [string]$r.ColumnName
        if (-not $column) { continue }
        if ($r.IsIncluded -or [int]$r.KeyOrdinal -eq 0) { $ix.IncludeColumns.Add($column); continue }
        if ($r.IsDescending) { $ix.KeyColumns.Add($column + ' DESC') } else { $ix.KeyColumns.Add($column) }
        $ix.KeyParts.Add(@{ Name = $column; Desc = [bool]$r.IsDescending })
    }
    foreach ($ix in $indexes.Values) {
        $r = $ix.Row
        $name = [string]$r.IndexName
        $columns = $ix.KeyColumns -join ', '
        if ($r.IsPrimaryKey) { $kind = 'PRIMARY KEY' }
        elseif ($r.IsUniqueConstraint) { $kind = 'UNIQUE CONSTRAINT' }
        elseif ($r.IsUnique) { $kind = 'UNIQUE INDEX' }
        else { $kind = 'INDEX' }

        if ($r.IsPrimaryKey) {
            $key = '{0}|PK' -f $ix.Table
            $display = '{0} (primary key)' -f $ix.Table
        }
        elseif ($r.IsSystemNamed) {
            $key = '{0}|UQ({1})' -f $ix.Table, $columns
            $display = '{0} (unique: {1})' -f $ix.Table, $columns
        }
        else {
            $key = '{0}|{1}' -f $ix.Table, (Get-NameKey $name)
            $display = '{0}.{1}' -f $ix.Table, $name
        }

        $props = [ordered]@{
            Kind    = $kind
            Type    = [string]$r.IndexType
            Columns = $columns
            Include = (@($ix.IncludeColumns | Sort-Object) -join ', ')
            Filter  = [string]$r.FilterDefinition
        }
        if ($r.IsPrimaryKey) {
            if ($r.IsSystemNamed) { $props.Name = '(system-named)' } else { $props.Name = $name }
        }
        $sqlParts = @{
            Schema        = [string]$r.SchemaName
            Table         = [string]$r.TableName
            Name          = $name
            IsSystemNamed = [bool]$r.IsSystemNamed
            KeyParts      = $ix.KeyParts.ToArray()
            Includes      = $ix.IncludeColumns.ToArray()
        }
        $snap['Index'][$key] = New-SchemaItem $display $props $ix.Table -ObjectName $name -Sql $sqlParts
    }

    $foreignKeys = @{}
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.ForeignKeys)) {
        $table = '{0}.{1}' -f $r.SchemaName, $r.TableName
        $id = '{0}|{1}' -f $table, $r.ForeignKeyName
        $fk = $foreignKeys[$id]
        if ($null -eq $fk) {
            $fk = @{
                Table       = $table
                Row         = $r
                FromColumns = New-Object System.Collections.Generic.List[string]
                ToColumns   = New-Object System.Collections.Generic.List[string]
            }
            $foreignKeys[$id] = $fk
        }
        $fk.FromColumns.Add([string]$r.ColumnName)
        $fk.ToColumns.Add([string]$r.ReferencedColumn)
    }
    foreach ($fk in $foreignKeys.Values) {
        $r = $fk.Row
        $from = $fk.FromColumns -join ', '
        $references = '{0}.{1} ({2})' -f $r.ReferencedSchema, $r.ReferencedTable, ($fk.ToColumns -join ', ')
        if ($r.IsSystemNamed) {
            $key = '{0}|FK({1})->{2}' -f $fk.Table, $from, $references
            $display = '{0} (foreign key: {1} -> {2})' -f $fk.Table, $from, $references
        }
        else {
            $key = '{0}|{1}' -f $fk.Table, (Get-NameKey ([string]$r.ForeignKeyName))
            $display = '{0}.{1}' -f $fk.Table, $r.ForeignKeyName
        }
        $props = [ordered]@{
            Columns    = $from
            References = $references
            OnDelete   = [string]$r.OnDelete
            OnUpdate   = [string]$r.OnUpdate
            State      = [string]$r.State
        }
        $sqlParts = @{
            Schema        = [string]$r.SchemaName
            Table         = [string]$r.TableName
            Name          = [string]$r.ForeignKeyName
            IsSystemNamed = [bool]$r.IsSystemNamed
            Columns       = $fk.FromColumns.ToArray()
            RefSchema     = [string]$r.ReferencedSchema
            RefTable      = [string]$r.ReferencedTable
            RefColumns    = $fk.ToColumns.ToArray()
        }
        $snap['Foreign key'][$key] = New-SchemaItem $display $props $fk.Table -ObjectName ([string]$r.ForeignKeyName) -Sql $sqlParts
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.CheckConstraints)) {
        $table = '{0}.{1}' -f $r.SchemaName, $r.TableName
        $expression = [string]$r.Expression
        # An unreadable expression cannot identify the constraint, so it falls back to the name.
        if ($r.IsSystemNamed -and $expression -ne $HiddenValue) {
            $key = '{0}|CK:{1}' -f $table, $expression
            $display = '{0} (check: {1})' -f $table, $expression
        }
        else {
            $key = '{0}|{1}' -f $table, (Get-NameKey ([string]$r.ConstraintName))
            $display = '{0}.{1}' -f $table, $r.ConstraintName
        }
        $props = [ordered]@{ Expression = $expression; State = [string]$r.State }
        $sqlParts = @{ Schema = [string]$r.SchemaName; Table = [string]$r.TableName; Name = [string]$r.ConstraintName; IsSystemNamed = [bool]$r.IsSystemNamed }
        $snap['Check constraint'][$key] = New-SchemaItem $display $props $table -ObjectName ([string]$r.ConstraintName) -Sql $sqlParts
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Modules)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.ObjectName
        $category = $ModuleCategories[[string]$r.ObjectType]
        $props = [ordered]@{ Type = [string]$r.TypeDesc }
        if ($category -eq 'Trigger') {
            $props.Table = [string]$r.ParentName
            $props.State = [string]$r.TriggerState
        }
        # The ANSI_NULLS and QUOTED_IDENTIFIER a module was created under are stored with it and
        # used whenever it runs, whatever the caller has set. Empty when both are ON, as nearly
        # every module has them. Left out for a CLR object (no sys.sql_modules row), and missing
        # in snapshots taken before 2026-11-11: a prop missing on one side is not compared.
        if ($r.SetOptions -isnot [System.DBNull]) { $props.SetOptions = [string]$r.SetOptions }
        # The raw text is kept for the sync script (string literals must not change); comparison
        # and the report use the normalized form.
        if ([int]$r.IsHidden) { $definition = $HiddenDefinition }
        else { $definition = [string]$r.Definition }
        $sqlParts = @{
            Schema       = [string]$r.SchemaName
            Name         = [string]$r.ObjectName
            ObjectType   = [string]$r.ObjectType
            ParentSchema = [string]$r.ParentSchema
            ParentObject = [string]$r.ParentObject
        }
        $snap[$category][$key] = New-SchemaItem $key $props '' $definition -Sql $sqlParts
    }

    # Database triggers are items of the Trigger category. They have no schema, so their key is
    # not schema.name: the prefix keeps one apart from a table's trigger of the same name (both
    # can exist). Table says DATABASE where a table's trigger names its table, and Scope tells the
    # scripts that this one is created, dropped and disabled "ON DATABASE".
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.DatabaseTriggers)) {
        $name = [string]$r.TriggerName
        $props = [ordered]@{ Type = [string]$r.TypeDesc; Table = 'DATABASE'; State = [string]$r.TriggerState }
        if ($r.SetOptions -isnot [System.DBNull]) { $props.SetOptions = [string]$r.SetOptions }
        if ([int]$r.IsHidden) { $definition = $HiddenDefinition }
        else { $definition = [string]$r.Definition }
        $sqlParts = @{ Schema = ''; Name = $name; ObjectType = 'TR'; ParentSchema = ''; ParentObject = ''; Scope = 'DATABASE' }
        $snap['Trigger']['(database trigger)|' + $name] = New-SchemaItem ($name + ' (database trigger)') $props '' $definition -Sql $sqlParts
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.AliasTypes)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.TypeName
        $sqlParts = @{ Schema = [string]$r.SchemaName; Name = [string]$r.TypeName }
        $snap['User-defined type'][$key] = New-SchemaItem $key ([ordered]@{ Kind = 'alias type'; Spec = [string]$r.Spec }) -Sql $sqlParts
    }

    # A table type: Spec is its columns as name, type and nullability (all that was read before
    # 2026-11-11, and still written the same way, so older snapshots compare as they did). What
    # else its definition says goes into Details: IDENTITY, defaults, computed columns, primary
    # key and unique constraints (with IGNORE_DUP_KEY when it is on), checks; and the collations
    # of its columns into Collation. Not read: indexes that are not constraints, and
    # MEMORY_OPTIMIZED.
    $tableTypes = @{}
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.TableTypeColumns)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.TypeName
        if (-not $tableTypes.ContainsKey($key)) {
            $tableTypes[$key] = @{
                Schema   = [string]$r.SchemaName
                Name     = [string]$r.TypeName
                Specs    = New-Object System.Collections.Generic.List[string]
                Columns  = New-Object System.Collections.Generic.List[object]
                Details  = New-Object System.Collections.Generic.List[string]
                Collations = New-Object System.Collections.Generic.List[string]
                KeyRows  = New-Object System.Collections.Generic.List[object]
                Checks   = New-Object System.Collections.Generic.List[string]
                Unreadable = $false
            }
        }
        $tt = $tableTypes[$key]
        $tt.Specs.Add(('{0} {1} {2}' -f $r.ColumnName, $r.DataType, $r.Nullable))
        $tt.Columns.Add(@{
            Name = [string]$r.ColumnName; Type = [string]$r.DataType; Nullable = [string]$r.Nullable
            Identity = [string]$r.IdentitySpec; Computed = [string]$r.ComputedDefinition; Persisted = [string]$r.Persisted; Default = [string]$r.DefaultDefinition
            Collation = [string]$r.Collation
        })
        if ([string]$r.Collation) { $tt.Collations.Add(('{0} {1}' -f $r.ColumnName, $r.Collation)) }
        if ([string]$r.IdentitySpec) { $tt.Details.Add(('{0} {1}' -f $r.ColumnName, $r.IdentitySpec)) }
        if ([string]$r.ComputedDefinition) {
            $computed = '{0} AS {1}' -f $r.ColumnName, $r.ComputedDefinition
            if ([string]$r.Persisted) { $computed += ' PERSISTED' }
            $tt.Details.Add($computed)
        }
        if ([string]$r.DefaultDefinition) { $tt.Details.Add(('{0} DEFAULT {1}' -f $r.ColumnName, $r.DefaultDefinition)) }
        if ([string]$r.ComputedDefinition -eq $HiddenValue -or [string]$r.DefaultDefinition -eq $HiddenValue) { $tt.Unreadable = $true }
    }
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.TableTypeKeys)) {
        $tt = $tableTypes[('{0}.{1}' -f $r.SchemaName, $r.TypeName)]
        if ($null -ne $tt) { $tt.KeyRows.Add($r) }
    }
    foreach ($r in (Invoke-SqlQuery $Connection $Sql.TableTypeChecks)) {
        $tt = $tableTypes[('{0}.{1}' -f $r.SchemaName, $r.TypeName)]
        if ($null -eq $tt) { continue }
        $tt.Checks.Add([string]$r.Expression)
        if ([string]$r.Expression -eq $HiddenValue) { $tt.Unreadable = $true }
    }
    foreach ($key in $tableTypes.get_Keys()) {
        $tt = $tableTypes[$key]
        $spec = '(' + ($tt.Specs -join ', ') + ')'

        # Key rows come one per column, in index and key order; group them per constraint.
        $keys = New-Object System.Collections.Generic.List[object]
        $current = $null
        foreach ($r in $tt.KeyRows) {
            if ($null -eq $current -or $current.IndexId -ne [int]$r.IndexId) {
                $current = @{
                    IndexId = [int]$r.IndexId; Kind = [string]$r.Kind; Type = [string]$r.IndexType; IgnoreDupKey = [bool]$r.IgnoreDupKey
                    Parts = New-Object System.Collections.Generic.List[object]
                    Names = New-Object System.Collections.Generic.List[string]
                }
                $keys.Add($current)
            }
            $current.Parts.Add(@{ Name = [string]$r.ColumnName; Desc = [bool]$r.IsDescending })
            if ($r.IsDescending) { $current.Names.Add([string]$r.ColumnName + ' DESC') } else { $current.Names.Add([string]$r.ColumnName) }
        }
        # In a fixed order, whatever order the constraints were written in: the primary key, then
        # the unique constraints, then the checks, each kind sorted by its text (ordinal, so a
        # snapshot does not depend on the culture of the machine that took it).
        $orderedKeys = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([System.StringComparer]::Ordinal)
        foreach ($k in $keys) {
            $k.Text = '{0} {1} ({2})' -f $k.Kind, $k.Type, ($k.Names -join ', ')
            # Only when it is on, so the text of every other key is what it was before this was read.
            if ($k.IgnoreDupKey) { $k.Text += ' WITH (IGNORE_DUP_KEY = ON)' }
            if ($k.Kind -eq 'PRIMARY KEY') { $rank = '0' } else { $rank = '1' }
            $orderedKeys[$rank + $k.Text + [char]31 + $k.IndexId] = $k
        }
        $keyParts = New-Object System.Collections.Generic.List[object]
        $keyTexts = New-Object System.Collections.Generic.List[string]
        foreach ($k in $orderedKeys.get_Values()) {
            $keyTexts.Add($k.Text)
            $keyParts.Add(@{ Kind = $k.Kind; Type = $k.Type; IgnoreDupKey = $k.IgnoreDupKey; Columns = $k.Parts.ToArray() })
        }
        $tt.Checks.Sort([System.StringComparer]::Ordinal)
        $checks = $tt.Checks.ToArray()
        if ($tt.Unreadable) { $details = $HiddenValue }
        else { $details = (@($tt.Details) + @($keyTexts) + @($checks | ForEach-Object { 'CHECK ' + $_ })) -join '; ' }

        # The collations of its columns are a property of their own, called Collation like a
        # table column's: -IgnoreCollation leaves out the properties of that name.
        $sqlParts = @{ Schema = $tt.Schema; Name = $tt.Name; Columns = $tt.Columns.ToArray(); KeyConstraints = $keyParts.ToArray(); Checks = $checks }
        $props = [ordered]@{ Kind = 'table type'; Spec = $spec; Details = $details; Collation = ($tt.Collations -join '; ') }
        $snap['User-defined type'][$key] = New-SchemaItem $key $props -Sql $sqlParts
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Sequences)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.SequenceName
        $props = [ordered]@{ DataType = [string]$r.DataType }
        # decimal and numeric only: "decimal" alone is decimal(18,0), and the limits of a wider
        # sequence do not fit that (Msg 11708). Left out for every other type, and missing in
        # snapshots taken before 2026-11-11: a prop missing on one side is not compared.
        if ($r.Precision -isnot [System.DBNull]) { $props['Precision'] = [string]$r.Precision }
        $props['Start'] = [string]$r.StartValue
        $props['Increment'] = [string]$r.Increment
        $props['Min'] = [string]$r.MinValue
        $props['Max'] = [string]$r.MaxValue
        $props['Cycle'] = [string]$r.Cycle
        $props['Cache'] = [string]$r.Cache
        $snap['Sequence'][$key] = New-SchemaItem $key $props -Sql @{ Schema = [string]$r.SchemaName; Name = [string]$r.SequenceName }
    }

    foreach ($r in (Invoke-SqlQuery $Connection $Sql.Synonyms)) {
        $key = '{0}.{1}' -f $r.SchemaName, $r.SynonymName
        $sqlParts = @{ Schema = [string]$r.SchemaName; Name = [string]$r.SynonymName }
        $snap['Synonym'][$key] = New-SchemaItem $key ([ordered]@{ BaseObject = [string]$r.BaseObject }) -Sql $sqlParts
    }

    return $snap
}

# ---------------------------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------------------------

function Get-ComparableText([string]$Text) {
    if ($IgnoreWhitespace) { return ($Text -replace '\s+', ' ').Trim() }
    return $Text
}

# The whole header of a module: CREATE [OR ALTER] <kind> [schema.]name and, for a trigger, ON
# [schema.]table. A name part is [bracketed], "quoted" or bare; whitespace and comments may stand
# between the tokens and around the dot, and nothing has to stand before a bracket or a quote
# (CREATE PROCEDURE[dbo].[p]AS ... is valid). Precompiled: it runs on every module.
# The pieces are atomic, (?>...), and a block comment is matched with its nested comments counted
# (T-SQL nests them) instead of lazily up to some later "*/": a header that does not fit must fail
# at once. With a lazy comment, a text of a few thousand block comments and no readable header
# kept the regex busy for minutes.
$ModuleComment = '/\*(?>(?:[^/*]+|/(?!\*)|\*(?!/)|(?<c>/\*)|(?<-c>\*/))*)(?(c)(?!))\*/'
$ModuleGap = '(?:\s|--[^\n]*\n|' + $ModuleComment + ')'
$ModuleNamePart = '(?>\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|[^\s\[\]"''.,;()/\-]+)'
$ModuleNameHeader = New-Object System.Text.RegularExpressions.Regex((
    '\A(?<lead>(?>(?:\s|--[^\n]*(?:\n|\z)|COMMENT)*))' +
    '(?<create>CREATE)(?<oralter>(?>GAP+)OR(?>GAP+)ALTER)?(?>GAP+)' +
    '(?<kind>PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)(?![\w@#$])(?>GAP*)' +
    '(?<object>(?:(?<schema>PART)(?>GAP*)\.(?>GAP*))?(?<name>PART))' +
    '(?:(?>GAP*)ON(?![\w@#$])(?>GAP*)(?<parent>(?:(?<pschema>PART)(?>GAP*)\.(?>GAP*))?(?<pname>PART)))?'
).Replace('COMMENT', $ModuleComment).Replace('GAP', $ModuleGap).Replace('PART', $ModuleNamePart), 'IgnoreCase')

# Only the start of a header, for a definition whose header the pattern above cannot read. SQL
# Server stores a module deployed with CREATE OR ALTER as "CREATE   PROCEDURE ..." (the two words
# become spaces), so the leading CREATE [OR ALTER] is compared as a plain "CREATE ". Built from
# the same atomic pieces, for the same reason: it is tried on every definition the first pattern
# does not fit, and must give up as fast.
$ModuleHeader = New-Object System.Text.RegularExpressions.Regex((
    '\A((?>(?:\s|--[^\n]*(?:\n|\z)|COMMENT)*))CREATE(?>GAP+)(?:OR(?>GAP+)ALTER(?>GAP+))?'
).Replace('COMMENT', $ModuleComment).Replace('GAP', $ModuleGap), 'IgnoreCase')

# The name written in a module's header is not always its name: sp_rename and ALTER SCHEMA ...
# TRANSFER leave the stored text as it was, and so does the table a trigger names when that table
# is renamed. Both sides of a comparison are the same object by catalog name already, so the
# header name (and a trigger's table, which is compared as the Table property) is left out:
# without this, a module the sync script created under its catalog name would differ from its
# source for ever.
function Get-ComparableDefinition([string]$Text) {
    $display = Get-DisplayDefinition $Text
    $m = $ModuleNameHeader.Match($display)
    if (-not $m.Success) { return Get-ComparableText ($ModuleHeader.Replace($display, '${1}CREATE ', 1)) }
    $kind = $m.Groups['kind']
    $object = $m.Groups['object']
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append($m.Groups['lead'].Value).Append('CREATE ')
    [void]$builder.Append($display, $kind.Index, $object.Index - $kind.Index).Append('<name>')
    $end = $object.Index + $object.Length
    $parent = $m.Groups['parent']
    if ($parent.Success -and $kind.Value -ieq 'TRIGGER') {
        [void]$builder.Append($display, $end, $parent.Index - $end).Append('<name>')
        $end = $parent.Index + $parent.Length
    }
    [void]$builder.Append($display, $end, $display.Length - $end)
    return Get-ComparableText $builder.ToString()
}

function Test-SameText([string]$A, [string]$B) {
    if ($IgnoreCase) { return $A -eq $B }
    return $A -ceq $B
}

# Table and column names are matched ignoring case, so lists of column names inside an index or a
# foreign key are compared the same way (otherwise "Id" vs "id" shows up as a changed index).
$NameListProps = @{ 'Columns' = $true; 'Include' = $true; 'References' = $true }

function Test-SameProp([string]$Prop, [string]$A, [string]$B) {
    if ($NameListProps.ContainsKey($Prop)) { return (Get-ComparableText $A) -eq (Get-ComparableText $B) }
    return Test-SameText (Get-ComparableText $A) (Get-ComparableText $B)
}

# Returns which side holds an unreadable value ('' when both sides are readable).
function Get-UnreadableSide([string]$A, [string]$B, [string]$Marker) {
    if ($A -eq $Marker -and $B -eq $Marker) { return 'not readable on either side' }
    if ($A -eq $Marker) { return 'not readable on source' }
    if ($B -eq $Marker) { return 'not readable on target' }
    return ''
}

function Format-Value([string]$Value) {
    if ($Value -eq '') { return '(none)' }
    return $Value
}

function Get-ComparedProps($Item) {
    foreach ($prop in $Item.Props.get_Keys()) {
        if (-not $IgnoredProps.ContainsKey($prop)) { $prop }
    }
}

function Get-ItemSummary($Item) {
    $parts = foreach ($prop in (Get-ComparedProps $Item)) {
        $value = [string]$Item.Props[$prop]
        if ($value) { '{0}: {1}' -f $prop, $value }
    }
    return (@($parts) -join '; ')
}

function New-DiffRecord {
    param(
        [string]$Category,
        [string]$Object,
        [string]$Status,
        [string]$Detail,
        $SourceDefinition,
        $TargetDefinition,
        # Snapshot keys of the item on each side, for the sync script.
        $SourceKey = $null,
        $TargetKey = $null
    )
    [pscustomobject]@{
        Category         = $Category
        Object           = $Object
        Status           = $Status
        Detail           = $Detail
        SourceDefinition = $SourceDefinition
        TargetDefinition = $TargetDefinition
        SourceKey        = $SourceKey
        TargetKey        = $TargetKey
    }
}

function Get-ItemSignature($Item) {
    $values = foreach ($prop in (Get-ComparedProps $Item)) {
        $value = Get-ComparableText ([string]$Item.Props[$prop])
        if ($NameListProps.ContainsKey($prop)) { $value.ToLowerInvariant() } else { $value }
    }
    $signature = $Item.Parent + [char]31 + (@($values) -join [char]31)
    if ($IgnoreCase) { $signature = $signature.ToLowerInvariant() }
    return $signature
}

function Compare-SchemaSet {
    param(
        [string]$Category,
        [hashtable]$Source,
        [hashtable]$Target,
        [hashtable]$CommonParents
    )

    $keys = New-Object 'System.Collections.Generic.SortedSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in $Source.get_Keys()) { [void]$keys.Add($key) }
    foreach ($key in $Target.get_Keys()) { [void]$keys.Add($key) }

    $records = New-Object System.Collections.Generic.List[object]
    $onlySource = New-Object System.Collections.Generic.List[object]
    $onlyTarget = New-Object System.Collections.Generic.List[object]

    foreach ($key in $keys) {
        $s = $Source[$key]
        $t = $Target[$key]
        if ($null -ne $s) { $item = $s } else { $item = $t }
        if ($null -ne $CommonParents -and -not $CommonParents.ContainsKey($item.Parent)) { continue }

        if ($null -ne $s) { $s['Key'] = $key }
        if ($null -ne $t) { $t['Key'] = $key }
        if ($null -eq $t) { $onlySource.Add($s); continue }
        if ($null -eq $s) { $onlyTarget.Add($t); continue }

        $changes = New-Object System.Collections.Generic.List[string]
        $unreadable = New-Object System.Collections.Generic.List[string]
        $definitionChanged = $false
        if ($null -ne $s.Definition) {
            $side = Get-UnreadableSide $s.Definition $t.Definition $HiddenDefinition
            if ($side) { $unreadable.Add("Definition: $side") }
            elseif (-not (Test-SameText (Get-ComparableDefinition $s.Definition) (Get-ComparableDefinition $t.Definition))) {
                $definitionChanged = $true
                $changes.Add('Definition differs')
            }
        }
        foreach ($prop in (Get-ComparedProps $s)) {
            # Only on one side: a snapshot from an engine version that did not read it yet.
            if (-not $t.Props.Contains($prop)) { continue }
            $a = [string]$s.Props[$prop]
            $b = [string]$t.Props[$prop]
            $side = Get-UnreadableSide $a $b $HiddenValue
            if ($side) { $unreadable.Add("${prop}: $side") }
            elseif (-not (Test-SameProp $prop $a $b)) {
                $changes.Add(('{0}: source {1}, target {2}' -f $prop, (Format-Value $a), (Format-Value $b)))
            }
        }

        if ($changes.Count -gt 0) {
            $detail = @($changes) + @($unreadable | ForEach-Object { "$_ (not compared)" })
            if ($definitionChanged) {
                $records.Add((New-DiffRecord $Category $s.Name 'Different' ($detail -join "`n") (Get-ShownDefinition $s.Definition) (Get-ShownDefinition $t.Definition) $key $key))
            }
            else {
                $records.Add((New-DiffRecord $Category $s.Name 'Different' ($detail -join "`n") $null $null $key $key))
            }
        }
        elseif ($unreadable.Count -gt 0) {
            $records.Add((New-DiffRecord $Category $s.Name 'Unverified' ($unreadable -join "`n") $null $null $key $key))
        }
    }

    if ($PairableCategories -contains $Category -and $onlySource.Count -gt 0 -and $onlyTarget.Count -gt 0) {
        $targetsBySignature = New-Object System.Collections.Hashtable
        foreach ($t in $onlyTarget) {
            $signature = Get-ItemSignature $t
            if (-not $targetsBySignature.ContainsKey($signature)) {
                $targetsBySignature[$signature] = New-Object System.Collections.Generic.List[object]
            }
            $targetsBySignature[$signature].Add($t)
        }

        $unpairedSource = New-Object System.Collections.Generic.List[object]
        foreach ($s in $onlySource) {
            $candidates = $targetsBySignature[(Get-ItemSignature $s)]
            if ($null -eq $candidates -or $candidates.Count -eq 0) { $unpairedSource.Add($s); continue }
            $t = $candidates[0]
            $candidates.RemoveAt(0)
            # Same name on both sides means only the system-named flag differs: not a schema change.
            if (-not (Test-SameText $s.ObjectName $t.ObjectName)) {
                $detail = 'Name: source {0}, target {1}' -f $s.ObjectName, $t.ObjectName
                $records.Add((New-DiffRecord $Category $s.Name 'Different' $detail $null $null $s.Key $t.Key))
            }
        }

        $onlySource = $unpairedSource
        $onlyTarget = New-Object System.Collections.Generic.List[object]
        foreach ($candidates in $targetsBySignature.Values) {
            foreach ($t in $candidates) { $onlyTarget.Add($t) }
        }
    }

    foreach ($s in $onlySource) {
        $records.Add((New-DiffRecord $Category $s.Name 'OnlyInSource' (Get-ItemSummary $s) (Get-ShownDefinition $s.Definition) $null $s.Key $null))
    }
    foreach ($t in $onlyTarget) {
        $records.Add((New-DiffRecord $Category $t.Name 'OnlyInTarget' (Get-ItemSummary $t) $null (Get-ShownDefinition $t.Definition) $null $t.Key))
    }

    $records | Sort-Object Object
}

# ---------------------------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------------------------

# Precompiled: building a MatchEvaluator from a scriptblock on every string is the slow part.
$ControlChars = [regex]'[\x00-\x1f]'

function ConvertTo-JsLiteral($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [bool]) {
        if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
        return [string]$Value
    }
    $text = ([string]$Value).Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    # Escaping < > & keeps "</script>" inside a definition from closing the report's script tag.
    $text = $text.Replace('<', ('\u' + '003c')).Replace('>', ('\u' + '003e')).Replace('&', ('\u' + '0026'))
    $text = $text.Replace([string][char]0x2028, ('\u' + '2028')).Replace([string][char]0x2029, ('\u' + '2029'))
    if ($ControlChars.IsMatch($text)) { $text = $ControlChars.Replace($text, { param($m) '\u{0:x4}' -f [int][char]$m.Value }) }
    return '"' + $text + '"'
}

# Fills __PLACEHOLDER__ markers in one pass, so text inside a value (a database named
# "__DATA_JSON__", say) is never replaced again.
function Expand-Template([string]$Template, [hashtable]$Values) {
    $pattern = (@($Values.get_Keys() | ForEach-Object { [regex]::Escape($_) }) -join '|')
    $builder = New-Object System.Text.StringBuilder
    $last = 0
    foreach ($m in [regex]::Matches($Template, $pattern)) {
        [void]$builder.Append($Template, $last, $m.Index - $last)
        [void]$builder.Append([string]$Values[$m.Value])
        $last = $m.Index + $m.Length
    }
    [void]$builder.Append($Template, $last, $Template.Length - $last)
    return $builder.ToString()
}

function ConvertTo-JsArray($Values) {
    return '[' + (@($Values | ForEach-Object { ConvertTo-JsLiteral $_ }) -join ',') + ']'
}

# ---------------------------------------------------------------------------------------------
# JSON files: result files for the web app, schema snapshots
# ---------------------------------------------------------------------------------------------

function Add-JsonValue([System.Text.StringBuilder]$Builder, $Value) {
    if ($null -eq $Value -or $Value -is [System.DBNull]) { [void]$Builder.Append('null'); return }
    if ($Value -is [string] -or $Value -is [char]) { [void]$Builder.Append((ConvertTo-JsLiteral ([string]$Value))); return }
    if ($Value -is [bool]) {
        if ($Value) { [void]$Builder.Append('true') } else { [void]$Builder.Append('false') }
        return
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or
        $Value -is [single] -or $Value -is [int16] -or $Value -is [byte]) {
        [void]$Builder.Append([System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture))
        return
    }
    if ($Value -is [System.Collections.IDictionary]) {
        [void]$Builder.Append('{')
        $first = $true
        foreach ($key in $Value.get_Keys()) {
            if (-not $first) { [void]$Builder.Append(',') }
            $first = $false
            [void]$Builder.Append((ConvertTo-JsLiteral ([string]$key)))
            [void]$Builder.Append(':')
            Add-JsonValue $Builder $Value[$key]
        }
        [void]$Builder.Append('}')
        return
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        [void]$Builder.Append('{')
        $first = $true
        foreach ($property in $Value.PSObject.Properties) {
            if (-not $first) { [void]$Builder.Append(',') }
            $first = $false
            [void]$Builder.Append((ConvertTo-JsLiteral $property.Name))
            [void]$Builder.Append(':')
            Add-JsonValue $Builder $property.Value
        }
        [void]$Builder.Append('}')
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        [void]$Builder.Append('[')
        $first = $true
        foreach ($element in $Value) {
            if (-not $first) { [void]$Builder.Append(',') }
            $first = $false
            Add-JsonValue $Builder $element
        }
        [void]$Builder.Append(']')
        return
    }
    [void]$Builder.Append((ConvertTo-JsLiteral ([string]$Value)))
}

function ConvertTo-JsonText($Value) {
    $builder = New-Object System.Text.StringBuilder
    Add-JsonValue $builder $Value
    return $builder.ToString()
}

function Write-JsonFile([string]$Path, $Value) {
    [System.IO.File]::WriteAllText($Path, (ConvertTo-JsonText $Value), $Utf8NoBom)
}

# Raw UTF-8 bytes on stdout: going through the console encoder adds a BOM when output is redirected.
function Write-JsonStdout($Value) {
    $bytes = $Utf8NoBom.GetBytes((ConvertTo-JsonText $Value))
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Read-JsonFile([string]$Path) {
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    return $serializer.DeserializeObject([System.IO.File]::ReadAllText($Path, $Utf8NoBom))
}

function Export-SchemaSnapshot([string]$Path, $Snap, [string]$ServerLabel, [string]$Database) {
    $categories = [ordered]@{}
    foreach ($category in $CategoryOrder) { $categories[$category] = $Snap[$category] }
    Write-JsonFile $Path ([ordered]@{
        format            = 'database-diff-snapshot'
        version           = [int]$Snap['Meta'].Version
        captured          = (Get-Timestamp 's')
        server            = $ServerLabel
        serverName        = [string]$Snap['Meta'].ServerName
        database          = $Database
        login             = $Snap['Meta'].LoginName
        canViewDefinition = [bool]$Snap['Meta'].CanViewDefinition
        categories        = $categories
    })
}

# Snapshots written before 2026-10-27 lost the index name parts (a hashtable entry called "Keys"
# hid the real key list during export). Rebuild them from the props so index scripting works.
function Repair-IndexSql([string]$Key, $Item) {
    $parent = [string]$Item.Parent
    $dot = $parent.IndexOf('.')
    if ($dot -lt 1) { return $null }
    $keyParts = @(([string]$Item.Props['Columns']) -split ', ' | Where-Object { $_ } | ForEach-Object {
        if ($_ -match '^(.*) DESC$') { @{ Name = $Matches[1]; Desc = $true } } else { @{ Name = $_; Desc = $false } }
    })
    $includes = @(([string]$Item.Props['Include']) -split ', ' | Where-Object { $_ })
    $systemNamed = ([string]$Item.Props['Name'] -eq '(system-named)') -or ($Key -like '*|UQ(*')
    return @{
        Schema        = $parent.Substring(0, $dot)
        Table         = $parent.Substring($dot + 1)
        Name          = [string]$Item.ObjectName
        IsSystemNamed = $systemNamed
        KeyParts      = $keyParts
        Includes      = $includes
    }
}

function Import-SchemaSnapshot([string]$Path) {
    $doc = Read-JsonFile $Path
    if ($doc['format'] -ne 'database-diff-snapshot') { throw "Not a database-diff snapshot: $Path" }

    $snap = @{}
    foreach ($category in $CategoryOrder) {
        $set = @{}
        $items = $doc['categories'][$category]
        if ($items) {
            foreach ($key in $items.get_Keys()) {
                $i = $items[$key]
                $props = [ordered]@{}
                if ($i['Props']) { foreach ($prop in $i['Props'].get_Keys()) { $props[$prop] = [string]$i['Props'][$prop] } }
                $sqlParts = $null
                if ($i.ContainsKey('Sql')) { $sqlParts = $i['Sql'] }
                $item = New-SchemaItem ([string]$i['Name']) $props ([string]$i['Parent']) $i['Definition'] ([string]$i['ObjectName']) $sqlParts
                if ($category -eq 'Index' -and ($null -eq $sqlParts -or -not $sqlParts.ContainsKey('KeyParts'))) {
                    $item.Sql = Repair-IndexSql $key $item
                }
                $set[$key] = $item
            }
        }
        $snap[$category] = $set
    }
    # serverName: snapshots saved before 2026-11-11 do not have it. version: what the engine that
    # saved the file read (see $SnapshotVersion); 0 when the file does not say.
    $snap['Meta'] = @{ CanViewDefinition = [bool]$doc['canViewDefinition']; LoginName = [string]$doc['login']; ServerName = [string]$doc['serverName']; Version = [int]$doc['version'] }
    return @{
        Snap     = $snap
        Server   = [string]$doc['server']
        Database = [string]$doc['database']
        Captured = [string]$doc['captured']
    }
}

function Write-JsonReport([string]$Path, $Result, $SourceSnap, $TargetSnap) {
    # PowerShell 5.1 throws "Argument types do not match" for @($genericList) inside a hashtable
    # literal, so the arrays are built first.
    $warnings = [object[]]@($Result.Warnings)
    $summary = [object[]]@($Result.Summary)
    $diffs = [object[]]$Result.Diffs.ToArray()
    $categories = [object[]]@($SelectedCategories)
    Write-JsonFile $Path ([ordered]@{
        format    = 'database-diff-result'
        version   = 1
        generated = (Get-Timestamp 's')
        source    = [ordered]@{
            label             = $Result.SourceLabel
            serverName        = [string]$SourceSnap['Meta'].ServerName
            login             = $SourceSnap['Meta'].LoginName
            canViewDefinition = [bool]$SourceSnap['Meta'].CanViewDefinition
        }
        target    = [ordered]@{
            label             = $Result.TargetLabel
            serverName        = [string]$TargetSnap['Meta'].ServerName
            login             = $TargetSnap['Meta'].LoginName
            canViewDefinition = [bool]$TargetSnap['Meta'].CanViewDefinition
        }
        categories  = $categories
        perspective = $Perspective
        options   = [ordered]@{
            ignoreWhitespace   = [bool]$IgnoreWhitespace
            ignoreCase         = [bool]$IgnoreCase
            ignoreCollation    = [bool]$IgnoreCollation
            compareColumnOrder = [bool]$CompareColumnOrder
        }
        counts    = [ordered]@{
            onlyInSource = $Result.OnlyInSource
            onlyInTarget = $Result.OnlyInTarget
            different    = $Result.Different
            unverified   = $Result.Unverified
        }
        warnings   = $warnings
        syncScript = $Result.SyncScript
        syncError  = $Result.SyncError
        rollbackScript = $Result.RollbackScript
        rollbackError  = $Result.RollbackError
        summary    = $summary
        diffs      = $diffs
    })
}

# The templates are UTF-8 (they hold the Thai text of the reports); ReadAllText reads a file
# without a byte order mark as UTF-8.
$ReportTemplate = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'templates\report.html'))

# The table or view a difference belongs to, for the HTML report, which shows everything of one
# table together: 'table' or 'view', then the snapshot key of that table or view. A table and a
# view are their own group. Nothing ($null) for what belongs to neither: procedures, functions,
# types, sequences, synonyms, schemas, database triggers. Taken from the snapshot items (the
# Parent of a column, index or constraint; the Table property of a trigger), never from the
# name that is shown: a name can hold dots.
function Get-DiffGroup($Diff, $SourceSnap, $TargetSnap) {
    $category = [string]$Diff.Category
    if ($null -ne $Diff.SourceKey) { $key = [string]$Diff.SourceKey; $own = $SourceSnap; $other = $TargetSnap }
    else { $key = [string]$Diff.TargetKey; $own = $TargetSnap; $other = $SourceSnap }
    if ($category -eq 'Table') { return @('table', $key) }
    if ($category -eq 'View') { return @('view', $key) }
    $item = $own[$category][$key]
    if ($null -eq $item) { return $null }
    if ($category -eq 'Trigger') {
        if (Test-DatabaseScope $item) { return $null }
        $parent = [string]$item.Props['Table']
    }
    elseif ($TableChildCategories -contains $category) { $parent = [string]$item.Parent }
    else { return $null }
    if (-not $parent) { return $null }
    # What the parent is on the side the item was read from; the other side when that side does
    # not have it (a trigger on a table that is not among the tables read is taken as a table's).
    foreach ($snap in @($own, $other)) {
        if ($snap['Table'].ContainsKey($parent)) { return @('table', $parent) }
        if ($snap['View'].ContainsKey($parent)) { return @('view', $parent) }
    }
    return @('table', $parent)
}

function Write-HtmlReport {
    param(
        [string]$Path,
        [string]$SourceLabel,
        [string]$TargetLabel,
        $Diffs,
        $Summary,
        [string[]]$Warnings = @(),
        $SourceSnap,
        $TargetSnap
    )

    # The sides read without VIEW DEFINITION, as [side, login] pairs: the report explains in its
    # own words what that means (the warnings are the same sentences as in the scripts).
    $noViewDefinition = @(foreach ($side in @(@('source', $SourceSnap), @('target', $TargetSnap))) {
        $sideMeta = $side[1]['Meta']
        if (-not $sideMeta.CanViewDefinition) { ConvertTo-JsArray @($side[0], [string]$sideMeta.LoginName) }
    }) -join ','

    $summaryJs = @($Summary | ForEach-Object {
        '[' + (@(
            (ConvertTo-JsLiteral $_.Category), $_.Source, $_.Target, $_.OnlyInSource, $_.OnlyInTarget, $_.Different, $_.Unverified
        ) -join ',') + ']'
    }) -join ','

    $meta = '{' + (@(
        '"source":' + (ConvertTo-JsLiteral $SourceLabel)
        '"target":' + (ConvertTo-JsLiteral $TargetLabel)
        '"generated":' + (ConvertTo-JsLiteral (Get-Timestamp 'yyyy-MM-dd HH:mm:ss'))
        '"ignoreWhitespace":' + (ConvertTo-JsLiteral ([bool]$IgnoreWhitespace))
        '"ignoreCase":' + (ConvertTo-JsLiteral ([bool]$IgnoreCase))
        '"ignoreCollation":' + (ConvertTo-JsLiteral ([bool]$IgnoreCollation))
        '"compareColumnOrder":' + (ConvertTo-JsLiteral ([bool]$CompareColumnOrder))
        '"categories":' + (ConvertTo-JsArray $SelectedCategories)
        '"perspective":' + (ConvertTo-JsLiteral $Perspective)
        '"warnings":' + (ConvertTo-JsArray @($Warnings))
        '"noViewDefinition":[' + $noViewDefinition + ']'
        '"summary":[' + $summaryJs + ']'
    ) -join ',') + '}'

    # One row per difference: category, object, status, detail, source definition, target
    # definition, and last its group (see Get-DiffGroup) as [kind, key] or null. Only the report
    # has the group: the result file and the difference records stay as they are.
    $data = '[' + (@($Diffs | ForEach-Object {
        $row = ConvertTo-JsArray @($_.Category, $_.Object, $_.Status, $_.Detail, $_.SourceDefinition, $_.TargetDefinition)
        $group = Get-DiffGroup $_ $SourceSnap $TargetSnap
        if ($null -eq $group) { $groupJs = 'null' } else { $groupJs = ConvertTo-JsArray @($group) }
        $row.Substring(0, $row.Length - 1) + ',' + $groupJs + ']'
    }) -join ",`n") + ']'

    $html = Expand-Template $ReportTemplate @{ '__META_JSON__' = $meta; '__DATA_JSON__' = $data }

    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        [void](New-Item -ItemType Directory -Path $directory)
    }
    [System.IO.File]::WriteAllText($Path, $html, (New-Object System.Text.UTF8Encoding($false)))
}

. (Join-Path $PSScriptRoot 'lib\SyncScript.ps1')

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

# A side is one half of a comparison: a live database (Endpoint + Database) or a saved snapshot
# file. SaveSnapshot, when set, is where the live schema gets written.
function New-Side {
    param([hashtable]$Endpoint, [string]$Database, [string]$SnapshotFile = '', [string]$SaveSnapshot = '')
    if ($SnapshotFile) { $label = 'snapshot ' + $SnapshotFile } else { $label = Get-EndpointLabel $Endpoint $Database }
    @{ Endpoint = $Endpoint; Database = $Database; SnapshotFile = $SnapshotFile; SaveSnapshot = $SaveSnapshot; Label = $label }
}

# The instance named in an address that also has a port ("host\NAME,1433"). SqlClient ignores the
# name when a port is given and connects to whatever listens on that port, which can be another
# instance on the same host. Without a port the name is resolved by SQL Browser, so it cannot miss.
function Get-RequestedInstance([string]$Server) {
    if ($Server -match '^\s*(?:tcp:)?[^\\,]+\\([^\\,]+?)\s*,\s*\d+\s*$') { return $Matches[1] }
    return ''
}

# The server and instance that answered on an endpoint. Asked once and kept on the endpoint: a
# batch opens one connection per database.
function Get-ServerIdentity([hashtable]$Endpoint, $Connection) {
    if (-not $Endpoint.ContainsKey('Identity')) {
        $r = @(Invoke-SqlQuery $Connection $Sql.ServerIdentity)[0]
        $Endpoint['Identity'] = @{ ServerName = [string]$r.ServerName; InstanceName = [string]$r.InstanceName }
    }
    return $Endpoint['Identity']
}

# Stops the run when the address names one instance and another one answered (see
# Get-RequestedInstance): going on would put another server's schema under this server's name in
# the reports, snapshots and scripts. $Endpoint is a hashtable, or a dictionary in the tests.
function Assert-RequestedInstance($Endpoint, [string]$InstanceName, [string]$ServerName) {
    $requested = Get-RequestedInstance ([string]$Endpoint['Server'])
    if (-not $requested -or $requested -eq $InstanceName) { return }
    throw ('The address {0} names instance {1}, but {2} (instance {3}) answered: with a port in the address SQL Server connects by port and ignores the instance name. Remove the port to connect by instance name, or set the port that {1} listens on.' -f $Endpoint['Server'], $requested, $ServerName, $InstanceName)
}

function Read-SideSnapshot([hashtable]$Side) {
    if ($Side.SnapshotFile) {
        $loaded = Import-SchemaSnapshot $Side.SnapshotFile
        $Side.Database = $loaded.Database
        $Side.Label = '{0} / {1} (snapshot {2})' -f $loaded.Server, $loaded.Database, $loaded.Captured
        return $loaded.Snap
    }
    try { $connection = Open-SqlConnection $Side.Endpoint $Side.Database }
    catch {
        # The database may be missing only because another instance answered (it is on the one
        # the address names). Then that is the error to report, not "cannot open database": the
        # server says who it is through master. Whatever goes wrong here, the first error stands.
        $openError = $_
        if (Get-RequestedInstance ([string]$Side.Endpoint.Server)) {
            $identity = $null
            try {
                $master = Open-SqlConnection $Side.Endpoint 'master'
                try { $identity = Get-ServerIdentity $Side.Endpoint $master }
                finally { $master.Dispose() }
            }
            catch { $identity = $null }
            if ($null -ne $identity) { Assert-RequestedInstance $Side.Endpoint $identity.InstanceName $identity.ServerName }
        }
        throw $openError
    }
    try {
        # Before anything is read: a report must not carry the name of a server that was not read.
        $identity = Get-ServerIdentity $Side.Endpoint $connection
        Assert-RequestedInstance $Side.Endpoint $identity.InstanceName $identity.ServerName
        $snap = Get-SchemaSnapshot $connection
        $snap['Meta'].ServerName = $identity.ServerName
    }
    finally { $connection.Dispose() }
    if ($Side.SaveSnapshot) { Export-SchemaSnapshot $Side.SaveSnapshot $snap (Get-ServerLabel $Side.Endpoint) $Side.Database }
    return $snap
}

# True for a database trigger (ON DATABASE): an item of the Trigger category with that scope.
# Name parts come as a hashtable (live snapshot) or a Dictionary (snapshot loaded from JSON).
function Test-DatabaseScope($Item) {
    if ($null -eq $Item -or $null -eq $Item.Sql) { return $false }
    return $Item.Sql.ContainsKey('Scope') -and [string]$Item.Sql['Scope'] -eq 'DATABASE'
}

# The items of a set without the database triggers, for a comparison in which one side never
# read them.
function Get-ItemsWithoutDatabaseScope($Items) {
    $kept = @{}
    foreach ($key in @($Items.get_Keys())) {
        if (-not (Test-DatabaseScope $Items[$key])) { $kept[$key] = $Items[$key] }
    }
    return $kept
}

function Invoke-DatabaseComparison {
    param(
        [hashtable]$SourceSide,
        [hashtable]$TargetSide,
        [string]$ReportPath
    )

    $sourceSnap = Read-SideSnapshot $SourceSide
    $targetSnap = Read-SideSnapshot $TargetSide
    $SourceDb = $SourceSide.Database
    $TargetDb = $TargetSide.Database

    $commonTables = @{}
    foreach ($key in $sourceSnap['Table'].get_Keys()) {
        if ($targetSnap['Table'].ContainsKey($key)) { $commonTables[$key] = $true }
    }

    # The indexes of views and database triggers are read since snapshot version 2. A side that
    # comes from an older snapshot file has neither, and that must not read as "the other side
    # has them and this one does not": they are compared only when both sides were read.
    $bothRead = ([int]$sourceSnap['Meta'].Version -ge 2) -and ([int]$targetSnap['Meta'].Version -ge 2)

    # An index belongs to a table or to a view. Like a table's, a view's indexes are compared only
    # when the view is on both sides: a view on one side only is reported once, under View.
    $indexParents = @{}
    foreach ($key in $commonTables.get_Keys()) { $indexParents[$key] = $true }
    if ($bothRead) {
        foreach ($key in $sourceSnap['View'].get_Keys()) {
            if ($targetSnap['View'].ContainsKey($key)) { $indexParents[$key] = $true }
        }
    }

    $diffs = New-Object System.Collections.Generic.List[object]
    foreach ($category in $SelectedCategories) {
        if ($category -eq 'Index') { $parents = $indexParents }
        elseif ($TableChildCategories -contains $category) { $parents = $commonTables }
        else { $parents = $null }
        $sourceSet = $sourceSnap[$category]
        $targetSet = $targetSnap[$category]
        if ($category -eq 'Trigger' -and -not $bothRead) {
            $sourceSet = Get-ItemsWithoutDatabaseScope $sourceSet
            $targetSet = Get-ItemsWithoutDatabaseScope $targetSet
        }
        foreach ($record in (Compare-SchemaSet $category $sourceSet $targetSet $parents)) {
            $diffs.Add($record)
        }
    }
    if (-not $bothRead -and ($SelectedCategories -contains 'Index' -or $SelectedCategories -contains 'Trigger')) {
        # Not a warning: the warnings of a result mean "no VIEW DEFINITION" to the web app.
        Write-Host 'Note: one side is a snapshot saved before the engine read the indexes of views and database triggers. Those are not compared in this run.'
    }

    $summary = foreach ($category in $SelectedCategories) {
        $items = @($diffs | Where-Object { $_.Category -eq $category })
        [pscustomobject]@{
            Category     = $category
            Source       = $sourceSnap[$category].get_Count()
            Target       = $targetSnap[$category].get_Count()
            OnlyInSource = @($items | Where-Object { $_.Status -eq 'OnlyInSource' }).Count
            OnlyInTarget = @($items | Where-Object { $_.Status -eq 'OnlyInTarget' }).Count
            Different    = @($items | Where-Object { $_.Status -eq 'Different' }).Count
            Unverified   = @($items | Where-Object { $_.Status -eq 'Unverified' }).Count
        }
    }

    # Without VIEW DEFINITION, catalog views hide objects the login has no other permission on and
    # return NULL definitions, so the comparison cannot be complete.
    $warnings = @()
    foreach ($side in @(@('source', $sourceSnap, $SourceDb), @('target', $targetSnap, $TargetDb))) {
        $meta = $side[1]['Meta']
        if (-not $meta.CanViewDefinition) {
            $warnings += ('Login {0} has no VIEW DEFINITION permission in {1} database {2}: objects it cannot access are invisible and definitions read as empty, so this comparison is incomplete.' -f $meta.LoginName, $side[0], $side[2])
        }
    }

    Write-HtmlReport $ReportPath $SourceSide.Label $TargetSide.Label $diffs $summary $warnings $sourceSnap $targetSnap

    # A target read without VIEW DEFINITION hides objects, so "only in source" can mean "there, but
    # not visible": the scripts then neither replace nor drop such an object. Taken from the real
    # target here, once: the rollback script gets the snapshots the other way round.
    $targetIncomplete = -not $targetSnap['Meta'].CanViewDefinition

    # A failing sync or rollback script must not lose the comparison itself; the error is reported instead.
    $syncPath = [System.IO.Path]::ChangeExtension($ReportPath, '.sync.sql')
    $syncError = ''
    try {
        Write-SyncScript $syncPath $sourceSnap $targetSnap $diffs $SourceSide.Label $TargetSide.Label $TargetDb $warnings -TargetIncomplete:$targetIncomplete
    }
    catch {
        $syncError = $_.Exception.Message
        Write-Host ('Sync script failed: {0}' -f $syncError) -ForegroundColor Red
        Write-Verbose $_.ScriptStackTrace
    }
    $rollbackPath = [System.IO.Path]::ChangeExtension($ReportPath, '.rollback.sql')
    $rollbackError = ''
    try {
        Write-RollbackScript $rollbackPath $sourceSnap $targetSnap $diffs $SourceSide.Label $TargetSide.Label $TargetDb $warnings -TargetIncomplete:$targetIncomplete
    }
    catch {
        $rollbackError = $_.Exception.Message
        Write-Host ('Rollback script failed: {0}' -f $rollbackError) -ForegroundColor Red
        Write-Verbose $_.ScriptStackTrace
    }

    $result = [pscustomobject]@{
        SourceLabel  = $SourceSide.Label
        TargetLabel  = $TargetSide.Label
        Diffs        = $diffs
        Summary      = $summary
        Warnings     = $warnings
        OnlyInSource = @($diffs | Where-Object { $_.Status -eq 'OnlyInSource' }).Count
        OnlyInTarget = @($diffs | Where-Object { $_.Status -eq 'OnlyInTarget' }).Count
        Different    = @($diffs | Where-Object { $_.Status -eq 'Different' }).Count
        Unverified   = @($diffs | Where-Object { $_.Status -eq 'Unverified' }).Count
        SyncScript   = $(if ($syncError) { '' } else { Split-Path -Leaf $syncPath })
        SyncError    = $syncError
        RollbackScript = $(if ($rollbackError) { '' } else { Split-Path -Leaf $rollbackPath })
        RollbackError  = $rollbackError
    }
    Write-JsonReport ([System.IO.Path]::ChangeExtension($ReportPath, '.json')) $result $sourceSnap $targetSnap
    return $result
}

function Format-ResultLine($Result) {
    $differences = $Result.OnlyInSource + $Result.OnlyInTarget + $Result.Different
    if ($differences -eq 0) { $line = 'no differences found' }
    else {
        $line = '{0} differences: {1} only in source, {2} only in target, {3} different' -f $differences, $Result.OnlyInSource, $Result.OnlyInTarget, $Result.Different
    }
    if ($Result.Unverified -gt 0) { $line += '; {0} cannot compare' -f $Result.Unverified }
    return $line
}

function Get-ResultColor($Result) {
    if ($Result.Warnings.Count -gt 0) { return 'Red' }
    if ($Result.Diffs.Count -gt 0) { return 'Yellow' }
    return 'Green'
}

function Get-DatabaseList([hashtable]$Endpoint) {
    $connection = Open-SqlConnection $Endpoint 'master'
    try {
        # A batch asks for this list first, so a wrong instance fails it once, before any database.
        $identity = Get-ServerIdentity $Endpoint $connection
        Assert-RequestedInstance $Endpoint $identity.InstanceName $identity.ServerName
        foreach ($r in (Invoke-SqlQuery $connection $Sql.DatabaseList)) {
            [pscustomobject]@{ Name = [string]$r.DatabaseName; HasAccess = ([int]$r.HasAccess -eq 1) }
        }
    }
    finally {
        $connection.Dispose()
    }
}

# Server facts and the database list as JSON on stdout, for the web app (also a connection test).
# A wrong instance (see Assert-RequestedInstance) is reported here, not thrown: the servers page
# shows which instance answered so the address can be corrected.
function Write-DatabaseList([hashtable]$Endpoint) {
    $connection = Open-SqlConnection $Endpoint 'master'
    try {
        $info = @(Invoke-SqlQuery $connection $Sql.ServerInfo)[0]
        $databases = foreach ($r in (Invoke-SqlQuery $connection $Sql.DatabaseList)) {
            [ordered]@{
                name              = [string]$r.DatabaseName
                hasAccess         = ([int]$r.HasAccess -eq 1)
                canViewDefinition = ([int]$r.CanViewDefinition -eq 1)
                state             = [string]$r.State
            }
        }
    }
    finally {
        $connection.Dispose()
    }
    $requested = Get-RequestedInstance $Endpoint.Server
    Write-JsonStdout ([ordered]@{
        server            = Get-ServerLabel $Endpoint
        serverName        = [string]$info.ServerName
        instance          = [string]$info.InstanceName
        requestedInstance = $requested
        instanceMismatch  = [bool]($requested -and $requested -ne [string]$info.InstanceName)
        version           = [string]$info.Version
        edition           = [string]$info.Edition
        collation         = [string]$info.Collation
        login             = [string]$info.LoginName
        viewAnyDefinition = ([int]$info.ViewAnyDefinition -eq 1)
        databases         = @($databases)
    })
}

$IndexTemplate = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'templates\index.html'))

function Write-IndexReport {
    param(
        [string]$Path,
        [string]$SourceLabel,
        [string]$TargetLabel,
        $Results,
        [string[]]$OnlyOnSourceServer,
        [string[]]$OnlyOnTargetServer,
        $NoAccess = @()
    )

    # The page is built in the browser from this data, like the report of one database: the text
    # of the page is in the template (templates\index.html), which can hold what this file cannot.
    # The arrays are built before the hashtable literal (see Write-JsonReport).
    $rows = [object[]]@($Results | ForEach-Object {
        # The sides read without VIEW DEFINITION, from the warnings of the comparison.
        $sides = [object[]]@($_.Warnings | ForEach-Object { if ($_ -match 'in (source|target) database') { $Matches[1] } })
        [ordered]@{
            database     = [string]$_.Database
            report       = [string]$_.Report
            error        = [string]$_.Error
            onlyInSource = [int]$_.OnlyInSource
            onlyInTarget = [int]$_.OnlyInTarget
            different    = [int]$_.Different
            unverified   = [int]$_.Unverified
            incomplete   = $sides
        }
    })
    $categories = [object[]]@($SelectedCategories)
    $onlySourceList = [object[]]@($OnlyOnSourceServer | Where-Object { $_ })
    $onlyTargetList = [object[]]@($OnlyOnTargetServer | Where-Object { $_ })
    $noAccessList = [object[]]@($NoAccess)
    $index = ConvertTo-JsonText ([ordered]@{
        source       = $SourceLabel
        target       = $TargetLabel
        generated    = (Get-Timestamp 'yyyy-MM-dd HH:mm:ss')
        categories   = $categories
        options      = [ordered]@{
            ignoreWhitespace   = [bool]$IgnoreWhitespace
            ignoreCase         = [bool]$IgnoreCase
            ignoreCollation    = [bool]$IgnoreCollation
            compareColumnOrder = [bool]$CompareColumnOrder
        }
        rows         = $rows
        onlyOnSource = $onlySourceList
        onlyOnTarget = $onlyTargetList
        noAccess     = $noAccessList
    })

    # Every string in it went through ConvertTo-JsLiteral, which writes < > & as escapes: nothing
    # in a database name or an error message can close the script element of the page.
    $html = Expand-Template $IndexTemplate @{ '__INDEX_JSON__' = $index }
    [System.IO.File]::WriteAllText($Path, $html, (New-Object System.Text.UTF8Encoding($false)))
}

# The files a batch writes for one database, as endings of its base name.
$BatchFileSuffixes = @('.html', '.json', '.sync.sql', '.rollback.sql', '.source.snapshot.json', '.target.snapshot.json')

# What Windows reads as a device whatever extension follows: nul.html cannot be created. Tested
# against the part of a name before its first dot. Precompiled: used for every database of a batch.
$BatchDeviceName = New-Object System.Text.RegularExpressions.Regex('\A(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])\z', 'IgnoreCase')

# The file names taken in the folder of a batch, compared as Windows does (ignoring case). From
# the start: the index of the batch, and what the web app keeps in the same folder (run.json,
# run.log, heartbeat: see app/lib/runs.js).
function New-BatchFileSet {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('index.html', 'index.json', 'run.json', 'run.log', 'heartbeat')) { [void]$set.Add($name) }
    # The comma keeps the set from being unrolled into its (five) elements on the way out.
    return , $set
}

# The base name of the files of one database in a batch: its name with every character a file
# name cannot hold replaced, as it always was. Numbered (-2, -3, ...) only when one of its files
# is taken already ("sales 2024" after "sales_2024"; a database called "index" or "run";
# "a.source.snapshot", whose result would be the snapshot of "a") or the name is a Windows device.
# The files of the name returned are added to $Used.
function Get-BatchBaseName([string]$Database, $Used) {
    $baseName = $Database -replace '[^\w.-]', '_'
    $dot = $baseName.IndexOf('.')
    if ($dot -lt 0) { $dot = $baseName.Length }
    $isDevice = $BatchDeviceName.IsMatch($baseName.Substring(0, $dot))
    $candidate = $baseName
    for ($n = 1; ; $n++) {
        if ($n -gt 1) {
            # A device name is the part before the first dot, so that is where its number goes:
            # "con.x-2" would still be the console.
            if ($isDevice) { $candidate = $baseName.Insert($dot, ('-{0}' -f $n)) } else { $candidate = '{0}-{1}' -f $baseName, $n }
        }
        $free = -not ($isDevice -and $n -eq 1)
        foreach ($suffix in $BatchFileSuffixes) { if ($Used.Contains($candidate + $suffix)) { $free = $false; break } }
        if (-not $free) { continue }
        foreach ($suffix in $BatchFileSuffixes) { [void]$Used.Add($candidate + $suffix) }
        return $candidate
    }
}

$exitCode = 0
try {
    $SelectedCategories = Resolve-Categories $Categories
    if ($SourceSnapshot) { $Perspective = 'timeline' }

    # Explicit -*Server / -*Credential parameters override what a profile says.
    if ($SourceProfile) { $source = Read-ConnectionProfile $SourceProfile }
    else { $source = New-Endpoint -Server $SourceServer }
    if ($PSBoundParameters.ContainsKey('SourceServer')) { $source.Server = $SourceServer }
    if ($PSBoundParameters.ContainsKey('SourceCredential')) { $source.Credential = $SourceCredential }

    if ($TargetProfile) { $target = Read-ConnectionProfile $TargetProfile }
    elseif ($TargetServer) { $target = New-Endpoint -Server $TargetServer }
    else { $target = $source.Clone() }
    if ($TargetServer) { $target.Server = $TargetServer }
    if ($PSBoundParameters.ContainsKey('TargetCredential')) { $target.Credential = $TargetCredential }

    if ($TrustServerCertificate) {
        $source.TrustServerCertificate = $true
        $target.TrustServerCertificate = $true
    }

    if ($ListDatabases) {
        Write-DatabaseList $source
        exit 0
    }

    $batch = $AllDatabases -or $Databases
    if ($batch -and ($SourceSnapshot -or $TargetSnapshot)) { throw '-SourceSnapshot / -TargetSnapshot work with a single comparison only.' }
    if (-not $batch -and -not $SourceDatabase -and -not $SourceSnapshot) { throw 'Specify -SourceDatabase, -Databases or -AllDatabases.' }
    $stamp = Get-Timestamp 'yyyyMMdd_HHmmss'
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    if (-not $batch) {
        if (-not $TargetDatabase) { $TargetDatabase = $SourceDatabase }
        # A live side without a database name would silently read the login's default database.
        if (-not $TargetSnapshot -and -not $TargetDatabase) { throw 'Specify -TargetDatabase: the target is a live database.' }
        $sourceSide = New-Side $source $SourceDatabase $SourceSnapshot
        $targetSide = New-Side $target $TargetDatabase $TargetSnapshot
        if (-not $OutputPath) {
            if ($SourceSnapshot) { $sourceTag = 'snapshot' } else { $sourceTag = '{0}_{1}' -f (Get-EndpointTag $source), $SourceDatabase }
            if ($TargetSnapshot) { $targetTag = 'snapshot' } else { $targetTag = '{0}_{1}' -f (Get-EndpointTag $target), $TargetDatabase }
            $fileName = 'diff_{0}_vs_{1}_{2}.html' -f $sourceTag, $targetTag, $stamp
            $OutputPath = Join-Path (Join-Path $PSScriptRoot 'reports') ($fileName -replace '[^\w.-]', '_')
        }
        $OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
        $directory = Split-Path -Parent $OutputPath
        if (-not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory) }
        if ($SaveSnapshots) {
            $base = Join-Path $directory ([System.IO.Path]::GetFileNameWithoutExtension($OutputPath))
            if (-not $SourceSnapshot) { $sourceSide.SaveSnapshot = $base + '.source.snapshot.json' }
            if (-not $TargetSnapshot) { $targetSide.SaveSnapshot = $base + '.target.snapshot.json' }
        }

        Write-Host ('Source: {0}' -f $sourceSide.Label)
        Write-Host ('Target: {0}' -f $targetSide.Label)
        $result = Invoke-DatabaseComparison $sourceSide $targetSide $OutputPath
        $timer.Stop()

        Write-Host ($result.Summary | Format-Table -AutoSize | Out-String).TrimEnd()
        Write-Host ''
        foreach ($warning in $result.Warnings) { Write-Host "WARNING: $warning" -ForegroundColor Red }
        Write-Host (Format-ResultLine $result) -ForegroundColor (Get-ResultColor $result)
        Write-Host ('Report: {0}  ({1:N1}s)' -f $OutputPath, $timer.Elapsed.TotalSeconds)
        if ($result.Diffs.Count -gt 0 -or $result.Warnings.Count -gt 0) { $exitCode = 1 }

        if ($Open) { Invoke-Item -LiteralPath $OutputPath }
        if ($PassThru) { $result.Diffs }
    }
    else {
        $sourceList = @(Get-DatabaseList $source)
        $targetList = @(Get-DatabaseList $target)
        $sourceAll = @($sourceList | ForEach-Object { $_.Name })
        $targetAll = @($targetList | ForEach-Object { $_.Name })
        $sourceNames = @($sourceList | Where-Object { $_.HasAccess } | ForEach-Object { $_.Name })
        $targetNames = @($targetList | Where-Object { $_.HasAccess } | ForEach-Object { $_.Name })
        $onlyOnSource = @()
        $onlyOnTarget = @()
        $noAccess = @()
        if ($Databases) {
            # powershell -File passes "a,b" as one string, so split on commas here as well.
            $names = @($Databases | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        else {
            $names = @($sourceNames | Where-Object { $targetNames -contains $_ } | Sort-Object)
            $onlyOnSource = @($sourceAll | Where-Object { $targetAll -notcontains $_ } | Sort-Object)
            $onlyOnTarget = @($targetAll | Where-Object { $sourceAll -notcontains $_ } | Sort-Object)
            # On both servers, but the login cannot open it on at least one side: not compared.
            $noAccess = @($sourceAll | Where-Object { $targetAll -contains $_ -and $names -notcontains $_ } | Sort-Object | ForEach-Object {
                [ordered]@{ database = $_; source = ($sourceNames -contains $_); target = ($targetNames -contains $_) }
            })
        }

        if (-not $OutputPath) {
            $folder = 'batch_{0}_vs_{1}_{2}' -f (Get-EndpointTag $source), (Get-EndpointTag $target), $stamp
            $OutputPath = Join-Path (Join-Path $PSScriptRoot 'reports') ($folder -replace '[^\w.-]', '_')
        }
        $OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
        if (-not (Test-Path -LiteralPath $OutputPath)) { [void](New-Item -ItemType Directory -Path $OutputPath) }

        Write-Host ('Source: {0}' -f (Get-ServerLabel $source))
        Write-Host ('Target: {0}' -f (Get-ServerLabel $target))
        Write-Host ('Databases to compare: {0}' -f $names.Count)

        $index = 0
        $usedFiles = New-BatchFileSet
        $results = foreach ($db in $names) {
            $index++
            # "sales 2024" and "sales_2024" would share a file name; the later one is numbered.
            $baseName = Get-BatchBaseName $db $usedFiles
            $file = $baseName + '.html'
            $prefix = '[{0}/{1}] {2}' -f $index, $names.Count, $db
            try {
                if ($sourceAll -notcontains $db) { throw 'database not found on the source server' }
                if ($sourceNames -notcontains $db) { throw 'the login has no access to this database on the source server' }
                if ($targetAll -notcontains $db) { throw 'database not found on the target server' }
                if ($targetNames -notcontains $db) { throw 'the login has no access to this database on the target server' }
                $sourceSide = New-Side $source $db
                $targetSide = New-Side $target $db
                if ($SaveSnapshots) {
                    $sourceSide.SaveSnapshot = Join-Path $OutputPath ($baseName + '.source.snapshot.json')
                    $targetSide.SaveSnapshot = Join-Path $OutputPath ($baseName + '.target.snapshot.json')
                }
                $result = Invoke-DatabaseComparison $sourceSide $targetSide (Join-Path $OutputPath $file)
                $incomplete = ''
                if ($result.Warnings.Count -gt 0) { $incomplete = ' [incomplete: no VIEW DEFINITION]' }
                Write-Host ('{0} : {1}{2}' -f $prefix, (Format-ResultLine $result), $incomplete) -ForegroundColor (Get-ResultColor $result)
                if ($PassThru) {
                    foreach ($d in $result.Diffs) { $d | Add-Member -NotePropertyName Database -NotePropertyValue $db }
                }
                [pscustomobject]@{
                    Database = $db; OnlyInSource = $result.OnlyInSource; OnlyInTarget = $result.OnlyInTarget
                    Different = $result.Different; Unverified = $result.Unverified; Warnings = $result.Warnings
                    Report = $file; Error = ''; Diffs = $result.Diffs
                    SourceSnapshot = $(if ($sourceSide.SaveSnapshot) { Split-Path -Leaf $sourceSide.SaveSnapshot } else { '' })
                    TargetSnapshot = $(if ($targetSide.SaveSnapshot) { Split-Path -Leaf $targetSide.SaveSnapshot } else { '' })
                    SyncScript     = $result.SyncScript
                    RollbackScript = $result.RollbackScript
                }
            }
            catch {
                Write-Host ('{0} : error: {1}' -f $prefix, $_.Exception.Message) -ForegroundColor Red
                [pscustomobject]@{
                    Database = $db; OnlyInSource = 0; OnlyInTarget = 0; Different = 0; Unverified = 0; Warnings = @()
                    Report = ''; Error = $_.Exception.Message; Diffs = $null; SourceSnapshot = ''; TargetSnapshot = ''; SyncScript = ''; RollbackScript = ''
                }
            }
        }
        $results = @($results)

        $indexPath = Join-Path $OutputPath 'index.html'
        Write-IndexReport $indexPath (Get-ServerLabel $source) (Get-ServerLabel $target) $results $onlyOnSource $onlyOnTarget $noAccess
        $databaseRows = [object[]]@($results | ForEach-Object {
            $rowWarnings = [object[]]@($_.Warnings)
            [ordered]@{
                database     = $_.Database
                onlyInSource = $_.OnlyInSource
                onlyInTarget = $_.OnlyInTarget
                different    = $_.Different
                unverified   = $_.Unverified
                warnings       = $rowWarnings
                report         = $_.Report
                error          = $_.Error
                sourceSnapshot = $_.SourceSnapshot
                targetSnapshot = $_.TargetSnapshot
                syncScript     = $_.SyncScript
                rollbackScript = $_.RollbackScript
            }
        })
        $onlySourceList = [object[]]@($onlyOnSource)
        $onlyTargetList = [object[]]@($onlyOnTarget)
        $noAccessList = [object[]]@($noAccess)
        Write-JsonFile (Join-Path $OutputPath 'index.json') ([ordered]@{
            format       = 'database-diff-batch'
            version      = 1
            generated    = (Get-Timestamp 's')
            source       = Get-ServerLabel $source
            target       = Get-ServerLabel $target
            databases    = $databaseRows
            onlyOnSource = $onlySourceList
            onlyOnTarget = $onlyTargetList
            noAccess     = $noAccessList
        })
        $timer.Stop()

        Write-Host ''
        if ($onlyOnSource) { Write-Host ('Databases only on source server: {0}' -f ($onlyOnSource -join ', ')) }
        if ($onlyOnTarget) { Write-Host ('Databases only on target server: {0}' -f ($onlyOnTarget -join ', ')) }
        if ($noAccess) {
            Write-Host ('Databases on both servers that the login cannot open (not compared): {0}' -f (($noAccess | ForEach-Object { $_.database }) -join ', ')) -ForegroundColor Yellow
        }
        Write-Host ('Index: {0}  ({1:N1}s)' -f $indexPath, $timer.Elapsed.TotalSeconds)

        $incompleteCount = @($results | Where-Object { $_.Warnings.Count -gt 0 }).Count
        if ($incompleteCount -gt 0) {
            Write-Host ('WARNING: {0} of {1} databases were compared without VIEW DEFINITION permission; their results are incomplete (see index.html).' -f $incompleteCount, $results.Count) -ForegroundColor Red
        }

        if (@($results | Where-Object { $_.Error }).Count -gt 0) { $exitCode = 2 }
        elseif (@($results | Where-Object { $_.Diffs.Count -gt 0 -or $_.Warnings.Count -gt 0 }).Count -gt 0) { $exitCode = 1 }

        if ($Open) { Invoke-Item -LiteralPath $indexPath }
        if ($PassThru) { foreach ($r in $results) { if ($r.Diffs) { $r.Diffs } } }
    }
}
catch {
    if ($ListDatabases) {
        Write-JsonStdout ([ordered]@{ error = $_.Exception.Message })
    }
    else {
        Write-Host ('Error: {0}' -f $_.Exception.Message) -ForegroundColor Red
        Write-Verbose $_.ScriptStackTrace
    }
    $exitCode = 2
}
exit $exitCode
