"use strict";

/**
 * Netlify Function: auditoría real de una ficha de Google Maps
 * -----------------------------------------------------------------
 * Se llama vía POST /api/audit (redirect definido en netlify.toml
 * hacia /.netlify/functions/audit) con body { url }.
 *
 * Fuente de datos, en orden de preferencia:
 *
 *   1) SerpApi (engine=google_maps, hl=es) — si hay `SERPAPI_KEY`
 *      configurada como variable de entorno del sitio en Netlify Y
 *      se pudo extraer un identificador de lugar (data_id + coords,
 *      o place_id) del link de Maps que pegó el usuario. Parseamos
 *      `place_results` tal cual lo documenta SerpApi (ver comentario
 *      arriba de buildContextFromSerpApi) — esta es la fuente
 *      confiable: no depende de que Google no nos bloquee ni de que
 *      el HTML público tenga tal o cual patrón de texto.
 *
 *   2) HTML público de la ficha (fallback) — si no hay SERPAPI_KEY,
 *      no se pudo identificar el lugar, o la llamada a SerpApi
 *      falla (rate limit, key inválida, etc.). Es el comportamiento
 *      original: traemos el HTML sin login/API oficial y aplicamos
 *      heurísticas de texto. Sigue siendo frágil por lo que ya
 *      estaba documentado acá (ver LIMITACIONES más abajo).
 *
 * Devuelve { resolvedUrl, checks: { <id>: boolean, ... }, debug: {...} },
 * usando los mismos "id" que CHECKLIST_DEFINITION en script.js.
 *
 * El campo `debug` es TEMPORAL, para diagnosticar en pantalla (sección
 * "Ver detalle técnico" en el resultado) por qué cada punto da ok/falta
 * sin tener que ir a buscar los logs de Netlify. Sacarlo (y el bloque
 * de <details> correspondiente en el frontend) una vez resuelto el
 * diagnóstico — ver DEBUG_MODE más abajo. `debug.dataSource` dice
 * "serpapi" o "html" según qué camino se usó en cada auditoría — es
 * el primer dato a mirar para confirmar que SERPAPI_KEY está andando.
 *
 * LIMITACIONES CONOCIDAS QUE SIGUEN IGUAL AUNQUE HAYA SERPAPI:
 * `place_results` de SerpApi (ver ejemplo de la documentación) NO
 * trae WhatsApp, publicaciones (posts), área de servicio ni preguntas
 * y respuestas — Google Maps no expone esos datos como campos
 * públicos de la API tampoco. Esos 4 puntos del checklist quedan
 * "débiles" (casi siempre van a marcar "falta") sea cual sea la
 * fuente de datos. El resto de las limitaciones del modo HTML (fotos,
 * horarios y atributos como best-effort) están documentadas en los
 * comentarios de buildContext() más abajo.
 */

// TEMP: mientras se diagnostica en producción, mandamos el detalle
// técnico (incluida qué fuente de datos se usó) al frontend. Poner en
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

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

