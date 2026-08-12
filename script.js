/* =========================================================
   Auditoría GMB · GoodMax
   -----------------------------------------------------------
   Por ahora esto es SOLO diseño y estructura: no hay lectura
   real de la ficha de Google Maps todavía. `runMockAudit()`
   genera un resultado simulado (pero estable para el mismo
   link) para poder mostrar la interfaz completa.

   Cuando conectemos la lectura real, el único lugar que hay
   que tocar es `getAuditResult()`: reemplazar la llamada a
   `runMockAudit()` por la consulta real (API / scraping /
   backend propio) que devuelva el mismo formato de datos.
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

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60; // r = 60 en el SVG

  // ---- Validación básica del link ---------------------------
  function isLikelyGoogleMapsUrl(value) {
    if (!value) return false;
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(trimmed);
  }

  // ---- Generador pseudo-aleatorio con semilla ---------------
  // Así el mismo link siempre da el mismo resultado simulado
  // (más creíble para una demo que puro azar cada vez).
  function seededRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    }
    return function () {
      h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5) | 0;
      let t = h ^ (h >>> 15);
      t = Math.imul(t, 1 | t);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Auditoría simulada (placeholder) ----------------------
  function runMockAudit(url) {
    const rand = seededRandom(url.trim().toLowerCase());
    return CHECKLIST_DEFINITION.map((item) => ({
      ...item,
      ok: rand() > 0.45, // ~55% de probabilidad de que "falte" cada punto
    }));
  }

  // ---- Punto único de integración futura ---------------------
  // Reemplazar el cuerpo de esta función por la lectura real
  // (API de Google, backend propio, etc.) manteniendo el mismo
  // formato de retorno: array de { id, title, okDesc, failDesc, ok }
  async function getAuditResult(url) {
    // Simulamos una pequeña demora de "análisis" para que la
    // interfaz de carga tenga sentido.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return runMockAudit(url);
  }

  // ---- Render de resultados -----------------------------------
  function renderResults(url, checklist) {
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
      const checklist = await getAuditResult(url);
      renderResults(url, checklist);
      showResults();
    } catch (err) {
      loadingSection.classList.add("hidden");
      auditBtn.disabled = false;
      auditBtn.querySelector(".btn-label").textContent = "Auditar mi ficha";
      showError("No pudimos analizar la ficha. Probá de nuevo en un momento.");
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
})();
