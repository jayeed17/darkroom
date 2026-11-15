# ◉ Darkroom

**Shoot on your Sony. Watch every frame develop live. Cull, share a proofing link, design the album.**

Darkroom is a minimal, open-source alternative to tools like Zno and Pixieset for working photographers:

| | |
|---|---|
| **Live ingest** | Sony FX3 / a7 IV / a7R V push each shot over Wi-Fi FTP to the bridge on your laptop, which develops it into the cloud gallery within seconds. |
| **Smart cull** | Exposure-independent blur detection (dark-but-sharp frames aren't flagged) and near-duplicate detection. Star your keepers. |
| **Client proofing** | One link, no client accounts. Clients ♥ favorites and comment; you see it live and reply. |
| **Album designer** | Layflat spreads (12×12, 10×10, 8×8, 11×8.5), seven layouts, story-order auto-layout, drag-and-drop. |
| **Print PDF** | One PDF per album, spread-sized pages, ready for any lab. |

## How it fits together

```
 Sony camera ──FTP/Wi-Fi──▶ bridge/ (your Mac) ──HTTPS──▶ Supabase (Postgres · Storage · Realtime · Edge Function)
                               │ originals stay on your SSD                    ▲
                               ▼                                                │
                         thumb + 2400px preview                web/ on Vercel ──┘  (you + your clients, anywhere)
```

* `web/` static app (no build step). Vanilla JS modules, Supabase JS, jsPDF. Deployed on Vercel.
* `bridge/` Python. FTP server for the camera, sharpness/duplicate scoring, offline-safe upload queue.
* `supabase/` schema + RLS (`migrations/`) and the `ingest` Edge Function. The bridge authenticates with a per-shoot key, and the service key never leaves Supabase.

## Use it

1. Open the web app, create an account, and click **+ New shoot**.
2. On your Mac:
   ```bash
   git clone https://github.com/jayeed17/darkroom
   cd darkroom/bridge
   ./start.sh <SHOOT_KEY>                      # key is on the shoot's Camera tab
   ./start.sh <SHOOT_KEY> /Volumes/SSD/Darkroom  # optional: keep originals on your SSD
   ```
3. Camera: **Network → FTP Transfer Func. → Server 1**
   Host = IP printed by the bridge · Port `2121` · User `sony` · Password `darkroom` · Secure **Off** · Passive **On**,
   then **FTP Function On**, **Auto FTP Transfer On**, Transfer Target **JPEG**.
4. Shoot. Photos develop in the gallery. Star keepers → **Client proofing** → turn sharing on → send the link.
5. **Album** → Auto-layout → tweak → **Export print PDF**.

### Network notes
The camera and the Mac must be on the same network, and the network must allow devices to see each other.
Guest Wi-Fi and some carrier hotspots (IPv6-only, which shows up as a `192.0.0.2` address) block this.
On location, a pocket travel router (GL.iNet Opal/Mango) is the reliable setup; it needs no internet to receive,
and uploads resume when the laptop is back online.

### Tuning
`DARKROOM_BLUR` (default `11`) sets the blur threshold: higher flags more. `DARKROOM_FTP_PASS` changes the camera password.

## Develop

```bash
cd web && python3 -m http.server 5173     # http://localhost:5173
```
Database changes go in `supabase/migrations/`. Edge Function source is in `supabase/functions/ingest/`.

## Roadmap
- [ ] Full-resolution originals to cloud storage (R2) for print-final PDFs
- [ ] Cloud FTP endpoint so the camera can upload with no laptop
- [ ] Watermarks + download permissions on proofing galleries
- [ ] Native iOS/Android app
- [ ] Lab ordering integration

MIT licensed.
