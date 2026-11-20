"""Bridge behaviour for every camera brand, offline. Usage: python3 tests/bridge_brands.py bridge/bridge.py <round>
Simulates: Sony/Canon/Nikon/Fujifilm FTP habits (nested folders, temp-name-then-rename, size check after upload,
RAW-only files), the second port, private camera passwords, shoot switching on an open connection, and hot folders."""
import ftplib, io, json, os, signal, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

BRIDGE, ROUND = Path(sys.argv[1]), int(sys.argv[2])
FTP, FTP2, WEB = 2600 + ROUND, 2700 + ROUND, 8600 + ROUND
R = []
def ok(n, c, i=""): R.append(f"{'PASS' if c else 'FAIL'} {n}{' — ' + str(i) if i != '' else ''}")

def jpeg(seed, size=(1800, 1200), model="Canon EOS R5"):
    rng = np.random.default_rng(seed); im = Image.new("RGB", size, (70, 90, 120)); d = ImageDraw.Draw(im)
    for _ in range(120):
        x, y = int(rng.integers(0, size[0] - 100)), int(rng.integers(0, size[1] - 100))
        d.rectangle([x, y, x + 80, y + 60], fill=tuple(int(v) for v in rng.integers(0, 255, 3)))
    ex = Image.Exif(); ex[272] = model; ex[306] = "2026:11:19 18:00:00"
    b = io.BytesIO(); im.save(b, "JPEG", quality=90, exif=ex); return b.getvalue()

def fake_raw(seed, header):
    """A RAW-like file: vendor header, a small thumbnail JPEG, the full-size preview JPEG, sensor junk."""
    small = io.BytesIO(); Image.new("RGB", (160, 120), (9, 9, 9)).save(small, "JPEG")
    return header + os.urandom(4000) + small.getvalue() + os.urandom(3000) + jpeg(seed, (3000, 2000)) + os.urandom(20000)

