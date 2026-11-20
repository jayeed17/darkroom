"""
Darkroom bridge: Sony camera (FTP over Wi-Fi) -> this computer -> Darkroom cloud.

As a Mac app: open "Darkroom Bridge". A control panel opens in your browser at http://localhost:47474.
From the shoot's Camera tab on Darkroom, click "Connect this Mac", then point the camera at the address shown.

From source:  ./start.sh <SHOOT_KEY> [library folder]

* Receives JPEG/RAW from FX3 / a7 IV / a7R V via FTP (port 2121).
* Keeps originals on this machine, one folder per shoot (point the library at your SSD).
* Scores sharpness and finds duplicates, makes a thumbnail + a 2400px preview,
  uploads both to Darkroom, so the web gallery develops live for you and your clients.
* Works offline: anything not uploaded yet is retried until it goes through.
"""
import html, io, json, os, queue, re, shutil, socket, sqlite3, subprocess, sys, threading, time
import urllib.error, urllib.parse, urllib.request, webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if getattr(sys, "frozen", False):
    # A packaged app is only ever started by the user. If a library re-runs sys.executable as a helper
    # (multiprocessing, "python -c ..."), that must not start a second bridge.
    import multiprocessing; multiprocessing.freeze_support()
    if [a for a in sys.argv[1:] if not a.startswith("-psn_")]:
        sys.exit(0)

import numpy as np
from PIL import Image, ImageOps
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

VERSION = "1.1.0"
FROZEN = getattr(sys, "frozen", False)
APP = FROZEN or os.environ.get("DARKROOM_APP") == "1"
HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
CFG = json.loads((HERE / "config.json").read_text())
if os.environ.get("DARKROOM_API"): CFG["supabase_url"] = os.environ["DARKROOM_API"]  # tests only

FTP_PORT = int(os.environ.get("DARKROOM_FTP_PORT", 2121))
FTP_PORT2 = int(os.environ.get("DARKROOM_FTP_PORT2", 21))   # also listen on the standard port (cameras that can't change it)
WEB_PORT = int(os.environ.get("DARKROOM_WEB_PORT", 47474))
BLUR_THRESHOLD = float(os.environ.get("DARKROOM_BLUR", 11))
DUP_DISTANCE = 6
IMG_EXT = {".jpg", ".jpeg", ".png", ".heif", ".hif", ".heic"}
RAW_EXT = {".arw", ".srf", ".sr2", ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".raf", ".rw2", ".orf", ".dng",
           ".3fr", ".fff", ".iiq", ".pef", ".srw", ".x3f", ".rwl", ".erf", ".mos"}
TEMP_SUFFIXES = (".tmp", ".part", ".partial", ".filepart", ".crdownload", ".~tmp")

# App: state in Application Support, photos in ~/Pictures/Darkroom. Source: everything in the library folder.
if APP:
    STATE = Path(os.environ.get("DARKROOM_STATE", "~/Library/Application Support/Darkroom")).expanduser()
else:
    STATE = Path(os.environ.get("DARKROOM_LIBRARY", Path(__file__).parent / "library")).expanduser()
STATE.mkdir(parents=True, exist_ok=True)
SETTINGS_F = STATE / "settings.json"
try:
    SETTINGS = json.loads(SETTINGS_F.read_text())
except Exception:
    SETTINGS = {}
_SAVED_BEFORE = dict(SETTINGS)  # as saved by a previous run, before this launch's overrides
def save_settings():
    tmp = SETTINGS_F.with_suffix(".tmp"); tmp.write_text(json.dumps(SETTINGS, indent=1)); os.replace(tmp, SETTINGS_F)

