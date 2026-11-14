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
    # The type is a user-defined one the login could not see (see $Sql.Columns): no definition.
    if ($p['Type'] -eq $HiddenValue) { return $null }
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

# Why Get-ColumnDefinition has no definition for a column: its computed definition, or the name of
# its type, is not readable.
function Get-UnreadableColumnText($Item, [string]$Name) {
    if ([string]$Item.Props['Computed']) { return "computed column $Name is not readable" }
    return "the type of column $Name is not readable (a user-defined type the login has no permission on)"
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
    $databaseScope = Test-DatabaseScope $Item
    if ($isTrigger -and -not $parent.Success -and -not $databaseScope) { return @{ Comment = '-- Not scripted: the table of the trigger could not be read from its definition; copy it from the report.' } }

    # What to write in place of each name token; $null keeps the token as it was written.
    $objectName = $null
    $parentName = $null
    if ($databaseScope) {
        # A database trigger. Its header must say ON DATABASE, the keyword: [DATABASE] or
        # "DATABASE" is a table of that name, and ON ALL SERVER another kind of trigger. The
        # keyword stays as it was written. The name has no schema (Msg 1094 when one is
        # written), and gets its catalog spelling when the header has another.
        $name = [string](Get-SqlPart $Item 'Name')
        if (-not $name) { return @{ Comment = '-- Not scripted: the name of the object is missing from this snapshot; rerun the comparison.' } }
        if (-not $isTrigger -or -not $parent.Success -or $m.Groups['pschema'].Success -or $m.Groups['pname'].Value -ine 'DATABASE') {
            return @{ Comment = '-- Not scripted: the definition of this database trigger does not read CREATE TRIGGER ... ON DATABASE; copy it from the report.' }
        }
        if ($m.Groups['schema'].Success -or (Get-UnquotedName $m.Groups['name'].Value) -cne $name) { $objectName = Get-QuotedName $name }
    }
    elseif ($null -ne $Item.Sql) {
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
    # decimal and numeric: the precision is part of the type, and the scale of a sequence is 0.
    # Without it the type is decimal(18,0), which the limits of a wider sequence do not fit (Msg
    # 11708). A snapshot taken before 2026-11-11 does not have it: the type is written as it was.
    $type = [string]$p['DataType']
    $precision = [string]$p['Precision']
    if ($precision) { $type = '{0}({1},0)' -f $type, $precision }
    return 'CREATE SEQUENCE {0} AS {1} START WITH {2} INCREMENT BY {3} MINVALUE {4} MAXVALUE {5} {6} {7};' -f $name, $type, $p['Start'], $p['Increment'], $p['Min'], $p['Max'], $p['Cycle'], $cache
}

# A sequence named in a default, as SQL Server stores it: (NEXT VALUE FOR [schema].[name]), or
# [name] alone when it was written without a schema. A name of three parts (another database) does
# not match. Precompiled: it runs on the default of every new and changed column.
$SequenceInDefault = New-Object System.Text.RegularExpressions.Regex('NEXT\s+VALUE\s+FOR\s+(?:(?<schema>(?>\[(?:[^\]]|\]\])+\]))\s*\.\s*)?(?<name>(?>\[(?:[^\]]|\]\])+\]))(?!\s*\.)', 'IgnoreCase')

# A column name inside the definition of a computed column, as SQL Server stores it: always in
# [brackets], whatever the column is called and however it was written, with a ] of the name
# doubled. Precompiled: it runs on the computed columns of the table of every column that gets an
# ALTER COLUMN.
$BracketedName = New-Object System.Text.RegularExpressions.Regex('\[((?:[^\]]|\]\])+)\]')

# The computed columns of a snapshot by table: table key -> list of @{ Key = column key; Item }.
# Table keys are matched ignoring case, as everywhere. Built once per script, so that looking
# for the computed columns of a table does not walk every column of the database each time. The
# columns of a table are listed in column order (a snapshot holds them in no order at all), so a
# script comes out the same at every run.
function Get-ComputedColumnsByTable($Snap) {
    $ordered = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([System.StringComparer]::Ordinal)
    foreach ($key in @($Snap['Column'].get_Keys())) {
        $item = $Snap['Column'][$key]
        if (-not [string]$item.Props['Computed']) { continue }
        $ordinal = 0
        [void][int]::TryParse([string]$item.Props['Ordinal'], [ref]$ordinal)
        $ordered[('{0:D10}{1}{2}' -f $ordinal, [char]31, $key)] = @{ Key = [string]$key; Item = $item }
    }
    $byTable = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $ordered.get_Values()) {
        $table = [string]$entry.Item.Parent
        if (-not $byTable.ContainsKey($table)) { $byTable[$table] = New-Object System.Collections.Generic.List[object] }
        $byTable[$table].Add($entry)
    }
    return $byTable
}

# The computed columns of a table that use a column: those whose definition names it, as entries
# of Get-ComputedColumnsByTable. A definition that is not readable (no VIEW DEFINITION) is not
# counted: what it uses cannot be known. A name in brackets that is something else than a column
# (a function, text in a string) counts too, which only makes the script more careful.
function Get-ComputedDependents($ByTable, [string]$TableKey, [string]$Column) {
    $entries = $ByTable[$TableKey]
    if ($null -eq $entries) { return }
    foreach ($entry in $entries) {
        $definition = [string]$entry.Item.Props['Computed']
        if ($definition -eq $HiddenValue) { continue }
        foreach ($m in $BracketedName.Matches($definition)) {
            if ([string]::Equals($m.Groups[1].Value.Replace(']]', ']'), $Column, [System.StringComparison]::OrdinalIgnoreCase)) { $entry; break }
        }
    }
}

# The indexes of the views of a snapshot by view: view key -> list of @{ Key = index key; Item }.
# The clustered index of a view comes first (its other indexes cannot exist without it), then
# the rest by key, so a script comes out the same at every run.
function Get-IndexesByView($Snap) {
    $ordered = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([System.StringComparer]::Ordinal)
    foreach ($key in @($Snap['Index'].get_Keys())) {
        $item = $Snap['Index'][$key]
        if (-not $Snap['View'].ContainsKey([string]$item.Parent)) { continue }
        if ([string]$item.Props['Type'] -eq 'CLUSTERED') { $rank = '0' } else { $rank = '1' }
        $ordered[$rank + [string]$key] = @{ Key = [string]$key; Item = $item }
    }
    $byView = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $ordered.get_Values()) {
        $view = [string]$entry.Item.Parent
        if (-not $byView.ContainsKey($view)) { $byView[$view] = New-Object System.Collections.Generic.List[object] }
        $byView[$view].Add($entry)
    }
    return $byView
}

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

# The name of a module as a statement writes it: [schema].[name], and [name] alone for a database
# trigger, which has no schema (Msg 1094 when one is written).
function Get-ModuleName($Item) {
    if (Test-DatabaseScope $Item) { return Get-QuotedName ([string](Get-SqlPart $Item 'Name')) }
    return Get-QuotedPair (Get-SqlPart $Item 'Schema') (Get-SqlPart $Item 'Name')
}

# What a trigger is on, as DISABLE TRIGGER ... ON and ENABLE TRIGGER ... ON write it: its table,
# or the keyword DATABASE.
function Get-TriggerTarget($Item) {
    if (Test-DatabaseScope $Item) { return 'DATABASE' }
    return Get-QuotedPair (Get-SqlPart $Item 'ParentSchema') (Get-SqlPart $Item 'ParentObject')
}

# DROP <kind> [IF EXISTS] <name>; with ON DATABASE for a database trigger: without it the
# statement looks for a table's trigger of that name.
function Get-DropModuleSql($Item, [switch]$IfExists) {
    if ($IfExists) { $exists = 'IF EXISTS ' } else { $exists = '' }
    $sql = 'DROP {0} {1}{2}' -f $DropKeywords[[string](Get-SqlPart $Item 'ObjectType')], $exists, (Get-ModuleName $Item)
    if (Test-DatabaseScope $Item) { $sql += ' ON DATABASE' }
    return $sql + ';'
}

