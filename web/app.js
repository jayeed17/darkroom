import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { LAYOUTS, SIZES, autoLayout, exportPdf } from "./album.js";
import { pickQuote, prints3d, quoteEl, greeting } from "./welcome.js";

// Email links (confirm signup / reset password) land as #access_token=…&type=… or #error=…
const BOOT_HASH = location.hash;
const BOOT = Object.fromEntries(new URLSearchParams(BOOT_HASH.replace(/^#\/?/, "").includes("=") ? BOOT_HASH.replace(/^#\/?/, "") : ""));
let recovering = BOOT.type === "recovery";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
let teardown = [];
const onLeave = (fn) => teardown.push(fn);
const sget = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
const lget = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lset = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const fmtDate = (d) => d ? new Date(d + (String(d).length === 10 ? "T12:00:00" : "")).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400);
}
async function manage(body) {
  const { data, error } = await sb.functions.invoke("manage", { body });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch {} throw new Error(m); }
  return data;
}
async function copy(text, msg = "Copied") { try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt("Copy this:", text); } }
async function download(url, name) {
  try {
    const blob = await (await fetch(url, { mode: "cors" })).blob();
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch { window.open(url, "_blank", "noopener"); }
}
const LOGO = `<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1e1e22"/><circle cx="16" cy="16" r="8" fill="none" stroke="#e8c07a" stroke-width="2.5"/><circle cx="16" cy="16" r="3" fill="#e8c07a"/></svg>`;

const friendly = (error) => {
  const m = (error?.message || String(error || "")).toLowerCase();
  if (m.includes("rate limit") || error?.status === 429) return "Too many emails were sent in the last hour. Please wait a bit and try again.";
  if (m.includes("invalid login")) return "That email and password don't match. If you just signed up, confirm your email first.";
  if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox (and spam).";
  if (m.includes("already registered")) return "An account with this email already exists. Sign in or reset your password.";
  if (error?.code === "same_password" || m.includes("different from the old")) return "Your new password must be different from your current one.";
  if (error?.code === "weak_password") return "That password is too easy to guess or has appeared in a data breach. Please choose a stronger one.";
  if (m.includes("password should")) return error.message;
  if (m.includes("expired") || m.includes("invalid")) return "That link has expired or was already used. Request a new one below.";
  if (m.includes("fetch") || m.includes("network")) return "Can't reach the server. Check your connection and try again.";
  return error?.message || "Something went wrong. Please try again.";
};

// profile cache (name + phone)
let PROFILE = null;
async function loadProfile(user) {
  if (PROFILE && PROFILE.id === user.id) return PROFILE;
  const { data } = await sb.from("profiles").select("id,full_name,phone").eq("id", user.id).maybeSingle();
  PROFILE = data || { id: user.id, full_name: null, phone: null };
  if (!PROFILE.full_name && user.user_metadata?.full_name) PROFILE.full_name = user.user_metadata.full_name;
  return PROFILE;
}
const firstName = (p) => (p?.full_name || "").trim().split(/\s+/)[0] || "";

// every route() bumps this; async views bail out if a newer route started while they awaited
let ROUTE = 0;
const stale = (g) => g !== ROUTE;

async function route() {
  const gen = ++ROUTE;
  teardown.forEach((f) => { try { f(); } catch {} }); teardown = [];
  closeLb(); closeShow();
  if (recovering) return resetView();
  if (BOOT.error && !route.shownError) { route.shownError = true; history.replaceState(null, "", location.pathname + "#/"); return authView("in", friendly({ message: BOOT.error_description || BOOT.error }), true); }
  const hash = location.hash.includes("access_token=") ? "/" : (location.hash.slice(1) || "/");
  const [, a, b, c] = hash.split("/");
  if (a === "p" && b) return proofView(b);
  const { data: { session } } = await sb.auth.getSession();
  if (stale(gen)) return;
  if (location.hash.includes("access_token=")) history.replaceState(null, "", location.pathname + "#/");
  if (!session) { PROFILE = null; return authView(); }
  if (BOOT.type === "signup" && !route.welcomed) { route.welcomed = true; toast("Email confirmed. Welcome to Darkroom!"); }
  if (a === "s" && b) return shootView(b, c || "gallery");
  return homeView(session);
}
addEventListener("hashchange", route);
// re-route only when the signed-in user actually changes. Supabase re-fires SIGNED_IN on tab focus and
// token refresh; re-routing then would rebuild the page mid-shoot (flicker, closed lightbox, dropped live feed).
let AUTH_UID;
sb.auth.onAuthStateChange((ev, session) => {
  const uid = session?.user?.id || null;
  if (ev === "PASSWORD_RECOVERY") { recovering = true; AUTH_UID = uid; route(); return; }
  if (ev === "INITIAL_SESSION" || AUTH_UID === undefined) { AUTH_UID = uid; return; }
  if (uid === AUTH_UID) return;
  AUTH_UID = uid;
  if ((ev === "SIGNED_IN" && !recovering) || ev === "SIGNED_OUT") route();
});

const EYE = `<button type="button" class="eye" aria-label="Show password" tabindex="-1">Show</button>`;
function wireEyes(root) {
  root.querySelectorAll(".pw").forEach((w) => {
    const i = w.querySelector("input"), b = w.querySelector(".eye");
    b.onclick = () => { const show = i.type === "password"; i.type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show"; };
  });
}

function authShell(inner) {
  const el = h(`<div class="auth">
    <div class="auth-art"><div class="art-slot"></div><div class="quote-slot"></div></div>
    <div class="auth-box">
      <a class="brand" href="#/">${LOGO} Darkroom</a>
      <h1>Shoot.<br>Watch it develop.</h1>
      <p class="lede">Your Sony sends every frame here as you shoot. Cull, share a proofing link, and design the album in one place.</p>
      ${inner}</div></div>`);
  const stage = prints3d([], { count: 12 });
  el.querySelector(".art-slot").append(stage);
  el.querySelector(".quote-slot").append(quoteEl(pickQuote()));
  onLeave(() => stage._cleanup());
  return el;
}

function authView(mode = "in", notice = "", isError = false) {
  const titles = { in: "Sign in", up: "Create account", forgot: "Send reset link" };
  app.replaceChildren(authShell(`
    <form id="f" novalidate>
      <div class="form-title" id="ft"></div>
      <div class="up-only" id="upFields">
        <input class="input" name="name" type="text" placeholder="Full name" autocomplete="name" maxlength="120">
        <input class="input" name="phone" type="tel" placeholder="Phone number" autocomplete="tel" maxlength="40">
      </div>
      <input class="input" name="email" type="email" placeholder="Email" autocomplete="email" required>
      <div class="pw" id="pwrow"><input class="input" name="pw" type="password" placeholder="Password (8+ characters)" minlength="8" autocomplete="current-password">${EYE}</div>
      <div class="row-end" id="forgotRow"><button type="button" class="linkish" id="forgot">Forgot password?</button></div>
      <div class="msg" id="msg" role="status" aria-live="polite"></div>
      <button class="btn primary big" id="go" type="submit">Sign in</button>
      <button class="btn ghost big" id="resend" type="button" hidden>Resend confirmation email</button>
    </form>
    <div class="switch" id="sw"></div>`));
  wireEyes(app);
  const f = $("#f"), go = $("#go"), msg = $("#msg"), sw = $("#sw"), resend = $("#resend");
  const say = (text, bad = false) => { msg.textContent = text; msg.className = "msg " + (bad ? "bad" : "good"); };
  const paint = () => {
    go.textContent = titles[mode];
    $("#ft").textContent = mode === "forgot" ? "Reset your password" : mode === "up" ? "Create your account" : "";
    $("#upFields").hidden = mode !== "up";
    $("#pwrow").hidden = mode === "forgot";
    $("#forgotRow").hidden = mode !== "in";
    f.pw.autocomplete = mode === "up" ? "new-password" : "current-password";
    sw.innerHTML = mode === "in" ? `New here? <button type="button" data-m="up">Create an account</button>`
      : mode === "up" ? `Have an account? <button type="button" data-m="in">Sign in</button>`
      : `Remembered it? <button type="button" data-m="in">Back to sign in</button>`;
    sw.querySelector("button").onclick = (e) => { mode = e.target.dataset.m; msg.textContent = ""; resend.hidden = true; paint(); };
  };
  $("#forgot").onclick = () => { mode = "forgot"; msg.textContent = ""; paint(); f.email.focus(); };
  if (notice) say(notice, isError);
  paint();
  const redirectTo = `${location.origin}/`;
  resend.onclick = async () => {
    resend.disabled = true;
    const { error } = await sb.auth.resend({ type: "signup", email: f.email.value.trim(), options: { emailRedirectTo: redirectTo } });
    resend.disabled = false;
    error ? say(friendly(error), true) : say("Sent. Check your inbox (and spam) for the confirmation link.");
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = f.email.value.trim(), password = f.pw.value;
    const name = f.name.value.trim().replace(/\s+/g, " "), phone = f.phone.value.trim();
    if (mode === "up") {
      if (name.length < 2) return say("Please enter your full name.", true);
      if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) return say("Please enter a valid phone number.", true);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say("Enter a valid email address.", true);
    if (mode !== "forgot" && password.length < 8) return say("Password must be at least 8 characters.", true);
    go.disabled = true; const label = go.textContent; go.textContent = "One moment…";
    let error, data;
    if (mode === "in") ({ data, error } = await sb.auth.signInWithPassword({ email, password }));
    else if (mode === "up") ({ data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo, data: { full_name: name, phone } } }));
    else ({ error } = await sb.auth.resetPasswordForEmail(email, { redirectTo }));
    go.disabled = false; go.textContent = label;
    if (error) {
      say(friendly(error), true);
      resend.hidden = !/confirm/i.test(error.message || "");
      return;
    }
    if (mode === "forgot") { say(`If an account exists for ${email}, a reset link is on its way. Check your inbox (and spam).`); return; }
    if (mode === "up") {
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        say("An account with this email already exists. Sign in, or use Forgot password.", true); mode = "in"; paint(); return;
      }
      if (!data.session) { say(`Almost done, ${name.split(" ")[0]}. We sent a confirmation link to ${email}. Open it, then sign in here.`); mode = "in"; paint(); resend.hidden = false; }
    }
  };
}