if APP and not os.environ.get("DARKROOM_CONSOLE"):
    log_f = open(STATE / "bridge.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr = log_f
else:
    for _s in (sys.stdout, sys.stderr):  # write log lines as they happen, even into a file
        try: _s.reconfigure(line_buffering=True)
        except Exception: pass

if os.environ.get("DARKROOM_KEY", "").strip():
    SETTINGS["key"] = os.environ["DARKROOM_KEY"].strip()
if os.environ.get("DARKROOM_LIBRARY") and APP:
    SETTINGS["library"] = os.environ["DARKROOM_LIBRARY"]
# Camera login. New installs get a private password (anyone on the same Wi-Fi could otherwise log in);
# installs from before 1.1 keep the old default so a camera that's already set up keeps working.
if "ftp_pass" not in SETTINGS:
    import secrets
    legacy = bool(_SAVED_BEFORE.get("key") or _SAVED_BEFORE.get("folders"))
    SETTINGS["ftp_user"] = "sony" if legacy else "darkroom"
    SETTINGS["ftp_pass"] = "darkroom" if legacy else "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))
    save_settings()
FTP_USER = os.environ.get("DARKROOM_FTP_USER") or SETTINGS["ftp_user"]
FTP_PASS = os.environ.get("DARKROOM_FTP_PASS") or SETTINGS["ftp_pass"]
ROOT = Path(SETTINGS.get("library") or (Path.home() / "Pictures/Darkroom" if APP else STATE)).expanduser()
ROOT.mkdir(parents=True, exist_ok=True)
INBOX, CACHE = STATE / "inbox", STATE / ".cache"
for d in (INBOX, CACHE):
    d.mkdir(parents=True, exist_ok=True)
INBOX = INBOX.resolve()  # the FTP server reports real paths (macOS: /var -> /private/var)

STATUS = {"online": None, "last_camera": None, "last_file": None, "ftp_error": None, "port2": None, "login_failed": None}

# ---------------------------------------------------------------- local state
lock = threading.Lock()
db = sqlite3.connect(STATE / "darkroom.db", check_same_thread=False)
db.row_factory = sqlite3.Row
COLS = "name, path, raw, w, h, taken, sharpness, dhash, blurry, dup_of, camera, synced, shoot, added"
SCHEMA = """CREATE TABLE IF NOT EXISTS photos(
  name TEXT, path TEXT, raw TEXT, w INT, h INT, taken TEXT, sharpness REAL,
  dhash TEXT, blurry INT, dup_of TEXT, camera TEXT, synced INT DEFAULT 0, shoot TEXT, added REAL,
  PRIMARY KEY(shoot, name))"""
pk = [r[1] for r in db.execute("PRAGMA table_info(photos)") if r[5]]
if pk == ["name"]:  # v0 table keyed by file name only: same file name in two shoots collided
    db.executescript(f"ALTER TABLE photos RENAME TO photos_v0; {SCHEMA};"
                     f"INSERT OR IGNORE INTO photos({COLS}) SELECT {COLS} FROM photos_v0; DROP TABLE photos_v0;")
db.execute(SCHEMA)
db.commit()

def q(sql, *a):
    with lock:
        cur = db.execute(sql, a); db.commit()
        return [dict(r) for r in cur.fetchall()]

def key_now(): return SETTINGS.get("key", "")
def kid(key): return re.sub(r"[^A-Za-z0-9]", "", key)[:10] or "none"
def shoot_dir(key):
    folders = SETTINGS.setdefault("folders", {})
    if key not in folders:
        base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", (SETTINGS.get("titles", {}).get(key) or "")).strip()[:60]
        folders[key] = f"{base} ({kid(key)[:6]})" if base else f"Shoot {kid(key)[:6]}"
        save_settings()
    return ROOT / folders[key]

# ---------------------------------------------------------------- image analysis
def embedded_jpeg(path: Path) -> Image.Image:
    """Largest JPEG preview embedded in a RAW file. Every major RAW format carries one, so this works
    for brand-new camera models before the RAW library knows them."""
    data = path.read_bytes()
    best, best_area, i, tries = None, 0, 0, 0
    while tries < 80:
        i = data.find(b"\xff\xd8\xff", i)
        if i < 0: break
        tries += 1
        try:
            im = Image.open(io.BytesIO(data[i:]))
            if im.format == "JPEG" and im.width * im.height > best_area:
                best, best_area = i, im.width * im.height
        except Exception:
            pass
        i += 3
    if best is None:
        raise ValueError("no preview inside this RAW file")
    im = Image.open(io.BytesIO(data[best:])); im.load()
    return ImageOps.exif_transpose(im)

def load_image(path: Path) -> Image.Image:
    if path.suffix.lower() in RAW_EXT:
        try:
            import rawpy
            with rawpy.imread(str(path)) as raw:
                t = raw.extract_thumb()
                if t.format == rawpy.ThumbFormat.JPEG:
                    return ImageOps.exif_transpose(Image.open(io.BytesIO(t.data)))
                return Image.fromarray(t.data)
        except Exception:
            return embedded_jpeg(path)
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

class Rejected(RuntimeError):
    """Darkroom answered but refused (bad key, deleted shoot). Not a network problem."""

def call(payload, key=None, timeout=30):
    req = urllib.request.Request(FUNC, data=json.dumps({"key": key or key_now(), **payload}).encode(),
                                 headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read())
        STATUS["online"] = True
        return out
    except urllib.error.HTTPError as e:
        STATUS["online"] = True
        body = e.read().decode(errors="ignore")[:200]
        if e.code == 401:   # only "invalid key" is final; 400/429/5xx are retried
            raise Rejected(f"{e.code} {body}")
        raise RuntimeError(f"{e.code} {body}")
    except Exception:
        STATUS["online"] = False
        raise

def put(url, data: bytes):
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Content-Type": "image/jpeg", "x-upsert": "true", "apikey": CFG["publishable_key"],
        "cache-control": "max-age=31536000"})
    with urllib.request.urlopen(req, timeout=120) as r:
        r.read()

