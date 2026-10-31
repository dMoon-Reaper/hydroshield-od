@echo off
title HydroShield OD - Full Stack Launcher
echo ==========================================================
echo   HydroShield OD - Urban Flood Intelligence Command Portal
echo ==========================================================

if not exist ".venv" (
    echo [1/4] Creating Python virtual environment...
    python -m venv .venv
)

echo [2/4] Activating virtual environment and checking Python packages...
call .venv\Scripts\activate.bat
pip install -r backend\requirements.txt

if not exist "backend\models\severity_model.joblib" (
    echo [3/4] Generating spatial graphs and training Random Forest model...
    python backend\simulate_and_train.py --area bhubaneswar
) else (
    echo [3/4] Pre-trained model and GIS data found in backend/data and backend/models.
)

if not exist "node_modules" (
    echo [3.5/4] Installing frontend npm dependencies...
    call npm install
)

echo [4/4] Starting Backend (Uvicorn on :8000) and Frontend (Vite on :5173)...
set PROJECT_BRAND_NAME=HydroShield OD
set NFC_HMAC_SECRET=hydroshield-od-secret-2026
start "HydroShield OD Backend" cmd /k "call .venv\Scripts\activate.bat && set PROJECT_BRAND_NAME=HydroShield OD && set NFC_HMAC_SECRET=hydroshield-od-secret-2026 && uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000"
start "HydroShield OD Frontend" cmd /k "npm run dev"

echo.
echo Both servers are launching in separate windows!
echo -> Frontend Web Portal: http://localhost:5173
echo -> Backend API Docs:    http://127.0.0.1:8000/docs
pause
