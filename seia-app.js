// Sistematización de RCA/ICSARA — MVP 2 (prototipo)
// Busca documentos en el SEIA -> extrae datos estructurados con Gemini -> los muestra.

const $ = (id) => document.getElementById(id);

const state = {
  documentos: [], // [{ etiqueta, tipo, fecha, url, extraido: {...} | null, error: string | null, cargando: bool }]
};

function setStatus(el, text, kind) {
  el.innerHTML = "";
  if (!text) return;
  const div = document.createElement("div");
  div.className = "status-msg" + (kind ? " " + kind : "");
  div.textContent = text;
  el.appendChild(div);
}

async function buscarDocumentos(idExpediente) {
  const resp = await fetch(`/api/buscar-documentos?id_expediente=${encodeURIComponent(idExpediente)}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status} buscando el expediente.`);
  return data;
}

async function extraerDocumento(doc) {
  const resp = await fetch("/api/extraer-seia", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: doc.url }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status} extrayendo el documento.`);
  const parsed = tryParseJSON(data.text);
  if (!parsed) throw new Error("La IA no devolvió un JSON válido para este documento.");
  return parsed;
}

function tryParseJSON(text) {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

function renderDocs() {
  const filtroTexto = $("filtro").value.trim().toLowerCase();
  const wrap = $("docs-list");
  wrap.innerHTML = "";

  state.documentos.forEach((doc) => {
    if (filtroTexto && !docCoincide(doc, filtroTexto)) return;

    const card = document.createElement("div");
    card.className = "doc-card";

    const top = document.createElement("div");
    top.className = "doc-top";
    const badge = document.createElement("span");
    badge.className = "badge " + doc.etiqueta.toLowerCase();
    badge.textContent = doc.etiqueta;
    const meta = document.createElement("span");
    meta.className = "doc-meta";
    meta.textContent = `${doc.tipo} — ${doc.fecha}`;
    const link = document.createElement("a");
    link.href = doc.url;
    link.target = "_blank";
    link.textContent = "Ver PDF original";
    link.style.fontSize = "0.85rem";
    top.append(badge, meta, link);
    card.appendChild(top);

    if (doc.cargando) {
      const p = document.createElement("p");
      p.className = "spinner-line";
      p.textContent = "Extrayendo con IA...";
      card.appendChild(p);
    } else if (doc.error) {
      const p = document.createElement("div");
      p.className = "status-msg error";
      p.textContent = doc.error;
      card.appendChild(p);
    } else if (doc.extraido) {
      card.appendChild(renderExtraido(doc.extraido));
    }

    wrap.appendChild(card);
  });
}

function docCoincide(doc, filtro) {
  if (!doc.extraido) return (doc.tipo + " " + doc.fecha).toLowerCase().includes(filtro);
  const e = doc.extraido;
  const bolsa = [
    e.proyecto, e.titular, e.region, e.sectorProductivo,
    ...(e.condicionesExigencias || []),
    ...(e.componentesAmbientales || []),
    ...(e.normativaCitada || []),
    ...(e.plazosCumplimiento || []),
    ...((e.observaciones || []).map((o) => `${o.organismo} ${o.tema} ${o.resumen}`)),
  ].filter(Boolean).join(" ").toLowerCase();
  return bolsa.includes(filtro);
}

function renderExtraido(e) {
  const box = document.createElement("div");

  const linea = document.createElement("p");
  linea.className = "doc-meta";
  const partes = [e.proyecto, e.titular, e.region, e.sectorProductivo, e.tipoEvaluacion].filter(Boolean);
  linea.textContent = partes.join(" · ");
  box.appendChild(linea);

  if (e.resultado && e.resultado !== "No aplica") {
    const r = document.createElement("p");
    r.innerHTML = `<strong>Resultado:</strong> ${escapeHtml(e.resultado)}`;
    box.appendChild(r);
  }

  addListSection(box, "Condiciones / exigencias", e.condicionesExigencias);

  if (e.componentesAmbientales && e.componentesAmbientales.length) {
    const h = document.createElement("h3");
    h.textContent = "Componentes ambientales";
    box.appendChild(h);
    const tagWrap = document.createElement("div");
    tagWrap.className = "tag-list";
    e.componentesAmbientales.forEach((c) => {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = c;
      tagWrap.appendChild(tag);
    });
    box.appendChild(tagWrap);
  }

  if (e.observaciones && e.observaciones.length) {
    const h = document.createElement("h3");
    h.textContent = "Observaciones";
    box.appendChild(h);
    e.observaciones.forEach((o) => {
      const item = document.createElement("div");
      item.className = "obs-item";
      const org = document.createElement("div");
      org.className = "obs-organismo";
      org.textContent = o.organismo;
      const tema = document.createElement("div");
      tema.className = "obs-tema";
      tema.textContent = o.tema;
      const resumen = document.createElement("div");
      resumen.textContent = o.resumen;
      item.append(org, tema, resumen);
      box.appendChild(item);
    });
  }

  addListSection(box, "Normativa citada", e.normativaCitada);
  addListSection(box, "Plazos de cumplimiento", e.plazosCumplimiento);

  return box;
}

function addListSection(container, titulo, items) {
  if (!items || !items.length) return;
  const h = document.createElement("h3");
  h.textContent = titulo;
  container.appendChild(h);
  const ul = document.createElement("ul");
  items.forEach((it) => {
    const li = document.createElement("li");
    li.textContent = it;
    ul.appendChild(li);
  });
  container.appendChild(ul);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function onBuscar() {
  const idExpediente = $("f-id-expediente").value.trim();
  const status = $("buscar-status");
  const btn = $("btn-buscar");
  if (!/^\d+$/.test(idExpediente)) {
    setStatus(status, "El id_expediente debe ser numérico (lo encuentras en la URL de la ficha del proyecto).", "error");
    return;
  }

  btn.disabled = true;
  setStatus(status, "Buscando en seia.sea.gob.cl...", null);
  $("panel-resultados").classList.add("hidden");

  try {
    const data = await buscarDocumentos(idExpediente);
    $("resumen-expediente").textContent =
      `${data.totalDocumentosExpediente} documentos en el expediente completo — ${data.documentos.length} coinciden con RCA/ICSARA.`;

    state.documentos = data.documentos.map((d) => ({ ...d, cargando: true, error: null, extraido: null }));
    $("panel-resultados").classList.remove("hidden");
    renderDocs();
    setStatus(status, "", null);

    if (!state.documentos.length) {
      setStatus(status, "No se encontraron RCA ni ICSARA en este expediente.", "warn");
    }

    // Extrae todos los documentos en paralelo (cada uno es su propia función serverless).
    await Promise.all(
      state.documentos.map(async (doc) => {
        try {
          doc.extraido = await extraerDocumento(doc);
        } catch (err) {
          doc.error = err.message || String(err);
        } finally {
          doc.cargando = false;
          renderDocs();
        }
      })
    );
  } catch (err) {
    setStatus(status, err.message || String(err), "error");
  } finally {
    btn.disabled = false;
  }
}

function init() {
  $("btn-buscar").addEventListener("click", onBuscar);
  $("f-id-expediente").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onBuscar();
  });
  $("filtro").addEventListener("input", renderDocs);
}

init();
