-- Clients may only act on photos they can actually see on the proofing page:
-- the starred photos, or, if nothing is starred, every photo that isn't blurry or a duplicate.
-- Before this, share_pick / share_comment accepted any photo id in the shoot, and share_get
-- returned comments attached to hidden photos.

create or replace function public._share_visible(p_shoot uuid, p_photo bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.photos p
    where p.id = p_photo and p.shoot_id = p_shoot
      and case when exists (select 1 from public.photos x where x.shoot_id = p_shoot and x.star)
               then p.star else (not p.blurry and p.dup_of is null) end
  );
$$;
revoke all on function public._share_visible(uuid, bigint) from public, anon, authenticated;

create or replace function public.share_pick(p_token text, p_photo bigint, p_pick boolean, p_password text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare s public.shoots;
begin
  s := public._share_gate(p_token, p_password);
  if s.id is null or not public._share_visible(s.id, p_photo) then
    raise exception 'not found';
  end if;
  update public.photos set pick = p_pick where id = p_photo and shoot_id = s.id;
end $$;

create or replace function public.share_comment(p_token text, p_photo bigint, p_author text, p_body text, p_password text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare s public.shoots; new_id bigint;
begin
  s := public._share_gate(p_token, p_password);
  if s.id is null or not public._share_visible(s.id, p_photo) then
    raise exception 'not found';
  end if;
  if coalesce(trim(p_body), '') = '' then
    raise exception 'empty comment';
  end if;
  insert into public.comments (shoot_id, photo_id, author, body)
  values (s.id, p_photo, left(coalesce(nullif(trim(p_author), ''), 'Client'), 80), left(trim(p_body), 2000))
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.share_get(p_token text, p_password text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
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
      from public.comments c
      join public.photos p on p.id = c.photo_id
      where c.shoot_id = s.id
        and (case when any_star then p.star else (not p.blurry and p.dup_of is null) end)), '[]'::jsonb));
end $$;
