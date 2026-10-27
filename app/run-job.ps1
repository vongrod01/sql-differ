# Started by Windows Task Scheduler in a hidden window: runs one scheduled job of the web app.
# node inherits this hidden console, so nothing shows on the desktop during the run.
param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$JobId
)

& $Node (Join-Path $PSScriptRoot 'cli.js') run-job $JobId
exit $LASTEXITCODE