def upload(row):
    stem, c = Path(row["name"]).stem, CACHE / kid(row["shoot"])
    up = call({"action": "prepare", "name": row["name"]}, key=row["shoot"])["upload"]
    put(up["thumb"], (c / f"{stem}.thumb.jpg").read_bytes())
    put(up["preview"], (c / f"{stem}.preview.jpg").read_bytes())
    call({"action": "commit", "name": row["name"], "w": row["w"], "h": row["h"], "taken": row["taken"],
          "sharpness": row["sharpness"], "blurry": bool(row["blurry"]), "dup_of_name": row["dup_of"],
          "camera": row["camera"]}, key=row["shoot"])

wake = threading.Event()
def sync_loop():
    """Uploads every shoot's queue (switching shoots never strands photos), oldest first."""
    backoff = 2
    while True:
        wake.wait(timeout=15); wake.clear()
        for row in q("SELECT * FROM photos WHERE synced=0 AND shoot<>'' ORDER BY added"):
            try:
                upload(row)
                q("UPDATE photos SET synced=1 WHERE name=? AND shoot=?", row["name"], row["shoot"])
                print(f"  ↑ {row['name']} developed in Darkroom")
                backoff = 2
            except Rejected as e:   # shoot deleted / key revoked: park it, keep the original
                q("UPDATE photos SET synced=-1 WHERE name=? AND shoot=?", row["name"], row["shoot"])
                print(f"  ! Darkroom refused {row['name']} ({e}). Was that shoot deleted?")
            except Exception as e:
                print(f"  ! upload {row['name']} failed ({e}); retrying in {backoff}s")
                time.sleep(backoff); backoff = min(backoff * 2, 60)
                wake.set(); break

# ---------------------------------------------------------------- ingest
jobs: "queue.Queue[tuple[Path, str]]" = queue.Queue()

def file_in(path: Path, key: str):
    """Move a received file from the FTP inbox into the shoot's folder, then develop it."""
    if not key:
        return  # no shoot connected: it waits in the inbox and is assigned when one is
    path = path.resolve()
    if not path.is_file():
        return  # renamed or removed by the camera meanwhile; the rename is handled separately
    try:
        rel = path.relative_to(INBOX)        # arrived with no shoot connected: file it now
    except ValueError:
        return ingest(path, key)              # already in the shoot folder (or a hot folder): leave it there
    dest = shoot_dir(key) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(dest))
    ingest(dest, key)

def ingest(path: Path, key: str):
    ext = path.suffix.lower()
    if ext not in IMG_EXT | RAW_EXT or path.name.startswith(".") or path.name.lower().endswith(TEMP_SUFFIXES):
        return
    stem = path.stem
    existing = q("SELECT * FROM photos WHERE shoot=? AND name LIKE ?", key, stem + ".%")
    if existing:
        if ext in RAW_EXT:                                  # RAW+JPEG pair: attach RAW, keep JPEG preview
            q("UPDATE photos SET raw=? WHERE name=? AND shoot=?", str(path), existing[0]["name"], key); return
        if Path(existing[0]["name"]).suffix.lower() in RAW_EXT:
            q("DELETE FROM photos WHERE name=? AND shoot=?", existing[0]["name"], key)
        elif existing[0]["name"] == path.name and existing[0]["synced"]:
            return
    img = load_image(path)
    camera, taken = exif_info(img)
    sharp = sharpness(img)
    h = dhash(img)
    rgb = img.convert("RGB")
    c = CACHE / kid(key); c.mkdir(exist_ok=True)
    prev = rgb.copy(); prev.thumbnail((2400, 2400), Image.LANCZOS); prev.save(c / f"{stem}.preview.jpg", quality=86, optimize=True)
    th = rgb.copy(); th.thumbnail((640, 640), Image.LANCZOS); th.save(c / f"{stem}.thumb.jpg", quality=80, optimize=True)
    blurry = int(sharp < BLUR_THRESHOLD)
    # Duplicate of the closest *keeper* only (sharp and not itself a duplicate). Linking to a soft or
    # duplicate frame would hide the good shot of a burst whose first frame missed focus.
    dup_of, best = None, DUP_DISTANCE + 1
    for r in q("SELECT name, dhash, blurry, dup_of FROM photos WHERE shoot=? AND name<>? ORDER BY added DESC LIMIT 40", key, path.name):
        if not r["dhash"] or r["blurry"] or r["dup_of"]:
            continue
        d = hamming(r["dhash"], h)
        if d < best:
            dup_of, best = r["name"], d
    q("""INSERT OR REPLACE INTO photos(name,path,w,h,taken,sharpness,dhash,blurry,dup_of,camera,synced,shoot,added)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)""",
      path.name, str(path), img.width, img.height, taken or datetime.now(timezone.utc).isoformat(),
      sharp, h, blurry, dup_of, camera, key, time.time())
    STATUS["last_file"] = time.time()
    print(f"+ {path.name}  sharp={sharp:.0f}{'  BLURRY' if blurry else ''}{'  DUP' if dup_of else ''}")
    wake.set()

