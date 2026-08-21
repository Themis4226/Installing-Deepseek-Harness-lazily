[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$NodeExecutable = 'node.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$packageName = '@deepseek-ai/dsh'
$platform = 'win32'
$architecture = 'x64'
$format = 'dsh-runtime-zip-v1'
$fixedEntry = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
$assetName = "dsh-runtime-$Version-win-x64.zip"
$metadataName = "$assetName.metadata.json"
$workingRoot = $null
$publishedArchive = $null

function Resolve-RequiredAbsoluteDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Label must be an absolute path: $Path"
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not [System.IO.Directory]::Exists($fullPath)) {
        throw "$Label does not exist: $fullPath"
    }
    if ($fullPath -eq [System.IO.Path]::GetPathRoot($fullPath)) {
        throw "$Label cannot be a filesystem root: $fullPath"
    }
    return [System.IO.DirectoryInfo]::new($fullPath).FullName
}

function Resolve-RequiredExecutable {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ([System.IO.Path]::IsPathRooted($Value)) {
        $fullPath = [System.IO.Path]::GetFullPath($Value)
        if (-not [System.IO.File]::Exists($fullPath)) {
            throw "Executable does not exist: $fullPath"
        }
        return $fullPath
    }
    $command = Get-Command -Name $Value -CommandType Application -ErrorAction Stop | Select-Object -First 1
    return $command.Source
}

function Assert-SafeTemporaryWorkingRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parent = [System.IO.Directory]::GetParent($candidate)
    if ($null -eq $parent -or $parent.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ne $temporaryBase) {
        throw "Refusing to clean an unexpected temporary path: $candidate"
    }
    if (-not [System.IO.Path]::GetFileName($candidate).StartsWith('dsh-runtime-package-', [System.StringComparison]::Ordinal)) {
        throw "Refusing to clean an unexpected temporary directory name: $candidate"
    }
}

