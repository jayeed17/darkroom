-- Profiles (name + phone collected at sign-up) and client-gallery settings
-- (cover, date, password, expiry, downloads, watermark, submitted selections).

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text check (char_length(full_name) <= 120),
  phone      text check (char_length(phone) <= 40),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "own profile insert" on public.profiles for insert to authenticated with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id,
          nullif(left(trim(new.raw_user_meta_data->>'full_name'), 120), ''),
          nullif(left(trim(new.raw_user_meta_data->>'phone'), 40), ''))
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

alter table public.shoots
  add column if not exists cover_photo   bigint references public.photos(id) on delete set null,
  add column if not exists shoot_date    date,
  add column if not exists share_pw_hash text,
  add column if not exists expires_at    timestamptz,
  add column if not exists allow_download boolean not null default false,
  add column if not exists watermark     text check (char_length(watermark) <= 60),
  add column if not exists submitted_at  timestamptz,
  add column if not exists submitted_by  text;
create index if not exists shoots_cover_idx on public.shoots (cover_photo);

-- owner sets/clears the gallery password (stored as a bcrypt hash)
create or replace function public.set_share_password(p_shoot uuid, p_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.shoots
     set share_pw_hash = case when coalesce(p_password, '') = '' then null
                              else extensions.crypt(p_password, extensions.gen_salt('bf')) end
   where id = p_shoot and owner = auth.uid();
  if not found then raise exception 'not found'; end if;
end $$;
revoke all on function public.set_share_password(uuid, text) from public, anon;
grant execute on function public.set_share_password(uuid, text) to authenticated;

-- shared gate used by every client RPC
create or replace function public._share_gate(p_token text, p_password text)
returns public.shoots language plpgsql stable security definer set search_path = '' as $$
declare s public.shoots;
begin
  select * into s from public.shoots where share_token = p_token and sharing;
  if not found then return null; end if;
  if s.expires_at is not null and s.expires_at < now() then return null; end if;
  if s.share_pw_hash is not null and (p_password is null or extensions.crypt(p_password, s.share_pw_hash) <> s.share_pw_hash) then
    raise exception 'password required' using errcode = '28P01';
  end if;
  return s;
end $$;
revoke all on function public._share_gate(text, text) from public, anon, authenticated;

drop function if exists public.share_get(text);
drop function if exists public.share_pick(text, bigint, boolean);
drop function if exists public.share_comment(text, bigint, text, text);

create or replace function public.share_get(p_token text, p_password text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.shoots; any_star boolean; expired boolean;
begin
  select (expires_at is not null and expires_at < now()) into expired from public.shoots where share_token = p_token and sharing;
  if expired then return jsonb_build_object('expired', true); end if;
  s := public._share_gate(p_token, p_password);
  if s.id is null then return null; end if;
  select exists(select 1 from public.photos where shoot_id = s.id and star) into any_star;
  return jsonb_build_object(
    'title', s.title,
    'date', s.shoot_date,
    'expires_at', s.expires_at,
    'allow_download', s.allow_download,
    'watermark', s.watermark,
    'submitted_at', s.submitted_at,
    'submitted_by', s.submitted_by,
    'cover', (select coalesce(p.preview_url, p.thumb_url) from public.photos p where p.id = s.cover_photo),
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

create or replace function public.share_pick(p_token text, p_photo bigint, p_pick boolean, p_password text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.shoots;
begin
  s := public._share_gate(p_token, p_password);
  if s.id is null then return; end if;
  update public.photos set pick = p_pick where id = p_photo and shoot_id = s.id;
end $$;

create or replace function public.share_comment(p_token text, p_photo bigint, p_author text, p_body text, p_password text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare s public.shoots; new_id bigint;
begin
  s := public._share_gate(p_token, p_password);
  if s.id is null or not exists (select 1 from public.photos where id = p_photo and shoot_id = s.id) then
    raise exception 'not found';
  end if;
  insert into public.comments (shoot_id, photo_id, author, body)
  values (s.id, p_photo, left(coalesce(nullif(trim(p_author), ''), 'Client'), 80), left(trim(p_body), 2000))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.share_submit(p_token text, p_name text, p_password text default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare s public.shoots; ts timestamptz := now();
begin
  s := public._share_gate(p_token, p_password);
  if s.id is null then raise exception 'not found'; end if;
  update public.shoots set submitted_at = ts, submitted_by = left(coalesce(nullif(trim(p_name), ''), 'Client'), 80) where id = s.id;
  return ts;
end $$;

revoke all on function public.share_get(text, text) from public;
revoke all on function public.share_pick(text, bigint, boolean, text) from public;
revoke all on function public.share_comment(text, bigint, text, text, text) from public;
revoke all on function public.share_submit(text, text, text) from public;
grant execute on function public.share_get(text, text) to anon, authenticated;
grant execute on function public.share_pick(text, bigint, boolean, text) to anon, authenticated;
grant execute on function public.share_comment(text, bigint, text, text, text) to anon, authenticated;
grant execute on function public.share_submit(text, text, text) to anon, authenticated;

alter publication supabase_realtime add table public.shoots;
