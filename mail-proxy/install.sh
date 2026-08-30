#!/usr/bin/env bash
# Install mail-proxy on a fresh Ubuntu machine. Run as root.
#
#   MAIL_PROXY_SECRET=<secret> ./install.sh
#
# Idempotent: safe to re-run to upgrade proxy.ts in place.
set -euo pipefail

: "${MAIL_PROXY_SECRET:?MAIL_PROXY_SECRET must be set}"
PORT="${MAIL_PROXY_LISTEN_PORT:-8443}"
DIR=/opt/mail-proxy

if ! command -v deno >/dev/null 2>&1; then
  echo "Installing Deno..."
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y
fi

id -u mailproxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin mailproxy
install -d -o mailproxy -g mailproxy "$DIR"
install -o mailproxy -g mailproxy -m 0644 "$(dirname "$0")/proxy.ts" "$DIR/proxy.ts"

# The secret lives in a root-only file rather than the unit, so it stays out of
# `systemctl cat` and out of the process table.
umask 077
cat > "$DIR/env" <<ENV
MAIL_PROXY_SECRET=${MAIL_PROXY_SECRET}
MAIL_PROXY_LISTEN_PORT=${PORT}
ENV
chown root:root "$DIR/env"
chmod 0600 "$DIR/env"

cat > /etc/systemd/system/mail-proxy.service <<UNIT
[Unit]
Description=MCP Emails mail proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mailproxy
EnvironmentFile=$DIR/env
ExecStart=/usr/local/bin/deno run --allow-net --allow-env $DIR/proxy.ts
Restart=always
RestartSec=2

# It forwards bytes between two sockets. It has no business doing anything else.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
SystemCallFilter=@system-service
ReadWritePaths=

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now mail-proxy
systemctl restart mail-proxy

if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT"/tcp || true
fi

sleep 1
systemctl --no-pager --lines=5 status mail-proxy
