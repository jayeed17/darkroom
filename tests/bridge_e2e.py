"""End-to-end test of the Darkroom bridge, driven like a Sony camera over FTP (offline: no cloud needed).
Usage: python3 tests/bridge_e2e.py bridge/bridge.py <round>"""
import ftplib, io, json, os, signal, sqlite3, subprocess, sys, tempfile, time, urllib.request
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

lib = Path(tempfile.mkdtemp(prefix=f"dr{ROUND}_"))
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
    r = {x["name"]: dict(x) for x in db.execute("select * from photos")}; db.close(); return r
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
    th = Image.open(lib / ".cache/DSC00001.thumb.jpg"); pv = Image.open(lib / ".cache/DSC00001.preview.jpg")
    ok("I9 thumb ≤640 and preview ≤2400", max(th.size) == 640 and max(pv.size) == 2400, f"{th.size} {pv.size}")
    ok("I10 original kept untouched", (lib / "inbox/DCIM/DSC00001.JPG").read_bytes() == files["DSC00001.JPG"])
    ok("Q1 offline: kept in queue, nothing lost", all(x["synced"] == 0 for x in r.values()))
    html = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/").read().decode()
    ok("L1 local view lists photos", "7 photos" in html and html.count("BLUR") == 2)
    ok("L2 local view serves thumbnails", urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/c/DSC00001.thumb.jpg").status == 200)
    try: urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/c/..%2F..%2Fdarkroom.db"); ok("L3 no path traversal", False)
    except urllib.error.HTTPError as e: ok("L3 no path traversal", e.code == 404)
    ftp.storbinary("STOR DSC00001.JPG", io.BytesIO(files["DSC00001.JPG"])); time.sleep(2)
    ok("I11 re-sent file doesn't duplicate", len(rows()) == 7)
    r1 = rows()["DSC00001.JPG"]
    ok("I12 re-sent original stays a keeper", not r1["dup_of"] and r1["blurry"] == 0, r1["dup_of"])
    ftp.quit()
finally:
    out = stop(p)
ok("Q2 offline message shown", "Couldn't reach Darkroom" in out or "failed" in out)
# restart: nothing re-ingested twice, queue survives
p = start(); time.sleep(3); out2 = stop(p)
ok("Q3 queue survives restart", len(rows()) == 7 and all(x["synced"] == 0 for x in rows().values()))
ok("Q4 no crash on restart", "Traceback" not in out + out2, (out + out2)[-300:] if "Traceback" in out + out2 else "")
print("\n".join(R))
print(f"\nROUND {ROUND}: {sum(x.startswith('PASS') for x in R)}/{len(R)} passed")
