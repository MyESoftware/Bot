#!/usr/bin/env bash
set -e

APP_DIR=${APP_DIR:-$HOME/bot-whatsapp-master-pro-v6}
PORT=${PORT:-3000}

sudo apt update
sudo apt install -y curl unzip nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

sudo npm install -g pm2

mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ ! -f package.json ]; then
  echo "Copiá primero los archivos del proyecto dentro de $APP_DIR"
  exit 1
fi

npm install

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Se creó .env. Editalo antes de seguir."
fi

pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME"

echo "Proyecto instalado."
echo "Ahora abrí el puerto $PORT en Oracle Cloud Security List o NSG y entrá a /qr"
