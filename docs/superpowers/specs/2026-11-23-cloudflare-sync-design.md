# Sincronización con Cloudflare Workers + D1 y publicación en GitHub Pages — diseño

Fecha: 2026-11-23 · Rama base: `main`

## Intención

Horas es una PWA personal (una sola persona, varios dispositivos). Hoy la nube opcional usa Supabase (login por link al correo, Postgres con RLS, función `horas_push`, canal en tiempo real). La persona quiere **dejar Supabase** y usar **un Worker de Cloudflare con D1** como backend de sincronización, y **publicar la app en GitHub Pages** para no depender de un servidor local. La nube sigue siendo opcional: sin configurar, la app funciona solo local.

## Objetivos

- Reemplazar el backend de sync por un Worker + D1 con el mismo contrato que usa el motor (`pull`, `push`, perfil de cifrado, activar cifrado).
- Autenticación por **clave secreta** (decisión de la persona): un secreto del Worker, pegado una vez en cada dispositivo.
- Publicar la PWA en GitHub Pages con despliegue automático desde `main`.
- Quitar `@supabase/supabase-js` y el código/SQL de Supabase.

## No objetivos

- No se cambia el motor de sync (`cycle`, `preferRemote`, `stageInitial`, `encodeChanges`, `decryptRows`) ni el cifrado de extremo a extremo (`crypto.ts`).
- No hay multiusuario, registro de cuentas ni recuperación de clave.
- No hay tiempo real (websocket/Durable Objects): alcanza con el sondeo de 45 s y la sincronización al cambiar/volver la conexión que ya existen.
- No se migran datos de Supabase: nunca se configuró (no hay `.env`); los dispositivos tienen los datos y el flujo "Fusionar datos" los sube al backend nuevo.
- No se usa Cloudflare Access (descartado por la persona: cookies de terceros entre `github.io` y `workers.dev`).

## Anti-objetivos (fracaso aunque funcione)

- Perder o duplicar registros locales al pasar al backend nuevo.
- Que la clave de sincronización salga del dispositivo o quede en el bundle público, en el repo o en los backups/exportaciones.
- Que cualquiera pueda leer o escribir registros sin la clave (incluida comparación de la clave no constante en tiempo).
- Que un `push` parcial deje la base inconsistente (debe ser atómico por lote).
- Romper el modo "Solo local" o el uso offline.

## Restricciones

- Español rioplatense en toda la UI, mismo estilo.
- Valor hora e importes siguen solo en el dispositivo (nunca a la nube).
- Los cambios de datos pasan por `apply()`; la sync por el motor existente.
- Contrato de fila en la nube (`cloudRowSchema`): `id`, `collection`, `data`, `revision`, `updated_at` (ISO con zona, hasta microsegundos), `deleted_at`. `updated_at` debe ser estrictamente creciente por registro (el cliente compara hasta microsegundos).
- Colecciones válidas: `periods`, `entries`, `comps`, `leaves`, `holidays`, `rules`. Lotes de hasta 100 cambios. Ciphertext obligatorio si el modo es cifrado.
- `npm run lint`, `typecheck`, `test` y `test:e2e` en verde antes de cada commit.
- Pages sirve bajo `/horas/`: manifest, service worker y rutas deben funcionar con esa base.

## Enfoques considerados

**Autenticación**
- **A (elegido): clave secreta compartida.** Secreto del Worker (`SYNC_KEY`), enviado como `Authorization: Bearer`. Una sola persona; no depende del correo. Se compara en tiempo constante. La clave se guarda solo en el dispositivo (meta de IndexedDB).
- B: Cloudflare Access (JWT). Descartado: cookies de terceros entre `github.io` y `workers.dev`, y el login redirige los pedidos en segundo plano.
- C: link mágico por correo propio. Descartado: requiere servicio de correo y más piezas.

**Dónde se sirve la app**
- **A (elegido): GitHub Pages** (pedido de la persona), con workflow de GitHub Actions. Limitación: en cuentas gratuitas Pages solo publica repos públicos. El repo `ilancueto/horas` hoy es privado; hay que hacerlo público (el código no contiene secretos ni datos) o tener un plan que lo permita.
- B: Cloudflare Pages / Worker con assets. Más simple con repos privados; fuera de lo pedido. Queda como alternativa si no se puede hacer público el repo.

**Tiempo real**
- **A (elegido): sondeo existente** (45 s + al cambiar datos + al volver la conexión).
- B: Durable Objects + websocket. Descartado: complejidad sin beneficio para una persona.

## Diseño

### 1. Worker (`worker/`)

