"use strict";

/**
 * Netlify Function: auditoría real de una ficha de Google Maps
 * -----------------------------------------------------------------
 * Se llama vía POST /api/audit (redirect definido en netlify.toml
 * hacia /.netlify/functions/audit) con body { url }.
 *
 * HISTORIAL: la primera versión de esto traía el HTML público de la
 * ficha y buscaba patrones de texto (og:description, "Horario de
 * atención", etc.). Con una ficha real esa versión no encontró NADA
 * — confirmamos con el HTML real que Google Maps no manda ese
 * contenido como texto plano en la carga inicial, sino adentro de un
 * bloque de datos interno (APP_INITIALIZATION_STATE) pensado para
 * que lo parsee el JS del propio Google, no para que lo lea un
 * tercero. Scrapear eso de forma confiable requeriría un navegador
 * headless (Puppeteer), que no entra en el límite de tiempo de las
 * Netlify Functions gratuitas para una sola ficha.
 *
 * VERSIÓN ACTUAL: usa SerpApi (https://serpapi.com), un servicio de
 * terceros que ya resolvió ese problema y expone los datos de una
 * ficha de Google Maps como JSON estructurado en una sola llamada
 * HTTP síncrona — encaja bien con el límite de tiempo de Netlify.
 * Hace falta una cuenta gratis en serpapi.com y cargar la API key
 * como variable de entorno SERPAPI_KEY en Netlify (Site settings →
 * Environment variables). El nivel gratis alcanza para auditar
 * fichas de a una (no para picos de miles).
 *
 * Devuelve { resolvedUrl, checks: { <id>: boolean, ... }, debug }
 * usando los mismos "id" que CHECKLIST_DEFINITION en script.js.
 *
 * QUÉ TAN CONFIABLE ES CADA PUNTO CON SERPAPI (a diferencia del
 * scraping directo, acá SÍ es JSON estructurado y documentado, pero
 * ojo: no todos los campos existen para todos los rubros de negocio):
 *
 *   - Categoría, categorías secundarias, sitio web, descripción,
 *     horarios y reseñas: vienen directo de campos de la API
 *     (type/types, website, description, hours, reviews). Son los
 *     más confiables.
 *   - Atributos (delivery / retiro en el local / etc.): vienen de
 *     `service_options`, que Google solo carga para ciertos rubros
 *     (gastronomía, sobre todo). Para un electricista o un plomero,
 *     por ejemplo, puede no venir y el punto va a marcar "falta"
 *     aunque no aplique realmente.
 *   - Fotos: solo podemos confirmar "¿hay al menos una foto de
 *     portada?" (campo `thumbnail`). Cantidad real y si están
 *     actualizadas NO se puede saber sin una llamada aparte (y paga)
 *     a la API de fotos de SerpApi.
 *   - WhatsApp, publicaciones (posts), área de servicio y preguntas
 *     y respuestas: SerpApi no expone estos datos en la respuesta
 *     básica de Google Maps (en el caso de WhatsApp, ademas, ni
 *     siquiera es un campo público real de Maps). Van a marcar
 *     "falta" casi siempre — limitación conocida, no un bug.
 *
 * El campo `debug` es TEMPORAL, para calibrar estos mapeos contra
 * datos reales sin tener que ir a buscar logs. Se puede apagar
 * cambiando DEBUG_MODE a false más abajo.
 */

const DEBUG_MODE = true;

const ALLOWED_URL_PATTERN =
  /^https?:\/\/(www\.)?(google\.[a-z.]{2,10}\/maps\/|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)/i;

const FETCH_TIMEOUT_MS = 9000;
const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Errores "esperables" (config faltante, link no identificable, etc.)
// que queremos mostrar tal cual al usuario, sin genérico "502".
class UserError extends Error {}

