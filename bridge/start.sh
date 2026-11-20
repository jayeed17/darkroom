#!/usr/bin/env bash
# Darkroom bridge
#   ./start.sh <SHOOT_KEY>                       start for a shoot (key is on the shoot's Camera tab)
#   ./start.sh <SHOOT_KEY> /Volumes/SSD/Darkroom save originals to your SSD
#   ./start.sh                                   reuse the last shoot key
set -e
cd "$(dirname "$0")"
if [ -n "$1" ]; then echo "$1" > .shoot-key; fi
[ -f .shoot-key ] && export DARKROOM_KEY="$(cat .shoot-key)"
[ -n "$2" ] && export DARKROOM_LIBRARY="$2"
if [ ! -d .venv ]; then
  echo "  First run: installing (about a minute)…"
  python3 -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements.txt
fi
# Free the ports if an old bridge is still running
lsof -ti :2121 -ti :47474 2>/dev/null | xargs kill 2>/dev/null || true
exec .venv/bin/python bridge.py
