# Builds a T-SQL script that changes the TARGET database so its schema matches the SOURCE, and a
# rollback script that undoes it. The scripts are for review only: this tool never runs them, and
# statements that drop objects or columns are written commented out (a rollback runs the drops
# that lose no data). Dot-sourced by Compare-Database.ps1.

function Get-QuotedName([string]$Name) { '[' + $Name.Replace(']', ']]') + ']' }

# Text for a "--" comment line: line breaks would end the comment, so they become spaces.
function Get-CommentText([string]$Text) { return ($Text -replace '[\r\n]+', ' ') }

function Get-QuotedPair([string]$Schema, [string]$Name) { (Get-QuotedName $Schema) + '.' + (Get-QuotedName $Name) }

function Get-SqlLiteral([string]$Text) { "N'" + $Text.Replace("'", "''") + "'" }

# Name parts come as a hashtable (live snapshot) or a Dictionary (snapshot loaded from JSON).
function Get-SqlPart($Item, [string]$Name) {
    if ($null -eq $Item -or $null -eq $Item.Sql) { return $null }
    if ($Item.Sql.ContainsKey($Name)) { return $Item.Sql[$Name] }
    return $null
}

function Get-QuotedList($Names) {
    return (@($Names | Where-Object { $_ } | ForEach-Object { Get-QuotedName ([string]$_) }) -join ', ')
}

# 'dbo.MyType' (user-defined) gets quoted; built-in types such as 'varchar(50)' stay as they are.
function Format-ColumnType([string]$Type) {
    if ($Type -match '^([^.(]+)\.(.+)$') { return Get-QuotedPair $Matches[1] $Matches[2] }
    return $Type
}

# A column type as the snapshot writes a user-defined one: schema.name (the same test as above).
# COLLATE cannot be written for a column of such a type (Msg 452): it has its database's collation.
function Test-UserDefinedType([string]$Type) { return $Type -match '^[^.(]+\..+$' }

function Get-TableName($Item) { Get-QuotedPair (Get-SqlPart $Item 'Schema') (Get-SqlPart $Item 'Table') }

function Get-ColumnDefinition($Item, [string]$TargetCollation) {
    $p = $Item.Props
    $name = Get-QuotedName (Get-SqlPart $Item 'Name')
    if ($p['Computed']) {
        if ($p['Computed'] -eq $HiddenValue) { return $null }
        $sql = '{0} AS {1}' -f $name, $p['Computed']
        if ($p['Persisted'] -eq 'PERSISTED') {
            $sql += ' PERSISTED'
            # Only a persisted computed column can be declared NOT NULL; any other gets its
            # nullability from the expression. Writing it for one that is NOT NULL by its
            # expression already is allowed.
            if ($p['Nullable'] -eq 'NOT NULL') { $sql += ' NOT NULL' }
        }
        return $sql
    }
    $parts = @($name, (Format-ColumnType $p['Type']))
    if (-not $IgnoreCollation -and $p['Collation'] -and $p['Collation'] -ne $TargetCollation -and -not (Test-UserDefinedType $p['Type'])) { $parts += 'COLLATE ' + $p['Collation'] }
    if ($p['Identity']) { $parts += $p['Identity'] }
    $parts += $p['Nullable']
    if ($p['Default'] -and $p['Default'] -ne $HiddenValue) { $parts += (Get-DefaultConstraintPrefix $Item) + 'DEFAULT ' + $p['Default'] }
    return $parts -join ' '
}

# "CONSTRAINT [DF_x] " for a default whose name someone chose; empty for a system-named one (and
# for snapshots taken before 2026-10-28, which did not keep the name).
function Get-DefaultConstraintPrefix($Column) {
    $name = [string](Get-SqlPart $Column 'DefaultName')
    if (-not $name) { return '' }
    return 'CONSTRAINT ' + (Get-QuotedName $name) + ' '
}

function Get-ConstraintPrefix($Item) {
    if (Get-SqlPart $Item 'IsSystemNamed') { return '' }
    return 'CONSTRAINT ' + (Get-QuotedName (Get-SqlPart $Item 'Name')) + ' '
}

function Get-IndexKeyList($Item) {
    $keys = foreach ($k in @(Get-SqlPart $Item 'KeyParts')) {
        if ($null -eq $k) { continue }
        $text = Get-QuotedName ([string]$k['Name'])
        if ($k['Desc']) { $text += ' DESC' }
        $text
    }
    return (@($keys) -join ', ')
}

function Test-ConstraintIndex($Item) { $Item.Props['Kind'] -in @('PRIMARY KEY', 'UNIQUE CONSTRAINT') }

function Get-CreateIndexSql($Item) {
    $p = $Item.Props
    $table = Get-TableName $Item
    $name = [string](Get-SqlPart $Item 'Name')
    $type = [string]$p['Type']
    if ($type -notin @('CLUSTERED', 'NONCLUSTERED')) { return '-- ' + (Get-CommentText "Not scripted: $type index $name on $table (create it manually)") }
    if ($p['Filter'] -eq $HiddenValue) { return '-- ' + (Get-CommentText "Not scripted: the filter of index $name on $table is not readable") }
    $columns = Get-IndexKeyList $Item
    if (Test-ConstraintIndex $Item) {
        if ($p['Kind'] -eq 'PRIMARY KEY') { $keyword = 'PRIMARY KEY' } else { $keyword = 'UNIQUE' }
        return 'ALTER TABLE {0} ADD {1}{2} {3} ({4});' -f $table, (Get-ConstraintPrefix $Item), $keyword, $type, $columns
    }
    if ($p['Kind'] -eq 'UNIQUE INDEX') { $unique = 'UNIQUE ' } else { $unique = '' }
    $sql = 'CREATE {0}{1} INDEX {2} ON {3} ({4})' -f $unique, $type, (Get-QuotedName $name), $table, $columns
    $includes = Get-QuotedList (Get-SqlPart $Item 'Includes')
    if ($includes) { $sql += " INCLUDE ($includes)" }
    if ($p['Filter']) { $sql += ' WHERE ' + $p['Filter'] }
    return $sql + ';'
}

function Get-DropIndexSql($Item, [switch]$IfExists) {
    $table = Get-TableName $Item
    $name = Get-QuotedName (Get-SqlPart $Item 'Name')
    if ($IfExists) { $exists = 'IF EXISTS ' } else { $exists = '' }
    if (Test-ConstraintIndex $Item) { return 'ALTER TABLE {0} DROP CONSTRAINT {1}{2};' -f $table, $exists, $name }
    return 'DROP INDEX {0}{1} ON {2};' -f $exists, $name, $table
}

function Get-DisableConstraintSql($Item) {
    if ($Item.Props['State'] -ne 'DISABLED') { return @() }
    if (Get-SqlPart $Item 'IsSystemNamed') { return @('-- The constraint above is disabled in source; its generated name is unknown, so disable it manually.') }
    return @('ALTER TABLE {0} NOCHECK CONSTRAINT {1};' -f (Get-TableName $Item), (Get-QuotedName (Get-SqlPart $Item 'Name')))
}

function Get-AddForeignKeySql($Item) {
    $p = $Item.Props
    $sql = 'ALTER TABLE {0} WITH CHECK ADD {1}FOREIGN KEY ({2}) REFERENCES {3} ({4})' -f (Get-TableName $Item), (Get-ConstraintPrefix $Item),
        (Get-QuotedList (Get-SqlPart $Item 'Columns')),
        (Get-QuotedPair (Get-SqlPart $Item 'RefSchema') (Get-SqlPart $Item 'RefTable')),
        (Get-QuotedList (Get-SqlPart $Item 'RefColumns'))
    if ($p['OnDelete'] -and $p['OnDelete'] -ne 'NO_ACTION') { $sql += ' ON DELETE ' + $p['OnDelete'].Replace('_', ' ') }
    if ($p['OnUpdate'] -and $p['OnUpdate'] -ne 'NO_ACTION') { $sql += ' ON UPDATE ' + $p['OnUpdate'].Replace('_', ' ') }
    return @(($sql + ';')) + @(Get-DisableConstraintSql $Item)
}

function Get-AddCheckSql($Item) {
    $expression = [string]$Item.Props['Expression']
    if ($expression -eq $HiddenValue) { return @('-- ' + (Get-CommentText "Not scripted: check constraint $(Get-SqlPart $Item 'Name') on $(Get-TableName $Item) is not readable")) }
    $sql = 'ALTER TABLE {0} WITH CHECK ADD {1}CHECK {2};' -f (Get-TableName $Item), (Get-ConstraintPrefix $Item), $expression
    return @($sql) + @(Get-DisableConstraintSql $Item)
}

