# CI and local command evidence. Release mode includes the five isolated native product cases.
param([ValidateSet('core', 'release')][string]$Mode = 'core')
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repository
$evidenceDirectory = Join-Path $repository '.artifacts/ci'
New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null
$executions = [System.Collections.Generic.List[object]]::new()
$gitRoot = & git rev-parse --show-toplevel 2>$null
$ownsGit = $LASTEXITCODE -eq 0 -and [System.IO.Path]::GetFullPath($gitRoot) -eq [System.IO.Path]::GetFullPath($repository)
$revision = if ($ownsGit) { & git rev-parse HEAD } else { $null }
$dirty = if ($ownsGit) { [bool](& git status --porcelain) } else { $null }
$report = [ordered]@{ recordedAt = [DateTimeOffset]::UtcNow.ToString('o'); commit = $revision; dirty = $dirty; sourceKind = $(if ($ownsGit) { 'git checkout' } else { 'exported directory; retain its source manifest separately' }); node = (& node --version); pnpm = (& pnpm --version); os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription; mode = $Mode; productTests = 'not enabled'; executions = $executions; artifacts = @() }
function Invoke-Checked([string]$Name, [string[]]$CommandArguments) {
  $log = Join-Path $evidenceDirectory "$Name.log"
  & pnpm @CommandArguments *> $log
  $code = $LASTEXITCODE
  $executions.Add(@{ command = "pnpm $($CommandArguments -join ' ')"; exitCode = $code; log = "$Name.log" })
  Get-Content -LiteralPath $log -Tail 12
  if ($code -ne 0) { throw "Verification failed: $Name (exit $code); see $log" }
}
try {
  if ($env:MCP_PROXY_PRODUCT_TESTS -eq '1') { throw 'Unset MCP_PROXY_PRODUCT_TESTS for core/CI verification.' }
  Invoke-Checked 'doctor' @('dev:doctor', '--packaging')
  Invoke-Checked 'development-init' @('dev:init')
  Invoke-Checked 'build' @('build')
  Invoke-Checked 'typecheck' @('typecheck')
  Invoke-Checked 'test' @('test')
  Invoke-Checked 'development-check' @('dev:check')
  if ($Mode -eq 'release') {
    Invoke-Checked 'proxy' @('build:mcp-proxy', '--skip-build')
    Invoke-Checked 'plugin' @('build:mcp-plugin', '--skip-build')
    $report.artifacts = @(Get-ChildItem -LiteralPath (Join-Path $repository 'release') -Recurse -File | ForEach-Object {
      @{ path = [System.IO.Path]::GetRelativePath($repository, $_.FullName); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $report.productTests = 'required; inspect product-verification.json for outcome'
    Invoke-Checked 'product' @('test:product')
    $report.productTests = 'five native product cases passed; zero skips'
  }
} finally {
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'verification.json') -Encoding utf8
}
