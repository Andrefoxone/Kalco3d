-- Kalco3D — schema iniziale (già applicato al progetto Supabase "Kalco3D").
-- Per un nuovo progetto: incollalo nell'SQL Editor di Supabase, oppure
-- `supabase db push` con la CLI.

create table public.models (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name varchar(120) not null,
  mode varchar(16) not null,
  glb_key varchar(255) not null default '',
  photo_key varchar(255) not null default '',
  vertices integer not null default 0,
  triangles integer not null default 0,
  size_bytes integer not null default 0,
  status varchar(16) not null default 'ready',
  error varchar(255),
  provider varchar(32),
  provider_model varchar(64),
  quality varchar(16),
  target varchar(16),
  views integer not null default 1,
  progress integer not null default 0,
  stage varchar(96),
  preview_key varchar(255),
  created_at timestamptz not null default now()
);
create index models_user_created_idx on public.models (user_id, created_at desc);
create index models_processing_idx on public.models (status) where status = 'processing';

alter table public.models enable row level security;
-- il server usa una connessione privilegiata; dal browser ognuno vede solo i suoi modelli
create policy "lettura dei propri modelli" on public.models
  for select to authenticated using ((select auth.uid()) = user_id);

-- bucket privato per GLB, foto e anteprime (100 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('kalco3d', 'kalco3d', false, 104857600)
on conflict (id) do nothing;
