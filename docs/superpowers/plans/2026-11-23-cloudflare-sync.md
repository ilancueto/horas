# Sincronización con Cloudflare Workers + D1 y GitHub Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar Supabase por un Worker de Cloudflare con D1 (clave secreta) como backend de sincronización y publicar la PWA en GitHub Pages bajo `/horas/`.

**Architecture:** El motor de sync (`syncEngine.ts`, `crypto.ts`) no cambia. Un Worker nuevo (`worker/`) expone cuatro rutas `/v1/*` con la lógica de `horas_push`/`enable_encryption` portada a JS sobre D1 (lote atómico con `db.batch`). El cliente cambia `supabase.ts` por `cloud.ts` (mismo contrato `Backend`) y el panel de sync pasa de login por correo a una clave guardada en el dispositivo. La app se publica con un workflow de Actions con `base` configurable.

**Tech Stack:** Cloudflare Workers + D1, wrangler, Miniflare (tests), Zod 4, Vite 8 + vite-plugin-pwa, React 19, Dexie, Vitest 5, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-23-cloudflare-sync-design.md` (leerlo completo antes de empezar; el contrato de rutas y los textos salen de ahí). Referencia de la lógica a portar: `supabase/migrations/20261122215227_horas_sync.sql`.

## Global Constraints

- UI en español rioplatense, mismo tono que el resto ("Guardá", "Revisá").
- Colecciones válidas: `periods`, `entries`, `comps`, `leaves`, `holidays`, `rules`. Lotes de hasta 100 cambios. Ciphertext (`iv` y `ciphertext`) obligatorio si el modo es cifrado.
- Contrato de fila en la nube (`cloudRowSchema`): `id`, `collection`, `data`, `revision`, `updated_at` (ISO con zona, hasta 6 decimales), `deleted_at`. `updated_at` estrictamente creciente por registro.
- Rutas bajo `/v1/` con `Authorization: Bearer <clave>`; errores `401` clave inválida, `400` validación, `409` modo de cifrado / "Records changed".
- La clave de sincronización vive solo en el meta de IndexedDB del dispositivo: nunca en backups, exportaciones, sync, el bundle ni el repo.
- Valor hora e importes siguen solo en el dispositivo.
- No se cambia `syncEngine.ts` ni `crypto.ts`.
- Sin `VITE_SYNC_URL` la app queda "Solo local" y funciona offline como hoy.
- Pages sirve bajo `/horas/` (`VITE_BASE=/horas/`); por defecto `VITE_BASE=/`.
- Antes de cada commit: `npm run lint`, `npm run typecheck`, `npm test` en verde (y `npm run test:e2e` en las tareas con UI o build). Un commit por tarea, mensaje en español, terminando en `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Nada se despliega (wrangler, Pages, repo público) sin confirmación explícita de la persona en el momento (Task 8).

## Review Focus

- Clave ausente, mal formada o incorrecta (también con otro largo): `401` sin leer ni escribir datos; la UI avisa "La clave de sincronización no es válida." sin reintentar en bucle. → tests en Task 1 y Task 5.
- Reintento del mismo lote (misma `revision`): no duplica ni cambia `updated_at`. → test en Task 2.
- Lote inválido a mitad (101 cambios, colección desconocida, sin `ciphertext` en modo cifrado): `400`/`409` y **nada** queda escrito. → test en Task 2.
- Dos cambios del mismo registro en un lote y reloj que retrocede: `updated_at` estrictamente creciente. → test en Task 2.
- Activar cifrado con registros que cambiaron entre el `pull` y el envío: `409` y ningún registro cifrado a medias. → test en Task 3.
- Sin `VITE_SYNC_URL`, sin clave, o sin conexión: "Solo local"/"Sin conexión", sin errores ni pérdida de la cola. → tests en Task 5.
- Rutas absolutas rotas bajo `/horas/` (manifest, service worker, `notifications.js`, íconos). → verificación en Task 6.

---

### Task 1: Worker — esquema, autenticación, CORS y lecturas

**Files:**
- Create: `worker/schema.sql`, `worker/wrangler.toml`, `worker/tsconfig.json`
- Create: `worker/src/index.ts` (entrada, enrutado, CORS, auth), `worker/src/auth.ts`, `worker/src/time.ts`
- Test: `worker/test/helpers.ts`, `worker/test/read.test.ts`, `worker/test/time.test.ts`
- Modify: `package.json` (devDependencies `wrangler`, `miniflare`, `@cloudflare/workers-types`; scripts `worker:dev`, `worker:deploy`; `typecheck` suma `tsc --noEmit -p worker`)