// ---------------------------------------------------------------
// Definición única de los 13 puntos: cada uno sabe cómo evaluarse
// (ok) y cómo explicar en criollo qué buscó y qué encontró (detail),
// a partir del mismo `ctx` calculado una sola vez por auditoría.
// `ctx.source` es "serpapi" o "html" — varios checks evalúan distinto
// según de dónde salió el dato, porque el campo disponible no es el
// mismo (ver buildContextFromSerpApi vs buildContext). Así evitamos
// mantener la misma lógica escrita dos veces en paralelo (una para el
// resultado real y otra para el debug) y que se desincronicen.
// ---------------------------------------------------------------
const CHECK_DEFINITIONS = [
  {
    id: "fotos",
    title: "Fotos actualizadas",
    ok: (ctx) =>
      ctx.source === "serpapi" ? ctx.imagesCategoryCount >= 4 : ctx.photoUrlCount >= 20,
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.images trae ${ctx.imagesCategoryCount} categorías de fotos (Todas/Interior/Menú/etc.). Ojo: SerpApi no da la cantidad exacta de fotos en esta llamada — eso requeriría una llamada aparte a photos_link (engine=google_maps_photos, cuesta créditos extra). Usamos la cantidad de categorías como proxy; hacen falta 4 o más para marcar "bien".`
        : `Buscamos URLs de fotos con el patrón "lh#.googleusercontent.com/p/...". Encontradas: ${ctx.photoUrlCount} (hace falta 20 o más para marcar "bien").`,
  },
  {
    id: "horarios",
    title: "Horarios completos",
    ok: (ctx) =>
      ctx.source === "serpapi" ? ctx.hoursCount >= 6 : (ctx.timeRangeCount >= 3 || ctx.hasHorarioLabel),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.hours trae horario cargado para ${ctx.hoursCount} de 7 días (hace falta 6 o más).`
        : `Buscamos 3 o más rangos horarios tipo "08:00-20:00" (encontrados: ${ctx.timeRangeCount}) o el texto "Horario de atención" (${ctx.hasHorarioLabel ? "SÍ aparece" : "NO aparece"}).`,
  },
  {
    id: "categoria",
    title: "Categoría correcta",
    ok: (ctx) => (ctx.source === "serpapi" ? ctx.typeCount >= 1 : ctx.ogDescription.length > 0),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.type: ${ctx.types.length ? ctx.types.join(", ") : "(vacío)"}.`
        : `Buscamos el meta tag <meta property="og:description">. Contenido encontrado: ${ctx.ogDescription ? `"${ctx.ogDescription}"` : "(vacío / no se encontró el meta tag)"}.`,
  },
  {
    id: "web",
    title: "Web cargada",
    ok: (ctx) =>
      ctx.source === "serpapi" ? ctx.hasWebsite : (ctx.externalUrls.length > 0 && ctx.hasSitioWebLabel),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.website: ${ctx.website || "(no viene en la respuesta)"}.`
        : `Buscamos el texto "Sitio web"/"Website" (${ctx.hasSitioWebLabel ? "SÍ aparece" : "NO aparece"}) y URLs externas a Google. Encontradas: ${ctx.externalUrls.length}${ctx.externalUrls.length ? ` (ej. ${ctx.externalUrls[0]})` : ""}.`,
  },
  {
    id: "whatsapp",
    title: "WhatsApp cargado",
    ok: (ctx) => (ctx.source === "serpapi" ? false : ctx.hasWhatsappMention),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results no trae ningún campo de WhatsApp — Google Maps no lo expone como dato público de la API tampoco. No se puede verificar automáticamente.`
        : `Buscamos "wa.me/" o la palabra "whatsapp" en el HTML. ${ctx.hasWhatsappMention ? "SÍ aparece" : "NO aparece"}. Ojo: Maps no suele exponer esto como campo público, así que este punto casi siempre da "falta" aunque el negocio sí tenga WhatsApp.`,
  },
  {
    id: "publicaciones",
    title: "Publicaciones activas",
    ok: (ctx) => (ctx.source === "serpapi" ? false : ctx.hasLocalPostMarker),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results no trae publicaciones (posts) — no es un campo que devuelva engine=google_maps. No se puede verificar automáticamente.`
        : `Buscamos el marcador interno "LocalPost" o el texto "Actualizaciones recientes". ${ctx.hasLocalPostMarker ? "SÍ aparece" : "NO aparece"}. Los posts se cargan con JavaScript después de la carga inicial, así que rara vez están en este HTML.`,
  },
  {
    id: "descripcion",
    title: "Descripción del negocio completa",
    ok: (ctx) => (ctx.source === "serpapi" ? ctx.descriptionLength >= 60 : ctx.ogDescription.length >= 60),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.description, ${ctx.descriptionLength} caracteres: ${ctx.description ? `"${ctx.description}"` : "(vacío)"}.`
        : `Mismo meta tag og:description que "Categoría", pero exigiendo 60 caracteres o más. Largo encontrado: ${ctx.ogDescription.length} caracteres.`,
  },
  {
    id: "servicios",
    title: "Servicios o productos cargados",
    ok: (ctx) =>
      ctx.source === "serpapi" ? (ctx.hasMenu || ctx.serviceOptionsOnCount > 0) : ctx.hasServiciosLabel,
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.menu: ${ctx.hasMenu ? "SÍ" : "NO"}. service_options activos: ${ctx.serviceOptionsOnCount} (dine_in/takeout/delivery).`
        : `Buscamos los textos "Servicios ofrecidos", "Lista de productos" o "Productos destacados". ${ctx.hasServiciosLabel ? "SÍ aparece alguno" : "NO aparece ninguno"}. Esta sección suele cargarse con JavaScript.`,
  },
  {
    id: "categorias-secundarias",
    title: "Categorías secundarias",
    ok: (ctx) => (ctx.source === "serpapi" ? ctx.typeCount > 1 : ctx.categoryIdCount > 1),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.type trae ${ctx.typeCount} categorías (hace falta más de 1): ${ctx.types.join(", ") || "(ninguna)"}.`
        : `Contamos apariciones de "category_id" en el HTML (proxy indirecto, no es un dato público mostrado tal cual). Encontradas: ${ctx.categoryIdCount} (hace falta más de 1).`,
  },
  {
    id: "area-servicio",
    title: "Área de servicio configurada",
    ok: (ctx) => (ctx.source === "serpapi" ? false : ctx.hasAreaServicioLabel),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results no trae ningún campo de área de servicio. No se puede verificar automáticamente.`
        : `Buscamos el texto "Área de servicio" / "Service area". ${ctx.hasAreaServicioLabel ? "SÍ aparece" : "NO aparece"}.`,
  },
  {
    id: "atributos",
    title: "Atributos del negocio completos",
    ok: (ctx) => (ctx.source === "serpapi" ? ctx.attributeHits.length >= 3 : ctx.attributeHits.length >= 2),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.extensions trae ${ctx.attributeHits.length} atributos (accesibilidad, popular_for, highlights, etc.): ${ctx.attributeHits.length ? ctx.attributeHits.join(", ") : "ninguno"}. Hacen falta 3 o más.`
        : `Buscamos estas frases exactas: ${ATTRIBUTE_KEYWORDS.map((k) => `"${k}"`).join(", ")}. Encontradas (${ctx.attributeHits.length}): ${ctx.attributeHits.length ? ctx.attributeHits.join(", ") : "ninguna"}. Hacen falta 2 o más.`,
  },
  {
    id: "preguntas-respuestas",
    title: "Preguntas y respuestas",
    ok: (ctx) => (ctx.source === "serpapi" ? false : ctx.hasPreguntasLabel && ctx.hasRespuestaDeLabel),
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results no trae preguntas y respuestas — no es un campo que devuelva engine=google_maps. No se puede verificar automáticamente.`
        : `Buscamos el texto "Preguntas y respuestas" (${ctx.hasPreguntasLabel ? "SÍ aparece" : "NO aparece"}) y "Respuesta de" (${ctx.hasRespuestaDeLabel ? "SÍ aparece" : "NO aparece"}). Esta sección se carga con JavaScript, casi nunca está en el HTML inicial.`,
  },
  {
    id: "resenas",
    title: "Reseñas",
    ok: (ctx) => ctx.reviewCount !== null && ctx.reviewCount >= 5,
    detail: (ctx) =>
      ctx.source === "serpapi"
        ? `(Vía SerpApi) place_results.reviews: ${ctx.reviewCount !== null ? ctx.reviewCount : "(no viene)"}, place_results.rating: ${ctx.rating !== null ? ctx.rating : "(no viene)"} (hace falta 5 reseñas o más).`
        : `Buscamos un número seguido de "reseñas"/"reviews"/"opiniones". Encontrado: ${ctx.reviewCountMatch ? `"${ctx.reviewCountMatch}"` : "(no se encontró)"} → ${ctx.reviewCount !== null ? ctx.reviewCount : "sin número"} (hace falta 5 o más).`,
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
      debug: DEBUG_MODE
        ? { httpStatus: null, htmlLength: 0, htmlHead500: "", fetchError: message, points: [] }
        : undefined,
    });
  }

  const blocked = looksBlocked(html);
  const trimmedHtml = html.slice(0, MAX_HTML_LENGTH);

  // La identificación del lugar (para SerpApi) sale de la URL final
  // después de seguir redirects, no del cuerpo del HTML — así que
  // esto puede funcionar incluso si Google nos bloqueó el HTML
  // (`blocked`), porque el redirect ya se resolvió igual.
  const identifier = extractPlaceIdentifier(resolvedUrl, html);

  let ctx = null;
  let serpApiError = null;
  const serpApiAttempted = Boolean(SERPAPI_KEY && identifier);

  if (serpApiAttempted) {
    const { placeResults, error } = await fetchSerpApiPlace(identifier, SERPAPI_KEY);
    if (placeResults) {
      ctx = buildContextFromSerpApi(placeResults);
    } else {
      serpApiError = error;
      console.error("[audit][serpapi-error]", error);
    }
  }

  if (!ctx) {
    // Fallback: si SerpApi no estaba disponible/configurada, no se
    // pudo identificar el lugar, o la llamada falló, seguimos con el
    // scraping de HTML de siempre — salvo que además Google nos haya
    // bloqueado, en cuyo caso no tenemos ningún dato confiable.
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
              dataSource: "none",
              serpApiAttempted,
              serpApiError,
              points: [],
            }
          : undefined,
      });
    }
    ctx = buildContext(trimmedHtml);
  }

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
      looksBlocked: blocked,
      dataSource: ctx.source,
      serpApiAttempted,
      serpApiError,
      points: debugPoints,
    };
  }

  return jsonResponse(200, responseBody);
};

