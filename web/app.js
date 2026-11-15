import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { LAYOUTS, SIZES, autoLayout, exportPdf } from "./album.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
let teardown = [];
const onLeave = (fn) => teardown.push(fn);

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { prompt("Copy this:", text); } }
const LOGO = `<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1e1e22"/><circle cx="16" cy="16" r="8" fill="none" stroke="#e8c07a" stroke-width="2.5"/><circle cx="16" cy="16" r="3" fill="#e8c07a"/></svg>`;

async function route() {
  teardown.forEach((f) => { try { f(); } catch {} }); teardown = [];
  closeLb();
  const hash = location.hash.slice(1) || "/";
  const [, a, b, c] = hash.split("/");
  if (a === "p" && b) return proofView(b);
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return authView();
  if (a === "s" && b) return shootView(b, c || "gallery");
  return homeView(session);
}
addEventListener("hashchange", route);
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") route(); });

function authView() {
  let mode = "in";
  app.replaceChildren(h(`<div class="auth"><div class="auth-box">
    <a class="brand" href="#/">${LOGO} Darkroom</a>
    <h1>Shoot.<br>Watch it develop.</h1>
    <p class="lede">Your Sony sends every frame here as you shoot. Cull, share a proofing link, and design the album in one place.</p>
    <form id="f">
      <input class="input" name="email" type="email" placeholder="Email" autocomplete="email" required>
      <input class="input" name="pw" type="password" placeholder="Password (8+ characters)" minlength="8" autocomplete="current-password" required>
      <div class="err" id="err"></div>
      <button class="btn primary" id="go" type="submit" style="justify-content:center;padding:11px">Sign in</button>
    </form>
    <div class="switch" id="sw"></div>
  </div></div>`));
  const sw = $("#sw"), go = $("#go"), err = $("#err");
  const paint = () => {
    go.textContent = mode === "in" ? "Sign in" : "Create account";
    sw.innerHTML = mode === "in" ? `New here? <button type="button">Create an account</button>` : `Have an account? <button type="button">Sign in</button>`;
    sw.querySelector("button").onclick = () => { mode = mode === "in" ? "up" : "in"; err.textContent = ""; paint(); };
  };
  paint();
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); err.textContent = ""; err.style.color = ""; go.disabled = true;
    const email = e.target.email.value.trim(), password = e.target.pw.value;
    const { data, error } = mode === "in"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
    go.disabled = false;
    if (error) { err.textContent = error.message; return; }
    if (mode === "up" && !data.session) {
      err.style.color = "var(--good)";
      err.textContent = "Check your email to confirm, then come back and sign in.";
      mode = "in"; paint();
    }
  };
}

async function homeView(session) {
  app.replaceChildren(h(`<div>
    <header class="top"><a class="brand" href="#/">${LOGO} Darkroom</a><span class="sp"></span>
      <span class="crumb">${esc(session.user.email)}</span><button class="btn ghost small" id="out">Sign out</button></header>
    <main><div class="wrap">
      <div class="bar"><div><div class="label">Your shoots</div><h1 class="h1">Shoots</h1></div><span class="sp"></span>
        <button class="btn primary" id="new">+ New shoot</button></div>
      <div class="shoots" id="list"><div class="muted">Loading…</div></div>
    </div></main></div>`));
  $("#out").onclick = () => sb.auth.signOut();
  $("#new").onclick = async () => {
    const title = prompt("Shoot name", "Untitled shoot"); if (title === null) return;
    const { data, error } = await sb.from("shoots").insert({ title: title.trim() || "Untitled shoot" }).select("id").single();
    if (error) return toast(error.message);
    location.hash = `#/s/${data.id}/bridge`;
  };
  const { data: shoots, error } = await sb.from("shoots").select("id,title,created_at").order("created_at", { ascending: false });
  const list = $("#list");
  if (error) { list.innerHTML = `<div class="err">${esc(error.message)}</div>`; return; }
  if (!shoots.length) {
    list.replaceWith(h(`<div class="empty"><h2>No shoots yet</h2><p>Create a shoot, connect your camera, and photos appear here as you take them.</p></div>`));
    return;
  }
  const { data: covers } = await sb.from("photos").select("shoot_id,thumb_url,star").in("shoot_id", shoots.map((s) => s.id)).order("star", { ascending: false }).limit(1000);
  const cover = {}, counts = {};
  (covers || []).forEach((p) => { cover[p.shoot_id] ??= p.thumb_url; counts[p.shoot_id] = (counts[p.shoot_id] || 0) + 1; });
  list.replaceChildren(...shoots.map((s) => h(`<a class="shoot" href="#/s/${s.id}">
    <div class="cover" style="${cover[s.id] ? `background-image:url('${esc(cover[s.id])}')` : ""}">${cover[s.id] ? "" : "Waiting for photos"}</div>
    <div class="meta"><h3>${esc(s.title)}</h3><div class="muted" style="font-size:12.5px">${new Date(s.created_at).toLocaleDateString()} · ${counts[s.id] || 0} photos</div></div></a>`)));
}