**Interfaces:**
- Produces:
  - `export type Env = { DB: D1Database; SYNC_KEY: string; ALLOWED_ORIGIN: string }`
  - `export async function handle(request: Request, env: Env): Promise<Response>` y `export default { fetch: handle }`
  - `export async function authorized(request: Request, key: string): Promise<boolean>` (`worker/src/auth.ts`): compara en tiempo constante los SHA-256 de la clave recibida y la esperada con un bucle XOR; falso si falta el encabezado o no empieza con `Bearer `.
  - `export function nextTimestamp(now: Date, previous?: string): string` (`worker/src/time.ts`): ISO UTC con 6 decimales (`2026-11-23T12:00:00.123456Z`); si `now` formateado no es mayor que `previous`, devuelve `previous + 1 µs`.
  - `worker/test/helpers.ts`: `export async function setup(): Promise<{ env: Env; call: (method: string, path: string, init?: { body?: unknown; key?: string; origin?: string }) => Promise<Response> }>` que crea una D1 con Miniflare (`new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: { DB: 'test' } })` + `getD1Database('DB')`), aplica `worker/schema.sql` y usa `SYNC_KEY = 'clave-de-prueba'`, `ALLOWED_ORIGIN = 'https://ilancueto.github.io'`.
  - Rutas de esta tarea: `OPTIONS *`, `GET /v1/records?after=<id>&limit=<n>` → `200 { rows: CloudRow[] }` (ordenadas por `id`, `limit` máx. 500, por defecto 500; `data` parseado de JSON; filas borradas con `data: null`), `GET /v1/profile` → `200 { encryption: object | null }`.
- D1 (`schema.sql`): `records(id text primary key, collection text not null check(collection in (...6 colecciones...)), data text, revision text not null, updated_at text not null, deleted_at text, check((deleted_at is null and data is not null) or (deleted_at is not null and data is null)))`, `profile(id integer primary key check(id = 1), encryption text)`, `mutations(revision text primary key)`.

- [ ] **Step 1: Escribir los tests que fallan.**
  - `time.test.ts`: `nextTimestamp(new Date('2026-11-23T12:00:00.123Z'))` → `'2026-11-23T12:00:00.123000Z'`; con `previous = '2026-11-23T12:00:00.123000Z'` (mismo instante) → `'...123001Z'`; con `previous` posterior al reloj → `previous + 1 µs` (carry correcto: `'...999999Z'` → `'...00:01.000000Z'`).
  - `read.test.ts`: sin encabezado, con clave incorrecta, con clave de otro largo y con esquema distinto de Bearer → `401` en `/v1/records` y `/v1/profile`; con clave correcta y base vacía → `{ rows: [] }` y `{ encryption: null }`; 3 filas insertadas directo en D1 → devueltas ordenadas por `id`; `limit=2&after=<id1>` pagina; `OPTIONS` con `Origin = ALLOWED_ORIGIN` → `204` con `access-control-allow-origin` igual al origen y `allow-headers` con `authorization`; con otro origen → sin esos encabezados; ruta desconocida → `404`.
- [ ] **Step 2:** `npx vitest run worker` → FAIL (módulos inexistentes).
- [ ] **Step 3:** Implementar los archivos listados. Reglas: respuestas JSON con `content-type: application/json`; CORS solo para los orígenes de `ALLOWED_ORIGIN`, que es una lista separada por comas (en producción `https://ilancueto.github.io`; para desarrollo se agregan `http://127.0.0.1:5180` y `http://localhost:5173`); `401` antes de tocar la base; `wrangler.toml` con `name = "horas-sync"`, `main = "src/index.ts"`, `compatibility_date = "2026-11-01"` y el binding `DB` (el `database_id` real se completa en Task 8; dejar el campo con el valor `"00000000-0000-0000-0000-000000000000"` marcado con un comentario).
- [ ] **Step 4:** `npx vitest run worker` y `npm run typecheck` → PASS. Si Miniflare no puede crear la D1 en esta plataforma, parar y reportar BLOCKED con el error.
- [ ] **Step 5:** Commit `Worker: esquema D1, autenticación por clave, CORS y lecturas`.

### Task 2: Worker — push atómico