// ---------------------------------------------------------------
// Descarga de la página (siempre se hace: da resolvedUrl, sirve para
// identificar el lugar para SerpApi, y es el fallback si SerpApi no
// está disponible)
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
// SerpApi (engine=google_maps, place_results)
// ---------------------------------------------------------------

// Google Maps mete la identidad del lugar en la propia URL: o bien un
// place_id ("ChIJ..."), o bien un data_id tipo "0x<hex>:0x<hex>"
// (segmento "!1s...") + las coordenadas ("!3d...!4d..." o "@lat,lng").
// SerpApi arma su propio ejemplo de "cómo pedir este place_results de
// nuevo" en place_id_search con exactamente ese formato
// (data=!4m5!3m4!1s<data_id>!8m2!3d<lat>!4d<lng>&engine=google_maps&type=place),
// así que lo replicamos acá para pedirlo la primera vez.
function extractPlaceIdentifier(resolvedUrl, html) {
  return extractFromText(resolvedUrl) || extractFromText(html.slice(0, 20000));
}

function extractFromText(text) {
  if (!text) return null;

  const placeIdMatch = text.match(/[?&]place_id=(ChIJ[0-9A-Za-z_-]+)/);
  if (placeIdMatch) return { placeId: placeIdMatch[1] };

  const dataIdMatch = text.match(/!1s(0x[0-9a-f]+(?:%3A|:)0x[0-9a-f]+)/i);
  const latLngMatch =
    text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);

  if (dataIdMatch && latLngMatch) {
    return {
      dataId: decodeURIComponent(dataIdMatch[1]),
      lat: latLngMatch[1],
      lng: latLngMatch[2],
    };
  }

  return null;
}

