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
const pathsFor = (shootId: string, name: string) => {
  const stem = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.[^.]+$/, "");
  return [`${shootId}/${stem}.thumb.jpg`, `${shootId}/${stem}.preview.jpg`];
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
      const { data: p } = await admin.from("photos").select("id,name,shoot_id,shoots!inner(owner)").eq("id", Number(b.photo_id)).maybeSingle();
      // deno-lint-ignore no-explicit-any
      if (!p || (p as any).shoots.owner !== uid) return json({ error: "not found" }, 404);
      await removeAll(pathsFor(p.shoot_id, p.name));
      await admin.from("photos").delete().eq("id", p.id);
      return json({ ok: true });
    }
    if (b.action === "delete_shoot") {
      const { data: s } = await admin.from("shoots").select("id,owner").eq("id", String(b.shoot_id)).maybeSingle();
      if (!s || s.owner !== uid) return json({ error: "not found" }, 404);
      await removeAll(await listAll(s.id));
      await admin.from("shoots").delete().eq("id", s.id);
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
