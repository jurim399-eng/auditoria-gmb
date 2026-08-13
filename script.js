/* =========================================================
   Auditoría GMB · GoodMax
   -----------------------------------------------------------
   La auditoría lee la ficha real de Google Maps a través de la
   Netlify Function en /api/audit (ver netlify/functions/audit.js).
   Esa function trae el HTML público de la ficha y devuelve, para
   cada punto del checklist, si lo detectó o no: { checks: { <id>:
   boolean, ... } }. Acá solo pedimos ese resultado y lo cruzamos
   con CHECKLIST_DEFINITION (que tiene los títulos y textos).

   Como es lectura de la página pública sin API oficial, puede
   fallar o quedar desactualizada si Google cambia el diseño de la
   página — el detalle de qué tan confiable es cada punto está
   documentado en netlify/functions/audit.js.
   ========================================================= */

(function () {
  "use strict";

  // ---- Definición de los puntos que se auditan -------------
  // Cada item tiene lo que se muestra cuando está OK y cuando falta.
  const CHECKLIST_DEFINITION = [
    {
      id: "fotos",
      title: "Fotos actualizadas",
      okDesc: "Tu ficha tiene fotos recientes que muestran bien el negocio.",
      failDesc: "No se ven fotos recientes. Las fichas con fotos actuales generan más confianza y clics.",
    },
    {
      id: "horarios",
      title: "Horarios completos",
      okDesc: "Los horarios de atención están cargados y completos.",
      failDesc: "Faltan horarios o están incompletos. Sin horarios, Google puede mostrar tu negocio como \"cerrado\" por error.",
    },
    {
      id: "categoria",
      title: "Categoría correcta",
      okDesc: "La categoría principal describe bien tu rubro.",
      failDesc: "La categoría no está bien definida. Una categoría incorrecta te hace perder búsquedas de clientes.",
    },
    {
      id: "web",
      title: "Web cargada",
      okDesc: "El link a tu sitio web está cargado en la ficha.",
      failDesc: "No hay un sitio web cargado. Es una oportunidad perdida de llevar tráfico fuera de Maps.",
    },
    {
      id: "whatsapp",
      title: "WhatsApp cargado",
      okDesc: "Tenés un link directo de WhatsApp para que te contacten.",
      failDesc: "No hay un link directo de WhatsApp. Muchos clientes prefieren escribir antes que llamar.",
    },
    {
      id: "publicaciones",
      title: "Publicaciones activas",
      okDesc: "Estás publicando novedades con cierta frecuencia.",
      failDesc: "No hay publicaciones recientes. Las publicaciones activas ayudan a aparecer más arriba en las búsquedas.",
    },
    {
      id: "descripcion",
      title: "Descripción del negocio completa",
      okDesc: "La descripción está completa y usa palabras clave de tu rubro.",
      failDesc: "Falta o es muy pobre la descripción. Sin palabras clave del rubro, Google tiene menos pistas para mostrarte en las búsquedas correctas.",
    },
    {
      id: "servicios",
      title: "Servicios o productos cargados",
      okDesc: "Tenés cargados los servicios o productos que ofrecés.",
      failDesc: "No hay servicios ni productos cargados. Es información que ayuda a que el cliente decida contactarte antes de escribir.",
    },
    {
      id: "categorias-secundarias",
      title: "Categorías secundarias",
      okDesc: "Además de la principal, sumaste categorías secundarias que amplían tu alcance.",
      failDesc: "Solo tenés la categoría principal. Sumar categorías secundarias te hace aparecer en más búsquedas relacionadas.",
    },
    {
      id: "area-servicio",
      title: "Área de servicio configurada",
      okDesc: "El área donde atendés está bien configurada.",
      failDesc: "No hay un área de servicio configurada. Si trabajás fuera de tu local (a domicilio, por zona), Google necesita saberlo para mostrarte a esos clientes.",
    },
    {
      id: "atributos",
      title: "Atributos del negocio completos",
      okDesc: "Cargaste los atributos relevantes (accesibilidad, delivery, retiro en local, etc.).",
      failDesc: "Faltan atributos como accesibilidad, delivery o retiro en local. Son filtros que los clientes usan para elegir entre varios negocios.",
    },
    {
      id: "preguntas-respuestas",
      title: "Preguntas y respuestas",
      okDesc: "Respondés las preguntas que dejan los usuarios en tu ficha.",
      failDesc: "Hay preguntas sin responder. Dejarlas así puede llevar a que otro usuario responda mal en tu lugar, o directamente hacer dudar al cliente.",
    },
    {
      id: "resenas",
      title: "Reseñas",
      okDesc: "Tenés buen volumen de reseñas y respondés a las que recibís.",
      failDesc: "Te faltan reseñas o no estás respondiendo las que ya tenés. Responder reseñas (buenas y malas) mejora la confianza y el posicionamiento.",
    },
  ];

  // ---- Referencias al DOM -----------------------------------
  const form = document.getElementById("audit-form");
  const input = document.getElementById("gmb-url");
  const formError = document.getElementById("form-error");
  const auditBtn = document.getElementById("audit-btn");

  const loadingSection = document.getElementById("loading");
  const resultsSection = document.getElementById("results");

  const checklistEl = document.getElementById("checklist");
  const scoreNumberEl = document.getElementById("score-number");
  const scoreRingFg = document.getElementById("score-ring-fg");
  const analyzedUrlEl = document.getElementById("analyzed-url");
  const resultsHeadline = document.getElementById("results-headline");
  const resultsSubheadline = document.getElementById("results-subheadline");

  const restartBtn = document.getElementById("restart-btn");
  const copyReportBtn = document.getElementById("copy-report-btn");
  const copyReportFeedback = document.getElementById("copy-report-feedback");
  const whatsappCtaLink = document.getElementById("whatsapp-cta");

  const debugDetailsEl = document.getElementById("debug-details");
  const debugDetailsContentEl = document.getElementById("debug-details-content");
  const copyHtmlBtn = document.getElementById("copy-html-btn");
  const copyHtmlFeedback = document.getElementById("copy-html-feedback");

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60; // r = 60 en el SVG
  const AUDIT_ENDPOINT = "/api/audit";

  // Se completa después de cada auditoría exitosa, para poder armar
  // el informe copiable sin tener que recalcular nada.
  let lastAuditState = null;

  // Guarda el último `debug` recibido (incluye el HTML crudo completo)
  // para el botón "Copiar HTML completo". Es aparte de lastAuditState
  // porque es un dato de diagnóstico, no del resultado en sí.
  let lastDebugState = null;

  // ---- Validación básica del link ---------------------------
  function isLikelyGoogleMapsUrl(value) {
    if (!value) return false;
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(trimmed);
  }

  // ---- Lectura real de la ficha (Netlify Function) ------------
  // La function busca el HTML público de la ficha y devuelve qué
  // puntos detectó. Acá solo cruzamos ese resultado con
  // CHECKLIST_DEFINITION para tener título + texto + ok por punto.
  async function getAuditResult(url) {
    const response = await fetch(AUDIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      // el servidor no devolvió JSON (por ej. la function no está desplegada)
    }

    if (!response.ok) {
      const message = data && data.error ? data.error : "No pudimos analizar la ficha. Probá de nuevo en un momento.";
      throw new Error(message);
    }

    const checks = (data && data.checks) || {};
    const checklist = CHECKLIST_DEFINITION.map((item) => ({
      ...item,
      ok: Boolean(checks[item.id]),
    }));

    return { checklist, debug: (data && data.debug) || null };
  }

  // ---- Render de resultados -----------------------------------
  function renderResults(url, checklist, debug) {
    checklistEl.innerHTML = "";

    checklist.forEach((item) => {
      const li = document.createElement("li");
      li.className = "check-item " + (item.ok ? "ok" : "fail");
      li.setAttribute("role", "listitem");

      li.innerHTML = `
        <span class="check-icon" aria-hidden="true">${item.ok ? "✓" : "✕"}</span>
        <div class="check-body">
          <div class="check-title">${item.title}</div>
          <p class="check-desc">${item.ok ? item.okDesc : item.failDesc}</p>
        </div>
      `;
      checklistEl.appendChild(li);
    });

    const okCount = checklist.filter((i) => i.ok).length;
    const total = checklist.length;
    const score = Math.round((okCount / total) * 100);

    scoreNumberEl.textContent = score;

    const offset = RING_CIRCUMFERENCE * (1 - score / 100);
    // Forzamos un reflow para que la transición del anillo se vea.
    scoreRingFg.style.strokeDashoffset = RING_CIRCUMFERENCE;
    requestAnimationFrame(() => {
      scoreRingFg.style.strokeDashoffset = offset;
    });

    let ringColor = "#1a73e8";
    if (score >= 80) ringColor = "#1e8e5a";
    else if (score < 50) ringColor = "#d33b2c";
    scoreRingFg.style.stroke = ringColor;

    if (score === 100) {
      resultsHeadline.textContent = "¡Tu ficha está impecable!";
      resultsSubheadline.textContent = "Cumple con todos los puntos clave que evaluamos.";
    } else if (score >= 60) {
      resultsHeadline.textContent = "Tu ficha está bien encaminada";
      resultsSubheadline.textContent = `Cumple ${okCount} de ${total} puntos clave. Todavía hay margen para mejorar.`;
    } else {
      resultsHeadline.textContent = "Tu ficha se está perdiendo clientes";
      resultsSubheadline.textContent = `Solo cumple ${okCount} de ${total} puntos clave que evaluamos.`;
    }

    analyzedUrlEl.textContent = url;

    lastAuditState = { url, checklist, score, okCount, total };

    renderDebugDetails(debug);
  }

  // ---- Detalle técnico (temporal, para diagnóstico) ------------
  // Muestra en texto plano lo que devolvió la Netlify Function en
  // `debug`: status HTTP, primeros 500 caracteres del HTML recibido,
  // y qué patrón buscó y encontró cada uno de los 13 puntos. Se arma
  // con textContent (no innerHTML) porque el HTML de Google puede
  // traer cualquier cosa ahí adentro y no queremos ni interpretarlo
  // ni que rompa el diseño de la página.
  function renderDebugDetails(debug) {
    lastDebugState = debug;

    if (!debug) {
      debugDetailsEl.classList.add("hidden");
      debugDetailsContentEl.textContent = "";
      return;
    }

    const lines = [];
    lines.push(`Proveedor de lectura: ${debug.provider || "(desconocido)"}`);
    lines.push(`Identificador usado (data_id de Google): ${debug.dataId || "(ninguno — se buscó por nombre)"}`);
    if (debug.query && !debug.dataId) lines.push(`Búsqueda por nombre usada como respaldo: "${debug.query}"`);
    lines.push("");
    lines.push("--- Detalle por punto (qué campo miramos y qué encontramos) ---");

    (debug.points || []).forEach((point) => {
      lines.push("");
      lines.push(`${point.found ? "✅" : "❌"} ${point.title}`);
      lines.push(point.detail);
    });

    lines.push("");
    lines.push("--- JSON crudo que devolvió el proveedor para esta ficha ---");
    lines.push(debug.placeJson || "(vacío)");

    debugDetailsContentEl.textContent = lines.join("\n");
    debugDetailsEl.classList.remove("hidden");
  }

  async function copyRawHtml() {
    if (!lastDebugState || !lastDebugState.placeJson) return;

    let copied = false;
    try {
      await navigator.clipboard.writeText(lastDebugState.placeJson);
      copied = true;
    } catch {
      copied = legacyCopyToClipboard(lastDebugState.placeJson);
    }

    copyHtmlFeedback.textContent = copied
      ? "¡JSON copiado! Ya lo podés pegar donde lo necesites."
      : "No pudimos copiarlo automáticamente.";
  }

  // ---- Estados de la interfaz ---------------------------------
  function showLoading() {
    formError.textContent = "";
    resultsSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    auditBtn.disabled = true;
    auditBtn.querySelector(".btn-label").textContent = "Auditando…";
  }

  function showResults() {
    loadingSection.classList.add("hidden");
    resultsSection.classList.remove("hidden");
    auditBtn.disabled = false;
    auditBtn.querySelector(".btn-label").textContent = "Auditar mi ficha";
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showError(message) {
    formError.textContent = message;
    input.classList.add("input-error");
    input.focus();
  }

  // ---- Informe copiable (texto plano, listo para WhatsApp) ----
  function buildReportText(state) {
    const { url, checklist, score, okCount, total } = state;
    const whatsappLink = whatsappCtaLink ? whatsappCtaLink.href.split("?")[0] : "";

    const lines = [];
    lines.push("📍 *Diagnóstico de tu ficha de Google Maps*");
    if (url) lines.push(url);
    lines.push("");
    lines.push(`Resultado: ${score}% — cumple ${okCount} de ${total} puntos clave`);
    lines.push("");

    checklist.forEach((item) => {
      const icon = item.ok ? "✅" : "❌";
      const estado = item.ok ? "" : " (te falta)";
      lines.push(`${icon} ${item.title}${estado}`);
      lines.push(item.ok ? item.okDesc : item.failDesc);
      lines.push("");
    });

    lines.push("—");
    lines.push(
      "Este diagnóstico lo armó automáticamente la herramienta de GoodMax, así que puede tener algún margen de error."
    );
    lines.push(
      "Si querés el diagnóstico completo y de yapa te dejamos la ficha optimizada, escribinos por WhatsApp y lo vemos juntos 👇"
    );
    if (whatsappLink) lines.push(whatsappLink);

    return lines.join("\n");
  }

  async function copyReport() {
    if (!lastAuditState) return;
    const text = buildReportText(lastAuditState);

    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = legacyCopyToClipboard(text);
    }

    copyReportFeedback.textContent = copied
      ? "¡Informe copiado! Ya lo podés pegar en WhatsApp."
      : "No pudimos copiarlo automáticamente. Seleccioná el texto a mano.";

    if (copied) {
      const originalLabel = copyReportBtn.textContent;
      copyReportBtn.textContent = "✓ Copiado";
      setTimeout(() => {
        copyReportBtn.textContent = originalLabel;
      }, 2000);
    }
  }

  function legacyCopyToClipboard(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let success = false;
    try {
      success = document.execCommand("copy");
    } catch {
      success = false;
    }
    document.body.removeChild(textarea);
    return success;
  }

  // ---- Eventos ---------------------------------------------------
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const url = input.value.trim();

    input.classList.remove("input-error");
    formError.textContent = "";

    if (!url) {
      showError("Pegá el link de tu ficha de Google Maps para poder auditarla.");
      return;
    }

    if (!isLikelyGoogleMapsUrl(url)) {
      showError("Ese link no parece ser de Google Maps. Copialo desde \"Compartir\" en tu ficha.");
      return;
    }

    showLoading();
    try {
      const { checklist, debug } = await getAuditResult(url);
      renderResults(url, checklist, debug);
      showResults();
    } catch (err) {
      loadingSection.classList.add("hidden");
      auditBtn.disabled = false;
      auditBtn.querySelector(".btn-label").textContent = "Auditar mi ficha";
      const message = err && err.message ? err.message : "No pudimos analizar la ficha. Probá de nuevo en un momento.";
      showError(message);
    }
  });

  input.addEventListener("input", function () {
    if (input.classList.contains("input-error")) {
      input.classList.remove("input-error");
      formError.textContent = "";
    }
  });

  restartBtn.addEventListener("click", function () {
    resultsSection.classList.add("hidden");
    input.value = "";
    input.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  copyReportBtn.addEventListener("click", copyReport);
  copyHtmlBtn.addEventListener("click", copyRawHtml);
})();
