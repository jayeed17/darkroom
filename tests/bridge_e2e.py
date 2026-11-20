"""End-to-end test of the Darkroom bridge, driven like a Sony camera over FTP (offline: no cloud needed).
Usage: python3 tests/bridge_e2e.py bridge/bridge.py <round>"""
import ftplib, io, json, os, signal, sqlite3, subprocess, sys, tempfile, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

BRIDGE, ROUND = Path(sys.argv[1]), sys.argv[2]
FTP_PORT, WEB_PORT = 2321 + int(ROUND), 8100 + int(ROUND)
R = []
def ok(name, cond, info=""): R.append(f"{'PASS' if cond else 'FAIL'} {name}{' — ' + str(info) if info != '' else ''}")

def scene(seed, dark=False):
    rng = np.random.default_rng(seed)
    a = np.zeros((1600, 2400, 3), np.uint8); a[:] = (60, 80, 110)
    img = Image.fromarray(a)
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    for _ in range(140):
        x, y = rng.integers(0, 2300), rng.integers(0, 1500)
        d.rectangle([x, y, x + rng.integers(20, 120), y + rng.integers(20, 120)], fill=tuple(int(v) for v in rng.integers(0, 255, 3)))
    if dark: img = Image.eval(img, lambda v: v // 7)
    return img

def jpeg(img, model="ILCE-7M4", dt="2026:11:19 10:00:00"):
    ex = Image.Exif(); ex[272] = model; ex[306] = dt
    b = io.BytesIO(); img.save(b, "JPEG", quality=92, exif=ex); return b.getvalue()

lib = Path(tempfile.mkdtemp(prefix=f"dr{ROUND}_", dir=os.environ.get("TEST_TMP")))
KEY = "testkey" + ROUND * 17
KID = KEY[:10]
env = {**os.environ, "DARKROOM_LIBRARY": str(lib), "DARKROOM_KEY": "testkey" + ROUND * 17,
       "DARKROOM_FTP_PORT": str(FTP_PORT), "DARKROOM_WEB_PORT": str(WEB_PORT), "PYTHONUNBUFFERED": "1"}
def start():
    p = subprocess.Popen([sys.executable, str(BRIDGE)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/", timeout=1); return p
        except Exception: time.sleep(0.25)
    raise SystemExit("bridge did not start")
def stop(p):
    p.send_signal(signal.SIGINT)
    try: return p.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired: p.kill(); return p.communicate()[0]
def rows():
    db = sqlite3.connect(lib / "darkroom.db"); db.row_factory = sqlite3.Row
    r = {x["name"]: dict(x) for x in db.execute("select * from photos where shoot=?", (KEY,))}; db.close(); return r
def wait_rows(n, t=30):
    for _ in range(t * 4):
        if len(rows()) >= n: return True
        time.sleep(0.25)
    return False

sharp = scene(1)
files = {
    "DSC00001.JPG": jpeg(sharp),
    "DSC00002.JPG": jpeg(sharp.filter(ImageFilter.GaussianBlur(9))),          # out of focus
    "DSC00003.JPG": jpeg(sharp.crop((6, 6, 2394, 1594)).resize((2400, 1600))),  # burst near-duplicate of 1
    "DSC00004.JPG": jpeg(scene(7, dark=True)),                                  # dark but sharp
    "DSC00005.JPG": jpeg(scene(9).rotate(90, expand=True), model="ILCE-7RM5"),  # portrait, a7R V
    "DSC00006.JPG": jpeg(scene(11).filter(ImageFilter.GaussianBlur(9))),        # burst: soft first frame...
    "DSC00007.JPG": jpeg(scene(11)),                                            # ...then the sharp one
}
p = start()
try:
    ftp = ftplib.FTP()
    ftp.connect("127.0.0.1", FTP_PORT, timeout=10)
    try: ftp.login("sony", "wrong"); ok("F1 wrong FTP password rejected", False)
    except ftplib.error_perm: ok("F1 wrong FTP password rejected", True)
    ftp.close()
    ftp = ftplib.FTP(); ftp.connect("127.0.0.1", FTP_PORT, timeout=10); ftp.login("sony", "darkroom"); ftp.set_pasv(True)
    ok("F2 camera login (sony/darkroom, passive)", True)
    ftp.mkd("DCIM"); ftp.cwd("DCIM")   # cameras often create folders
    for name, data in files.items(): ftp.storbinary(f"STOR {name}", io.BytesIO(data))
    ftp.storbinary("STOR notes.txt", io.BytesIO(b"x")); ftp.storbinary("STOR .hidden.JPG", io.BytesIO(files["DSC00001.JPG"]))
    ok("F3 uploads accepted", True)
    ok("I1 all photos ingested", wait_rows(7), len(rows()))
    time.sleep(1)
    r = rows()
    ok("I2 ignores non-photos and hidden files", set(r) == set(files), sorted(r))
    ok("I3 sharp photo not flagged", r["DSC00001.JPG"]["blurry"] == 0, round(r["DSC00001.JPG"]["sharpness"], 1))
    ok("I4 out-of-focus flagged BLUR", r["DSC00002.JPG"]["blurry"] == 1, round(r["DSC00002.JPG"]["sharpness"], 1))
    ok("I5 burst duplicate linked to original", r["DSC00003.JPG"]["dup_of"] == "DSC00001.JPG", r["DSC00003.JPG"]["dup_of"])
    ok("I5b sharp frame never hidden behind a soft one", not r["DSC00007.JPG"]["dup_of"] and r["DSC00007.JPG"]["blurry"] == 0, r["DSC00007.JPG"]["dup_of"])
    ok("I5c soft first frame still flagged", r["DSC00006.JPG"]["blurry"] == 1)
    ok("I6 dark-but-sharp NOT flagged", r["DSC00004.JPG"]["blurry"] == 0, round(r["DSC00004.JPG"]["sharpness"], 1))
    ok("I7 camera model from EXIF", r["DSC00001.JPG"]["camera"] == "ILCE-7M4" and r["DSC00005.JPG"]["camera"] == "ILCE-7RM5")
    ok("I8 portrait orientation kept", r["DSC00005.JPG"]["h"] > r["DSC00005.JPG"]["w"], f'{r["DSC00005.JPG"]["w"]}x{r["DSC00005.JPG"]["h"]}')
    th = Image.open(lib / f".cache/{KID}/DSC00001.thumb.jpg"); pv = Image.open(lib / f".cache/{KID}/DSC00001.preview.jpg")
    ok("I9 thumb ≤640 and preview ≤2400", max(th.size) == 640 and max(pv.size) == 2400, f"{th.size} {pv.size}")
    ok("I10 original kept untouched, in the shoot's own folder", (lib / f"Shoot {KID[:6]}/DCIM/DSC00001.JPG").read_bytes() == files["DSC00001.JPG"])
    ok("Q1 offline: kept in queue, nothing lost", all(x["synced"] == 0 for x in r.values()))
    html = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/").read().decode()
    ok("L1 local view lists photos", "7 photos" in html and html.count("BLUR") == 2)
    ok("L2 local view serves thumbnails", urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/c/{KID}/DSC00001.thumb.jpg").status == 200)
    try: urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/c/..%2F..%2Fdarkroom.db"); ok("L3 no path traversal", False)
    except urllib.error.HTTPError as e: ok("L3 no path traversal", e.code == 404)
    ftp.storbinary("STOR DSC00001.JPG", io.BytesIO(files["DSC00001.JPG"])); time.sleep(2)
    ok("I11 re-sent file doesn't duplicate", len(rows()) == 7)
    r1 = rows()["DSC00001.JPG"]
    ok("I12 re-sent original stays a keeper", not r1["dup_of"] and r1["blurry"] == 0, r1["dup_of"])
    # ---- control panel security + shoot switching
    def post(path, data, origin=None, host=None):
        req = urllib.request.Request(f"http://127.0.0.1:{WEB_PORT}{path}", data=urllib.parse.urlencode(data).encode(), method="POST")
        if origin: req.add_header("Origin", origin)
        if host: req.add_header("Host", host)
        class NoRedir(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k): return None
        try: r = urllib.request.build_opener(NoRedir).open(req, timeout=15); return r.status, r.headers.get("Location", "")
        except urllib.error.HTTPError as e: return e.code, e.headers.get("Location", "")
    ok("S1 other websites can't switch the shoot", post("/key", {"key": "evilkey12345678"}, origin="https://evil.example")[0] == 403)
    ok("S2 rebinding host blocked", post("/key", {"key": "evilkey12345678"}, host="evil.example:%d" % WEB_PORT)[0] == 403)
    try: urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{WEB_PORT}/", headers={"Host": "evil.example"})); ok("S3 panel unreadable via foreign Host", False)
    except urllib.error.HTTPError as e: ok("S3 panel unreadable via foreign Host", e.code == 403)
    code, loc = post("/key", {"key": "bad key!"}, origin=f"http://localhost:{WEB_PORT}")
    ok("S4 malformed key rejected with a message", code == 303 and "doesn" in urllib.parse.unquote(loc), loc)
    cpage = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/connect?key=secondshoot{ROUND}abc").read().decode()
    ok("S5 connect page asks before switching", "Connect this Mac to" in cpage and 'name=key value="secondshoot' in cpage)
    st = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/status.json").read())
    ok("S6 status.json says which shoot (prefix only)", st["app"] == "darkroom-bridge" and st["key"] == KEY[:6], st)
    code, loc = post("/key", {"key": f"secondshoot{ROUND}abc"}, origin=f"http://localhost:{WEB_PORT}")
    ok("S7 switch shoot from the panel", code == 303 and "m=" not in loc, loc)
    ftp.storbinary("STOR DSC00001.JPG", io.BytesIO(files["DSC00005.JPG"]))  # same file name, new shoot
    time.sleep(3)
    db = sqlite3.connect(lib / "darkroom.db"); n_new = db.execute("select count(*) from photos where shoot=?", (f"secondshoot{ROUND}abc",)).fetchone()[0]
    n_old = db.execute("select count(*) from photos where shoot=?", (KEY,)).fetchone()[0]; db.close()
    ok("S8 same file name in two shoots: both kept", n_new == 1 and n_old == 7, (n_old, n_new))
    ok("S9 new shoot gets its own folder", (lib / "Shoot second/DCIM/DSC00001.JPG").exists() and (lib / f"Shoot {KID[:6]}/DCIM/DSC00001.JPG").read_bytes() == files["DSC00001.JPG"])
    post("/key", {"key": KEY}, origin=f"http://localhost:{WEB_PORT}")
    ftp.quit()
finally:
    out = stop(p)
ok("Q2 offline message shown", "Couldn't reach Darkroom" in out or "failed" in out)
# restart: nothing re-ingested twice, queue survives
p = start(); time.sleep(3); out2 = stop(p)
ok("Q3 queue survives restart", len(rows()) == 7 and all(x["synced"] == 0 for x in rows().values()))
ok("Q4 no crash on restart", "Traceback" not in out + out2, (out + out2)[-300:] if "Traceback" in out + out2 else "")

# ---- photos shot before any shoot is connected wait, then go to the shoot you connect
lib2 = Path(tempfile.mkdtemp(prefix=f"dr{ROUND}b_"))
env2 = {**env, "DARKROOM_LIBRARY": str(lib2), "DARKROOM_KEY": ""}
p2 = subprocess.Popen([sys.executable, str(BRIDGE)], env=env2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for _ in range(60):
    try: urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/", timeout=1); break
    except Exception: time.sleep(0.25)
ftp = ftplib.FTP(); ftp.connect("127.0.0.1", FTP_PORT, timeout=10); ftp.login("sony", "darkroom")
ftp.storbinary("STOR DSC09001.JPG", io.BytesIO(files["DSC00001.JPG"])); ftp.quit(); time.sleep(2)
panel = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/").read().decode()
ok("W1 no shoot yet: photo waits, panel says so", (lib2 / "inbox/DSC09001.JPG").exists() and "No shoot connected" in panel and "waiting for a shoot" in panel)
req = urllib.request.Request(f"http://127.0.0.1:{WEB_PORT}/key", data=b"key=latershoot99", method="POST", headers={"Origin": f"http://127.0.0.1:{WEB_PORT}"})
try: urllib.request.urlopen(req, timeout=15)
except Exception: pass
time.sleep(3)
ok("W2 waiting photo goes to the shoot you connect", (lib2 / "Shoot laters/DSC09001.JPG").exists() and not (lib2 / "inbox/DSC09001.JPG").exists())
req = urllib.request.Request(f"http://127.0.0.1:{WEB_PORT}/quit", data=b"", method="POST")
try: urllib.request.urlopen(req, timeout=5)
except Exception: pass
try: p2.wait(timeout=5); ok("W3 Quit button stops the bridge", True)
except subprocess.TimeoutExpired: p2.kill(); ok("W3 Quit button stops the bridge", False)
out3 = p2.communicate()[0]
ok("W4 no crash", "Traceback" not in out3, out3[-300:])

# ---- old library (v0 database) is migrated, nothing lost
lib3 = Path(tempfile.mkdtemp(prefix=f"dr{ROUND}c_"))
d = sqlite3.connect(lib3 / "darkroom.db")
d.execute("""CREATE TABLE photos(name TEXT PRIMARY KEY, path TEXT, raw TEXT, w INT, h INT, taken TEXT, sharpness REAL,
  dhash TEXT, blurry INT, dup_of TEXT, camera TEXT, synced INT DEFAULT 0, shoot TEXT, added REAL)""")
d.execute("insert into photos(name,shoot,synced,added) values('OLD1.JPG','k1',1,1),('OLD2.JPG','k1',0,2)"); d.commit(); d.close()
p3 = subprocess.Popen([sys.executable, str(BRIDGE)], env={**env, "DARKROOM_LIBRARY": str(lib3), "DARKROOM_KEY": ""}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(3); out4 = stop(p3)
d = sqlite3.connect(lib3 / "darkroom.db"); pkc = [r[1] for r in d.execute("pragma table_info(photos)") if r[5]]
n = d.execute("select count(*) from photos").fetchone()[0]; d.close()
ok("M1 old library migrated, nothing lost", n == 2 and pkc == ["name", "shoot"] or n == 2 and set(pkc) == {"name", "shoot"}, (n, pkc, out4[-200:]))
print("\n".join(R))
print(f"\nROUND {ROUND}: {sum(x.startswith('PASS') for x in R)}/{len(R)} passed")