def worker():
    while True:
        p, key = jobs.get()
        for attempt in range(3):
            try:
                file_in(p, key); break
            except Exception as e:
                if attempt == 2: print("  ! could not read", p.name, e)
                time.sleep(1.5)

def queue_waiting():
    """Photos sitting in the inbox (received with no shoot connected, or before a crash) go to the current shoot."""
    for p in sorted(INBOX.rglob("*")):
        if p.is_file():
            jobs.put((p, key_now()))
    wake.set()

class ShootAuthorizer(DummyAuthorizer):
    """The camera's FTP folder IS the connected shoot's folder, so files land where they belong and
    are never moved while the camera may still rename or check them."""
    def get_home_dir(self, username):
        key = key_now()
        d = (shoot_dir(key) if key else INBOX).resolve()
        d.mkdir(parents=True, exist_ok=True)
        return str(d)

class CameraHandler(FTPHandler):
    shoot_key = ""
    def on_login(self, username):
        STATUS["last_camera"] = time.time()
        root = Path(self.fs.root).resolve()
        self.shoot_key = key_now() if key_now() and root == shoot_dir(key_now()).resolve() else ""
    def pre_process_command(self, line, cmd, arg):
        # Cameras keep one connection open for hours. If the photographer switches shoots meanwhile,
        # point this open connection at the new shoot's folder before the next command runs.
        if self.authenticated and self.shoot_key != key_now():
            home, cwd = self.authorizer.get_home_dir(self.username), self.fs.cwd
            self.fs = self.abstracted_fs(home, self)
            if cwd not in ("", "/"):  # a camera that cd'ed into e.g. DCIM/100CANON keeps the same place
                os.makedirs(self.fs.ftp2fs(cwd), exist_ok=True); self.fs.cwd = cwd
            self.shoot_key = key_now()
        return super().pre_process_command(line, cmd, arg)
    def on_login_failed(self, username, password):
        STATUS["login_failed"] = time.time()
    def on_file_received(self, file):
        STATUS["last_camera"] = time.time()
        if self.shoot_key: jobs.put((Path(file), self.shoot_key))
    def ftp_RNTO(self, path):  # cameras that upload "name.tmp" then rename it
        out = super().ftp_RNTO(path)
        if self.shoot_key and os.path.isfile(path): jobs.put((Path(path), self.shoot_key))
        return out
    def on_incomplete_file_received(self, file):
        try: os.remove(file)
        except OSError: pass

def run_ftp():
    try:
        _run_ftp()
    except OSError as e:
        STATUS["ftp_error"] = f"The camera port {FTP_PORT} is used by another program. Quit it and restart Darkroom Bridge."
        print("  !", STATUS["ftp_error"], e)

def _run_ftp():
    from pyftpdlib.ioloop import IOLoop
    auth = ShootAuthorizer()
    auth.add_user(FTP_USER, FTP_PASS, str(INBOX), perm="elradfmwMT")
    CameraHandler.authorizer = auth
    CameraHandler.passive_ports = range(60000, 60100)
    CameraHandler.banner = "darkroom ready"
    CameraHandler.auth_failed_timeout = 2
    if FTP_PORT2 and FTP_PORT2 != FTP_PORT:
        try:  # best effort: macOS lets apps use port 21; elsewhere it may be taken or need admin rights
            srv2 = FTPServer(("0.0.0.0", FTP_PORT2), CameraHandler, ioloop=IOLoop())
            srv2.max_cons = 32
            threading.Thread(target=srv2.serve_forever, kwargs={"handle_exit": False}, daemon=True).start()
            STATUS["port2"] = FTP_PORT2
        except OSError:
            STATUS["port2"] = None
    srv = FTPServer(("0.0.0.0", FTP_PORT), CameraHandler)
    srv.max_cons = 32
    srv.serve_forever(handle_exit=False)

def hot_folder_loop():
    """Ingests new photos that appear in a folder (where a tethering app saves: Capture One, Phocus,
    Lumix Tether, EOS Utility...). Files already there when watching starts are left alone."""
    seen, pending, watched = set(), {}, None
    while True:
        time.sleep(2)
        hf = SETTINGS.get("hot_folder")
        if not hf:
            watched = None; continue
        d = Path(hf)
        if not d.is_dir():
            continue
        try:
            files = [p for p in d.rglob("*") if p.is_file() and p.suffix.lower() in IMG_EXT | RAW_EXT]
        except OSError:
            continue
        if watched != hf:  # new folder: everything already in it is the baseline
            watched, seen, pending = hf, {str(p) for p in files}, {}
            continue
        for p in files:
            sp = str(p)
            if sp in seen: continue
            try: st = p.stat()
            except OSError: continue
            sig = (st.st_size, st.st_mtime)
            if pending.get(sp) == sig and time.time() - st.st_mtime > 1 and key_now():  # stopped growing
                seen.add(sp); pending.pop(sp, None); jobs.put((p, key_now())); STATUS["last_camera"] = time.time()
            else:
                pending[sp] = sig