def start(lib, env_extra):
    env = {**os.environ, "DARKROOM_API": "http://127.0.0.1:9", "DARKROOM_LIBRARY": str(lib), "DARKROOM_FTP_PORT": str(FTP),
           "DARKROOM_FTP_PORT2": str(FTP2), "DARKROOM_WEB_PORT": str(WEB), "PYTHONUNBUFFERED": "1", **env_extra}
    for k in ("DARKROOM_FTP_USER", "DARKROOM_FTP_PASS"):
        if k not in env_extra: env.pop(k, None)
    p = subprocess.Popen([sys.executable, str(BRIDGE)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(80):
        try: urllib.request.urlopen(f"http://127.0.0.1:{WEB}/status.json", timeout=1); return p
        except Exception: time.sleep(0.25)
    raise SystemExit("bridge did not start")
def stop(p):
    p.send_signal(signal.SIGINT)
    try: return p.communicate(timeout=6)[0]
    except subprocess.TimeoutExpired: p.kill(); return p.communicate()[0]
def post(path, data):
    req = urllib.request.Request(f"http://127.0.0.1:{WEB}{path}", data=urllib.parse.urlencode(data).encode(), method="POST",
                                 headers={"Origin": f"http://localhost:{WEB}"})
    class N(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try: urllib.request.build_opener(N).open(req, timeout=15); return ""
    except urllib.error.HTTPError as e: return urllib.parse.unquote(e.headers.get("Location", ""))
def panel(): return urllib.request.urlopen(f"http://127.0.0.1:{WEB}/").read().decode()
def rows(lib, key):
    d = sqlite3.connect(lib / "darkroom.db"); d.row_factory = sqlite3.Row
    r = {x["name"]: dict(x) for x in d.execute("select * from photos where shoot=?", (key,))}; d.close(); return r
def wait(f, t=20):
    for _ in range(t * 4):
        if f(): return True
        time.sleep(0.25)
    return False
def login(port, user, pw):
    f = ftplib.FTP(); f.connect("127.0.0.1", port, timeout=10); f.login(user, pw); f.set_pasv(True); return f

# ---------------------------------------------------------------- 1. new install, private password, brands
lib = Path(tempfile.mkdtemp(prefix=f"drb{ROUND}_"))
KEY = "brandtest" + str(ROUND) * 15
p = start(lib, {"DARKROOM_KEY": KEY})
try:
    st = json.loads((lib / "settings.json").read_text())
    pw, user = st["ftp_pass"], st["ftp_user"]
    ok("P1 new install gets a private 8-char camera password", len(pw) == 8 and pw != "darkroom" and user == "darkroom", user)
    try: login(FTP, "sony", "darkroom"); ok("P2 old shared password no longer works", False)
    except ftplib.error_perm: ok("P2 old shared password no longer works", True)
    ok("P3 panel shows the password", pw in panel())

    # Canon: logs in, makes DCIM/100CANON, uploads JPEG + CR3
    f = login(FTP, user, pw)
    f.mkd("DCIM"); f.cwd("DCIM"); f.mkd("100CANON"); f.cwd("100CANON")
    f.storbinary("STOR IMG_0001.JPG", io.BytesIO(jpeg(1)))
    ok("C1 Canon size check right after upload succeeds", f.size("IMG_0001.JPG") > 0)
    f.storbinary("STOR IMG_0002.CR3", io.BytesIO(fake_raw(2, b"\x00\x00\x00\x18ftypcrx ")))
    f.quit()
    shoot = lib / f"Shoot {KEY[:6]}"
    ok("C2 Canon files land in the shoot folder, nested folders kept", (shoot / "DCIM/100CANON/IMG_0001.JPG").exists() and (shoot / "DCIM/100CANON/IMG_0002.CR3").exists())
    ok("C3 Canon JPEG + RAW-only CR3 developed", wait(lambda: {"IMG_0001.JPG", "IMG_0002.CR3"} <= set(rows(lib, KEY))), sorted(rows(lib, KEY)))
    r = rows(lib, KEY)
    ok("C4 CR3 preview is the full-size embedded JPEG", r.get("IMG_0002.CR3", {}).get("w") == 3000, r.get("IMG_0002.CR3", {}).get("w"))

    # Nikon on the second port (cameras that can't change port 21), NEF + uploads as temp name then renames
    f = login(FTP2, user, pw)
    f.storbinary("STOR DSC_0003.NEF", io.BytesIO(fake_raw(3, b"MM\x00\x2a\x00\x00\x00\x08")))
    f.storbinary("STOR DSC_0004.JPG.tmp", io.BytesIO(jpeg(4, model="NIKON Z 8")))
    f.rename("DSC_0004.JPG.tmp", "DSC_0004.JPG")
    f.quit()
    ok("N1 second port accepts the camera", True)
    ok("N2 NEF + upload-then-rename developed", wait(lambda: {"DSC_0003.NEF", "DSC_0004.JPG"} <= set(rows(lib, KEY))), sorted(rows(lib, KEY)))
    time.sleep(1)
    ok("N3 temp file never developed", not any(n.endswith(".tmp") for n in rows(lib, KEY)))
    ok("N4 renamed file in place", (shoot / "DSC_0004.JPG").exists() and not (shoot / "DSC_0004.JPG.tmp").exists())

    # Fujifilm RAF, Panasonic RW2, Hasselblad 3FR, Sony ARW (RAW-only)
    f = login(FTP, user, pw)
    for name, hdr in (("DSCF0005.RAF", b"FUJIFILMCCD-RAW "), ("P1000006.RW2", b"IIU\x00"), ("B0000007.3FR", b"II*\x00"), ("DSC00008.ARW", b"II*\x00")):
        f.storbinary(f"STOR {name}", io.BytesIO(fake_raw(len(name), hdr)))
    ok("F1 RAF, RW2, 3FR, ARW (RAW-only) developed",
       wait(lambda: {"DSCF0005.RAF", "P1000006.RW2", "B0000007.3FR", "DSC00008.ARW"} <= set(rows(lib, KEY))), sorted(rows(lib, KEY)))

    # Switch shoot while the camera keeps its connection open (Sony/Nikon keep one session for hours)
    KEY2 = "secondbrand" + str(ROUND) * 13
    post("/key", {"key": KEY2})
    f.storbinary("STOR DSC00009.JPG", io.BytesIO(jpeg(9, model="ILCE-7M4")))
    ok("S1 open connection follows the shoot switch", wait(lambda: "DSC00009.JPG" in rows(lib, KEY2)) and (lib / f"Shoot {KEY2[:6]}/DSC00009.JPG").exists())
    ok("S2 old shoot keeps its photos", "DSC00009.JPG" not in rows(lib, KEY) and len(rows(lib, KEY)) == 8, len(rows(lib, KEY)))
    f.quit()

    # Hot folder (tethered capture with any brand)
    hot = Path(tempfile.mkdtemp(prefix=f"hot{ROUND}_"))
    (hot / "OLD_0001.JPG").write_bytes(jpeg(50))
    msg = post("/hotfolder", {"path": str(hot)})
    ok("H1 hot folder accepted", "Watching" in msg, msg)
    time.sleep(5)
    (hot / "TETHER_0001.JPG").write_bytes(jpeg(51, model="Hasselblad X2D II 100C"))
    (hot / "TETHER_0002.3FR").write_bytes(fake_raw(52, b"II*\x00"))
    ok("H2 new tethered photos develop in the current shoot", wait(lambda: {"TETHER_0001.JPG", "TETHER_0002.3FR"} <= set(rows(lib, KEY2)), 25), sorted(rows(lib, KEY2)))
    ok("H3 photos already in the folder are left alone", "OLD_0001.JPG" not in rows(lib, KEY2))
    ok("H4 hot-folder originals stay where the tethering app put them", (hot / "TETHER_0001.JPG").exists())
    ok("H5 bad hot folder path refused", "no folder" in post("/hotfolder", {"path": str(hot / "nope")}))
    post("/hotfolder", {"path": ""})
    ok("H6 stop watching", "hot_folder" not in json.loads((lib / "settings.json").read_text()))
finally:
    out = stop(p)
ok("X1 no crash", "Traceback" not in out, out[-500:] if "Traceback" in out else "")

# ---------------------------------------------------------------- 2. install from before 1.1 keeps working, then upgrades
lib2 = Path(tempfile.mkdtemp(prefix=f"drb{ROUND}l_"))
(lib2 / "settings.json").write_text(json.dumps({"key": KEY, "folders": {KEY: "Old shoot"}}))
p = start(lib2, {})
try:
    f = login(FTP, "sony", "darkroom"); f.quit()
    ok("L1 already-set-up camera keeps working after the update", True)
    ok("L2 panel offers a private password", "Make a private password" in panel())
    post("/newpass", {})
    new = json.loads((lib2 / "settings.json").read_text())["ftp_pass"]
    try: login(FTP, "sony", "darkroom"); ok("L3 old password stops working at once", False)
    except ftplib.error_perm: ok("L3 old password stops working at once", True)
    f = login(FTP, "sony", new); f.quit()
    ok("L4 new password works without restarting", new != "darkroom")
finally:
    out = stop(p)
ok("X2 no crash", "Traceback" not in out, out[-500:] if "Traceback" in out else "")
print("\n".join(R)); print(f"\nBRANDS ROUND {ROUND}: {sum(x.startswith('PASS') for x in R)}/{len(R)} passed")
