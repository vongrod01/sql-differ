# The sync or rollback script of a chosen part of a comparison. It is built from what a run keeps of
# the comparison: the result file (<base>.json) and the two snapshots next to it
# (<base>.source.snapshot.json, <base>.target.snapshot.json), so no database is opened. The scripts
# come from Write-SyncScript and Write-RollbackScript, called as Invoke-DatabaseComparison calls them
# but with only the chosen differences: choosing every difference gives the script that the
# comparison wrote. Compare-Database.ps1 -ScriptFromResult is the way in (see Write-SelectedScript).

# The rows a selection file names: { "rows": [3, 5, 8] }, where a row is the position (from 0) of a
# difference in the "diffs" of the result file, which is also the id of its row in the HTML report.
# Returns them in ascending order. Throws for anything else: no rows, a row that is not a whole
# number or is out of range, a row twice.
function Read-ScriptSelection([string]$Path, [int]$Total) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { throw "Selection file not found: $Path" }
    $doc = Read-JsonFile $Path
    $rows = $null
    if ($doc -is [System.Collections.IDictionary] -and @($doc.Keys) -contains 'rows') { $rows = $doc['rows'] }
    if ($null -eq $rows -or $rows -isnot [System.Collections.IList] -or $rows.Count -eq 0) {
        throw 'The selection needs "rows": a list of at least one row.'
    }
    $seen = @{}
    foreach ($row in $rows) {
        if ($row -isnot [int]) { throw ('The rows of a selection are whole numbers, not {0}.' -f $row) }
        if ($row -lt 0 -or $row -ge $Total) {
            throw ('Row {0} is not one of the rows of this comparison (0 to {1}).' -f $row, ($Total - 1))
        }
        if ($seen.ContainsKey($row)) { throw ('Row {0} is in the rows of the selection twice.' -f $row) }
        $seen[$row] = $true
    }
    return @($rows | Sort-Object)
}

# The key of the table a foreign key points to, as the Table category names it ("dbo.Customers").
function Get-ReferencedTable($Item) {
    if ($null -ne $Item.Sql -and $Item.Sql.ContainsKey('RefTable')) {
        return ('{0}.{1}' -f $Item.Sql['RefSchema'], $Item.Sql['RefTable'])
    }
    $text = [string]$Item.Props['References']
    $paren = $text.LastIndexOf(' (')
    if ($paren -gt 0) { return $text.Substring(0, $paren) }
    return $text
}

# What a chosen difference needs that is not chosen: a trigger on a table, or a foreign key to a
# table, that the comparison lists as only in the source (the table is created by the sync script,
# or not at all). Without that table the statement fails when the script runs. This is all it can
# tell from the snapshots; other dependencies (a view or a procedure that reads a new object) are
# not looked for. $Diffs are all the differences of the comparison and $Rows the chosen ones, as
# positions in $Diffs. Returns { row, object, needsRow, needs } per difference.
function Get-SelectionNeeds($Diffs, [int[]]$Rows, $SourceSnap) {
    $newTables = @{}
    for ($i = 0; $i -lt $Diffs.Count; $i++) {
        $d = $Diffs[$i]
        if ($d.Category -eq 'Table' -and $d.Status -eq 'OnlyInSource' -and $null -ne $d.SourceKey) { $newTables[[string]$d.SourceKey] = $i }
    }
    $chosen = @{}
    foreach ($row in $Rows) { $chosen[$row] = $true }
    $needs = New-Object System.Collections.Generic.List[object]
    foreach ($row in $Rows) {
        $d = $Diffs[$row]
        if (($d.Status -ne 'OnlyInSource' -and $d.Status -ne 'Different') -or $null -eq $d.SourceKey) { continue }
        $item = $SourceSnap[[string]$d.Category][[string]$d.SourceKey]
        if ($null -eq $item) { continue }
        $table = ''
        if ($d.Category -eq 'Trigger') {
            if (-not (Test-DatabaseScope $item)) { $table = [string]$item.Props['Table'] }
        }
        elseif ($d.Category -eq 'Foreign key') { $table = Get-ReferencedTable $item }
        if (-not $table -or -not $newTables.ContainsKey($table)) { continue }
        $tableRow = [int]$newTables[$table]
        if ($chosen.ContainsKey($tableRow)) { continue }
        $needs.Add([ordered]@{ row = $row; object = [string]$d.Object; needsRow = $tableRow; needs = [string]$Diffs[$tableRow].Object })
    }
    return $needs.ToArray()
}