# DISABLE TRIGGER or ENABLE TRIGGER ($Action) for a database trigger, only when the trigger is
# there: on one that is missing the statement fails with Msg 1088 (a script that stopped part
# way, or runs a second time, meets that). Neither statement is a DDL event, so no database
# trigger can refuse it, which CREATE, ALTER and DROP TRIGGER are.
function Get-DatabaseTriggerStateSql($Item, [string]$Action) {
    $name = [string](Get-SqlPart $Item 'Name')
    return 'IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {0}) {1} TRIGGER {2} ON DATABASE;' -f (Get-SqlLiteral $name), $Action, (Get-QuotedName $name)
}

# Database triggers on a target that was read without VIEW DEFINITION. Such a login sees no
# database trigger at all, so every one the source has reads as "only in source", also one that
# is there. What a script may do to a trigger then depends on something only the session that
# runs it can find out, and a script cannot carry a variable over a GO. So it keeps notes in a
# temporary table of that session, one row per trigger name:
# - the sync script notes, before each CREATE, the triggers that were not there
#   ($CreatedTriggersTable): only those are disabled after their CREATE and enabled at the end.
#   One that was there already (its CREATE fails with Msg 2714) is never touched.
# - the rollback script cannot know which ones the sync script created (it is written before the
#   sync script runs, and nothing on the target tells the two apart). It disables every one of
#   them that is enabled, because one the sync script created may refuse the statements of the
#   rollback, notes it ($DisabledTriggersTable), and enables exactly the noted ones again with
#   its last statements: whichever it was, it ends as it started.
# Why a temporary table: it lives across batches and is gone with the session; creating, filling
# and dropping one fires no DDL trigger; and under the NOEXEC of a failed database check the
# batches that name it still compile (nothing runs, so it is never created). All checked on SQL
# Server 2025 (LocalDB). The table is created only when missing and dropped by the last batch
# that uses it, so a second run in the same session after a run that stopped part way still
# has the notes of the first. (In another session it has not: a trigger the first run created
# and left disabled is then one that "was there already", and stays disabled. Both headers say
# so.) A row carries the database id: in a combined script, or in a session that ran the script
# of another database, a name noted for one database says nothing about another. The name is
# compared byte for byte (a binary collation): the same literal is written in every statement.
#
# When such a script stops part way (a person stops it, or it is run with stop-on-error, where
# the Msg 2714 it expects for a trigger that is there already ends it), the triggers it disabled
# stay disabled, and a run in another session cannot put that right: it finds them disabled, so
# they are not noted, and it enables only what is noted. Seen: a rollback cut before its last
# section and run again with sqlcmd ended without a message, with the target's own trigger
# (enabled before the sync script, never touched by it) disabled for good. That cannot be made
# to work without notes that outlive the session, so it is made loud instead:
# - as a script disables a trigger that it means to enable again, it prints the statement that
#   does so (PRINT, with the name quoted as the statement needs it), for a person to run when
#   the script does not get to its end;
# - at its end, for each trigger it would have enabled had it noted it, it prints a warning when
#   that trigger is disabled without a note. The script cannot know why it is: an earlier run
#   that stopped may have left it so, or it was disabled all along (the target's own trigger
#   that its owner turned off, or one the sync script created disabled). So the warning names
#   no cause, and it is the same for every trigger: it sends the reader to what the stopped run
#   printed, which is the list of what that run disabled. (It once said "that run disabled it"
#   of a trigger nothing had touched, and went by the state in the source, which says nothing
#   of a trigger that was in the target before.)
# Every such line names its database, twice: in front, and as USE in the statement to run. A
# combined script holds the scripts of many databases, whose triggers often have the same names,
# and a statement pasted into a new query window runs wherever that window is (Msg 1088 in
# master, or the trigger of that name in another database). The name is not written into the
# script: the line is put together when it runs, with DB_NAME(), so it is right whatever
# database the script is run in.
# PRINT is not executed under the NOEXEC of a failed database check, and is no error: it does
# not stop a run with stop-on-error, nor count as a failure.
$CreatedTriggersTable = '#database_diff_created'
$DisabledTriggersTable = '#database_diff_disabled'

# The messages, with {0} where the quoted name of the trigger goes. Each ends with "run:": the
# statement to run follows it (Get-TriggerPrintSql).
$TriggerDisabledMessage = 'database trigger {0} is disabled while this script runs; its last statements enable it again. If the script stops before them, run:'
$TriggerCreatedMessage = 'database trigger {0} is created, and disabled until the last statements of this script enable it. If the script stops before them: run it again to its end, then run:'
$TriggerNotCreatedWarning = 'WARNING: database trigger {0} is disabled, and this run did not create it: it was there before this run. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it created: only if this trigger is among them, run:'
$TriggerNotDisabledWarning = 'WARNING: database trigger {0} is disabled, and this run did not disable it. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it disabled: only if this trigger is among them, run:'

# What the first statements of a sync script say as they disable a trigger that is enabled: one
# that the last statements enable again, and one that the source has disabled, which stays so.
# And what is said of a new trigger as it is disabled after its CREATE, on a target read in full.
# A run that ends before the last statements (an error, under stop-on-error: on a second run the
# first "already there" message is one) leaves them disabled: it must not do so without a word.
# The statements these lines name, run as printed, put each trigger back as that run found it.
$TriggerHeldMessage = 'database trigger {0} is disabled until the last statements of this script enable it again. If the script stops before them: run it again to its end, or run:'
$TriggerOffMessage = 'database trigger {0} is disabled, as the source has it, and stays so. To have it enabled as it was, run:'
$TriggerNewHeldMessage = 'database trigger {0} is created, and disabled until the last statements of this script enable it. If the script stops before them: run it again to its end, or run:'

# PRINT of one of those messages for a trigger:
#   database-diff: [database]: <message> USE [database]; ENABLE TRIGGER [name] ON DATABASE;
# The database is the one the statement runs in (QUOTENAME(DB_NAME()), when it runs). The name of
# the trigger stands as a statement writes it ([a]]b]), and the text in literals (a quote
# doubled).
function Get-TriggerPrintSql($Item, [string]$Message) {
    $quoted = Get-QuotedName ([string](Get-SqlPart $Item 'Name'))
    $text = Get-SqlLiteral (': ' + ($Message -f $quoted) + ' USE ')
    $statement = Get-SqlLiteral ('; ENABLE TRIGGER ' + $quoted + ' ON DATABASE;')
    return 'PRINT N''database-diff: '' + QUOTENAME(DB_NAME()) + {0} + QUOTENAME(DB_NAME()) + {1};' -f $text, $statement
}

# DISABLE of a database trigger that is there and enabled, with the line that says so and how
# to enable it again ($Message). Nothing is done, and nothing printed, for one that is disabled
# already or not there: a line stands for a trigger whose state this statement changed.
function Get-DisableTriggerLoudSql($Item, [string]$Message) {
    $name = [string](Get-SqlPart $Item 'Name')
    return 'IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {0} AND is_disabled = 0) BEGIN DISABLE TRIGGER {1} ON DATABASE; {2} END' -f (Get-SqlLiteral $name), (Get-QuotedName $name), (Get-TriggerPrintSql $Item $Message)
}

function Get-TriggerNoteTableSql([string]$Table) {
    return 'IF OBJECT_ID(N''tempdb..{0}'') IS NULL CREATE TABLE {0} (database_id int NOT NULL, name nvarchar(128) COLLATE Latin1_General_BIN2 NOT NULL);' -f $Table
}

function Get-DropTriggerNoteTableSql([string]$Table) {
    return 'IF OBJECT_ID(N''tempdb..{0}'') IS NOT NULL DROP TABLE {0};' -f $Table
}

# Before the CREATE of a database trigger: notes its name when no trigger of that name is there.
function Get-NoteMissingTriggerSql($Item) {
    $literal = Get-SqlLiteral ([string](Get-SqlPart $Item 'Name'))
    return 'IF NOT EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {0}) INSERT INTO {1} (database_id, name) VALUES (DB_ID(), {0});' -f $literal, $CreatedTriggersTable
}

