-- Catálogo de cuentos: la app lo lee con la clave pública; solo el script de publicación escribe.
create table public.cuentos (
  slug text primary key,
  titulo text not null,
  descripcion text not null default '',
  texto text not null,
  texto_hash text not null,
  audio_url text not null,
  duracion_s integer,
  orden integer not null default 0,
  publicado boolean not null default true,
  creado_en timestamptz not null default now()
);

alter table public.cuentos enable row level security;

create policy "lectura publica de cuentos publicados"
  on public.cuentos for select
  to anon
  using (publicado);

grant select on public.cuentos to anon;
grant all on public.cuentos to service_role;

-- Bucket público para los audios (la escritura queda reservada a la clave secreta).
insert into storage.buckets (id, name, public)
values ('cuentos-audio', 'cuentos-audio', true)
on conflict (id) do nothing;