# Writes the script of $Kind ('sync' or 'rollback') for the rows in the selection file to
# $OutputPath, and returns what the caller needs to know: how many rows were chosen of how many,
# and what they need that is not chosen (see Get-SelectionNeeds). When not every row is chosen the
# header of the file says so, and names what is missing, for a file that is taken without the page
# that warned. When every row is chosen the file is the one the comparison wrote.
function Write-SelectedScript([string]$ResultPath, [string]$SelectionPath, [string]$Kind, [string]$OutputPath) {
    if ($Kind -ne 'sync' -and $Kind -ne 'rollback') { throw '-ScriptKind must be sync or rollback.' }
    if (-not $OutputPath) { throw '-ScriptOutput is required.' }
    if (-not $ResultPath.EndsWith('.json', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "-ScriptFromResult must be the .json result file of a run: $ResultPath"
    }
    if (-not (Test-Path -LiteralPath $ResultPath)) { throw "Result file not found: $ResultPath" }
    $base = $ResultPath.Substring(0, $ResultPath.Length - '.json'.Length)
    $snapshotPaths = @{ Source = $base + '.source.snapshot.json'; Target = $base + '.target.snapshot.json' }
    foreach ($side in 'Source', 'Target') {
        if (-not (Test-Path -LiteralPath $snapshotPaths[$side])) {
            throw ('This run did not keep the {0} snapshot ({1}), so a script cannot be built from a selection. Compare again.' -f $side.ToLowerInvariant(), [System.IO.Path]::GetFileName($snapshotPaths[$side]))
        }
    }

    $result = Read-JsonFile $ResultPath
    if ($result['format'] -ne 'database-diff-result') { throw "Not a database-diff result: $ResultPath" }
    $records = @($result['diffs'])
    $rows = @(Read-ScriptSelection $SelectionPath $records.Count)

    # What the comparison had set. The generator reads some of it from script-level variables.
    $script:SelectedCategories = [string[]]@($result['categories'])
    $script:Perspective = [string]$result['perspective']
    $options = $result['options']
    $script:IgnoreWhitespace = [bool]$options['ignoreWhitespace']
    $script:IgnoreCase = [bool]$options['ignoreCase']
    $script:IgnoreCollation = [bool]$options['ignoreCollation']
    $script:CompareColumnOrder = [bool]$options['compareColumnOrder']
    # The same as at the top of Compare-Database.ps1, which works it out once from the switches.
    $script:IgnoredProps = @{}
    if ($script:IgnoreCollation) { $script:IgnoredProps['Collation'] = $true }
    if (-not $script:CompareColumnOrder) { $script:IgnoredProps['Ordinal'] = $true }

    $diffs = @(foreach ($r in $records) {
        New-DiffRecord -Category ([string]$r['Category']) -Object ([string]$r['Object']) -Status ([string]$r['Status']) -Detail ([string]$r['Detail']) `
            -SourceDefinition $r['SourceDefinition'] -TargetDefinition $r['TargetDefinition'] -SourceKey $r['SourceKey'] -TargetKey $r['TargetKey']
    })
    $chosen = @(foreach ($row in $rows) { $diffs[$row] })

    $source = Import-SchemaSnapshot $snapshotPaths.Source
    $target = Import-SchemaSnapshot $snapshotPaths.Target
    $needs = @(Get-SelectionNeeds $diffs $rows $source.Snap)

    $notes = New-Object System.Collections.Generic.List[string]
    if ($rows.Count -lt $diffs.Count) {
        $notes.Add(('Generated from a selection: {0} of {1} differences. The others are not in this file.' -f $rows.Count, $diffs.Count))
        # A rollback undoes only what the sync script of the same selection did; it has nothing to say about a table.
        if ($Kind -eq 'sync') {
            foreach ($n in $needs) {
                $notes.Add(('WARNING: {0} needs {1}, which is new in the source and is not part of the selection: its statement fails until that table exists.' -f $n['object'], $n['needs']))
            }
        }
    }

    $scriptArguments = @{
        Path             = $OutputPath
        SourceSnap       = $source.Snap
        TargetSnap       = $target.Snap
        Diffs            = $chosen
        SourceLabel      = [string]$result['source']['label']
        TargetLabel      = [string]$result['target']['label']
        TargetDatabase   = $target.Database
        Warnings         = [string[]]@($result['warnings'])
        HeaderNotes      = $notes.ToArray()
        TargetIncomplete = (-not [bool]$target.Snap['Meta'].CanViewDefinition)
    }
    if ($Kind -eq 'sync') { Write-SyncScript @scriptArguments } else { Write-RollbackScript @scriptArguments }

    return [ordered]@{ selected = $rows.Count; total = $diffs.Count; needs = [object[]]@($needs) }
}
