# Despliegue: Worker de Cloudflare + GitHub Pages

Guía para poner en línea la sincronización (Worker + base D1) y la app (GitHub Pages). Todo es opcional: sin esto la app funciona en **Solo local**. Hacé los pasos en orden. Los comandos están pensados para PowerShell, desde la carpeta del proyecto.

Antes de empezar: Node.js 24, `npm ci` ya corrido, una cuenta de Cloudflare (alcanza el plan gratuito) y `gh` autenticado (`gh auth status`).

## 1. Worker y base de datos

1. Iniciá sesión en Cloudflare (se abre el navegador):

   ```powershell
   npx wrangler login
   ```

2. Creá la base D1:

   ```powershell
   npx wrangler d1 create horas
   ```

   Copiá el `database_id` que imprime y pegalo en `worker/wrangler.toml`, en lugar de `00000000-0000-0000-0000-000000000000`.

3. Creá las tablas en la base remota:

   ```powershell
   npx wrangler d1 execute horas --remote --file worker/schema.sql
   ```

4. Generá una clave larga y aleatoria (guardala en tu gestor de contraseñas: la vas a pegar en cada dispositivo):

   ```powershell
   $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

5. Cargala como secreto del Worker (el comando te la pide por pantalla):

   ```powershell
   npx wrangler secret put SYNC_KEY --config worker/wrangler.toml
   ```

   La clave nunca va en `wrangler.toml`, en el repositorio ni en el build.

6. Revisá `ALLOWED_ORIGIN` en `worker/wrangler.toml`. Es una lista separada por comas de los orígenes que pueden hablar con el Worker. En producción:

   ```toml
   ALLOWED_ORIGIN = "https://ilancueto.github.io"
   ```

   Es el origen, sin `/horas/` ni barra final.

7. Desplegá:

   ```powershell
   npm run worker:deploy
   ```

   Anotá la URL que imprime, con la forma `https://horas-sync.<tu-cuenta>.workers.dev`.

## 2. Verificar el Worker

Sin clave tiene que dar `401`; con la clave, `200` y `{"encryption":null}`:

```powershell
curl.exe -i https://horas-sync.<tu-cuenta>.workers.dev/v1/profile
curl.exe -i -H "Authorization: Bearer TU_CLAVE" https://horas-sync.<tu-cuenta>.workers.dev/v1/profile
```

Si algo falla, mirá los logs con `npx wrangler tail --config worker/wrangler.toml`.

## 3. Límites a verificar

Esto no se probó contra Cloudflare real. Probalo después de desplegar.

- D1 limita la cantidad de consultas por invocación del Worker (en el plan gratuito, un tope bajo; revisá los límites vigentes en la documentación de D1, "Limits"). Cada `push` ejecuta todo el lote en una sola `db.batch`, y un lote de 100 cambios más las lecturas previas y los registros en `mutations` genera más de 100 sentencias. La activación del cifrado también arma una sola `batch` con una sentencia por registro vivo.
- Prueba recomendada: con la app ya conectada, cargá o importá al menos 100 cambios de una vez (por ejemplo, **Fusionar datos** con un historial largo) y comprobá que el panel llegue a **Sincronizado**. Repetí con la activación del cifrado si tenés muchos registros.
- Si el `push` falla por el límite de sentencias o consultas (el Worker responde `500` y el panel no sale de "Error"), no hace falta tocar nada en la nube: los cambios quedan en la cola local. La solución es **un seguimiento aparte**: bajar el tamaño del lote del cliente en `src/data/syncEngine.ts` (hoy 100 cambios) y, si hace falta, partir la activación del cifrado en varios pasos. No se hizo en este cambio. Como alternativa, pasar al plan de pago de Workers sube esos topes.

## 4. Publicar la app en GitHub Pages

