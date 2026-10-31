# HydroShield OD — Odisha Urban Flood Intelligence & Command Portal

Predicting Impact. Protecting Lifelines.

## What's Included in This Ready-to-Run Package
- **Complete Rebranding**: Rebranded everywhere to **HydroShield OD**.
- **Hero Video Configured**: Your custom 3D animation video is already placed at `public/media/hero-monsoon.mp4` and configured to loop on the main landing page (with an **Unmute Audio** button in the top navigation bar).
- **Pre-Built GIS Data & Trained ML Model**: `backend/data/*` and `backend/models/*` are already pre-generated for Bhubaneswar (Nayapalli / ISKCON NH-16), so Uvicorn can start immediately.
- **Bug Fixes Applied**:
  - Fixed work-order "Mark Cleared" duplicate ticket respawn in `backend/main.py`.
  - Added thread-safety locking around shared state in `_scan_payload` and `decide`.
  - Sanitized CSV export filenames (`hydroshield_od_audit_log_*.csv`).
  - Improved HTML5 `<video>` visibility (`opacity-55`), error handling, and audio toggle in `src/pages/LandingShowcase.tsx`.

---

## Quick Start (One-Click Run)

### Option A: Windows (One-Click)
Double-click **`start_windows.bat`** or run in Command Prompt / PowerShell:
```cmd
start_windows.bat
```

### Option B: macOS / Linux (One-Click)
```bash
./start_unix.sh
```

---

## Manual Step-by-Step Run (Two Terminals)

### Terminal 1 — FastAPI Backend (Uvicorn)
```bash
python -m venv .venv
# Activate venv:
#   Windows PowerShell: .\.venv\Scripts\Activate.ps1
#   Windows CMD:        .venv\Scripts\activate.bat
#   macOS/Linux:        source .venv/bin/activate

pip install -r backend/requirements.txt

# (Optional) Regenerate data/model or switch study area (bhubaneswar | cuttack):
python backend/simulate_and_train.py --area bhubaneswar

# Start Uvicorn server:
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

### Terminal 2 — React + Vite Frontend
```bash
npm install
npm run dev
```
Then open **http://localhost:5173** in your browser.
