# ============================================================
# deploy.ps1 — runs ON the IIS server (called over SSH).
# Back up current release -> deploy new -> health check ->
# roll back automatically if the health check fails.
#
# Usage (done by the pipeline):
#   powershell -ExecutionPolicy Bypass -File deploy.ps1 -Environment production
# ============================================================
param(
    [string]$Environment = "development",
    [string]$Incoming    = "C:\deploy-incoming"
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

# ---- Config (must match what you created in SERVER_SETUP.md) ----
$apiPool   = "SimpleWebApp-Api"
$apiPath   = "C:\inetpub\api"
$apiHealth = "http://localhost:8080/health"

$webPool   = "SimpleWebApp-Web"
$webPath   = "C:\inetpub\web"
$webHealth = "http://localhost/"

$backupRoot = "C:\deploy-backups"
$stamp      = Get-Date -Format 'yyyyMMdd_HHmmss'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

# ---- Helpers ----
function Backup-Site($path, $name) {
    if ((Test-Path $path) -and (Get-ChildItem $path -Force | Select-Object -First 1)) {
        $b = Join-Path $backupRoot "${name}_$stamp"
        Copy-Item $path $b -Recurse -Force
        Write-Host "Backed up $name -> $b"
        return $b
    }
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    Write-Host "No existing $name release (first deploy)."
    return $null
}

function Deploy-Zip($zip, $path) {
    $tmp = Join-Path $env:TEMP ("ex_" + [guid]::NewGuid())
    Expand-Archive $zip $tmp -Force
    if (Test-Path $path) { Get-ChildItem $path -Force | Remove-Item -Recurse -Force }
    Copy-Item (Join-Path $tmp '*') $path -Recurse -Force
    Remove-Item $tmp -Recurse -Force
}

function Restore-Site($backup, $path) {
    if ($backup) {
        Get-ChildItem $path -Force | Remove-Item -Recurse -Force
        Copy-Item (Join-Path $backup '*') $path -Recurse -Force
        Write-Host "Restored $path from $backup"
    }
}

function Test-Health($url) {
    Start-Sleep -Seconds 5
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
    if ($r.StatusCode -ne 200) { throw "Health check $url returned $($r.StatusCode)" }
    Write-Host "Healthy: $url (200)"
}

# ---- Deploy ----
Write-Host "=== Deploying ($Environment) ==="
$apiBackup = Backup-Site $apiPath "api"
$webBackup = Backup-Site $webPath "web"

try {
    Stop-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Stop-WebAppPool $webPool -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2   # let file locks release

    Deploy-Zip (Join-Path $Incoming 'api.zip') $apiPath
    Deploy-Zip (Join-Path $Incoming 'web.zip') $webPath

    Start-WebAppPool $apiPool
    Start-WebAppPool $webPool

    Test-Health $apiHealth
    Test-Health $webHealth

    Write-Host "=== SUCCESS: deploy healthy ($Environment) ==="
}
catch {
    Write-Warning "DEPLOY FAILED: $($_.Exception.Message)"
    Write-Warning "Rolling back to the previous release..."
    Stop-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Stop-WebAppPool $webPool -ErrorAction SilentlyContinue
    Restore-Site $apiBackup $apiPath
    Restore-Site $webBackup $webPath
    Start-WebAppPool $apiPool -ErrorAction SilentlyContinue
    Start-WebAppPool $webPool -ErrorAction SilentlyContinue
    Write-Host "=== ROLLED BACK. Site restored to previous release. ==="
    exit 1
}
