# Builds a T-SQL script that changes the TARGET database so its schema matches the SOURCE.
# The script is for review only: this tool never runs it, and statements that drop objects or
# columns are written commented out. Dot-sourced by Compare-Database.ps1.

function Get-QuotedName([string]$Name) { '[' + $Name.Replace(']', ']]') + ']' }

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

function Get-TableName($Item) { Get-QuotedPair (Get-SqlPart $Item 'Schema') (Get-SqlPart $Item 'Table') }

function Get-ColumnDefinition($Item, [string]$TargetCollation) {
    $p = $Item.Props
    $name = Get-QuotedName (Get-SqlPart $Item 'Name')
    if ($p['Computed']) {
        if ($p['Computed'] -eq $HiddenValue) { return $null }
        return '{0} AS {1}' -f $name, $p['Computed']
    }
    $parts = @($name, (Format-ColumnType $p['Type']))
    if (-not $IgnoreCollation -and $p['Collation'] -and $p['Collation'] -ne $TargetCollation) { $parts += 'COLLATE ' + $p['Collation'] }
    if ($p['Identity']) { $parts += $p['Identity'] }
    $parts += $p['Nullable']
    if ($p['Default'] -and $p['Default'] -ne $HiddenValue) { $parts += 'DEFAULT ' + $p['Default'] }
    return $parts -join ' '
}

function Get-ConstraintPrefix($Item) {
    if (Get-SqlPart $Item 'IsSystemNamed') { return '' }
    return 'CONSTRAINT ' + (Get-QuotedName (Get-SqlPart $Item 'Name')) + ' '
}

