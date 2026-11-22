create table public.horas_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encryption jsonb
);

create table public.records (
  user_id uuid not null references auth.users(id) on delete cascade,
  collection text not null check (collection in ('periods','entries','comps','leaves','holidays','rules')),
  id uuid not null,
  data jsonb,
  revision uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  primary key (user_id,id),
  check ((deleted_at is null and data is not null) or (deleted_at is not null and data is null))
);

create schema if not exists horas_private;
revoke all on schema horas_private from public;

create table horas_private.mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  revision uuid not null,
  primary key (user_id, revision)
);

alter table public.records enable row level security;
alter table public.horas_profiles enable row level security;
alter table horas_private.mutations enable row level security;

create policy "Read own hours" on public.records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Read own encryption profile" on public.horas_profiles
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.records, public.horas_profiles from anon, authenticated;
grant select on public.records, public.horas_profiles to authenticated;

create function horas_private.push(changes jsonb, encrypted boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  row_data jsonb;
  mode jsonb;
  change_id uuid;
  change_rev uuid;
  change_at timestamptz;
  is_deleted boolean;
  payload jsonb;
begin
  if owner_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 100 then raise exception 'Invalid batch'; end if;
  insert into public.horas_profiles(user_id) values (owner_id) on conflict do nothing;
  select encryption into mode from public.horas_profiles where user_id=owner_id for update;
  if (mode is not null) is distinct from encrypted then raise exception 'Encryption mode changed'; end if;
  for row_data in select value from jsonb_array_elements(changes)
  loop
    change_id := (row_data->>'id')::uuid;
    change_rev := (row_data->>'revision')::uuid;
    is_deleted := (row_data->>'deleted')::boolean;
    payload := case when is_deleted then null else row_data->'data' end;
    if not is_deleted and (
      jsonb_typeof(payload) is distinct from 'object' or
      (encrypted and not (payload ? 'iv' and payload ? 'ciphertext'))
    ) then raise exception 'Invalid record'; end if;
    insert into horas_private.mutations(user_id,revision) values (owner_id,change_rev) on conflict do nothing;
    if not found then continue; end if;

    select greatest(clock_timestamp(),updated_at + interval '1 microsecond')
      into change_at from public.records where user_id=owner_id and id=change_id;
    change_at := coalesce(change_at,clock_timestamp());
    insert into public.records(user_id,collection,id,data,revision,updated_at,deleted_at)
    values(owner_id,row_data->>'collection',change_id,payload,change_rev,change_at,case when is_deleted then change_at end)
    on conflict(user_id,id) do update set collection=excluded.collection,data=excluded.data,
      revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at;
  end loop;
end;
$$;

create function horas_private.enable_encryption(config jsonb, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  mode jsonb;
  row_data jsonb;
  count_records bigint;
begin
  if owner_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(config) is distinct from 'object' or not (config ? 'salt' and config ? 'check')
    or jsonb_typeof(changes) is distinct from 'array' then raise exception 'Invalid configuration'; end if;
  insert into public.horas_profiles(user_id) values (owner_id) on conflict do nothing;
  select encryption into mode from public.horas_profiles where user_id=owner_id for update;
  if mode is not null then raise exception 'Encryption already enabled'; end if;
  select count(*) into count_records from public.records where user_id=owner_id and deleted_at is null;
  if count_records <> jsonb_array_length(changes) then raise exception 'Records changed'; end if;
  for row_data in select value from jsonb_array_elements(changes)
  loop
    if jsonb_typeof(row_data->'data') is distinct from 'object'
      or not ((row_data->'data') ? 'iv' and (row_data->'data') ? 'ciphertext')
      then raise exception 'Invalid ciphertext'; end if;
    update public.records set data=row_data->'data', updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond')
      where user_id=owner_id and id=(row_data->>'id')::uuid and revision=(row_data->>'revision')::uuid
      and deleted_at is null and (data->'ciphertext') is null;
    if not found then raise exception 'Records changed'; end if;
  end loop;
  update public.horas_profiles set encryption=config where user_id=owner_id;
end;
$$;

revoke all on function horas_private.push(jsonb,boolean), horas_private.enable_encryption(jsonb,jsonb) from public;
grant usage on schema horas_private to authenticated;
grant execute on function horas_private.push(jsonb,boolean), horas_private.enable_encryption(jsonb,jsonb) to authenticated;

create function public.horas_push(changes jsonb, encrypted boolean)
returns void language sql security invoker set search_path = '' as $$
  select horas_private.push(changes,encrypted);
$$;

create function public.horas_enable_encryption(config jsonb, changes jsonb)
returns void language sql security invoker set search_path = '' as $$
  select horas_private.enable_encryption(config,changes);
$$;

revoke all on function public.horas_push(jsonb,boolean), public.horas_enable_encryption(jsonb,jsonb) from public, anon;
grant execute on function public.horas_push(jsonb,boolean), public.horas_enable_encryption(jsonb,jsonb) to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.records, public.horas_profiles;
  end if;
end;
$$;