async function shootView(id, tab) {
  const { data: shoot, error } = await sb.from("shoots").select("*").eq("id", id).maybeSingle();
  if (error || !shoot) { app.replaceChildren(h(`<div class="empty"><h2>Shoot not found</h2><p><a href="#/">Back to shoots</a></p></div>`)); return; }
  const tabs = [["gallery", "Gallery"], ["album", "Album"], ["share", "Client proofing"], ["bridge", "Camera"]];
  app.replaceChildren(h(`<div>
    <header class="top"><a class="brand" href="#/">${LOGO}</a><span class="crumb"><a href="#/" style="text-decoration:none">Shoots</a> /</span>
      <input class="title-in" id="title" value="${esc(shoot.title)}" aria-label="Shoot name"><span class="sp"></span>
      <span class="live" id="live"><span class="dot"></span><span id="liveTxt">connecting</span></span></header>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/s/${id}/${k}" ${k === tab ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <div id="body"></div></div>`));
  $("#title").onchange = async (e) => {
    const t = e.target.value.trim() || "Untitled shoot";
    await sb.from("shoots").update({ title: t }).eq("id", id); toast("Renamed");
  };
  const state = { shoot, photos: new Map(), comments: [] };
  const [{ data: photos }, { data: comments }] = await Promise.all([
    sb.from("photos").select("*").eq("shoot_id", id),
    sb.from("comments").select("*").eq("shoot_id", id).order("created_at"),
  ]);
  (photos || []).forEach((p) => state.photos.set(p.id, p));
  state.comments = comments || [];

  let rerender = () => {};
  const ch = sb.channel(`shoot-${id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos", filter: `shoot_id=eq.${id}` }, (pl) => {
      if (pl.eventType === "DELETE") state.photos.delete(pl.old.id);
      else { const isNew = !state.photos.has(pl.new.id); state.photos.set(pl.new.id, pl.new); if (isNew) state.fresh = pl.new.id; }
      rerender("photos");
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter: `shoot_id=eq.${id}` }, (pl) => {
      if (!state.comments.some((c) => c.id === pl.new.id)) state.comments.push(pl.new);
      rerender("comments");
    })
    .subscribe((st) => {
      const on = st === "SUBSCRIBED";
      $("#live")?.classList.toggle("on", on);
      if ($("#liveTxt")) $("#liveTxt").textContent = on ? "live" : "reconnecting";
    });
  onLeave(() => sb.removeChannel(ch));

  const body = $("#body");
  if (tab === "gallery") rerender = galleryTab(body, state);
  else if (tab === "album") rerender = albumTab(body, state);
  else if (tab === "share") rerender = shareTab(body, state);
  else rerender = bridgeTab(body, state);
}

function galleryTab(body, state) {
  let filter = "all";
  body.replaceChildren(h(`<main><div class="bar">
      <div class="seg" id="flt">
        <button data-f="all" aria-pressed="true">All</button><button data-f="keep" aria-pressed="false">Keepers</button>
        <button data-f="star" aria-pressed="false">★ Starred</button><button data-f="pick" aria-pressed="false">♥ Client picks</button>
        <button data-f="flag" aria-pressed="false">Flagged</button></div>
      <span class="count" id="cnt"></span></div>
    <div class="grid" id="grid"></div><div id="empty"></div></main>`));
  const vis = (p) => filter === "all" || (filter === "star" ? p.star : filter === "pick" ? p.pick : filter === "keep" ? !p.blurry && !p.dup_of : p.blurry || p.dup_of);
  const sorted = () => [...state.photos.values()].sort((a, b) => new Date(b.taken) - new Date(a.taken) || b.id - a.id);
  const ccount = () => { const m = {}; state.comments.forEach((c) => (m[c.photo_id] = (m[c.photo_id] || 0) + 1)); return m; };
  const render = () => {
    const list = sorted().filter(vis), cc = ccount();
    $("#grid").replaceChildren(...list.map((p) => {
      const el = h(`<div class="ph ${p.blurry || p.dup_of ? "dim" : ""} ${state.fresh === p.id ? "new" : ""}">
        <img loading="lazy" alt="" src="${esc(p.thumb_url)}">
        <div class="tags">${p.blurry ? '<span class="tag w">BLUR</span>' : ""}${p.dup_of ? '<span class="tag w">DUP</span>' : ""}${p.pick ? '<span class="tag p">♥ CLIENT</span>' : ""}${cc[p.id] ? `<span class="tag c">💬 ${cc[p.id]}</span>` : ""}</div>
        <button class="star ${p.star ? "on" : ""}" title="Star (S)">★</button></div>`);
      const img = el.querySelector("img"); img.onload = () => img.classList.add("ok"); if (img.complete) img.classList.add("ok");
      el.querySelector(".star").onclick = (e) => { e.stopPropagation(); toggleStar(p); };
      el.onclick = () => openLb(list.map((x) => x.id), p.id, ownerLb(state));
      return el;
    }));
    state.fresh = null;
    const all = [...state.photos.values()];
    $("#cnt").textContent = `${all.length} shots · ${all.filter((p) => p.star).length} ★ · ${all.filter((p) => p.pick).length} ♥ · ${all.filter((p) => p.blurry || p.dup_of).length} flagged`;
    $("#empty").innerHTML = all.length ? "" : `<div class="empty"><h2>Waiting for your camera</h2><p>Open the <a href="#/s/${state.shoot.id}/bridge">Camera</a> tab to connect your Sony. Photos develop here the moment you take them.</p></div>`;
  };
  async function toggleStar(p) {
    p.star = !p.star; render();
    const { error } = await sb.from("photos").update({ star: p.star }).eq("id", p.id);
    if (error) { p.star = !p.star; render(); toast(error.message); }
  }
  state.toggleStar = toggleStar;
  $("#flt").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f;
    $("#flt").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); render();
  };
  render();
  return () => { render(); lbRefresh(); };
}

function ownerLb(state) {
  return {
    get: (id) => state.photos.get(id),
    comments: (id) => state.comments.filter((c) => c.photo_id === id),
    head: (p) => `<button class="btn small" data-act="star">${p.star ? "★ Starred" : "☆ Star"}</button>${p.pick ? '<span class="tag p">♥ Client pick</span>' : ""}`,
    act: (p, act) => act === "star" && state.toggleStar(p),
    send: async (p, text) => {
      const { data, error } = await sb.from("comments").insert({ shoot_id: state.shoot.id, photo_id: p.id, author: "Photographer", body: text, from_owner: true }).select().single();
      if (error) return toast(error.message);
      if (!state.comments.some((c) => c.id === data.id)) state.comments.push(data);
    },
    info: (p) => `${esc(p.name)} · ${esc(p.camera || "")} · sharpness ${Math.round(p.sharpness || 0)}${p.blurry ? " · blurry" : ""}${p.dup_of ? " · duplicate" : ""}`,
    keys: { s: "star" },
  };
}

let LB = null;
function openLb(ids, id, api) { LB = { ids, id, api }; $("#lb").hidden = false; lbRefresh(); }
function closeLb() { LB = null; const lb = $("#lb"); if (lb) { lb.hidden = true; lb.innerHTML = ""; } }
function lbRefresh() {
  if (!LB) return;
  const p = LB.api.get(LB.id); if (!p) return closeLb();
  const cmts = LB.api.comments(p.id);
  const lb = $("#lb");
  const draft = lb.querySelector("textarea")?.value || "";
  lb.innerHTML = `<div class="stage"><img src="${esc(p.preview_url || p.preview)}" alt="">
      <button class="nav l" data-nav="-1" aria-label="Previous">‹</button><button class="nav r" data-nav="1" aria-label="Next">›</button>
      <div class="info">${LB.api.info(p)} · ← → to browse · Esc to close</div></div>
    <aside><div class="head">${LB.api.head(p)}<span class="sp"></span><button class="btn small ghost" data-act="close">Close</button></div>
      <div class="list">${cmts.length ? cmts.map((c) => `<div class="cmt ${c.from_owner ? "own" : ""}"><b>${esc(c.author)}</b><p>${esc(c.body)}</p></div>`).join("") : '<div class="muted">No comments yet.</div>'}</div>
      <form><textarea class="input" rows="2" placeholder="Add a comment…" required></textarea><button class="btn primary small" style="justify-self:end">Send</button></form></aside>`;
  const ta = lb.querySelector("textarea"); ta.value = draft;
  lb.querySelector(".stage").onclick = (e) => { if (e.target.classList.contains("stage")) closeLb(); };
  lb.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => lbStep(+b.dataset.nav)));
  lb.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (b.dataset.act === "close" ? closeLb() : (LB.api.act(p, b.dataset.act), setTimeout(lbRefresh, 30)))));
  lb.querySelector("form").onsubmit = async (e) => {
    e.preventDefault(); const t = ta.value.trim(); if (!t) return;
    ta.value = ""; await LB.api.send(p, t); lbRefresh();
  };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); lb.querySelector("form").requestSubmit(); } };
}
function lbStep(d) { if (!LB) return; const i = LB.ids.indexOf(LB.id) + d; if (i >= 0 && i < LB.ids.length) { LB.id = LB.ids[i]; lbRefresh(); } }
addEventListener("keydown", (e) => {
  if (!LB || e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (e.key === "Escape") closeLb();
  else if (e.key === "ArrowRight") lbStep(1);
  else if (e.key === "ArrowLeft") lbStep(-1);
  else if (LB.api.keys[e.key.toLowerCase()]) { LB.api.act(LB.api.get(LB.id), LB.api.keys[e.key.toLowerCase()]); setTimeout(lbRefresh, 30); }
});

function shareTab(body, state) {
  const s = state.shoot;
  const url = `${location.origin}/#/p/${s.share_token}`;
  body.replaceChildren(h(`<main><div class="wrap panel-grid">
    <div class="card"><div class="switch-row"><div><div class="label">Proofing link</div><h3 style="margin:4px 0 0;font-family:var(--serif);font-weight:500">Share with your clients</h3></div>
      <button class="toggle" id="tg" role="switch" aria-checked="${s.sharing}" aria-label="Sharing on/off"></button></div>
      <p class="muted">Clients open the link with no account, heart their favorites and leave comments. They see your <b>starred</b> photos; if nothing is starred, every photo that isn't flagged.</p>
      <div class="kv"><input class="input" readonly value="${esc(url)}"><button class="btn" id="cp">Copy</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
      <p class="muted" id="st" style="margin-bottom:0"></p></div>
    <div class="card"><div class="label">Client activity</div><div id="act" style="margin-top:10px"></div></div>
  </div></main>`));
  const paint = () => {
    $("#tg").setAttribute("aria-checked", s.sharing);
    $("#st").textContent = s.sharing ? "Sharing is on. Anyone with the link can view and pick." : "Sharing is off. The link shows nothing until you turn it on.";
    const all = [...state.photos.values()], picks = all.filter((p) => p.pick), cl = state.comments.filter((c) => !c.from_owner);
    $("#act").innerHTML = `<div style="font-size:28px;font-family:var(--serif)">${picks.length} <span class="muted" style="font-size:14px">favorites</span> · ${cl.length} <span class="muted" style="font-size:14px">comments</span></div>
      ${picks.length ? `<p><a href="#/s/${s.id}/gallery">See client picks in the Gallery →</a></p>` : ""}
      ${cl.slice(-5).reverse().map((c) => `<div class="cmt" style="margin-top:8px"><b>${esc(c.author)}</b> on ${esc(state.photos.get(c.photo_id)?.name || "a photo")}<p>${esc(c.body)}</p></div>`).join("")}`;
  };
  $("#tg").onclick = async () => {
    s.sharing = !s.sharing; paint();
    const { error } = await sb.from("shoots").update({ sharing: s.sharing }).eq("id", s.id);
    if (error) { s.sharing = !s.sharing; paint(); toast(error.message); }
  };
  $("#cp").onclick = () => copy(url);
  paint();
  return paint;
}

function bridgeTab(body, state) {
  const s = state.shoot;
  const cmd = `cd darkroom/bridge && ./start.sh ${s.ingest_key}`;
  body.replaceChildren(h(`<main><div class="wrap panel-grid">
    <div class="card"><div class="label">Step 1 · on your Mac</div><h3 style="margin:4px 0 10px;font-family:var(--serif);font-weight:500">Start the camera bridge</h3>
      <p class="muted">The bridge receives photos from your camera over Wi-Fi and develops them here. Run this in Terminal and leave it open while you shoot:</p>
      <div class="code" id="cmd">${esc(cmd)}</div>
      <div class="kv" style="margin-top:10px"><button class="btn" id="cpc">Copy command</button><button class="btn ghost" id="cpk">Copy shoot key</button></div>
      <p class="muted" style="font-size:12.5px">First time? <code>git clone https://github.com/jayeed17/darkroom</code>. The terminal prints your Mac's IP for step 2.</p></div>
    <div class="card"><div class="label">Step 2 · on the camera</div><h3 style="margin:4px 0 10px;font-family:var(--serif);font-weight:500">Sony FX3 · a7 IV · a7R V</h3>
      <ol class="steps">
        <li>Join the <b>same Wi-Fi</b> as your Mac. Guest networks and carrier hotspots usually block this; a travel router works everywhere.</li>
        <li><b>Network → FTP Transfer Func. → Server Setting → Server 1</b>: Host = the IP the bridge printed, Port <b>2121</b>, User <b>sony</b>, Password <b>darkroom</b>, Secure Protocol <b>Off</b>, Passive <b>On</b></li>
        <li><b>FTP Function: On</b> · <b>Auto FTP Transfer: On</b> · Transfer Target: <b>JPEG</b></li>
        <li>Shoot. Photos develop in the <a href="#/s/${s.id}/gallery">Gallery</a> within seconds.</li>
      </ol></div>
  </div></main>`));
  $("#cpc").onclick = () => copy(cmd);
  $("#cpk").onclick = () => copy(s.ingest_key);
  return () => {};
}

function albumTab(body, state) {
  const s = state.shoot;
  const album = s.album && Array.isArray(s.album.spreads) ? s.album : { size: "12x12", spreads: [] };
  let saveT;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
    const { error } = await sb.from("shoots").update({ album }).eq("id", s.id);
    if (error) toast(error.message);
  }, 500); };
  const pool = () => {
    const all = [...state.photos.values()].sort((a, b) => new Date(a.taken) - new Date(b.taken) || a.id - b.id);
    const stars = all.filter((p) => p.star);
    return stars.length ? stars : all.filter((p) => !p.blurry && !p.dup_of);
  };
  body.replaceChildren(h(`<div><main><div class="wrap">
      <div class="bar"><div><div class="label">Layflat album</div><h1 class="h1">Album</h1></div><span class="sp"></span>
        <select class="select" id="size">${Object.entries(SIZES).map(([k, v]) => `<option value="${k}" ${k === album.size ? "selected" : ""}>${v.label}</option>`).join("")}</select>
        <button class="btn" id="auto">Auto-layout</button><button class="btn" id="add">+ Spread</button>
        <button class="btn primary" id="pdf">Export print PDF</button></div>
      <p class="muted" style="margin-top:-6px">Built from your ★ starred photos (or every keeper if nothing is starred). Drag photos from the tray onto any slot.</p>
      <div class="album" id="spreads"></div></div></main>
    <div class="tray" id="tray"></div></div>`));
  const used = () => new Set(album.spreads.flatMap((sp) => sp.slots).filter(Boolean));
  const render = () => {
    const size = SIZES[album.size] || SIZES["12x12"], u = used();
    const wrap = $("#spreads");
    if (!album.spreads.length) {
      wrap.innerHTML = `<div class="empty"><h2>No spreads yet</h2><p>Star your favorites in the Gallery, then hit <b>Auto-layout</b>, or add a spread and drag photos in.</p></div>`;
    } else {
      wrap.replaceChildren(...album.spreads.map((sp, i) => {
        const el = h(`<div class="spread-wrap"><div class="spread-head">
            <span>Spread ${i + 1}</span>
            <select class="select" data-k="layout">${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}" ${k === sp.layout ? "selected" : ""}>${v.label}</option>`).join("")}</select>
            <span class="sp"></span>
            <button class="btn small ghost" data-k="up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn small ghost" data-k="down" ${i === album.spreads.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn small ghost" data-k="del">Delete</button></div>
          <div class="spread" style="aspect-ratio:${size.w * 2}/${size.h}"></div></div>`);
        const box = el.querySelector(".spread");
        LAYOUTS[sp.layout].rects.forEach((r, j) => {
          const pid = sp.slots[j], p = pid && state.photos.get(pid);
          const slot = h(`<div class="slot ${p ? "" : "empty-slot"}" style="left:${r[0] * 100}%;top:${r[1] * 100}%;width:${r[2] * 100}%;height:${r[3] * 100}%;${p ? `background-image:url('${esc(p.preview_url)}')` : ""}">${p ? '<button class="x" title="Remove">✕</button>' : "Drop photo"}</div>`);
          slot.ondragover = (e) => { e.preventDefault(); slot.classList.add("over"); };
          slot.ondragleave = () => slot.classList.remove("over");
          slot.ondrop = (e) => { e.preventDefault(); const id = +e.dataTransfer.getData("text/plain"); if (id) { sp.slots[j] = id; save(); render(); } };
          slot.querySelector(".x")?.addEventListener("click", () => { sp.slots[j] = null; save(); render(); });
          box.append(slot);
        });
        el.querySelector('[data-k="layout"]').onchange = (e) => {
          const n = LAYOUTS[e.target.value].rects.length; sp.layout = e.target.value;
          sp.slots = Array.from({ length: n }, (_, k) => sp.slots[k] ?? null); save(); render();
        };
        el.querySelector('[data-k="up"]').onclick = () => { [album.spreads[i - 1], album.spreads[i]] = [album.spreads[i], album.spreads[i - 1]]; save(); render(); };
        el.querySelector('[data-k="down"]').onclick = () => { [album.spreads[i + 1], album.spreads[i]] = [album.spreads[i], album.spreads[i + 1]]; save(); render(); };
        el.querySelector('[data-k="del"]').onclick = () => { album.spreads.splice(i, 1); save(); render(); };
        return el;
      }));
    }
    const tray = $("#tray");
    const photos = pool();
    tray.replaceChildren(...(photos.length ? photos.map((p) => {
      const img = h(`<img draggable="true" src="${esc(p.thumb_url)}" alt="" class="${u.has(p.id) ? "used" : ""}" title="${esc(p.name)}">`);
      img.ondragstart = (e) => e.dataTransfer.setData("text/plain", String(p.id));
      return img;
    }) : [h(`<span class="muted">Star photos in the Gallery to fill this tray.</span>`)]));
  };
  $("#size").onchange = (e) => { album.size = e.target.value; save(); render(); };
  $("#add").onclick = () => { album.spreads.push({ layout: "two", slots: [null, null] }); save(); render(); };
  $("#auto").onclick = () => {
    if (album.spreads.length && !confirm("Replace the current layout with an automatic one?")) return;
    album.spreads = autoLayout(pool()); save(); render();
  };
  $("#pdf").onclick = async (e) => {
    if (!album.spreads.length) return toast("Add some spreads first");
    const b = e.target; b.disabled = true; const old = b.textContent;
    try {
      await exportPdf(album, state.photos, `${s.title}`, (i, n) => (b.textContent = `Rendering ${i}/${n}…`));
      toast("PDF downloaded");
    } catch (err) { console.error(err); toast("Export failed: " + err.message); }
    b.disabled = false; b.textContent = old;
  };
  render();
  return (what) => { if (what === "photos") render(); };
}

async function proofView(token) {
  app.replaceChildren(h(`<div class="boot">Developing…</div>`));
  let data;
  const load = async () => {
    const { data: d, error } = await sb.rpc("share_get", { p_token: token });
    if (error) throw error; return d;
  };
  try { data = await load(); } catch (e) { data = null; }
  if (!data) { app.replaceChildren(h(`<div class="empty"><h2>This gallery isn't available</h2><p>The link may be off or mistyped. Ask your photographer for a fresh one.</p></div>`)); return; }
  let name = localStorage.getItem("darkroom:name") || "";
  const photos = new Map(data.photos.map((p) => [p.id, p]));
  let comments = data.comments;
  app.replaceChildren(h(`<div>
    <header class="top"><span class="brand">${LOGO} Darkroom</span><span class="sp"></span><span class="count" id="cnt"></span>
      <div class="seg" id="flt"><button data-f="all" aria-pressed="true">All</button><button data-f="pick" aria-pressed="false">♥ My favorites</button></div></header>
    <div class="proof-hero"><div class="label">Proofing gallery</div><h1>${esc(data.title)}</h1><p>Tap ♥ on the photos you love. Open a photo to leave a comment.</p></div>
    <div class="masonry" id="grid"></div></div>`));
  let filter = "all";
  const render = () => {
    const list = [...photos.values()].filter((p) => filter === "all" || p.pick);
    $("#grid").replaceChildren(...list.map((p) => {
      const el = h(`<div class="ph"><img loading="lazy" alt="" src="${esc(p.thumb)}" style="aspect-ratio:${p.w || 3}/${p.h || 2}"><button class="star heart ${p.pick ? "on" : ""}" title="Favorite">♥</button></div>`);
      const img = el.querySelector("img"); img.onload = () => img.classList.add("ok"); if (img.complete) img.classList.add("ok");
      el.querySelector(".heart").onclick = (e) => { e.stopPropagation(); pick(p); };
      el.onclick = () => openLb(list.map((x) => x.id), p.id, api);
      return el;
    }));
    const n = [...photos.values()].filter((p) => p.pick).length;
    $("#cnt").textContent = `${photos.size} photos · ${n} ♥`;
  };
  async function pick(p) {
    p.pick = !p.pick; render(); lbRefresh();
    const { error } = await sb.rpc("share_pick", { p_token: token, p_photo: p.id, p_pick: p.pick });
    if (error) { p.pick = !p.pick; render(); toast("Couldn't save, try again"); }
  }
  const api = {
    get: (id) => photos.get(id),
    comments: (id) => comments.filter((c) => c.photo_id === id),
    head: (p) => `<button class="btn small" data-act="pick">${p.pick ? "♥ Favorited" : "♡ Favorite"}</button>`,
    act: (p, a) => a === "pick" && pick(p),
    send: async (p, text) => {
      if (!name) { name = (prompt("Your name (so your photographer knows who commented)") || "").trim(); if (name) localStorage.setItem("darkroom:name", name); }
      const { data: id, error } = await sb.rpc("share_comment", { p_token: token, p_photo: p.id, p_author: name || "Client", p_body: text });
      if (error) return toast("Couldn't send, try again");
      comments.push({ id, photo_id: p.id, author: name || "Client", body: text, from_owner: false });
    },
    info: (p) => esc(p.name),
    keys: { f: "pick" },
  };
  $("#flt").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f;
    $("#flt").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); render();
  };
  render();
  const iv = setInterval(async () => {
    try { const d = await load(); if (d) { comments = d.comments; lbRefresh(); } } catch {}
  }, 20000);
  onLeave(() => clearInterval(iv));
}

route();
