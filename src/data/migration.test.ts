import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('ejecuta la migración, protege cada cuenta e ignora reintentos viejos', async () => {
  const sql = new PGlite()
  const a = '00100000-0000-4000-a000-000000000001'
  const b = '00100000-0000-4000-a000-000000000002'
  const id = '10000000-0000-4000-8000-000020261124'
  const r1 = '00100000-0000-4000-a000-000000000003'
  const r2 = '00100000-0000-4000-a000-000000000004'
  const r3 = '00100000-0000-4000-a000-000000000005'
  async function as(who: string) {
    await sql.exec('reset role; set role authenticated;')
    await sql.query("select set_config('request.jwt.claim.sub',$1,false)", [who])
  }
  async function push(revision: string, deleted = false, encrypted = false) {
    await sql.query('select public.horas_push($1::jsonb,$2)', [
      JSON.stringify([
        { id, collection: 'entries', data: deleted ? null : { id }, deleted, revision },
      ]),
      encrypted,
    ])
  }
  try {
    await sql.exec(`
      create role anon;create role authenticated;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable
        as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth to authenticated;
      insert into auth.users values ('${a}'),('${b}');
    `)
    await sql.exec(readFileSync('supabase/migrations/20261122215227_horas_sync.sql', 'utf8'))
    await as(a)
    await push(r1)
    await push(r2, true)
    await push(r1)
    const rows = await sql.query<{ revision: string; deleted_at: Date }>(
      'select revision, deleted_at from public.records',
    )
    expect(rows.rows[0].revision).toBe(r2)
    expect(rows.rows[0].deleted_at).toBeTruthy()
    await expect(sql.query("update public.records set data='{}'")).rejects.toThrow(
      /permission denied/,
    )
    await as(b)
    expect((await sql.query('select * from public.records')).rows).toHaveLength(0)
    await push(r3)
    await sql.query('select public.horas_enable_encryption($1::jsonb,$2::jsonb)', [
      JSON.stringify({ salt: 'mock', check: { iv: 'mock', ciphertext: 'mock' } }),
      JSON.stringify([{ id, revision: r3, data: { iv: 'mock', ciphertext: 'mock' } }]),
    ])
    await expect(push(r3)).rejects.toThrow(/Encryption mode changed/)
    expect(
      (await sql.query<{ data: { ciphertext: string } }>('select data from public.records')).rows[0]
        .data.ciphertext,
    ).toBe('mock')
    await as(a)
    expect(
      (await sql.query<{ data: null }>('select data from public.records')).rows[0].data,
    ).toBeNull()
  } finally {
    await sql.close()
  }
}, 15000)