function resetView() {
  app.replaceChildren(authShell(`
    <form id="f" novalidate>
      <div class="form-title">Choose a new password</div>
      <div class="pw"><input class="input" name="pw" type="password" placeholder="New password (8+ characters)" autocomplete="new-password">${EYE}</div>
      <div class="pw"><input class="input" name="pw2" type="password" placeholder="Repeat new password" autocomplete="new-password">${EYE}</div>
      <div class="msg" id="msg" role="status" aria-live="polite"></div>
      <button class="btn primary big" id="go" type="submit">Save new password</button>
    </form>`));
  wireEyes(app);
  const f = $("#f"), msg = $("#msg"), go = $("#go");
  const say = (t, bad) => { msg.textContent = t; msg.className = "msg " + (bad ? "bad" : "good"); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.pw.value.length < 8) return say("Password must be at least 8 characters.", true);
    if (f.pw.value !== f.pw2.value) return say("The two passwords don't match.", true);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { recovering = false; history.replaceState(null, "", location.pathname + "#/"); return authView("forgot", "That reset link has expired. Request a new one.", true); }
    go.disabled = true;
    const { error } = await sb.auth.updateUser({ password: f.pw.value });
    go.disabled = false;
    if (error) return say(friendly(error), true);
    recovering = false;
    history.replaceState(null, "", location.pathname + "#/");
    toast("Password updated. You're signed in.");
    route();
  };
}

