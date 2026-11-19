"""
Darkroom bridge: Sony camera (FTP over Wi-Fi) -> this computer -> Darkroom cloud.

  ./start.sh <SHOOT_KEY> [library folder]

* Receives JPEG/RAW from FX3 / a7 IV / a7R V via FTP (port 2121).
* Keeps originals on this machine (point the library at your SSD).
* Scores sharpness and finds duplicates, makes a thumbnail + a 2400px preview,
  uploads both to Darkroom, so the web gallery develops live for you and your clients.
* Works offline: anything not uploaded yet is retried until it goes through.
* Local fallback gallery at http://localhost:8000
"""
import io, json, os, queue, socket, sqlite3, threading, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

HERE = Path(__file__).parent
CFG = json.loads((HERE / "config.json").read_text())
ROOT = Path(os.environ.get("DARKROOM_LIBRARY", HERE / "library")).expanduser()
KEY = os.environ.get("DARKROOM_KEY", "").strip()
FTP_USER = os.environ.get("DARKROOM_FTP_USER", "sony")
FTP_PASS = os.environ.get("DARKROOM_FTP_PASS", "darkroom")
FTP_PORT = int(os.environ.get("DARKROOM_FTP_PORT", 2121))
WEB_PORT = int(os.environ.get("DARKROOM_WEB_PORT", 8000))
BLUR_THRESHOLD = float(os.environ.get("DARKROOM_BLUR", 11))
DUP_DISTANCE = 6

INBOX, CACHE = ROOT / "inbox", ROOT / ".cache"
for d in (INBOX, CACHE):
    d.mkdir(parents=True, exist_ok=True)
IMG_EXT = {".jpg", ".jpeg", ".png", ".heif", ".hif", ".heic"}
RAW_EXT = {".arw", ".dng"}

