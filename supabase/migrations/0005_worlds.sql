-- Scene (ambienti 3D) generate con World Labs Marble. Tabella separata dalla
-- galleria Modelli: una scena è un Gaussian splat (SPZ) da esplorare, con
-- mesh di collisione e, su richiesta, mesh GLB texturizzata.
-- Da applicare nell'SQL Editor di Supabase (progetto "Kalco3D").
create table if not exists public.worlds (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name varchar(120) not null,
  source varchar(8) not null,
  prompt varchar(2000),
  photo_key varchar(255),
  quality varchar(16) not null,
  status varchar(16) not null default 'processing',
  error varchar(255),
  progress integer not null default 0,
  stage varchar(96),
  credits_paid integer not null default 0,
  world_id varchar(96),
  marble_url varchar(255),
  caption varchar(600),
  spz_key varchar(255),
  spz_resolution varchar(16),
  collider_key varchar(255),
  pano_key varchar(255),
  thumb_key varchar(255),
  metric_scale double precision not null default 1,
  ground_offset double precision not null default 0,
  size_bytes integer not null default 0,
  mesh_status varchar(16),
  mesh_key varchar(255),
  mesh_error varchar(255),
  mesh_credits_paid integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists worlds_user_created_idx on public.worlds (user_id, created_at desc);
create index if not exists worlds_processing_idx on public.worlds (status) where status = 'processing';
create index if not exists worlds_mesh_processing_idx on public.worlds (mesh_status) where mesh_status = 'processing';

alter table public.worlds enable row level security;
-- il server usa una connessione privilegiata; dal browser ognuno vede solo le sue scene
create policy "lettura delle proprie scene" on public.worlds
  for select to authenticated using ((select auth.uid()) = user_id);