**Files:**
- Create: `worker/src/push.ts`
- Modify: `worker/src/index.ts` (ruta `POST /v1/push`)
- Test: `worker/test/push.test.ts`

**Interfaces:**
- Consumes: `Env`, `nextTimestamp`, `authorized`, `setup` (Task 1).
- Produces: `export async function push(env: Env, body: unknown, now?: () => Date): Promise<Response>`; ruta `POST /v1/push` `{ changes: ChangePacket[], encrypted: boolean }` → `204`. `ChangePacket = { id: uuid, collection, revision: uuid, deleted: boolean, data: unknown }` (validar con Zod).

Reglas a portar de `horas_private.push`: lote ≤ 100; `data` objeto salvo borrados (`data = null`); con `encrypted = true` el `data` debe tener `iv` y `ciphertext`; el modo (`profile.encryption` no nulo) debe coincidir con `encrypted` (si no, `409` "Encryption mode changed"); revisión ya registrada en `mutations` se ignora; `updated_at = nextTimestamp(ahora, updated_at previo de ese `id`)`; borrado → `deleted_at = updated_at`, `data = null`; upsert por `id` (colección, data, revision, updated_at, deleted_at). Se crea la fila `profile(1)` si no existe. Leer primero (perfil, `mutations` y `updated_at` previos de los ids del lote), calcular en JS y escribir todo en **una** `env.DB.batch([...])`. Dos cambios del mismo `id` en el lote deben encadenar `updated_at` en memoria.

- [ ] **Step 1: Tests que fallan** (`push.test.ts`, usando `setup().call`):
  - push de 1 cambio nuevo → `204` y `GET /v1/records` lo devuelve con `updated_at` válido (`z.iso.datetime({ offset: true })`).
  - repetir el mismo lote (misma `revision`) → `204`, la fila no cambia (`updated_at` y `revision` idénticos).
  - mismo `id` con `revision` nueva → `updated_at` estrictamente mayor, aunque el reloj del Worker se simule hacia atrás (inyectar `now` falso vía un parámetro opcional `now: () => Date` en `push`; `handle` usa `() => new Date()`).
  - dos cambios del mismo `id` en un lote → quedan con la última revisión y `updated_at` mayor que el de la primera.
  - borrado → `deleted_at` igual a `updated_at`, `data: null`; una revisión vieja posterior de ese `id` ya aplicada se ignora.
  - lote de 101 → `400` y base vacía; colección desconocida en el último cambio de un lote válido → `400` y **ninguna** fila escrita; `data` no objeto → `400`.
  - modo cifrado: con perfil cifrado, `encrypted: false` → `409`; `encrypted: true` sin `ciphertext` → `400`; sin perfil, `encrypted: true` → `409`.
  - sin clave → `401`.
- [ ] **Step 2:** `npx vitest run worker/test/push.test.ts` → FAIL.
- [ ] **Step 3:** Implementar `push` con validación Zod previa a cualquier escritura.
- [ ] **Step 4:** `npx vitest run worker` → PASS; `npm run lint && npm run typecheck`.
- [ ] **Step 5:** Commit `Worker: push atómico con revisiones y orden por microsegundos`.

### Task 3: Worker — activar cifrado

**Files:**
- Create: `worker/src/encryption.ts`
- Modify: `worker/src/index.ts` (ruta `POST /v1/encryption`)
- Test: `worker/test/encryption.test.ts`

**Interfaces:**
- Consumes: `Env`, `nextTimestamp`, `setup`, ruta `/v1/push` (para sembrar datos en los tests).
- Produces: `export async function enableEncryption(env: Env, body: unknown, now?: () => Date): Promise<Response>`; ruta `POST /v1/encryption` `{ config: { salt: string, check: { iv: string, ciphertext: string } }, changes: { id: uuid, revision: uuid, data: { iv: string, ciphertext: string } }[] }` → `204`.

Portar `horas_private.enable_encryption`: `409` "Encryption already enabled" si ya hay perfil cifrado; `400` si `config`/`changes` inválidos; la cantidad de registros vivos debe ser igual a `changes.length` y cada cambio debe coincidir por `id` y `revision` con un registro vivo todavía sin cifrar (`data.ciphertext` ausente); si algo no coincide → `409` "Records changed" **sin cifrar nada**; si todo coincide: actualizar `data` y `updated_at = nextTimestamp(...)` de cada uno y guardar `profile.encryption = config` en una única `batch`.

