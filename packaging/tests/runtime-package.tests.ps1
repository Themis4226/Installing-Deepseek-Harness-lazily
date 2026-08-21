[CmdletBinding()]
param(
    [string]$NodeExecutable = 'node.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$packagingRoot = Split-Path -Parent $PSScriptRoot
$builder = Join-Path $packagingRoot 'build-runtime-update.ps1'
$verifier = Join-Path $packagingRoot 'verify-runtime-package.mjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-runtime-tests-" + [System.Guid]::NewGuid().ToString('N'))
$version = '0.1.1-rc.2'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Write-Utf8Json {
    param([string]$Path, [object]$Value)
    $json = ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($Path, $json, $utf8WithoutBom)
}

try {
    $sourceRoot = Join-Path $testRoot 'source'
    $packageRoot = Join-Path $sourceRoot 'node_modules\@deepseek-ai\dsh'
    $outputRoot = Join-Path $testRoot 'output'
    [System.IO.Directory]::CreateDirectory((Join-Path $packageRoot 'lib')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $packageRoot 'lib\bin.js'), "console.log('fixture')`n", $utf8WithoutBom)
    Write-Utf8Json -Path (Join-Path $packageRoot 'package.json') -Value ([ordered]@{
        name = '@deepseek-ai/dsh'
        version = $version
    })

    # These user-data-looking directories deliberately coexist beside node_modules.
    # The builder must select node_modules only, never copy them into runtime/.
    foreach ($name in @('data', 'logs', '.dsh')) {
        $directory = Join-Path $sourceRoot $name
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $directory 'must-not-ship.txt'), 'private fixture', $utf8WithoutBom)
    }

    $buildOutput = & $builder -SourceRoot $sourceRoot -Version $version -OutputDirectory $outputRoot -NodeExecutable $NodeExecutable
    $buildResult = ($buildOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($buildResult.status -eq 'created') 'builder did not report created status'
    Assert-True ([System.IO.File]::Exists($buildResult.archive)) 'runtime archive was not created'
    Assert-True ([System.IO.File]::Exists($buildResult.metadata)) 'asset metadata was not created'

    $verifyOutput = & $NodeExecutable $verifier --archive $buildResult.archive --version $version --json
    Assert-True ($LASTEXITCODE -eq 0) 'valid fixture archive did not pass verification'
    $verifyResult = ($verifyOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($verifyResult.valid -eq $true) 'verifier did not return valid=true'
    Assert-True ($verifyResult.sha256 -eq $buildResult.sha256) 'builder and verifier SHA256 values differ'

    $metadata = Get-Content -LiteralPath $buildResult.metadata -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($metadata.asset.size -eq $verifyResult.size) 'metadata asset size is incorrect'
    Assert-True ($metadata.asset.sha256 -eq $verifyResult.sha256) 'metadata SHA256 is incorrect'
    Assert-True ($metadata.runtime.fixedEntry -eq 'node_modules/@deepseek-ai/dsh/lib/bin.js') 'fixed entry metadata is incorrect'

    $listing = & tar.exe -tf $buildResult.archive
    foreach ($sensitiveName in @('runtime/data', 'runtime/logs', 'runtime/.dsh')) {
        Assert-True (-not (($listing -join "`n") -match [regex]::Escape($sensitiveName))) "$sensitiveName leaked into the archive"
    }

    $wrongOutput = Join-Path $testRoot 'wrong-version-output'
    $failedAsExpected = $false
    try {
        & $builder -SourceRoot $sourceRoot -Version '0.1.1-rc.3' -OutputDirectory $wrongOutput -NodeExecutable $NodeExecutable | Out-Null
    }
    catch {
        $failedAsExpected = $_.Exception.Message -match 'does not match requested version'
    }
    Assert-True $failedAsExpected 'builder did not reject a mismatched DSH package version'
    Assert-True (-not [System.IO.Directory]::Exists($wrongOutput)) 'failed build published an output directory'

    $forbiddenPackage = Join-Path $sourceRoot 'node_modules\@themis4226\dsh-launcher-update-ui'
    [System.IO.Directory]::CreateDirectory($forbiddenPackage) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $forbiddenPackage 'package.json'), '{}', $utf8WithoutBom)
    $forbiddenOutput = Join-Path $testRoot 'launcher-integration-output'
    $forbiddenFailedAsExpected = $false
    try {
        & $builder -SourceRoot $sourceRoot -Version $version -OutputDirectory $forbiddenOutput -NodeExecutable $NodeExecutable | Out-Null
    }
    catch {
        $forbiddenFailedAsExpected = $_.Exception.Message -match 'Launcher integration must not be included'
    }
    Assert-True $forbiddenFailedAsExpected 'builder accepted launcher integration inside runtime node_modules'
    Assert-True (-not [System.IO.Directory]::Exists($forbiddenOutput)) 'forbidden build published an output directory'

    $maliciousRoot = Join-Path $testRoot 'malicious-stage'
    $maliciousRuntime = Join-Path $maliciousRoot 'runtime'
    [System.IO.Directory]::CreateDirectory((Join-Path $maliciousRuntime 'data')) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $maliciousRuntime 'data\secret.txt'), 'secret', $utf8WithoutBom)
    $maliciousArchive = Join-Path $testRoot 'malicious.zip'
    & tar.exe -a -cf $maliciousArchive -C $maliciousRoot runtime
    Assert-True ($LASTEXITCODE -eq 0) 'could not create malicious test archive'
    # Windows PowerShell 5.1 can promote native stderr to an ErrorRecord when
    # ErrorActionPreference is Stop. This invocation is expected to fail, so
    # temporarily keep native stderr non-terminating and assert the exit code.
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $NodeExecutable $verifier --archive $maliciousArchive --version $version --json 2>$null | Out-Null
    $maliciousExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    Assert-True ($maliciousExitCode -ne 0) 'verifier accepted runtime/data content'

    [ordered]@{
        status = 'passed'
        tests = 11
        fixtureArchive = $buildResult.archive
        fixtureSha256 = $buildResult.sha256
    } | ConvertTo-Json -Compress
}
finally {
    $candidate = [System.IO.Path]::GetFullPath($testRoot)
    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parent = [System.IO.Directory]::GetParent($candidate)
    if ($null -ne $parent -and
        $parent.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -eq $temporaryBase -and
        [System.IO.Path]::GetFileName($candidate).StartsWith('dsh-runtime-tests-', [System.StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
}
