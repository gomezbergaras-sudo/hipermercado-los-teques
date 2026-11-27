begin;

alter table public.rrhh_miembros
  add column usuario text unique check (
    usuario ~ '^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$'
    and position('..' in usuario) = 0
  );

grant select on public.rrhh_miembros to service_role;

create schema if not exists rrhh_privado;
revoke all on schema rrhh_privado from public, anon, authenticated;

-- Auth registra la cuenta y la membresía en la misma transacción.
create function rrhh_privado.registrar_usuario_app()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  alta jsonb := new.raw_app_meta_data -> 'hlt_rrhh_alta';
  alias_usuario text := alta ->> 'usuario';
  nombre_visible text := pg_catalog.btrim(alta ->> 'nombre');
begin
  if alta is null then return new; end if;
  if new.email is distinct from (alias_usuario || '@hlt-rrhh.example.com')
      or nombre_visible is null
      or not exists (
        select 1 from public.rrhh_miembros
        where usuario_id = (alta ->> 'creado_por')::uuid and activo and rol = 'gerencia'
      ) then
    raise exception 'Alta de usuario de RRHH no autorizada' using errcode = '42501';
  end if;
  insert into public.rrhh_miembros (usuario_id, nombre, rol, activo, usuario)
    values (new.id, nombre_visible, 'rrhh', true, alias_usuario);
  return new;
end;
$$;

revoke all on function rrhh_privado.registrar_usuario_app() from public, anon, authenticated;

create trigger hlt_registrar_usuario_app
after insert on auth.users
for each row execute function rrhh_privado.registrar_usuario_app();

commit;
