# HALEEM Server - Windows to Linux Sync Script
# This script copies your database, config, and WhatsApp login session from Windows to Linux.
# Run this inside PowerShell on your Windows machine.

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "          HALEEM SERVER DATA SYNC (WINDOWS -> LINUX)      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Get Linux Connection Details
$linuxHost = Read-Host "Enter Linux Server IP (e.g. 192.168.1.15) or Hostname"
if ([string]::IsNullOrWhiteSpace($linuxHost)) {
    Write-Error "Linux Server IP/Hostname is required."
}

$linuxUser = Read-Host "Enter Linux Username [default: haleem]"
if ([string]::IsNullOrWhiteSpace($linuxUser)) {
    $linuxUser = "haleem"
}

# Source Data Directory on Windows
$winDataDir = "$env:USERPROFILE\.haleem-server"

if (-not (Test-Path $winDataDir)) {
    Write-Error "HALEEM data directory not found on Windows at: $winDataDir`nPlease run the desktop server at least once."
}

$sshTarget = "$linuxUser@$linuxHost"

Write-Host ""
Write-Host "[CONN] Connecting to Linux Server ($linuxUser on $linuxHost) to stop background daemon..." -ForegroundColor Yellow

# 2. Stop Service on Linux (to release database/session files)
try {
    ssh -o ConnectTimeout=5 $sshTarget "sudo systemctl stop haleem-server"
    Write-Host "[OK] HALEEM Server daemon stopped on Linux." -ForegroundColor Green
} catch {
    Write-Host "[WARN] Could not stop service (maybe not installed yet or authentication failed)." -ForegroundColor Yellow
}

# 3. Create Target Directory on Linux
Write-Host "[DIR] Creating data directory on Linux (~/.haleem-server)..." -ForegroundColor Yellow
ssh $sshTarget "mkdir -p ~/.haleem-server"

# 4. Copy data using SCP
Write-Host "[SYNC] Syncing licenses, SSL keys, and WhatsApp sessions (this might take a minute)..." -ForegroundColor Yellow
# Using scp -r to recursively copy all files
scp -r "$winDataDir\*" "${sshTarget}:~/.haleem-server/"

# 5. Fix permissions on Linux (make sure the user owns their copied files)
Write-Host "[PERM] Adjusting file permissions on Linux..." -ForegroundColor Yellow
ssh $sshTarget "chown -R ${linuxUser}:${linuxUser} ~/.haleem-server"

# 6. Start Service on Linux
Write-Host "[START] Starting background HALEEM Server daemon on Linux..." -ForegroundColor Yellow
ssh $sshTarget "sudo systemctl start haleem-server"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "[SUCCESS] Data and WhatsApp Session successfully synced to Linux!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
