// Layflat album engine: layouts, auto-layout, print-PDF export.
// Rects are [x, y, w, h] as fractions of the whole spread (two facing pages).

const page = (side, [x, y, w, h]) => [side * 0.5 + x * 0.5, y, w * 0.5, h];
const L = (r) => page(0, r), R = (r) => page(1, r);

export const LAYOUTS = {
  full:     { label: "Full spread",          rects: [[0, 0, 1, 1]] },
  two:      { label: "One per page",         rects: [L([0, 0, 1, 1]), R([0, 0, 1, 1])] },
  framed:   { label: "Framed pair",          rects: [L([0.12, 0.12, 0.76, 0.76]), R([0.12, 0.12, 0.76, 0.76])] },
  "one-two":{ label: "1 + 2 stacked",        rects: [L([0, 0, 1, 1]), R([0.08, 0.06, 0.84, 0.42]), R([0.08, 0.52, 0.84, 0.42])] },
  "two-two":{ label: "2 + 2 stacked",        rects: [L([0.08, 0.06, 0.84, 0.42]), L([0.08, 0.52, 0.84, 0.42]), R([0.08, 0.06, 0.84, 0.42]), R([0.08, 0.52, 0.84, 0.42])] },
  hero:     { label: "Small + full",         rects: [L([0.22, 0.28, 0.56, 0.44]), R([0, 0, 1, 1])] },
  grid:     { label: "Grid of 6",            rects: [0, 1].flatMap((s) => [0, 1, 2].map((r) => page(s, [0.08, 0.05 + r * 0.31, 0.84, 0.28]))) },
};

export const SIZES = {
  "12x12":  { w: 12, h: 12, label: "12×12 in (24×12 spread)" },
  "10x10":  { w: 10, h: 10, label: "10×10 in (20×10 spread)" },
  "8x8":    { w: 8,  h: 8,  label: "8×8 in (16×8 spread)" },
  "11x8.5": { w: 11, h: 8.5, label: "11×8.5 in landscape" },
  "8.5x11": { w: 8.5, h: 11, label: "8.5×11 in portrait" },
};

const landscape = (p) => (p.w || 3) >= (p.h || 2);

// Story-order auto layout: opens big, varies rhythm, gives landscapes the full spreads.
export function autoLayout(photos) {
  const rhythm = ["full", "two", "one-two", "framed", "two-two", "hero", "two", "one-two"];
  const spreads = [];
  let i = 0, step = 0;
  while (i < photos.length) {
    let layout = rhythm[step % rhythm.length];
    if (layout === "full" && !landscape(photos[i])) layout = "two";
    const n = LAYOUTS[layout].rects.length;
    const slots = photos.slice(i, i + n).map((p) => p.id);
    while (slots.length < n) slots.push(null);
    spreads.push({ layout, slots });
    i += n; step++;
  }
  return spreads;
}

async function loadBitmap(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`image ${res.status}`);
  return createImageBitmap(await res.blob());
}

// Cover-crop an image into a w×h canvas and return JPEG data.
function coverJpeg(bmp, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const s = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s, dh = bmp.height * s;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c.toDataURL("image/jpeg", 0.92);
}

export async function exportPdf(album, photos, title, progress = () => {}) {
  if (!window.jspdf) throw new Error("PDF library still loading, try again in a second");
  const size = SIZES[album.size] || SIZES["12x12"];
  const W = size.w * 2 * 72, H = size.h * 72;                 // points
  const DPI = 200;                                             // per-slot render resolution cap
  const pdf = new window.jspdf.jsPDF({ orientation: W >= H ? "landscape" : "portrait", unit: "pt", format: [W, H], compress: true });
  const cache = new Map();
  for (let i = 0; i < album.spreads.length; i++) {
    progress(i + 1, album.spreads.length);
    if (i) pdf.addPage([W, H], W >= H ? "landscape" : "portrait");
    pdf.setFillColor(255, 255, 255); pdf.rect(0, 0, W, H, "F");
    const sp = album.spreads[i];
    const rects = LAYOUTS[sp.layout]?.rects || [];
    for (let j = 0; j < rects.length; j++) {
      const p = sp.slots[j] && photos.get(sp.slots[j]);
      if (!p) continue;
      const [x, y, w, h] = rects[j];
      const pw = w * W, ph = h * H;
      if (!cache.has(p.id)) cache.set(p.id, await loadBitmap(p.preview_url));
      const bmp = cache.get(p.id);
      const scale = Math.min((DPI / 72), Math.max(bmp.width / pw, bmp.height / ph));
      pdf.addImage(coverJpeg(bmp, Math.round(pw * scale), Math.round(ph * scale)), "JPEG", x * W, y * H, pw, ph, undefined, "FAST");
    }
  }
  pdf.save(`${title.replace(/[^\w\- ]+/g, "").trim() || "album"} - album.pdf`);
}