# DISABLE TRIGGER or ENABLE TRIGGER ($Action) for a database trigger, only when its name is noted
# in $Table for this database and the trigger is there.
function Get-NotedTriggerStateSql($Item, [string]$Table, [string]$Action) {
    $name = [string](Get-SqlPart $Item 'Name')
    return 'IF EXISTS (SELECT 1 FROM {0} WHERE database_id = DB_ID() AND name = {1}) AND EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {1}) {2} TRIGGER {3} ON DATABASE;' -f $Table, (Get-SqlLiteral $name), $Action, (Get-QuotedName $name)
}

# Disables a database trigger that is there and enabled, notes that this script did, and prints
# the statement that enables it again. The note first: a statement that fails between the two
# then leaves a note too many (the trigger is enabled once more, which it still is) instead of
# a trigger that stays disabled.
function Get-DisableAndNoteTriggerSql($Item) {
    $name = [string](Get-SqlPart $Item 'Name')
    $literal = Get-SqlLiteral $name
    return 'IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {0} AND is_disabled = 0) BEGIN INSERT INTO {1} (database_id, name) VALUES (DB_ID(), {0}); DISABLE TRIGGER {2} ON DATABASE; {3} END' -f $literal, $DisabledTriggersTable, (Get-QuotedName $name), (Get-TriggerPrintSql $Item $TriggerDisabledMessage)
}

# After the CREATE of a database trigger that the source has enabled: disabled when this run
# created it (it is noted), with the statement that enables it again printed.
function Get-DisableCreatedTriggerSql($Item) {
    $name = [string](Get-SqlPart $Item 'Name')
    return 'IF EXISTS (SELECT 1 FROM {0} WHERE database_id = DB_ID() AND name = {1}) AND EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {1}) BEGIN DISABLE TRIGGER {2} ON DATABASE; {3} END' -f $CreatedTriggersTable, (Get-SqlLiteral $name), (Get-QuotedName $name), (Get-TriggerPrintSql $Item $TriggerCreatedMessage)
}

