-- Index the owner FK (performance advisor) and restrict uploads to JPEG, max 15 MB.
create index if not exists shoots_owner_idx on public.shoots (owner);
update storage.buckets set file_size_limit = 15728640, allowed_mime_types = array['image/jpeg'] where id = 'photos';
