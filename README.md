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
online. Eso significa que:

- El parámetro `type=place` (que le pide a SerpApi la ficha completa de
  un negocio puntual, no una lista de resultados de búsqueda) y los
  nombres de campo que se leen en `buildContext()` (`website`, `hours`,
  `service_options`, `reviews`, etc.) están basados en documentación
  recordada, **no verificada en vivo**. Ya hubo un bug real por esto
  (faltaba `type=place`, y antes faltaba mandar `q` junto con
  `data_id`) — es decir, esta integración **todavía no se probó de
  punta a punta con una respuesta real de SerpApi confirmada como
  correcta**.
- `buildContext()` prueba varios nombres de campo posibles por dato
  (ver `firstDefined()`) para no depender de una sola apuesta, pero
  eso reduce el riesgo, no lo elimina.

**Para cerrar esto de una vez** hace falta un solo JSON real de
`debug.placeJson` (una auditoría ya hecha, sin gastar una nueva) o, si
hay margen de créditos, un `debug.placeJson` de una ficha con web,
horarios y reseñas conocidas para comparar campo por campo contra la
realidad. Con eso se ajusta `buildContext()` en un solo paso en vez de
seguir corrigiendo a ciegas.

### Qué tan confiable es cada punto

| Confiable (campo directo de la API) | Best-effort (depende del rubro del negocio) | No disponible con este proveedor |
|---|---|---|
| Categoría, categorías secundarias, sitio web, descripción, horarios, reseñas | Atributos (`service_options`: delivery/para llevar/etc. — Google solo lo carga para algunos rubros, sobre todo gastronomía) | WhatsApp, publicaciones (posts), área de servicio, preguntas y respuestas, servicios/productos, y "¿hay fotos actualizadas?" (solo se puede confirmar si hay *una* foto de portada, no cantidad ni fecha) |

El detalle punto por punto está documentado en los comentarios de
`netlify/functions/audit.js` y en el `detail` de cada punto (visible en el
panel de "Ver detalle técnico" del resultado). Los puntos de la columna
"no disponible" no son un bug: SerpApi no expone esos datos en la
respuesta básica de Google Maps (y en el caso de WhatsApp, ni siquiera es
un campo público real de Maps) — van a marcar "falta" casi siempre.

**Importante:** no se pudo probar contra SerpApi en producción desde este
entorno de desarrollo (no tiene salida de red hacia servicios externos) —
se validó con respuestas de SerpApi simuladas. Conviene probarlo con
fichas reales apenas esté la `SERPAPI_KEY` configurada en Netlify, y
ajustar el mapeo de campos en `buildContext()` de `audit.js` según lo que
se vea en el panel de detalle técnico.

## Los 13 puntos que se evalúan

- Fotos actualizadas
- Horarios completos
- Categoría correcta
- Web cargada
- WhatsApp cargado
- Publicaciones activas
- Descripción del negocio completa (con palabras clave del rubro)
- Servicios o productos cargados
- Categorías secundarias
- Área de servicio configurada
- Atributos del negocio completos (accesibilidad, delivery, retiro en local, etc.)
- Preguntas y respuestas (si el dueño responde)
- Reseñas (cantidad y si el negocio responde)

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
cada uno de los 13 puntos qué campo miramos y qué encontramos, y el JSON
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

El frontend llama a `POST /api/audit` con `{ url }`. Netlify redirige eso
a la function real (`/.netlify/functions/audit`, ver `netlify.toml`). La
function devuelve:

```json
{ "resolvedUrl": "...", "checks": { "fotos": true, "horarios": false, ... } }
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
  — ajustar según lo que muestre el panel de detalle técnico.
- Evaluar el consumo real contra el nivel gratuito de SerpApi (o el plan
  pago si hace falta más volumen).
- Para los puntos "no disponibles" de la tabla de arriba (WhatsApp,
  posts, preguntas y respuestas, área de servicio), evaluar si vale la
  pena sumar un navegador headless más adelante, o directamente dejarlos
  como limitación conocida de la auditoría automática.