const FIRST_VISIT = {};
async function homeView(session) {
  const gen = ROUTE;
  const profile = await loadProfile(session.user);
  if (stale(gen)) return;
  const first = firstName(profile);
  FIRST_VISIT[session.user.id] ??= !lget("darkroom:seen:" + session.user.id);
  const returning = !FIRST_VISIT[session.user.id];
  lset("darkroom:seen:" + session.user.id, "1");
  app.replaceChildren(h(`<div>
    <header class="top"><a class="brand" href="#/">${LOGO} Darkroom</a><span class="sp"></span>
      <span class="crumb" id="who">${esc(profile.full_name || session.user.email)}</span><button class="btn ghost small" id="out">Sign out</button></header>
    <section class="hero">
      <div class="hero-text">
        <div class="label">${esc(greeting())}</div>
        <h1 class="hero-h">${returning ? "Welcome back" : "Welcome"}${first ? `, <em>${esc(first)}</em>` : ""}.</h1>
        <div class="quote-slot"></div>
        <div class="kv" style="margin-top:22px"><button class="btn primary" id="new">+ New shoot</button></div>
        <form class="card name-card" id="nameCard" hidden>
          <div class="label">Finish your profile</div>
          <p class="muted" style="margin:6px 0 10px">Add your name so clients see who they're working with.</p>
          <div class="kv"><input class="input" name="name" placeholder="Full name" maxlength="120" value="${esc(profile.full_name || "")}"><input class="input" name="phone" type="tel" placeholder="Phone" maxlength="40" value="${esc(profile.phone || "")}"><button class="btn primary">Save</button></div>
        </form>
      </div>
      <div class="hero-art"></div>
    </section>
    <main><div class="wrap">
      <div class="bar"><div><div class="label">Your shoots</div><h2 class="h1">Shoots</h2></div></div>
      <div class="shoots" id="list"><div class="muted">Loading…</div></div>
    </div></main></div>`));
  $(".quote-slot").append(quoteEl(pickQuote()));
  $("#out").onclick = () => sb.auth.signOut();
  $("#new").onclick = newShoot;
  const nc = $("#nameCard");
  nc.hidden = !!profile.full_name;
  nc.onsubmit = async (e) => {
    e.preventDefault();
    const full_name = nc.name.value.trim().replace(/\s+/g, " "), phone = nc.phone.value.trim();
    if (full_name.length < 2) return toast("Please enter your full name");
    const { error } = await sb.from("profiles").upsert({ id: session.user.id, full_name, phone: phone || null });
    if (error) return toast(error.message);
    PROFILE = { ...profile, full_name, phone }; toast("Saved"); route();
  };
  const [{ data: shoots, error }, { data: recent }] = await Promise.all([
    sb.from("shoots").select("id,title,created_at,shoot_date,cover_photo").order("created_at", { ascending: false }),
    sb.from("photos").select("id,shoot_id,thumb_url,star,blurry").order("created_at", { ascending: false }).limit(400),
  ]);
  if (stale(gen)) return;
  const heroArt = $(".hero-art");
  if (!heroArt) return;
  const art = prints3d((recent || []).filter((p) => !p.blurry).slice(0, 12).map((p) => p.thumb_url), { count: 12 });
  heroArt.append(art); onLeave(() => art._cleanup());
  const list = $("#list");
  if (error) { list.innerHTML = `<div class="err">${esc(error.message)}</div>`; return; }
  if (!shoots.length) {
    list.replaceWith(h(`<div class="empty"><h2>No shoots yet</h2><p>Create a shoot, connect your camera, and photos appear here as you take them.</p></div>`));
    return;
  }
  const byId = new Map((recent || []).map((p) => [p.id, p]));
  const cover = {}, counts = {};
  (recent || []).forEach((p) => { counts[p.shoot_id] = (counts[p.shoot_id] || 0) + 1; if (p.star) cover[p.shoot_id] ??= p.thumb_url; });
  (recent || []).forEach((p) => { cover[p.shoot_id] ??= p.thumb_url; });
  shoots.forEach((s) => { if (s.cover_photo && byId.get(s.cover_photo)) cover[s.id] = byId.get(s.cover_photo).thumb_url; });
  list.replaceChildren(...shoots.map((s) => h(`<a class="shoot" href="#/s/${s.id}">
    <div class="cover" style="${cover[s.id] ? `background-image:url('${esc(cover[s.id])}')` : ""}">${cover[s.id] ? "" : "Waiting for photos"}</div>
    <div class="meta"><h3>${esc(s.title)}</h3><div class="muted" style="font-size:12.5px">${s.shoot_date ? fmtDate(s.shoot_date) : new Date(s.created_at).toLocaleDateString()}${counts[s.id] ? ` · ${counts[s.id]}${counts[s.id] >= 400 ? "+" : ""} photos` : ""}</div></div></a>`)));
}

async function newShoot() {
  const title = prompt("Shoot name", "Untitled shoot"); if (title === null) return;
  const { data, error } = await sb.from("shoots").insert({ title: title.trim() || "Untitled shoot", shoot_date: new Date().toISOString().slice(0, 10) }).select("id").single();
  if (error) return toast(error.message);
  location.hash = `#/s/${data.id}/bridge`;
}

async function shootView(id, tab) {
  const gen = ROUTE;
  const { data: shoot, error } = await sb.from("shoots").select("*").eq("id", id).maybeSingle();
  if (stale(gen)) return;
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
    await sb.from("shoots").update({ title: t }).eq("id", id); shoot.title = t; toast("Renamed");
  };
  const state = { shoot, photos: new Map(), comments: [] };
  const [{ data: photos }, { data: comments }] = await Promise.all([
    sb.from("photos").select("*").eq("shoot_id", id),
    sb.from("comments").select("*").eq("shoot_id", id).order("created_at"),
  ]);
  if (stale(gen)) return;
  (photos || []).forEach((p) => state.photos.set(p.id, p));
  state.comments = comments || [];

  let rerender = () => {};
  // Live events aren't replayed after a drop (venue Wi-Fi, laptop sleep), and a photo committed while the
  // subscription is still connecting would be missed. Re-sync on every (re)subscribe, on wake and when back online.
  let lastSync = 0;
  const resync = async () => {
    if (Date.now() - lastSync < 3000) return;
    lastSync = Date.now();
    const [{ data: ph, error: e1 }, { data: cm, error: e2 }] = await Promise.all([
      sb.from("photos").select("*").eq("shoot_id", id),
      sb.from("comments").select("*").eq("shoot_id", id).order("created_at"),
    ]);
    if (stale(gen) || e1 || e2) return;
    const seen = new Set(ph.map((p) => p.id)), added = [];
    for (const p of ph) { if (!state.photos.has(p.id)) added.push(p); state.photos.set(p.id, p); }
    for (const pid of [...state.photos.keys()]) if (!seen.has(pid)) state.photos.delete(pid);
    state.comments = cm;
    if (added.length) {
      state.fresh ||= new Set(); added.forEach((p) => state.fresh.add(p.id));
      added.sort((a, b) => a.id - b.id).slice(-3).forEach(arrival);
    }
    rerender("photos");
  };
  const onVisible = () => { if (document.visibilityState === "visible") resync(); };
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("online", resync);
  const safety = setInterval(() => { if (document.visibilityState === "visible") resync(); }, 30000);
  onLeave(() => { document.removeEventListener("visibilitychange", onVisible); removeEventListener("online", resync); clearInterval(safety); });
  const ch = sb.channel(`shoot-${id}`)
    // sent by the server each time database changes start flowing to this channel, including after a reconnect
    .on("system", {}, (m) => { if (m?.extension === "postgres_changes" && m?.status === "ok") resync(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "photos", filter: `shoot_id=eq.${id}` }, (pl) => {
      if (pl.eventType === "DELETE") state.photos.delete(pl.old.id);
      else {
        const isNew = !state.photos.has(pl.new.id);
        state.photos.set(pl.new.id, pl.new);
        if (isNew) { (state.fresh ||= new Set()).add(pl.new.id); arrival(pl.new); }
      }
      rerender("photos");
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter: `shoot_id=eq.${id}` }, (pl) => {
      if (!state.comments.some((c) => c.id === pl.new.id)) state.comments.push(pl.new);
      rerender("comments");
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "shoots", filter: `id=eq.${id}` }, (pl) => {
      Object.assign(state.shoot, pl.new); rerender("shoot");
    })
    .subscribe((st) => { setTimeout(paintLive, 0); if (st === "SUBSCRIBED") resync(); });
  // the channel status callback doesn't fire when the socket silently drops, so read the real state
  function paintLive() {
    const on = ch.state === "joined" && (sb.realtime.isConnected?.() ?? true);
    $("#live")?.classList.toggle("on", on);
    if ($("#liveTxt")) $("#liveTxt").textContent = on ? "live" : "reconnecting";
  }
  const liveTick = setInterval(paintLive, 2000);
  onLeave(() => { clearInterval(liveTick); sb.removeChannel(ch); });

  const body = $("#body");
  state.rerender = (w) => rerender(w);
  if (tab === "gallery") rerender = galleryTab(body, state);
  else if (tab === "album") rerender = albumTab(body, state);
  else if (tab === "share") rerender = shareTab(body, state);
  else rerender = bridgeTab(body, state);
}