- `worker/src/index.ts`, `worker/wrangler.toml`, `worker/schema.sql` (migración D1), tests con Vitest.
- Variables: secreto `SYNC_KEY`; var `ALLOWED_ORIGIN` (origen de Pages, más `http://127.0.0.1:*`/`localhost` solo en desarrollo).
- Rutas (JSON, todas con `Authorization: Bearer <clave>` salvo `OPTIONS`):
  - `GET /v1/records?after=<id>&limit=500` → `{ rows: CloudRow[] }` ordenadas por `id`, paginadas igual que hoy (cursor por `id`).
  - `POST /v1/push` `{ changes, encrypted }` → `204`. Misma lógica que `horas_private.push`: lote ≤ 100; valida colección, `uuid`, objeto en `data`, `iv`/`ciphertext` si `encrypted`; exige que el modo cifrado coincida con el perfil (`Encryption mode changed`); ignora revisiones ya aplicadas (`mutations`); `updated_at = max(ahora, previo + 1 µs)`; borrados con `data = null` y `deleted_at = updated_at`. Todo el lote en una única `db.batch` (atómico).
  - `GET /v1/profile` → `{ encryption: Encryption | null }`.
  - `POST /v1/encryption` `{ config, changes }` → `204`. Misma lógica que `enable_encryption` (solo si no está activado; el conteo de registros vivos debe coincidir con `changes`; cada cambio coincide por `id` y `revision` y hoy no está cifrado).
  - `OPTIONS` y encabezados CORS solo para `ALLOWED_ORIGIN`.
  - Errores: `401` clave inválida; `400` validación; `409` modo de cifrado/“Records changed”.
- D1 (`schema.sql`): `records(id text primary key, collection text not null check(...), data text, revision text not null, updated_at text not null, deleted_at text, check(...))`, `profile(id integer primary key check(id = 1), encryption text)`, `mutations(revision text primary key)`. Una sola persona: sin `user_id`.
- `updated_at`: texto ISO con 6 decimales (`2026-11-23T12:00:00.123456Z`); el Worker garantiza monotonía por registro sumando 1 µs cuando hace falta.

### 2. Cliente

- `src/data/cloud.ts` reemplaza a `src/data/supabase.ts` y expone el mismo `Backend` (`pull`, `push`) más `encryption()` y `enable()`. URL base de `VITE_SYNC_URL` (sin ella, `cloudConfigured = false` y la app queda "Solo local"). La clave se lee del meta local.
- `src/ui/Sync.tsx`: se quitan login por correo, `onAuthStateChange`, `signOut` y el canal en tiempo real. El panel pide la **clave de sincronización** (campo de contraseña, "Guardar y conectar", "Quitar clave"). El "owner" de los datos locales pasa a un valor fijo (el id de usuario ya no existe); se mantiene la protección contra mezclar datos de otra cuenta con un identificador derivado de la URL del backend.
- La clave nunca entra en backups, exportaciones ni sync; solo en meta del dispositivo.
- `cloudRowSchema`: `updated_at` sigue aceptando offset/zulú con microsegundos.
- Se eliminan la dependencia `@supabase/supabase-js`, `src/data/supabase.ts`, `.env.example` actualizado (`VITE_SYNC_URL`), y la carpeta `supabase/` al final.

### 3. GitHub Pages

- `vite.config.ts`: `base` desde `VITE_BASE` (por defecto `/`; en Pages `/horas/`). Manifest (`id`, `start_url`, `scope`), `navigateFallback` e `importScripts` usan la base; íconos y `index.html` con rutas relativas a la base.
- `.github/workflows/pages.yml`: en cada push a `main`, `npm ci`, lint/typecheck/test, `npm run build` con `VITE_BASE=/horas/` y `VITE_SYNC_URL` (variable del repositorio), y `actions/deploy-pages`.
- `404.html` copia de `index.html` no hace falta (la app no usa rutas de ruta, solo vistas internas); se verifica.

### 4. Pruebas

- Vitest para el Worker (`push` atómico, idempotencia por `revision`, modo cifrado, monotonía de `updated_at`, `401`, CORS, paginación, `enable_encryption`).
- Vitest de cliente: `cloud.ts` contra un `fetch` simulado.
- Playwright: `tests/sync.e2e.ts` se reescribe contra la API simulada del Worker (sin websocket); el resto de e2e sin cambios. Se corre además con `VITE_BASE=/horas/` en un `vite preview` para verificar la app bajo subruta.
- Verificación manual guiada de despliegue real al final (Worker + Pages).

### 5. Despliegue (acciones fuera de este repo — piden confirmación)

- `wrangler login`, crear la base D1, aplicar `schema.sql`, `wrangler secret put SYNC_KEY`, `wrangler deploy`.
- Hacer público el repo (o confirmar plan), habilitar Pages (fuente: GitHub Actions), cargar la variable `VITE_SYNC_URL`.
- Cada una la hace la persona o se hace con su confirmación explícita en el momento; nada se despliega sin ella.

## Decisiones que tomó Claude (revisar)

1. Una sola persona → sin `user_id` en D1; "owner" local derivado de la URL del backend.
2. Sin tiempo real; sondeo existente.
3. La URL del Worker va en `VITE_SYNC_URL` (build), la clave la escribe la persona en la app.
4. Rutas bajo `/v1/` y códigos `401/400/409`.
5. `updated_at` en texto ISO con microsegundos, monotónico por registro en el Worker.
6. Se borra `supabase/` y la dependencia al final, con test de que "Solo local" sigue funcionando.
7. Hacer público el repo es lo más simple para Pages gratis; si no se quiere, la alternativa es Cloudflare Pages.

## Para quien construye

- Estructura exacta de `worker/` y herramienta de test del Worker (Vitest con el pool de Workers o simulación de D1).
- Nombres de componentes y copys menores del panel, en el tono de la app.
- Cómo derivar el identificador del backend para el "owner" local.
- Orden sugerido (un commit por parte): 1 Worker + schema + tests → 2 cliente `cloud.ts` + panel + tests/e2e → 3 base `/horas/` + workflow → 4 limpieza de Supabase → 5 guía de despliegue.
