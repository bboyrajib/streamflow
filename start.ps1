# Torrent Streamer — Production Start Script (Windows PowerShell)
# Usage: powershell -ExecutionPolicy Bypass -File .\start.ps1
# Optional flags: -Port 8080  -SkipBuild
# Auto-installs Node.js via winget, choco, or direct MSI if not present.

param(
    [int]$Port = 9090,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$NodeVersion = "20"

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "       $msg" -ForegroundColor DarkGray }
function Write-Fail($msg) { Write-Host "   ERR $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH    = "$machinePath;$userPath"
}

function Install-NodeWindows {
    Write-Step "Installing Node.js $NodeVersion LTS"

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Using winget"
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        Refresh-Path
        return
    }

    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Using Chocolatey"
        choco install nodejs-lts -y
        Refresh-Path
        return
    }

    Write-Warn "winget and choco not found -- downloading Node.js MSI installer"
    $arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $indexUrl = "https://nodejs.org/dist/latest-v${NodeVersion}.x/"

    Write-Info "Resolving latest v$NodeVersion..."
    $html = (Invoke-WebRequest $indexUrl -UseBasicParsing).Content
    $match = [regex]::Match($html, "node-v(\d+\.\d+\.\d+)-win-${arch}\.msi")
    if (-not $match.Success) {
        Write-Fail "Could not resolve Node.js v$NodeVersion MSI. Install manually: https://nodejs.org"
    }

    $version = $match.Groups[1].Value
    $msiName = "node-v${version}-win-${arch}.msi"
    $msiUrl  = "https://nodejs.org/dist/v${version}/${msiName}"
    $tmpPath = Join-Path $env:TEMP $msiName

    Write-Info "Downloading $msiUrl"
    Invoke-WebRequest $msiUrl -OutFile $tmpPath -UseBasicParsing

    Write-Info "Running installer silently..."
    Start-Process msiexec.exe -ArgumentList "/i `"$tmpPath`" /quiet /norestart ADDLOCAL=ALL" -Wait -Verb RunAs
    Remove-Item $tmpPath -ErrorAction SilentlyContinue
    Refresh-Path
}

# ─────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Torrent Streamer" -ForegroundColor White
Write-Host "  Port : $Port" -ForegroundColor DarkGray
Write-Host ""

# 1. Node.js
Write-Step "Checking Node.js"
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-OK "Node $(node --version) already installed"
} else {
    Write-Warn "Node.js not found -- installing automatically"
    Install-NodeWindows
    Refresh-Path
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-OK "Node $(node --version) installed"
    } else {
        Write-Fail "Installation failed. Install manually: https://nodejs.org"
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "npm not found. Restart your terminal or reinstall Node.js."
}

# 2. Frontend
$FrontendDir = Join-Path $Root "frontend"
if (-not (Test-Path $FrontendDir)) {
    Write-Fail "frontend/ directory not found at $FrontendDir"
}

if (-not $SkipBuild) {
    Write-Step "Installing frontend dependencies"
    Push-Location $FrontendDir
    npm install --silent
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "npm install failed in frontend/" }
    Pop-Location
    Write-OK "frontend deps installed"

    Write-Step "Building frontend"
    Push-Location $FrontendDir
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "npm run build failed" }
    Pop-Location
    Write-OK "frontend built"

    Write-Step "Copying build to streamer/public/"
    $DistDir   = Join-Path $FrontendDir "dist"
    $PublicDir = Join-Path (Join-Path $Root "streamer") "public"
    if (-not (Test-Path $DistDir)) {
        Write-Fail "frontend/dist/ not found after build"
    }
    if (Test-Path $PublicDir) {
        Remove-Item $PublicDir -Recurse -Force
    }
    Copy-Item $DistDir $PublicDir -Recurse
    Write-OK "streamer/public/ ready"
} else {
    Write-Warn "Skipping frontend build (-SkipBuild)"
    $PublicDir = Join-Path (Join-Path $Root "streamer") "public"
    if (-not (Test-Path $PublicDir)) {
        Write-Warn "streamer/public/ not found -- UI may not load"
    }
}

# 3. Server deps
$StreamerDir = Join-Path $Root "streamer"
if (-not (Test-Path $StreamerDir)) {
    Write-Fail "streamer/ directory not found at $StreamerDir"
}

Write-Step "Installing server dependencies"
Push-Location $StreamerDir
npm install --omit=dev --silent
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "npm install failed in streamer/" }
Pop-Location
Write-OK "server deps installed"

# 4. Launch
Write-Step "Starting server"
Write-Host ""
Write-Host "  http://localhost:$Port" -ForegroundColor White
Write-Host ""

$env:PORT = $Port
Set-Location $StreamerDir
node server.js
