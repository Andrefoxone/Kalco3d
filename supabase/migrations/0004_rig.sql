-- Auto-rigging: un modello animato nasce da un altro modello e può avere
-- anche una copia FBX (per Blender, Unreal, Unity).
alter table public.models add column if not exists parent_id bigint references public.models(id) on delete set null;
alter table public.models add column if not exists fbx_key varchar(255);
-- animazioni presenti nel file, separate da virgola (es. "preset:idle,preset:walk")
alter table public.models add column if not exists animations varchar(255);
