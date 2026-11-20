"""Bridge against a fake Darkroom API: uploads, two shoots, real titles, a deleted shoot. Usage: python3 tests/bridge_online.py bridge/bridge.py <round>"""
import ftplib, io, json, os, signal, sqlite3, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image
BRIDGE, ROUND = Path(sys.argv[1]), int(sys.argv[2])
API, FTP_PORT, WEB_PORT = 9400 + ROUND, 2400 + ROUND, 8400 + ROUND
SHOOTS = {"a" * 24: "Smith Wedding", "b" * 24: "Lee Engagement"}   # "c"*24 = deleted
got = {"put": [], "commit": []}; R = []
def ok(n, c, i=""): R.append(f"{'PASS' if c else 'FAIL'} {n}{' — ' + str(i) if i != '' else ''}")
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_PUT(self):
        n = int(self.headers["Content-Length"]); data = self.rfile.read(n); got["put"].append((self.path, len(data))); self.reply(200, {})
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if b["key"] not in SHOOTS: return self.reply(401, {"error": "invalid key"})
        if b["action"] == "hello": return self.reply(200, {"title": SHOOTS[b["key"]]})
        if b["action"] == "prepare":
            base = f"http://127.0.0.1:{API}/up/{b['key'][:1]}/{b['name']}"
            return self.reply(200, {"upload": {"thumb": base + ".t", "preview": base + ".p"}})
        if b["action"] == "commit": got["commit"].append((b["key"][:1], b["name"])); return self.reply(200, {"id": 1})
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", API), Fake).serve_forever, daemon=True).start()
lib = Path(tempfile.mkdtemp(prefix=f"dron{ROUND}_"))
env = {**os.environ, "DARKROOM_API": f"http://127.0.0.1:{API}", "DARKROOM_LIBRARY": str(lib), "DARKROOM_KEY": "a" * 24,
       "DARKROOM_FTP_PORT": str(FTP_PORT), "DARKROOM_WEB_PORT": str(WEB_PORT), "PYTHONUNBUFFERED": "1",
       "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
p = subprocess.Popen([sys.executable, str(BRIDGE)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for _ in range(60):
    try: urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/", timeout=1); break
    except Exception: time.sleep(0.25)
def jpg(c):
    b = io.BytesIO(); Image.new("RGB", (1200, 800), c).save(b, "JPEG"); return b.getvalue()
def send(names, c):
    f = ftplib.FTP(); f.connect("127.0.0.1", FTP_PORT); f.login("sony", "darkroom")
    for n in names: f.storbinary(f"STOR {n}", io.BytesIO(jpg(c)))
    f.quit()
def setkey(k):
    r = urllib.request.Request(f"http://127.0.0.1:{WEB_PORT}/key", data=f"key={k}".encode(), method="POST", headers={"Origin": f"http://localhost:{WEB_PORT}"})
    class N(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try: urllib.request.build_opener(N).open(r)
    except urllib.error.HTTPError as e: return e.headers.get("Location", "")
def wait(cond, t=25):
    for _ in range(t * 4):
        if cond(): return True
        time.sleep(0.25)
    return False
try:
    panel = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/").read().decode()
    ok("O1 panel shows real shoot title + Online", "Smith Wedding" in panel and "Online" in panel)
    send(["A1.JPG", "A2.JPG"], (200, 30, 30))
    ok("O2 photos uploaded (thumb+preview) and committed", wait(lambda: len(got["commit"]) == 2) and len(got["put"]) == 4, got["commit"])
    ok("O3 originals in 'Smith Wedding (aaaaaa)'", (lib / "Smith Wedding (aaaaaa)/A1.JPG").exists())
    loc = setkey("c" * 24)
    ok("O4 deleted shoot's key refused with a message", loc and "recognise" in urllib.parse.unquote(loc), loc)
    setkey("b" * 24); send(["A1.JPG"], (30, 30, 200))
    ok("O5 switch: same file name uploads to the new shoot", wait(lambda: ("b", "A1.JPG") in got["commit"]), got["commit"])
    ok("O6 new shoot folder uses its title", (lib / "Lee Engagement (bbbbbb)/A1.JPG").exists())
    db = sqlite3.connect(lib / "darkroom.db")
    ok("O7 everything marked uploaded", db.execute("select count(*) from photos where synced<>1").fetchone()[0] == 0); db.close()
    # a shoot deleted after photos were taken: those photos park, others keep flowing
    db = sqlite3.connect(lib / "darkroom.db"); db.execute("insert into photos(name,path,shoot,synced,added,w,h) values('Z.JPG','x','" + "c" * 24 + "',0,0,1,1)"); db.commit(); db.close()
    setkey("a" * 24); send(["A3.JPG"], (30, 200, 30))
    ok("O8 deleted-shoot photo parked, queue not blocked", wait(lambda: ("a", "A3.JPG") in got["commit"]))
    panel = urllib.request.urlopen(f"http://127.0.0.1:{WEB_PORT}/").read().decode()
    ok("O9 panel warns about the refused photo", "Z.JPG" in panel and "deleted on Darkroom" in panel)
finally:
    p.send_signal(signal.SIGINT); out = p.communicate(timeout=10)[0]
ok("O10 no crash", "Traceback" not in out, out[-400:])
print("\n".join(R)); print(f"\nONLINE ROUND {ROUND}: {sum(x.startswith('PASS') for x in R)}/{len(R)} passed")
