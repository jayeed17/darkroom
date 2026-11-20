// Darkroom manage: owner-only destructive actions that must also clean up storage.
//   {action:"delete_photo", photo_id}
//   {action:"delete_shoot", shoot_id}
//   {action:"sweep_orphans"}   removes stored files whose shoot no longer exists
// Requires the signed-in user's JWT; ownership is checked before anything is removed.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "photos";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function listAll(prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    out.push(...data.filter((f) => f.id).map((f) => `${prefix}/${f.name}`));
    if (data.length < 1000) return out;
  }
}
async function removeAll(paths: string[]) {
  for (let i = 0; i < paths.length; i += 900) {
    const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 900));
    if (error) throw error;
  }
}
// The stored URLs say exactly where the files are (new files carry an unguessable code in their name);
// the name-based paths cover photos uploaded before that.
const pathsFor = (p: { shoot_id: string; name: string; thumb_url?: string | null; preview_url?: string | null }) => {
  const stem = p.name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.[^.]+$/, "");
  const fromUrl = (u?: string | null) => {
    const m = u && decodeURIComponent(u.split("?")[0]).match(/\/object\/public\/photos\/(.+)$/);
    return m && m[1].startsWith(`${p.shoot_id}/`) ? m[1] : null;
  };
  const out = [fromUrl(p.thumb_url), fromUrl(p.preview_url), `${p.shoot_id}/${stem}.thumb.jpg`, `${p.shoot_id}/${stem}.preview.jpg`];
  return [...new Set(out.filter(Boolean) as string[])];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "sign in required" }, 401);
  const uid = u.user.id;
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    if (b.action === "delete_photo") {
      // two plain lookups (no embed): shoots<->photos has two foreign keys since cover_photo, so an embed is ambiguous
      const { data: p, error: pe } = await admin.from("photos").select("id,name,shoot_id,thumb_url,preview_url").eq("id", Number(b.photo_id)).maybeSingle();
      if (pe) throw pe;
      const { data: own } = p ? await admin.from("shoots").select("owner").eq("id", p.shoot_id).maybeSingle() : { data: null };
      if (!p || !own || own.owner !== uid) return json({ error: "not found" }, 404);
      await removeAll(pathsFor(p));
      { const { error } = await admin.from("photos").delete().eq("id", p.id); if (error) throw error; }
      return json({ ok: true });
    }
    if (b.action === "delete_shoot") {
      const { data: s } = await admin.from("shoots").select("id,owner").eq("id", String(b.shoot_id)).maybeSingle();
      if (!s || s.owner !== uid) return json({ error: "not found" }, 404);
      await removeAll(await listAll(s.id));
      { const { error } = await admin.from("shoots").delete().eq("id", s.id); if (error) throw error; }
      return json({ ok: true });
    }
    if (b.action === "sweep_orphans") {
      const { data: top, error } = await admin.storage.from(BUCKET).list("", { limit: 1000 });
      if (error) throw error;
      const folders = top.filter((f) => !f.id).map((f) => f.name);
      const { data: live } = await admin.from("shoots").select("id").in("id", folders.length ? folders : ["00000000-0000-0000-0000-000000000000"]);
      const keep = new Set((live || []).map((s) => s.id));
      let removed = 0;
      for (const f of folders.filter((f) => !keep.has(f))) { const p = await listAll(f); await removeAll(p); removed += p.length; }
      return json({ ok: true, removed });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
