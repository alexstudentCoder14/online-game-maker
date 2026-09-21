-- Shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles (one per auth user)
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Projects (the "saved projects" list)
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  thumbnail_path text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_opened_at timestamptz
);
create index projects_owner_updated_idx on public.projects (owner_id, updated_at desc);

-- Scenes belong to a project; scene graph / ECS data stored as JSON
create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null default 'Untitled Scene',
  data jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scenes_project_idx on public.scenes (project_id, sort_order);

-- Assets: metadata for files held in Supabase Storage
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('model','texture','material','audio','script','font','other')),
  storage_bucket text not null default 'project-assets',
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb, -- e.g. triangle count, LOD paths, compression
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);
create index assets_project_idx on public.assets (project_id, kind);
create index assets_owner_idx on public.assets (owner_id);
create index assets_tags_idx on public.assets using gin (tags);

-- Version history snapshots
create table public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  label text,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index project_versions_project_idx on public.project_versions (project_id, created_at desc);
create index project_versions_created_by_idx on public.project_versions (created_by);

-- Export builds (Android / macOS / Windows / web)
create table public.builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('android','macos','windows','web')),
  status text not null default 'queued' check (status in ('queued','building','succeeded','failed')),
  artifact_path text,
  log text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index builds_project_idx on public.builds (project_id, created_at desc);
create index builds_requested_by_idx on public.builds (requested_by);

-- updated_at triggers
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();
create trigger scenes_updated_at before update on public.scenes
  for each row execute function public.set_updated_at();

-- Auto-create a profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.scenes enable row level security;
alter table public.assets enable row level security;
alter table public.project_versions enable row level security;
alter table public.builds enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "projects_all_own" on public.projects for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "scenes_all_own" on public.scenes for all to authenticated
  using (exists (select 1 from public.projects p where p.id = scenes.project_id and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.projects p where p.id = scenes.project_id and p.owner_id = (select auth.uid())));

create policy "assets_all_own" on public.assets for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.projects p where p.id = assets.project_id and p.owner_id = (select auth.uid()))
  );

create policy "versions_all_own" on public.project_versions for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_versions.project_id and p.owner_id = (select auth.uid())))
  with check (
    created_by = (select auth.uid())
    and exists (select 1 from public.projects p where p.id = project_versions.project_id and p.owner_id = (select auth.uid()))
  );

create policy "builds_all_own" on public.builds for all to authenticated
  using (exists (select 1 from public.projects p where p.id = builds.project_id and p.owner_id = (select auth.uid())))
  with check (
    requested_by = (select auth.uid())
    and exists (select 1 from public.projects p where p.id = builds.project_id and p.owner_id = (select auth.uid()))
  );

-- Storage buckets (private). Files are stored under "<user_id>/<project_id>/<file>"
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('project-assets', 'project-assets', false, 52428800),
  ('build-artifacts', 'build-artifacts', false, 52428800)
on conflict (id) do nothing;

create policy "assets_storage_select_own" on storage.objects for select to authenticated
  using (bucket_id in ('project-assets','build-artifacts') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "assets_storage_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id in ('project-assets','build-artifacts') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "assets_storage_update_own" on storage.objects for update to authenticated
  using (bucket_id in ('project-assets','build-artifacts') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "assets_storage_delete_own" on storage.objects for delete to authenticated
  using (bucket_id in ('project-assets','build-artifacts') and (storage.foldername(name))[1] = (select auth.uid())::text);
