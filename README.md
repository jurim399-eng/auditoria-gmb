# Auditoría GMB — GoodMax

Landing de una sola página (HTML/CSS/JS puro, sin frameworks) para que un
negocio pegue el link de su ficha de Google Maps y reciba un checklist
simple de qué está bien y qué le falta, con un informe copiable para
WhatsApp y una invitación final a contactar a GoodMax.

## Estado actual

La auditoría lee la ficha real de Google Maps a través de una Netlify
Function (`netlify/functions/audit.js`), con dos fuentes de datos posibles
por auditoría (se elige sola, en este orden):

1. **SerpApi** (`engine=google_maps`, `place_results`) — si el sitio tiene
   configurada la variable de entorno `SERPAPI_KEY` en Netlify y se pudo
   identificar el lugar (place_id o data_id + coordenadas) a partir del
   link que pegó el usuario. Es la fuente confiable: los datos vienen
   estructurados de la API paga de SerpApi, no dependen de que Google no
   nos bloquee ni de parsear texto suelto.
2. **HTML público** (fallback) — si no hay `SERPAPI_KEY`, no se pudo
   identificar el lugar, o la llamada a SerpApi falla. Trae el HTML
   público de la ficha y aplica heurísticas de texto para estimar cada
   punto. No usa navegador headless — por eso es gratis, pero también por
   eso es **frágil**: si Google cambia el diseño de la página, algunas
   detecciones pueden dejar de funcionar hasta que se actualicen los
   patrones.

`debug.dataSource` en la respuesta de la function dice `"serpapi"` o
`"html"` según qué camino se usó en cada auditoría — es el primer dato a
mirar para confirmar que `SERPAPI_KEY` está andando.

### Qué tan confiable es cada punto

| Confiable (con SerpApi o en el HTML inicial) | Best-effort (patrones de texto, solo en modo HTML) | No disponible (ni Maps ni SerpApi lo exponen como dato público) |
|---|---|---|
| Categoría, categorías secundarias, sitio web, descripción, reseñas, servicios/menú, atributos | Fotos, horarios (en modo HTML son best-effort; con SerpApi son más confiables) | WhatsApp, publicaciones (posts), área de servicio, preguntas y respuestas |

El detalle punto por punto (qué campo de `place_results` o qué patrón de
texto busca cada uno, según la fuente) está documentado en los comentarios
de `netlify/functions/audit.js`, junto a cada `CHECK_DEFINITIONS`. Los 4
puntos de la columna "no disponible" van a marcar "falta" siempre, con
cualquiera de las dos fuentes — no es un bug, es que ni la API paga de
SerpApi ni el HTML público de Maps exponen esos datos.

**Importante:** el modo SerpApi no se probó todavía en producción — el
entorno donde se desarrolló no tiene salida de red hacia `serpapi.com`, así
que el parseo de `place_results` se validó offline contra el ejemplo de la
documentación oficial de SerpApi, pero no con una llamada real. Conviene
probarlo con fichas reales apenas esté desplegado en Netlify y revisar
`debug.dataSource` / `debug.serpApiError` en el resultado.

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
tiene al final una sección colapsable **"Ver detalle técnico"** con:
status HTTP del fetch a Google, los primeros 500 caracteres del HTML que
llegó, y para cada uno de los 13 puntos qué patrón/texto buscó y si lo
encontró. Sirve para diagnosticar directo desde el sitio publicado, sin
entrar a los logs de Netlify.

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
4. Deploy. Netlify va a redeployar automáticamente con cada push a
   `main`.
5. Si el sitio venía publicado en GitHub Pages, se puede desactivar en
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

- Probar el modo SerpApi con fichas reales en producción (ver
  `debug.dataSource` / `debug.serpApiError`) y ajustar el mapeo de campos
  si algo no viene como se esperaba.
- Validar en la práctica, con fichas reales, qué tan seguido Google
  bloquea o cambia el HTML del modo fallback — y ajustar los patrones de
  `netlify/functions/audit.js` según lo que se vea.
- Evaluar si conviene pedir también `engine=google_maps_photos` para
  tener el conteo real de fotos (hoy, con SerpApi, "fotos actualizadas" es
  un proxy por cantidad de categorías, no el total real — cuesta un
  crédito extra de SerpApi por auditoría).
