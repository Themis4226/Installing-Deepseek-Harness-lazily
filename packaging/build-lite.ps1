[CmdletBinding()]
param(
    [string]$Version = '1.4.0',
    [string]$DshVersion = '0.1.1-rc.2',
    [string]$RuntimeArchive,
    [string]$NodeExecutable = 'node.exe'
)

$ErrorActionPreference = 'Stop'
$packagingRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$workspace = [IO.Path]::GetFullPath((Join-Path $packagingRoot '..')).TrimEnd('\')
$distRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'dist')).TrimEnd('\')
$stageName = "DSH-Desktop-Lite-$Version-win-x64"
$stagePath = [IO.Path]::GetFullPath((Join-Path $distRoot $stageName)).TrimEnd('\')
$zipPath = [IO.Path]::GetFullPath((Join-Path $distRoot "$stageName.zip"))
$checksumPath = "$zipPath.sha256"
$runtimeExtractName = "$stageName-runtime-extract"
$runtimeExtractPath = [IO.Path]::GetFullPath((Join-Path $distRoot $runtimeExtractName)).TrimEnd('\')

if ([string]::IsNullOrWhiteSpace($RuntimeArchive)) {
    $RuntimeArchive = Join-Path $distRoot "runtime\dsh-runtime-$DshVersion-win-x64.zip"
}
$RuntimeArchive = [IO.Path]::GetFullPath($RuntimeArchive)

function Assert-ExactChildPath([string]$candidate, [string]$parent, [string]$expectedName) {
    $expected = [IO.Path]::GetFullPath((Join-Path $parent $expectedName)).TrimEnd('\')
    if ($candidate -ne $expected -or -not $candidate.StartsWith("$parent\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify unverified path: $candidate"
    }
}

function Remove-VerifiedDirectoryTree([string]$candidate, [string]$parent, [string]$expectedName) {
    Assert-ExactChildPath $candidate $parent $expectedName
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { return }

    $emptyName = "$expectedName.cleanup-empty"
    $emptyPath = [IO.Path]::GetFullPath((Join-Path $parent $emptyName)).TrimEnd('\')
    Assert-ExactChildPath $emptyPath $parent $emptyName
    if (Test-Path -LiteralPath $emptyPath) { Remove-Item -LiteralPath $emptyPath -Recurse -Force }
    New-Item -ItemType Directory -Path $emptyPath -Force | Out-Null
    try {
        $null = & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $emptyPath $candidate /MIR /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
        $robocopyExit = $LASTEXITCODE
        if ($robocopyExit -ge 8) { throw "Long-path cleanup failed with robocopy exit code ${robocopyExit}: $candidate" }
        Remove-Item -LiteralPath $candidate -Force
    } finally {
        if (Test-Path -LiteralPath $emptyPath) { Remove-Item -LiteralPath $emptyPath -Recurse -Force }
    }
}

Assert-ExactChildPath $stagePath $distRoot $stageName
Assert-ExactChildPath $zipPath $distRoot "$stageName.zip"
Assert-ExactChildPath $checksumPath $distRoot "$stageName.zip.sha256"
Assert-ExactChildPath $runtimeExtractPath $distRoot $runtimeExtractName

$exePath = Join-Path $workspace 'DeepSeek Harness.exe'
$packagePath = Join-Path $workspace 'package.json'
$lockPath = Join-Path $workspace 'pnpm-lock.yaml'
$workspaceConfigPath = Join-Path $workspace 'pnpm-workspace.yaml'
$integrationPath = Join-Path $workspace 'launcher-integration'
$integrationPackagePath = Join-Path $integrationPath 'dsh-launcher-update-ui'
$integrationRequired = @(
    (Join-Path $integrationPath 'cordis.patch.yml'),
    (Join-Path $integrationPackagePath 'package.json'),
    (Join-Path $integrationPackagePath 'lib\index.js'),
    (Join-Path $integrationPackagePath 'lib\client.js')
)
foreach ($required in @($exePath, $packagePath, $lockPath, $workspaceConfigPath, $RuntimeArchive) + $integrationRequired) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing build input: $required" }
}

$exeVersion = (Get-Item -LiteralPath $exePath).VersionInfo.FileVersion
if ($exeVersion -ne "$Version.0") { throw "EXE version $exeVersion does not match release $Version" }
$launcherBuildInputs = @(
    (Join-Path $workspace 'launcher\DeepSeekHarnessLauncher.cpp'),
    (Join-Path $workspace 'launcher\DeepSeekHarnessLauncher.rc'),
    (Join-Path $workspace 'launcher\DeepSeekHarnessLauncher.manifest'),
    (Join-Path $workspace 'launcher\resource.h'),
    (Join-Path $workspace 'launcher\updater.mjs'),
    (Join-Path $workspace 'launcher\self_update.cpp'),
    (Join-Path $workspace 'launcher\self_update.h')
) + $integrationRequired
$newestLauncherInput = $launcherBuildInputs | Get-Item | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$exeItem = Get-Item -LiteralPath $exePath
if ($exeItem.LastWriteTimeUtc -lt $newestLauncherInput.LastWriteTimeUtc) {
    throw "Launcher EXE is older than build input: $($newestLauncherInput.FullName)"
}
$exeBytes = [IO.File]::ReadAllBytes($exePath)
$exeUtf8 = [Text.Encoding]::UTF8.GetString($exeBytes)
$exeUtf16 = [Text.Encoding]::Unicode.GetString($exeBytes)
foreach ($requiredMarker in @('registerHooks', '@themis4226/dsh-launcher-update-ui')) {
    if (-not $exeUtf8.Contains($requiredMarker)) { throw "Launcher EXE is missing marker: $requiredMarker" }
}
foreach ($requiredMarker in @('DSH_LAUNCHER_INTEGRATION_ROOT', 'dsh-launcher:v1:update.check')) {
    if (-not $exeUtf16.Contains($requiredMarker)) { throw "Launcher EXE is missing marker: $requiredMarker" }
}
$forbiddenMarkers = @(
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5biu5Yqp')),
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5peg5rOV5YeG5aSH5qGM6Z2i5ZCv5Yqo5Zmo6K6+572u6ZuG5oiQ44CC'))
)
foreach ($forbiddenMarker in $forbiddenMarkers) {
    if ($exeUtf16.Contains($forbiddenMarker)) { throw "Launcher EXE still contains removed marker: $forbiddenMarker" }
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Remove-VerifiedDirectoryTree $stagePath $distRoot $stageName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
Remove-VerifiedDirectoryTree $runtimeExtractPath $distRoot $runtimeExtractName
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null

Copy-Item -LiteralPath $exePath -Destination $stagePath
Copy-Item -LiteralPath $packagePath -Destination $stagePath
Copy-Item -LiteralPath $lockPath -Destination $stagePath
Copy-Item -LiteralPath $workspaceConfigPath -Destination $stagePath
Copy-Item -LiteralPath (Join-Path $packagingRoot 'README-LITE.md') -Destination (Join-Path $stagePath 'README.md')
Copy-Item -LiteralPath (Join-Path $packagingRoot 'PUBLIC-RELEASE-NOTICE.md') -Destination $stagePath
Copy-Item -LiteralPath (Join-Path $workspace 'THIRD_PARTY_NOTICES.md') -Destination $stagePath

$nodeCommand = if ([IO.Path]::IsPathRooted($NodeExecutable)) {
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        throw "Node executable does not exist: $NodeExecutable"
    }
    [IO.Path]::GetFullPath($NodeExecutable)
} else {
    (Get-Command $NodeExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
& $nodeCommand (Join-Path $packagingRoot 'verify-runtime-package.mjs') `
    --archive $RuntimeArchive --version $DshVersion --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Runtime archive verification failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Path $runtimeExtractPath -Force | Out-Null
& 'C:\Windows\System32\tar.exe' -xf $RuntimeArchive -C $runtimeExtractPath
if ($LASTEXITCODE -ne 0) { throw "Runtime extraction failed with exit code $LASTEXITCODE" }
$runtimeNodeModules = Join-Path $runtimeExtractPath 'runtime\node_modules'
if (-not (Test-Path -LiteralPath $runtimeNodeModules -PathType Container)) {
    throw 'Verified runtime archive did not extract node_modules.'
}
Move-Item -LiteralPath $runtimeNodeModules -Destination (Join-Path $stagePath 'node_modules')
Remove-VerifiedDirectoryTree $runtimeExtractPath $distRoot $runtimeExtractName

$dshPackagePath = Join-Path $stagePath 'node_modules\@deepseek-ai\dsh\package.json'
$dshEntryPath = Join-Path $stagePath 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $dshEntryPath -PathType Leaf)) { throw 'DSH runtime entry is missing.' }
$dshPackage = Get-Content -LiteralPath $dshPackagePath -Encoding utf8 -Raw | ConvertFrom-Json
if ($dshPackage.version -ne $DshVersion) { throw "Unexpected DSH version: $($dshPackage.version)" }
$runtimeIntegrationPackage = Join-Path $stagePath 'node_modules\@themis4226\dsh-launcher-update-ui'
if (Test-Path -LiteralPath $runtimeIntegrationPackage) {
    throw 'Launcher integration must remain outside the immutable DSH runtime tree.'
}
$integrationPackage = Get-Content -LiteralPath (Join-Path $integrationPackagePath 'package.json') -Encoding utf8 -Raw | ConvertFrom-Json
if ($integrationPackage.name -ne '@themis4226/dsh-launcher-update-ui') {
    throw "Unexpected launcher integration package: $($integrationPackage.name)"
}

$webViewLicenseRoot = Join-Path $stagePath 'licenses\WebView2'
New-Item -ItemType Directory -Path $webViewLicenseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'launcher\vendor\webview2\LICENSE.txt') -Destination $webViewLicenseRoot
Copy-Item -LiteralPath (Join-Path $workspace 'launcher\vendor\webview2\NOTICE.txt') -Destination $webViewLicenseRoot
Copy-Item -LiteralPath (Join-Path $stagePath 'node_modules\@deepseek-ai\dsh\LICENSE') `
    -Destination (Join-Path $stagePath 'licenses\DeepSeek-Harness-LICENSE.txt')

& $nodeCommand (Join-Path $packagingRoot 'generate-license-inventory.mjs') $stagePath (Join-Path $stagePath 'licenses')
if ($LASTEXITCODE -ne 0) { throw "License inventory failed with exit code $LASTEXITCODE" }

$release = [ordered]@{
    product = 'DSH Desktop Launcher Lite'
    launcherVersion = "$Version.0"
    dshPackage = '@deepseek-ai/dsh'
    dshVersion = $dshPackage.version
    launcherIntegration = "$($integrationPackage.name)@$($integrationPackage.version)"
    platform = 'win32'
    architecture = 'x64'
    nodeBundled = $false
    requiredNode = 'x64 Node.js ^22.19.0 || >=24.0.0'
    updater = [ordered]@{
        channel = 'preview'
        manifest = 'https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/update.json'
        launcherManifest = 'https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/launcher-update.json'
        runtimeFormat = 'dsh-runtime-zip-v1'
        launcherFormat = 'portable-exe-v1'
    }
    generatedUtc = [DateTime]::UtcNow.ToString('o')
}
$release | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagePath 'RELEASE.json') -Encoding utf8

$sensitiveValues = @(
    $workspace,
    $env:USERPROFILE,
    $env:USERNAME,
    $nodeCommand
) | Where-Object { $_ }
$stageVerificationJson = & $nodeCommand (Join-Path $packagingRoot 'verify-lite-stage.mjs') $stagePath @sensitiveValues
if ($LASTEXITCODE -ne 0) { throw "Stage verification failed with exit code $LASTEXITCODE" }
$stageVerification = $stageVerificationJson | ConvertFrom-Json

Push-Location $distRoot
try {
    & 'C:\Windows\System32\tar.exe' -a -c -f $zipPath $stageName
    if ($LASTEXITCODE -ne 0) { throw "ZIP creation failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$entries = @(& 'C:\Windows\System32\tar.exe' -tf $zipPath)
if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) { throw 'ZIP table-of-contents verification failed.' }
$badEntries = @($entries | Where-Object {
    $_ -notlike "$stageName/*" -and $_ -ne "$stageName/"
})
if ($badEntries.Count -gt 0) { throw "ZIP contains entries outside the release root: $($badEntries[0])" }

$hash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
"$($hash.Hash) *$([IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $checksumPath -Encoding ascii

[pscustomobject]@{
    ZipPath = $zipPath
    ZipBytes = (Get-Item -LiteralPath $zipPath).Length
    Sha256 = $hash.Hash
    StageFiles = [int]$stageVerification.fileCount
    StageBytes = [long]$stageVerification.totalBytes
    DshVersion = $dshPackage.version
    ExeVersion = $exeVersion
} | Format-List

Remove-VerifiedDirectoryTree $stagePath $distRoot $stageName