def connect(key):
    """Switch to a shoot. Online: the key is checked. Offline: accepted, checked on first upload."""
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
        return False, "That doesn't look like a shoot key. Copy it from the shoot's Camera tab."
    try:
        title = call({"action": "hello"}, key=key, timeout=10).get("title")
        SETTINGS.setdefault("titles", {})[key] = title
    except Rejected:
        return False, "Darkroom doesn't recognise that key. Was the shoot deleted?"
    except Exception:
        title = None
    SETTINGS["key"] = key
    save_settings()
    shoot_dir(key)
    queue_waiting()
    print(f"  ◉ connected to {title or key[:6]}")
    return True, title

def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(("10.255.255.255", 1)); return s.getsockname()[0]
    except Exception: return "127.0.0.1"
    finally: s.close()

# ---------------------------------------------------------------- control panel (localhost only)
def ago(t):
    if not t: return "never"
    s = int(time.time() - t)
    return "just now" if s < 10 else f"{s}s ago" if s < 60 else f"{s // 60} min ago" if s < 3600 else f"{s // 3600} h ago"

CSS = """*{box-sizing:border-box}body{margin:0;background:#0f0f11;color:#ddd;font:14px/1.5 -apple-system,system-ui,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:14px 22px;border-bottom:1px solid #26262b}header b{font-size:16px;color:#fff}
.dot{width:9px;height:9px;border-radius:50%;background:#666;display:inline-block}.on{background:#3ecf6e}.off{background:#e2683c}
main{max-width:980px;margin:0 auto;padding:20px 22px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:#17171b;border:1px solid #26262b;border-radius:12px;padding:16px 18px}.wide{grid-column:1/-1}
.lab{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888}h2{margin:2px 0 8px;font-size:20px;color:#fff;font-weight:600}
.kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:15px}.kv b{color:#fff;font-family:ui-monospace,Menlo,monospace}
input{width:100%;background:#0f0f11;border:1px solid #33333a;color:#fff;border-radius:8px;padding:9px 10px;font:inherit}
button{background:#26262c;color:#fff;border:1px solid #3a3a42;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
button.p{background:#e2683c;border-color:#e2683c}.row{display:flex;gap:8px;margin-top:8px}.muted{color:#888;font-size:13px}
.warn{background:#3a2316;border:1px solid #6b3a1f;color:#f3b48f;padding:9px 12px;border-radius:8px;margin-top:10px;font-size:13px}
.stats{display:flex;gap:28px}.stats div{font-size:26px;color:#fff}.stats span{display:block;font-size:12px;color:#888}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;margin-top:10px}.g div{position:relative}
.g img{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:5px;background:#222}
.t{position:absolute;left:5px;top:5px;font-size:10px;background:#e2683c;color:#fff;padding:1px 5px;border-radius:3px}
.t.d{background:#555}@media(max-width:720px){main{grid-template-columns:1fr}}"""

