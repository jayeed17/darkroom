#!/usr/bin/env bash
# Starts the built app headless, sends it a photo over FTP like a camera, checks it was developed.
set -euo pipefail
APP="$1"; T=$(mktemp -d)
export DARKROOM_STATE="$T/state" DARKROOM_LIBRARY="$T/lib" DARKROOM_NO_BROWSER=1 DARKROOM_CONSOLE=1 DARKROOM_WEB_PORT=47999 DARKROOM_FTP_PORT=2999 DARKROOM_KEY=smoketest0123 DARKROOM_API=http://127.0.0.1:9
"$APP/Contents/MacOS/Darkroom Bridge" > "$T/out.log" 2>&1 & PID=$!
for i in $(seq 1 60); do curl -fs http://127.0.0.1:47999/status.json >/dev/null && break; sleep 0.5; done
curl -fs http://127.0.0.1:47999/status.json && echo
python3 -c "from PIL import Image; Image.new('RGB',(1200,800),(200,40,40)).save('$T/DSC00001.JPG')"
curl -fsS -T "$T/DSC00001.JPG" "ftp://sony:darkroom@127.0.0.1:2999/"
sleep 4
curl -fs http://127.0.0.1:47999/ | grep -o "[0-9]* photos<span>received" || true
ls -R "$T/lib" | head
test -n "$(find "$T/lib" -name DSC00001.JPG)" && echo "SMOKE: photo received and filed: ok" || { echo "SMOKE FAILED"; cat "$T/out.log"; kill $PID; exit 1; }
test -n "$(find "$T/state/.cache" -name 'DSC00001.thumb.jpg')" && echo "SMOKE: thumbnail developed: ok" || { echo "SMOKE FAILED (no thumbnail)"; cat "$T/out.log"; kill $PID; exit 1; }
grep -q Traceback "$T/out.log" && { echo "SMOKE: traceback in log"; cat "$T/out.log"; kill $PID; exit 1; } || true
kill $PID; echo "SMOKE: ok"