// a quiet "just developed" card for every photo that arrives from the camera
function arrival(p) {
  let box = $("#arrivals");
  if (!box) { box = h(`<div class="arrivals" id="arrivals" aria-live="polite"></div>`); document.body.append(box); onLeave(() => box.remove()); }
  const card = h(`<div class="arrival"><img alt="" src="${esc(p.thumb_url)}"><div><b>Just developed</b><span>${esc(p.name)}${p.blurry ? " · soft focus" : ""}</span></div></div>`);
  box.prepend(card);
  while (box.children.length > 3) box.lastElementChild.remove();
  setTimeout(() => { card.classList.add("out"); setTimeout(() => card.remove(), 400); }, 3800);
}

// gallery: keyed rendering, so existing photos are never re-created and nothing flickers
function galleryTab(body, state) {
  let filter = "all";
  const cards = new Map();
  body.replaceChildren(h(`<main><div class="bar">
      <div class="seg" id="flt">
        <button data-f="all" aria-pressed="true">All</button><button data-f="keep" aria-pressed="false">Keepers</button>
        <button data-f="star" aria-pressed="false">★ Starred</button><button data-f="pick" aria-pressed="false">♥ Client picks</button>
        <button data-f="flag" aria-pressed="false">Flagged</button></div>
      <span class="count" id="cnt"></span><span class="sp"></span>
      <button class="btn" id="show" title="Slideshow">▶ Slideshow</button>
      <button class="btn" id="lr" title="Copy file names for Lightroom">Copy for Lightroom</button></div>
    <div class="grid" id="grid"></div><div id="empty"></div></main>`));
  const vis = (p) => filter === "all" || (filter === "star" ? p.star : filter === "pick" ? p.pick : filter === "keep" ? !p.blurry && !p.dup_of : p.blurry || p.dup_of);
  const sorted = () => [...state.photos.values()].sort((a, b) => new Date(b.taken) - new Date(a.taken) || b.id - a.id);
  const ccount = () => { const m = {}; state.comments.forEach((c) => (m[c.photo_id] = (m[c.photo_id] || 0) + 1)); return m; };
  const makeCard = (p) => {
    const el = h(`<div class="ph"><img loading="lazy" decoding="async" alt=""><div class="tags"></div><button class="star" title="Star (S)">★</button></div>`);
    const img = el.querySelector("img");
    img.onload = () => img.classList.add("ok");
    img.src = p.thumb_url;
    el.dataset.id = p.id;
    el.querySelector(".star").onclick = (e) => { e.stopPropagation(); toggleStar(state.photos.get(+el.dataset.id)); };
    el.onclick = () => { const list = sorted().filter(vis); openLb(list.map((x) => x.id), +el.dataset.id, ownerLb(state)); };
    return el;
  };
  const paintCard = (el, p, cc) => {
    el.classList.toggle("dim", !!(p.blurry || p.dup_of));
    el.querySelector(".star").classList.toggle("on", !!p.star);
    const img = el.querySelector("img");
    if (img.getAttribute("src") !== p.thumb_url) { img.classList.remove("ok"); img.src = p.thumb_url; }
    const cover = state.shoot.cover_photo === p.id;
    el.querySelector(".tags").innerHTML = `${cover ? '<span class="tag k">COVER</span>' : ""}${p.blurry ? '<span class="tag w">BLUR</span>' : ""}${p.dup_of ? '<span class="tag w">DUP</span>' : ""}${p.pick ? '<span class="tag p">♥ CLIENT</span>' : ""}${cc[p.id] ? `<span class="tag c">💬 ${cc[p.id]}</span>` : ""}`;
  };
  // batch bursts of arrivals into one paint: next animation frame, or 300ms at most, because browsers pause
  // animation frames for covered/background windows and the gallery must still be current when you look
  let raf = 0, rt = 0;
  const render = () => {
    cancelAnimationFrame(raf); clearTimeout(rt);
    raf = requestAnimationFrame(() => { clearTimeout(rt); renderNow(); });
    rt = setTimeout(() => { cancelAnimationFrame(raf); renderNow(); }, 300);
  };
  const renderNow = () => {
    const grid = $("#grid");
    if (!grid) return;
    const list = sorted().filter(vis), cc = ccount();
    for (const id of cards.keys()) if (!state.photos.has(id)) cards.delete(id);
    const els = list.map((p) => {
      let el = cards.get(p.id);
      if (!el) { el = makeCard(p); cards.set(p.id, el); if (state.fresh?.has(p.id)) el.classList.add("new"); }
      paintCard(el, p, cc);
      return el;
    });
    if (els.length !== grid.children.length || els.some((el, i) => grid.children[i] !== el)) grid.replaceChildren(...els);
    state.fresh?.clear();
    const all = [...state.photos.values()];
    $("#cnt").textContent = `${all.length} shots · ${all.filter((p) => p.star).length} ★ · ${all.filter((p) => p.pick).length} ♥ · ${all.filter((p) => p.blurry || p.dup_of).length} flagged`;
    $("#empty").innerHTML = all.length ? "" : `<div class="empty"><h2>Waiting for your camera</h2><p>Open the <a href="#/s/${state.shoot.id}/bridge">Camera</a> tab to connect your Sony. Photos develop here the moment you take them.</p></div>`;
  };
  async function toggleStar(p) {
    if (!p) return;
    p.star = !p.star; renderNow(); lbRefresh();
    const { error } = await sb.from("photos").update({ star: p.star }).eq("id", p.id);
    if (error) { p.star = !p.star; renderNow(); toast(error.message); }
  }
  state.toggleStar = toggleStar;
  $("#flt").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f;
    $("#flt").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderNow();
  };
  $("#show").onclick = () => {
    const list = sorted().filter(vis).reverse();
    if (!list.length) return toast("No photos to show yet");
    openShow(list.map((p) => p.preview_url), state.shoot.title);
  };
  $("#lr").onclick = () => {
    const all = [...state.photos.values()];
    const picks = all.filter((p) => p.pick), stars = all.filter((p) => p.star);
    const set = picks.length ? picks : stars;
    if (!set.length) return toast("Star photos or wait for client picks first");
    const stems = set.map((p) => p.name.replace(/\.[^.]+$/, ""));
    copy(stems.join(" "), `Copied ${set.length} ${picks.length ? "client picks" : "starred"}. In Lightroom: Library Filter → Text → Filename → Contains, then paste.`);
  };
  renderNow();
  return (what) => { if (what === "shoot") renderNow(); else render(); setTimeout(lbRefresh, 0); };
}

