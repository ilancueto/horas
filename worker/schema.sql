create table if not exists records (
  id text primary key,
  collection text not null check (collection in ('periods', 'entries', 'comps', 'leaves', 'holidays', 'rules')),
  data text,
  revision text not null,
  updated_at text not null,
  deleted_at text,
  check ((deleted_at is null and data is not null) or (deleted_at is not null and data is null))
);

create table if not exists profile (
  id integer primary key check (id = 1),
  encryption text
);

create table if not exists mutations (
  revision text primary key
);