try {
    $source = Resolve-RequiredAbsoluteDirectory -Path $SourceRoot -Label 'SourceRoot'
    if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
        throw "OutputDirectory must be an absolute path: $OutputDirectory"
    }
    $output = [System.IO.Path]::GetFullPath($OutputDirectory)
    if ($output -eq [System.IO.Path]::GetPathRoot($output)) {
        throw "OutputDirectory cannot be a filesystem root: $output"
    }

    $node = Resolve-RequiredExecutable -Value $NodeExecutable
    $tar = Resolve-RequiredExecutable -Value 'tar.exe'
    $verifier = Join-Path $PSScriptRoot 'verify-runtime-package.mjs'
    $sanitizer = Join-Path $PSScriptRoot 'sanitize-pnpm-bin-shims.mjs'
    $sensitiveScanner = Join-Path $PSScriptRoot 'scan-sensitive-strings.mjs'
    foreach ($script in @($verifier, $sanitizer, $sensitiveScanner)) {
        if (-not [System.IO.File]::Exists($script)) {
            throw "Required packaging script is missing: $script"
        }
    }

    $sourceNodeModules = Join-Path $source 'node_modules'
    $sourcePackageJson = Join-Path $sourceNodeModules '@deepseek-ai\dsh\package.json'
    $sourceEntry = Join-Path $sourceNodeModules '@deepseek-ai\dsh\lib\bin.js'
    if (-not [System.IO.Directory]::Exists($sourceNodeModules)) {
        throw "Source node_modules is missing: $sourceNodeModules"
    }
    if (-not [System.IO.File]::Exists($sourcePackageJson)) {
        throw "DSH package metadata is missing: $sourcePackageJson"
    }
    if (-not [System.IO.File]::Exists($sourceEntry)) {
        throw "Fixed DSH entry is missing: $sourceEntry"
    }
    $launcherIntegrationInRuntime = Join-Path $sourceNodeModules '@themis4226\dsh-launcher-update-ui'
    if (Test-Path -LiteralPath $launcherIntegrationInRuntime) {
        throw 'Launcher integration must not be included in a DSH runtime asset.'
    }

    $dshPackage = Get-Content -LiteralPath $sourcePackageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($dshPackage.name -ne $packageName) {
        throw "Unexpected DSH package name: $($dshPackage.name)"
    }
    if ($dshPackage.version -ne $Version) {
        throw "Source DSH version '$($dshPackage.version)' does not match requested version '$Version'."
    }

    $unsafeLink = Get-ChildItem -LiteralPath $sourceNodeModules -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop |
        Select-Object -First 1
    if ($null -ne $unsafeLink) {
        throw "Source node_modules contains a reparse point and cannot be packaged safely: $($unsafeLink.FullName)"
    }

    $finalArchive = Join-Path $output $assetName
    $finalMetadata = Join-Path $output $metadataName
    if ([System.IO.File]::Exists($finalArchive) -or [System.IO.File]::Exists($finalMetadata)) {
        throw "Refusing to overwrite an existing runtime asset or metadata file in: $output"
    }

    $workingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-runtime-package-" + [System.Guid]::NewGuid().ToString('N'))
    Assert-SafeTemporaryWorkingRoot -Path $workingRoot
    $stagingRoot = Join-Path $workingRoot 'stage'
    $runtimeRoot = Join-Path $stagingRoot 'runtime'
    $stagedNodeModules = Join-Path $runtimeRoot 'node_modules'
    [System.IO.Directory]::CreateDirectory($stagedNodeModules) | Out-Null

    $robocopy = Resolve-RequiredExecutable -Value 'robocopy.exe'
    & $robocopy $sourceNodeModules $stagedNodeModules /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP /NJH /NJS | Out-Null
    $robocopyExitCode = $LASTEXITCODE
    if ($robocopyExitCode -ge 8) {
        throw "robocopy failed while staging node_modules (exit code $robocopyExitCode)."
    }
    $sanitizeOutput = & $node $sanitizer $stagedNodeModules 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm shim sanitization failed: $($sanitizeOutput -join [Environment]::NewLine)"
    }

    $runtimeMetadata = [ordered]@{
        schemaVersion = 1
        dshPackage = $packageName
        dshVersion = $Version
        platform = $platform
        arch = $architecture
        entry = $fixedEntry
    }
    $runtimeMetadataJson = ($runtimeMetadata | ConvertTo-Json -Depth 4) + [Environment]::NewLine
    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $runtimeRoot 'runtime.json'), $runtimeMetadataJson, $utf8WithoutBom)

    $unexpectedTopLevel = Get-ChildItem -LiteralPath $runtimeRoot -Force | Where-Object {
        $_.Name -ne 'node_modules' -and $_.Name -ne 'runtime.json'
    } | Select-Object -First 1
    if ($null -ne $unexpectedTopLevel) {
        throw "Refusing to package unexpected runtime content: $($unexpectedTopLevel.FullName)"
    }
    foreach ($sensitiveName in @('data', 'logs', '.dsh')) {
        if (Test-Path -LiteralPath (Join-Path $runtimeRoot $sensitiveName)) {
            throw "Refusing to package sensitive runtime content: runtime/$sensitiveName"
        }
    }
    $sensitiveValues = @(
        $source,
        $env:USERPROFILE,
        $env:USERNAME,
        $node
    ) | Where-Object { $_ }
    $scanOutput = & $node $sensitiveScanner $runtimeRoot @sensitiveValues 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Sensitive-string scan failed: $($scanOutput -join [Environment]::NewLine)"
    }

    $temporaryArchive = Join-Path $workingRoot $assetName
    & $tar -a -cf $temporaryArchive -C $stagingRoot 'runtime'
    if ($LASTEXITCODE -ne 0 -or -not [System.IO.File]::Exists($temporaryArchive)) {
        throw "tar failed to create the runtime ZIP (exit code $LASTEXITCODE)."
    }

    $verificationOutput = & $node $verifier --archive $temporaryArchive --version $Version --tar $tar --json 2>&1
    $verificationExitCode = $LASTEXITCODE
    if ($verificationExitCode -ne 0) {
        throw "Runtime ZIP verification failed: $($verificationOutput -join [Environment]::NewLine)"
    }
    $verification = ($verificationOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $verification.valid -or $verification.version -ne $Version) {
        throw 'Runtime ZIP verifier returned an unexpected result.'
    }

    $assetMetadata = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTime]::UtcNow.ToString('o')
        runtime = [ordered]@{
            version = $Version
            platform = $platform
            arch = $architecture
            format = $format
            fixedEntry = $fixedEntry
        }
        asset = [ordered]@{
            fileName = $assetName
            size = [int64]$verification.size
            sha256 = [string]$verification.sha256
        }
        verification = [ordered]@{
            archiveEntries = [int64]$verification.archiveEntries
            files = [int64]$verification.files
            directories = [int64]$verification.directories
            extractedBytes = [int64]$verification.extractedBytes
        }
    }
    $temporaryMetadata = Join-Path $workingRoot $metadataName
    $assetMetadataJson = ($assetMetadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($temporaryMetadata, $assetMetadataJson, $utf8WithoutBom)

    [System.IO.Directory]::CreateDirectory($output) | Out-Null
    if ([System.IO.File]::Exists($finalArchive) -or [System.IO.File]::Exists($finalMetadata)) {
        throw "Runtime output appeared while the package was being built; refusing to overwrite it: $output"
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $finalArchive -ErrorAction Stop
    $publishedArchive = $finalArchive
    Move-Item -LiteralPath $temporaryMetadata -Destination $finalMetadata -ErrorAction Stop

    $result = [ordered]@{
        status = 'created'
        archive = $finalArchive
        metadata = $finalMetadata
        version = $Version
        size = [int64]$verification.size
        sha256 = [string]$verification.sha256
        files = [int64]$verification.files
        extractedBytes = [int64]$verification.extractedBytes
    }
    $result | ConvertTo-Json -Compress
}
catch {
    if ($null -ne $publishedArchive -and [System.IO.File]::Exists($publishedArchive)) {
        Remove-Item -LiteralPath $publishedArchive -Force -ErrorAction SilentlyContinue
    }
    throw
}
finally {
    if ($null -ne $workingRoot -and [System.IO.Directory]::Exists($workingRoot)) {
        Assert-SafeTemporaryWorkingRoot -Path $workingRoot
        Remove-Item -LiteralPath $workingRoot -Recurse -Force
    }
}