# Names of the compared properties that differ between two items, as Compare-SchemaSet sees them:
# a property that only one side has, or that is not readable on one side, is not compared.
function Get-ChangedProps($Source, $Target) {
    foreach ($prop in (Get-ComparedProps $Source)) {
        if (-not $Target.Props.Contains($prop)) { continue }
        $a = [string]$Source.Props[$prop]
        $b = [string]$Target.Props[$prop]
        if ($a -eq $HiddenValue -or $b -eq $HiddenValue) { continue }
        if (-not (Test-SameProp $prop $a $b)) { $prop }
    }
}

# True when at least one of the script lines is a statement rather than a "--" comment.
function Test-HasStatement($Lines) {
    return @($Lines | Where-Object { $_ -and $_ -notmatch '^\s*--' }).Count -gt 0
}

function Get-DropConstraintSql($Item, [switch]$IfExists) {
    if ($IfExists) { $exists = 'IF EXISTS ' } else { $exists = '' }
    return 'ALTER TABLE {0} DROP CONSTRAINT {1}{2};' -f (Get-TableName $Item), $exists, (Get-QuotedName (Get-SqlPart $Item 'Name'))
}

# The name inside one name token of a module header: [a]]b] -> a]b, "a""b" -> a"b, bare as it is.
function Get-UnquotedName([string]$Token) {
    if ($Token.StartsWith('[')) { return $Token.Substring(1, $Token.Length - 2).Replace(']]', ']') }
    if ($Token.StartsWith('"')) { return $Token.Substring(1, $Token.Length - 2).Replace('""', '"') }
    return $Token
}

# The [schema.]name of a module header as plain text: dbo.p, or p when no schema is written.
function Get-WrittenName($SchemaGroup, $NameGroup) {
    $name = Get-UnquotedName $NameGroup.Value
    if ($SchemaGroup.Success) { return (Get-UnquotedName $SchemaGroup.Value) + '.' + $name }
    return $name
}

# True when a header writes both the schema and the name, exactly as the catalog has them.
function Test-WrittenName($SchemaGroup, $NameGroup, [string]$Schema, [string]$Name) {
    return $SchemaGroup.Success -and (Get-UnquotedName $SchemaGroup.Value) -ceq $Schema -and (Get-UnquotedName $NameGroup.Value) -ceq $Name
}

# The batch that creates a module on the target: its definition as stored in the source, with the
# header made right.
# - The name in the stored text is what the last CREATE or ALTER said. sp_rename and ALTER SCHEMA
#   ... TRANSFER do not change it, and a name without a schema says nothing about where the
#   object is: replayed as it is, such a text creates or overwrites another object. A header that
#   does not name the catalog object exactly gets the quoted catalog name. For a trigger the same
#   goes for the table after ON (a renamed table keeps its earlier name in its triggers' text).
# - CREATE becomes CREATE OR ALTER (SQL Server 2016 SP1 and later). With $CreateOnly it stays, or
#   becomes, a plain CREATE, which fails instead of replacing an object that is already there.
# Nothing else of the text changes: literals, comments and layout are the author's.
# Returns @{ Script = <text> }, or @{ Comment = '-- Not scripted: ...' } when the header cannot be
# read. $Key is the snapshot key (schema.name): all a snapshot saved without name parts has.
function ConvertTo-ModuleScript($Item, [string]$Key, [bool]$CreateOnly) {
    $definition = [string]$Item.Definition
    if ($definition -eq $HiddenDefinition) { return @{ Comment = '-- Not scripted: the source definition is not readable.' } }
    $m = $ModuleNameHeader.Match($definition)
    if (-not $m.Success) { return @{ Comment = '-- Not scripted: the definition does not start with CREATE and the name of the object; copy it from the report.' } }
    $isTrigger = $m.Groups['kind'].Value -ieq 'TRIGGER'
    $object = $m.Groups['object']
    $parent = $m.Groups['parent']
    if ($isTrigger -and -not $parent.Success) { return @{ Comment = '-- Not scripted: the table of the trigger could not be read from its definition; copy it from the report.' } }

    # What to write in place of each name token; $null keeps the token as it was written.
    $objectName = $null
    $parentName = $null
    if ($null -ne $Item.Sql) {
        # Name parts that are there but empty (a snapshot file that was edited, or of another
        # format) cannot name the object: writing [].[], or leaving the table a trigger's text
        # happens to name, would create something else.
        $schema = [string](Get-SqlPart $Item 'Schema')
        $name = [string](Get-SqlPart $Item 'Name')
        if (-not $schema -or -not $name) { return @{ Comment = '-- Not scripted: the name of the object is missing from this snapshot; rerun the comparison.' } }
        if (-not (Test-WrittenName $m.Groups['schema'] $m.Groups['name'] $schema $name)) { $objectName = Get-QuotedPair $schema $name }
        if ($isTrigger) {
            $parentSchema = [string](Get-SqlPart $Item 'ParentSchema')
            $parentObject = [string](Get-SqlPart $Item 'ParentObject')
            if (-not $parentSchema -or -not $parentObject) { return @{ Comment = '-- Not scripted: the table of the trigger is missing from this snapshot; rerun the comparison.' } }
            if (-not (Test-WrittenName $m.Groups['pschema'] $m.Groups['pname'] $parentSchema $parentObject)) { $parentName = Get-QuotedPair $parentSchema $parentObject }
        }
    }
    else {
        # A snapshot from before the engine kept name parts: the key cannot be split into schema
        # and name safely (either may hold a dot), so a header that does not name it is not fixed.
        $oldSnapshot = '-- Not scripted: the definition names {0} but the object is {1}, and this snapshot was saved by an older version without name details; rerun the comparison.'
        $written = Get-WrittenName $m.Groups['schema'] $m.Groups['name']
        if ($written -ne $Key) { return @{ Comment = (Get-CommentText ($oldSnapshot -f $written, $Key)) } }
        if ($isTrigger) {
            $table = [string]$Item.Props['Table']
            $writtenTable = Get-WrittenName $m.Groups['pschema'] $m.Groups['pname']
            if ($table -and $writtenTable -ne $table) { return @{ Comment = (Get-CommentText ($oldSnapshot -f $writtenTable, $table)) } }
        }
    }

    # Right to left, so the positions the match gave stay valid.
    $text = $definition
    if ($null -ne $parentName) { $text = $text.Remove($parent.Index, $parent.Length).Insert($parent.Index, $parentName) }
    if ($null -ne $objectName) { $text = $text.Remove($object.Index, $object.Length).Insert($object.Index, $objectName) }
    $orAlter = $m.Groups['oralter']
    if ($CreateOnly) {
        if ($orAlter.Success) { $text = $text.Remove($orAlter.Index, $orAlter.Length) }
    }
    elseif (-not $orAlter.Success) {
        $text = $text.Insert($m.Groups['create'].Index + $m.Groups['create'].Length, ' OR ALTER')
    }
    return @{ Script = $text }
}

# How many parts an object name has: [schema].[name] is 2, [database].[schema].[name] is 3 (also
# database..name), [server].[database].[schema].[name] is 4. Dots inside [brackets] or "quotes" are
# part of a name; ]] and "" are an escaped bracket and quote. A synonym's base object with 3 or
# more parts is in another database or on another server.
function Get-NamePartCount([string]$Name) {
    $parts = 1
    $i = 0
    while ($i -lt $Name.Length) {
        $ch = $Name[$i]
        if ($ch -eq '[' -or $ch -eq '"') {
            if ($ch -eq '[') { $close = [char]']' } else { $close = [char]'"' }
            $i++
            while ($i -lt $Name.Length) {
                if ($Name[$i] -eq $close) {
                    if ($i + 1 -lt $Name.Length -and $Name[$i + 1] -eq $close) { $i++ } else { break }
                }
                $i++
            }
        }
        elseif ($ch -eq '.') { $parts++ }
        $i++
    }
    return $parts
}

