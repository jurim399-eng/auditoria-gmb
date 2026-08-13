"use strict";

/**
 * Netlify Function: auditoría real de una ficha de Google Maps
 * -----------------------------------------------------------------
 * Se llama vía POST /api/audit (redirect definido en netlify.toml
 * hacia /.netlify/functions/audit) con body { url }.
 *
 * Trae el HTML público de esa ficha —sin login, sin API oficial de
 * Google— y aplica heurísticas de texto para estimar cada punto del
 * checklist. Devuelve { resolvedUrl, checks: { <id>: boolean, ... },
 * debug: {...} }, usando los mismos "id" que CHECKLIST_DEFINITION en
 * script.js.
 *
 * El campo `debug` es TEMPORAL, para diagnosticar en pantalla (sección
 * "Ver detalle técnico" en el resultado) por qué cada punto da ok/falta
 * sin tener que ir a buscar los logs de Netlify. Sacarlo (y el bloque
 * de <details> correspondiente en el frontend) una vez resuelto el
 * diagnóstico — ver DEBUG_MODE más abajo.
 *
 * LIMITACIONES CONOCIDAS (léase antes de tocar esto):
 * Google Maps es una app muy dinámica: gran parte de lo que se ve en
 * el navegador (fotos, horarios, posts, preguntas y respuestas,
 * atributos) se termina de cargar con JavaScript después de la carga
 * inicial, o viene de llamadas internas no documentadas de Google. Acá
 * NO ejecutamos JavaScript ni usamos un navegador headless (para que
 * siga siendo gratis y simple) — solo pedimos el HTML inicial y
 * buscamos pistas de texto. Por eso:
 *
 *   - Categoría, sitio web, descripción y reseñas se detectan
 *     razonablemente bien: esos datos casi siempre están en el HTML
 *     inicial (meta tags, bloque de datos embebido).
 *   - Horarios, atributos y área de servicio son best-effort: buscan
 *     patrones de texto conocidos, pero pueden fallar si Google
 *     cambia el formato de la página.
 *   - WhatsApp, categorías secundarias, publicaciones (posts) y
 *     preguntas y respuestas son los puntos MÁS débiles: esa
 *     información casi nunca está en el HTML inicial (o ni siquiera
 *     es un dato público de Maps, como pasa con WhatsApp), así que en
 *     la mayoría de los casos van a marcar "falta" aunque la ficha sí
 *     los tenga. Es una limitación conocida de leer la página pública
 *     sin un navegador con JS — no de un bug puntual.
 *
 * Si en algún momento se necesita más precisión, el camino es usar un
 * navegador headless (Puppeteer/Playwright) para que la página se
 * renderice como en un navegador real. Eso ya no entra limpio en el
 * plan gratuito de Netlify Functions tal cual está armado hoy — se
 * evalúa aparte si hace falta.
 */

// TEMP: mientras se diagnostica por qué los puntos dan "falta" con
// fichas reales, mandamos el detalle técnico al frontend. Poner en
// false (o borrar el campo `debug` de las respuestas) para apagarlo.
const DEBUG_MODE = true;

const ALLOWED_URL_PATTERN =
  /^https?:\/\/(www\.)?(google\.[a-z.]{2,10}\/maps\/|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)/i;

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_LENGTH = 3_000_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const GOOGLE_OWNED_DOMAIN =
  /(google\.|gstatic\.|ggpht\.|googleusercontent\.|goo\.gl|schema\.org|w3\.org|googleapis\.|gmail\.|youtube\.|apple\.com|play\.google)/i;

const ATTRIBUTE_KEYWORDS = [
  "Accesible en silla de ruedas",
  "Entrada accesible",
  "Retiro en el local",
  "Entrega a domicilio",
  "Para llevar",
  "Delivery",
];

