"use strict";

/**
 * Netlify Function: auditoría real de una ficha de Google Maps
 * -----------------------------------------------------------------
 * Se llama vía POST /api/audit (redirect definido en netlify.toml
 * hacia /.netlify/functions/audit) con body { url }.
 *
 * Trae el HTML público de esa ficha —sin login, sin API oficial de
 * Google— y aplica heurísticas de texto para estimar cada punto del
 * checklist. Devuelve { resolvedUrl, checks: { <id>: boolean, ... } },
 * usando los mismos "id" que CHECKLIST_DEFINITION en script.js.
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

const ALLOWED_URL_PATTERN =
  /^https?:\/\/(www\.)?(google\.[a-z.]{2,10}\/maps\/|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)/i;

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_LENGTH = 3_000_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  try {
    const result = await fetchMapsPage(url);
    html = result.html;
    resolvedUrl = result.resolvedUrl;
  } catch (err) {
    return jsonResponse(502, {
      error:
        "No pudimos abrir tu ficha de Google Maps en este intento. Puede ser un bloqueo temporal de Google o un problema de red — probá de nuevo en un rato.",
      detail: String(err && err.message ? err.message : err),
    });
  }

  if (looksBlocked(html)) {
    return jsonResponse(502, {
      error:
        "Google bloqueó la lectura automática de tu ficha en este intento (pasa a veces al leer la página pública sin API oficial). Probá de nuevo en unos minutos.",
    });
  }

  const checks = extractChecks(html.slice(0, MAX_HTML_LENGTH));

  return jsonResponse(200, { resolvedUrl, checks });
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

    if (!response.ok) {
      throw new Error("Google respondió con estado " + response.status);
    }

    const html = await response.text();
    return { html, resolvedUrl: response.url || url };
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
// Extracción de cada punto del checklist a partir del HTML público.
// Cada extractor está protegido con safe(): si uno falla, no tira
// abajo el resto del análisis, simplemente queda en "falta".
// ---------------------------------------------------------------

function extractChecks(html) {
  const ogDescription = matchFirst(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i);
  const photoUrlCount = countMatches(html, /https:\/\/lh\d\.googleusercontent\.com\/p\/[^\s"'\\<>]+/g);
  const timeRangeCount = countMatches(html, /\b\d{1,2}[:.]\d{2}\s?(?:a|-|–)\s?\d{1,2}[:.]\d{2}\b/g);
  const reviewCountMatch = matchFirst(html, /([\d.,]+)\s*(?:reseñas|reviews|opiniones)/i);

  const attributeKeywords = [
    "Accesible en silla de ruedas",
    "Entrada accesible",
    "Retiro en el local",
    "Entrega a domicilio",
    "Para llevar",
    "Delivery",
  ];
  const attributeHits = attributeKeywords.filter((kw) => html.includes(kw)).length;

  return {
    fotos: safe(() => photoUrlCount >= 20),
    horarios: safe(() => timeRangeCount >= 3 || /Horario de atención/i.test(html)),
    categoria: safe(() => ogDescription.length > 0),
    web: safe(() => hasExternalWebsite(html)),
    whatsapp: safe(() => /wa\.me\/|whatsapp/i.test(html)),
    publicaciones: safe(() => /"LocalPost"|Actualizaciones recientes/i.test(html)),
    descripcion: safe(() => ogDescription.length >= 60),
    servicios: safe(() => /Servicios ofrecidos|Lista de productos|Productos destacados/i.test(html)),
    "categorias-secundarias": safe(() => countMatches(html, /"category_id"/g) > 1),
    "area-servicio": safe(() => /Área de servicio|Service area/i.test(html)),
    atributos: safe(() => attributeHits >= 2),
    "preguntas-respuestas": safe(() => /Preguntas y respuestas/i.test(html) && /Respuesta de/i.test(html)),
    resenas: safe(() => {
      if (!reviewCountMatch) return false;
      const n = parseInt(reviewCountMatch.replace(/[.,]/g, ""), 10);
      return Number.isFinite(n) && n >= 5;
    }),
  };
}

function hasExternalWebsite(html) {
  const urls = html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'\\<>]*/gi) || [];
  const googleOwnedDomain =
    /(google\.|gstatic\.|ggpht\.|googleusercontent\.|goo\.gl|schema\.org|w3\.org|googleapis\.|gmail\.|youtube\.|apple\.com|play\.google)/i;
  const external = urls.filter((u) => !googleOwnedDomain.test(u));
  return external.length > 0 && /Sitio web|Website/i.test(html);
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