def panel_html(msg=""):
    key = key_now()
    title = SETTINGS.get("titles", {}).get(key) if key else None
    ip = local_ip()
    rows = q("SELECT * FROM photos WHERE shoot=? ORDER BY added DESC", key) if key else []
    up = sum(r["synced"] == 1 for r in rows)
    waiting = sum(1 for p in INBOX.rglob("*") if p.is_file())
    online = STATUS["online"]
    pk_rows = q("SELECT name FROM photos WHERE synced=-1 ORDER BY added DESC")
    parked, parked_name = len(pk_rows), (pk_rows[0]["name"] if pk_rows else "")
    items = "".join(f'<div><img loading=lazy src="/c/{kid(key)}/{html.escape(Path(r["name"]).stem)}.thumb.jpg">'
                    f'{"<span class=t>BLUR</span>" if r["blurry"] else "<span class=\"t d\">DUP</span>" if r["dup_of"] else ""}</div>'
                    for r in rows[:60])
    bad_net = ip.startswith("192.0.0.") or ip == "127.0.0.1"
    shoot = (f'<h2>{html.escape(title or "Shoot " + key[:6])}</h2><p class=muted>Photos go to this shoot. '
             f'To switch, click <b>Connect this Mac</b> on another shoot\'s Camera tab, or paste its key:</p>') if key else \
            ('<h2>No shoot connected</h2><p class=muted>On Darkroom, open a shoot → <b>Camera</b> tab → '
             '<b>Connect this Mac</b>. Or paste the shoot key here:</p>')
    return f"""<!doctype html><meta charset=utf-8><title>Darkroom Bridge</title><meta name=viewport content="width=device-width">
<style>{CSS}</style>
<header><span class="dot {'on' if online else 'off' if online is False else ''}"></span><b>Darkroom Bridge</b>
<span class=muted>{'Online' if online else 'Offline: photos are saved and upload when you are back online' if online is False else 'Starting'} · v{VERSION}</span>
<span style="flex:1"></span><form method=post action=/quit onsubmit="return confirm('Stop the bridge? The camera will stop sending photos.')"><button>Quit</button></form></header>
<main id=live>
{f'<div class="card wide warn">{html.escape(msg)}</div>' if msg else ''}
{f'<div class="card wide warn">{html.escape(STATUS["ftp_error"])}</div>' if STATUS["ftp_error"] else ''}
{f'<div class="card wide warn">{parked} photo{"s" if parked != 1 else ""} (e.g. {html.escape(parked_name)}) couldn\'t upload because {"their shoot was" if parked != 1 else "its shoot was"} deleted on Darkroom. The originals are safe in your folder.</div>' if parked else ''}
<div class=card><div class=lab>Shoot</div>{shoot}
<form method=post action=/key class=row><input name=key placeholder="Shoot key" autocomplete=off><button class=p>Connect</button></form></div>
<div class=card><div class=lab>Enter this in your camera's FTP server settings</div>
<div class=kv style="margin-top:8px"><span>Server / Host</span><b>{ip}</b><span>Port</span><b>{FTP_PORT}{f" (or {STATUS['port2']})" if STATUS["port2"] else ""}</b>
<span>Server type</span><b>FTP</b><span>User</span><b>{html.escape(FTP_USER)}</b><span>Password</span><b>{html.escape(FTP_PASS)}</b>
<span>Passive mode</span><b>On</b><span>Secure / FTPS</span><b>Off</b><span>Folder</span><b>leave empty</b></div>
<p class=muted>Turn on automatic transfer and send <b>JPEG</b> (or HEIF). Camera last seen: <b>{ago(STATUS["last_camera"])}</b></p>
{'<div class=warn>A camera just tried the wrong user name or password. Check the two fields above.</div>' if STATUS["login_failed"] and time.time() - STATUS["login_failed"] < 120 else ''}
{'<div class=warn>Your camera password is the old shared default. <form method=post action=/newpass style="display:inline"><button>Make a private password</button></form> then enter it in the camera.</div>' if FTP_PASS == "darkroom" and not os.environ.get("DARKROOM_FTP_PASS") else ''}
{'<div class=warn>This Mac has no usable Wi-Fi address. Join a normal Wi-Fi network (not a phone hotspot or guest Wi-Fi) with the camera.</div>' if bad_net else ''}</div>
<div class="card wide"><div class=lab>This shoot</div><div class=stats style="margin-top:6px">
<div>{len(rows)} photo{"" if len(rows) == 1 else "s"}<span>received</span></div><div>{up}<span>developed in Darkroom</span></div>
<div>{len(rows) - up}<span>waiting to upload</span></div>{f'<div>{waiting}<span>waiting for a shoot</span></div>' if waiting else ''}</div>
<div class=g>{items}</div></div>
<div class="card wide"><div class=lab>Originals saved in</div>
<form method=post action=/library class=row><input name=path value="{html.escape(str(ROOT))}"><button>Change</button></form>
<div class=row><form method=post action=/reveal><button>Show in Finder</button></form><a href=/log style="margin:auto 0;color:#888">Log</a></div></div>
<div class="card wide"><div class=lab>Camera without Wi-Fi FTP? Use a hot folder</div>
<p class=muted>Shooting tethered with Capture One, Phocus, Lumix Tether, EOS Utility or similar? Point that app at a folder and enter it here. New photos that appear in it develop in the connected shoot.</p>
<form method=post action=/hotfolder class=row><input name=path placeholder="e.g. ~/Pictures/Tethered" value="{html.escape(SETTINGS.get('hot_folder') or '')}"><button>{'Change' if SETTINGS.get('hot_folder') else 'Watch'}</button></form>
{'<form method=post action=/hotfolder class=row><input type=hidden name=path value=""><button>Stop watching</button></form>' if SETTINGS.get('hot_folder') else ''}</div>
</main>
<script>setInterval(async()=>{{if(document.activeElement&&document.activeElement.tagName==='INPUT')return;
try{{const t=await (await fetch('/',{{cache:'no-store'}})).text();const d=new DOMParser().parseFromString(t,'text/html');
document.getElementById('live').replaceWith(d.getElementById('live'));document.querySelector('header').replaceWith(d.querySelector('header'))}}catch(e){{}}}},3000)</script>"""

