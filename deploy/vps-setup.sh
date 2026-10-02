#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  EVM-LOAN-TOOLKIT: Setup VPS untuk LLM Operator & Executor"
echo "============================================================"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${REPO_DIR}/tools"

if ! command -v node >/dev/null 2>&1; then
  echo "[1/4] Menginstal Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/4] Node.js terdeteksi: $(node --version)"
fi

echo "[2/4] Menginstal dependencies di tools/..."
cd "${TOOLS_DIR}"
npm ci

if [ ! -f "${TOOLS_DIR}/.env" ]; then
  echo "[3/4] Membuat file tools/.env dari template..."
  cp "${TOOLS_DIR}/.env.example" "${TOOLS_DIR}/.env"
  chmod 600 "${TOOLS_DIR}/.env"
  echo "PENTING: Edit ${TOOLS_DIR}/.env dan isi PRIVATE_KEY, RPC_URL, serta LLM_API_KEY Anda."
else
  chmod 600 "${TOOLS_DIR}/.env"
  echo "[3/4] File tools/.env sudah ada dan diamankan (chmod 600)."
fi

echo "[4/4] Menjalankan typecheck & unit test..."
npm run build
npm test

echo ""
echo "Setup VPS selesai! Cara menjalankan operator:"
echo "  1. Mode CLI Langsung : cd tools && npm run watch"
echo "  2. Mode PM2 Daemon   : npx pm2 start deploy/ecosystem.config.cjs && npx pm2 save"
echo "  3. Mode Docker       : docker compose up -d --build"
echo "  4. Mode Systemd      : sudo cp deploy/morpho-llm-operator.service /etc/systemd/system/"