function ownerLb(state) {
  return {
    get: (id) => state.photos.get(id),
    comments: (id) => state.comments.filter((c) => c.photo_id === id),
    head: (p) => `<button class="btn small" data-act="star">${p.star ? "★ Starred" : "☆ Star"}</button>
      <button class="btn small ghost" data-act="cover">${state.shoot.cover_photo === p.id ? "✓ Cover" : "Set as cover"}</button>
      ${p.pick ? '<span class="tag p">♥ Client</span>' : ""}<button class="btn small ghost danger" data-act="del" title="Delete photo">Delete</button>`,
    act: async (p, act) => {
      if (act === "star") return state.toggleStar(p);
      if (act === "cover") {
        const next = state.shoot.cover_photo === p.id ? null : p.id;
        const { error } = await sb.from("shoots").update({ cover_photo: next }).eq("id", state.shoot.id);
        if (error) return toast(error.message);
        state.shoot.cover_photo = next; state.rerender?.("shoot"); lbRefresh();
        return toast(next ? "Cover photo set. Clients see it first." : "Cover removed");
      }
      if (act === "del") {
        if (!confirm(`Delete ${p.name}? This removes it from the gallery, album and client link. The original stays on your computer.`)) return;
        try {
          const next = LB && (LB.ids[LB.ids.indexOf(p.id) + 1] ?? LB.ids[LB.ids.indexOf(p.id) - 1]);
          await manage({ action: "delete_photo", photo_id: p.id });
          state.photos.delete(p.id);
          if (LB) { LB.ids = LB.ids.filter((x) => x !== p.id); LB.id = next; }
          const sp = state.shoot.album?.spreads || []; sp.forEach((x) => (x.slots = x.slots.map((id) => (id === p.id ? null : id))));
          state.rerender?.(); lbRefresh(); toast("Photo deleted");
        } catch (e) { toast("Couldn't delete: " + e.message); }
      }
    },
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
function openLb(ids, id, api) { LB = { ids, id, api }; $("#lb").hidden = false; document.body.classList.add("noscroll"); lbRefresh(); }
function closeLb() { LB = null; document.body.classList.remove("noscroll"); const lb = $("#lb"); if (lb) { lb.hidden = true; lb.innerHTML = ""; } }
function lbRefresh() {
  if (!LB) return;
  const p = LB.api.get(LB.id); if (!p) return closeLb();
  const cmts = LB.api.comments(p.id);
  const lb = $("#lb");
  const draft = lb.querySelector("textarea")?.value || "";
  const wm = LB.api.watermark ? `<div class="wm" aria-hidden="true">${esc(LB.api.watermark)}</div>` : "";
  lb.innerHTML = `<div class="stage"><div class="lb-img"><img src="${esc(p.preview_url || p.preview)}" alt="">${wm}</div>
      <button class="nav l" data-nav="-1" aria-label="Previous">‹</button><button class="nav r" data-nav="1" aria-label="Next">›</button>
      <div class="info">${LB.api.info(p)} · ${LB.ids.indexOf(LB.id) + 1} / ${LB.ids.length} · ← → to browse · Esc to close</div></div>
    <aside><div class="head">${LB.api.head(p)}<span class="sp"></span><button class="btn small ghost" data-act="close">Close</button></div>
      <div class="list">${cmts.length ? cmts.map((c) => `<div class="cmt ${c.from_owner ? "own" : ""}"><b>${esc(c.author)}</b><p>${esc(c.body)}</p></div>`).join("") : '<div class="muted">No comments yet.</div>'}</div>
      <form><textarea class="input" rows="2" placeholder="Add a comment…" required></textarea><button class="btn primary small" style="justify-self:end">Send</button></form></aside>`;
  const ta = lb.querySelector("textarea"); ta.value = draft;
  if (LB.api.noSave) lb.querySelector(".lb-img img").oncontextmenu = (e) => e.preventDefault();
  lb.querySelector(".stage").onclick = (e) => { if (e.target.classList.contains("stage")) closeLb(); };
  lb.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => lbStep(+b.dataset.nav)));
  lb.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (b.dataset.act === "close" ? closeLb() : (LB.api.act(p, b.dataset.act), setTimeout(lbRefresh, 30)))));
  lb.querySelector("form").onsubmit = async (e) => {
    e.preventDefault(); const t = ta.value.trim(); if (!t) return;
    ta.value = ""; await LB.api.send(p, t); lbRefresh();
  };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); lb.querySelector("form").requestSubmit(); } };
  const st = lb.querySelector(".stage"); let x0 = null;
  st.ontouchstart = (e) => (x0 = e.touches[0].clientX);
  st.ontouchend = (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1); x0 = null; };
}
function lbStep(d) { if (!LB) return; const i = LB.ids.indexOf(LB.id) + d; if (i >= 0 && i < LB.ids.length) { LB.id = LB.ids[i]; lbRefresh(); } }
addEventListener("keydown", (e) => {
  if (SHOW) { if (e.key === "Escape") closeShow(); else if (e.key === "ArrowRight") SHOW.step(1); else if (e.key === "ArrowLeft") SHOW.step(-1); else if (e.key === " ") { e.preventDefault(); SHOW.toggle(); } return; }
  if (!LB || e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (e.key === "Escape") closeLb();
  else if (e.key === "ArrowRight") lbStep(1);
  else if (e.key === "ArrowLeft") lbStep(-1);
  else if (LB.api.keys[e.key.toLowerCase()]) { LB.api.act(LB.api.get(LB.id), LB.api.keys[e.key.toLowerCase()]); setTimeout(lbRefresh, 30); }
});

// slideshow: cross-fade with a slow Ken Burns drift
let SHOW = null;
function openShow(urls, title, watermark) {
  closeShow();
  const el = h(`<div class="show" role="dialog" aria-label="Slideshow">
    <div class="show-frame a"></div><div class="show-frame b"></div>${watermark ? `<div class="wm" aria-hidden="true">${esc(watermark)}</div>` : ""}
    <div class="show-ui"><span class="show-title">${esc(title || "")}</span><span class="sp"></span><span class="count" id="showCount"></span>
      <button class="btn small ghost" data-s="prev" aria-label="Previous">‹</button><button class="btn small ghost" data-s="play">Pause</button>
      <button class="btn small ghost" data-s="next" aria-label="Next">›</button><button class="btn small ghost" data-s="close">Close</button></div></div>`);
  document.body.append(el); document.body.classList.add("noscroll");
  let i = -1, playing = true, t, front = "a";
  const frames = { a: el.querySelector(".a"), b: el.querySelector(".b") };
  const show = (n) => {
    const target = (n + urls.length) % urls.length;
    const img = new Image();
    img.onload = () => {
      if (!SHOW || SHOW.el !== el) return;
      i = target;
      const back = front === "a" ? "b" : "a";
      frames[back].style.backgroundImage = `url("${urls[i]}")`;
      frames[back].classList.remove("on"); void frames[back].offsetWidth; frames[back].classList.add("on");
      frames[front].classList.remove("on"); front = back;
      el.querySelector("#showCount").textContent = `${i + 1} / ${urls.length}`;
      [1, 2].forEach((k) => { const pre = new Image(); pre.src = urls[(i + k) % urls.length]; });
    };
    img.src = urls[target];
  };
  const loop = () => { clearTimeout(t); if (playing) t = setTimeout(() => { show(i + 1); loop(); }, 4500); };
  SHOW = {
    el, step: (d) => { show(i + d); loop(); },
    toggle: () => { playing = !playing; el.querySelector('[data-s="play"]').textContent = playing ? "Pause" : "Play"; loop(); },
    stop: () => clearTimeout(t),
    index: () => i,
  };
  el.querySelector('[data-s="prev"]').onclick = () => SHOW.step(-1);
  el.querySelector('[data-s="next"]').onclick = () => SHOW.step(1);
  el.querySelector('[data-s="play"]').onclick = () => SHOW.toggle();
  el.querySelector('[data-s="close"]').onclick = closeShow;
  el.requestFullscreen?.().catch(() => {});
  show(0); loop();
}
function closeShow() {
  if (!SHOW) return;
  SHOW.stop(); SHOW.el.remove(); SHOW = null; document.body.classList.remove("noscroll");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && SHOW) closeShow(); });