// ---------------------------------------------------------------
// Definición única de los 13 puntos: cada uno sabe evaluarse (ok) y
// explicar en criollo qué campo miró y qué encontró (detail), a
// partir de un mismo `ctx` armado una sola vez por auditoría.
// ---------------------------------------------------------------
const CHECK_DEFINITIONS = [
  {
    id: "fotos",
    title: "Fotos actualizadas",
    ok: (ctx) => Boolean(ctx.thumbnail),
    detail: (ctx) =>
      `Miramos si la ficha tiene foto de portada (\`thumbnail\`). ${ctx.thumbnail ? "Sí tiene." : "No vino ninguna."} Ojo: con esto no podemos confirmar cuántas fotos hay ni si están actualizadas, solo si hay al menos una.`,
  },
  {
    id: "horarios",
    title: "Horarios completos",
    ok: (ctx) => ctx.hoursDayCount >= 5,
    detail: (ctx) =>
      `Contamos cuántos días tienen horario cargado en el campo \`hours\`. Encontrados: ${ctx.hoursDayCount} de 7 días (hace falta 5 o más).`,
  },
  {
    id: "categoria",
    title: "Categoría correcta",
    ok: (ctx) => Boolean(ctx.primaryType),
    detail: (ctx) =>
      `Categoría principal que devuelve la API: ${ctx.primaryType ? `"${ctx.primaryType}"` : "(no vino ninguna)"}.`,
  },
  {
    id: "web",
    title: "Web cargada",
    ok: (ctx) => Boolean(ctx.website),
    detail: (ctx) => `Campo \`website\`: ${ctx.website ? ctx.website : "(vacío)"}.`,
  },
  {
    id: "whatsapp",
    title: "WhatsApp cargado",
    ok: (ctx) => ctx.website.includes("wa.me") || ctx.website.includes("whatsapp"),
    detail: () =>
      `Buscamos "wa.me" o "whatsapp" dentro del campo \`website\`. Google Maps no tiene un campo público de WhatsApp propiamente dicho, así que este punto casi siempre va a dar "falta" aunque el negocio sí tenga WhatsApp.`,
  },
  {
    id: "publicaciones",
    title: "Publicaciones activas",
    ok: () => false,
    detail: () => `SerpApi no expone publicaciones (posts) en la respuesta básica de Google Maps. No podemos verificar este punto con el proveedor actual.`,
  },
  {
    id: "descripcion",
    title: "Descripción del negocio completa",
    ok: (ctx) => ctx.description.length >= 60,
    detail: (ctx) => `Campo \`description\`, largo: ${ctx.description.length} caracteres (hace falta 60 o más).`,
  },
  {
    id: "servicios",
    title: "Servicios o productos cargados",
    ok: (ctx) => ctx.hasMenuOrProducts,
    detail: (ctx) =>
      `Buscamos un menú o lista de productos en la respuesta (\`menu\`/\`products\`). ${ctx.hasMenuOrProducts ? "Encontramos algo cargado." : "No vino nada."} Este dato no está disponible para todos los rubros.`,
  },
  {
    id: "categorias-secundarias",
    title: "Categorías secundarias",
    ok: (ctx) => ctx.types.length > 1,
    detail: (ctx) =>
      `Campo \`types\` (todas las categorías): ${ctx.types.length ? ctx.types.join(", ") : "(vacío)"} — ${ctx.types.length} en total (hace falta más de 1).`,
  },
  {
    id: "area-servicio",
    title: "Área de servicio configurada",
    ok: (ctx) => ctx.hasServiceArea,
    detail: () => `SerpApi no expone directamente si hay un "área de servicio" configurada. Best-effort: casi siempre va a dar "falta".`,
  },
  {
    id: "atributos",
    title: "Atributos del negocio completos",
    ok: (ctx) => ctx.serviceOptionHits.length >= 2,
    detail: (ctx) =>
      `Campo \`service_options\` (delivery / para llevar / servir en el local, etc.). Activos: ${ctx.serviceOptionHits.length ? ctx.serviceOptionHits.join(", ") : "ninguno"}. Google solo carga este campo para algunos rubros (gastronomía sobre todo) — para otros rubros puede no aplicar.`,
  },
  {
    id: "preguntas-respuestas",
    title: "Preguntas y respuestas",
    ok: () => false,
    detail: () => `SerpApi no expone preguntas y respuestas en la respuesta básica de Google Maps. No podemos verificar este punto con el proveedor actual.`,
  },
  {
    id: "resenas",
    title: "Reseñas",
    ok: (ctx) => ctx.reviews !== null && ctx.reviews >= 5,
    detail: (ctx) =>
      `Campo \`reviews\`: ${ctx.reviews !== null ? ctx.reviews : "(no vino)"} (hace falta 5 o más). No podemos verificar automáticamente si el negocio responde a las reseñas.`,
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

  try {
    const identifiers = await resolvePlaceIdentifiers(url);
    const serpApiResponse = await querySerpApi(identifiers);
    const place = extractPlace(serpApiResponse);

    if (!place) {
      throw new UserError("No encontramos la ficha con ese link. Probá copiarlo de nuevo desde \"Compartir\" en Google Maps.");
    }

    const ctx = buildContext(place);
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

    const responseBody = { resolvedUrl: identifiers.resolvedUrl, checks };

    if (DEBUG_MODE) {
      responseBody.debug = {
        provider: "serpapi",
        dataId: identifiers.dataId,
        query: identifiers.query,
        placeJson: safeJsonPreview(place, 20000),
        points: debugPoints,
      };
    }

    return jsonResponse(200, responseBody);
  } catch (err) {
    if (err instanceof UserError) {
      return jsonResponse(400, { error: err.message });
    }
    console.error("[audit][error]", err);
    return jsonResponse(502, {
      error:
        "No pudimos analizar tu ficha en este intento. Puede ser un problema temporal del servicio de lectura — probá de nuevo en un rato.",
      detail: String(err && err.message ? err.message : err),
    });
  }
};

// ---------------------------------------------------------------
// Paso 1: identificar la ficha a partir del link pegado por el
// usuario (sin todavía consultar a SerpApi).
// ---------------------------------------------------------------

async function resolvePlaceIdentifiers(url) {
  let workingUrl = url;
  let resolvedUrl = url;

  // Los links cortos (maps.app.goo.gl, goo.gl/maps) hay que
  // resolverlos primero para llegar a la URL completa con los datos
  // de la ficha adentro.
  const isShortLink = /maps\.app\.goo\.gl|goo\.gl\/maps/i.test(url);
  if (isShortLink) {
    resolvedUrl = await resolveRedirect(url);
    workingUrl = resolvedUrl;
  }

  // El "CID" de Google (data_id para SerpApi) suele venir en la URL
  // como !1s0x...:0x... — si está, es la forma más confiable de
  // identificar la ficha exacta.
  const dataId = matchFirst(workingUrl, /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);

  // Fallback: nombre del negocio + coordenadas, para hacer una
  // búsqueda si no encontramos el data_id.
  const coordsMatch = workingUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const nameMatch = workingUrl.match(/\/maps\/place\/([^/@?]+)/i);
  let query = null;
  if (nameMatch) {
    try {
      query = decodeURIComponent(nameMatch[1].replace(/\+/g, " "));
    } catch {
      query = nameMatch[1].replace(/\+/g, " ");
    }
  }

  return {
    resolvedUrl,
    dataId: dataId || null,
    lat: coordsMatch ? coordsMatch[1] : null,
    lng: coordsMatch ? coordsMatch[2] : null,
    query,
  };
}

async function resolveRedirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA },
    });
    return response.url || url;
  } catch {
    // Algunos servidores no soportan HEAD bien — reintentamos con GET.
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_UA },
      });
      return response.url || url;
    } catch (err) {
      throw new UserError(
        "No pudimos abrir ese link corto de Google Maps. Probá pegar el link completo (abrilo en el navegador y copiá la URL de la barra de direcciones)."
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------
// Paso 2: consultar SerpApi con lo que identificamos en el paso 1.
// ---------------------------------------------------------------

async function querySerpApi({ dataId, query, lat, lng }) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new UserError(
      "Falta configurar la lectura real de fichas (SERPAPI_KEY) en Netlify. Avisale a quien administra el sitio."
    );
  }

  // SerpApi exige el parámetro `q` siempre, incluso cuando también le
  // pasamos `data_id` para apuntar a la ficha exacta — mandamos los dos
  // juntos cuando los tenemos.
  if (!query && !dataId) {
    throw new UserError(
      "No pudimos identificar tu ficha a partir de ese link. Probá copiarlo de nuevo desde \"Compartir\" en Google Maps."
    );
  }

  const params = new URLSearchParams({
    engine: "google_maps",
    // type=place: pedimos la FICHA COMPLETA de un negocio puntual
    // (con website, horarios, descripción, etc.). Sin esto, SerpApi
    // devuelve por default una lista de resultados de búsqueda
    // (tarjetas resumidas, sin la mayoría de estos campos) — que es
    // lo que estaba pasando antes de este fix.
    type: "place",
    hl: "es",
    api_key: apiKey,
    q: query || "ficha de Google Maps",
  });

  if (dataId) params.set("data_id", dataId);
  if (lat && lng) params.set("ll", `@${lat},${lng},15z`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${SERPAPI_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
    const json = await response.json();
    if (json && json.error) {
      throw new UserError("El servicio de lectura de fichas devolvió un error: " + json.error);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function extractPlace(serpApiResponse) {
  if (!serpApiResponse) return null;
  if (serpApiResponse.place_results) return serpApiResponse.place_results;
  if (Array.isArray(serpApiResponse.local_results) && serpApiResponse.local_results.length > 0) {
    return serpApiResponse.local_results[0];
  }
  return null;
}

// ---------------------------------------------------------------
// Paso 3: pasar el JSON de SerpApi a los valores crudos que usan
// las definiciones de CHECK_DEFINITIONS.
// ---------------------------------------------------------------

// No pudimos confirmar en vivo los nombres exactos de campo que usa
// SerpApi (este entorno de desarrollo no tiene salida de red hacia
// serpapi.com). Para no depender de adivinar un solo nombre por dato,
// probamos varias variantes plausibles por campo — así, si el nombre
// real no es el primero que se nos ocurrió, igual lo encontramos.
function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function buildContext(place) {
  const rawTypes = firstDefined(place, ["types", "categories"]);
  const rawType = firstDefined(place, ["type", "category", "primary_type"]);
  const types = Array.isArray(rawTypes) ? rawTypes : typeof rawType === "string" ? [rawType] : [];

  const hours = firstDefined(place, ["hours", "operating_hours", "open_hours", "opening_hours"]);
  const hoursDayCount =
    hours && typeof hours === "object" && !Array.isArray(hours)
      ? Object.keys(hours).length
      : Array.isArray(hours)
      ? hours.length
      : 0;

  const serviceOptionsRaw = firstDefined(place, ["service_options", "serviceOptions"]);
  const serviceOptions = serviceOptionsRaw && typeof serviceOptionsRaw === "object" ? serviceOptionsRaw : {};
  const serviceOptionHits = Object.entries(serviceOptions)
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const reviewsRaw = firstDefined(place, ["reviews", "review_count", "user_ratings_total", "reviews_count"]);
  const reviews =
    typeof reviewsRaw === "number"
      ? reviewsRaw
      : typeof reviewsRaw === "string"
      ? parseInt(reviewsRaw.replace(/\D/g, ""), 10)
      : null;

  const websiteRaw = firstDefined(place, ["website", "link", "site"]);
  const descriptionRaw = firstDefined(place, ["description", "about", "editorial_summary"]);
  const thumbnailRaw = firstDefined(place, ["thumbnail", "photo", "image", "main_image"]);

  return {
    primaryType: typeof rawType === "string" ? rawType : types[0] || "",
    types,
    hoursDayCount,
    website: typeof websiteRaw === "string" ? websiteRaw : "",
    description: typeof descriptionRaw === "string" ? descriptionRaw : "",
    thumbnail: typeof thumbnailRaw === "string" ? thumbnailRaw : "",
    serviceOptionHits,
    hasMenuOrProducts: Boolean(place.menu || place.products),
    hasServiceArea: Boolean(place.service_area || place.serves_area),
    reviews: Number.isFinite(reviews) ? reviews : null,
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

function safeJsonPreview(obj, maxLen) {
  try {
    return JSON.stringify(obj, null, 2).slice(0, maxLen);
  } catch {
    return "(no se pudo serializar)";
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
