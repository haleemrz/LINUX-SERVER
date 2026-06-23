# Sync HALEEM credentials from Windows to Linux server
# This copies: config.json (admin token), RSA keys, licenses, and knowledge base
# so the Linux server uses the same credentials as the Windows desktop app.

$SRC = "$env:USERPROFILE\.haleem-server"
$LINUX_USER = "haleem"
$LINUX_HOST = "haleem-HP-Laptop-15-da1xxx"
$DEST = "/home/$LINUX_USER/.haleem-server"

Write-Host "🔄 Syncing credentials from Windows to Linux..." -ForegroundColor Cyan

# 1. Config (admin token, storage key)
Write-Host "📋 Copying config.json (admin token)..."
scp "$SRC\config.json" "${LINUX_USER}@${LINUX_HOST}:${DEST}/config.json"

# 2. RSA keys (for license signatures)
Write-Host "🔑 Copying RSA keys..."
scp "$SRC\rsa\private.pem" "${LINUX_USER}@${LINUX_HOST}:${DEST}/rsa/private.pem"
scp "$SRC\rsa\public.pem" "${LINUX_USER}@${LINUX_HOST}:${DEST}/rsa/public.pem"

# 3. Licenses database
Write-Host "📦 Copying licenses database..."
scp "$SRC\data\licenses.enc" "${LINUX_USER}@${LINUX_HOST}:${DEST}/data/licenses.enc"

# 4. Knowledge base
if (Test-Path "$SRC\wa_knowledge_base.json") {
    Write-Host "📚 Copying knowledge base..."
    scp "$SRC\wa_knowledge_base.json" "${LINUX_USER}@${LINUX_HOST}:${DEST}/wa_knowledge_base.json"
}

Write-Host ""
Write-Host "✅ Done! Now restart the Linux server:" -ForegroundColor Green
Write-Host "   ssh ${LINUX_USER}@${LINUX_HOST} 'sudo systemctl restart haleem-server'"
