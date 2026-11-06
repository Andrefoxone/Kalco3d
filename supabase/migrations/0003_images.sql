-- Galleria Foto: immagini create dal testo (source = 'ai') e foto usate per
-- generare i modelli (source = 'foto'). Separata dalla galleria dei modelli.
create table public.images (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source varchar(8) not null default 'ai',
  name varchar(120) not null default '',
  prompt varchar(600),
  style varchar(16),
  path varchar(255) not null,
  created_at timestamptz not null default now()
);
create index images_user_idx on public.images (user_id, created_at desc);

alter table public.images enable row level security;
create policy "lettura delle proprie immagini" on public.images
  for select to authenticated using ((select auth.uid()) = user_id);

-- le foto dei modelli AI già creati entrano subito nella galleria
insert into public.images (user_id, source, name, path, created_at)
select user_id, 'foto', name, photo_key, created_at
from public.models
where mode = 'ai' and photo_key <> '';
