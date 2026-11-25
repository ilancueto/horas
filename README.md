# Horas

Registro personal de jornadas, horas extra y períodos de pago. Funciona en español rioplatense, con fecha y hora de Buenos Aires. Se puede usar solo con el almacenamiento del dispositivo o sincronizar varios dispositivos con un Worker de Cloudflare y una base D1.

## Arrancar en la compu

Usá Node.js 24 LTS.

```sh
npm ci
npm run dev
```

Abrí la dirección que indica Vite. En el primer uso elegí **Importar mi Excel** o **Empezar de cero** (con la sincronización configurada, también **Ya tengo mis datos en la nube**). La planilla original se conserva en tu carpeta y está excluida de Git y del sitio publicado. La app lee el archivo localmente cuando lo elegís.

Para probar la PWA de producción:

```sh
npm run build
npm run preview -- --port 47683
```

## Instalar en el celular o la compu

1. Publicá la app por HTTPS y abrila una vez con conexión. Esperá a que termine de cargar.
2. En Android, abrí el menú de Chrome y elegí **Instalar aplicación** o **Agregar a la pantalla principal**. En iPhone, abrí Safari y elegí **Compartir → Agregar a pantalla de inicio**. En Chrome o Edge de escritorio, usá el botón de instalación de la barra de direcciones o del menú.
3. Abrila desde el ícono. En los sistemas que admiten accesos directos del manifest, **Cargar hoy** abre la jornada actual.

El service worker guarda la aplicación, las tipografías y los módulos de importación/exportación. Las jornadas quedan en IndexedDB. Cada origen tiene su propio almacenamiento. Si cambiás de dirección, migrá los datos con un JSON o con la misma clave de sincronización. Los recordatorios requieren permiso de notificaciones y se comprueban mientras Horas está abierta. Los navegadores no ofrecen programación local fiable con la PWA totalmente cerrada.

## Importar, exportar y respaldar

- En **Más → Archivos y respaldo**, podés importar otra planilla, exportar XLSX o bajar un JSON. Antes de confirmar el Excel, revisá el resumen de la importación. Se conservan las ediciones locales de registros que ya existen.
- Las dos hojas con jornadas de la planilla de referencia se incorporan con 49 filas con datos. El segundo período tenía el cierre en blanco, por lo que se propone un cierre editable que cubre la última carga. Las hojas de plantilla sin datos se omiten.
- La vista previa contrasta los valores guardados en Excel con los valores recalculados usando sus feriados y su redondeo por fila. Los totales de noviembre y diciembre coinciden con ese método. En los períodos importados, el decimal del período, la conciliación y el PDF usan el redondeo por fila de Excel. La duración en h:mm conserva los minutos exactos. **Totales de la planilla original** permite comparar ambas formas de sumar.
- En el período, **Resumen para RRHH** ofrece texto copiable y dos PDF imprimibles. Los importes de pago y la conciliación quedan locales y se excluyen de las descargas por defecto. Podés incluirlos explícitamente en el backup JSON.
- **Restaurar backup** valida el archivo antes de mostrar la confirmación. Descargá un respaldo previo desde el diálogo. Los respaldos son archivos de lectura directa, incluso cuando el cifrado en la nube está activo.

