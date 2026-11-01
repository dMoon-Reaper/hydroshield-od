#!/usr/bin/env bash
set -e
echo "=========================================================="
echo "  HydroShield OD - Urban Flood Intelligence Command Portal"
echo "=========================================================="

if [ ! -d ".venv" ]; then
  echo "[1/4] Creating Python virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate
echo "[2/4] Installing Python dependencies..."
pip install -r backend/requirements.txt

if [ ! -f "backend/models/severity_model.joblib" ]; then
  echo "[3/4] Generating spatial graphs and training Random Forest model..."
  python backend/simulate_and_train.py --area bhubaneswar
else
  echo "[3/4] Pre-trained model and GIS data found."
fi

if [ ! -d "node_modules" ]; then
  echo "[3.5/4] Installing frontend npm packages..."
  npm install
fi

export PROJECT_BRAND_NAME="HydroShield OD"
export NFC_HMAC_SECRET="hydroshield-od-secret-2026"

echo "[4/4] Starting Backend on http://127.0.0.1:8000 and Frontend on http://localhost:5173 ..."
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!
trap "kill $BACKEND_PID 2>/dev/null || true" EXIT
npm run dev