// ---------------------------------------------------------------
// Definición única de los 13 puntos: cada uno sabe cómo evaluarse
// (ok) y cómo explicar en criollo qué buscó y qué encontró (detail),
// a partir del mismo `ctx` calculado una sola vez por auditoría. Así
// evitamos mantener la misma lógica escrita dos veces en paralelo
// (una para el resultado real y otra para el debug) y que se
// desincronicen.
// ---------------------------------------------------------------
const CHECK_DEFINITIONS = [
  {
    id: "fotos",
    title: "Fotos actualizadas",
    ok: (ctx) => ctx.photoUrlCount >= 20,
    detail: (ctx) =>
      `Buscamos URLs de fotos con el patrón "lh#.googleusercontent.com/p/...". Encontradas: ${ctx.photoUrlCount} (hace falta 20 o más para marcar "bien").`,
  },
  {
    id: "horarios",
    title: "Horarios completos",
    ok: (ctx) => ctx.timeRangeCount >= 3 || ctx.hasHorarioLabel,
    detail: (ctx) =>
      `Buscamos 3 o más rangos horarios tipo "08:00-20:00" (encontrados: ${ctx.timeRangeCount}) o el texto "Horario de atención" (${ctx.hasHorarioLabel ? "SÍ aparece" : "NO aparece"}).`,
  },
  {
    id: "categoria",
    title: "Categoría correcta",
    ok: (ctx) => ctx.ogDescription.length > 0,
    detail: (ctx) =>
      `Buscamos el meta tag <meta property="og:description">. Contenido encontrado: ${ctx.ogDescription ? `"${ctx.ogDescription}"` : "(vacío / no se encontró el meta tag)"}.`,
  },
  {
    id: "web",
    title: "Web cargada",
    ok: (ctx) => ctx.externalUrls.length > 0 && ctx.hasSitioWebLabel,
    detail: (ctx) =>
      `Buscamos el texto "Sitio web"/"Website" (${ctx.hasSitioWebLabel ? "SÍ aparece" : "NO aparece"}) y URLs externas a Google. Encontradas: ${ctx.externalUrls.length}${ctx.externalUrls.length ? ` (ej. ${ctx.externalUrls[0]})` : ""}.`,
  },
  {
    id: "whatsapp",
    title: "WhatsApp cargado",
    ok: (ctx) => ctx.hasWhatsappMention,
    detail: (ctx) =>
      `Buscamos "wa.me/" o la palabra "whatsapp" en el HTML. ${ctx.hasWhatsappMention ? "SÍ aparece" : "NO aparece"}. Ojo: Maps no suele exponer esto como campo público, así que este punto casi siempre da "falta" aunque el negocio sí tenga WhatsApp.`,
  },
  {
    id: "publicaciones",
    title: "Publicaciones activas",
    ok: (ctx) => ctx.hasLocalPostMarker,
    detail: (ctx) =>
      `Buscamos el marcador interno "LocalPost" o el texto "Actualizaciones recientes". ${ctx.hasLocalPostMarker ? "SÍ aparece" : "NO aparece"}. Los posts se cargan con JavaScript después de la carga inicial, así que rara vez están en este HTML.`,
  },
  {
    id: "descripcion",
    title: "Descripción del negocio completa",
    ok: (ctx) => ctx.ogDescription.length >= 60,
    detail: (ctx) =>
      `Mismo meta tag og:description que "Categoría", pero exigiendo 60 caracteres o más. Largo encontrado: ${ctx.ogDescription.length} caracteres.`,
  },
  {
    id: "servicios",
    title: "Servicios o productos cargados",
    ok: (ctx) => ctx.hasServiciosLabel,
    detail: (ctx) =>
      `Buscamos los textos "Servicios ofrecidos", "Lista de productos" o "Productos destacados". ${ctx.hasServiciosLabel ? "SÍ aparece alguno" : "NO aparece ninguno"}. Esta sección suele cargarse con JavaScript.`,
  },
  {
    id: "categorias-secundarias",
    title: "Categorías secundarias",
    ok: (ctx) => ctx.categoryIdCount > 1,
    detail: (ctx) =>
      `Contamos apariciones de "category_id" en el HTML (proxy indirecto, no es un dato público mostrado tal cual). Encontradas: ${ctx.categoryIdCount} (hace falta más de 1).`,
  },
  {
    id: "area-servicio",
    title: "Área de servicio configurada",
    ok: (ctx) => ctx.hasAreaServicioLabel,
    detail: (ctx) =>
      `Buscamos el texto "Área de servicio" / "Service area". ${ctx.hasAreaServicioLabel ? "SÍ aparece" : "NO aparece"}.`,
  },
  {
    id: "atributos",
    title: "Atributos del negocio completos",
    ok: (ctx) => ctx.attributeHits.length >= 2,
    detail: (ctx) =>
      `Buscamos estas frases exactas: ${ATTRIBUTE_KEYWORDS.map((k) => `"${k}"`).join(", ")}. Encontradas (${ctx.attributeHits.length}): ${ctx.attributeHits.length ? ctx.attributeHits.join(", ") : "ninguna"}. Hacen falta 2 o más.`,
  },
  {
    id: "preguntas-respuestas",
    title: "Preguntas y respuestas",
    ok: (ctx) => ctx.hasPreguntasLabel && ctx.hasRespuestaDeLabel,
    detail: (ctx) =>
      `Buscamos el texto "Preguntas y respuestas" (${ctx.hasPreguntasLabel ? "SÍ aparece" : "NO aparece"}) y "Respuesta de" (${ctx.hasRespuestaDeLabel ? "SÍ aparece" : "NO aparece"}). Esta sección se carga con JavaScript, casi nunca está en el HTML inicial.`,
  },
  {
    id: "resenas",
    title: "Reseñas",
    ok: (ctx) => ctx.reviewCount !== null && ctx.reviewCount >= 5,
    detail: (ctx) =>
      `Buscamos un número seguido de "reseñas"/"reviews"/"opiniones". Encontrado: ${ctx.reviewCountMatch ? `"${ctx.reviewCountMatch}"` : "(no se encontró)"} → ${ctx.reviewCount !== null ? ctx.reviewCount : "sin número"} (hace falta 5 o más).`,
  },
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Método no permitido." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "JSON inválido." });
  }

  const url = typeof payload.url === "string" ? payload.url.trim() : "";

  if (!url || !ALLOWED_URL_PATTERN.test(url)) {
    return jsonResponse(400, {
      error: "Ese link no parece ser una ficha de Google Maps. Copialo desde \"Compartir\" en tu ficha.",
    });
  }

  let html;
  let resolvedUrl = url;
  let httpStatus = null;
  try {
    const result = await fetchMapsPage(url);
    html = result.html;
    resolvedUrl = result.resolvedUrl;
    httpStatus = result.status;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    console.error("[audit][fetch-error]", message);
    return jsonResponse(502, {
      error:
        "No pudimos abrir tu ficha de Google Maps en este intento. Puede ser un bloqueo temporal de Google o un problema de red — probá de nuevo en un rato.",
      detail: message,
      debug: DEBUG_MODE ? { httpStatus: null, htmlLength: 0, htmlHead500: "", fetchError: message, points: [] } : undefined,
    });
  }

  const blocked = looksBlocked(html);
  const trimmedHtml = html.slice(0, MAX_HTML_LENGTH);

  if (blocked) {
    return jsonResponse(502, {
      error:
        "Google bloqueó la lectura automática de tu ficha en este intento (pasa a veces al leer la página pública sin API oficial). Probá de nuevo en unos minutos.",
      debug: DEBUG_MODE
        ? {
            httpStatus,
            htmlLength: html.length,
            htmlHead500: trimmedHtml.slice(0, 500),
            looksBlocked: true,
            points: [],
          }
        : undefined,
    });
  }

  const ctx = buildContext(trimmedHtml);
  const checks = {};
  const debugPoints = [];

  CHECK_DEFINITIONS.forEach((def) => {
    const found = safe(() => def.ok(ctx));
    checks[def.id] = found;
    if (DEBUG_MODE) {
      let detail;
      try {
        detail = def.detail(ctx);
      } catch (err) {
        detail = "(no se pudo generar el detalle: " + String(err && err.message ? err.message : err) + ")";
      }
      debugPoints.push({ id: def.id, title: def.title, found, detail });
    }
  });

  const responseBody = { resolvedUrl, checks };

  if (DEBUG_MODE) {
    responseBody.debug = {
      httpStatus,
      htmlLength: html.length,
      htmlHead500: trimmedHtml.slice(0, 500),
      looksBlocked: false,
      points: debugPoints,
    };
  }

  return jsonResponse(200, responseBody);
};