1. Revisá el historial por secretos antes de hacer público el repo (claves, tokens, `.env`):

   ```powershell
   git log -p --all | Select-String -Pattern "SYNC_KEY|api[_-]?key|token|secret|password|BEGIN .*PRIVATE" -CaseSensitive:$false
   git log --all --name-only --pretty=format: | Sort-Object -Unique | Select-String "\.env|\.pem|\.key"
   ```

   `.env.example` solo trae `VITE_SYNC_URL=` vacío y está bien. Si aparece algo sensible, **no** hagas público el repo: limpiá el historial primero. La planilla original está fuera de Git.

2. Hacé público el repo (Pages gratis lo exige):

   ```powershell
   gh repo edit ilancueto/horas --visibility public --accept-visibility-change-consequences
   ```

3. Habilitá Pages con fuente **GitHub Actions**:

   ```powershell
   gh api -X POST repos/ilancueto/horas/pages -f build_type=workflow
   ```

4. Cargá la URL del Worker como variable del repositorio (es pública, no un secreto):

   ```powershell
   gh variable set VITE_SYNC_URL --body https://horas-sync.<tu-cuenta>.workers.dev
   ```

5. Mergeá esta rama a `main` (por PR) y mirá el workflow:

   ```powershell
   gh run list --workflow pages.yml
   gh run watch
   ```

   El workflow corre lint, tipos y tests, compila con `VITE_BASE=/horas/` y publica. La app queda en https://ilancueto.github.io/horas/.

## 5. Primer uso

1. En el celular, abrí https://ilancueto.github.io/horas/ con conexión y esperá a que termine de cargar. Instalala (Android: **Instalar aplicación**; iPhone: **Compartir → Agregar a pantalla de inicio**). En la compu, usá el botón de instalar de Chrome o Edge.
2. En **Más → Sincronización**, pegá la clave y tocá **Guardar y conectar**. Tiene que pasar a **Sincronizado**.
3. En el segundo dispositivo, repetí la instalación y cargá la misma clave. Si los dos ya tienen datos, aparece **Fusionar datos**: confirmá y esperá a **Sincronizado**.
4. Opcional: activá el cifrado de extremo a extremo con una frase y guardala en un lugar seguro.

Cada origen tiene su propio almacenamiento: si ya usabas la app en otra dirección (por ejemplo `127.0.0.1`), bajá un backup JSON de ahí y restauralo en la instalación nueva, o dejá que **Fusionar datos** suba los datos.

## Solución de problemas

- **"La clave de sincronización no es válida."**: el Worker respondió `401`. Revisá que la clave pegada sea exactamente la del secreto (sin espacios) o volvé a cargarla con `npx wrangler secret put SYNC_KEY --config worker/wrangler.toml` y pegala de nuevo con **Quitar clave** y **Guardar y conectar**. La app no reintenta en bucle.
- **Error de CORS en la consola o "Sin conexión" con red buena**: `ALLOWED_ORIGIN` no incluye el origen desde el que abrís la app. Corregilo en `worker/wrangler.toml` y volvé a correr `npm run worker:deploy`.
- **Carrera perdida (`500` al guardar)**: si dos dispositivos escriben a la vez, el que pierde puede recibir un `500` del Worker. No se pierde nada: el cliente conserva la cola y reintenta con backoff, y el reintento de la misma revisión es idempotente.
- **Solo local**: falta `VITE_SYNC_URL` en el build. Cargala con `gh variable set` y volvé a correr el workflow (`gh workflow run pages.yml`).
- **Git Bash reescribe las rutas como `/horas/`** (las convierte en `C:/Program Files/Git/horas/`). Para `npm run verify:pages -- /horas/` usá PowerShell, no Git Bash.
- **Probar el build bajo `/horas/` en la compu** (PowerShell):

  ```powershell
  $env:VITE_BASE = '/horas/'; npm run build; npm run verify:pages -- /horas/
  ```

  Después limpiá la variable (`Remove-Item Env:VITE_BASE`) para que el siguiente build vuelva a la base `/`.