- [ ] **Step 1: Tests que fallan:** sembrar 2 registros por `/v1/push` sin cifrar; (a) `enableEncryption` con los 2 cambios correctos → `204`, ambos con `ciphertext`, `GET /v1/profile` devuelve `config`, y un push posterior con `encrypted: false` → `409`; (b) un cambio con `revision` que no coincide → `409` y los 2 registros siguen sin cifrar y sin perfil; (c) `changes` con 1 solo registro de 2 → `409`; (d) segunda activación → `409`; (e) `data` sin `ciphertext` → `400`; (f) sin clave → `401`.
- [ ] **Step 2:** `npx vitest run worker/test/encryption.test.ts` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npx vitest run worker` → PASS; lint y typecheck.
- [ ] **Step 5:** Commit `Worker: activación del cifrado de extremo a extremo`.

### Task 4: Cliente de la nube (`cloud.ts`)

**Files:**
- Create: `src/data/cloud.ts`
- Test: `src/data/cloud.test.ts`

**Interfaces:**
- Consumes: `Backend`, `CloudRow`, `ChangePacket`, `cloudRowSchema` de `src/data/syncEngine.ts`; `Encryption`, `encryptionSchema` de `src/data/crypto.ts`.
- Produces:
  - `export const cloudUrl: string | undefined` (de `import.meta.env.VITE_SYNC_URL`, sin barra final) y `export const cloudConfigured: boolean`
  - `export class CloudError extends Error { status: number }`
  - `export function createCloud(baseUrl: string, key: string, fetcher?: typeof fetch): Backend & { encryption: () => Promise<Encryption | null>; enable: (config: Encryption, changes: ChangePacket[]) => Promise<void> }`

Comportamiento: `pull` pagina `GET /v1/records?after=<último id>&limit=500` hasta recibir menos de 500 y valida con `cloudRowSchema`; `push` hace `POST /v1/push` con `{ changes, encrypted }`; `encryption` lee `GET /v1/profile` y valida con `encryptionSchema` (null si no hay); `enable` hace `POST /v1/encryption`. Todas envían `Authorization: Bearer <key>`. Toda respuesta no OK lanza `CloudError` con el `status`; un fallo de red propaga el error original.

- [ ] **Step 1: Tests que fallan** con un `fetcher` falso: pagina 2 páginas (500 + 3) y las concatena; arma URL y encabezados exactos; `push` envía el cuerpo esperado; `401` → `CloudError` con `status 401`; `encryption` devuelve `null` y un objeto válido, y rechaza uno inválido; `baseUrl` con barra final no duplica `/`; `enable` envía `{ config, changes }`.
- [ ] **Step 2:** `npx vitest run src/data/cloud.test.ts` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npx vitest run`, lint, typecheck → PASS.
- [ ] **Step 5:** Commit `Cliente de sincronización para el Worker de Cloudflare`.

### Task 5: Panel y hook de sincronización con clave

**Files:**
- Modify: `src/ui/Sync.tsx` (hook `useSync` y `SyncPanel`; `MergeSync` sin cambios de lógica)
- Modify: `playwright.config.ts` (env del servidor de desarrollo: `VITE_SYNC_URL: 'https://horas-test.workers.dev'`)
- Modify: `.env.example` (`VITE_SYNC_URL=`)
- Test: `tests/sync.e2e.ts` (reescritura), `src/data/transfer.test.ts` (la clave no sale en el backup)

**Interfaces:**
- Consumes: `createCloud`, `CloudError`, `cloudUrl`, `cloudConfigured` (Task 4); `getMeta`/`putMeta` de `src/data/db.ts`.
- Produces: `useSync(enabled: boolean)` devuelve `{ status, merge, encryption, issue, agree, syncNow, changeEncryption, canSend, hasKey, saveKey, removeKey }` (se quitan `client` y `session`; `App.tsx` solo pasa `sync` a `SyncPanel`/`MergeSync`, no debería cambiar). `saveKey(key: string): Promise<void>` guarda en meta `syncKey` (`z.string().nullable()`); `removeKey(): Promise<void>` la borra y vuelve a "Solo local".

