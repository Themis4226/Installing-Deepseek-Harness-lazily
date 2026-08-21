[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$UpdaterScript,

    [string]$NodeExecutable = 'node.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$updaterPath = (Resolve-Path -LiteralPath $UpdaterScript).Path
$nodePath = if ([System.IO.Path]::IsPathRooted($NodeExecutable)) {
    (Resolve-Path -LiteralPath $NodeExecutable).Path
} else {
    (Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-updater-compat-" + [System.Guid]::NewGuid().ToString('N'))
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

try {
    [System.IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $dataRoot = Join-Path $testRoot 'data-root'
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    $manifestPath = Join-Path $testRoot 'update.json'
    $asset = Get-Item -LiteralPath $archivePath
    $sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        schemaVersion = 1
        channel = 'preview'
        publishedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        minimumLauncherVersion = '1.2.0'
        runtime = [ordered]@{
            version = $Version
            platform = 'win32'
            arch = 'x64'
            format = 'dsh-runtime-zip-v1'
            asset = [ordered]@{
                url = [System.Uri]::new($archivePath).AbsoluteUri
                size = [int64]$asset.Length
                sha256 = $sha256
            }
        }
        releaseNotesUrl = [System.Uri]::new($manifestPath).AbsoluteUri
    }
    $manifestJson = ($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8WithoutBom)
    $manifestUrl = [System.Uri]::new($manifestPath).AbsoluteUri

    $firstOutput = & $nodePath $updaterPath prepare --manifest $manifestUrl --data-root $dataRoot --current-version '0.1.0-rc.6' --test-mode
    Assert-True ($LASTEXITCODE -eq 0) "updater prepare failed: $($firstOutput -join [Environment]::NewLine)"
    $first = ($firstOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($first.ok -eq $true) 'updater did not return ok=true'
    Assert-True ($first.status -eq 'prepared') 'first updater run did not prepare the runtime'
    Assert-True ($first.version -eq $Version) 'updater returned the wrong runtime version'
    Assert-True ([System.IO.Directory]::Exists($first.runtimePath)) 'updater runtimePath was not created'
    Assert-True ([System.IO.File]::Exists((Join-Path $first.runtimePath 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) 'prepared runtime fixed entry is missing'

    $secondOutput = & $nodePath $updaterPath prepare --manifest $manifestUrl --data-root $dataRoot --current-version '0.1.0-rc.6' --test-mode
    Assert-True ($LASTEXITCODE -eq 0) "second updater prepare failed: $($secondOutput -join [Environment]::NewLine)"
    $second = ($secondOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($second.status -eq 'already-prepared') 'second updater run was not idempotent'

    $temporaryResidue = @(Get-ChildItem -LiteralPath $dataRoot -Force -Recurse -ErrorAction Stop | Where-Object {
        $_.Name -match '\.(partial|staging)-'
    })
    Assert-True ($temporaryResidue.Count -eq 0) 'updater left a partial or staging path behind'

    [ordered]@{
        status = 'passed'
        archive = $archivePath
        sha256 = $sha256
        preparedRuntime = $first.runtimePath
        firstStatus = $first.status
        secondStatus = $second.status
    } | ConvertTo-Json -Compress
}
finally {
    $candidate = [System.IO.Path]::GetFullPath($testRoot)
    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parent = [System.IO.Directory]::GetParent($candidate)
    if ($null -ne $parent -and
        $parent.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -eq $temporaryBase -and
        [System.IO.Path]::GetFileName($candidate).StartsWith('dsh-updater-compat-', [System.StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
    }
}