function shareTab(body, state) {
  const s = state.shoot;
  const url = `${location.origin}/#/p/${s.share_token}`;
  const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");
  body.replaceChildren(h(`<main><div class="wrap panel-grid">
    <div class="card"><div class="switch-row"><div><div class="label">Proofing link</div><h3 class="card-h">Share with your clients</h3></div>
      <button class="toggle" id="tg" role="switch" aria-checked="${s.sharing}" aria-label="Sharing on/off"></button></div>
      <p class="muted">Clients open the link with no account, heart their favorites, leave comments and send you their final selection. They see your <b>starred</b> photos; if nothing is starred, every photo that isn't flagged.</p>
      <div class="kv"><input class="input" readonly value="${esc(url)}"><button class="btn" id="cp">Copy</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Preview</a></div>
      <p class="muted" id="st" style="margin-bottom:0"></p></div>
    <div class="card"><div class="label">Gallery settings</div><h3 class="card-h">How clients see it</h3>
      <form class="settings" id="set" onsubmit="return false">
        <label>Shoot date<input class="input" type="date" name="shoot_date" value="${esc(s.shoot_date || "")}"></label>
        <label>Link expires<input class="input" type="date" name="expires_at" value="${esc(day(s.expires_at))}"><small>Leave empty to keep it open.</small></label>
        <label>Watermark<input class="input" name="watermark" maxlength="60" placeholder="e.g. © Suabers Capture" value="${esc(s.watermark || "")}"><small>Shown over photos on the client page.</small></label>
        <div class="row"><span>Allow downloads<small>Web-size (2400px) JPEGs.</small></span><button type="button" class="toggle" id="dl" role="switch" aria-checked="${s.allow_download}" aria-label="Allow downloads"></button></div>
        <label>Gallery password<div class="kv"><div class="pw" style="flex:1"><input class="input" name="pw" type="password" placeholder="${s.share_pw_hash ? "Password is set. Type to change" : "No password"}" autocomplete="new-password">${EYE}</div><button type="button" class="btn" id="pwSave">Save</button>${s.share_pw_hash ? '<button type="button" class="btn ghost" id="pwClear">Remove</button>' : ""}</div></label>
      </form></div>
    <div class="card"><div class="label">Client activity</div><div id="act" style="margin-top:10px"></div></div>
  </div></main>`));
  wireEyes(body);
  const save = async (patch, msg = "Saved") => {
    const { error } = await sb.from("shoots").update(patch).eq("id", s.id);
    if (error) return toast(error.message);
    Object.assign(s, patch); toast(msg); paint();
  };
  const f = $("#set");
  f.shoot_date.onchange = () => save({ shoot_date: f.shoot_date.value || null });
  f.expires_at.onchange = () => save({ expires_at: f.expires_at.value ? new Date(f.expires_at.value + "T23:59:59").toISOString() : null }, f.expires_at.value ? `Link closes after ${fmtDate(f.expires_at.value)}` : "Link never expires");
  f.watermark.onchange = () => save({ watermark: f.watermark.value.trim() || null });
  $("#dl").onclick = () => save({ allow_download: !s.allow_download }, !s.allow_download ? "Downloads on" : "Downloads off");
  $("#pwSave").onclick = async () => {
    const pw = f.pw.value; if (pw.length < 4) return toast("Use at least 4 characters");
    const { error } = await sb.rpc("set_share_password", { p_shoot: s.id, p_password: pw });
    if (error) return toast(error.message);
    s.share_pw_hash = "set"; toast("Password set. Share it with your client separately."); route();
  };
  if ($("#pwClear")) $("#pwClear").onclick = async () => {
    const { error } = await sb.rpc("set_share_password", { p_shoot: s.id, p_password: "" });
    if (error) return toast(error.message);
    s.share_pw_hash = null; toast("Password removed"); route();
  };
  const paint = () => {
    if (!$("#tg")) return;
    $("#tg").setAttribute("aria-checked", s.sharing);
    $("#dl").setAttribute("aria-checked", s.allow_download);
    const expired = s.expires_at && new Date(s.expires_at) < new Date();
    $("#st").textContent = !s.sharing ? "Sharing is off. The link shows nothing until you turn it on."
      : expired ? "This link has expired. Clear or move the expiry date to reopen it."
      : `Sharing is on${s.share_pw_hash ? " with a password" : ""}. Anyone with the link${s.share_pw_hash ? " and password" : ""} can view and pick.`;
    const all = [...state.photos.values()], picks = all.filter((p) => p.pick), cl = state.comments.filter((c) => !c.from_owner);
    $("#act").innerHTML = `${s.submitted_at ? `<div class="submitted">✓ <b>${esc(s.submitted_by || "Client")}</b> sent their final selection · ${new Date(s.submitted_at).toLocaleString()}</div>` : ""}
      <div style="font-size:28px;font-family:var(--serif)">${picks.length} <span class="muted" style="font-size:14px">favorites</span> · ${cl.length} <span class="muted" style="font-size:14px">comments</span></div>
      ${picks.length ? `<p><a href="#/s/${s.id}/gallery">See client picks in the Gallery →</a></p>` : ""}
      ${cl.slice(-5).reverse().map((c) => `<div class="cmt" style="margin-top:8px"><b>${esc(c.author)}</b> on ${esc(state.photos.get(c.photo_id)?.name || "a photo")}<p>${esc(c.body)}</p></div>`).join("")}`;
  };
  $("#tg").onclick = () => save({ sharing: !s.sharing }, !s.sharing ? "Sharing on" : "Sharing off");
  $("#cp").onclick = () => copy(url);
  paint();
  return paint;
}

