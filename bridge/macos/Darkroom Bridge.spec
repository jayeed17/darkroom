# PyInstaller spec for the Mac app. Built by .github/workflows/bridge-mac.yml (bridge/macos/build.sh).
import os, re
from PyInstaller.utils.hooks import collect_all
B = os.path.abspath(os.path.join(SPECPATH, ".."))
VERSION = re.search(r'VERSION = "([^"]+)"', open(os.path.join(B, "bridge.py")).read()).group(1)
datas, binaries, hidden = [(os.path.join(B, "config.json"), ".")], [], ["rumps"]
for m in ("rawpy", "pillow_heif"):
    d, b, h = collect_all(m); datas += d; binaries += b; hidden += h
a = Analysis([os.path.join(B, "bridge.py")], pathex=[B], datas=datas, binaries=binaries, hiddenimports=hidden,
             excludes=["tkinter", "matplotlib", "IPython"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Darkroom Bridge", console=False, argv_emulation=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Darkroom Bridge")
app = BUNDLE(coll, name="Darkroom Bridge.app", icon=os.path.join(SPECPATH, "Darkroom.icns"),
             bundle_identifier="app.darkroom.bridge", version=VERSION,
             info_plist={
                 "CFBundleDisplayName": "Darkroom Bridge",
                 "CFBundleShortVersionString": VERSION,
                 "LSUIElement": True,   # lives in the menu bar
                 "NSHighResolutionCapable": True,
                 "LSMinimumSystemVersion": "11.0",
                 "NSLocalNetworkUsageDescription": "Darkroom Bridge receives photos from your camera over Wi-Fi.",
             })
