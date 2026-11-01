#!/usr/bin/env python3
"""
backend/nfc_bridge.py  -  USB NFC reader -> signed HTTP events
==============================================================
Reads the UID of NTAG213 tags through a PC/SC reader (ACS ACR1552U, ACR122U or any
13.56 MHz PC/SC reader) and POSTs each tap to the FastAPI backend with an
HMAC-SHA256 signature in the `X-Signature` header.

Setup (Windows / Linux / macOS):
    pip install pyscard
    set NFC_HMAC_SECRET=<same value you gave the server>      (Windows cmd)
    export NFC_HMAC_SECRET=<same value>                       (Linux / macOS)

Usage:
    python backend/nfc_bridge.py --list-readers
    python backend/nfc_bridge.py --enroll DR-01     # tap the sticker you glued on node DR-01
    python backend/nfc_bridge.py --enroll DR-02     # ... repeat for DR-03, DR-04, DR-05
    python backend/nfc_bridge.py                    # normal run: every tap -> /api/nfc-scan
    python backend/nfc_bridge.py --uid 04A1B2C3D4E5F6   # send one signed scan with no hardware (test)

Signature = HMAC-SHA256(secret, raw_request_body) as lowercase hex.
Body fields: uid, ts (epoch seconds), nonce (unique per request), reader_id.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    from smartcard.System import readers as pcsc_readers
    from smartcard.Exceptions import CardConnectionException, NoCardException
except ImportError:  # allows --uid testing without pyscard
    pcsc_readers = None

GET_UID_APDU = [0xFF, 0xCA, 0x00, 0x00, 0x00]     # PC/SC "Get Data: UID" (works on ACS readers)
DEBOUNCE_S = 3.0                                  # same UID within this window is ignored
POLL_S = 0.25


def sign(secret: bytes, body: bytes) -> str:
    return hmac.new(secret, body, hashlib.sha256).hexdigest()


def post_signed(url: str, payload: dict, secret: bytes) -> tuple[int, str]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Signature": sign(secret, body)})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except urllib.error.URLError as e:
        return 0, f"backend unreachable: {e.reason}"


def make_payload(uid: str, reader_id: str, **extra) -> dict:
    return {"uid": uid.upper(), "ts": time.time(), "nonce": uuid.uuid4().hex, "reader_id": reader_id, **extra}


def read_uid(reader) -> str | None:
    """Return the UID of the tag currently on the reader as an upper-case hex string, or None."""
    conn = reader.createConnection()
    try:
        conn.connect()
        data, sw1, sw2 = conn.transmit(GET_UID_APDU)
        if (sw1, sw2) == (0x90, 0x00) and data:
            return "".join(f"{b:02X}" for b in data)
    except (NoCardException, CardConnectionException):
        return None
    except Exception:
        return None
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return None


def pick_reader(name_filter: str | None):
    if pcsc_readers is None:
        sys.exit("pyscard is not installed. Run: pip install pyscard")
    found = pcsc_readers()
    if name_filter:
        found = [r for r in found if name_filter.lower() in str(r).lower()]
    # prefer the contactless interface (PICC) when the reader exposes several
    found.sort(key=lambda r: 0 if ("picc" in str(r).lower() or "contactless" in str(r).lower() or "pn53" in str(r).lower()) else 1)
    return found[0] if found else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default=os.getenv("FLOOD_API", "http://127.0.0.1:8000"))
    ap.add_argument("--reader", help="substring of the PC/SC reader name (default: first contactless reader)")
    ap.add_argument("--reader-id", default=os.getenv("COMPUTERNAME", "usb-reader-1"))
    ap.add_argument("--enroll", metavar="DRAIN_ID", help="bind the next tapped tag to this drain asset (e.g. DR-01), then exit")
    ap.add_argument("--uid", help="send one signed scan/enrol with this UID instead of reading hardware (testing)")
    ap.add_argument("--list-readers", action="store_true")
    args = ap.parse_args()

    secret = os.getenv("NFC_HMAC_SECRET", "dev-secret-change-me").encode()
    if secret == b"dev-secret-change-me":
        print("WARNING: NFC_HMAC_SECRET not set - using the insecure development secret.")

    if args.list_readers:
        if pcsc_readers is None:
            sys.exit("pyscard is not installed. Run: pip install pyscard")
        rs = pcsc_readers()
        print("\n".join(f"[{i}] {r}" for i, r in enumerate(rs)) or "No PC/SC readers found. Is the driver installed and the reader plugged in?")
        return

    scan_url, enroll_url = f"{args.server}/api/nfc-scan", f"{args.server}/api/nfc-enroll"

    def send(uid: str):
        if args.enroll:
            code, text = post_signed(enroll_url, make_payload(uid, args.reader_id, drain_id=args.enroll), secret)
        else:
            code, text = post_signed(scan_url, make_payload(uid, args.reader_id), secret)
        print(f"[{time.strftime('%H:%M:%S')}] UID {uid} -> HTTP {code} {text[:160]}")
        return code

    if args.uid:
        sys.exit(0 if send(args.uid) in (200, 201) else 1)

    reader = pick_reader(args.reader)
    if reader is None:
        sys.exit("No PC/SC reader found. Plug in the reader / install its driver (try --list-readers).")
    print(f"Using reader: {reader}")
    print(f"Enrolling next tag as {args.enroll} ..." if args.enroll else "Listening for taps (Ctrl+C to stop) ...")

    current, last_sent = None, {}
    try:
        while True:
            uid = read_uid(reader)
            if uid is None:
                current = None                     # tag removed -> next tap counts as a new tap
            elif uid != current:
                current = uid
                if time.time() - last_sent.get(uid, 0) >= DEBOUNCE_S:
                    last_sent[uid] = time.time()
                    code = send(uid)
                    if args.enroll:
                        sys.exit(0 if code == 200 else 1)
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        print("\nBridge stopped.")


if __name__ == "__main__":
    main()
