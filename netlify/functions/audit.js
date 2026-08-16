"use strict";

/**
 * Netlify Function: auditoría real de una ficha de Google Maps
 * -----------------------------------------------------------------
 * Se llama vía POST /api/audit (redirect definido en netlify.toml
 * hacia /.netlify/functions/audit) con body { url, rubro }. `rubro` es
 * opcional: es el texto que el dueño tipea en el formulario ("cerrajería",
 * "plomería", etc.) y solo lo usa el check "categoria" (ver más abajo) —
 * sin él, ese check igual corre, pero con una verificación más débil.
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
 *   - Sitio web (una vez identificado) y reseñas: vienen directo de
 *     campos de la API (website, reviews, rating) y son los más
 *     confiables.
 *   - Categoría, categorías secundarias, horarios, descripción y
 *     atributos: vienen de campos de la API (type/types, hours,
 *     description, service_options), pero con algo de heurística
 *     propia arriba (ver el criterio de cada check más abajo) — no
 *     alcanza con que el campo "exista", miramos si dice algo bueno.
 *   - Atributos (delivery / retiro en el local / etc.): vienen de
 *     `service_options`, que Google solo carga para ciertos rubros
 *     (gastronomía, sobre todo). Para un electricista o un plomero,
 *     por ejemplo, puede no venir y el punto va a marcar "falta"
 *     aunque no aplique realmente.
 *   - WhatsApp, publicaciones (posts), área de servicio, preguntas y
 *     respuestas, y fotos: se sacaron del checklist. SerpApi no
 *     expone estos datos en la respuesta básica de Google Maps (en
 *     el caso de WhatsApp, además, ni siquiera es un campo público
 *     real de Maps; en el de fotos, el único campo disponible es
 *     `thumbnail` — sí/no hay foto de portada, sin fecha ni cantidad,
 *     así que no se puede evaluar "actualizadas"). Auditarlos daba
 *     "falta" casi siempre, tuviera o no la ficha eso resuelto — no
 *     era una auditoría real, era ruido. Se reincorporan si en algún
 *     momento se paga la llamada aparte a la API de fotos de SerpApi
 *     o se suma otra fuente de datos para el resto.
 *
 * Dos checks hacen trabajo extra sobre lo que devuelve SerpApi:
 *   - "categoria" no se conforma con que `type` no esté vacío: marca
 *     mal si es una categoría "cajón de sastre" que Google usa cuando
 *     nadie configuró una específica, y si el usuario declaró su
 *     rubro en el formulario, exige que la categoría coincida
 *     razonablemente con ese rubro (ver GENERIC_CATEGORY_NAMES y
 *     rubroMatchesCategory).
 *   - "web" no se conforma con que `website` no esté vacío: le hace
 *     un fetch aparte para confirmar que responde. Esto agrega
 *     latencia (hasta WEBSITE_FETCH_TIMEOUT_MS) y puede dar falso
 *     negativo si ese sitio bloquea peticiones automáticas — un
 *     trade-off aceptado a propósito (ver checkWebsiteReachable).
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
const MAX_RUBRO_LENGTH = 80;

// Timeout para el fetch aparte que hace el check "web" contra el sitio del
// negocio (no contra SerpApi/Google). Corto a propósito: si el sitio tarda
// más que esto en responder, lo tratamos igual que si no respondiera — ver
// checkWebsiteReachable más abajo.
const WEBSITE_FETCH_TIMEOUT_MS = 4500;

// Errores "esperables" (config faltante, link no identificable, etc.)
// que queremos mostrar tal cual al usuario, sin genérico "502".
class UserError extends Error {}

// Rubros donde "abierto las 24 horas" es un dato real y esperable, no un
// horario mal cargado. Fuera de esta lista, 24hs se trata como señal
// sospechosa (ver check "horarios" más abajo).
const EMERGENCY_RUBRO_PATTERNS = [
  /cerrajer/i,
  /gr[uú]a/i,
  /auxilio mec[aá]nico/i,
  /plomer[oía]{0,2}.{0,15}urgencia|plomer[oa].{0,5}24/i,
  /electricista.{0,15}urgencia|electricista.{0,5}24/i,
  /farmacia.{0,15}turno/i,
  /gomer[ií]a/i,
  /ambulancia/i,
  /emergencias? m[eé]dicas?/i,
  /veterinaria.{0,15}urgencia/i,
  /\bhotel(es)?\b/i,
  /seguridad|vigilancia/i,
  /locksmith/i,
  /towing/i,
];

// Frases que indican que la ficha figura abierta las 24 horas. Se buscan
// dentro de un volcado en texto de lo que venga en `hours` (no sabemos el
// formato exacto que usa SerpApi para cada rubro, así que en vez de asumir
// una forma fija convertimos a texto y buscamos el patrón — best-effort).
const OPEN_24H_PATTERNS = [
  /abiert[oa].{0,20}24\s?(horas|hs)/i,
  /atenci[oó]n.{0,20}24\s?(horas|hs)/i,
  /24\s?(horas|hs).{0,20}(al d[ií]a|los 7 d[ií]as|todos los d[ií]as)/i,
  /24\/7/,
  /open 24 hours/i,
];

// Categorías "cajón de sastre" que Google le pone a una ficha cuando el
// dueño nunca configuró una categoría específica. Si `type` es una de
// estas, tratamos la ficha como si tuviera la categoría mal cargada,
// aunque técnicamente "haya algo cargado". Comparación siempre contra
// texto normalizado (ver normalizeText).
const GENERIC_CATEGORY_NAMES = [
  "punto de interes",
  "establecimiento",
  "negocio local",
  "point of interest",
  "negocio",
  "tienda",
  "lugar",
  "place",
  "establishment",
];

// Palabras muy comunes en español que no aportan nada al detectar
// "relleno de palabras clave" en una descripción — las ignoramos al buscar
// una palabra sospechosamente repetida (ver detectDescriptionSpam).
const SPAM_STOPWORDS = new Set([
  "para",
  "con",
  "los",
  "las",
  "del",
  "una",
  "uno",
  "unos",
  "unas",
  "mas",
  "que",
  "por",
  "este",
  "esta",
  "estos",
  "estas",
  "son",
  "fue",
  "ser",
  "estar",
  "tiene",
  "tienen",
  "todo",
  "toda",
  "todos",
  "todas",
  "somos",
  "como",
  "donde",
  "cuando",
  "desde",
  "hasta",
  "entre",
  "sobre",
  "tambien",
  "nuestra",
  "nuestro",
  "nuestros",
  "nuestras",
]);

// ---------------------------------------------------------------
// Definición única de los puntos que se auditan: cada uno sabe evaluarse
// (ok) y explicar en criollo qué campo miró y qué encontró (detail), a
// partir de un mismo `ctx` armado una sola vez por auditoría.
// ---------------------------------------------------------------
const CHECK_DEFINITIONS = [
  {
    id: "horarios",
    title: "Horarios completos",
    // Si la ficha figura abierta las 24 horas y el rubro no es de los que
    // realmente funcionan así (emergencias, hotelería, etc.), es casi
    // siempre un horario mal cargado, no disponibilidad real — lo marcamos
    // mal directamente, sin mirar el resto de las señales de "horario
    // completo".
    ok: (ctx) => {
      if (ctx.hasOpen24h && !ctx.isEmergencyRubro) return false;
      return ctx.hoursDayCount >= 5;
    },
    detail: (ctx) => {
      if (ctx.hasOpen24h && !ctx.isEmergencyRubro) {
        return `Detectamos en el campo \`hours\` que la ficha figura abierta las 24 horas, pero el rubro no parece ser de los que justifican ese horario (emergencias, hotelería, seguridad, etc.). Lo tratamos como horario mal cargado → "mal".`;
      }
      const rubroNote = ctx.hasOpen24h && ctx.isEmergencyRubro ? " (24hs detectado, pero el rubro sí lo justifica)" : "";
      return `Contamos cuántos días tienen horario cargado en el campo \`hours\`. Encontrados: ${ctx.hoursDayCount} de 7 días (hace falta 5 o más)${rubroNote}.`;
    },
  },
  {
    id: "categoria",
    title: "Categoría correcta",
    // No alcanza con que `type` no esté vacío: si Google le puso a la
    // ficha una categoría "cajón de sastre" (Establecimiento, Punto de
    // interés, etc.) es como si no tuviera categoría específica → mal. Y
    // si el usuario nos dijo su rubro al auditar, exigimos que la
    // categoría coincida con ese rubro (comparación por palabra, no
    // exacta — ver rubroMatchesCategory).
    ok: (ctx) => {
      if (!ctx.primaryType) return false;
      if (ctx.isGenericCategory) return false;
      if (ctx.declaredRubro && ctx.categoryMatchesRubro === false) return false;
      return true;
    },
    detail: (ctx) => {
      if (!ctx.primaryType) {
        return `Campo \`type\` de la API: vacío. Sin categoría, marcamos "mal".`;
      }
      if (ctx.isGenericCategory) {
        return `Categoría principal: "${ctx.primaryType}" — es una categoría genérica que Google usa cuando no hay una específica configurada. Se trata como "mal".`;
      }
      if (ctx.declaredRubro) {
        return ctx.categoryMatchesRubro
          ? `Categoría principal: "${ctx.primaryType}". Coincide razonablemente con el rubro declarado ("${ctx.declaredRubro}").`
          : `Categoría principal: "${ctx.primaryType}". NO coincide con el rubro declarado ("${ctx.declaredRubro}") → "mal".`;
      }
      return `Categoría principal: "${ctx.primaryType}" (específica, no genérica). No se declaró un rubro para comparar, así que no exigimos coincidencia exacta.`;
    },
  },
  {
    id: "web",
    title: "Web cargada",
    // No alcanza con que `website` no esté vacío: si el sitio no responde
    // (caído, dominio vencido, 404), es una ficha con "web rota", no con
    // web cargada. ctx.websiteCheck se completa con un fetch aparte hecho
    // en el handler (no acá, porque ok()/detail() son síncronas) — ver
    // checkWebsiteReachable.
    ok: (ctx) => Boolean(ctx.website) && ctx.websiteCheck.attempted && ctx.websiteCheck.reachable === true,
    detail: (ctx) => {
      if (!ctx.website) return `Campo \`website\`: (vacío).`;
      if (!ctx.websiteCheck.attempted) return `Campo \`website\`: ${ctx.website}. No llegamos a verificar si responde.`;
      if (ctx.websiteCheck.reachable) {
        return `Campo \`website\`: ${ctx.website}. Respondió correctamente (status ${ctx.websiteCheck.status}).`;
      }
      const reason = ctx.websiteCheck.error ? `error de red/timeout: ${ctx.websiteCheck.error}` : `respondió con status ${ctx.websiteCheck.status}`;
      return `Campo \`website\`: ${ctx.website}. No pudimos confirmar que esté vivo (${reason}). Ojo: puede ser un falso negativo si ese sitio bloquea peticiones automáticas.`;
    },
  },
  {
    id: "descripcion",
    title: "Descripción del negocio completa",
    // Además del largo mínimo, buscamos señales de mala calidad en el
    // campo `description`: teléfono o URL metidos en el texto (prohibido
    // por las políticas de Google) o una palabra que se repite de forma
    // sospechosa (relleno de palabras clave). Cualquiera de esas señales
    // tira el check a "mal" aunque cumpla el largo.
    ok: (ctx) => {
      const longEnough = ctx.description.length >= 60;
      const spam = ctx.descriptionSpam.hasPhone || ctx.descriptionSpam.hasUrl || ctx.descriptionSpam.hasRepeatedWord;
      return longEnough && !spam;
    },
    detail: (ctx) => {
      const lengthPart = `Campo \`description\`, largo: ${ctx.description.length} caracteres (hace falta 60 o más).`;
      const flags = [];
      if (ctx.descriptionSpam.hasPhone) flags.push("parece tener un teléfono adentro del texto");
      if (ctx.descriptionSpam.hasUrl) flags.push("parece tener una URL adentro del texto");
      if (ctx.descriptionSpam.hasRepeatedWord) {
        flags.push(
          `la palabra "${ctx.descriptionSpam.repeatedWord.word}" se repite ${ctx.descriptionSpam.repeatedWord.count} veces (posible relleno de palabras clave)`
        );
      }
      if (flags.length === 0) return `${lengthPart} No detectamos señales de relleno o spam.`;
      return `${lengthPart} Detectamos señales de mala calidad: ${flags.join("; ")}. Google prohíbe teléfonos/URLs en la descripción, y el relleno de palabras clave perjudica más de lo que ayuda.`;
    },
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
    ok: (ctx) => ctx.types.length >= 3,
    detail: (ctx) =>
      `Campo \`types\` (todas las categorías): ${ctx.types.length ? ctx.types.join(", ") : "(vacío)"} — ${ctx.types.length} en total (hace falta 3 o más: principal + al menos 2 secundarias).`,
  },
  {
    id: "atributos",
    title: "Atributos del negocio completos",
    ok: (ctx) => ctx.serviceOptionHits.length >= 2,
    detail: (ctx) =>
      `Campo \`service_options\` (delivery / para llevar / servir en el local, etc.). Activos: ${ctx.serviceOptionHits.length ? ctx.serviceOptionHits.join(", ") : "ninguno"}. Google solo carga este campo para algunos rubros (gastronomía sobre todo) — para otros rubros puede no aplicar.`,
  },
  {
    id: "resenas",
    title: "Reseñas",
    // No alcanza con "tener reseñas": exigimos volumen (>30) y buen
    // promedio (4.2+). Si no llega al volumen, es "mal" sin importar el
    // promedio. Si el volumen está bien pero no vino el promedio, le
    // damos el beneficio de la duda y lo dejamos en "bien" en vez de
    // penalizar por un dato que no pudimos leer.
    ok: (ctx) => {
      const countOk = ctx.reviews !== null && ctx.reviews > 30;
      if (!countOk) return false;
      if (ctx.rating === null) return true;
      return ctx.rating >= 4.2;
    },
    detail: (ctx) => {
      const countPart = `Campo \`reviews\`: ${ctx.reviews !== null ? ctx.reviews : "(no vino)"} (hace falta más de 30).`;
      const countOk = ctx.reviews !== null && ctx.reviews > 30;
      if (!countOk) return `${countPart} No llega al volumen mínimo → "mal", sin mirar el promedio.`;
      if (ctx.rating === null) {
        return `${countPart} Cumple el volumen. No vino el campo \`rating\`, así que por buena fe lo dejamos en "bien".`;
      }
      return `${countPart} Cumple el volumen. Promedio (\`rating\`): ${ctx.rating} (hace falta 4.2 o más).`;
    },
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
  const rubro = typeof payload.rubro === "string" ? payload.rubro.trim().slice(0, MAX_RUBRO_LENGTH) : "";

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

    const ctx = buildContext(place, rubro);

    // El check "web" necesita confirmar que el sitio responde, y eso
    // implica un fetch de red aparte del que ya le hicimos a SerpApi — no
    // podemos hacerlo dentro de buildContext (síncrona) ni dentro de
    // def.ok() (los CHECK_DEFINITIONS son todos síncronos por diseño).
    // Lo resolvemos acá y lo colgamos de ctx.websiteCheck.
    ctx.websiteCheck = { attempted: false, reachable: null, status: null, error: null };
    if (ctx.website) {
      let result;
      try {
        result = await checkWebsiteReachable(ctx.website);
      } catch (err) {
        result = { reachable: false, status: null, error: String(err && err.message ? err.message : err) };
      }
      ctx.websiteCheck = { ...result, attempted: true };
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

    const responseBody = { resolvedUrl: identifiers.resolvedUrl, checks };

    if (DEBUG_MODE) {
      responseBody.debug = {
        provider: "serpapi",
        cidPair: identifiers.cidPair,
        identifierUsed: identifiers.dataParam ? "data" : identifiers.dataCid ? "data_cid" : "búsqueda por nombre",
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

  // Google Maps identifica cada ficha con un CID en formato
  // "0x<feature>:0x<cid>" que aparece en la URL como !1s0x...:0x...
  // SerpApi (según su propio mensaje de error, confirmado probando
  // en el sitio real) NO acepta ese par tal cual — acepta uno de
  // estos tres: `data`, `place_id` o `data_cid`. La forma más directa
  // y menos propensa a errores es pasarle el bloque `data=...` de la
  // URL tal cual viene (sin reinterpretarlo); como respaldo, también
  // calculamos `data_cid` (el segundo hex convertido a decimal, que
  // es el formato que Google llama "CID" en otros contextos, ej. la
  // URL corta google.com/maps?cid=...).
  const cidPairMatch = workingUrl.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
  const cidPair = cidPairMatch ? `${cidPairMatch[1]}:${cidPairMatch[2]}` : null;
  let dataCid = null;
  if (cidPairMatch) {
    try {
      dataCid = BigInt(cidPairMatch[2]).toString();
    } catch {
      dataCid = null;
    }
  }

  // Ojo: en las URLs reales de Maps "data=" es parte del PATH
  // (.../17z/data=!3m1!...), no un parámetro de query string — puede
  // venir precedido de "/", no solo de "?" o "&".
  const dataParamMatch = workingUrl.match(/[/?&]data=([^?&]+)/i);
  let dataParam = null;
  if (dataParamMatch) {
    try {
      dataParam = decodeURIComponent(dataParamMatch[1]);
    } catch {
      dataParam = dataParamMatch[1];
    }
  }

  // Fallback: nombre del negocio + coordenadas, para hacer una
  // búsqueda si no encontramos ningún identificador de arriba.
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
    cidPair: cidPair || null, // solo para mostrar en el debug, no se manda a SerpApi
    dataParam,
    dataCid,
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

async function querySerpApi({ dataParam, dataCid, query, lat, lng }) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new UserError(
      "Falta configurar la lectura real de fichas (SERPAPI_KEY) en Netlify. Avisale a quien administra el sitio."
    );
  }

  const hasPlaceIdentifier = Boolean(dataParam || dataCid);

  if (!query && !hasPlaceIdentifier) {
    throw new UserError(
      "No pudimos identificar tu ficha a partir de ese link. Probá copiarlo de nuevo desde \"Compartir\" en Google Maps."
    );
  }

  const params = new URLSearchParams({
    engine: "google_maps",
    hl: "es",
    api_key: apiKey,
    q: query || "ficha de Google Maps",
  });

  // type=place: pedimos la FICHA COMPLETA de un negocio puntual (con
  // website, horarios, descripción, etc.), no una lista de resultados
  // de búsqueda. Pero type=place exige identificar la ficha con uno
  // de estos parámetros (confirmado por el propio mensaje de error de
  // SerpApi): `data`, `place_id` o `data_cid`. Si no tenemos ninguno
  // (link sin datos de ubicación, solo nombre), no podemos pedir
  // type=place — hacemos una búsqueda normal y nos quedamos con el
  // primer resultado, que va a traer menos campos.
  if (dataParam) {
    params.set("type", "place");
    params.set("data", dataParam);
  } else if (dataCid) {
    params.set("type", "place");
    params.set("data_cid", dataCid);
  }

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

function buildContext(place, rubro) {
  // OJO (confirmado con una respuesta real de SerpApi): el campo
  // `type` viene como ARRAY con TODAS las categorías de la ficha
  // (ej. `type: ["Instalador de gas"]`), no como string suelto — y
  // SerpApi no manda ningún campo separado `types`/`categories` con
  // la lista completa. Antes asumíamos lo contrario (que `type` era
  // un string y `types`/`categories` la lista), así que con una
  // ficha real esto siempre daba "categoría vacía" aunque la API sí
  // trajera la categoría. Probamos primero el array (`type`/`types`/
  // `categories`, sea cual sea el que venga como array) y, si no hay
  // ninguno, contemplamos el caso de que sea un string suelto.
  const rawTypes = firstDefined(place, ["type", "types", "categories"]);
  const rawType = firstDefined(place, ["type", "category", "primary_type"]);
  const types = Array.isArray(rawTypes)
    ? rawTypes
    : Array.isArray(rawType)
    ? rawType
    : typeof rawType === "string"
    ? [rawType]
    : [];

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

  const ratingRaw = firstDefined(place, ["rating", "average_rating", "stars", "rating_value"]);
  const rating =
    typeof ratingRaw === "number"
      ? ratingRaw
      : typeof ratingRaw === "string"
      ? parseFloat(ratingRaw.replace(",", "."))
      : null;

  const websiteRaw = firstDefined(place, ["website", "link", "site"]);
  const descriptionRaw = firstDefined(place, ["description", "about", "editorial_summary"]);

  const primaryType = types[0] || "";
  const declaredRubro = rubro || "";
  const isGenericCategory = isGenericCategoryName(primaryType);
  const categoryMatchesRubro =
    declaredRubro && primaryType && !isGenericCategory ? rubroMatchesCategory(declaredRubro, primaryType) : null;

  // No sabemos con certeza el formato exacto de `hours` para todos los
  // rubros (ver comentario arriba sobre `type`), así que en vez de asumir
  // una forma fija lo volcamos a texto y buscamos el patrón de "24 horas"
  // ahí adentro — mismo espíritu best-effort que el resto de los campos
  // no confirmados contra una respuesta real.
  const hoursBlob = safeJsonPreview(hours, 4000);
  const hasOpen24h = OPEN_24H_PATTERNS.some((re) => re.test(hoursBlob));
  const rubroBlob = [primaryType, ...types, declaredRubro].filter(Boolean).join(" ");
  const isEmergencyRubro = EMERGENCY_RUBRO_PATTERNS.some((re) => re.test(rubroBlob));

  return {
    primaryType,
    types,
    hoursDayCount,
    hasOpen24h,
    isEmergencyRubro,
    declaredRubro,
    isGenericCategory,
    categoryMatchesRubro,
    website: typeof websiteRaw === "string" ? websiteRaw : "",
    description: typeof descriptionRaw === "string" ? descriptionRaw : "",
    descriptionSpam: detectDescriptionSpam(typeof descriptionRaw === "string" ? descriptionRaw : ""),
    serviceOptionHits,
    hasMenuOrProducts: Boolean(place.menu || place.products),
    reviews: Number.isFinite(reviews) ? reviews : null,
    rating: Number.isFinite(rating) ? rating : null,
  };
}

function isGenericCategoryName(categoryText) {
  if (!categoryText) return false;
  return GENERIC_CATEGORY_NAMES.includes(normalizeText(categoryText));
}

// Compara el rubro que declaró el usuario contra la categoría detectada.
// No exigimos coincidencia exacta (plomería/plomero, cerrajería/cerrajero)
// — comparamos por prefijo de cada palabra relevante, una forma simple de
// tolerar variaciones de género/número típicas del español.
function rubroMatchesCategory(rubro, categoryText) {
  const rubroNorm = normalizeText(rubro);
  const categoryNorm = normalizeText(categoryText);
  if (!rubroNorm || !categoryNorm) return null;
  if (rubroNorm.includes(categoryNorm) || categoryNorm.includes(rubroNorm)) return true;

  const rubroWords = rubroNorm.split(" ").filter((w) => w.length >= 4);
  const categoryWords = categoryNorm.split(" ").filter((w) => w.length >= 4);
  return rubroWords.some((rw) => categoryWords.some((cw) => wordsShareStem(rw, cw)));
}

function wordsShareStem(a, b) {
  const prefixLen = Math.min(6, a.length, b.length);
  if (prefixLen < 4) return a === b;
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // saca acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Busca señales de mala calidad en la descripción: teléfono o URL metidos
// en el texto (prohibido por las políticas de Google para esta sección) o
// una palabra de contenido que se repite mucho más de lo esperable (relleno
// de palabras clave, otra práctica que Google penaliza).
function detectDescriptionSpam(text) {
  if (!text) return { hasPhone: false, hasUrl: false, hasRepeatedWord: false, repeatedWord: null };

  const hasPhone = /(\+?\d[\d\s.()-]{6,}\d)/.test(text);
  const hasUrl = /https?:\/\/|www\.|\.(com|com\.ar|net|ar)\b/i.test(text);

  const words = normalizeText(text)
    .split(" ")
    .filter((w) => w.length >= 4 && !SPAM_STOPWORDS.has(w));

  let repeatedWord = null;
  if (words.length > 0) {
    const freq = {};
    words.forEach((w) => {
      freq[w] = (freq[w] || 0) + 1;
    });
    const [topWord, topCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    if (topCount >= 4) repeatedWord = { word: topWord, count: topCount };
  }

  return { hasPhone, hasUrl, hasRepeatedWord: repeatedWord !== null, repeatedWord };
}

// Fetch aparte (no a SerpApi/Google) para confirmar que el sitio web
// cargado en la ficha efectivamente responde. Ver comentario de
// WEBSITE_FETCH_TIMEOUT_MS sobre el trade-off de latencia/falsos
// negativos que esto acepta a propósito.
async function checkWebsiteReachable(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBSITE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA },
    });
    return { reachable: response.ok, status: response.status, error: null };
  } catch (err) {
    return { reachable: false, status: null, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timeout);
  }
}

function safe(fn) {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
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