# ---------------------------------------------------------------- local state
lock = threading.Lock()
db = sqlite3.connect(ROOT / "darkroom.db", check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE IF NOT EXISTS photos(
  name TEXT PRIMARY KEY, path TEXT, raw TEXT, w INT, h INT, taken TEXT, sharpness REAL,
  dhash TEXT, blurry INT, dup_of TEXT, camera TEXT, synced INT DEFAULT 0, shoot TEXT, added REAL)""")
db.commit()

def q(sql, *a):
    with lock:
        cur = db.execute(sql, a); db.commit()
        return [dict(r) for r in cur.fetchall()]

# ---------------------------------------------------------------- image analysis
def load_image(path: Path) -> Image.Image:
    if path.suffix.lower() in RAW_EXT:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            try:
                t = raw.extract_thumb()
                if t.format == rawpy.ThumbFormat.JPEG:
                    return ImageOps.exif_transpose(Image.open(io.BytesIO(t.data)))
                return Image.fromarray(t.data)
            except Exception:
                return Image.fromarray(raw.postprocess(half_size=True, use_camera_wb=True))
    if path.suffix.lower() in {".heif", ".hif", ".heic"}:
        try:
            import pillow_heif; pillow_heif.register_heif_opener()
        except ImportError:
            pass
    img = Image.open(path)
    img.load()
    return ImageOps.exif_transpose(img)

def sharpness(img: Image.Image) -> float:
    """Exposure-independent focus score.
    Contrast-stretch first (so dark, low-light frames aren't mistaken for blur), then take the
    Laplacian variance per tile and score the sharpest tiles (so a sharp subject on a soft,
    bokeh background still counts as sharp)."""
    g = np.asarray(img.convert("L").resize((1000, max(1, int(1000 * img.height / img.width)))), dtype=np.float32)
    lo, hi = np.percentile(g, (1, 99))
    g = np.clip((g - lo) / max(hi - lo, 8.0), 0, 1) * 255
    lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:])
    H, W = lap.shape
    th, tw = H // 6, W // 6
    tiles = [lap[r*th:(r+1)*th, c*tw:(c+1)*tw].var() for r in range(6) for c in range(6)]
    return float(np.mean(sorted(tiles)[-4:]) ** 0.5)  # RMS edge strength of the 4 sharpest tiles

def dhash(img: Image.Image) -> str:
    g = np.asarray(img.convert("L").resize((9, 8), Image.LANCZOS), dtype=np.int16)
    bits = (g[:, 1:] > g[:, :-1]).flatten()
    return "%016x" % int("".join("1" if b else "0" for b in bits), 2)

def hamming(a, b): return bin(int(a, 16) ^ int(b, 16)).count("1")

def exif_info(img):
    try:
        ex = img.getexif()
        model = ex.get(272)
        dt = ex.get_ifd(0x8769).get(36867) or ex.get(306)
        taken = datetime.strptime(dt, "%Y:%m:%d %H:%M:%S").astimezone().isoformat() if dt else None
        return (model or "").strip() or None, taken
    except Exception:
        return None, None

# ---------------------------------------------------------------- cloud
FUNC = CFG["supabase_url"].rstrip("/") + "/functions/v1/ingest"
HEADERS = {"apikey": CFG["publishable_key"], "Content-Type": "application/json"}

def call(payload, timeout=30):
    req = urllib.request.Request(FUNC, data=json.dumps({"key": KEY, **payload}).encode(), headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code} {e.read().decode(errors='ignore')[:200]}")

def put(url, data: bytes):
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Content-Type": "image/jpeg", "x-upsert": "true", "apikey": CFG["publishable_key"],
        "cache-control": "max-age=31536000"})
    with urllib.request.urlopen(req, timeout=120) as r:
        r.read()

def upload(row):
    stem = Path(row["name"]).stem
    up = call({"action": "prepare", "name": row["name"]})["upload"]
    put(up["thumb"], (CACHE / f"{stem}.thumb.jpg").read_bytes())
    put(up["preview"], (CACHE / f"{stem}.preview.jpg").read_bytes())
    call({"action": "commit", "name": row["name"], "w": row["w"], "h": row["h"], "taken": row["taken"],
          "sharpness": row["sharpness"], "blurry": bool(row["blurry"]), "dup_of_name": row["dup_of"],
          "camera": row["camera"]})

wake = threading.Event()
def sync_loop():
    backoff = 2
    while True:
        wake.wait(timeout=15); wake.clear()
        if not KEY:
            continue
        pending = q("SELECT * FROM photos WHERE synced=0 AND shoot=? ORDER BY added", KEY)
        for row in pending:
            try:
                upload(row)
                q("UPDATE photos SET synced=1 WHERE name=?", row["name"])
                print(f"  ↑ {row['name']} developed in Darkroom")
                backoff = 2
            except Exception as e:
                print(f"  ! upload {row['name']} failed ({e}); retrying in {backoff}s")
                time.sleep(backoff); backoff = min(backoff * 2, 60)
                wake.set(); break

# ---------------------------------------------------------------- ingest
jobs: "queue.Queue[Path]" = queue.Queue()

def ingest(path: Path):
    ext = path.suffix.lower()
    if ext not in IMG_EXT | RAW_EXT or path.name.startswith("."):
        return
    stem = path.stem
    existing = q("SELECT * FROM photos WHERE name LIKE ?", stem + ".%")
    if existing:
        if ext in RAW_EXT:                                  # RAW+JPEG pair: attach RAW, keep JPEG preview
            q("UPDATE photos SET raw=? WHERE name=?", str(path), existing[0]["name"]); return
        if Path(existing[0]["name"]).suffix.lower() in RAW_EXT:
            q("DELETE FROM photos WHERE name=?", existing[0]["name"])
        elif existing[0]["name"] == path.name and existing[0]["synced"]:
            return
    img = load_image(path)
    camera, taken = exif_info(img)
    sharp = sharpness(img)
    h = dhash(img)
    rgb = img.convert("RGB")
    prev = rgb.copy(); prev.thumbnail((2400, 2400), Image.LANCZOS); prev.save(CACHE / f"{stem}.preview.jpg", quality=86, optimize=True)
    th = rgb.copy(); th.thumbnail((640, 640), Image.LANCZOS); th.save(CACHE / f"{stem}.thumb.jpg", quality=80, optimize=True)
    blurry = int(sharp < BLUR_THRESHOLD)
    # Duplicate of the closest *keeper* only (sharp and not itself a duplicate). Linking to a soft or
    # duplicate frame would hide the good shot of a burst whose first frame missed focus.
    dup_of, best = None, DUP_DISTANCE + 1
    for r in q("SELECT name, dhash, blurry, dup_of FROM photos WHERE shoot=? AND name<>? ORDER BY added DESC LIMIT 40", KEY, path.name):
        if not r["dhash"] or r["blurry"] or r["dup_of"]:
            continue
        d = hamming(r["dhash"], h)
        if d < best:
            dup_of, best = r["name"], d
    q("""INSERT OR REPLACE INTO photos(name,path,w,h,taken,sharpness,dhash,blurry,dup_of,camera,synced,shoot,added)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)""",
      path.name, str(path), img.width, img.height, taken or datetime.now(timezone.utc).isoformat(),
      sharp, h, blurry, dup_of, camera, KEY, time.time())
    print(f"+ {path.name}  sharp={sharp:.0f}{'  BLURRY' if blurry else ''}{'  DUP' if dup_of else ''}")
    wake.set()

def worker():
    while True:
        p = jobs.get()
        for attempt in range(3):
            try:
                ingest(p); break
            except Exception as e:
                if attempt == 2: print("  ! could not read", p.name, e)
                time.sleep(1.5)

class CameraHandler(FTPHandler):
    def on_file_received(self, file): jobs.put(Path(file))
    def on_incomplete_file_received(self, file):
        try: os.remove(file)
        except OSError: pass

def run_ftp():
    auth = DummyAuthorizer()
    auth.add_user(FTP_USER, FTP_PASS, str(INBOX), perm="elradfmwMT")
    CameraHandler.authorizer = auth
    CameraHandler.passive_ports = range(60000, 60100)
    CameraHandler.banner = "darkroom ready"
    srv = FTPServer(("0.0.0.0", FTP_PORT), CameraHandler)
    srv.max_cons = 32
    srv.serve_forever(handle_exit=False)

# ---------------------------------------------------------------- tiny local gallery (offline fallback)
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
LOCAL_HTML = """<!doctype html><meta charset=utf-8><title>Darkroom bridge</title><meta http-equiv=refresh content=5>
<style>body{margin:0;background:#0f0f11;color:#ddd;font:14px system-ui}h1{font:600 16px system-ui;padding:14px 18px;margin:0;border-bottom:1px solid #2a2a2f}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;padding:14px}.g div{position:relative}img{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:4px}
span{position:absolute;left:6px;top:6px;font-size:10px;background:#e2683c;color:#fff;padding:1px 5px;border-radius:3px}</style>
<h1>Darkroom bridge · local view · __N__ photos · __S__ uploaded</h1><div class=g>__ITEMS__</div>"""

class Local(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/c/"):
            f = CACHE / Path(self.path[3:]).name
            if f.exists():
                self.send_response(200); self.send_header("Content-Type", "image/jpeg"); self.end_headers()
                self.wfile.write(f.read_bytes()); return
            self.send_error(404); return
        rows = q("SELECT * FROM photos ORDER BY added DESC")
        items = "".join(f'<div><img loading=lazy src="/c/{Path(r["name"]).stem}.thumb.jpg">'
                        f'{"<span>BLUR</span>" if r["blurry"] else ""}</div>' for r in rows)
        html = LOCAL_HTML.replace("__N__", str(len(rows))).replace("__S__", str(sum(r["synced"] for r in rows))).replace("__ITEMS__", items)
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
        self.wfile.write(html.encode())

def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(("10.255.255.255", 1)); return s.getsockname()[0]
    except Exception: return "127.0.0.1"
    finally: s.close()

def main():
    title = None
    if KEY:
        try: title = call({"action": "hello"}, timeout=10)["title"]
        except Exception as e: print(f"\n  ! Couldn't reach Darkroom ({e}). Photos will be kept and uploaded once online.")
    ip = local_ip()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=sync_loop, daemon=True).start()
    threading.Thread(target=run_ftp, daemon=True).start()
    for p in sorted(INBOX.rglob("*")):
        if p.is_file() and not q("SELECT 1 FROM photos WHERE name=? AND shoot=?", p.name, KEY):
            jobs.put(p)
    wake.set()
    print("\n  ◉ Darkroom bridge")
    print(f"    Shoot     {title or ('(offline)' if KEY else 'none, local only. Pass your shoot key: ./start.sh <KEY>')}")
    print(f"    Library   {ROOT}")
    if ip.startswith("192.0.0.") or ip == "127.0.0.1":
        print("    ! No usable local network address. Join a normal Wi-Fi network (not a carrier hotspot).")
    print(f"\n    Camera → Network → FTP Transfer Func. → Server 1")
    print(f"      Host {ip}   Port {FTP_PORT}   User {FTP_USER}   Password {FTP_PASS}   Passive ON   Secure OFF")
    print(f"\n    Local view http://localhost:{WEB_PORT}   ·   Ctrl+C to stop\n")
    ThreadingHTTPServer(("0.0.0.0", WEB_PORT), Local).serve_forever()

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\n  stopped")