# The lines of the CREATE TYPE statement for a user-defined type of the source. A table type is
# written with what the engine reads of it: columns (IDENTITY, defaults, computed columns), its
# primary key and unique constraints (with IGNORE_DUP_KEY), its checks. A column's collation is
# written as a table column's is: when it is not the target database's, and not with
# -IgnoreCollation. A snapshot taken before 2026-11-11 has only the names, types and nullability
# of the columns: that is what is written then, with a note saying so.
function Get-CreateTypeSql($Item, [string]$TargetCollation = '') {
    $name = Get-QuotedPair (Get-SqlPart $Item 'Schema') (Get-SqlPart $Item 'Name')
    if ($Item.Props['Kind'] -ne 'table type') { return @('CREATE TYPE {0} FROM {1};' -f $name, $Item.Props['Spec']) }

    $notReadable = '-- ' + (Get-CommentText "Not scripted: table type $name has a default, a computed column or a check that is not readable.")
    $notes = @('-- Table type: indexes that are not constraints and MEMORY_OPTIMIZED are not read. Add them here if the source has them.')
    if (-not $Item.Props.Contains('Details')) {
        $notes += '-- This snapshot was saved before the engine read more of a table type than its columns: IDENTITY, defaults, computed columns, keys and checks are NOT in the statement below. Compare it with the source and add them.'
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($c in @(Get-SqlPart $Item 'Columns')) {
        if ($null -eq $c) { continue }
        $column = Get-QuotedName ([string]$c['Name'])
        $computed = [string]$c['Computed']
        $default = [string]$c['Default']
        if ($computed -eq $HiddenValue -or $default -eq $HiddenValue) { return @($notReadable) }
        if ($computed) {
            $text = '{0} AS {1}' -f $column, $computed
            if ([string]$c['Persisted'] -eq 'PERSISTED') {
                $text += ' PERSISTED'
                if ([string]$c['Nullable'] -eq 'NOT NULL') { $text += ' NOT NULL' }
            }
        }
        else {
            $text = '{0} {1}' -f $column, (Format-ColumnType ([string]$c['Type']))
            $collation = [string]$c['Collation']
            if (-not $IgnoreCollation -and $collation -and $collation -ne $TargetCollation -and -not (Test-UserDefinedType ([string]$c['Type']))) { $text += ' COLLATE ' + $collation }
            if ([string]$c['Identity']) { $text += ' ' + [string]$c['Identity'] }
            $text += ' ' + [string]$c['Nullable']
            if ($default) { $text += ' DEFAULT ' + $default }
        }
        $lines.Add('    ' + $text)
    }
    foreach ($k in @(Get-SqlPart $Item 'KeyConstraints')) {
        if ($null -eq $k) { continue }
        $columns = foreach ($part in @($k['Columns'])) {
            if ($null -eq $part) { continue }
            if ($part['Desc']) { (Get-QuotedName ([string]$part['Name'])) + ' DESC' } else { Get-QuotedName ([string]$part['Name']) }
        }
        $text = '    {0} {1} ({2})' -f $k['Kind'], $k['Type'], (@($columns) -join ', ')
        if ($k['IgnoreDupKey']) { $text += ' WITH (IGNORE_DUP_KEY = ON)' }
        $lines.Add($text)
    }
    foreach ($expression in @(Get-SqlPart $Item 'Checks')) {
        if (-not $expression) { continue }
        if ([string]$expression -eq $HiddenValue) { return @($notReadable) }
        $lines.Add('    CHECK ' + [string]$expression)
    }
    return @($notes) + @(
        "CREATE TYPE $name AS TABLE ("
        ($lines -join ",`r`n")
        ');'
    )
}

function Get-CreateSequenceSql($Item) {
    $p = $Item.Props
    $cache = ([string]$p['Cache']).Replace(' (default)', '')
    $name = Get-QuotedPair (Get-SqlPart $Item 'Schema') (Get-SqlPart $Item 'Name')
    return 'CREATE SEQUENCE {0} AS {1} START WITH {2} INCREMENT BY {3} MINVALUE {4} MAXVALUE {5} {6} {7};' -f $name, $p['DataType'], $p['Start'], $p['Increment'], $p['Min'], $p['Max'], $p['Cycle'], $cache
}

# A sequence named in a default, as SQL Server stores it: (NEXT VALUE FOR [schema].[name]), or
# [name] alone when it was written without a schema. A name of three parts (another database) does
# not match. Precompiled: it runs on the default of every new and changed column.
$SequenceInDefault = New-Object System.Text.RegularExpressions.Regex('NEXT\s+VALUE\s+FOR\s+(?:(?<schema>(?>\[(?:[^\]]|\]\])+\]))\s*\.\s*)?(?<name>(?>\[(?:[^\]]|\]\])+\]))(?!\s*\.)', 'IgnoreCase')

# The SET statements for a module that has other options than the script's own (ANSI_NULLS ON,
# QUOTED_IDENTIFIER ON, set once at the top): its SetOptions property names the ones that are OFF.
# They go in a batch of their own before the module's, since CREATE must start its batch.
function Get-ModuleSetLines([string]$SetOptions) {
    $lines = @()
    if ($SetOptions -match 'ANSI_NULLS OFF') { $lines += 'SET ANSI_NULLS OFF;' }
    if ($SetOptions -match 'QUOTED_IDENTIFIER OFF') { $lines += 'SET QUOTED_IDENTIFIER OFF;' }
    return $lines
}

$DropKeywords = @{ 'P' = 'PROCEDURE'; 'PC' = 'PROCEDURE'; 'V' = 'VIEW'; 'FN' = 'FUNCTION'; 'IF' = 'FUNCTION'; 'TF' = 'FUNCTION'; 'FS' = 'FUNCTION'; 'FT' = 'FUNCTION'; 'TR' = 'TRIGGER' }

# The comment above the SET NOEXEC OFF that ends every script. app/lib/runs.js (SCRIPT_TRAILER)
# matches this text: change both together.
$ScriptTrailerComment = '-- End of script: ends the NOEXEC that a failed database check at the top turned on.'

function Get-DropDefaultSql([string]$Table, [string]$Column) {
    # EXEC (...) takes only literals and variables, not QUOTENAME(), so the statement goes into a variable.
    return @(
        'DECLARE @default sysname, @drop nvarchar(max);'
        ('SELECT @default = dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID({0}) AND c.name = {1};' -f (Get-SqlLiteral $Table), (Get-SqlLiteral $Column))
        ('IF @default IS NOT NULL BEGIN SET @drop = N''ALTER TABLE {0} DROP CONSTRAINT '' + QUOTENAME(@default); EXEC (@drop); END' -f $Table.Replace("'", "''"))
    )
}

function Write-SyncScript {
    param(
        [string]$Path,
        $SourceSnap,
        $TargetSnap,
        $Diffs,
        [string]$SourceLabel,
        [string]$TargetLabel,
        [string]$TargetDatabase,
        [string[]]$Warnings = @(),
        # Set by Write-RollbackScript: the snapshots and diffs come reversed, the labels do not.
        [switch]$Rollback,
        # The login that read the target (the database the script runs on, also in a rollback) has
        # no VIEW DEFINITION permission: an object "only in source" may be there, just not visible.
        [switch]$TargetIncomplete
    )

    $out = New-Object System.Collections.Generic.List[string]
    $add = { param($lines) foreach ($line in @($lines)) { $out.Add([string]$line) } }
    # Every comment that carries names or values from the databases goes through here: a line break
    # inside a name would otherwise end the comment and turn the rest into live SQL.
    $note = { param($text) $out.Add('-- ' + (Get-CommentText $text)) }
    $section = { param($title) $out.Add(''); $out.Add('-- ' + ('=' * 90)); $out.Add("-- $title"); $out.Add('-- ' + ('=' * 90)) }
    $go = { $out.Add('GO') }

    $byCategory = @{}
    foreach ($d in $Diffs) {
        if (-not $byCategory.ContainsKey($d.Category)) { $byCategory[$d.Category] = New-Object System.Collections.Generic.List[object] }
        $byCategory[$d.Category].Add($d)
    }
    $pick = { param($category, $status) @($byCategory[$category] | Where-Object { $null -ne $_ -and $_.Status -eq $status }) }
    $src = { param($d) $SourceSnap[$d.Category][$d.SourceKey] }
    $tgt = { param($d) $TargetSnap[$d.Category][$d.TargetKey] }

    $targetCollation = ''
    if ($TargetSnap['Database'].ContainsKey('(database)')) { $targetCollation = [string]$TargetSnap['Database']['(database)'].Props['Collation'] }

    # ---- header ----
    # Line comments rather than /* */: a label holding "*/" cannot end a line comment.
    if ($Rollback) {
        & $note "Rollback script generated by database-diff on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        & $note "Source (the sync script's model):  $SourceLabel"
        & $note "Target (will be changed back):     $TargetLabel"
        & $add @(
            '--'
            '-- Running this on the TARGET database after the sync script of the same comparison puts its'
            '-- schema back as it was read during the comparison. REVIEW IT BEFORE RUNNING.'
            '-- - Nothing in this file has been executed by database-diff.'
            '-- - It assumes the target changed only through the sync script since the comparison.'
            '-- - Procedures, views, functions, triggers, synonyms, indexes and constraints the sync script'
            '--   created are dropped first, with IF EXISTS so a sync script that stopped part way is fine.'
            '-- - Tables, columns, sequences, types and schemas it created are commented out at the end:'
            '--   dropping them loses the data written since.'
            '-- - Changed objects get their earlier definition back. ALTER COLUMN statements are active:'
            '--   check them for data loss (narrower types, NOT NULL).'
            '-- - Objects only in the target are not here: the sync script leaves them (its drops are'
            '--   commented out). Schemas, types and sequences it created only when missing are left in place.'
            '-- - Only a backup brings back dropped data.'
            '-- - Objects are ordered by kind, not by dependency; rerun a failed part after the rest.'
            '-- - Uses CREATE OR ALTER and DROP IF EXISTS: SQL Server 2016 SP1 or later on the target.'
            '-- - It starts with USE of the target database. If that fails (wrong server, no access), nothing'
            '--   after it is executed, so no statement runs in another database.'
            '-- - A changed index, constraint or default is dropped and created again in one transaction (a'
            '--   default also around the type change of its column), under the SET XACT_ABORT ON below'
            '--   (keep it when running only a part of this file): when a statement in it fails, the drop'
            '--   is rolled back and the existing one stays.'
        )
    }
    else {
        & $note "Sync script generated by database-diff on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        & $note "Source (the model):        $SourceLabel"
        & $note "Target (will be changed):  $TargetLabel"
        & $add @(
            '--'
            '-- Running this on the TARGET database changes its schema to match the SOURCE, as far as the'
            '-- comparison could see. REVIEW IT BEFORE RUNNING and back up the target first.'
            '-- - Nothing in this file has been executed by database-diff.'
            '-- - Statements that drop tables, columns or other objects are commented out at the end.'
            '-- - ALTER COLUMN statements are active: check them for data loss (narrower types, NOT NULL).'
            '-- - Objects are ordered by kind, not by dependency; rerun a failed part after the rest.'
            '-- - Uses CREATE OR ALTER, which needs SQL Server 2016 SP1 or later on the target.'
            '-- - It starts with USE of the target database. If that fails (wrong server, no access), nothing'
            '--   after it is executed, so no statement runs in another database.'
            '-- - A changed index, constraint or default is dropped and created again in one transaction (a'
            '--   default also around the type change of its column), under the SET XACT_ABORT ON below'
            '--   (keep it when running only a part of this file): when a statement in it fails, the drop'
            '--   is rolled back and the existing one stays.'
        )
    }
    if ($TargetIncomplete -and $Rollback) {
        & $add @(
            '-- - INCOMPLETE COMPARISON: the login that read the target has no VIEW DEFINITION permission, so'
            '--   an object the sync script was to create may have been there before (its CREATE then'
            '--   failed). The drops of procedures, views, functions, triggers and synonyms are therefore'
            '--   commented out at the end: uncomment only those the sync script really created.'
        )
    }
    elseif ($TargetIncomplete) {
        & $add @(
            '-- - INCOMPLETE COMPARISON: the login that read the target has no VIEW DEFINITION permission, so'
            '--   an object it cannot see reads as "only in source". Procedures, views, functions and'
            '--   triggers that are only in the source are therefore written as a plain CREATE, which fails'
            '--   (Msg 2714) when the object is there already instead of replacing it.'
            '-- - For the same reason two kinds of statement are commented out, each with what to check'
            '--   before running it: the indexes, checks and foreign keys of a table that is only in the'
            '--   source (when that table is there already its CREATE TABLE fails, and they would be added'
            '--   to the table that is there), and unnamed checks that are only in the source (the target''s'
            '--   unnamed checks cannot be read, so the same check may be there under a generated name).'
        )
    }
    foreach ($w in $Warnings) { & $add '--'; & $note "WARNING: $w" }
    & $add ('USE {0};' -f (Get-QuotedName $TargetDatabase)); & $go
    # A USE that fails ends only its own batch: every batch after it would run in the database the
    # session was in. NOEXEC stays on until the last batch of the script, so nothing in between is
    # executed. The web app's combined script (app/lib/runs.js) writes the same check per part.
    $databaseLiteral = Get-SqlLiteral $TargetDatabase
    & $add @(
        ('IF DB_ID({0}) IS NULL OR DB_ID() <> DB_ID({0})' -f $databaseLiteral)
        'BEGIN'
        ('    RAISERROR(N''database-diff: cannot use database %s. The rest of this file is not executed.'', 16, 1, {0});' -f $databaseLiteral)
        '    SET NOEXEC ON;'
        'END'
    ); & $go
    # XACT_ABORT is set once for the whole script: a SET inside a later batch would stay in effect
    # for the rest of the session anyway, only less visibly. No transaction spans a GO.
    & $add @('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;', 'SET XACT_ABORT ON;'); & $go

    $missingParts = { param($item) $null -eq $item -or $null -eq $item.Sql }
    $oldSnapshotNote = '-- Not scripted: this snapshot was saved by an older version without name details; rerun the comparison.'

    # ---- only in target: drops ----
    # A sync script lists every drop commented out at the end. In a rollback, "only in target" means
    # created by the sync script: the drops that lose no data run first, the rest stay commented out.
    # Modules and synonyms are kept apart from indexes and constraints: when the target was read
    # without VIEW DEFINITION, one of them may have been there before the sync script (hidden from
    # the comparison, so its plain CREATE failed), and a rollback must not drop it.
    $constraintDrops = New-Object System.Collections.Generic.List[string]
    $moduleDrops = New-Object System.Collections.Generic.List[string]
    $dataDrops = New-Object System.Collections.Generic.List[string]
    if ($Rollback) { $exists = 'IF EXISTS ' } else { $exists = '' }
    foreach ($category in @('Foreign key', 'Check constraint', 'Index')) {
        foreach ($d in (& $pick $category 'OnlyInTarget')) {
            $t = & $tgt $d
            if (& $missingParts $t) { continue }
            if ($Rollback -and (Get-SqlPart $t 'IsSystemNamed')) {
                # The sync script created it without a name, so SQL Server gave it a new one. Or,
                # for an unnamed check on a target read without VIEW DEFINITION, left it as a comment.
                if ($TargetIncomplete -and $category -eq 'Check constraint') {
                    $constraintDrops.Add('-- ' + (Get-CommentText "Not scripted: the sync script left $category $($d.Object) commented out (the comparison of the target is incomplete). If it was run by hand, it got a system-generated name: find it on the target and drop it manually."))
                }
                else {
                    $constraintDrops.Add('-- ' + (Get-CommentText "Not scripted: the sync script created $category $($d.Object) with a new system-generated name; find it on the target and drop it manually."))
                }
            }
            elseif ($category -eq 'Index') { $constraintDrops.Add((Get-DropIndexSql $t -IfExists:$Rollback)) }
            else { $constraintDrops.Add((Get-DropConstraintSql $t -IfExists:$Rollback)) }
        }
    }
    foreach ($category in @('Trigger', 'Stored procedure', 'View', 'Function')) {
        foreach ($d in (& $pick $category 'OnlyInTarget')) {
            $t = & $tgt $d
            if (& $missingParts $t) { continue }
            $moduleDrops.Add(('DROP {0} {1}{2};' -f $DropKeywords[[string](Get-SqlPart $t 'ObjectType')], $exists, (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name'))))
        }
    }
    foreach ($d in (& $pick 'Synonym' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $moduleDrops.Add(('DROP SYNONYM {0}{1};' -f $exists, (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Column' 'OnlyInTarget')) {
        $t = & $tgt $d
        if (& $missingParts $t) { continue }
        if ($t.Props['Default']) { $dataDrops.Add('-- (drop the default constraint of the next column first)') }
        $dataDrops.Add(('ALTER TABLE {0} DROP COLUMN {1};' -f (Get-TableName $t), (Get-QuotedName (Get-SqlPart $t 'Name'))))
    }
    foreach ($d in (& $pick 'Table' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $dataDrops.Add(('DROP TABLE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Sequence' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $dataDrops.Add(('DROP SEQUENCE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'User-defined type' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $dataDrops.Add(('DROP TYPE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Schema' 'OnlyInTarget')) { $dataDrops.Add(('DROP SCHEMA {0};' -f (Get-QuotedName $d.TargetKey))) }

    $activeDrops = @($constraintDrops)
    if (-not $TargetIncomplete) { $activeDrops += @($moduleDrops) }
    if ($Rollback -and $activeDrops.Count) {
        & $section 'Created by the sync script: dropped'
        foreach ($line in $activeDrops) {
            & $add $line
            if (-not $line.StartsWith('--')) { & $go }
        }
    }

    # ---- types and sequences that new tables and columns need ----
    # A category that was not compared has no differences to script, so a new table or column of a
    # type the target lacks would fail (Msg 2715), and so would a default that takes its value
    # from a sequence the target lacks. Those of the source that the target snapshot does not
    # have are created, only when missing: the snapshots hold every category, compared or not.
    $neededTypes = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    $neededSequences = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    $wantTypes = $SelectedCategories -notcontains 'User-defined type'
    $wantSequences = $SelectedCategories -notcontains 'Sequence'
    if ($wantTypes -or $wantSequences) {
        $createdTables = @{}
        foreach ($d in (& $pick 'Table' 'OnlyInSource')) { $createdTables[$d.SourceKey] = $true }
        $usedColumns = New-Object System.Collections.Generic.List[object]
        foreach ($c in $SourceSnap['Column'].get_Values()) { if ($createdTables.ContainsKey($c.Parent)) { $usedColumns.Add($c) } }
        foreach ($d in (@(& $pick 'Column' 'OnlyInSource') + @(& $pick 'Column' 'Different'))) { $usedColumns.Add((& $src $d)) }
        foreach ($c in $usedColumns) {
            if ($null -eq $c) { continue }
            $type = [string]$c.Props['Type']
            if ($wantTypes -and (Test-UserDefinedType $type) -and $SourceSnap['User-defined type'].ContainsKey($type) -and -not $TargetSnap['User-defined type'].ContainsKey($type)) {
                $neededTypes[$type] = $SourceSnap['User-defined type'][$type]
            }
            if (-not $wantSequences) { continue }
            foreach ($m in $SequenceInDefault.Matches([string]$c.Props['Default'])) {
                # A name written without a schema is looked for in dbo.
                if ($m.Groups['schema'].Success) { $schema = Get-UnquotedName $m.Groups['schema'].Value } else { $schema = 'dbo' }
                $key = '{0}.{1}' -f $schema, (Get-UnquotedName $m.Groups['name'].Value)
                if ($SourceSnap['Sequence'].ContainsKey($key) -and -not $TargetSnap['Sequence'].ContainsKey($key)) { $neededSequences[$key] = $SourceSnap['Sequence'][$key] }
            }
        }
    }

    # ---- schemas ----
    $items = @(& $pick 'Schema' 'OnlyInSource')
    if ($items.Count) {
        & $section 'Schemas'
        foreach ($d in $items) { & $add ('CREATE SCHEMA {0};' -f (Get-QuotedName $d.SourceKey)); & $go }
    }
    elseif ($SelectedCategories -notcontains 'Schema') {
        # Schemas were not compared: create the ones that new objects need, only when missing.
        $needed = New-Object 'System.Collections.Generic.SortedSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($d in @($Diffs | Where-Object { $_.Status -eq 'OnlyInSource' })) {
            $schema = [string](Get-SqlPart (& $src $d) 'Schema')
            if ($schema -and $schema -ne 'dbo') { [void]$needed.Add($schema) }
        }
        # The types and sequences found above are new objects too, without a difference record.
        foreach ($item in (@($neededTypes.get_Values()) + @($neededSequences.get_Values()))) {
            $schema = [string](Get-SqlPart $item 'Schema')
            if ($schema -and $schema -ne 'dbo') { [void]$needed.Add($schema) }
        }
        if ($needed.Count) {
            & $section 'Schemas used by new objects (created only when missing)'
            foreach ($schema in $needed) {
                & $add ('IF SCHEMA_ID({0}) IS NULL EXEC (N''CREATE SCHEMA {1}'');' -f (Get-SqlLiteral $schema), (Get-QuotedName $schema).Replace("'", "''"))
                & $go
            }
        }
    }

    # ---- user-defined types ----
    $new = @(& $pick 'User-defined type' 'OnlyInSource')
    $changed = @(& $pick 'User-defined type' 'Different')
    if ($new.Count -or $changed.Count) {
        & $section 'User-defined types'
        foreach ($d in $new) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            & $add (Get-CreateTypeSql $s $targetCollation)
            & $go
        }
        foreach ($d in $changed) {
            & $note "Type $($d.Object) differs: $($d.Detail)"
            & $add '-- A type cannot be altered: drop the objects that use it, DROP TYPE, CREATE TYPE, then recreate them.'
        }
    }
    if ($neededTypes.Count) {
        & $section 'User-defined types used by new tables and columns (created only when missing)'
        foreach ($key in $neededTypes.get_Keys()) {
            $s = $neededTypes[$key]
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            # CREATE TYPE may follow IF in the same batch (CREATE SCHEMA may not, hence its EXEC).
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            & $add ('IF TYPE_ID({0}) IS NULL {1}' -f (Get-SqlLiteral $name), (@(Get-CreateTypeSql $s $targetCollation) -join ' '))
            & $go
        }
    }

    # ---- sequences ----
    $new = @(& $pick 'Sequence' 'OnlyInSource')
    $changed = @(& $pick 'Sequence' 'Different')
    if ($new.Count -or $changed.Count) {
        & $section 'Sequences'
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            if ($d.Status -eq 'OnlyInSource') { & $add (Get-CreateSequenceSql $s) }
            else {
                $p = $s.Props
                $cache = ([string]$p['Cache']).Replace(' (default)', '')
                $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
                & $add ('ALTER SEQUENCE {0} INCREMENT BY {1} MINVALUE {2} MAXVALUE {3} {4} {5};  -- data type and start value are not changed' -f $name, $p['Increment'], $p['Min'], $p['Max'], $p['Cycle'], $cache)
            }
            & $go
        }
    }
    if ($neededSequences.Count) {
        & $section 'Sequences used by the defaults of new tables and columns (created only when missing)'
        foreach ($key in $neededSequences.get_Keys()) {
            $s = $neededSequences[$key]
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            & $add ('IF OBJECT_ID({0}, N''SO'') IS NULL {1}' -f (Get-SqlLiteral $name), (Get-CreateSequenceSql $s))
            & $go
        }
    }

    # ---- new tables (with primary key) ----
    $newTables = @(& $pick 'Table' 'OnlyInSource')
    $newTableKeys = @{}
    if ($newTables.Count) {
        & $section 'New tables'
        $skipped = @(@('Index', 'Check constraint', 'Foreign key') | Where-Object { $SelectedCategories -notcontains $_ })
        if ($skipped.Count) {
            & $add ('-- Categories not compared, so not created with these tables (the primary key is): {0}.' -f ($skipped -join ', '))
        }
        foreach ($d in $newTables) {
            $s = & $src $d
            $newTableKeys[$d.SourceKey] = $true
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $table = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            $columns = @($SourceSnap['Column'].get_Values() | Where-Object { $_.Parent -eq $d.SourceKey } | Sort-Object { [int]$_.Props['Ordinal'] })
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($c in $columns) {
                $definition = Get-ColumnDefinition $c $targetCollation
                if ($definition) { $lines.Add("    $definition") }
                else { $lines.Add('    -- ' + (Get-CommentText "computed column $(Get-SqlPart $c 'Name') is not readable")) }
            }
            $pk = @($SourceSnap['Index'].get_Values() | Where-Object { $_.Parent -eq $d.SourceKey -and $_.Props['Kind'] -eq 'PRIMARY KEY' }) | Select-Object -First 1
            if ($pk) { $lines.Add(('    {0}PRIMARY KEY {1} ({2})' -f (Get-ConstraintPrefix $pk), $pk.Props['Type'], (Get-IndexKeyList $pk))) }
            # Commas go after every real column line except the last one.
            $realLines = @($lines | Where-Object { $_ -notmatch '^\s*--' })
            $lastReal = $realLines[-1]
            $body = foreach ($line in $lines) { if ($line -match '^\s*--' -or $line -eq $lastReal) { $line } else { $line + ',' } }
            & $add @("CREATE TABLE $table (") ; & $add @($body); & $add ');'; & $go
        }
    }

    # ---- columns ----
    $new = @(& $pick 'Column' 'OnlyInSource')
    $changed = @(& $pick 'Column' 'Different')
    if ($new.Count -or $changed.Count) {
        & $section 'Columns'
        foreach ($d in $new) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $definition = Get-ColumnDefinition $s $targetCollation
            if (-not $definition) { & $note "Not scripted: computed column $($d.Object) is not readable"; continue }
            if ($s.Props['Nullable'] -eq 'NOT NULL' -and -not $s.Props['Default'] -and -not $s.Props['Identity'] -and -not $s.Props['Computed']) {
                & $add '-- WARNING: NOT NULL without a default fails when the table already has rows.'
            }
            & $add ('ALTER TABLE {0} ADD {1};' -f (Get-TableName $s), $definition); & $go
        }
        foreach ($d in $changed) {
            $s = & $src $d
            $t = & $tgt $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $table = Get-TableName $s
            $column = [string](Get-SqlPart $s 'Name')
            $diff = @{}
            foreach ($prop in (Get-ComparedProps $s)) {
                if (-not $t.Props.Contains($prop)) { continue }
                $a = [string]$s.Props[$prop]
                $b = [string]$t.Props[$prop]
                if ($a -eq $HiddenValue -or $b -eq $HiddenValue) { continue }
                if (-not (Test-SameText (Get-ComparableText $a) (Get-ComparableText $b))) { $diff[$prop] = $true }
            }
            & $note "$($d.Object): $($d.Detail)"
            # The ALTER COLUMN statement, when one is written: it may have to stand between the
            # drop of the column's default and the statement that adds the default again.
            $alterSql = $null
            if ($diff['Identity'] -or $diff['Computed']) {
                & $add '-- IDENTITY or computed definition differs: SQL Server cannot ALTER this; rebuild the column or table manually.'
            }
            elseif ($s.Props['Computed']) {
                # ALTER COLUMN changes nothing of a computed column (Msg 4928) but PERSISTED.
                if ($diff['Persisted']) {
                    if ($s.Props['Persisted'] -eq 'PERSISTED') { $change = 'ADD' } else { $change = 'DROP' }
                    & $add ('ALTER TABLE {0} ALTER COLUMN {1} {2} PERSISTED;' -f $table, (Get-QuotedName $column), $change)
                }
                if ($diff['Type'] -or $diff['Nullable'] -or $diff['Collation']) {
                    & $add '-- Not scripted: SQL Server cannot ALTER the type, collation or NULL / NOT NULL of a computed column; they follow from its definition and the columns it uses.'
                    $definition = Get-ColumnDefinition $s $targetCollation
                    if ($diff['Nullable'] -and $s.Props['Persisted'] -eq 'PERSISTED' -and $definition) {
                        & $add '-- NOT NULL is part of how a persisted computed column is declared: to change it, drop the column and add it again (indexes and constraints that use it first):'
                        & $note ('ALTER TABLE {0} DROP COLUMN {1};' -f $table, (Get-QuotedName $column))
                        & $note ('ALTER TABLE {0} ADD {1};' -f $table, $definition)
                    }
                }
            }
            elseif ($diff['Type'] -or $diff['Nullable'] -or $diff['Collation']) {
                $userType = Test-UserDefinedType $s.Props['Type']
                if ($userType -and $diff['Collation']) {
                    & $add '-- Not scripted: the collation differs, and COLLATE cannot be used on a column of a user-defined type (Msg 452); such a column has the collation of its database.'
                }
                if ($diff['Type'] -or $diff['Nullable'] -or -not $userType) {
                    $parts = @((Get-QuotedName $column), (Format-ColumnType $s.Props['Type']))
                    # ALTER COLUMN without COLLATE resets the column to the database default, so with
                    # -IgnoreCollation the target keeps the collation it already has. A rollback always
                    # puts back the target's own collation, which is the source side here.
                    if ($IgnoreCollation -and -not $Rollback) { $collation = [string]$t.Props['Collation'] } else { $collation = [string]$s.Props['Collation'] }
                    if ($s.Props['Collation'] -and $collation -and -not $userType) { $parts += 'COLLATE ' + $collation }
                    $parts += $s.Props['Nullable']
                    & $add '-- Fails if an index, constraint or schema-bound object uses this column; check for data loss.'
                    $alterSql = 'ALTER TABLE {0} ALTER COLUMN {1};' -f $table, ($parts -join ' ')
                }
            }
            # A default is dropped when it differs, and when the column gets another type: SQL
            # Server refuses to change the data type of a column that has a default (Msg 5074),
            # also when the default itself stays the same. (Length, precision, scale, NULL / NOT
            # NULL and collation can change with the default in place.)
            $sourceDefault = [string]$s.Props['Default']
            $targetDefault = [string]$t.Props['Default']
            if ($diff['Default'] -or ($alterSql -and $diff['Type'] -and $targetDefault)) {
                $dropLines = @(Get-DropDefaultSql $table $column)
                # What follows the drop: the ALTER COLUMN and the default of the source.
                $afterDrop = @()
                if ($alterSql) { $afterDrop += $alterSql }
                if ($sourceDefault -and $sourceDefault -ne $HiddenValue) {
                    $afterDrop += 'ALTER TABLE {0} ADD {1}DEFAULT {2} FOR {3};' -f $table, (Get-DefaultConstraintPrefix $s), $sourceDefault, (Get-QuotedName $column)
                }
                if ($sourceDefault -eq $HiddenValue) {
                    # Dropping a default that cannot be put back is not for a script to do.
                    if ($Rollback) { $which = 'the default the column had before the sync script' } else { $which = 'the default the column has in the source' }
                    & $add "-- Not scripted: the type change needs the default of the column dropped first, and $which is not readable, so it cannot be added again. By hand: run these, then add the default:"
                    foreach ($line in ($dropLines + $afterDrop)) { & $note $line }
                }
                elseif ($targetDefault -eq $HiddenValue) {
                    # Nor is dropping a default nobody could read: what goes is not known, and
                    # the other script (which has it as the default to put back) cannot restore it.
                    & $add '-- Not scripted: the type change needs the default of the column dropped first, and the default the column has now is not readable, so what would be dropped is not known and could not be put back. By hand: look at that default, then run these:'
                    foreach ($line in ($dropLines + $afterDrop)) { & $note $line }
                }
                else {
                    # More than the drop itself: one transaction, under the script's SET XACT_ABORT
                    # ON. When the ALTER COLUMN or the new default fails (rows that do not fit, a
                    # function that is not there), the drop is rolled back and the default stays.
                    if ($afterDrop.Count) { & $add 'BEGIN TRANSACTION;'; & $add $dropLines; & $add $afterDrop; & $add 'COMMIT TRANSACTION;' }
                    else { & $add $dropLines }
                }
            }
            elseif ($alterSql) { & $add $alterSql }
            if ($diff['Ordinal']) {
                & $add '-- Column order differs: SQL Server cannot move a column without rebuilding the table, so this is not scripted.'
            }
            & $go
        }
    }

    # ---- indexes, check constraints, foreign keys ----
    $childSections = @(
        @{ Category = 'Index'; Title = 'Indexes, primary keys and unique constraints' },
        @{ Category = 'Check constraint'; Title = 'Check constraints' },
        @{ Category = 'Foreign key'; Title = 'Foreign keys' }
    )
    foreach ($cs in $childSections) {
        $category = $cs.Category
        if ($SelectedCategories -notcontains $category) { continue }
        # Objects of new tables are not in the diff list (only the table is), so take them from the source.
        $ofNewTables = @($SourceSnap[$category].get_Values() | Where-Object { $newTableKeys.ContainsKey($_.Parent) -and -not ($category -eq 'Index' -and $_.Props['Kind'] -eq 'PRIMARY KEY') })
        $new = @(& $pick $category 'OnlyInSource')
        $changed = @(& $pick $category 'Different')
        if (-not ($ofNewTables.Count -or $new.Count -or $changed.Count)) { continue }
        & $section $cs.Title

        $create = {
            param($item)
            if (& $missingParts $item) { return $oldSnapshotNote }
            switch ($category) {
                'Index' { Get-CreateIndexSql $item }
                'Check constraint' { Get-AddCheckSql $item }
                'Foreign key' { Get-AddForeignKeySql $item }
            }
        }
        $drop = {
            param($item)
            if ($category -eq 'Index') { Get-DropIndexSql $item } else { Get-DropConstraintSql $item }
        }

        # On a target read without VIEW DEFINITION, "only in source" may be something that is there
        # but hidden. A statement that would then land on an object this script did not create,
        # or add a second copy, is written as a comment that says what to check first. (Not in a
        # rollback: it has no new tables, and its unnamed checks are comments already.)
        $guarded = [bool]$TargetIncomplete -and -not $Rollback
        $commentedWith = {
            param($condition, $lines)
            foreach ($line in @($lines)) {
                if ([string]$line -match '^\s*--') { & $add $line } else { & $note "Run this only if ${condition}: $line" }
            }
        }
        foreach ($item in $ofNewTables) {
            if ($guarded) {
                # The table's CREATE TABLE fails when a table of that name is there already, and
                # this would be added to that table.
                & $commentedWith "the CREATE TABLE of $($item.Parent) above succeeded" (& $create $item)
            }
            else { & $add (& $create $item); & $go }
        }
        foreach ($d in $new) {
            $s = & $src $d
            if ($guarded -and $category -eq 'Check constraint' -and (Get-SqlPart $s 'IsSystemNamed')) {
                # An unnamed check is paired by its expression, which this login cannot read on
                # the target: the same check may be there, and would be added again at every run.
                & $commentedWith "$($s.Parent) does not have this check yet (the target's unnamed checks could not be read)" (& $create $s)
            }
            else { & $add (& $create $s); & $go }
        }
        foreach ($d in $changed) {
            $s = & $src $d
            $t = & $tgt $d
            if ((& $missingParts $s) -or (& $missingParts $t)) { & $add $oldSnapshotNote; continue }
            & $note "$($d.Object): $($d.Detail)"
            if ($d.SourceKey -ne $d.TargetKey -and $d.Detail -like 'Name:*') {
                # Same definition, other name: rename instead of rebuilding.
                if ($category -eq 'Index' -and -not (Test-ConstraintIndex $s)) {
                    $old = '{0}.{1}' -f (Get-TableName $t), (Get-QuotedName (Get-SqlPart $t 'Name'))
                    & $add ('EXEC sp_rename {0}, {1}, N''INDEX'';' -f (Get-SqlLiteral $old), (Get-SqlLiteral (Get-SqlPart $s 'Name')))
                }
                else {
                    $old = Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')
                    & $add ('EXEC sp_rename {0}, {1}, N''OBJECT'';' -f (Get-SqlLiteral $old), (Get-SqlLiteral (Get-SqlPart $s 'Name')))
                }
            }
            elseif ($category -eq 'Index' -and $s.Props['Kind'] -eq 'PRIMARY KEY') {
                & $add '-- Primary key differs. Foreign keys that reference it must be dropped first, so this is left commented out:'
                & $note (& $drop $t)
                foreach ($line in @(& $create $s)) { & $note $line }
            }
            elseif ((@(Get-ChangedProps $s $t) -join ',') -eq 'State') {
                # Only enabled / disabled differs: the constraint is switched, not rebuilt, so rows
                # that break it cannot make it disappear. It is still the target's own constraint,
                # under the name it has there (a system-named one has another name in the source).
                # This comes before the rollback branch below: nothing was recreated, so that name
                # is still the one on the target.
                if ($Rollback) { $live = $s } else { $live = $t }
                if ($s.Props['State'] -eq 'DISABLED') { $action = 'NOCHECK' } else { $action = 'WITH CHECK CHECK' }
                & $add ('ALTER TABLE {0} {1} CONSTRAINT {2};' -f (Get-TableName $live), $action, (Get-QuotedName (Get-SqlPart $live 'Name')))
                if ($action -ne 'NOCHECK') {
                    # WITH CHECK validates the rows that are there. A constraint that was enabled
                    # without being trusted (rows that break it were there before, which is what a
                    # rollback may have to put back) can only be enabled the same way again.
                    & $add '-- Fails (Msg 547) when rows that are there break the constraint, which then stays disabled. To enable it without checking those rows (enabled, not trusted), run instead:'
                    & $note ('ALTER TABLE {0} CHECK CONSTRAINT {1};' -f (Get-TableName $live), (Get-QuotedName (Get-SqlPart $live 'Name')))
                }
            }
            elseif ($Rollback -and -not (Test-HasStatement @(& $create $t))) {
                # What the sync script would have created is not scriptable, so it left this alone.
                & $add '-- Nothing to roll back: the sync script could not script this change and kept the existing one.'
            }
            elseif ($Rollback -and (Get-SqlPart $t 'IsSystemNamed')) {
                & $add '-- The sync script created this with a new system-generated name, so it is left commented out: drop it manually, then run:'
                foreach ($line in @(& $create $s)) { & $note $line }
            }
            else {
                $createLines = @(& $create $s)
                if (-not (Test-HasStatement $createLines)) {
                    # Columnstore, XML or spatial index, or a filter that is not readable: dropping
                    # the existing one would leave nothing in its place.
                    if ($Rollback) { & $add '-- Not rolled back: the earlier one cannot be scripted, so the one the sync script created is kept. To put it back manually, run this drop, then create the earlier one:' }
                    else { & $add '-- Not changed: what replaces it cannot be scripted, so the existing one is kept. To change it manually, run this drop, then create the other one:' }
                    & $note (& $drop $t)
                    & $add $createLines
                }
                else {
                    # One batch, one transaction, under the script's SET XACT_ABORT ON: when the
                    # create fails (rows that break the constraint, duplicate keys), the drop is
                    # rolled back and the existing one stays.
                    & $add 'BEGIN TRANSACTION;'
                    & $add (& $drop $t)
                    & $add $createLines
                    & $add 'COMMIT TRANSACTION;'
                }
            }
            & $go
        }
    }

    # ---- programmable objects ----
    foreach ($category in @('Function', 'View', 'Stored procedure', 'Trigger')) {
        $new = @(& $pick $category 'OnlyInSource')
        $changed = @(& $pick $category 'Different')
        if (-not ($new.Count -or $changed.Count)) { continue }
        & $section "$category`s"
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if ($d.Status -eq 'OnlyInSource') { $what = 'only in source' } else { $what = $d.Detail }
            & $note "$($d.Object): $what"
            # The SET options are stored with the module, so a difference in them alone is also
            # made by running the definition again.
            $definitionChanged = $d.Status -eq 'OnlyInSource' -or $d.Detail -match '(^|\n)(Definition differs|SetOptions:)'
            $typeChanged = $d.Status -eq 'Different' -and $d.Detail -match '(^|\n)Type:'
            # "Only in source" on a target read without VIEW DEFINITION may be an object that is
            # there but hidden: CREATE OR ALTER would replace it without a word. (A rollback has no
            # such items: what the sync script created reads as only in target there.)
            $createOnly = [bool]$TargetIncomplete -and $d.Status -eq 'OnlyInSource'
            # The same trigger name on another table. The table a trigger names is not part of the
            # definition comparison (a renamed table keeps its earlier name in the text), so this
            # shows only as the Table property, and CREATE OR ALTER cannot move a trigger (Msg 2110).
            $tableChanged = $category -eq 'Trigger' -and $d.Status -eq 'Different' -and $d.Detail -match '(^|\n)Table:'
            # The definition cannot be read on one side (no VIEW DEFINITION, WITH ENCRYPTION), yet
            # something that can be read differs: the SET options, the type, a trigger's table.
            # Nothing is written then, not even as a comment to run by hand: the body that would
            # be replaced or dropped was never compared, and the other script could not put it
            # back (it cannot read it either).
            $unreadable = $d.Status -eq 'Different' -and $d.Detail -match '(^|\n)Definition: not readable'
            if (($typeChanged -or $tableChanged) -and $unreadable) {
                & $add '-- Not scripted: the object would have to be dropped and created again, but its definition is not readable on one side.'
            }
            elseif ($definitionChanged -and $unreadable) {
                & $add '-- Not scripted: SET options differ, but the definition is not readable on one side.'
            }
            elseif ($typeChanged -or $tableChanged) {
                # ALTER cannot turn, say, a scalar function into a table-valued one, nor put a
                # trigger on another table: the object has to be dropped and created again. That
                # is for a person to do, so both statements are written as comments, the CREATE
                # with the catalog names (the text in the report may carry earlier ones).
                $t = & $tgt $d
                if ($typeChanged) { & $add '-- The object type changed, which ALTER cannot do. To change it, drop the object and create it again by hand:' }
                else { & $add '-- The trigger is on another table on the two sides, and ALTER cannot move a trigger. To change it, drop the trigger and create it again by hand:' }
                if (-not (& $missingParts $t)) {
                    & $note ('DROP {0} {1};' -f $DropKeywords[[string](Get-SqlPart $t 'ObjectType')], (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))
                    & $add '-- GO'
                }
                $module = ConvertTo-ModuleScript $s $d.SourceKey $true
                if ($module.ContainsKey('Comment')) { & $add $module.Comment }
                else {
                    # Line by line: a definition has line breaks, and each line needs its own "--".
                    $commented = New-Object System.Collections.Generic.List[string]
                    $setLines = @(Get-ModuleSetLines ([string]$s.Props['SetOptions']))
                    if ($setLines.Count) { $commented.AddRange([string[]]$setLines); $commented.Add('GO') }
                    $commented.AddRange([string[]]($module.Script.TrimEnd() -split '\r\n|\r|\n'))
                    $commented.Add('GO')
                    if ($setLines.Count) { $commented.AddRange([string[]]@('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;', 'GO')) }
                    if ($category -eq 'Trigger' -and $s.Props['State'] -eq 'DISABLED' -and -not (& $missingParts $s)) {
                        $commented.Add(('DISABLE TRIGGER {0} ON {1};' -f (Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')), (Get-QuotedPair (Get-SqlPart $s 'ParentSchema') (Get-SqlPart $s 'ParentObject'))))
                    }
                    foreach ($line in $commented) { & $add ('-- ' + $line).TrimEnd() }
                }
            }
            elseif ($definitionChanged) {
                $module = ConvertTo-ModuleScript $s $d.SourceKey $createOnly
                if ($module.ContainsKey('Comment')) { & $add $module.Comment }
                else {
                    if ($createOnly) { & $add '-- Plain CREATE, because the comparison of the target is incomplete: if it fails with Msg 2714, the object is there already. Compare it with the source by hand.' }
                    # SQL Server stores the whole batch as the module definition, so the comments
                    # above must end in their own batch or they become part of the procedure text.
                    & $go
                    # A module keeps the ANSI_NULLS and QUOTED_IDENTIFIER of the session that
                    # created or altered it. One that has another setting than the script's gets
                    # it from a batch before its own, and the batch after it sets the script's
                    # again for the modules that follow.
                    $setLines = @(Get-ModuleSetLines ([string]$s.Props['SetOptions']))
                    if ($setLines.Count) {
                        if ($Rollback) { $where = 'had before the sync script' } else { $where = 'has in the source' }
                        & $add "-- Created under the SET options it $where; the batch after it sets the script's own again."
                        & $add $setLines
                        & $go
                    }
                    & $add $module.Script
                    & $go
                    if ($setLines.Count) { & $add @('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;'); & $go }
                }
            }
            # Not for a trigger that has to be dropped and created again by hand: it is not there yet,
            # or still on the other table.
            if ($category -eq 'Trigger' -and -not (& $missingParts $s) -and -not ($typeChanged -or $tableChanged)) {
                $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
                $parent = Get-QuotedPair (Get-SqlPart $s 'ParentSchema') (Get-SqlPart $s 'ParentObject')
                if ($createOnly) {
                    # The trigger may be one that was there already (its CREATE then failed), and
                    # whether that one is enabled is not this script's to change. A trigger this
                    # script creates is enabled by its CREATE.
                    if ($s.Props['State'] -eq 'DISABLED') { & $note "It is disabled in source. Run this only if the CREATE above succeeded: DISABLE TRIGGER $name ON $parent;" }
                }
                elseif ($s.Props['State'] -eq 'DISABLED') { & $add "DISABLE TRIGGER $name ON $parent;"; & $go }
                elseif ($d.Detail -match 'State:') { & $add "ENABLE TRIGGER $name ON $parent;"; & $go }
            }
        }
    }

    # ---- synonyms ----
    $new = @(& $pick 'Synonym' 'OnlyInSource')
    $changed = @(& $pick 'Synonym' 'Different')
    if ($new.Count -or $changed.Count) {
        & $section 'Synonyms (base objects often name environment-specific databases: check them)'
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            $lines = @()
            if ($d.Status -eq 'Different') { $lines += "DROP SYNONYM $name;" }
            $lines += 'CREATE SYNONYM {0} FOR {1};' -f $name, $s.Props['BaseObject']
            # A base object in another database or on another server: that name is what differs
            # between environments (dev / prod), so pointing the target's synonym at the source's
            # is rarely what is wanted. For a changed synonym either side counts, which keeps the
            # sync script and the rollback script each other's mirror.
            $external = (Get-NamePartCount ([string]$s.Props['BaseObject'])) -ge 3
            if ($d.Status -eq 'Different') {
                $t = & $tgt $d
                if ($null -ne $t -and (Get-NamePartCount ([string]$t.Props['BaseObject'])) -ge 3) { $external = $true }
            }
            if ($external) {
                & $note "Not run: $($d.Object) is a synonym for an object in another database or on another server ($($d.Detail)). Check that name for this environment, then run by hand:"
                foreach ($line in $lines) { & $note $line }
            }
            else { & $add $lines; & $go }
        }
    }

    # ---- database settings: comments only ----
    $items = @(& $pick 'Database' 'Different')
    if ($items.Count) {
        & $section 'Database settings (not changed by this script)'
        foreach ($d in $items) { foreach ($line in ($d.Detail -split "`n")) { & $note $line } }
    }

    # ---- not compared ----
    $items = @($Diffs | Where-Object { $_.Status -eq 'Unverified' })
    if ($items.Count) {
        & $section "Not compared ($($items.Count) items): a value is not readable on one side, so nothing is scripted for these"
        foreach ($d in $items) { & $note ('{0} {1}: {2}' -f $d.Category, $d.Object, $d.Detail) }
    }

    # ---- only in target: commented-out drops ----
    if ($Rollback) {
        $drops = @($dataDrops)
        if ($TargetIncomplete -and $moduleDrops.Count) {
            $drops = @('-- The comparison of the target is incomplete: one of the next objects may have been there before the sync script (its CREATE then failed with Msg 2714). Uncomment only those the sync script created:') + @($moduleDrops) + $drops
        }
        $title = 'Created by the sync script: NOT dropped. Uncomment a line only after checking nothing still needs it (data is lost)'
    }
    else {
        $drops = @($constraintDrops) + @($moduleDrops) + @($dataDrops)
        $title = 'Only in target: NOT dropped. Uncomment a line only after checking nothing still needs it (data is lost)'
    }
    if ($drops.Count) {
        & $section $title
        foreach ($line in $drops) { if ($line.StartsWith('--')) { & $add $line } else { & $note $line } }
    }

    if ($out.Count -gt 0 -and -not ($Diffs | Where-Object { $_.Status -ne 'Unverified' })) {
        if ($Rollback) { & $section 'Nothing to roll back' } else { & $section 'No differences to apply' }
    }

    # Must stay the last lines of the script: the web app's combined script (app/lib/runs.js)
    # recognises them and leaves them out of each part, so a failed check stops the whole file.
    & $add @('', $ScriptTrailerComment, 'SET NOEXEC OFF;'); & $go

    # SSMS reads UTF-8 without a BOM as the ANSI code page, which breaks Thai text in definitions.
    [System.IO.File]::WriteAllText($Path, ($out -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
}

# The rollback script undoes the sync script of the same comparison: it is the sync script of the
# reversed comparison (the target before the sync is the model), without the objects only in the
# target, which the sync script does not drop. Details keep the wording of the comparison.
function Write-RollbackScript {
    param(
        [string]$Path,
        $SourceSnap,
        $TargetSnap,
        $Diffs,
        [string]$SourceLabel,
        [string]$TargetLabel,
        [string]$TargetDatabase,
        [string[]]$Warnings = @(),
        # About the real target, as in Write-SyncScript: not reversed with the snapshots.
        [switch]$TargetIncomplete
    )

    $reversedStatus = @{ 'OnlyInSource' = 'OnlyInTarget'; 'Different' = 'Different'; 'Unverified' = 'Unverified' }
    $reversed = foreach ($d in $Diffs) {
        if ($d.Status -eq 'OnlyInTarget') { continue }
        [pscustomobject]@{
            Category         = $d.Category
            Object           = $d.Object
            Status           = $reversedStatus[$d.Status]
            Detail           = $d.Detail
            SourceDefinition = $d.TargetDefinition
            TargetDefinition = $d.SourceDefinition
            SourceKey        = $d.TargetKey
            TargetKey        = $d.SourceKey
        }
    }
    Write-SyncScript $Path $TargetSnap $SourceSnap @($reversed) $SourceLabel $TargetLabel $TargetDatabase $Warnings -Rollback -TargetIncomplete:$TargetIncomplete
}
