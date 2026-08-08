param(
  [Parameter(Position=0)]
  [string]$Root = (Get-Location).Path,
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$BridgeArgs
)
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $dir 'atlas-bridge.js') --allow-root $Root --app (Join-Path $dir 'atlas-v1.0.0.html') @BridgeArgs
exit $LASTEXITCODE