def connect_html(key):
    title = None
    try: title = call({"action": "hello"}, key=key, timeout=10).get("title")
    except Exception: pass
    cur = key_now()
    same = cur == key
    return f"""<!doctype html><meta charset=utf-8><title>Connect · Darkroom Bridge</title><meta name=viewport content="width=device-width">
<style>{CSS} main{{display:block;max-width:520px;margin-top:8vh}}</style><main><div class=card><div class=lab>Darkroom Bridge</div>
<h2>{'Already connected to' if same else 'Connect this Mac to'} “{html.escape(title or 'shoot ' + key[:6])}”?</h2>
<p class=muted>Photos from your camera will go to this shoot.{'' if not cur or same else ' The shoot it is connected to now keeps everything it already has.'}</p>
<form method=post action=/key class=row><input type=hidden name=key value="{html.escape(key)}"><button class=p>Connect</button>
<a href="/" style="margin:auto 6px;color:#888">Cancel</a></form></div></main>"""

class Local(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="text/html; charset=utf-8", extra=()):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store"); self.send_header("X-Frame-Options", "DENY")
        for k, v in extra: self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def back(self, msg=""):
        self.send(303, "", extra=[("Location", "/" + ("?m=" + urllib.parse.quote(msg) if msg else ""))])
    LOCAL = re.compile(rf"^(localhost|127\.0\.0\.1):{WEB_PORT}$")
    def host_ok(self):  # blocks DNS-rebinding sites from reading the panel
        return bool(self.LOCAL.match(self.headers.get("Host", "")))
    def same_origin(self):  # blocks other websites from submitting the panel's forms
        o = self.headers.get("Origin")
        if o is None:
            r = self.headers.get("Referer")
            return r is None or bool(re.match(rf"^http://(localhost|127\.0\.0\.1):{WEB_PORT}/", r))
        return bool(re.match(rf"^http://(localhost|127\.0\.0\.1):{WEB_PORT}$", o))
    def do_GET(self):
        if not self.host_ok():
            return self.send(403, "forbidden", "text/plain")
        u = urllib.parse.urlparse(self.path); qs = urllib.parse.parse_qs(u.query)
        if u.path.startswith("/c/"):
            parts = urllib.parse.unquote(u.path[3:]).split("/")
            if len(parts) == 2:
                f = CACHE / Path(parts[0]).name / Path(parts[1]).name
                if f.is_file() and f.suffix == ".jpg":
                    return self.send(200, f.read_bytes(), "image/jpeg")
            return self.send(404, "not found", "text/plain")
        if u.path == "/connect" and qs.get("key"):
            return self.send(200, connect_html(qs["key"][0]))
        if u.path == "/status.json":
            key = key_now()
            return self.send(200, json.dumps({"app": "darkroom-bridge", "version": VERSION, "key": key[:6] if key else None,
                                              "online": STATUS["online"]}), "application/json",
                             extra=[("Access-Control-Allow-Origin", "*")])
        if u.path == "/log":
            f = STATE / "bridge.log"
            return self.send(200, f.read_text(errors="ignore")[-20000:] if f.exists() else "(no log: running in a terminal)", "text/plain; charset=utf-8")
        if u.path == "/":
            return self.send(200, panel_html(qs.get("m", [""])[0]))
        self.send(404, "not found", "text/plain")
    def do_POST(self):
        global ROOT, FTP_PASS
        if not (self.host_ok() and self.same_origin()):
            return self.send(403, "Blocked: requests must come from the bridge's own page.", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(min(n, 4096)).decode(errors="ignore")).items()}
        if self.path == "/key":
            ok, info = connect(form.get("key", ""))
            return self.back("" if ok else info)
        if self.path == "/library":
            p = Path(form.get("path", "")).expanduser()
            try:
                p.mkdir(parents=True, exist_ok=True); t = p / ".darkroom-write-test"; t.write_text("ok"); t.unlink()
            except Exception as e:
                return self.back(f"Can't save there ({e.__class__.__name__}). Is the drive plugged in?")
            ROOT = p; SETTINGS["library"] = str(p); SETTINGS.pop("folders", None); save_settings()
            return self.back(f"New photos will be saved in {p}")
        if self.path == "/hotfolder":
            p = form.get("path", "").strip()
            if not p:
                SETTINGS.pop("hot_folder", None); save_settings(); return self.back("Stopped watching the hot folder.")
            d = Path(p).expanduser()
            if not d.is_dir():
                return self.back(f"There's no folder at {d}.")
            SETTINGS["hot_folder"] = str(d.resolve()); save_settings()
            return self.back(f"Watching {d}. New photos that appear there go to the connected shoot.")
        if self.path == "/newpass":
            import secrets
            FTP_PASS = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))
            SETTINGS["ftp_pass"] = FTP_PASS; save_settings()
            CameraHandler.authorizer.user_table[FTP_USER]["pwd"] = FTP_PASS
            return self.back("New camera password set. Enter it in your camera's FTP settings.")
        if self.path == "/reveal":
            d = shoot_dir(key_now()) if key_now() else ROOT
            d.mkdir(parents=True, exist_ok=True)
            if sys.platform == "darwin": subprocess.Popen(["open", str(d)])
            return self.back()
        if self.path == "/quit":
            self.send(200, "<meta charset=utf-8><body style='background:#0f0f11;color:#ddd;font:15px system-ui;padding:40px'>"
                           "Darkroom Bridge stopped. Open the app again to keep receiving photos.")
            threading.Timer(0.3, lambda: os._exit(0)).start(); return
        self.send(404, "not found", "text/plain")

