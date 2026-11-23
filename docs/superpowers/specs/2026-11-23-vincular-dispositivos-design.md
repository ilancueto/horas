# Conectar y vincular dispositivos — diseño corto

Fecha: 2026-11-23 · Rama base: `main`

## Intención

En un dispositivo vacío la pantalla de bienvenida solo ofrece "Importar mi Excel" o "Empezar de cero". No hay dónde poner la clave de sincronización: hay que crear un período de cero, ir a Más → Sincronización, pegar la clave y fusionar (con riesgo de un período de más). La persona quiere que un celular nuevo quede sincronizado sin vueltas.

## Qué se construye

1. **Botón "Ya tengo mis datos en la nube" en la bienvenida** (solo si hay `VITE_SYNC_URL` válida). Abre un diálogo "Conectar con mi nube" con el campo "Clave de sincronización". Al enviar: guarda la clave (`sync.saveKey`), espera a que la sincronización termine y, si bajó datos (hay períodos), marca el dispositivo como configurado (`onboarded`) y entra a la app. Si la clave no es válida: "La clave de sincronización no es válida." Si no hay datos en la nube: "No encontramos datos en la nube con esa clave. Podés empezar de cero." sin marcar nada.
2. **Enlace para vincular otro dispositivo.** En Más → Sincronización (con clave guardada): botón "Vincular otro dispositivo" que muestra el enlace `<origen><base>#clave=<clave>`, un botón "Copiar enlace" y un QR en SVG (negro sobre blanco con margen). Aviso: "Este enlace contiene tu clave. Usalo solo en tus dispositivos y borrá el mensaje después."
3. **Abrir el enlace:** al cargar la app, si la URL trae `#clave=…`, se lee y se **borra de la barra de inmediato** (`history.replaceState`) antes de cualquier otra cosa. Si el dispositivo no tiene clave guardada, se conecta con ella y sigue el mismo flujo que el botón de bienvenida (si no está configurado, baja los datos y entra). Si ya tiene una clave, se ignora y se avisa "Este dispositivo ya está conectado."

## Decisiones (mías, revisar)

- La clave viaja en el fragmento `#` (no se envía a ningún servidor). Una clave inválida para el Worker no da acceso a nada: la URL del Worker está fija en el build.
- `onboarded` es local al dispositivo (no se sincroniza). Se marca con una escritura directa al meta de ajustes (`markOnboarded()` en `src/data/db.ts`), **sin** `saveSettings`, para no encolar ni subir las reglas por defecto y pisar las de la nube.
- QR con una librería chica, MIT y sin dependencias, que genere SVG (sin `<canvas>`).
- No se muestra la clave en el panel; solo en el enlace/QR cuando la persona lo pide.

## Anti-objetivos

- Que una clave en la URL quede en el historial, el service worker o los logs (se borra al leerla; nunca se registra).
- Que un dispositivo nuevo suba reglas/ajustes por defecto a la nube pisando los reales.
- Que la bienvenida deje al dispositivo "configurado" sin haber bajado datos.
- Romper "Solo local" (sin `VITE_SYNC_URL` no aparece nada nuevo).

## Pruebas

Vitest para los helpers puros (armar y leer el enlace, ignorar fragmentos que no son `#clave=`), `markOnboarded` sin encolar. Playwright con el Worker simulado de `tests/sync.e2e.ts`: (1) perfil nuevo → bienvenida → botón → clave → entra con los datos del otro perfil; (2) clave incorrecta y nube vacía; (3) perfil nuevo abierto con `#clave=…` entra solo y el fragmento desaparece de la URL; (4) el enlace del panel contiene la clave y el QR se muestra. Axe sobre el diálogo nuevo y el panel.
