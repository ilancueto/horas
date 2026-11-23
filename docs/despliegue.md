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
   npx wrangler d1 create horas --config worker/wrangler.toml
   ```

   Copiá el `database_id` que imprime y pegalo en `worker/wrangler.toml`, en lugar de `00000000-0000-0000-0000-000000000000`.

3. Creá las tablas en la base remota:

   ```powershell
   npx wrangler d1 execute horas --remote --file worker/schema.sql --config worker/wrangler.toml
   ```

   Para probar el Worker en la compu con `npm run worker:dev`, creá antes las mismas tablas en la base local (queda en `.wrangler/`, fuera de Git):

   ```powershell
   npx wrangler d1 execute horas --local --file worker/schema.sql --config worker/wrangler.toml
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

Esto no se probó contra Cloudflare real. Probalo después de desplegar. Los límites vigentes están en la documentación de D1 ("Limits": https://developers.cloudflare.com/d1/platform/limits/).

- **Consultas por invocación**: D1 limita las consultas por invocación del Worker (al 23-11-2026: 50 en el plan gratuito, 1000 en el de pago), pero una `db.batch()` cuenta como **una sola consulta**, sin importar cuántas sentencias lleve. Cada pedido del Worker hace a lo sumo unas pocas lecturas y una `batch`: `push` (lote de hasta 100 cambios) y la activación del cifrado (una sentencia por registro vivo) quedan muy por debajo del tope.
- **Tamaño**: cada fila o texto guardado en D1 puede medir hasta 2.000.000 bytes. El Worker rechaza con `400` el `data` de un registro de más de 1.000.000 bytes (medido en bytes UTF-8), así que un registro normal nunca se acerca. Los límites por sentencia (largo del SQL, parámetros) se aplican a cada sentencia de la `batch`; el Worker usa parámetros cortos y listas en JSON para no acercarse.
- **Lo que sí hay que mirar es el tiempo de CPU y el tamaño del pedido**. Con `npx wrangler tail --config worker/wrangler.toml` abierto en otra terminal, probá:
  1. **Un push de 100 cambios**: con la app ya conectada, cargá o importá al menos 100 cambios de una vez (por ejemplo, **Fusionar datos** con un historial largo) y comprobá que el panel llegue a **Sincronizado**.
  2. **Activar el cifrado con la cantidad real de registros**: activalo en el dispositivo con todos tus datos y comprobá que termine sin error.

  En los logs buscá errores de tiempo de CPU excedido (`exceededCpu`, "Worker exceeded CPU time limit"), de tamaño (`SQLITE_TOOBIG`, "string or blob too big", "request too large") o respuestas `500`. Si aparece alguno, no hace falta tocar nada en la nube: los cambios quedan en la cola local. Anotá el mensaje del log y tratalo como un seguimiento aparte.

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
2. En el primer dispositivo, empezá como siempre (**Importar mi Excel** o **Empezar de cero**). Después, en **Más → Sincronización**, pegá la clave y tocá **Guardar y conectar**. Tiene que pasar a **Sincronizado**.
3. Para sumar otro dispositivo, tenés dos caminos y ninguno crea un período de más:
   - **Con el enlace:** en el dispositivo ya conectado, andá a **Más → Sincronización → Vincular otro dispositivo**. Abrí el enlace en el dispositivo nuevo (mandátelo a vos mismo o escaneá el código QR con la cámara). La app lo borra de la barra apenas lo lee, se conecta sola, baja tus datos y entra. El enlace contiene tu clave: usalo solo en tus dispositivos y borrá el mensaje y la entrada del historial después. Si la app tiene PIN, el enlace se aplica después de desbloquearla.
   - **Con la clave:** en la bienvenida del dispositivo nuevo tocá **Ya tengo mis datos en la nube**, pegá la clave y tocá **Conectar**. Si la clave no es válida o la nube está vacía, la app te avisa y no deja nada configurado.
   - **Si activaste el cifrado:** en los dos caminos, la bienvenida te pide la frase de paso ("Tu nube tiene cifrado. Escribí tu frase de paso para bajar tus datos."). Escribila y tocá **Desbloquear**: recién ahí baja tus datos y entra. Si la frase no coincide, probá de nuevo; con **Cancelar** el dispositivo queda como estaba, sin la clave.

   La app borra el enlace de la barra apenas lo lee, pero puede quedar en el historial del navegador y en el historial del portapapeles si lo copiaste:

   - **Historial del navegador:** en Chrome o Edge, abrí **Historial** (Ctrl+H en la compu; menú ⋮ → **Historial** en el celular), buscá la dirección de Horas y eliminá esa entrada.
   - **Portapapeles:** en Windows, Win+V muestra el historial: borrá la entrada desde su menú `…` o con **Borrar todo**. En el celular, revisá el portapapeles del teclado.
   - **Si compartiste el enlace o la clave por error:** cambiá la clave con `npx wrangler secret put SYNC_KEY --config worker/wrangler.toml` y volvé a conectar cada dispositivo con la clave nueva (**Quitar clave** y **Guardar y conectar**, o un enlace nuevo desde un dispositivo ya conectado).

   Si el dispositivo nuevo ya tenía datos propios y lo conectás desde **Más → Sincronización**, aparece **Fusionar datos**: confirmá y esperá a **Sincronizado**.

4. Opcional: activá el cifrado de extremo a extremo con una frase y guardala en un lugar seguro. Si al activarlo el Worker responde con un error del servidor (`5xx`), el cliente **no** reintenta la activación solo: esperá unos segundos y volvé a tocar **Activar cifrado** con la misma frase. Hasta que funcione, los datos siguen sin cifrar en la nube.

Cada origen tiene su propio almacenamiento: si ya usabas la app en otra dirección (por ejemplo `127.0.0.1`), bajá un backup JSON de ahí y restauralo en la instalación nueva, o dejá que **Fusionar datos** suba los datos.

## Solución de problemas

- **"La clave de sincronización no es válida."**: el Worker respondió `401`. Revisá que la clave pegada sea exactamente la del secreto (sin espacios) o volvé a cargarla con `npx wrangler secret put SYNC_KEY --config worker/wrangler.toml` y pegala de nuevo con **Quitar clave** y **Guardar y conectar**. La app no reintenta en bucle.
- **Error de CORS en la consola o "Sin conexión" con red buena**: `ALLOWED_ORIGIN` no incluye el origen desde el que abrís la app. Corregilo en `worker/wrangler.toml` y volvé a correr `npm run worker:deploy`.
- **Carrera perdida (`500` al guardar)**: si dos dispositivos escriben a la vez, el que pierde puede recibir un `500` del Worker. No se pierde nada: el cliente conserva la cola y reintenta con backoff, y el reintento de la misma revisión es idempotente.
- **Push que falla con `500` en lotes grandes o al activar el cifrado**: mirá `npx wrangler tail --config worker/wrangler.toml` mientras repetís la acción. Una `db.batch` cuenta como una sola consulta para D1, así que no es el límite de consultas: buscá errores de tiempo de CPU o de tamaño (ver "Límites a verificar"). Los cambios siguen en la cola local mientras tanto.
- **"Estos datos locales están vinculados a otro servidor de sincronización."**: los datos del dispositivo quedaron atados al origen del Worker anterior (pasa si cambiás la URL o el dominio del Worker y volvés a compilar con otra `VITE_SYNC_URL`). La app no sube nada para no mezclar datos. Para pasar al servidor nuevo: bajá un backup con **Backup JSON** (marcá "Incluir valor hora y conciliación" si los usás); borrá los datos del sitio en el navegador (Chrome: candado de la barra → **Configuración del sitio** → **Borrar datos**; en la app instalada, desinstalala o borrá sus datos); abrí la app de nuevo, cargá el archivo en **Restaurar backup** y conectá con la clave. Si la nube nueva ya tiene datos, aparece **Fusionar datos**: confirmá y esperá a **Sincronizado**.
- **Solo local**: falta `VITE_SYNC_URL` en el build. Cargala con `gh variable set` y volvé a correr el workflow (`gh workflow run pages.yml`).
- **Git Bash reescribe las rutas como `/horas/`** (las convierte en `C:/Program Files/Git/horas/`). Para `npm run verify:pages -- /horas/` usá PowerShell, no Git Bash.
- **Probar el build bajo `/horas/` en la compu** (PowerShell):

  ```powershell
  $env:VITE_BASE = '/horas/'; npm run build; npm run verify:pages -- /horas/
  ```

  Después limpiá la variable (`Remove-Item Env:VITE_BASE`) para que el siguiente build vuelva a la base `/`. `npm run test:e2e` ya incluye una prueba de humo bajo `/horas/`: compila con `npm run build:pages` en `dist-pages/` (sin tocar `dist/`) y la sirve con `vite preview` en el puerto 47685.
