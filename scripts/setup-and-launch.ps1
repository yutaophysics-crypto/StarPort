param([switch]$NoOpen, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$StarportRoot = Split-Path -Parent $PSScriptRoot

try {
    $StarportNode = (Get-Command node.exe -ErrorAction Stop).Source
    $StarportVersion = (& $StarportNode --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $StarportVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw 'StarPort requires Node.js 24 or newer. Install it from https://nodejs.org/ and reopen this launcher.'
    }
    $StarportVendor = Join-Path $StarportRoot 'public\vendor'
    foreach ($StarportAsset in @('marked.min.js', 'katex.min.js', 'katex.min.css', 'fonts\archivo-latin-var.woff2')) {
        if (-not (Test-Path -LiteralPath (Join-Path $StarportVendor $StarportAsset) -PathType Leaf)) {
            throw 'Required UI assets are missing. Download the complete StarPort repository and extract the ZIP before starting.'
        }
    }
    $StarportLockHash = (Get-FileHash -LiteralPath (Join-Path $StarportRoot 'package-lock.json') -Algorithm SHA256).Hash
    $StarportStamp = Join-Path $StarportRoot '.data\dependencies.sha256'
    $StarportReady = (Test-Path -LiteralPath $StarportStamp) -and ((Get-Content -LiteralPath $StarportStamp -Raw).Trim() -eq $StarportLockHash)
    foreach ($StarportDependency in @('@anthropic-ai\claude-agent-sdk', 'dompurify', 'zod')) {
        if (-not (Test-Path -LiteralPath (Join-Path $StarportRoot ('node_modules\' + $StarportDependency + '\package.json')))) {
            $StarportReady = $false
        }
    }
    if ($CheckOnly) {
        if (-not $StarportReady) { throw 'Dependencies need installation. Run Start StarPort.cmd without -CheckOnly once.' }
        Write-Output "StarPort is ready ($StarportVersion)."
        exit 0
    }
    Push-Location -LiteralPath $StarportRoot
    try {
        if (-not $StarportReady) {
            $StarportNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
            Write-Output 'Installing the pinned StarPort dependencies...'
            & $StarportNpm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the network connection and retry.' }
            [System.IO.Directory]::CreateDirectory((Split-Path -Parent $StarportStamp)) | Out-Null
            [System.IO.File]::WriteAllText($StarportStamp, $StarportLockHash)
        }
        if ($NoOpen) { & $StarportNode (Join-Path $PSScriptRoot 'launch.mjs') --no-open }
        else { & $StarportNode (Join-Path $PSScriptRoot 'launch.mjs') }
        if ($LASTEXITCODE -ne 0) { throw 'StarPort failed to launch. See .data/server.log for details.' }
    } finally { Pop-Location }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