Los feriados de 2026 incluyen los días turísticos publicados para ese año. Para 2027 se aplican las reglas de los feriados nacionales de la Ley 27.399. Podés agregar fechas extraordinarias desde **Feriados**. [Ley 27.399](https://www.argentina.gob.ar/normativa/nacional/ley-27399-281835/texto) · [Calendario oficial](https://www.argentina.gob.ar/feriados) · [Resolución 164/2025](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-164-2025-421799)

## Licencias, saldos y calculadora de extras

- **Licencias**: en **Más → Licencias** cargás licencias por enfermedad, por mudanza u otras, con su rango de fechas. Se ven en el calendario, en el resumen anual y en el resumen para RRHH, cada una con su color.
- **Saldos**: la pestaña muestra los francos compensatorios disponibles (ganados con cada 8 h acumuladas al 100%, menos los tomados) y los días de vacaciones del año. Desde **Cargar saldo inicial** podés partir de los francos y las horas al 100% que ya tenías antes de usar la app. El saldo inicial se sincroniza con las reglas de cálculo.
- **Calculadora de extras**: en **Más → Calculadora de extras** elegís un período y ves cuánto suman las horas al 50% y al 100% con tu valor hora. Es una estimación con las horas decimales del período.
- El contador del período y el resumen anual muestran solo horas extra. El resumen para RRHH y los archivos exportados siguen mostrando las horas normales.
- El valor hora queda solo en el dispositivo: no entra en las exportaciones ni en la sincronización, salvo que lo incluyas a propósito en el backup JSON.
- Antes de usar Licencias, actualizá la app en todos tus dispositivos: uno con una versión vieja descarta el tipo de licencia y la lee como vacaciones.
- Un dispositivo con una versión vieja que guarde las reglas puede borrar el saldo inicial, y uno nuevo que después baje y edite las reglas puede pisarlo en los demás. Si pasa, volvé a cargarlo desde Ajustes.

## Sincronización (Worker de Cloudflare + D1)

La sincronización es opcional. Sin configurar nada, la app queda en **Solo local**. La guía paso a paso para desplegarla está en [`docs/despliegue.md`](docs/despliegue.md).

1. El Worker vive en `worker/` y guarda los registros en una base D1. Se despliega con `npm run worker:deploy`.
2. La URL del Worker se carga al compilar con la variable `VITE_SYNC_URL` (para probar en la compu, copiá `.env.example` a `.env.local`). Es una URL pública, no un secreto.
3. La clave secreta (`SYNC_KEY`) es un secreto del Worker. En el primer dispositivo la pegás una vez en **Más → Sincronización** y queda guardada solo en ese dispositivo. Nunca entra en backups, exportaciones ni en la sincronización, y tampoco en el build ni en el repositorio.
   - Para sumar otro dispositivo, usá **Más → Sincronización → Vincular otro dispositivo**: abrí ese enlace (o escaneá el QR) en el dispositivo nuevo y se conecta solo, baja tus datos y entra. La clave viaja en el fragmento `#` del enlace, que el navegador no le manda a ningún servidor, y la app la borra de la barra apenas la lee. Usalo solo en tus dispositivos y borrá el mensaje y la entrada del historial después.
   - También podés tocar **Ya tengo mis datos en la nube** en la bienvenida y pegar la clave. Si la clave no es válida o la nube está vacía, la app te avisa y no deja nada configurado. Si la nube tiene cifrado, te pide la frase de paso antes de entrar.
   - Ojo: aunque la app borra el enlace de la barra, puede quedar en el historial del navegador (la visita ya se registró al abrirlo) y en el historial del portapapeles si lo copiaste. Borralo a mano: en Chrome, **Historial** (Ctrl+H), buscá la dirección de Horas y eliminá esa entrada; en el celular, lo mismo desde **Historial** del navegador. En Windows, el historial del portapapeles se abre con Win+V (**Borrar todo** o el menú `…` de esa entrada); en el celular, revisá el portapapeles del teclado.
   - Si compartiste el enlace o la clave por error, cambiá la clave del Worker con `npx wrangler secret put SYNC_KEY --config worker/wrangler.toml` y volvé a conectar cada dispositivo con la clave nueva (**Quitar clave** y **Guardar y conectar**, o un enlace nuevo).
4. Si dos dispositivos ya tienen datos, el segundo que se conecta ofrece **Fusionar datos** para no perder ni duplicar nada.
5. Si ya habías cifrado los registros de la nube, abrí **Más → Sincronización**, ingresá la frase actual y tocá **Desactivar cifrado**. El Worker verifica la frase una vez y convierte todos los registros juntos. Luego la sincronización usa la clave de sincronización.

No hay tiempo real: la app consulta la nube cada 45 segundos, cuando cambian los datos y cuando vuelve la conexión.

Se sincronizan períodos, jornadas, días especiales, licencias y reglas de cálculo (incluido el saldo inicial de compensatorios). El PIN, tema, recordatorios, conciliación y estimación de pago son de cada dispositivo. El PIN controla la pantalla de acceso. Los registros sincronizados se guardan en Cloudflare y el acceso a la API requiere la clave de sincronización. Los IDs estables de jornadas, feriados y períodos se derivan de sus fechas.

Los cambios pendientes conservan su revisión hasta confirmarse. Ante cambios concurrentes del mismo registro gana la última escritura aceptada por el servidor. El servidor conserva los borrados lógicos y reconoce los reintentos de una revisión ya aceptada.

## Publicar por HTTPS

La app se publica en GitHub Pages, en https://ilancueto.github.io/horas/. El workflow `.github/workflows/pages.yml` corre lint, tipos y tests en cada push a `main`, compila con `VITE_BASE=/horas/` y publica. Las dos variables de build son:

- `VITE_BASE`: base pública de la app. Por defecto `/`; en Pages es `/horas/`.
- `VITE_SYNC_URL`: URL del Worker. Va como variable del repositorio (`gh variable set VITE_SYNC_URL --body <url>`). Si falta, la app queda en Solo local.

Para comprobar que el build respete la base, en PowerShell: `$env:VITE_BASE='/horas/'; npm run build; npm run verify:pages -- /horas/`.

Si cambia el dominio, volvé a instalar la PWA desde el dominio nuevo y actualizá `ALLOWED_ORIGIN` en `worker/wrangler.toml`. Cualquier otro hosting estático (Vercel, Cloudflare Pages) también sirve con `npm run build` y la carpeta `dist`.

## Verificación

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

Vitest prueba las franjas de horas, fechas, ausencias, importación, persistencia, cola, cifrado, el cliente de la nube y el Worker con una base D1 simulada. Playwright recorre la compilación de producción en escritorio (1440 px) y celular emulado (390 px), captura ambos temas, verifica accesibilidad, comprueba el manifest y prueba el acceso directo con la red desconectada. Se simulan dos perfiles de navegador contra una API del Worker simulada, con reconexión y fusión, porque el repositorio no trae credenciales reales. Las pruebas con la planilla privada se omiten únicamente cuando el archivo no está en la carpeta del proyecto.
