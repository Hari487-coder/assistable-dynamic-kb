#!/usr/bin/env bash
# Live KB — one-command setup for a fresh Ubuntu VM (tested target: Oracle
# Cloud Always Free ARM A1). Installs Node 22, the app, a systemd service,
# and Caddy for automatic HTTPS.
#
# Usage (as a sudo-capable user on the fresh VM):
#   export KB_DOMAIN=kb.yourdomain.com   # DNS A record must point at this VM
#   export KB_REPO=https://github.com/YOUR_USER/assistable-dynamic-kb.git
#   curl -fsSL <raw-url-of-this-script> | bash
# Or clone first and run: KB_DOMAIN=... bash deploy/oracle-setup.sh
set -euo pipefail

KB_DOMAIN="${KB_DOMAIN:?Set KB_DOMAIN to your domain (DNS must point here)}"
KB_REPO="${KB_REPO:-}"
KB_DIR=/opt/live-kb

echo "==> Installing Node 22 + Caddy"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

echo "==> Installing the app to $KB_DIR"
if [ -n "$KB_REPO" ]; then
  sudo git clone "$KB_REPO" "$KB_DIR" || (cd "$KB_DIR" && sudo git pull)
else
  sudo mkdir -p "$KB_DIR"
  sudo cp -r "$(cd "$(dirname "$0")/.." && pwd)/." "$KB_DIR"
fi
cd "$KB_DIR" && sudo npm ci --omit=dev

echo "==> systemd service"
sudo tee /etc/systemd/system/live-kb.service > /dev/null <<EOF
[Unit]
Description=Live KB (Assistable dynamic knowledge base)
After=network.target
[Service]
WorkingDirectory=$KB_DIR
Environment=NODE_ENV=production PORT=3900 DATA_DIR=$KB_DIR/data SIGNUPS=first-only MOCK_ASSISTABLE=0 BASE_URL=https://$KB_DOMAIN
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
User=root
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now live-kb

echo "==> Caddy reverse proxy with automatic HTTPS for $KB_DOMAIN"
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
$KB_DOMAIN {
    reverse_proxy 127.0.0.1:3900
}
EOF
sudo systemctl reload caddy

echo "==> Done. Open https://$KB_DOMAIN and create the owner account."
echo "    (Oracle note: open ports 80/443 in the VCN security list AND ufw.)"
