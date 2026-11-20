#!/usr/bin/env bash
# Builds "Darkroom Bridge.app" and a .dmg for this Mac's architecture, then smoke-tests the app.
#   bridge/macos/build.sh <AppleSilicon|Intel>
set -euo pipefail
FLAVOR="$1"; cd "$(dirname "$0")"
python3 -m pip install -q --upgrade pip
python3 -m pip install -q -r ../requirements.txt "rumps==0.4.0" "pyinstaller==6.*"
python3 make_icon.py Darkroom.iconset && iconutil -c icns Darkroom.iconset -o Darkroom.icns
python3 -m PyInstaller --noconfirm --clean --distpath dist --workpath build "Darkroom Bridge.spec"
APP="dist/Darkroom Bridge.app"
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP" && echo "codesign: ok (ad-hoc)"
echo "arch: $(lipo -archs "$APP/Contents/MacOS/Darkroom Bridge")"
echo "size: $(du -sh "$APP" | cut -f1)"
# Oldest macOS this build runs on = the highest minimum OS of any bundled binary
MINOS=$(find "$APP" -type f \( -name "*.so" -o -name "*.dylib" -o -perm -111 \) -print0 \
  | xargs -0 -n1 sh -c 'otool -l "$0" 2>/dev/null | awk "/LC_BUILD_VERSION/{f=1} f&&/minos/{print \$2; f=0}"' 2>/dev/null \
  | sort -t. -k1,1n -k2,2n | tail -1)
echo "minimum macOS: ${MINOS:-unknown}"
echo "$MINOS" > minos.txt
./smoke.sh "$APP"
mkdir -p dmg && rm -rf dmg/* && cp -R "$APP" dmg/ && ln -s /Applications dmg/Applications
hdiutil create -volname "Darkroom Bridge" -srcfolder dmg -ov -format UDZO "Darkroom-Bridge-$FLAVOR.dmg"
echo "built Darkroom-Bridge-$FLAVOR.dmg"
