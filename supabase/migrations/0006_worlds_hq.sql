-- Scene: versione dello splat a piena risoluzione (più nitida) accanto a
-- quella leggera da 500k splat.
alter table public.worlds add column if not exists spz_hq_key varchar(255);
alter table public.worlds add column if not exists spz_hq_resolution varchar(16);
alter table public.worlds add column if not exists spz_hq_bytes integer not null default 0;