def already_running():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/status.json", timeout=1) as r:
            return json.loads(r.read()).get("app") == "darkroom-bridge"
    except Exception:
        return False

_LOCK = None
def single_instance():
    """True if this is the only bridge using this state folder (an OS lock: released when the process dies)."""
    global _LOCK
    import fcntl
    _LOCK = open(STATE / "bridge.lock", "w")
    try:
        fcntl.flock(_LOCK, fcntl.LOCK_EX | fcntl.LOCK_NB); _LOCK.write(str(os.getpid())); _LOCK.flush(); return True
    except OSError:
        return False

def main():
    url = f"http://localhost:{WEB_PORT}"
    print(f"  start pid={os.getpid()} ppid={os.getppid()} argv={sys.argv[1:]}")
    if not single_instance():
        print("  Darkroom Bridge is already running:", url)
        if APP and not os.environ.get("DARKROOM_NO_BROWSER"): webbrowser.open(url)
        return
    if already_running():
        if APP and not os.environ.get("DARKROOM_NO_BROWSER"): webbrowser.open(url)
        print("  Darkroom Bridge is already running:", url); return
    if sys.platform == "darwin":  # keep the Mac awake while the bridge runs (lid open)
        try: subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        except Exception: pass
    if key_now():
        try:
            title = call({"action": "hello"}, timeout=10).get("title")
            SETTINGS.setdefault("titles", {})[key_now()] = title; save_settings()
        except Exception as e:
            print(f"\n  ! Couldn't reach Darkroom ({e}). Photos will be kept and uploaded once online.")
        shoot_dir(key_now())
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=sync_loop, daemon=True).start()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", WEB_PORT), Local)
    except OSError as e:
        print(f"  ! Port {WEB_PORT} is used by another program ({e}). Quit it and open Darkroom Bridge again."); return
    threading.Thread(target=run_ftp, daemon=True).start()
    threading.Thread(target=hot_folder_loop, daemon=True).start()
    queue_waiting()
    ip, key = local_ip(), key_now()
    print(f"\n  ◉ Darkroom bridge v{VERSION}")
    print(f"    Shoot     {SETTINGS.get('titles', {}).get(key) or (key[:6] if key else 'none yet: connect one from the shoot Camera tab')}")
    print(f"    Originals {ROOT}")
    if ip.startswith("192.0.0.") or ip == "127.0.0.1":
        print("    ! No usable local network address. Join a normal Wi-Fi network (not a carrier hotspot).")
    print(f"\n    Camera → Network → FTP Transfer Func. → Server 1")
    print(f"      Host {ip}   Port {FTP_PORT}   User {FTP_USER}   Password {FTP_PASS}   Passive ON   Secure OFF")
    print(f"\n    Control panel {url}   ·   Ctrl+C to stop\n")
    if APP and not os.environ.get("DARKROOM_NO_BROWSER"):
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    if APP and sys.platform == "darwin":
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            return menubar(url)
        except Exception as e:  # no menu bar available: keep running headless
            print("  (menu bar unavailable:", e, ")")
            while True: time.sleep(3600)
    srv.serve_forever()

def menubar(url):
    """◉ in the Mac menu bar: shows how many photos are waiting, opens the panel, quits."""
    import rumps
    class Bar(rumps.App):
        def __init__(self):
            super().__init__("Darkroom Bridge", title="◉", quit_button=None)
            self.menu = ["Open Darkroom Bridge", None, "Quit Darkroom Bridge"]
        @rumps.clicked("Open Darkroom Bridge")
        def open_panel(self, _): webbrowser.open(url)
        @rumps.clicked("Quit Darkroom Bridge")
        def quit_app(self, _): os._exit(0)
        @rumps.timer(4)
        def tick(self, _):
            n = q("SELECT count(*) AS n FROM photos WHERE synced=0 AND shoot<>''")[0]["n"]
            self.title = "◉" + (f" ↑{n}" if n else "") + ("" if STATUS["online"] is not False else " offline")
    Bar().run()

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\n  stopped")