// ---------------------------------------------------------------
// Descarga de la página
// ---------------------------------------------------------------

async function fetchMapsPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(addLangParam(url), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "es-419,es;q=0.9,en;q=0.5",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const html = await response.text();

    if (!response.ok) {
      throw new Error("Google respondió con estado " + response.status + " — cuerpo: " + html.slice(0, 300));
    }

    return { html, resolvedUrl: response.url || url, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function addLangParam(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("hl")) u.searchParams.set("hl", "es");
    return u.toString();
  } catch {
    return url;
  }
}

function looksBlocked(html) {
  if (!html || html.length < 2000) return true;
  return /(unusual traffic|antes de continuar|consent\.google\.com)/i.test(html);
}

// ---------------------------------------------------------------
// Calcula, una sola vez por auditoría, todos los valores crudos que
// usan las definiciones de CHECK_DEFINITIONS (tanto para decidir
// ok/falta como para explicar el detalle en el modo debug).
// ---------------------------------------------------------------
function buildContext(html) {
  const ogDescription = matchFirst(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i);
  const urls = html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'\\<>]*/gi) || [];
  const externalUrls = urls.filter((u) => !GOOGLE_OWNED_DOMAIN.test(u));
  const reviewCountMatch = matchFirst(html, /([\d.,]+)\s*(?:reseñas|reviews|opiniones)/i);
  const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch.replace(/[.,]/g, ""), 10) : null;

  return {
    ogDescription,
    photoUrlCount: countMatches(html, /https:\/\/lh\d\.googleusercontent\.com\/p\/[^\s"'\\<>]+/g),
    timeRangeCount: countMatches(html, /\b\d{1,2}[:.]\d{2}\s?(?:a|-|–)\s?\d{1,2}[:.]\d{2}\b/g),
    hasHorarioLabel: /Horario de atención/i.test(html),
    externalUrls,
    hasSitioWebLabel: /Sitio web|Website/i.test(html),
    hasWhatsappMention: /wa\.me\/|whatsapp/i.test(html),
    hasLocalPostMarker: /"LocalPost"|Actualizaciones recientes/i.test(html),
    hasServiciosLabel: /Servicios ofrecidos|Lista de productos|Productos destacados/i.test(html),
    categoryIdCount: countMatches(html, /"category_id"/g),
    hasAreaServicioLabel: /Área de servicio|Service area/i.test(html),
    attributeHits: ATTRIBUTE_KEYWORDS.filter((kw) => html.includes(kw)),
    hasPreguntasLabel: /Preguntas y respuestas/i.test(html),
    hasRespuestaDeLabel: /Respuesta de/i.test(html),
    reviewCountMatch,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
  };
}

function safe(fn) {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
}

function matchFirst(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : "";
}

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