Comportamiento: sin `cloudConfigured` o sin clave → `status 'Solo local'`. Con clave, el ciclo es el actual (`api.encryption()`, merge inicial con `stageInitial`, `cycle`), con `createCloud(cloudUrl, key)`; se elimina el canal en tiempo real (quedan sondeo de 45 s, `online`/`offline`, cola). El "owner" local pasa a ser `new URL(cloudUrl).origin` (meta `syncOwner`); si difiere, `issue`: "Estos datos locales están vinculados a otro servidor de sincronización." Un `CloudError` con `status 401` → `status 'Error'`, `issue` "La clave de sincronización no es válida.", **sin reintentos automáticos** hasta que se guarde otra clave. Otros errores conservan el mensaje y el reintento con `retryDelay` actuales. Panel: sin `canSend` → "Tus datos se guardan en este dispositivo. Podés habilitar la nube al configurar el Worker de Cloudflare."; sin clave → campo contraseña "Clave de sincronización" y botón "Guardar y conectar"; con clave → texto "Conectado a {host}", botones "Sincronizar ahora" y "Quitar clave", y la sección de cifrado actual sin cambios.

- [ ] **Step 1: Tests que fallan.**
  - `transfer.test.ts`: con `putMeta('syncKey', 'secreta-123')`, el JSON de backup generado (con y sin datos privados) no contiene `secreta-123`.
  - `sync.e2e.ts` reescrito (mismo escenario de dos perfiles, misma ayuda `onboard`/`more`/`period`): `context.route('https://horas-test.workers.dev/**')` simula el Worker (CORS con `authorization`; exige `Bearer clave-de-prueba` o responde `401`; `GET /v1/records`, `GET /v1/profile`, `POST /v1/push` con la misma lógica de revisiones/`updated_at` del mock actual). Sin websocket. Pasos: en cada perfil Más → completar "Clave de sincronización" con `clave-de-prueba` → "Guardar y conectar"; el segundo ve el diálogo "Fusionar datos" y confirma; ambos llegan a "Sincronizado". Un perfil sin conexión carga una jornada → el servidor no la ve; vuelve la conexión → aparece; el otro la ve tras "Sincronizar ahora". Test aparte: con la clave `incorrecta` aparece "La clave de sincronización no es válida." y "Quitar clave" vuelve a "Solo local".
- [ ] **Step 2:** `npx vitest run src/data/transfer.test.ts` y `npm run test:e2e -- -g sincroniza` → FAIL.
- [ ] **Step 3:** Implementar el hook y el panel según el comportamiento descrito; no importar `@supabase/supabase-js`.
- [ ] **Step 4:** `npm run lint && npm run typecheck && npm test && npm run test:e2e` → PASS (incluye axe y capturas del resto de las pantallas).
- [ ] **Step 5:** Commit `Sincronización: panel con clave y cliente del Worker`.

### Task 6: Publicación en GitHub Pages bajo `/horas/`

**Files:**
- Modify: `vite.config.ts` (`base` desde `VITE_BASE`; manifest y workbox con la base), `public/notifications.js` (rutas relativas al scope)
- Create: `.github/workflows/pages.yml`, `scripts/verify-pages-build.mjs`
- Modify: `package.json` (script `verify:pages`)

**Interfaces:**
- Produces: variable de entorno `VITE_BASE` (por defecto `/`, termina siempre en `/`); `node scripts/verify-pages-build.mjs <base>` sale con código distinto de cero si `dist` no respeta la base.

Cambios: `const base = process.env.VITE_BASE ?? '/'`; `base` en `defineConfig`; manifest `id`, `start_url` y `scope` = `base`, íconos y `shortcuts[].url` como rutas relativas a la base (`base + 'icon-192.png'`, `base + '?hoy=1'`); `navigateFallback: base + 'index.html'`; `importScripts: ['notifications.js']` (relativo al service worker). En `notifications.js`, usar `self.registration.scope` en lugar de `'/'` (URL `new URL('./?hoy=1', self.registration.scope)` y comparar clientes con `startsWith(self.registration.scope)`). El workflow corre en push a `main` y manualmente: checkout, Node 24, `npm ci`, lint, typecheck, test, `VITE_BASE=/horas/ VITE_SYNC_URL=${{ vars.VITE_SYNC_URL }} npm run build`, `node scripts/verify-pages-build.mjs /horas/`, `actions/upload-pages-artifact` (carpeta `dist`) y `actions/deploy-pages`; permisos `pages: write`, `id-token: write`, `contents: read`, y `concurrency` de un solo despliegue.

