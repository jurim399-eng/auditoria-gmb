# Auditoría GMB — GoodMax

Landing de una sola página (HTML/CSS/JS puro, sin frameworks) para que un
negocio pegue el link de su ficha de Google Maps y reciba un checklist
simple de qué está bien y qué le falta, con un informe copiable para
WhatsApp y una invitación final a contactar a GoodMax.

## Estado actual

La auditoría **lee la ficha real de Google Maps** a través de una Netlify
Function (`netlify/functions/audit.js`), usando **SerpApi**
([serpapi.com](https://serpapi.com)) como proveedor de lectura.

### Por qué SerpApi y no leer el HTML de Google directo

La primera versión de esto traía el HTML público de la ficha y buscaba
patrones de texto (`og:description`, "Horario de atención", etc.). Al
probarla con una ficha real, **no encontró nada** — el HTML real de Google
Maps no manda ese contenido como texto plano en la carga inicial, sino
adentro de un bloque de datos interno (`APP_INITIALIZATION_STATE`)
pensado para que lo parsee el JS del propio Google, no un tercero.
Leerlo de forma confiable requeriría un navegador headless (Puppeteer),
que no entra en el límite de tiempo de las Netlify Functions gratuitas
para una sola ficha.

SerpApi ya resolvió ese problema del lado de ellos y devuelve los datos
de una ficha de Google Maps como JSON estructurado en una sola llamada
HTTP síncrona — encaja bien con el límite de ~10s de las Netlify
Functions gratuitas. Hace falta:

1. Una cuenta gratis en [serpapi.com](https://serpapi.com) (alcanza para
   auditar fichas de a una, no para picos de miles).
2. Cargar la API key como variable de entorno **`SERPAPI_KEY`** en
   Netlify: **Site settings → Environment variables**.
3. Volver a desplegar (o esperar al próximo deploy) para que la function
   la tome.

Sin esa variable configurada, la auditoría devuelve un mensaje de error
claro en vez de romperse en silencio.

### ⚠️ Estado de la integración con SerpApi (a validar)

Este entorno de desarrollo no tiene salida de red hacia serpapi.com —
ni para llamar a la API con una key real, ni para leer su documentación
online. Se fueron encontrando bugs reales en varias vueltas, cada una
confirmada por el propio mensaje de error que devolvió SerpApi (no
adivinados): primero faltaba mandar `q` junto con el identificador de
la ficha, después faltaba `type=place` para pedir la ficha completa (sin
eso, SerpApi devuelve una lista de resultados de búsqueda), y el nombre
de parámetro para identificar la ficha (`data`, con `data_cid` como
respaldo) también se corrigió a partir de un mensaje de error real.

Lo que **todavía no está confirmado** con una respuesta real y exitosa
de SerpApi son los nombres de campo *adentro* de la ficha que lee
`buildContext()` (`website`, `hours`, `service_options`, `reviews`,
etc.) — siguen basados en documentación recordada. `buildContext()`
prueba varios nombres posibles por dato (ver `firstDefined()`) para no
depender de una sola apuesta, pero eso reduce el riesgo, no lo elimina.

**Para cerrar esto de una vez** hace falta un solo JSON real de
`debug.placeJson` (una auditoría ya hecha, sin gastar una nueva) o, si
hay margen de créditos, un `debug.placeJson` de una ficha con web,
horarios y reseñas conocidas para comparar campo por campo contra la
realidad. Con eso se ajusta `buildContext()` en un solo paso en vez de
seguir corrigiendo a ciegas.

### Qué tan confiable es cada punto

| Confiable (campo directo de la API) | Best-effort (depende del rubro, o de heurística propia arriba del campo) | No disponible con este proveedor |
|---|---|---|
| Sitio web (una vez que hay URL), reseñas | Horarios, categoría, descripción, categorías secundarias, atributos (`service_options` solo lo carga Google para algunos rubros, sobre todo gastronomía) | WhatsApp, publicaciones (posts), área de servicio, preguntas y respuestas, y fotos (SerpApi en el plan gratis solo da `thumbnail`: sí/no hay foto de portada, sin fecha ni cantidad — no alcanza para evaluar "actualizadas") |

El detalle punto por punto está documentado en los comentarios de
`netlify/functions/audit.js` y en el `detail` de cada punto (visible en el
panel de "Ver detalle técnico" del resultado). Los puntos de la columna
"no disponible" no son un bug: SerpApi no expone esos datos en la
respuesta básica de Google Maps (y en el caso de WhatsApp, ni siquiera es
un campo público real de Maps) — se sacaron del checklist en vez de
dejarlos marcando "falta" casi siempre sin que fuera una auditoría real.

**Categoría** y **Web** además hacen trabajo extra sobre el campo de la
API, no se conforman con que "exista":

- **Categoría**: `type` puede no estar vacío pero igual ser una
  categoría "cajón de sastre" que Google usa cuando nadie configuró una
  específica (`GENERIC_CATEGORY_NAMES` en `audit.js`) — en ese caso
  marca "mal". Si el usuario completa el campo opcional "Rubro de tu
  negocio" en el formulario, además exige que `type` coincida
  razonablemente con ese rubro (comparación por palabra, tolera
  variaciones como plomería/plomero).
- **Web**: además de que `website` no esté vacío, se hace un fetch
  aparte (no a SerpApi) contra esa URL para confirmar que responde —
  un link a un sitio caído ya no cuenta como "web cargada". Trade-off
  aceptado: más latencia (hasta `WEBSITE_FETCH_TIMEOUT_MS`, 4.5s) y
  riesgo de falso negativo si ese sitio bloquea peticiones automáticas.

**Importante:** no se pudo probar contra SerpApi en producción desde este
entorno de desarrollo (no tiene salida de red hacia servicios externos) —
se validó con respuestas de SerpApi simuladas, incluyendo los criterios
nuevos de categoría/web/horarios/descripción/reseñas. Conviene probarlo
con fichas reales apenas esté la `SERPAPI_KEY` configurada en Netlify, y
ajustar el mapeo de campos en `buildContext()` de `audit.js` según lo que
se vea en el panel de detalle técnico — en particular la forma real del
campo `hours` (de la que depende la detección de "abierto 24 horas").

## El campo "rubro" (opcional)

El formulario tiene un campo opcional, "Rubro de tu negocio", que viaja
como `rubro` en el `POST /api/audit`. Lo usan dos checks:

- **categoria**: si se completa, exige que la categoría (`type`)
  coincida con ese rubro (si no coincide, marca "mal" aunque `type` sea
  específico y no genérico). Vacío, el check solo evalúa que haya una
  categoría específica cargada, sin poder confirmar que sea *la
  correcta* para ese rubro.
- **horarios**: se usa junto con `type` para decidir si el rubro es de
  los que justifican "abierto las 24 horas" (cerrajería, grúa,
  emergencias médicas, hotelería, etc. — ver `EMERGENCY_RUBRO_PATTERNS`
  en `audit.js`).

## Los 8 puntos que se evalúan

- Horarios completos (y sin "abierto 24 horas" sospechoso fuera de rubros de emergencia)
- Categoría correcta (no genérica, y coincide con el rubro declarado si se completó)
- Web cargada (y confirmamos que responde)
- Descripción del negocio completa (largo mínimo y sin señales de spam/relleno)
- Servicios o productos cargados
- Categorías secundarias (principal + 2 o más secundarias)
- Atributos del negocio completos (accesibilidad, delivery, retiro en local, etc.)
- Reseñas (más de 30, con promedio de 4.2 o más)

**Se sacaron del checklist** (versión original tenía 13 puntos, esta
tiene 8): fotos, WhatsApp, publicaciones (posts), área de servicio y
preguntas y respuestas — sin dato confiable detrás con el proveedor
actual (ver tabla de arriba). Se reincorporan si en algún momento se paga
la llamada aparte a la API de fotos de SerpApi, o se suma otra fuente de
datos para el resto.

## Informe copiable

Al final del resultado hay un botón **"Copiar informe"** que arma un texto
plano (con formato WhatsApp: `*negrita*`) con el diagnóstico completo,
listo para pegar en un chat, y cierra invitando a pedir el diagnóstico
completo con GoodMax. La lógica está en `buildReportText()` en
`script.js`.

## Detalle técnico (temporal, para diagnóstico)

Mientras estamos ajustando la precisión de la lectura real, cada resultado
tiene al final una sección colapsable **"Ver detalle técnico"** con: qué
identificador de Google se usó (`data_id` o búsqueda por nombre), para
cada uno de los 8 puntos qué campo miramos y qué encontramos, y el JSON
completo que devolvió SerpApi para esa ficha (con un botón para copiarlo).
Sirve para diagnosticar directo desde el sitio publicado, sin entrar a
los logs de Netlify.

Es temporal: el interruptor está en `DEBUG_MODE` (arriba de
`netlify/functions/audit.js`) — ponerlo en `false` corta el campo `debug`
en la respuesta de la function, y con eso la sección deja de aparecer en
el frontend automáticamente (no hace falta tocar el HTML). Cuando se dé
de baja del todo, conviene borrar también el bloque `<details
id="debug-details">` de `index.html` y `renderDebugDetails()` de
`script.js`.

## Arquitectura

```
index.html + style.css + script.js   → frontend estático
netlify/functions/audit.js           → Netlify Function (lee Maps y devuelve el checklist)
netlify.toml                         → config de Netlify (publish dir, functions dir, redirect /api/*)
```

El frontend llama a `POST /api/audit` con `{ url, rubro }` (`rubro` puede
ir vacío). Netlify redirige eso a la function real
(`/.netlify/functions/audit`, ver `netlify.toml`). La function devuelve:

```json
{ "resolvedUrl": "...", "checks": { "horarios": true, "categoria": false, ... } }
```

`script.js` cruza ese `checks` con `CHECKLIST_DEFINITION` (que tiene los
títulos y textos de cada punto) para armar el checklist que se ve en
pantalla — así el formato de la interfaz no depende de la function.

## Cómo desplegar en Netlify (conectado a este repo de GitHub)

1. Entrar a [app.netlify.com](https://app.netlify.com) → **Add new site
   → Import an existing project**.
2. Elegir **GitHub** y autorizar acceso al repo `auditoria-gmb`.
3. Configuración de build (Netlify debería detectar `netlify.toml`
   solo, pero por si acaso):
   - **Build command:** dejar vacío (no hay build, es HTML/CSS/JS puro).
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`
4. Antes (o después) del primer deploy, cargar la variable de entorno
   **`SERPAPI_KEY`** en **Site settings → Environment variables** (ver
   sección de arriba) — sin esto la auditoría no va a poder leer fichas
   reales.
5. Deploy. Netlify va a redeployar automáticamente con cada push a
   `main`.
6. Si el sitio venía publicado en GitHub Pages, se puede desactivar en
   GitHub → repo → **Settings → Pages** una vez confirmado que Netlify
   funciona.

### Probarlo en local con Netlify CLI (opcional)

```bash
npm install -g netlify-cli
netlify dev
```

Esto sirve el sitio y las functions juntos (igual que en producción). Sin
`netlify dev`, abrir `index.html` directo o con `python3 -m http.server`
sirve el diseño pero **la auditoría real no va a funcionar** porque no
hay ningún servidor respondiendo `/api/audit`.

## Pendiente / a evaluar más adelante

- Validar en la práctica, con fichas reales y la `SERPAPI_KEY` puesta,
  que el mapeo de campos de `buildContext()` en `audit.js` sea correcto
  — ajustar según lo que muestre el panel de detalle técnico. En
  particular: confirmar la forma real de `hours` (de la que depende
  `hasOpen24h`) y si `rating` es el nombre de campo correcto para el
  promedio de reseñas.
- Evaluar el consumo real contra el nivel gratuito de SerpApi (o el plan
  pago si hace falta más volumen, o si se quiere sumar la llamada a la
  API de fotos para poder reincorporar ese check).
- Para los puntos "no disponibles" de la tabla de arriba (WhatsApp,
  posts, preguntas y respuestas, área de servicio, fotos), evaluar si
  vale la pena sumar un navegador headless u otra fuente de datos más
  adelante, o directamente dejarlos como limitación conocida de la
  auditoría automática.
