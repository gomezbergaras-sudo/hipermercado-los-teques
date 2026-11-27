begin;

create table public.rrhh_miembros (
  usuario_id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null check (length(btrim(nombre)) between 1 and 160),
  rol text not null check (rol in ('gerencia', 'rrhh')),
  activo boolean not null default true
);

create table public.rrhh_registros (
  coleccion text not null check (coleccion in (
    'config', 'empleados', 'bonos', 'evaluaciones', 'evalsup', 'asistencia', 'nomina',
    'dias_libres', 'inc_personal', 'candidatos', 'parametros_legales', 'conceptos_nomina',
    'liquidaciones', 'historial_salarios', 'personas_gerencia', 'conceptos_pago', 'reposos'
  )),
  id text not null check (id ~ '^[A-Za-z0-9_.-]{1,100}$'),
  contenido jsonb not null check (
    jsonb_typeof(contenido) = 'object' and
    contenido ? 'id' and (contenido ->> 'id') is not distinct from id and
    (not (contenido ? 'empleado_id') or
      coalesce(contenido ->> 'empleado_id', '') ~ '^([A-Za-z0-9_.-]{1,100})?$')
  ),
  revision bigint not null default 1 check (revision > 0),
  actualizado timestamptz not null default now(),
  primary key (coleccion, id)
);

alter table public.rrhh_miembros enable row level security;
alter table public.rrhh_registros enable row level security;
revoke all on public.rrhh_miembros, public.rrhh_registros from public, anon, authenticated;
grant select on public.rrhh_miembros to authenticated;
grant select, delete on public.rrhh_registros to authenticated;
grant insert (coleccion, id, contenido) on public.rrhh_registros to authenticated;
grant update (contenido) on public.rrhh_registros to authenticated;

create policy "Cada usuario puede leer su membresía activa"
on public.rrhh_miembros for select to authenticated
using (usuario_id = (select auth.uid()) and activo);

create function public.rrhh_permiso(coleccion text, id text, contenido jsonb, escritura boolean)
returns boolean
language sql
stable security invoker
set search_path = ''
as $$
  select coalesce((
    select m.rol = 'gerencia' or (
      m.rol = 'rrhh'
      and coleccion <> 'personas_gerencia'
      and (coleccion <> 'nomina' or left(coalesce(contenido ->> 'empleado_id', ''), 4) <> 'ger_')
      and (coleccion <> 'config' or left(id, 16) <> 'nomina_tasa_ger_')
      and (not escritura or (
        coleccion not in ('parametros_legales', 'conceptos_pago')
        and (coleccion <> 'config' or
          id in ('retardo_tol', 'retardo_bsmin', 'ver_moneda', 'constancia_cfg') or
          id ~ '^nomina_tasa_[0-9]{4}-[0-9]{2}-Q[12]$')
      ))
    )
    from public.rrhh_miembros m
    where m.usuario_id = (select auth.uid()) and m.activo
  ), false);
$$;

revoke all on function public.rrhh_permiso(text, text, jsonb, boolean) from public, anon;
grant execute on function public.rrhh_permiso(text, text, jsonb, boolean) to authenticated;

create policy "Leer registros autorizados"
on public.rrhh_registros for select to authenticated
using (public.rrhh_permiso(coleccion, id, contenido, false));
create policy "Crear registros autorizados"
on public.rrhh_registros for insert to authenticated
with check (public.rrhh_permiso(coleccion, id, contenido, true) and revision = 1);
create policy "Editar registros autorizados"
on public.rrhh_registros for update to authenticated
using (public.rrhh_permiso(coleccion, id, contenido, true))
with check (public.rrhh_permiso(coleccion, id, contenido, true));
create policy "Borrar registros autorizados"
on public.rrhh_registros for delete to authenticated
using (public.rrhh_permiso(coleccion, id, contenido, true));

create function public.rrhh_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  new.actualizado := pg_catalog.now();
  return new;
end;
$$;
revoke all on function public.rrhh_revision() from public, anon, authenticated;
create trigger rrhh_revision before update on public.rrhh_registros
for each row execute function public.rrhh_revision();

-- Evita dos fichas con la misma cédula, incluso en altas simultáneas.
create unique index rrhh_cedula_empleado
on public.rrhh_registros ((lower(regexp_replace(contenido ->> 'cedula', '[^A-Za-z0-9]', '', 'g'))))
where coleccion = 'empleados'
  and nullif(regexp_replace(contenido ->> 'cedula', '[^A-Za-z0-9]', '', 'g'), '') is not null;

-- La restauración reemplaza los registros como una sola transacción.
create function public.rrhh_restaurar(registros jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.rrhh_miembros
    where usuario_id = (select auth.uid()) and activo and rol = 'gerencia'
  ) then
    raise exception 'Restauración reservada a Gerencia' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(registros), '') <> 'object' then
    raise exception 'Respaldo de RRHH inválido';
  end if;
  delete from public.rrhh_registros;
  insert into public.rrhh_registros (coleccion, id, contenido)
  select tabla.key, registro.value ->> 'id', registro.value
  from jsonb_each(registros) tabla
  cross join lateral jsonb_array_elements(tabla.value) registro;
end;
$$;
revoke all on function public.rrhh_restaurar(jsonb) from public, anon;
grant execute on function public.rrhh_restaurar(jsonb) to authenticated;

commit;