# At the end of a script, after the statement that enables a noted trigger: a warning ($Message)
# when the trigger is disabled and not noted in $Table.
function Get-DisabledTriggerWarningSql($Item, [string]$Table, [string]$Message) {
    $literal = Get-SqlLiteral ([string](Get-SqlPart $Item 'Name'))
    return 'IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = {0} AND is_disabled = 1) AND NOT EXISTS (SELECT 1 FROM {1} WHERE database_id = DB_ID() AND name = {0}) {2}' -f $literal, $Table, (Get-TriggerPrintSql $Item $Message)
}

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
        # Lines for the header, after the labels (not $Note: names ignore case and $note is a scriptblock here; Write-SelectedScript says there that the file holds a selection).
        [string[]]$HeaderNotes = @(),
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
    # Statements to run by hand: each becomes a "-- " comment, and a line that is a comment
    # already stays as it is.
    $commented = {
        param($lines)
        foreach ($line in @($lines)) { if ([string]$line -match '^\s*--') { & $add $line } else { & $note $line } }
    }
    # Statements that are right only under a condition the script cannot check itself.
    $commentedWith = {
        param($condition, $lines)
        foreach ($line in @($lines)) {
            if ([string]$line -match '^\s*--') { & $add $line } else { & $note "Run this only if ${condition}: $line" }
        }
    }

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
        & $note "Rollback script generated by database-diff on $(Get-Timestamp 'yyyy-MM-dd HH:mm:ss')"
        & $note "Source (the sync script's model):  $SourceLabel"
        & $note "Target (will be changed back):     $TargetLabel"
        foreach ($line in $HeaderNotes) { & $note $line }
        # "Run it again, or its last section" is true where the script itself says what to enable.
        # On a target read without VIEW DEFINITION part of that is in the notes of a session.
        if ($TargetIncomplete) { $whenStopped = '--   disabled: see the INCOMPLETE COMPARISON lines below for what to do then.' }
        else { $whenStopped = '--   disabled: run it again, or its last section.' }
        & $add @(
            '--'
            '-- Running this on the TARGET database after the sync script of the same comparison puts its'
            '-- schema back as it was read during the comparison. REVIEW IT BEFORE RUNNING.'
            '-- - Nothing in this file has been executed by database-diff.'
            '-- - It assumes the target changed only through the sync script since the comparison.'
            '-- - Database triggers (ON DATABASE) come first: the ones the sync script created or changed are'
            '--   disabled, then dropped or put back. The ones that were enabled before the sync script'
            '--   are enabled again by the last statements of this file: an enabled one fires on the'
            '--   statements after it and may refuse them. If the script stops part way they stay'
            $whenStopped
            '-- - Procedures, views, functions, triggers, synonyms, indexes and constraints the sync script'
            '--   created are dropped next, with IF EXISTS so a sync script that stopped part way is fine.'
            '-- - Tables, columns, sequences, types and schemas it created are commented out at the end:'
            '--   dropping them loses the data written since.'
            '-- - Changed objects get their earlier definition back. ALTER COLUMN statements are active:'
            '--   check them for data loss (narrower types, NOT NULL). Except the change of a column that a'
            '--   computed column uses: SQL Server refuses it (Msg 5074), so it is written as a group of'
            '--   comments to run by hand (those computed columns dropped, the change, the columns added'
            '--   again).'
            '-- - A view that is altered back gets the indexes it had created again right after it (ALTER'
            '--   VIEW drops every index of a view). The indexes of the other views come after the views.'
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
        & $note "Sync script generated by database-diff on $(Get-Timestamp 'yyyy-MM-dd HH:mm:ss')"
        & $note "Source (the model):        $SourceLabel"
        & $note "Target (will be changed):  $TargetLabel"
        foreach ($line in $HeaderNotes) { & $note $line }
        # What a sync script does with database triggers, said for the target it was written for.
        # On a target read without VIEW DEFINITION the new ones are not disabled first (one of
        # them may be a trigger that was there all along), so the script is not simply run again.
        if ($TargetIncomplete) {
            $databaseTriggerLines = @(
                '-- - Database triggers (ON DATABASE): the ones this script changes or enables are disabled by'
                '--   its first statements, and changed and enabled by its last: an enabled one fires on the'
                '--   statements after it and may refuse them. Until then they are disabled for every session,'
                '--   not only this one: a trigger among them that records DDL (an audit trigger) records'
                '--   nothing while this script runs. The new ones are created by the last statements too; for'
                '--   those, and for running this script again, see INCOMPLETE COMPARISON below.'
                '-- - A database trigger this script does not touch stays enabled: if it refuses DDL, disable it'
                '--   by hand before running this script.'
            )
        }
        else {
            $databaseTriggerLines = @(
                '-- - Database triggers (ON DATABASE): the ones this script creates, changes or enables are'
                '--   disabled by its first statements, and created, changed and enabled by its last: an enabled'
                '--   one fires on the statements after it and may refuse them. Until then they are disabled for'
                '--   every session, not only this one: a trigger among them that records DDL (an audit trigger)'
                '--   records nothing while this script runs.'
                '-- - So the script can be run again after a run of it that completed or stopped part way: what'
                '--   that run enabled is disabled first, and what it created is reported as there already (Msg'
                '--   2714, Msg 1913 and the like). Do not run it with stop-on-error (sqlcmd -b): it would stop'
                '--   at the first such message, or at any other error, with those triggers disabled. For each'
                '--   trigger it disables, the script prints the statement that enables it again (USE ...;'
                '--   ENABLE TRIGGER ... ON DATABASE). If it stopped part way: run it again to its end, or run'
                '--   those statements to have the triggers enabled again.'
                '-- - A database trigger this script does not touch stays enabled: if it refuses DDL, disable it'
                '--   by hand before running this script.'
            )
        }
        & $add @(
            '--'
            '-- Running this on the TARGET database changes its schema to match the SOURCE, as far as the'
            '-- comparison could see. REVIEW IT BEFORE RUNNING and back up the target first.'
            '-- - Nothing in this file has been executed by database-diff.'
            '-- - Statements that drop tables, columns or other objects are commented out at the end.'
            '-- - ALTER COLUMN statements are active: check them for data loss (narrower types, NOT NULL).'
            '--   Except the change of a column that a computed column uses: SQL Server refuses it (Msg'
            '--   5074), so it is written as a group of comments to run by hand (those computed columns'
            '--   dropped, the change, the columns added again).'
            '-- - Objects are ordered by kind, not by dependency; rerun a failed part after the rest.'
            '-- - A view this script alters gets the indexes the source has on it created again right after'
            '--   it (ALTER VIEW drops every index of a view). The indexes of the other views come after'
            '--   the views.'
            $databaseTriggerLines
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
            '-- - Nor can this script tell which database triggers the sync script created. Each one that is'
            '--   only in the source and enabled when this script starts is disabled first (it may refuse'
            '--   the statements of this script), noted in a temporary table (#database_diff_disabled), and'
            '--   enabled again by the last statements, after the commented-out drops. That also happens to'
            '--   one that was there before the sync script: it ends as it started.'
            '-- - If this script stops part way, those triggers stay disabled, the target''s own among them,'
            '--   and the notes are gone with the session. For each trigger it disables, the script prints'
            '--   the statement that enables it again (USE ...; ENABLE TRIGGER ... ON DATABASE). Then: run'
            '--   the script again to its end, and run those statements. Only a run in the same session'
            '--   (query window) still has the notes and enables them itself; in another session the'
            '--   script cannot know what the stopped run disabled. It prints a warning for each trigger it'
            '--   finds disabled, also for one that was disabled all along: enable only what the stopped'
            '--   run listed.'
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
            '-- - A database trigger that is only in the source is disabled and enabled by this script only'
            '--   when this run created it: before each CREATE the script notes in a temporary table'
            '--   (#database_diff_created) whether the trigger was missing. One that was there already,'
            '--   hidden from the comparison, is left as it is, enabled or not. If such a trigger refuses'
            '--   DDL, disable it by hand before running this script.'
            '-- - Msg 2714 is therefore expected on this target. Do not run this script with stop-on-error'
            '--   (sqlcmd -b): it would stop at the first one, and leave the database triggers it created'
            '--   or was changing disabled. For each trigger it disables, the script prints the statement'
            '--   that enables it again (USE ...; ENABLE TRIGGER ... ON DATABASE). If it did stop part way:'
            '--   run it again to its end, then run those statements for the triggers it created (a changed'
            '--   one is enabled by that run itself). Only a run in the same session (query window) still'
            '--   has the notes and enables them itself; in another session the script prints a warning for'
            '--   each of them it finds disabled, also for one that was disabled all along: enable only what'
            '--   the stopped run said it created.'
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
    # An index of a view is an item of the Index category whose parent is a view. Those are kept
    # apart from the indexes of tables all through this script: they can only be written after
    # the views, and altering a view drops them (see $writeIndexesOfView).
    $sourceViewIndexes = Get-IndexesByView $SourceSnap
    $targetViewIndexes = Get-IndexesByView $TargetSnap
    $isViewIndex = {
        param($d)
        if ($d.Category -ne 'Index') { return $false }
        if ($null -ne $d.SourceKey) { $item = & $src $d } else { $item = & $tgt $d }
        if ($null -eq $item) { return $false }
        return $SourceSnap['View'].ContainsKey([string]$item.Parent) -or $TargetSnap['View'].ContainsKey([string]$item.Parent)
    }
    # The views whose indexes this script creates together with the view itself.
    $rebuiltViews = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)

    # ---- the writers of programmable objects (called further down, and first of all for the
    # database triggers of a rollback) ----
    # The indexes of a view, written right after the batch that created or altered it. ALTER VIEW
    # drops every index the view has, and CREATE OR ALTER VIEW is an ALTER when the view is
    # there: no message, the view just stops being an indexed view. So whenever this script
    # writes a view, it creates the indexes the model has on it, the clustered one first, whether
    # indexes are among the compared categories or not. $d: the difference record of the view.
    $writeIndexesOfView = {
        param($d, [bool]$createOnly)
        $rebuiltViews[[string]$d.SourceKey] = $true
        $model = $sourceViewIndexes[[string]$d.SourceKey]
        $existing = $targetViewIndexes[[string]$d.TargetKey]
        $hasModel = $null -ne $model -and $model.Count -gt 0
        $hasExisting = $null -ne $existing -and $existing.Count -gt 0
        # A model read from a snapshot file of version 1: what indexes the view had is not known.
        $modelKnown = [int]$SourceSnap['Meta'].Version -ge 2
        if ($Rollback) { $where = 'had before the sync script' } else { $where = 'has in the source' }
        if ($hasModel) {
            if ($d.Status -eq 'OnlyInSource') { & $note "The indexes $($d.Object) $where`:" }
            else { & $note "ALTER VIEW drops every index of a view. The indexes $($d.Object) $where are created again:" }
            foreach ($entry in $model) {
                if (& $missingParts $entry.Item) { $lines = @($oldSnapshotNote) } else { $lines = @(Get-CreateIndexSql $entry.Item) }
                if ($createOnly) {
                    # The CREATE VIEW fails when a view of that name is there already (hidden from
                    # the comparison), and these would land on that view.
                    & $commentedWith "the CREATE VIEW of $($d.Object) above succeeded" $lines
                }
                else { & $add $lines; & $go }
            }
        }
        if (-not $hasExisting) { return }
        if (-not $modelKnown) {
            $names = @($existing | ForEach-Object { [string](Get-SqlPart $_.Item 'Name') }) -join ', '
            & $note "WARNING: the ALTER VIEW above drops the indexes of $($d.Object) ($names), and this script cannot create them again: the side the view is taken from is a snapshot saved before the engine read the indexes of views. Create them again by hand. As they were:"
            foreach ($entry in $existing) {
                if (-not (& $missingParts $entry.Item)) { & $commented (Get-CreateIndexSql $entry.Item) }
            }
        }
        elseif (-not $Rollback) {
            # In a rollback these are the indexes the sync script created: gone, as they should be.
            $modelKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($entry in $model) { [void]$modelKeys.Add($entry.Key) }
            foreach ($entry in $existing) {
                if ($modelKeys.Contains($entry.Key)) { continue }
                & $note "Not created again: index $(Get-SqlPart $entry.Item 'Name') of $($d.Object) is only in the target, and the ALTER VIEW above drops it. The rollback script creates it again."
            }
        }
    }

    # One section of modules. Database triggers are items of the Trigger category, written in a
    # section of their own ($databaseScope): never with the triggers of tables.
    #
    # An enabled database trigger fires on every DDL statement after it and may refuse it
    # (RAISERROR and ROLLBACK end the batch with Msg 3609): the statements of this script too,
    # the CREATE of the next trigger, even its own ALTER. So a script disables, with its first
    # statements, every database trigger it manages (creates, alters, drops, or sets the state
    # of), and enables with its last statements the ones that are to be enabled. In between
    # none of them is left to refuse anything.
    # - A sync script disables them first ($part 'first'): the ones it alters, the ones of which
    #   only the state differs, whichever way, and the ones it creates. A new one is not there
    #   at a first run; at a second run the first has created and enabled it. It writes them
    #   last ($part 'last'), a new one disabled again right after its CREATE (which makes it
    #   enabled), and enables those the source has enabled at the very end.
    #   Between its first and its last statements those triggers are disabled, also when the
    #   script does not get that far: under stop-on-error any error ends it there (on a second
    #   run the first "already there" message does). So each DISABLE that changes the state of
    #   a trigger prints the statement that enables it again ($TriggerHeldMessage and the two
    #   after it), and the header says not to run the script that way.
    #   It once disabled them only in that last section. Run again after a run that completed,
    #   it then met the guards that run had enabled: every statement before the section was
    #   refused, and so were the CREATE OR ALTER statements in it. And a guard of the target
    #   itself of which only the state differs (enabled there, disabled in the source) refused
    #   the script from its first statement, on the first run.
    # - A rollback script writes them first: the sync script left them enabled, and they would
    #   refuse the rest of the rollback. The ones the sync script created are disabled and
    #   dropped, the ones it changed disabled and put back. Those that were enabled before the
    #   sync script are enabled again by the last statements of the script ($enableLast), not at
    #   the end of this section: one of them may be the target's own guard, and it would refuse
    #   what the rollback still has to do (seen: a trigger FOR DROP_PROCEDURE, DROP_INDEX that
    #   was enabled again here left the index and the procedure of the sync script in place).
    #   The ones it only enables at its end are disabled first as well: a second run of the
    #   rollback meets them enabled by the first.
    # DISABLE TRIGGER and ENABLE TRIGGER are not DDL events, so they are never refused.
    #
    # A refusal is not always just Msg 3609. Seen on SQL Server 2025 (LocalDB 17.0, 2026-11-12):
    # when the statement that a database trigger rolls back is the ALTER (CREATE OR ALTER) of a
    # DISABLED database trigger that itself watches ALTER_TRIGGER, the server ends with an
    # access violation (Error 17310: the session is killed, and once the whole instance went
    # down). The same ALTER of an enabled trigger, or of a trigger for other events, gets the
    # usual Msg 3609. One statement shows it: a guard FOR DDL_DATABASE_LEVEL_EVENTS that does
    # RAISERROR and ROLLBACK, a second trigger FOR ALTER_TRIGGER, disabled, and CREATE OR ALTER
    # of the second. A script cannot avoid that statement: it has to disable a trigger before
    # it alters it (an enabled one fires on its own ALTER and may refuse it). What it avoids is
    # the rollback: with every trigger it manages disabled before its first statement, none of
    # them is left to roll an ALTER back. A database trigger the script does not manage (the
    # same on both sides, only in the target, or hidden from the comparison) still can, which
    # is why the header says to disable such a trigger by hand.
    # Left as it was: a trigger that has to be dropped and created again by hand (another type).
    # On a target read without VIEW DEFINITION a trigger that is only in the source may be one
    # that was there already, and whether that one is enabled is not a script's to change (see
    # $CreatedTriggersTable for what the scripts do instead):
    # - a sync script disables a new trigger after its plain CREATE, and enables it at the end,
    #   only when this run created it;
    # - a rollback script leaves the drops of those triggers as comments, like the drops of the
    #   other modules, but disables the enabled ones while it runs and enables them again at
    #   its end ($restoreLast).
    # A trigger both sides have (the login saw it, and its text) is changed as on any target.
    $enableLast = New-Object System.Collections.Generic.List[object]
    # And the ones a rollback on a target read without VIEW DEFINITION disabled at its start
    # because the sync script may have created them: enabled again when its notes say so.
    $restoreLast = New-Object System.Collections.Generic.List[object]
    # $part, for the database triggers of a sync script, which writes them in two places:
    # 'first' is the section that disables them, 'last' everything else. 'all': one section.
    $writeModules = {
        param([string]$category, [bool]$databaseScope = $false, [string]$part = 'all')
        $new = @(@(& $pick $category 'OnlyInSource') | Where-Object { (Test-DatabaseScope (& $src $_)) -eq $databaseScope })
        $changed = @(@(& $pick $category 'Different') | Where-Object { (Test-DatabaseScope (& $src $_)) -eq $databaseScope })
        # For database triggers only: the ones a rollback drops, the ones disabled before
        # anything is written, and the ones enabled when everything is.
        $created = @()
        # On a target read without VIEW DEFINITION: the ones a rollback cannot tell from
        # triggers that were there before the sync script.
        $maybeCreated = @()
        $disableFirst = New-Object System.Collections.Generic.List[object]
        $enableChanged = New-Object System.Collections.Generic.List[object]
        $enableNew = New-Object System.Collections.Generic.List[object]
        $stateNotes = @{}
        if ($databaseScope) {
            # ToArray, not @(...): Windows PowerShell 5.1 fails on @() around an empty generic list.
            if ($Rollback -and -not $TargetIncomplete) { $created = $databaseTriggersCreated.ToArray() }
            elseif ($Rollback) { $maybeCreated = $databaseTriggersCreated.ToArray() }
            foreach ($item in $created) { $disableFirst.Add($item) }
            # (sync) The new ones this script writes: there, and enabled, when a run before
            # this one created them. Not on a target read without VIEW DEFINITION, where one
            # that is there may be the target's own (see $CreatedTriggersTable).
            if (-not $Rollback -and -not $TargetIncomplete) {
                foreach ($d in $new) {
                    $s = & $src $d
                    if ((& $missingParts $s) -or -not (ConvertTo-ModuleScript $s $d.SourceKey $false).ContainsKey('Script')) { continue }
                    $disableFirst.Add($s)
                }
            }
            foreach ($d in $changed) {
                $s = & $src $d
                if ((& $missingParts $s) -or $d.Detail -match '(^|\n)(Type|Table):') { continue }
                $stateDiffers = $d.Detail -match '(^|\n)State:'
                # The same test as below: a definition (or its SET options) that this script writes.
                $altered = $d.Detail -match '(^|\n)(Definition differs|SetOptions:)' -and $d.Detail -notmatch '(^|\n)Definition: not readable' -and
                    (ConvertTo-ModuleScript $s $d.SourceKey $false).ContainsKey('Script')
                $enabled = [string]$s.Props['State'] -ne 'DISABLED'
                # Also one that is only to be enabled at the end: it is disabled now when
                # the script runs for the first time, and enabled when it runs again.
                if ($altered -or $stateDiffers) { $disableFirst.Add($s) }
                if ($enabled -and ($altered -or $stateDiffers)) { $enableChanged.Add($s) }
                # Nothing but the state differs: no batch follows its line, so the line says
                # where its statement is.
                if ($stateDiffers -and -not $altered) {
                    if ($enabled -and $Rollback) { $stateNotes[[string]$d.SourceKey] = '-- Enabled by the last statements of this script.' }
                    elseif ($enabled) { $stateNotes[[string]$d.SourceKey] = '-- Enabled at the end of this section.' }
                    elseif ($Rollback) { $stateNotes[[string]$d.SourceKey] = '-- Disabled at the start of this section.' }
                    else { $stateNotes[[string]$d.SourceKey] = '-- Disabled by the first statements of this script.' }
                }
            }
        }
        if ($part -eq 'first') {
            # (sync) Nothing but the statements that disable them, before every other section.
            if (-not $disableFirst.Count) { return }
            & $section 'Database triggers first: disabled until the last section of this script creates, changes and enables them'
            # On a target read without VIEW DEFINITION the new ones are not among them.
            if ($TargetIncomplete) { & $add '-- Disabled before anything else: an enabled one fires on every statement of this script and may refuse it. Not the new ones, which may be triggers that were there all along: see INCOMPLETE COMPARISON at the top.' }
            else { & $add '-- Disabled before anything else: an enabled one fires on every statement of this script and may refuse it. Also the ones a run of this script before this one created or enabled, so that the script can be run again.' }
            # Each with its line: a run that ends before the last section leaves them disabled.
            # The ones the source has enabled are the ones that section enables again.
            foreach ($item in $disableFirst) {
                if ([string]$item.Props['State'] -ne 'DISABLED') { $message = $TriggerHeldMessage } else { $message = $TriggerOffMessage }
                & $add (Get-DisableTriggerLoudSql $item $message); & $go
            }
            return
        }
        if (-not ($new.Count -or $changed.Count -or $created.Count -or $maybeCreated.Count)) { return }
        # A sync script on a target read without VIEW DEFINITION keeps notes on its new triggers.
        $notesCreated = $databaseScope -and [bool]$TargetIncomplete -and -not $Rollback -and $new.Count -gt 0
        if (-not $databaseScope) { & $section "$category`s" }
        elseif ($Rollback) { & $section 'Database triggers first: disabled, then dropped or put back (enabled again by the last statements of this script)' }
        else { & $section 'Database triggers last: disabled until all of them are in place (an enabled one fires on the statements after it)' }
        if ($notesCreated) {
            & $add '-- The comparison of the target is incomplete: a trigger that is only in the source may be there already, hidden. This script disables and enables only the ones it creates: before each CREATE it notes in a temporary table of this session whether the trigger was missing. When running only a part of this section, run this batch and the batch before a CREATE with it.'
            & $add (Get-TriggerNoteTableSql $CreatedTriggersTable); & $go
        }
        if ($maybeCreated.Count) {
            & $add '-- The comparison of the target is incomplete: this script cannot tell which of these the sync script created, and one that is enabled may refuse the statements below. The enabled ones are disabled, noted in a temporary table of this session, and enabled again by the last statements of this script.'
            & $add (Get-TriggerNoteTableSql $DisabledTriggersTable); & $go
            foreach ($item in $maybeCreated) { & $add (Get-DisableAndNoteTriggerSql $item); & $go; $restoreLast.Add($item) }
        }
        # (A sync script wrote these in its first section: $part 'first', above.)
        if ($disableFirst.Count -and $part -ne 'last') {
            & $add '-- Disabled before anything else: the sync script left them enabled, and an enabled one may refuse the statements of this script.'
            foreach ($item in $disableFirst) { & $add (Get-DatabaseTriggerStateSql $item 'DISABLE'); & $go }
        }
        if ($created.Count) {
            & $add '-- Created by the sync script: dropped.'
            foreach ($item in $created) { & $add (Get-DropModuleSql $item -IfExists); & $go }
        }
        foreach ($d in ($new + $changed)) {
            $s = & $src $d
            # True once the batch that creates or alters the module is written (not a comment).
            $written = $false
            if ($d.Status -eq 'OnlyInSource') { $what = 'only in source' } else { $what = $d.Detail }
            & $note "$($d.Object): $what"
            if ($stateNotes.ContainsKey([string]$d.SourceKey)) { & $add $stateNotes[[string]$d.SourceKey] }
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
                    & $note (Get-DropModuleSql $t)
                    & $add '-- GO'
                }
                $module = ConvertTo-ModuleScript $s $d.SourceKey $true
                if ($module.ContainsKey('Comment')) { & $add $module.Comment }
                else {
                    # Line by line: a definition has line breaks, and each line needs its own "--".
                    # (Not called $commented: that is the script block every section writes
                    # comments with, also the ones this block calls.)
                    $byHand = New-Object System.Collections.Generic.List[string]
                    $setLines = @(Get-ModuleSetLines ([string]$s.Props['SetOptions']))
                    if ($setLines.Count) { $byHand.AddRange([string[]]$setLines); $byHand.Add('GO') }
                    $byHand.AddRange([string[]]($module.Script.TrimEnd() -split '\r\n|\r|\n'))
                    $byHand.Add('GO')
                    if ($setLines.Count) { $byHand.AddRange([string[]]@('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;', 'GO')) }
                    if ($category -eq 'Trigger' -and $s.Props['State'] -eq 'DISABLED' -and -not (& $missingParts $s)) {
                        $byHand.Add(('DISABLE TRIGGER {0} ON {1};' -f (Get-ModuleName $s), (Get-TriggerTarget $s)))
                    }
                    foreach ($line in $byHand) { & $add ('-- ' + $line).TrimEnd() }
                }
            }
            elseif ($definitionChanged) {
                $module = ConvertTo-ModuleScript $s $d.SourceKey $createOnly
                if ($module.ContainsKey('Comment')) { & $add $module.Comment }
                else {
                    if ($createOnly) { & $add '-- Plain CREATE, because the comparison of the target is incomplete: if it fails with Msg 2714, the object is there already. Compare it with the source by hand.' }
                    # A database trigger: noted when it is not there yet, in the batch before its
                    # CREATE (which must start a batch of its own).
                    if ($createOnly -and $databaseScope -and -not (& $missingParts $s)) { & $add (Get-NoteMissingTriggerSql $s) }
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
                    $written = $true
                    if ($setLines.Count) { & $add @('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;'); & $go }
                    if ($category -eq 'View') { & $writeIndexesOfView $d $createOnly }
                }
            }
            if ($databaseScope) {
                # A database trigger is not enabled here (see above). A new one is created
                # enabled: disabled at once, and enabled with the others at the end of the
                # section when the source has it enabled. A changed one was disabled before.
                if ($d.Status -eq 'OnlyInSource' -and -not (& $missingParts $s)) {
                    if ($createOnly) {
                        # Only when this run created it: one that was there already stays as
                        # it is, enabled or not.
                        # One the source has enabled is enabled again at the end: its
                        # DISABLE prints the statement to run should the script not get there.
                        if ($written -and [string]$s.Props['State'] -ne 'DISABLED') {
                            & $add (Get-DisableCreatedTriggerSql $s); & $go
                            $enableNew.Add($s)
                        }
                        elseif ($written) { & $add (Get-NotedTriggerStateSql $s $CreatedTriggersTable 'DISABLE'); & $go }
                    }
                    elseif ($written -and [string]$s.Props['State'] -ne 'DISABLED') {
                        # Enabled again at the end, so this DISABLE says how to do that by
                        # hand. (On a second run the trigger was disabled by the first
                        # statements, which said it: nothing is done or printed here.)
                        & $add (Get-DisableTriggerLoudSql $s $TriggerNewHeldMessage); & $go
                        $enableNew.Add($s)
                    }
                    elseif ($written) { & $add (Get-DatabaseTriggerStateSql $s 'DISABLE'); & $go }
                }
            }
            elseif ($category -eq 'Trigger' -and -not (& $missingParts $s) -and -not ($typeChanged -or $tableChanged)) {
                # The trigger of a table. Not one that has to be dropped and created again by
                # hand: it is not there yet, or still on the other table.
                $name = Get-ModuleName $s
                $parent = Get-TriggerTarget $s
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
        # Database triggers: every one of this section is in place now. The new ones first, in
        # the order they were created, then the changed ones. A rollback has everything else
        # still to do, so it keeps them for its last statements (it has no new ones).
        if ($Rollback) { foreach ($item in $enableChanged) { $enableLast.Add($item) } }
        elseif ($enableNew.Count + $enableChanged.Count) {
            if ($notesCreated) { & $add '-- Enabled now that all of them are in place: the ones the source has enabled. Of the new ones only those this run created; a warning is printed for one that was there already and is disabled: it may have been disabled all along, or an earlier run that stopped part way created it.' }
            else { & $add '-- Enabled now that all of them are in place: the ones the source has enabled.' }
            foreach ($item in $enableNew) {
                if ($notesCreated) {
                    & $add (Get-NotedTriggerStateSql $item $CreatedTriggersTable 'ENABLE')
                    & $add (Get-DisabledTriggerWarningSql $item $CreatedTriggersTable $TriggerNotCreatedWarning)
                }
                else { & $add (Get-DatabaseTriggerStateSql $item 'ENABLE') }
                & $go
            }
            foreach ($item in $enableChanged) { & $add (Get-DatabaseTriggerStateSql $item 'ENABLE'); & $go }
        }
        if ($notesCreated) { & $add (Get-DropTriggerNoteTableSql $CreatedTriggersTable); & $go }
    }

    $constraintDrops = New-Object System.Collections.Generic.List[string]
    # Each @{ Line = the drop; View = key of the view }.
    $viewIndexDrops = New-Object System.Collections.Generic.List[object]
    $moduleDrops = New-Object System.Collections.Generic.List[string]
    # Database triggers, apart from the other modules. The drops as text, for the lists of
    # comments, and the items themselves: a rollback disables and drops the ones the sync
    # script created before anything else (see $writeModules).
    $databaseTriggerDrops = New-Object System.Collections.Generic.List[string]
    $databaseTriggersCreated = New-Object System.Collections.Generic.List[object]
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
            elseif ($category -eq 'Index' -and (& $isViewIndex $d)) {
                $viewIndexDrops.Add(@{ Line = (Get-DropIndexSql $t -IfExists:$Rollback); View = [string]$t.Parent })
            }
            elseif ($category -eq 'Index') { $constraintDrops.Add((Get-DropIndexSql $t -IfExists:$Rollback)) }
            else { $constraintDrops.Add((Get-DropConstraintSql $t -IfExists:$Rollback)) }
        }
    }
    foreach ($category in @('Trigger', 'Stored procedure', 'View', 'Function')) {
        foreach ($d in (& $pick $category 'OnlyInTarget')) {
            $t = & $tgt $d
            if (& $missingParts $t) { continue }
            if (Test-DatabaseScope $t) { $databaseTriggerDrops.Add((Get-DropModuleSql $t -IfExists:$Rollback)); $databaseTriggersCreated.Add($t) }
            else { $moduleDrops.Add((Get-DropModuleSql $t -IfExists:$Rollback)) }
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

    # ---- (rollback) database triggers, before anything else ----
    # The sync script ended by enabling the database triggers the model has enabled. One of them
    # may refuse DDL: every drop and change below would end with Msg 3609.
    if ($Rollback) { & $writeModules 'Trigger' $true }
    # ---- (sync) database triggers, disabled before anything else ----
    # The ones the script manages; they are written, and enabled, by its last section.
    else { & $writeModules 'Trigger' $true 'first' }

    # In a rollback the indexes the sync script created on views go with the other indexes. (Where
    # the rollback alters the view back further down, that drops them anyway: hence IF EXISTS.)
    $activeDrops = @($constraintDrops) + @($viewIndexDrops | ForEach-Object { $_.Line })
    # The other modules after the indexes and constraints. (The database triggers went above.)
    if (-not $TargetIncomplete) { $activeDrops = $activeDrops + @($moduleDrops) }
    # Where modules are listed as comments: the database triggers first.
    $moduleDropComments = @($databaseTriggerDrops) + @($moduleDrops)
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
                else { $lines.Add('    -- ' + (Get-CommentText (Get-UnreadableColumnText $c ([string](Get-SqlPart $c 'Name'))))) }
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
        # New columns that are not computed come first, then the changed columns, then the new
        # computed columns: SQL Server does not alter a column that a computed column uses (Msg
        # 5074), so a computed column added before the columns it uses have been changed would be
        # in the way of this script's own ALTER COLUMN.
        $newPlain = New-Object System.Collections.Generic.List[object]
        $newComputed = New-Object System.Collections.Generic.List[object]
        foreach ($d in $new) {
            $s = & $src $d
            if ($null -ne $s -and [string]$s.Props['Computed']) { $newComputed.Add($d) } else { $newPlain.Add($d) }
        }
        $addColumn = {
            param($d)
            $s = & $src $d
            if (& $missingParts $s) { & $add $oldSnapshotNote; return }
            $definition = Get-ColumnDefinition $s $targetCollation
            if (-not $definition) { & $note ('Not scripted: ' + (Get-UnreadableColumnText $s $d.Object)); return }
            if ($s.Props['Nullable'] -eq 'NOT NULL' -and -not $s.Props['Default'] -and -not $s.Props['Identity'] -and -not $s.Props['Computed']) {
                & $add '-- WARNING: NOT NULL without a default fails when the table already has rows.'
            }
            & $add ('ALTER TABLE {0} ADD {1};' -f (Get-TableName $s), $definition); & $go
        }
        # The computed columns that are on the target when this script runs, by table. For a sync
        # script those of the target. For a rollback the target is what the sync script left: the
        # model's columns (this call's target snapshot), and the columns only the target had,
        # which the sync script does not drop (this call's source snapshot).
        $computedSides = @((Get-ComputedColumnsByTable $TargetSnap))
        if ($Rollback) { $computedSides += (Get-ComputedColumnsByTable $SourceSnap) }

        foreach ($d in $newPlain) { & $addColumn $d }
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
            elseif (($diff['Nullable'] -or $diff['Collation']) -and ([string]$s.Props['Type'] -eq $HiddenValue -or [string]$t.Props['Type'] -eq $HiddenValue)) {
                # ALTER COLUMN says the whole column again, its type first. One that is not
                # readable cannot be written, and writing the other side's would change a type
                # that was never compared.
                & $add '-- Not scripted: the type of this column is not readable on one side (a user-defined type the login has no permission on), and ALTER COLUMN has to say the type again. Compare the column by hand.'
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
            # Computed columns of the table that use this column. SQL Server does not alter a
            # column a computed column depends on, whatever changes (type, length, NULL / NOT
            # NULL) and whether the computed column is persisted or not: Msg 5074 for each of
            # them, then Msg 4922. They have to be dropped first and added again afterwards, and
            # dropping a column is not for this script to do: the whole change is written as
            # comments, one group to run by hand.
            $dropDependents = New-Object System.Collections.Generic.List[string]
            $addDependents = New-Object System.Collections.Generic.List[string]
            if ($alterSql) {
                $dependentNames = New-Object System.Collections.Generic.List[string]
                $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
                foreach ($side in $computedSides) {
                    foreach ($entry in @(Get-ComputedDependents $side $s.Parent $column)) {
                        if (-not $seen.Add($entry.Key)) { continue }
                        $name = [string](Get-SqlPart $entry.Item 'Name')
                        # A snapshot without name parts: the key is table.column.
                        if (-not $name) { $name = $entry.Key.Substring(([string]$s.Parent).Length + 1) }
                        $dependentNames.Add((Get-QuotedName $name))
                        $dropDependents.Add(('ALTER TABLE {0} DROP COLUMN {1};' -f $table, (Get-QuotedName $name)))
                        # Added again as the model has it; one the model does not have (only in
                        # the target, which this script leaves alone) as it is now.
                        $definition = $null
                        foreach ($snap in @($SourceSnap, $TargetSnap)) {
                            $candidate = $snap['Column'][$entry.Key]
                            if ($null -eq $definition -and $null -ne $candidate -and $null -ne $candidate.Sql) { $definition = Get-ColumnDefinition $candidate $targetCollation }
                        }
                        if ($definition) { $addDependents.Add(('ALTER TABLE {0} ADD {1};' -f $table, $definition)) }
                        else { $addDependents.Add('-- ' + (Get-CommentText "(add computed column $name again by hand: its definition is not readable)")) }
                    }
                }
                if ($dependentNames.Count) {
                    if ($dependentNames.Count -eq 1) { $which = 'computed column {0} uses' -f $dependentNames[0] } else { $which = 'computed columns {0} use' -f ($dependentNames -join ', ') }
                    & $note "Not run: $which this column, and SQL Server does not alter a column that a computed column uses (Msg 5074, Msg 4922). By hand: first drop the indexes, constraints and statistics that use the computed columns named here, then run the next lines as one batch. They drop those computed columns, make the change and add them again:"
                }
            }
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
                    & $commented (@($dropDependents) + $dropLines + $afterDrop + @($addDependents))
                }
                elseif ($targetDefault -eq $HiddenValue) {
                    # Nor is dropping a default nobody could read: what goes is not known, and
                    # the other script (which has it as the default to put back) cannot restore it.
                    & $add '-- Not scripted: the type change needs the default of the column dropped first, and the default the column has now is not readable, so what would be dropped is not known and could not be put back. By hand: look at that default, then run these:'
                    & $commented (@($dropDependents) + $dropLines + $afterDrop + @($addDependents))
                }
                elseif ($dropDependents.Count) {
                    # By hand, and all or nothing: one transaction around the computed columns
                    # going, the default going, the change, and all of them coming back.
                    & $commented (@('BEGIN TRANSACTION;') + @($dropDependents) + $dropLines + $afterDrop + @($addDependents) + @('COMMIT TRANSACTION;'))
                }
                else {
                    # More than the drop itself: one transaction, under the script's SET XACT_ABORT
                    # ON. When the ALTER COLUMN or the new default fails (rows that do not fit, a
                    # function that is not there), the drop is rolled back and the default stays.
                    if ($afterDrop.Count) { & $add 'BEGIN TRANSACTION;'; & $add $dropLines; & $add $afterDrop; & $add 'COMMIT TRANSACTION;' }
                    else { & $add $dropLines }
                }
            }
            elseif ($alterSql -and $dropDependents.Count) {
                & $commented (@('BEGIN TRANSACTION;') + @($dropDependents) + @($alterSql) + @($addDependents) + @('COMMIT TRANSACTION;'))
            }
            elseif ($alterSql) { & $add $alterSql }
            if ($diff['Ordinal']) {
                & $add '-- Column order differs: SQL Server cannot move a column without rebuilding the table, so this is not scripted.'
            }
            & $go
        }
        foreach ($d in $newComputed) { & $addColumn $d }
    }

    # ---- indexes, check constraints, foreign keys ----
    $childSections = @(
        @{ Category = 'Index'; Title = 'Indexes, primary keys and unique constraints' },
        @{ Category = 'Check constraint'; Title = 'Check constraints' },
        @{ Category = 'Foreign key'; Title = 'Foreign keys' }
    )
    # On a target read without VIEW DEFINITION, "only in source" may be something that is there
    # but hidden. A statement that would then land on an object this script did not create,
    # or add a second copy, is written as a comment that says what to check first. (Not in a
    # rollback: it has no new tables, and its unnamed checks are comments already.)
    $guarded = [bool]$TargetIncomplete -and -not $Rollback

    # One section of them. It is written for the tables (each of the three categories), and once
    # more for the indexes of views, which can only come after the views. $ofNewTables: items of
    # the tables this script creates; $new and $changed: difference records.
    $writeChildSection = {
        param([string]$category, [string]$title, $ofNewTables, $new, $changed, [bool]$onViews)
        if (-not ($ofNewTables.Count -or $new.Count -or $changed.Count)) { return }
        & $section $title

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
            elseif ($onViews -and ($s.Props['Type'] -eq 'CLUSTERED' -or $t.Props['Type'] -eq 'CLUSTERED')) {
                # Dropping the clustered index of a view drops every other index of that view
                # with it, and the view stops being an indexed view until it is created again.
                & $add '-- The clustered index of a view differs. Dropping it drops every other index of the view with it, so this is left commented out. By hand: run these (the drop, the index, then the other indexes of the view):'
                & $commented (& $drop $t)
                & $commented (& $create $s)
                foreach ($entry in $sourceViewIndexes[[string]$s.Parent]) {
                    if ($entry.Key -ne $d.SourceKey) { & $commented (& $create $entry.Item) }
                }
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
    foreach ($cs in $childSections) {
        $category = $cs.Category
        if ($SelectedCategories -notcontains $category) { continue }
        # Objects of new tables are not in the diff list (only the table is), so take them from the
        # source. In the order of their keys: a snapshot holds them in no order (as the catalog
        # returned them, which changes when other objects are added to the database), and the
        # script of the same comparison must come out the same every time.
        [string[]]$childKeys = @($SourceSnap[$category].get_Keys())
        [System.Array]::Sort($childKeys, [System.StringComparer]::Ordinal)
        $ofNewTables = @($childKeys | ForEach-Object { $SourceSnap[$category][$_] } | Where-Object { $newTableKeys.ContainsKey($_.Parent) -and -not ($category -eq 'Index' -and $_.Props['Kind'] -eq 'PRIMARY KEY') })
        # Without the indexes of views: those have a section of their own, after the views.
        $new = @(@(& $pick $category 'OnlyInSource') | Where-Object { -not (& $isViewIndex $_) })
        $changed = @(@(& $pick $category 'Different') | Where-Object { -not (& $isViewIndex $_) })
        & $writeChildSection $category $cs.Title $ofNewTables $new $changed $false
    }

    # ---- programmable objects ----
    & $writeModules 'Function'
    & $writeModules 'View'
    # The indexes of the views that are on both sides, now that every view is as the model has
    # it. Not those of a view written above: they were created with it. New ones with the
    # clustered index first, which the others of its view need.
    if ($SelectedCategories -contains 'Index') {
        $notRebuilt = {
            param($d)
            if (-not (& $isViewIndex $d)) { return $false }
            if ($null -ne $d.SourceKey) { $item = & $src $d } else { $item = & $tgt $d }
            return -not $rebuiltViews.ContainsKey([string]$item.Parent)
        }
        $newOnViews = @(@(& $pick 'Index' 'OnlyInSource') | Where-Object { & $notRebuilt $_ })
        $clusteredFirst = @($newOnViews | Where-Object { (& $src $_).Props['Type'] -eq 'CLUSTERED' }) + @($newOnViews | Where-Object { (& $src $_).Props['Type'] -ne 'CLUSTERED' })
        $changedOnViews = @(@(& $pick 'Index' 'Different') | Where-Object { & $notRebuilt $_ })
        & $writeChildSection 'Index' 'Indexes on views' @() $clusteredFirst $changedOnViews $true
    }
    & $writeModules 'Stored procedure'
    & $writeModules 'Trigger'

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

    # ---- (sync) database triggers ----
    # After everything else that is created or changed: a DDL trigger fires on the statements that
    # follow it, and the one the model has may refuse or record what this script still has to do.
    # (A rollback wrote them first, above.)
    if (-not $Rollback) { & $writeModules 'Trigger' $true 'last' }

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
        if ($TargetIncomplete -and $moduleDropComments.Count) {
            $incompleteNotes = @('-- The comparison of the target is incomplete: one of the next objects may have been there before the sync script (its CREATE then failed with Msg 2714). Uncomment only those the sync script created:')
            if ($databaseTriggerDrops.Count) {
                $incompleteNotes += '-- (Run with this whole file, the drop of a database trigger meets it disabled: see the first and the last section. Run on its own, an enabled trigger may refuse its own DROP: disable it first.)'
            }
            $drops = $incompleteNotes + $moduleDropComments + $drops
        }
        $title = 'Created by the sync script: NOT dropped. Uncomment a line only after checking nothing still needs it (data is lost)'
    }
    else {
        # Not the indexes of a view this script altered: they are gone with the ALTER VIEW, and the
        # note after that view says so.
        $leftViewIndexDrops = @($viewIndexDrops | Where-Object { -not $rebuiltViews.ContainsKey($_.View) } | ForEach-Object { $_.Line })
        $drops = @($constraintDrops) + $leftViewIndexDrops + $moduleDropComments + @($dataDrops)
        $title = 'Only in target: NOT dropped. Uncomment a line only after checking nothing still needs it (data is lost)'
    }
    if ($drops.Count) {
        & $section $title
        foreach ($line in $drops) { if ($line.StartsWith('--')) { & $add $line } else { & $note $line } }
    }

    if ($out.Count -gt 0 -and -not ($Diffs | Where-Object { $_.Status -ne 'Unverified' })) {
        if ($Rollback) { & $section 'Nothing to roll back' } else { & $section 'No differences to apply' }
    }

    # ---- (rollback) database triggers, enabled again ----
    # The last statements of a rollback: until here the database triggers it disabled at its
    # start stay disabled. After the commented-out drops as well, so that one of those that is
    # uncommented runs while they are disabled too.
    if ($Rollback -and ($enableLast.Count -or $restoreLast.Count)) {
        if ($restoreLast.Count) { & $section 'Database triggers, enabled again: the ones that were enabled before the sync script, and the ones this script disabled at its start' }
        else { & $section 'Database triggers, enabled again: the ones that were enabled before the sync script' }
        & $add '-- Last, when nothing is left for them to refuse: an enabled one fires on the statements after it.'
        foreach ($item in $enableLast) { & $add (Get-DatabaseTriggerStateSql $item 'ENABLE'); & $go }
        if ($restoreLast.Count) {
            & $add '-- The ones noted at the start of this script (enabled then, and the sync script may have created them): enabled again when they are still there. A warning is printed for one that is disabled without a note of this run: it may have been disabled all along, or an earlier run that stopped part way disabled it.'
            foreach ($item in $restoreLast) {
                & $add (Get-NotedTriggerStateSql $item $DisabledTriggersTable 'ENABLE')
                # The same warning for every one of them: this script does not know why a
                # trigger is disabled, and the state the source has it in does not tell.
                & $add (Get-DisabledTriggerWarningSql $item $DisabledTriggersTable $TriggerNotDisabledWarning)
                & $go
            }
            & $add (Get-DropTriggerNoteTableSql $DisabledTriggersTable); & $go
        }
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
        [string[]]$HeaderNotes = @(),
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
    Write-SyncScript $Path $TargetSnap $SourceSnap @($reversed) $SourceLabel $TargetLabel $TargetDatabase $Warnings -Rollback -TargetIncomplete:$TargetIncomplete -HeaderNotes $HeaderNotes
}