function Get-IndexKeyList($Item) {
    $keys = foreach ($k in @(Get-SqlPart $Item 'Keys')) {
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
    if ($type -notin @('CLUSTERED', 'NONCLUSTERED')) { return "-- Not scripted: $type index $name on $table (create it manually)" }
    if ($p['Filter'] -eq $HiddenValue) { return "-- Not scripted: the filter of index $name on $table is not readable" }
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

function Get-DropIndexSql($Item) {
    $table = Get-TableName $Item
    $name = Get-QuotedName (Get-SqlPart $Item 'Name')
    if (Test-ConstraintIndex $Item) { return 'ALTER TABLE {0} DROP CONSTRAINT {1};' -f $table, $name }
    return 'DROP INDEX {0} ON {1};' -f $name, $table
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
    if ($expression -eq $HiddenValue) { return @("-- Not scripted: check constraint $(Get-SqlPart $Item 'Name') on $(Get-TableName $Item) is not readable") }
    $sql = 'ALTER TABLE {0} WITH CHECK ADD {1}CHECK {2};' -f (Get-TableName $Item), (Get-ConstraintPrefix $Item), $expression
    return @($sql) + @(Get-DisableConstraintSql $Item)
}

function Get-DropConstraintSql($Item) {
    return 'ALTER TABLE {0} DROP CONSTRAINT {1};' -f (Get-TableName $Item), (Get-QuotedName (Get-SqlPart $Item 'Name'))
}

# Skips leading whitespace and comments, then turns the first CREATE into CREATE OR ALTER
# (SQL Server 2016 SP1 and later).
function ConvertTo-CreateOrAlter([string]$Definition) {
    $m = [regex]::Match($Definition, '\A(?:\s|--[^\n]*(?:\n|\z)|/\*[\s\S]*?\*/)*CREATE\b', 'IgnoreCase')
    if (-not $m.Success) { return $null }
    $rest = $Definition.Substring($m.Length)
    if ($rest -match '\A\s+OR\s+ALTER\b') { return $Definition }
    return $Definition.Substring(0, $m.Length) + ' OR ALTER' + $rest
}

$DropKeywords = @{ 'P' = 'PROCEDURE'; 'PC' = 'PROCEDURE'; 'V' = 'VIEW'; 'FN' = 'FUNCTION'; 'IF' = 'FUNCTION'; 'TF' = 'FUNCTION'; 'FS' = 'FUNCTION'; 'FT' = 'FUNCTION'; 'TR' = 'TRIGGER' }

function Get-DropDefaultSql([string]$Table, [string]$Column) {
    return @(
        'DECLARE @default sysname;'
        ('SELECT @default = dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID({0}) AND c.name = {1};' -f (Get-SqlLiteral $Table), (Get-SqlLiteral $Column))
        ('IF @default IS NOT NULL EXEC (N''ALTER TABLE {0} DROP CONSTRAINT '' + QUOTENAME(@default));' -f $Table.Replace("'", "''"))
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
        [string[]]$Warnings = @()
    )

    $out = New-Object System.Collections.Generic.List[string]
    $add = { param($lines) foreach ($line in @($lines)) { $out.Add([string]$line) } }
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
    & $add @(
        '/*'
        "  Sync script generated by database-diff on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        "  Source (the model):        $SourceLabel"
        "  Target (will be changed):  $TargetLabel"
        ''
        '  Running this on the TARGET database changes its schema to match the SOURCE, as far as the'
        '  comparison could see. REVIEW IT BEFORE RUNNING and back up the target first.'
        '  - Nothing in this file has been executed by database-diff.'
        '  - Statements that drop tables, columns or other objects are commented out at the end.'
        '  - ALTER COLUMN statements are active: check them for data loss (narrower types, NOT NULL).'
        '  - Objects are ordered by kind, not by dependency; rerun a failed part after the rest.'
        '  - Uses CREATE OR ALTER, which needs SQL Server 2016 SP1 or later on the target.'
    )
    foreach ($w in $Warnings) { & $add @('', "  WARNING: $w") }
    & $add @('*/', ('USE {0};' -f (Get-QuotedName $TargetDatabase))); & $go
    & $add @('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;'); & $go

    $missingParts = { param($item) $null -eq $item -or $null -eq $item.Sql }
    $oldSnapshotNote = '-- Not scripted: this snapshot was saved by an older version without name details; rerun the comparison.'

    # ---- schemas ----
    $items = & $pick 'Schema' 'OnlyInSource'
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
        if ($needed.Count) {
            & $section 'Schemas used by new objects (created only when missing)'
            foreach ($schema in $needed) {
                & $add ('IF SCHEMA_ID({0}) IS NULL EXEC (N''CREATE SCHEMA {1}'');' -f (Get-SqlLiteral $schema), (Get-QuotedName $schema).Replace("'", "''"))
                & $go
            }
        }
    }

    # ---- user-defined types ----
    $new = & $pick 'User-defined type' 'OnlyInSource'
    $changed = & $pick 'User-defined type' 'Different'
    if ($new.Count -or $changed.Count) {
        & $section 'User-defined types'
        foreach ($d in $new) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            if ($s.Props['Kind'] -eq 'table type') {
                $columns = foreach ($c in @(Get-SqlPart $s 'Columns')) { '    {0} {1} {2}' -f (Get-QuotedName ([string]$c['Name'])), (Format-ColumnType ([string]$c['Type'])), $c['Nullable'] }
                & $add @("CREATE TYPE $name AS TABLE (", (@($columns) -join (",`r`n")), ');')
            }
            else { & $add ('CREATE TYPE {0} FROM {1};' -f $name, $s.Props['Spec']) }
            & $go
        }
        foreach ($d in $changed) {
            & $add @("-- Type $($d.Object) differs: $($d.Detail -replace "`n", '; ')", '-- A type cannot be altered: drop the objects that use it, DROP TYPE, CREATE TYPE, then recreate them.')
        }
    }

    # ---- sequences ----
    $new = & $pick 'Sequence' 'OnlyInSource'
    $changed = & $pick 'Sequence' 'Different'
    if ($new.Count -or $changed.Count) {
        & $section 'Sequences'
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $p = $s.Props
            $cache = ([string]$p['Cache']).Replace(' (default)', '')
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            if ($d.Status -eq 'OnlyInSource') {
                & $add ('CREATE SEQUENCE {0} AS {1} START WITH {2} INCREMENT BY {3} MINVALUE {4} MAXVALUE {5} {6} {7};' -f $name, $p['DataType'], $p['Start'], $p['Increment'], $p['Min'], $p['Max'], $p['Cycle'], $cache)
            }
            else {
                & $add ('ALTER SEQUENCE {0} INCREMENT BY {1} MINVALUE {2} MAXVALUE {3} {4} {5};  -- data type and start value are not changed' -f $name, $p['Increment'], $p['Min'], $p['Max'], $p['Cycle'], $cache)
            }
            & $go
        }
    }

    # ---- new tables (with primary key) ----
    $newTables = & $pick 'Table' 'OnlyInSource'
    $newTableKeys = @{}
    if ($newTables.Count) {
        & $section 'New tables'
        foreach ($d in $newTables) {
            $s = & $src $d
            $newTableKeys[$d.SourceKey] = $true
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $table = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            $columns = @($SourceSnap['Column'].Values | Where-Object { $_.Parent -eq $d.SourceKey } | Sort-Object { [int]$_.Props['Ordinal'] })
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($c in $columns) {
                $definition = Get-ColumnDefinition $c $targetCollation
                if ($definition) { $lines.Add("    $definition") }
                else { $lines.Add("    -- computed column $(Get-SqlPart $c 'Name') is not readable") }
            }
            $pk = @($SourceSnap['Index'].Values | Where-Object { $_.Parent -eq $d.SourceKey -and $_.Props['Kind'] -eq 'PRIMARY KEY' }) | Select-Object -First 1
            if ($pk) { $lines.Add(('    {0}PRIMARY KEY {1} ({2})' -f (Get-ConstraintPrefix $pk), $pk.Props['Type'], (Get-IndexKeyList $pk))) }
            # Commas go after every real column line except the last one.
            $realLines = @($lines | Where-Object { $_ -notmatch '^\s*--' })
            $lastReal = $realLines[-1]
            $body = foreach ($line in $lines) { if ($line -match '^\s*--' -or $line -eq $lastReal) { $line } else { $line + ',' } }
            & $add @("CREATE TABLE $table (") ; & $add @($body); & $add ');'; & $go
        }
    }

    # ---- columns ----
    $new = & $pick 'Column' 'OnlyInSource'
    $changed = & $pick 'Column' 'Different'
    if ($new.Count -or $changed.Count) {
        & $section 'Columns'
        foreach ($d in $new) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $definition = Get-ColumnDefinition $s $targetCollation
            if (-not $definition) { & $add "-- Not scripted: computed column $($d.Object) is not readable"; continue }
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
                $a = [string]$s.Props[$prop]
                $b = [string]$t.Props[$prop]
                if ($a -eq $HiddenValue -or $b -eq $HiddenValue) { continue }
                if (-not (Test-SameText (Get-ComparableText $a) (Get-ComparableText $b))) { $diff[$prop] = $true }
            }
            & $add "-- $($d.Object): $($d.Detail -replace "`n", '; ')"
            if ($diff['Identity'] -or $diff['Computed']) {
                & $add '-- IDENTITY or computed definition differs: SQL Server cannot ALTER this; rebuild the column or table manually.'
            }
            elseif ($diff['Type'] -or $diff['Nullable'] -or $diff['Collation']) {
                $parts = @((Get-QuotedName $column), (Format-ColumnType $s.Props['Type']))
                if (-not $IgnoreCollation -and $s.Props['Collation']) { $parts += 'COLLATE ' + $s.Props['Collation'] }
                $parts += $s.Props['Nullable']
                & $add '-- Fails if an index, constraint or schema-bound object uses this column; check for data loss.'
                & $add ('ALTER TABLE {0} ALTER COLUMN {1};' -f $table, ($parts -join ' '))
            }
            if ($diff['Default']) {
                & $add (Get-DropDefaultSql $table $column)
                if ($s.Props['Default']) { & $add ('ALTER TABLE {0} ADD DEFAULT {1} FOR {2};' -f $table, $s.Props['Default'], (Get-QuotedName $column)) }
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
        $ofNewTables = @($SourceSnap[$category].Values | Where-Object { $newTableKeys.ContainsKey($_.Parent) -and -not ($category -eq 'Index' -and $_.Props['Kind'] -eq 'PRIMARY KEY') })
        $new = & $pick $category 'OnlyInSource'
        $changed = & $pick $category 'Different'
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

        foreach ($item in $ofNewTables) { & $add (& $create $item); & $go }
        foreach ($d in $new) { & $add (& $create (& $src $d)); & $go }
        foreach ($d in $changed) {
            $s = & $src $d
            $t = & $tgt $d
            if ((& $missingParts $s) -or (& $missingParts $t)) { & $add $oldSnapshotNote; continue }
            & $add "-- $($d.Object): $($d.Detail -replace "`n", '; ')"
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
                & $add ('-- ' + (& $drop $t))
                foreach ($line in @(& $create $s)) { & $add ('-- ' + $line) }
            }
            else {
                & $add (& $drop $t)
                & $add (& $create $s)
            }
            & $go
        }
    }

    # ---- programmable objects ----
    foreach ($category in @('Function', 'View', 'Stored procedure', 'Trigger')) {
        $new = & $pick $category 'OnlyInSource'
        $changed = & $pick $category 'Different'
        if (-not ($new.Count -or $changed.Count)) { continue }
        & $section "$category`s"
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if ($d.Status -eq 'OnlyInSource') { $what = 'only in source' } else { $what = $d.Detail -replace "`n", '; ' }
            & $add "-- $($d.Object): $what"
            if ($s.Definition -eq $HiddenDefinition) { & $add '-- Not scripted: the source definition is not readable.'; continue }
            $definitionChanged = $d.Status -eq 'OnlyInSource' -or $d.Detail -match '(^|\n)Definition differs'
            if ($definitionChanged) {
                $script = ConvertTo-CreateOrAlter $s.Definition
                if (-not $script) { & $add '-- Not scripted: the definition does not start with CREATE; copy it from the report.'; continue }
                # SQL Server stores the whole batch as the module definition, so the comments above
                # must end in their own batch or they become part of the procedure text.
                & $go
                & $add $script
                & $go
            }
            if ($category -eq 'Trigger' -and -not (& $missingParts $s)) {
                $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
                $parent = Get-QuotedPair (Get-SqlPart $s 'ParentSchema') (Get-SqlPart $s 'ParentObject')
                if ($s.Props['State'] -eq 'DISABLED') { & $add "DISABLE TRIGGER $name ON $parent;"; & $go }
                elseif ($d.Detail -match 'State:') { & $add "ENABLE TRIGGER $name ON $parent;"; & $go }
            }
        }
    }

    # ---- synonyms ----
    $new = & $pick 'Synonym' 'OnlyInSource'
    $changed = & $pick 'Synonym' 'Different'
    if ($new.Count -or $changed.Count) {
        & $section 'Synonyms (base objects often name environment-specific databases: check them)'
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; continue }
            $name = Get-QuotedPair (Get-SqlPart $s 'Schema') (Get-SqlPart $s 'Name')
            if ($d.Status -eq 'Different') { & $add "DROP SYNONYM $name;" }
            & $add ('CREATE SYNONYM {0} FOR {1};' -f $name, $s.Props['BaseObject']); & $go
        }
    }

    # ---- database settings: comments only ----
    $items = & $pick 'Database' 'Different'
    if ($items.Count) {
        & $section 'Database settings (not changed by this script)'
        foreach ($d in $items) { foreach ($line in ($d.Detail -split "`n")) { & $add "-- $line" } }
    }

    # ---- not compared ----
    $items = @($Diffs | Where-Object { $_.Status -eq 'Unverified' })
    if ($items.Count) {
        & $section "Not compared ($($items.Count) items): a value is not readable on one side, so nothing is scripted for these"
        foreach ($d in $items) { & $add ('-- {0} {1}: {2}' -f $d.Category, $d.Object, ($d.Detail -replace "`n", '; ')) }
    }

    # ---- only in target: commented-out drops ----
    $drops = New-Object System.Collections.Generic.List[string]
    foreach ($d in (& $pick 'Foreign key' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add((Get-DropConstraintSql $t)) } }
    foreach ($d in (& $pick 'Check constraint' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add((Get-DropConstraintSql $t)) } }
    foreach ($d in (& $pick 'Index' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add((Get-DropIndexSql $t)) } }
    foreach ($category in @('Trigger', 'Stored procedure', 'View', 'Function')) {
        foreach ($d in (& $pick $category 'OnlyInTarget')) {
            $t = & $tgt $d
            if (& $missingParts $t) { continue }
            $drops.Add(('DROP {0} {1};' -f $DropKeywords[[string](Get-SqlPart $t 'ObjectType')], (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name'))))
        }
    }
    foreach ($d in (& $pick 'Synonym' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add(('DROP SYNONYM {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Column' 'OnlyInTarget')) {
        $t = & $tgt $d
        if (& $missingParts $t) { continue }
        if ($t.Props['Default']) { $drops.Add('-- (drop the default constraint of the next column first)') }
        $drops.Add(('ALTER TABLE {0} DROP COLUMN {1};' -f (Get-TableName $t), (Get-QuotedName (Get-SqlPart $t 'Name'))))
    }
    foreach ($d in (& $pick 'Table' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add(('DROP TABLE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Sequence' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add(('DROP SEQUENCE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'User-defined type' 'OnlyInTarget')) { $t = & $tgt $d; if (-not (& $missingParts $t)) { $drops.Add(('DROP TYPE {0};' -f (Get-QuotedPair (Get-SqlPart $t 'Schema') (Get-SqlPart $t 'Name')))) } }
    foreach ($d in (& $pick 'Schema' 'OnlyInTarget')) { $drops.Add(('DROP SCHEMA {0};' -f (Get-QuotedName $d.TargetKey))) }
    if ($drops.Count) {
        & $section 'Only in target: NOT dropped. Uncomment a line only after checking nothing still needs it (data is lost)'
        foreach ($line in $drops) { if ($line.StartsWith('--')) { & $add $line } else { & $add ('-- ' + $line) } }
    }

    if ($out.Count -gt 0 -and -not ($Diffs | Where-Object { $_.Status -ne 'Unverified' })) {
        & $section 'No differences to apply'
    }

    # SSMS reads UTF-8 without a BOM as the ANSI code page, which breaks Thai text in definitions.
    [System.IO.File]::WriteAllText($Path, ($out -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
}
