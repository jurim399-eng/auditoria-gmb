# Auditoría GMB — GoodMax

Landing de una sola página (HTML/CSS/JS puro, sin frameworks) para que un
negocio pegue el link de su ficha de Google Maps y reciba un checklist
simple de qué está bien y qué le falta, con un informe copiable para
WhatsApp y una invitación final a contactar a GoodMax.

## Estado actual

La auditoría **lee la ficha real de Google Maps** a través de una Netlify
Function (`netlify/functions/audit.js`): trae el HTML público de la ficha
que pegó el usuario y aplica heurísticas de texto para estimar cada punto
del checklist. No usa la API oficial de Google (que es paga) ni un
navegador headless — por eso es gratis, pero también por eso es **frágil**:
si Google cambia el diseño de la página, algunas detecciones pueden dejar
de funcionar hasta que se actualicen los patrones.

### Qué tan confiable es cada punto

| Confiable (suele estar en el HTML inicial) | Best-effort (patrones de texto, puede fallar) | Débil (rara vez está en el HTML inicial o ni siquiera es un dato público) |
|---|---|---|
| Categoría, sitio web, descripción, reseñas | Fotos, horarios, atributos, área de servicio | WhatsApp, categorías secundarias, publicaciones (posts), preguntas y respuestas |

El detalle punto por punto está documentado en los comentarios de
`netlify/functions/audit.js`. Dicho en criollo: los puntos de la columna
"débil" van a marcar "falta" la mayoría de las veces aunque la ficha sí
los tenga, porque esa info se carga con JavaScript después de la carga
inicial (o directamente no es un dato que Maps muestre en público). Si en
algún momento hace falta más precisión, el camino es sumar un navegador
headless (Puppeteer/Playwright), que ya no entra limpio en el plan
gratuito de Netlify Functions tal cual está armado hoy.

**Importante:** esto no se probó todavía contra Google Maps en producción
— se validó con HTML de prueba simulado, porque el entorno donde se
desarrolló no tiene salida de red hacia google.com. Conviene probarlo con
fichas reales apenas esté desplegado en Netlify.

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

- Validar en la práctica, con fichas reales, qué tan seguido Google
  bloquea o cambia el HTML — y ajustar los patrones de
  `netlify/functions/audit.js` según lo que se vea.
- Evaluar si conviene sumar un navegador headless para los puntos
  "débiles" de la tabla de arriba, si la precisión actual no alcanza.
