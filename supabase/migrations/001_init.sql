-- Darkroom schema: shoots, photos, client comments, share links.

create extension if not exists pgcrypto with schema extensions;

create table public.shoots (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null default 'Untitled shoot',
  ingest_key   text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  share_token  text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  sharing      boolean not null default false,
  album        jsonb not null default '{"size":"12x12","spreads":[]}'::jsonb,
  created_at   timestamptz not null default now()
);

create table public.photos (
  id          bigint generated always as identity primary key,
  shoot_id    uuid not null references public.shoots(id) on delete cascade,
  name        text not null,
  w           int,
  h           int,
  taken       timestamptz,
  sharpness   real,
  blurry      boolean not null default false,
  dup_of      bigint references public.photos(id) on delete set null,
  star        boolean not null default false,
  pick        boolean not null default false,          -- client favorite
  camera      text,
  thumb_url   text,
  preview_url text,
  created_at  timestamptz not null default now(),
  unique (shoot_id, name)
);
create index photos_shoot_idx on public.photos (shoot_id, taken desc);
create index photos_dup_idx on public.photos (dup_of);

create table public.comments (
  id         bigint generated always as identity primary key,
  shoot_id   uuid not null references public.shoots(id) on delete cascade,
  photo_id   bigint not null references public.photos(id) on delete cascade,
  author     text not null default 'Client',
  body       text not null check (char_length(body) between 1 and 2000),
  from_owner boolean not null default false,
  created_at timestamptz not null default now()
);
create index comments_photo_idx on public.comments (photo_id);
create index comments_shoot_idx on public.comments (shoot_id);

-- ---------- RLS: owners see only their own data ----------
alter table public.shoots   enable row level security;
alter table public.photos   enable row level security;
alter table public.comments enable row level security;

create policy "own shoots" on public.shoots
  for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy "own photos" on public.photos
  for all to authenticated
  using (exists (select 1 from public.shoots s where s.id = shoot_id and s.owner = (select auth.uid())))
  with check (exists (select 1 from public.shoots s where s.id = shoot_id and s.owner = (select auth.uid())));

create policy "own comments" on public.comments
  for all to authenticated
  using (exists (select 1 from public.shoots s where s.id = shoot_id and s.owner = (select auth.uid())))
  with check (exists (select 1 from public.shoots s where s.id = shoot_id and s.owner = (select auth.uid())));

-- ---------- Client proofing (no login, share token) ----------
-- Clients see starred photos; if nothing is starred yet, every non-flagged photo.
create or replace function public.share_get(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.shoots; any_star boolean;
begin
  select * into s from public.shoots where share_token = p_token and sharing;
  if not found then return null; end if;
  select exists(select 1 from public.photos where shoot_id = s.id and star) into any_star;
  return jsonb_build_object(
    'title', s.title,
    'photos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'w', p.w, 'h', p.h, 'pick', p.pick,
        'thumb', p.thumb_url, 'preview', p.preview_url) order by p.taken, p.id)
      from public.photos p
      where p.shoot_id = s.id
        and (case when any_star then p.star else (not p.blurry and p.dup_of is null) end)), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'photo_id', c.photo_id, 'author', c.author, 'body', c.body,
        'from_owner', c.from_owner, 'created_at', c.created_at) order by c.created_at)
      from public.comments c where c.shoot_id = s.id), '[]'::jsonb));
end $$;

create or replace function public.share_pick(p_token text, p_photo bigint, p_pick boolean)
returns void language sql security definer set search_path = '' as $$
  update public.photos p set pick = p_pick
  from public.shoots s
  where p.id = p_photo and p.shoot_id = s.id and s.share_token = p_token and s.sharing;
$$;

create or replace function public.share_comment(p_token text, p_photo bigint, p_author text, p_body text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sid uuid; new_id bigint;
begin
  select s.id into sid from public.shoots s join public.photos p on p.shoot_id = s.id
   where s.share_token = p_token and s.sharing and p.id = p_photo;
  if sid is null then raise exception 'not found'; end if;
  insert into public.comments (shoot_id, photo_id, author, body)
  values (sid, p_photo, left(coalesce(nullif(trim(p_author), ''), 'Client'), 80), left(trim(p_body), 2000))
  returning id into new_id;
  return new_id;
end $$;

revoke all on function public.share_get(text) from public;
revoke all on function public.share_pick(text, bigint, boolean) from public;
revoke all on function public.share_comment(text, bigint, text, text) from public;
grant execute on function public.share_get(text) to anon, authenticated;
grant execute on function public.share_pick(text, bigint, boolean) to anon, authenticated;
grant execute on function public.share_comment(text, bigint, text, text) to anon, authenticated;

-- ---------- Storage: public-read bucket, uuid-scoped paths, writes only via signed URLs ----------
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

-- ---------- Realtime: live gallery ----------
alter publication supabase_realtime add table public.photos;
alter publication supabase_realtime add table public.comments;
