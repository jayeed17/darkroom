// Darkroom ingest: the camera bridge talks to this function with a per-shoot ingest key.
// The service-role key never leaves Supabase.
//   {action:"hello",   key}                       -> {shoot_id, title}
//   {action:"prepare", key, name}                 -> signed upload URLs for thumb + preview
//   {action:"commit",  key, name, ...metadata}    -> inserts/updates the photo row (gallery updates live)
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BUCKET = "photos";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const stem = (name: string) => safe(name).replace(/\.[^.]+$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const key = String(b.key ?? "");
  if (!/^[0-9a-f]{24}$/.test(key)) return json({ error: "invalid key" }, 401);
  const { data: shoot } = await db.from("shoots").select("id,title").eq("ingest_key", key).maybeSingle();
  if (!shoot) return json({ error: "invalid key" }, 401);

  if (b.action === "hello") return json({ shoot_id: shoot.id, title: shoot.title });

  const name = safe(String(b.name ?? ""));
  if (!name) return json({ error: "name required" }, 400);
  const base = `${shoot.id}/${stem(name)}`;
  const paths = { thumb: `${base}.thumb.jpg`, preview: `${base}.preview.jpg` };

  if (b.action === "prepare") {
    const out: Record<string, string> = {};
    for (const [k, path] of Object.entries(paths)) {
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error) return json({ error: error.message }, 500);
      out[k] = data.signedUrl;
    }
    return json({ upload: out });
  }

  if (b.action === "commit") {
    const pub = (p: string) => db.storage.from(BUCKET).getPublicUrl(p).data.publicUrl + `?v=${Date.now()}`;
    let dup_of: number | null = null;
    if (b.dup_of_name) {
      const { data } = await db.from("photos").select("id")
        .eq("shoot_id", shoot.id).eq("name", safe(String(b.dup_of_name))).maybeSingle();
      dup_of = data?.id ?? null;
    }
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
    const row = {
      shoot_id: shoot.id,
      name,
      w: num(b.w), h: num(b.h),
      taken: typeof b.taken === "string" ? b.taken : new Date().toISOString(),
      sharpness: num(b.sharpness),
      blurry: Boolean(b.blurry),
      dup_of,
      camera: typeof b.camera === "string" ? b.camera.slice(0, 80) : null,
      thumb_url: pub(paths.thumb),
      preview_url: pub(paths.preview),
    };
    const { data, error } = await db.from("photos").upsert(row, { onConflict: "shoot_id,name" }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ id: data.id });
  }

  return json({ error: "unknown action" }, 400);
});