function buildSerpApiParams(identifier) {
  if (identifier.placeId) {
    return { place_id: identifier.placeId };
  }
  if (identifier.dataId) {
    return {
      type: "place",
      data: `!4m5!3m4!1s${identifier.dataId}!8m2!3d${identifier.lat}!4d${identifier.lng}`,
    };
  }
  return null;
}

async function fetchSerpApiPlace(identifier, apiKey) {
  const extraParams = buildSerpApiParams(identifier);
  if (!extraParams) return { placeResults: null, error: "No se pudo armar el pedido a SerpApi." };

  const searchParams = new URLSearchParams({
    engine: "google_maps",
    google_domain: "google.com",
    hl: "es",
    api_key: apiKey,
    ...extraParams,
  });
  const requestUrl = "https://serpapi.com/search.json?" + searchParams.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(requestUrl, { signal: controller.signal });
    const text = await response.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Respuesta no-JSON de SerpApi (status " + response.status + ")");
    }

    if (json.error) throw new Error("SerpApi: " + json.error);
    if (!response.ok) throw new Error("SerpApi respondió estado " + response.status);
    if (!json.place_results) throw new Error("SerpApi no devolvió place_results para este lugar.");

    return { placeResults: json.place_results, error: null };
  } catch (err) {
    const message = redactKey(String(err && err.message ? err.message : err), apiKey);
    return { placeResults: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

// Nunca queremos que la API key termine en un log ni en la respuesta
// (aunque sea en el mensaje de un error de red que incluya la URL
// completa) — la reemplazamos por un placeholder antes de usar el
// texto en cualquier lado.
function redactKey(text, key) {
  if (!key) return text;
  return String(text).split(key).join("«api_key»");
}

// place_results de SerpApi, campo por campo (ver ejemplo de la
// documentación oficial que compartió el usuario):
//   type              -> categoría + categorías secundarias
//   website            -> web cargada
//   description        -> descripción del negocio
//   hours              -> horarios completos
//   images             -> fotos (proxy: cantidad de categorías, NO el
//                         total real de fotos — eso pide photos_link)
//   menu / service_options -> servicios o productos
//   extensions         -> atributos (accesibilidad, popular_for, etc.)
//   rating / reviews    -> reseñas
// Campos que NO existen en place_results (confirmado contra el
// ejemplo de la documentación): WhatsApp, publicaciones (posts), área
// de servicio, preguntas y respuestas. Quedan "no disponible" pase lo
// que pase con esta fuente.
function buildContextFromSerpApi(place) {
  const types = Array.isArray(place.type) ? place.type : [];
  const description = typeof place.description === "string" ? place.description : "";
  const hours = Array.isArray(place.hours) ? place.hours : [];
  const images = Array.isArray(place.images) ? place.images : [];
  const serviceOptions =
    place.service_options && typeof place.service_options === "object" ? place.service_options : {};
  const serviceOptionsOnCount = Object.values(serviceOptions).filter(Boolean).length;

  const extensions = Array.isArray(place.extensions) ? place.extensions : [];
  const attributeHits = [];
  extensions.forEach((group) => {
    if (!group || typeof group !== "object") return;
    Object.values(group).forEach((items) => {
      if (Array.isArray(items)) attributeHits.push(...items);
    });
  });

  const reviews = typeof place.reviews === "number" ? place.reviews : null;
  const rating = typeof place.rating === "number" ? place.rating : null;

  return {
    source: "serpapi",
    title: typeof place.title === "string" ? place.title : "",
    typeCount: types.length,
    types,
    hasWebsite: Boolean(place.website),
    website: typeof place.website === "string" ? place.website : "",
    description,
    descriptionLength: description.length,
    hoursCount: hours.length,
    imagesCategoryCount: images.length,
    hasMenu: Boolean(place.menu && place.menu.link),
    serviceOptionsOnCount,
    attributeHits,
    reviewCount: Number.isFinite(reviews) ? reviews : null,
    rating,
  };
}

// ---------------------------------------------------------------
// Fallback: heurísticas de texto sobre el HTML público (ver
// LIMITACIONES CONOCIDAS al principio del archivo). Calcula, una sola
// vez por auditoría, todos los valores crudos que usan las
// definiciones de CHECK_DEFINITIONS para este modo.
// ---------------------------------------------------------------
function buildContext(html) {
  const ogDescription = matchFirst(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i);
  const urls = html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'\\<>]*/gi) || [];
  const externalUrls = urls.filter((u) => !GOOGLE_OWNED_DOMAIN.test(u));
  const reviewCountMatch = matchFirst(html, /([\d.,]+)\s*(?:reseñas|reviews|opiniones)/i);
  const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch.replace(/[.,]/g, ""), 10) : null;

  return {
    source: "html",
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
