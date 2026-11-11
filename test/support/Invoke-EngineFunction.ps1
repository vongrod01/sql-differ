# Test harness: calls one function of the engine without running the engine itself.
#
# The function definitions and the top-level variable assignments of Compare-Database.ps1 and
# lib\SyncScript.ps1 are taken from their syntax trees and loaded here in file order. The engine's
# param block and main code never run, so its switches ($IgnoreCase, ...) are unset unless the
# request sets them.
#
# The request is a UTF-8 JSON file:
#   { "function": "Get-QuotedName", "variables": { "IgnoreCase": true }, "setup": "", "cases": [ ["a]b"], ... ] }
# Each case is the list of positional arguments of one call. JSON objects arrive as
# Dictionary[string, object], the shape of a snapshot loaded from a file. The result file holds one
# { "ok": true, "value": ... } or { "ok": false, "error": "..." } per case, in the same order.
#
# Names here start with "harness" so no engine function picks one up through dynamic scoping.
param(
    [Parameter(Mandatory = $true)][string]$CasesPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$harnessRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$harnessCode = New-Object System.Text.StringBuilder
foreach ($harnessFile in @('Compare-Database.ps1', 'lib\SyncScript.ps1')) {
    $harnessTokens = $null
    $harnessErrors = $null
    $harnessAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $harnessRoot $harnessFile), [ref]$harnessTokens, [ref]$harnessErrors)
    if ($harnessErrors.Count -gt 0) { throw ('{0} does not parse: {1}' -f $harnessFile, $harnessErrors[0].Message) }
    foreach ($harnessStatement in $harnessAst.EndBlock.Statements) {
        $harnessIsFunction = $harnessStatement -is [System.Management.Automation.Language.FunctionDefinitionAst]
        $harnessIsAssignment = $harnessStatement -is [System.Management.Automation.Language.AssignmentStatementAst]
        if (-not ($harnessIsFunction -or $harnessIsAssignment)) { continue }
        # The report templates are read from the engine's own folder; no function under test needs them.
        if ($harnessIsAssignment -and $harnessStatement.Extent.Text.Contains('$PSScriptRoot')) { continue }
        [void]$harnessCode.AppendLine($harnessStatement.Extent.Text)
    }
}
. ([scriptblock]::Create($harnessCode.ToString()))

Add-Type -AssemblyName System.Web.Extensions
$harnessSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$harnessSerializer.MaxJsonLength = [int]::MaxValue
$harnessUtf8 = New-Object System.Text.UTF8Encoding($false)
$harnessRequest = $harnessSerializer.DeserializeObject([System.IO.File]::ReadAllText($CasesPath, $harnessUtf8))

$harnessVariables = $harnessRequest['variables']
if ($null -ne $harnessVariables) {
    foreach ($harnessName in @($harnessVariables.get_Keys())) {
        Set-Variable -Name $harnessName -Value $harnessVariables[$harnessName] -Scope Script
    }
}

# "setup": PowerShell text that runs after the engine is loaded, in this scope. A test uses it to
# put a stub in place of a function that needs a server (Open-SqlConnection, ...) and to define a
# wrapper that calls the function under test with engine values (hashtables) built here.
if ($harnessRequest['setup']) { . ([scriptblock]::Create([string]$harnessRequest['setup'])) }

$harnessFunction = [string]$harnessRequest['function']
$harnessResults = New-Object System.Collections.Generic.List[object]
foreach ($harnessCase in $harnessRequest['cases']) {
    try {
        $harnessArguments = @($harnessCase)
        $harnessValue = & $harnessFunction @harnessArguments
        $harnessResults.Add(@{ ok = $true; value = $harnessValue })
    }
    catch {
        $harnessResults.Add(@{ ok = $false; error = $_.Exception.Message })
    }
}

# The engine's own JSON writer: it knows the engine's value types (hashtables, ordered dictionaries,
# custom objects), which JavaScriptSerializer does not once PowerShell has wrapped them.
[System.IO.File]::WriteAllText($ResultPath, (ConvertTo-JsonText $harnessResults.ToArray()), $harnessUtf8)
