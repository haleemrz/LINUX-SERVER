#!/bin/bash
set -e
# HALEEM Activation Server Installer for Ubuntu 24.04
# Run with sudo: sudo ./install.sh

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root (sudo ./install.sh)"
  exit 1
fi

# Get the actual user who ran sudo
ACTUAL_USER=${SUDO_USER:-$USER}
ACTUAL_HOME=$(eval echo ~$ACTUAL_USER)

echo "🚀 Installing HALEEM Activation Server for user: $ACTUAL_USER ($ACTUAL_HOME)..."

# 1. Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "📦 Node.js not found. Installing..."
    # Install Node.js 20 from NodeSource on Ubuntu
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "✅ Node.js version: $(node -v)"

# Install Puppeteer/Chromium headless system libraries
echo "📦 Installing headless Chromium libraries for WhatsAppBot..."
apt-get update
apt-get install -y --no-install-recommends libgbm1 libasound2t64 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 libnss3 libxss1

# 2. Create target directory
INSTALL_DIR="/opt/haleem-server"
echo "📂 Creating install directory: $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r ./* "$INSTALL_DIR/"
# Exclude installer script from copying inside the target
rm -f "$INSTALL_DIR/install.sh"
chown -R "$ACTUAL_USER":"$ACTUAL_USER" "$INSTALL_DIR"

# Install production node modules
echo "📦 Installing Node.js dependencies..."
cd "$INSTALL_DIR"
sudo -u "$ACTUAL_USER" npm install --production
cd - > /dev/null

# 3. Create Systemd Service File
SERVICE_FILE="/etc/systemd/system/haleem-server.service"
echo "⚙️ Creating systemd service: $SERVICE_FILE..."
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=HALEEM Activation Server Background Daemon
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$INSTALL_DIR
Environment=HALEEM_PORT=9847 HALEEM_BIND=0.0.0.0 HALEEM_DATA=$ACTUAL_HOME/.haleem-server
ExecStart=/usr/bin/node $INSTALL_DIR/server/server.js
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

# 4. Enable and start Systemd Service
echo "🔄 Reloading systemd daemon..."
systemctl daemon-reload
echo "🟢 Enabling haleem-server service..."
systemctl enable haleem-server.service
echo "▶️ Restarting haleem-server service..."
systemctl restart haleem-server.service

# 5. Open ports in UFW if enabled
if command -v ufw &> /dev/null; then
    echo "🛡️ Configuring Firewall (UFW)..."
    ufw allow 9847/tcp comment 'HALEEM HTTPS' || true
    ufw allow 9848/tcp comment 'HALEEM HTTP' || true
    ufw reload || true
fi

echo "✅ HALEEM Activation Server installed successfully and is running in the background!"
echo "To check status: sudo systemctl status haleem-server"
echo "To view logs: sudo journalctl -u haleem-server -n 50 --no-pager"