function bridgeTab(body, state) {
  const s = state.shoot;
  const cmd = `cd darkroom/bridge && ./start.sh ${s.ingest_key}`;
  body.replaceChildren(h(`<main><div class="wrap panel-grid">
    <div class="card"><div class="label">Step 1 · on your Mac</div><h3 class="card-h">Start the camera bridge</h3>
      <p class="muted">The bridge receives photos from your camera over Wi-Fi and develops them here. Run this in Terminal and leave it open while you shoot:</p>
      <div class="code" id="cmd">${esc(cmd)}</div>
      <div class="kv" style="margin-top:10px"><button class="btn" id="cpc">Copy command</button><button class="btn ghost" id="cpk">Copy shoot key</button></div>
      <p class="muted" style="font-size:12.5px">First time? <code>git clone https://github.com/jayeed17/darkroom</code>. The terminal prints your Mac's IP for step 2.</p></div>
    <div class="card"><div class="label">Step 2 · on the camera</div><h3 class="card-h">Sony FX3 · a7 IV · a7R V</h3>
      <ol class="steps">
        <li>Join the <b>same Wi-Fi</b> as your Mac. Guest networks and carrier hotspots usually block this; a travel router works everywhere.</li>
        <li><b>Network → FTP Transfer Func. → Server Setting → Server 1</b>: Host = the IP the bridge printed, Port <b>2121</b>, User <b>sony</b>, Password <b>darkroom</b>, Secure Protocol <b>Off</b>, Passive <b>On</b></li>
        <li><b>FTP Function: On</b> · <b>Auto FTP Transfer: On</b> · Transfer Target: <b>JPEG</b></li>
        <li>Shoot. Photos develop in the <a href="#/s/${s.id}/gallery">Gallery</a> within seconds.</li>
      </ol></div>
    <div class="card danger-card"><div class="label">Danger zone</div><h3 class="card-h">Delete this shoot</h3>
      <p class="muted">Removes every photo, comment, the album and the client link from Darkroom. Originals on your computer are not touched.</p>
      <button class="btn danger" id="delShoot">Delete shoot…</button></div>
  </div></main>`));
  $("#delShoot").onclick = async (e) => {
    const typed = prompt(`Type the shoot name to confirm deleting it:\n${s.title}`);
    if (typed === null) return;
    if (typed.trim() !== s.title.trim()) return toast("Name didn't match. Nothing was deleted.");
    e.target.disabled = true; e.target.textContent = "Deleting…";
    try { await manage({ action: "delete_shoot", shoot_id: s.id }); toast("Shoot deleted"); location.hash = "#/"; }
    catch (err) { toast("Couldn't delete: " + err.message); e.target.disabled = false; e.target.textContent = "Delete shoot…"; }
  };
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
    if (!wrap) return;
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

// client proofing page (no login)
async function proofView(token, wrongPw) {
  app.replaceChildren(h(`<div class="boot">Developing…</div>`));
  const pwKey = "darkroom:pw:" + token;
  let password = sget(pwKey) || null;
  const load = async () => {
    const { data: d, error } = await sb.rpc("share_get", { p_token: token, p_password: password });
    if (error) { if (/password/i.test(error.message)) return { needPassword: true }; throw error; }
    return d;
  };
  let data;
  const gen = ROUTE;
  try { data = await load(); } catch { data = null; }
  if (stale(gen)) return;
  if (data?.needPassword) {
    app.replaceChildren(h(`<div class="auth gate"><div class="auth-box">
      <span class="brand">${LOGO} Darkroom</span>
      <h1 style="font-size:34px">A private gallery.</h1>
      <p class="lede">Enter the password your photographer gave you.</p>
      <form id="g"><div class="pw"><input class="input" name="pw" type="password" placeholder="Gallery password">${EYE}</div>
      <div class="msg bad" id="gmsg">${password || wrongPw ? "That password isn't right." : ""}</div>
      <button class="btn primary big">Open gallery</button></form></div></div>`));
    wireEyes(app);
    $("#g").pw.focus();
    $("#g").onsubmit = (e) => { e.preventDefault(); sset(pwKey, e.target.pw.value); proofView(token, true); };
    return;
  }
  if (data?.expired) { app.replaceChildren(h(`<div class="empty"><h2>This gallery has closed</h2><p>The viewing window for this gallery has ended. Ask your photographer to reopen it.</p></div>`)); return; }
  if (!data) { app.replaceChildren(h(`<div class="empty"><h2>This gallery isn't available</h2><p>The link may be off or mistyped. Ask your photographer for a fresh one.</p></div>`)); return; }

  let name = lget("darkroom:name") || "";
  const photos = new Map(data.photos.map((p) => [p.id, p]));
  let comments = data.comments;
  const coverUrl = data.cover || data.photos[0]?.preview || "";
  app.replaceChildren(h(`<div class="proof">
    <section class="cover-hero ${coverUrl ? "" : "plain"}">
      ${coverUrl ? `<div class="cover-img" style="background-image:url('${esc(coverUrl)}')"></div>` : ""}
      <div class="cover-shade"></div>
      <div class="cover-text">
        <div class="label">${data.date ? esc(fmtDate(data.date)) : "Proofing gallery"}</div>
        <h1>${esc(data.title)}</h1>
        <p>${data.photos.length} photograph${data.photos.length === 1 ? "" : "s"}</p>
        <a class="btn ghost-light" href="#" id="enter">View gallery</a>
      </div>
    </section>
    <header class="top" id="ptop"><span class="brand">${LOGO} <span class="ptitle">${esc(data.title)}</span></span><span class="sp"></span><span class="count" id="cnt"></span>
      <div class="seg" id="flt"><button data-f="all" aria-pressed="true">All</button><button data-f="pick" aria-pressed="false">♥ Favorites</button></div>
      <button class="btn" id="show">▶ Slideshow</button></header>
    <p class="proof-help">Tap ♥ on the photos you love. Open a photo to comment${data.allow_download ? " or download" : ""}. When you're done, send your selection.${data.expires_at ? ` Open until ${esc(fmtDate(data.expires_at.slice(0, 10)))}.` : ""}</p>
    <div class="masonry" id="grid"></div>
    <div class="submit-bar" id="sbar"></div></div>`));
  $("#enter").onclick = (e) => { e.preventDefault(); $("#ptop").scrollIntoView({ behavior: "smooth" }); };
  let filter = "all";
  const wm = data.watermark ? `<div class="wm small" aria-hidden="true">${esc(data.watermark)}</div>` : "";
  const render = () => {
    const list = [...photos.values()].filter((p) => filter === "all" || p.pick);
    $("#grid").replaceChildren(...list.map((p) => {
      const el = h(`<div class="ph"><img loading="lazy" alt="" src="${esc(p.thumb)}" style="aspect-ratio:${p.w || 3}/${p.h || 2}">${wm}<button class="star heart ${p.pick ? "on" : ""}" title="Favorite">♥</button></div>`);
      const img = el.querySelector("img"); img.onload = () => img.classList.add("ok"); if (img.complete) img.classList.add("ok");
      if (!data.allow_download) img.oncontextmenu = (e) => e.preventDefault();
      el.querySelector(".heart").onclick = (e) => { e.stopPropagation(); pick(p); };
      el.onclick = () => openLb(list.map((x) => x.id), p.id, api);
      return el;
    }));
    if (!list.length && filter === "pick") $("#grid").innerHTML = `<p class="muted" style="text-align:center">No favorites yet. Tap ♥ on a photo to add it.</p>`;
    const n = [...photos.values()].filter((p) => p.pick).length;
    $("#cnt").textContent = `${photos.size} photos · ${n} ♥`;
    $("#sbar").innerHTML = data.submitted_at
      ? `<span>✓ Selection sent${data.submitted_by ? ` by ${esc(data.submitted_by)}` : ""} · ${esc(new Date(data.submitted_at).toLocaleDateString())}</span><button class="btn small ghost-light" id="resubmit">Send again</button>`
      : `<span><b>${n}</b> favorite${n === 1 ? "" : "s"} selected</span><button class="btn primary" id="submit" ${n ? "" : "disabled"}>Send my selection</button>`;
    ($("#submit") || $("#resubmit")).onclick = submit;
  };
  async function submit() {
    const n = [...photos.values()].filter((p) => p.pick).length;
    if (!n) return toast("Tap ♥ on your favorites first");
    if (!name) { name = (prompt("Your name, so your photographer knows who sent it") || "").trim(); if (name) lset("darkroom:name", name); }
    if (!confirm(`Send ${n} favorite${n === 1 ? "" : "s"} to your photographer?`)) return;
    const { data: ts, error } = await sb.rpc("share_submit", { p_token: token, p_name: name || "Client", p_password: password });
    if (error) return toast("Couldn't send, try again");
    data.submitted_at = ts; data.submitted_by = name || "Client"; render(); toast("Sent. Your photographer has your selection.");
  }
  async function pick(p) {
    p.pick = !p.pick; render(); lbRefresh();
    const { error } = await sb.rpc("share_pick", { p_token: token, p_photo: p.id, p_pick: p.pick, p_password: password });
    if (error) { p.pick = !p.pick; render(); toast("Couldn't save, try again"); }
  }
  const api = {
    get: (id) => photos.get(id),
    comments: (id) => comments.filter((c) => c.photo_id === id),
    head: (p) => `<button class="btn small" data-act="pick">${p.pick ? "♥ Favorited" : "♡ Favorite"}</button>${data.allow_download ? '<button class="btn small ghost" data-act="dl">Download</button>' : ""}`,
    act: (p, a) => { if (a === "pick") pick(p); if (a === "dl") download(p.preview, p.name.replace(/\.[^.]+$/, "") + ".jpg"); },
    send: async (p, text) => {
      if (!name) { name = (prompt("Your name (so your photographer knows who commented)") || "").trim(); if (name) lset("darkroom:name", name); }
      const { data: id, error } = await sb.rpc("share_comment", { p_token: token, p_photo: p.id, p_author: name || "Client", p_body: text, p_password: password });
      if (error) return toast("Couldn't send, try again");
      comments.push({ id, photo_id: p.id, author: name || "Client", body: text, from_owner: false });
    },
    info: (p) => esc(p.name),
    keys: { f: "pick" },
    watermark: data.watermark,
    noSave: !data.allow_download,
  };
  $("#flt").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; filter = b.dataset.f;
    $("#flt").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); render();
  };
  $("#show").onclick = () => {
    const list = [...photos.values()].filter((p) => filter === "all" || p.pick);
    if (!list.length) return toast("No photos to show");
    openShow(list.map((p) => p.preview), data.title, data.watermark);
  };
  render();
  const iv = setInterval(async () => {
    try { const d = await load(); if (d && !d.needPassword && !d.expired) { comments = d.comments; lbRefresh(); } } catch {}
  }, 20000);
  onLeave(() => clearInterval(iv));
}

route();