- [ ] **Step 1: Escribir `scripts/verify-pages-build.mjs` primero** (falla con el build actual al pedirle `/horas/`): lee `dist/index.html`, `dist/manifest.webmanifest`, `dist/sw.js`; exige que `index.html` referencie `<base>assets/`, que el manifest tenga `scope`, `start_url` e `id` iguales a la base y que el `sw.js` use `<base>index.html` como fallback.
- [ ] **Step 2:** `VITE_BASE=/horas/ npm run build && npm run verify:pages -- /horas/` → FAIL (antes de los cambios de `vite.config.ts`).
- [ ] **Step 3:** Implementar los cambios de `vite.config.ts` y `notifications.js`.
- [ ] **Step 4:** Mismo comando con `/horas/` → PASS; `npm run build && npm run verify:pages -- /` → PASS; `npm run lint && npm run typecheck && npm test && npm run test:e2e` → PASS (el build por defecto no cambia).
- [ ] **Step 5:** Commit `Publicación en GitHub Pages: base configurable y workflow`.

### Task 7: Retirar Supabase y documentar

**Files:**
- Delete: `src/data/supabase.ts`, `src/data/migration.test.ts`, `supabase/`
- Modify: `package.json` (quitar `@supabase/supabase-js` y `@electric-sql/pglite`; `npm install` para el lockfile), `README.md`, `PLAN.md`
- Create: `docs/despliegue.md`

- [ ] **Step 1:** Buscar referencias: `grep -rIn "supabase" src tests README.md PLAN.md package.json vite.config.ts playwright.config.ts .env.example` y resolver cada una (el e2e y `Sync.tsx` ya no deben tenerlas).
- [ ] **Step 2:** Borrar los archivos y dependencias listados; actualizar `README.md` (sección de sincronización: Worker de Cloudflare, clave, `VITE_SYNC_URL`, `VITE_BASE`, URL de Pages) y `PLAN.md` (decisión y checklist). En `docs/despliegue.md`, los pasos exactos de la Task 8 con los comandos (`wrangler login`, crear D1, `schema.sql`, `wrangler secret put SYNC_KEY`, `ALLOWED_ORIGIN`, `wrangler deploy`, hacer público el repo, habilitar Pages con fuente "GitHub Actions", variable `VITE_SYNC_URL`).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm test && npm run test:e2e` → PASS; `grep -rIn "supabase" src tests package.json` no devuelve nada; con `VITE_SYNC_URL` sin definir la app queda "Solo local" (cubierto por e2e existentes sin esa variable en el servidor de `preview`).
- [ ] **Step 4:** Commit `Retirar Supabase y documentar el despliegue en Cloudflare y Pages`.

### Task 8: Despliegue guiado (lo ejecuta la persona o el controlador con confirmación; no se delega a un subagente)

Cada punto pide confirmación explícita antes de ejecutarse:

- [ ] `npx wrangler login` (la persona inicia sesión en Cloudflare en el navegador).
- [ ] `npx wrangler d1 create horas` → copiar el `database_id` a `worker/wrangler.toml`; `npx wrangler d1 execute horas --remote --file worker/schema.sql`.
- [ ] Generar una clave larga aleatoria (la persona la guarda en su gestor) y `npx wrangler secret put SYNC_KEY --config worker/wrangler.toml`; fijar `ALLOWED_ORIGIN = "https://ilancueto.github.io"` en `wrangler.toml`.
- [ ] `npm run worker:deploy` → anotar la URL `https://horas-sync.<cuenta>.workers.dev`; verificar con `curl -i <url>/v1/profile` (debe dar `401`) y con la clave (`200 { "encryption": null }`).
- [ ] Antes de hacer público el repo: revisar el historial por secretos (`git log -p` buscando claves/tokens y `.env`); confirmar con la persona; `gh repo edit ilancueto/horas --visibility public --accept-visibility-change-consequences`.
- [ ] Habilitar Pages con fuente Actions (`gh api -X POST repos/ilancueto/horas/pages -f build_type=workflow`), cargar la variable `VITE_SYNC_URL` del repo (`gh variable set VITE_SYNC_URL --body <url>`), abrir PR de esta rama, mergear y esperar el workflow.
- [ ] Verificación real: abrir `https://ilancueto.github.io/horas/`, instalar la PWA, cargar la clave en Más → Sincronización, comprobar "Sincronizado" y repetir en un segundo dispositivo (diálogo de fusión).
