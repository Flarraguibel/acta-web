// Generador de actas INERCO Chile.
// Parseo de transcripción (en el navegador) -> Gemini vía función serverless de Vercel (api/generar-acta.mjs)
// (la API key vive solo en el servidor, nunca en el navegador) -> relleno del .docx institucional.

/* ---------------------------------------------------------------------- */
/* Constantes                                                              */
/* ---------------------------------------------------------------------- */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const TEMPLATE_URL = "assets/plantilla_base_acta.docx";
const GEMINI_FUNCTION_URL = "/api/generar-acta";

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio",
  "agosto","septiembre","octubre","noviembre","diciembre"];

const ACTA_SCHEMA = {
  type: "OBJECT",
  properties: {
    proyecto: { type: "STRING" },
    actaNumero: { type: "STRING" },
    fecha: { type: "STRING" },
    horaInicio: { type: "STRING" },
    horaTermino: { type: "STRING" },
    objetivo: { type: "STRING" },
    temas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          titulo: { type: "STRING" },
          parrafos: { type: "ARRAY", items: { type: "STRING" } },
          fecha: { type: "STRING" },
          encargado: { type: "STRING" },
          estado: { type: "STRING", enum: ["Pendiente", "Cerrado"] },
        },
        required: ["titulo", "parrafos", "fecha", "encargado", "estado"],
      },
    },
    notasRevision: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["objetivo", "temas", "notasRevision"],
};

/* ---------------------------------------------------------------------- */
/* Estado                                                                   */
/* ---------------------------------------------------------------------- */

const state = {
  turns: [],          // [{ name, empresa, text }]
  participants: [],   // [{ nombre, iniciales, empresa, modalidad }]
  temas: [],          // [{ titulo, parrafos:[...], fecha, encargado, estado }]
  notasRevision: [],  // [string]
};

/* ---------------------------------------------------------------------- */
/* Utilidades de texto                                                     */
/* ---------------------------------------------------------------------- */

function computeIniciales(nombre, usados) {
  const parts = nombre.trim().split(/\s+/).filter(Boolean);
  let ini;
  if (parts.length <= 1) ini = (parts[0] || "").slice(0, 2).toUpperCase();
  else ini = (parts[0][0] + parts[1][0]).toUpperCase();

  if (!usados.has(ini)) return ini;
  if (parts.length > 1 && parts[1].length > 1) {
    const alt = (parts[0][0] + parts[1][1]).toUpperCase();
    if (!usados.has(alt)) return alt;
  }
  let n = 2;
  while (usados.has(ini + n)) n++;
  return ini + n;
}

function parseOffsetToSeconds(ts) {
  const parts = ts.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function addSecondsToHora(horaInicio, seconds) {
  if (!horaInicio || seconds == null) return null;
  const m = horaInicio.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + seconds;
  const hh = Math.floor((total / 3600) % 24);
  const mm = Math.floor((total % 3600) / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------------- */
/* Parseo del .docx de Teams                                               */
/* ---------------------------------------------------------------------- */

async function extractDocxParagraphs(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("El archivo no parece un .docx válido (falta word/document.xml).");
  const xmlText = await entry.async("string");
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const paras = doc.getElementsByTagNameNS(W_NS, "p");
  const lines = [];
  for (const p of paras) {
    const ts = p.getElementsByTagNameNS(W_NS, "t");
    let line = "";
    for (const t of ts) line += t.textContent;
    line = line.trim();
    if (line) lines.push(line);
  }
  return lines;
}

function parseTeamsDocxLines(lines) {
  const turnRe = /^(.+?)\s-\s(.+?)\s{1,4}(\d{1,2}:\d{2}(?::\d{2})?)(.*)$/;
  const startStopRe = /(inició|detuvo) la transcripción/i;
  const turns = [];
  const headerLines = [];
  let sawFirstTurn = false;

  for (const line of lines) {
    if (startStopRe.test(line)) continue;
    const m = line.match(turnRe);
    if (m) {
      sawFirstTurn = true;
      const [, name, empresa, ts, text] = m;
      if (text && text.trim()) {
        turns.push({ name: name.trim(), empresa: empresa.trim(), ts, text: text.trim() });
      }
    } else if (!sawFirstTurn) {
      headerLines.push(line);
    }
  }
  return { turns, headerLines };
}

function extractFechaFromHeader(headerLines) {
  const re = new RegExp(`(\\d{1,2}) de (${MESES.join("|")}) de (\\d{4})`, "i");
  for (const line of headerLines) {
    const m = line.match(re);
    if (m) return `${parseInt(m[1], 10)} de ${m[2].toLowerCase()} de ${m[3]}`;
  }
  return null;
}

function extractHoraInicioFromHeader(headerLines) {
  for (const line of headerLines) {
    const m = line.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* Parseo de .vtt                                                          */
/* ---------------------------------------------------------------------- */

function parseVTT(text) {
  const lines = text.split(/\r?\n/);
  const raw = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^NOTE\b/i.test(line)) continue;

    let content = line;
    let speaker = null;
    const vMatch = content.match(/<v\s+([^>]+)>(.*?)(<\/v>)?$/i);
    if (vMatch) {
      speaker = vMatch[1].trim();
      content = vMatch[2];
    } else {
      const colonMatch = content.match(/^([A-Za-zÀ-ÿ' .-]{2,40}):\s?(.*)$/);
      if (colonMatch) {
        speaker = colonMatch[1].trim();
        content = colonMatch[2];
      }
    }
    content = content.replace(/<[^>]+>/g, "").trim();
    if (!content) continue;

    if (speaker) raw.push({ name: speaker, text: content });
    else if (raw.length) raw[raw.length - 1].text += " " + content;
  }

  // Fusiona turnos consecutivos del mismo hablante; las transcripciones VTT
  // "en vivo" suelen repetir el texto anterior ampliado cue a cue.
  const merged = [];
  for (const t of raw) {
    const last = merged[merged.length - 1];
    if (last && last.name === t.name) {
      if (t.text.startsWith(last.text)) last.text = t.text;
      else if (!last.text.endsWith(t.text)) last.text += " " + t.text;
    } else {
      merged.push({ ...t, empresa: "" });
    }
  }
  return merged;
}

/* ---------------------------------------------------------------------- */
/* Participantes y texto de transcripción para el LLM                      */
/* ---------------------------------------------------------------------- */

function buildParticipants(turns) {
  const usados = new Set();
  const map = new Map();
  for (const t of turns) {
    if (map.has(t.name)) continue;
    const ini = computeIniciales(t.name, usados);
    usados.add(ini);
    // turnName conserva el nombre tal como aparece en la transcripción, para poder
    // seguir atribuyendo intervenciones aunque el usuario corrija "nombre" en la tabla.
    map.set(t.name, { turnName: t.name, nombre: t.name, iniciales: ini, empresa: t.empresa || "", modalidad: "Telemático" });
  }
  return Array.from(map.values());
}

function buildTranscriptText(turns, participants) {
  const byTurnName = new Map(participants.filter((p) => p.turnName).map((p) => [p.turnName, p]));
  return turns
    .map((t) => {
      const p = byTurnName.get(t.name);
      const ini = p ? p.iniciales : "";
      const nombre = p ? p.nombre : t.name;
      return `${ini ? ini + " - " : ""}${nombre}: ${t.text}`;
    })
    .join("\n");
}

/* ---------------------------------------------------------------------- */
/* Prompting y LLM                                                         */
/* ---------------------------------------------------------------------- */

function systemPromptFinal(inicialesList) {
  return `Eres un asistente que redacta actas de reunión institucionales para INERCO Chile a partir de una transcripción. La transcripción es la única fuente de verdad: si un dato no está en ella, no lo inventes.

Esta acta es una ayuda-memoria de uso semanal, no un informe. Prioriza frases cortas y directas: la mayoría de los temas se resuelven en una o dos frases. Si dudas entre una versión corta y una más desarrollada, elige la corta. Cuatro párrafos es el máximo absoluto, solo para temas con muchos datos técnicos que de verdad haya que conservar.

Reglas de redacción:
- Atribuye cada intervención con las iniciales del participante (ej. "IR indica que..."), usando "indica que" como verbo por defecto. Iniciales válidas: ${inicialesList || "(no identificadas, usa el nombre tal cual)"}.
- Redacta los compromisos en futuro y voz pasiva o impersonal ("Serán enviadas...", "Se generará...").
- Refiérete a las organizaciones como "Equipo INERCO", "Equipo [cliente]"; el encargado de una acción es siempre una organización, nunca una persona.
- Tercera persona, tono sobrio, sin adjetivos valorativos. Nunca cites textualmente el diálogo.
- Un tema por objeto de la lista "temas". Ordena por relevancia, no cronológicamente.
- Conserva íntegros los datos técnicos: nombres de comunidades, localidades, componentes ambientales, áreas de influencia, referencias normativas, listados que alguien enumere.
- No fijes fechas, hitos o plazos regulatorios que no se hayan comprometido de forma explícita en la reunión. Si se mencionaron de pasada, usa una formulación neutra en vez de repetir la fecha exacta.
- Ignora muletillas, palabras sueltas en inglés y fragmentos ininteligibles; no los reconstruyas. Si algo parece importante pero es ininteligible, decláralo en "notasRevision" en vez de adivinar.
- Normaliza estas siglas si aparecen deformadas: SEIA (a veces "CIA", "CEA", "Seiya"), MOP (a veces "MOB", "MOF", "MOPA"), reasentamiento (a veces "resentamiento", "reacentamiento"), concesionario (a veces "concescenario"). Si una sigla aparece deformada y no puedes identificarla con certeza, déjala igual y anótalo en "notasRevision".
- No incluyas conversación social, bromas, ni nombres de personas ajenas a la reunión.

Además de redactar los temas, intenta identificar estos datos administrativos SOLO si alguien los menciona explícitamente en voz alta durante la reunión (ej. "esta es la reunión del proyecto X", "sería el acta número 5", "hoy es 18 de agosto", "partimos a las tres de la tarde"): nombre del proyecto, número de acta, fecha y horas de inicio/término. Es una minoría de las reuniones donde esto se dice en voz alta — no lo infieras del tema de conversación ni de lo que "normalmente" correspondería. Si un dato no se menciona explícitamente, responde con cadena vacía "" en ese campo; nunca inventes ni asumas la fecha de hoy.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin explicación, sin bloque de código markdown, con exactamente este formato:
{
  "proyecto": "nombre del proyecto si se menciona explícitamente, si no \"\"",
  "actaNumero": "número de acta si se menciona explícitamente, si no \"\"",
  "fecha": "d de mes de aaaa, si se menciona explícitamente, si no \"\"",
  "horaInicio": "HH:MM si se menciona explícitamente, si no \"\"",
  "horaTermino": "HH:MM si se menciona explícitamente, si no \"\"",
  "objetivo": "una sola línea describiendo el propósito de la reunión",
  "temas": [
    {
      "titulo": "título breve del tema",
      "parrafos": ["una o dos frases; hasta 4 solo si es imprescindible"],
      "fecha": "dd.mm.aaaa, o 'Por definir' si no se acordó explícitamente en la reunión",
      "encargado": "INERCO, el nombre del cliente, o 'Por definir'",
      "estado": "Cerrado si la acción ya ocurrió o se resuelve en la reunión, Pendiente en cualquier otro caso"
    }
  ],
  "notasRevision": ["dato que la transcripción no permitió confirmar con certeza (nombre incompleto, sigla dudosa, fecha ausente, contenido ininteligible). Si no hay ninguno, deja una lista vacía []."]
}`;
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

async function callGemini(systemPrompt, userPrompt, wantJSON, responseSchema) {
  const resp = await fetch(GEMINI_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, userPrompt, wantJSON, responseSchema }),
  });
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error("Respuesta inválida del servidor.");
  }
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status} al generar el acta.`);
  return data.text;
}

async function runPipeline({ inicialesList, transcriptText, onProgress }) {
  onProgress("Redactando el acta con Gemini...", 0.3);
  const userPrompt = `Transcripción:\n"""\n${transcriptText}\n"""\n\nRedacta el acta siguiendo las reglas del sistema. Responde solo con el JSON.`;
  const raw = await callGemini(systemPromptFinal(inicialesList), userPrompt, true, ACTA_SCHEMA);
  onProgress("Listo", 1);
  return { raw, parsed: tryParseJSON(raw) };
}

/* ---------------------------------------------------------------------- */
/* Generación del .docx final a partir de la plantilla                     */
/* ---------------------------------------------------------------------- */

function directChildren(el, name) {
  return Array.from(el.children).filter((c) => c.namespaceURI === W_NS && c.localName === name);
}

function newWordText(doc, text) {
  const t = doc.createElementNS(W_NS, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = text;
  return t;
}

function setCellText(doc, cell, text) {
  const paras = directChildren(cell, "p");
  let rPrTemplate = null;
  if (paras.length) {
    const runs = directChildren(paras[0], "r");
    if (runs.length) {
      const rPrs = directChildren(runs[0], "rPr");
      if (rPrs.length) rPrTemplate = rPrs[0].cloneNode(true);
    }
  }
  for (const p of paras) cell.removeChild(p);
  const newP = doc.createElementNS(W_NS, "w:p");
  const newR = doc.createElementNS(W_NS, "w:r");
  if (rPrTemplate) newR.appendChild(rPrTemplate);
  newR.appendChild(newWordText(doc, text));
  newP.appendChild(newR);
  cell.appendChild(newP);
}

function addParagraphToCell(doc, cell, text, bold) {
  const newP = doc.createElementNS(W_NS, "w:p");
  const newR = doc.createElementNS(W_NS, "w:r");
  if (bold) {
    const rPr = doc.createElementNS(W_NS, "w:rPr");
    rPr.appendChild(doc.createElementNS(W_NS, "w:b"));
    newR.appendChild(rPr);
  }
  newR.appendChild(newWordText(doc, text));
  newP.appendChild(newR);
  cell.appendChild(newP);
}

async function generarDocx(datos) {
  const resp = await fetch(TEMPLATE_URL);
  if (!resp.ok) throw new Error("No se pudo cargar la plantilla institucional (assets/plantilla_base_acta.docx).");
  const buf = await resp.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  const xmlText = await entry.async("string");
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  const tables = directChildren(body, "tbl");
  if (tables.length < 5) {
    throw new Error(`La plantilla tiene ${tables.length} tablas y se esperaban 5 (título, identificación, objetivo, participantes, cuerpo).`);
  }

  // Tabla 2: identificación
  const t2rows = directChildren(tables[1], "tr");
  const r0 = directChildren(t2rows[0], "tc");
  const r1 = directChildren(t2rows[1], "tc");
  const r2 = directChildren(t2rows[2], "tc");
  setCellText(doc, r0[2], datos.proyecto || "Por definir");
  setCellText(doc, r1[4], String(datos.actaNumero || "Por definir"));
  setCellText(doc, r1[2], datos.lugar || "Reunión Teams");
  setCellText(doc, r2[2], datos.fecha || "Por definir");
  setCellText(doc, r2[3], "Hora Inicio: " + (datos.horaInicio || "Por definir"));
  setCellText(doc, r2[4], "Hora Término: " + (datos.horaTermino || "Por definir"));

  // Tabla 3: objetivo
  const t3rows = directChildren(tables[2], "tr");
  setCellText(doc, directChildren(t3rows[1], "tc")[0], datos.objetivo || "Por definir");

  // Tabla 4: participantes (fila 1 = cabecera, fila 2 = plantilla a clonar)
  const t4 = tables[3];
  const t4rows = directChildren(t4, "tr");
  const templateRow4 = t4rows[1];
  for (const p of datos.participantes) {
    const newRow = templateRow4.cloneNode(true);
    const cells = directChildren(newRow, "tc");
    setCellText(doc, cells[0], p.nombre);
    setCellText(doc, cells[1], p.iniciales);
    setCellText(doc, cells[2], p.empresa);
    setCellText(doc, cells[3], p.modalidad);
    t4.insertBefore(newRow, templateRow4);
  }
  for (let i = t4rows.length - 1; i >= 1; i--) t4.removeChild(t4rows[i]);

  // Tabla 5: cuerpo / temas (fila 1 = cabecera, fila 2 = plantilla a clonar)
  const t5 = tables[4];
  const t5rows = directChildren(t5, "tr");
  const templateRow5 = t5rows[1];
  for (const tema of datos.temas) {
    const newRow = templateRow5.cloneNode(true);
    const cells = directChildren(newRow, "tc");
    const temaCell = cells[0];
    for (const p of directChildren(temaCell, "p")) temaCell.removeChild(p);
    addParagraphToCell(doc, temaCell, tema.titulo, true);
    for (const parrafo of tema.parrafos) addParagraphToCell(doc, temaCell, parrafo, false);
    setCellText(doc, cells[1], String(tema.fecha || "Por definir"));
    setCellText(doc, cells[2], tema.encargado || "Por definir");
    setCellText(doc, cells[3], tema.estado || "Pendiente");
    t5.insertBefore(newRow, templateRow5);
  }
  for (let i = t5rows.length - 1; i >= 1; i--) t5.removeChild(t5rows[i]);

  let newXml = new XMLSerializer().serializeToString(doc);
  if (!newXml.startsWith("<?xml")) {
    newXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + newXml;
  }
  zip.file("word/document.xml", newXml);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function actaToPlainText(datos) {
  const lines = [];
  lines.push("BLOQUE 1 — IDENTIFICACIÓN");
  lines.push(`Proyecto: ${datos.proyecto || "Por definir"}`);
  lines.push(`Lugar: ${datos.lugar || "Reunión Teams"}`);
  lines.push(`Fecha: ${datos.fecha || "Por definir"}`);
  lines.push(`Hora Inicio: ${datos.horaInicio || "Por definir"}   Hora Término: ${datos.horaTermino || "Por definir"}`);
  lines.push(`Acta N°: ${datos.actaNumero || "Por definir"}`);
  lines.push("");
  lines.push("BLOQUE 2 — OBJETIVO");
  lines.push(datos.objetivo || "Por definir");
  lines.push("");
  lines.push("BLOQUE 3 — PARTICIPANTES");
  lines.push("Nombre y apellido | Iniciales | Empresa | Modalidad");
  for (const p of datos.participantes) {
    lines.push(`${p.nombre} | ${p.iniciales} | ${p.empresa} | ${p.modalidad}`);
  }
  lines.push("");
  lines.push("BLOQUE 4 — CUERPO");
  for (const tema of datos.temas) {
    lines.push(`TEMA: ${tema.titulo}`);
    for (const par of tema.parrafos) lines.push(par);
    lines.push(`Fecha de entrega: ${tema.fecha || "Por definir"} | Encargado: ${tema.encargado || "Por definir"} | Estado: ${tema.estado || "Pendiente"}`);
    lines.push("");
  }
  lines.push("NOTAS DE REVISIÓN — ELIMINAR ANTES DE DISTRIBUIR");
  if (datos.notasRevision.length === 0) lines.push("Sin observaciones.");
  else for (const n of datos.notasRevision) lines.push(`- ${n}`);
  return lines.join("\n");
}

/* ---------------------------------------------------------------------- */
/* DOM / UI                                                                 */
/* ---------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.innerHTML = "";
  if (!text) return;
  const div = document.createElement("div");
  div.className = "status-msg" + (kind ? " " + kind : "");
  div.textContent = text;
  el.appendChild(div);
}

function renderParticipants() {
  const tbody = $("participants-tbody");
  tbody.innerHTML = "";
  state.participants.forEach((p, idx) => {
    const tr = document.createElement("tr");

    const tdNombre = document.createElement("td");
    const inNombre = document.createElement("input");
    inNombre.type = "text";
    inNombre.value = p.nombre;
    inNombre.addEventListener("input", () => (state.participants[idx].nombre = inNombre.value));
    tdNombre.appendChild(inNombre);

    const tdIni = document.createElement("td");
    const inIni = document.createElement("input");
    inIni.type = "text";
    inIni.value = p.iniciales;
    inIni.addEventListener("input", () => (state.participants[idx].iniciales = inIni.value.toUpperCase()));
    tdIni.appendChild(inIni);

    const tdEmpresa = document.createElement("td");
    const inEmpresa = document.createElement("input");
    inEmpresa.type = "text";
    inEmpresa.value = p.empresa;
    inEmpresa.addEventListener("input", () => (state.participants[idx].empresa = inEmpresa.value));
    tdEmpresa.appendChild(inEmpresa);

    const tdModalidad = document.createElement("td");
    const selMod = document.createElement("select");
    ["Telemático", "Presencial"].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (p.modalidad === opt) o.selected = true;
      selMod.appendChild(o);
    });
    selMod.addEventListener("change", () => (state.participants[idx].modalidad = selMod.value));
    tdModalidad.appendChild(selMod);

    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    const btnDel = document.createElement("button");
    btnDel.className = "link";
    btnDel.textContent = "✕";
    btnDel.title = "Quitar";
    btnDel.addEventListener("click", () => {
      state.participants.splice(idx, 1);
      renderParticipants();
    });
    tdActions.appendChild(btnDel);

    tr.append(tdNombre, tdIni, tdEmpresa, tdModalidad, tdActions);
    tbody.appendChild(tr);
  });
}

function renderTemas() {
  const wrap = $("temas-list");
  wrap.innerHTML = "";
  state.temas.forEach((tema, idx) => {
    const card = document.createElement("div");
    card.className = "tema-card";

    const top = document.createElement("div");
    top.className = "tema-top";
    const inTitulo = document.createElement("input");
    inTitulo.type = "text";
    inTitulo.value = tema.titulo;
    inTitulo.style.fontWeight = "600";
    inTitulo.addEventListener("input", () => (state.temas[idx].titulo = inTitulo.value));
    const btnDel = document.createElement("button");
    btnDel.className = "link";
    btnDel.textContent = "Quitar tema";
    btnDel.addEventListener("click", () => {
      state.temas.splice(idx, 1);
      renderTemas();
    });
    top.append(inTitulo, btnDel);

    const taParrafos = document.createElement("textarea");
    taParrafos.rows = 3;
    taParrafos.style.marginTop = "8px";
    taParrafos.value = tema.parrafos.join("\n");
    taParrafos.addEventListener("input", () => {
      state.temas[idx].parrafos = taParrafos.value.split("\n").map((s) => s.trim()).filter(Boolean);
    });

    const row = document.createElement("div");
    row.className = "tema-row";

    const fFecha = document.createElement("div");
    fFecha.innerHTML = `<label>Fecha de entrega</label>`;
    const inFecha = document.createElement("input");
    inFecha.type = "text";
    inFecha.value = tema.fecha;
    inFecha.addEventListener("input", () => (state.temas[idx].fecha = inFecha.value));
    fFecha.appendChild(inFecha);

    const fEncargado = document.createElement("div");
    fEncargado.innerHTML = `<label>Encargado</label>`;
    const inEncargado = document.createElement("input");
    inEncargado.type = "text";
    inEncargado.value = tema.encargado;
    inEncargado.addEventListener("input", () => (state.temas[idx].encargado = inEncargado.value));
    fEncargado.appendChild(inEncargado);

    const fEstado = document.createElement("div");
    fEstado.innerHTML = `<label>Estado</label>`;
    const selEstado = document.createElement("select");
    ["Pendiente", "Cerrado"].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (tema.estado === opt) o.selected = true;
      selEstado.appendChild(o);
    });
    selEstado.addEventListener("change", () => (state.temas[idx].estado = selEstado.value));
    fEstado.appendChild(selEstado);

    row.append(fFecha, fEncargado, fEstado);
    card.append(top, taParrafos, row);
    wrap.appendChild(card);
  });
}

function renderNotas() {
  const wrap = $("notas-list");
  wrap.innerHTML = "";
  state.notasRevision.forEach((nota, idx) => {
    const li = document.createElement("li");
    const ta = document.createElement("textarea");
    ta.rows = 1;
    ta.value = nota;
    ta.addEventListener("input", () => (state.notasRevision[idx] = ta.value));
    const btnDel = document.createElement("button");
    btnDel.className = "link";
    btnDel.textContent = "✕";
    btnDel.addEventListener("click", () => {
      state.notasRevision.splice(idx, 1);
      renderNotas();
    });
    li.append(ta, btnDel);
    wrap.appendChild(li);
  });
}

function fillIfEmpty(id, value) {
  const el = $(id);
  if (!el.value.trim() && value && String(value).trim()) el.value = String(value).trim();
}

function collectDatos() {
  return {
    proyecto: $("f-proyecto").value.trim(),
    actaNumero: $("f-acta-numero").value.trim(),
    lugar: $("f-lugar").value.trim() || "Reunión Teams",
    fecha: $("f-fecha").value.trim(),
    horaInicio: $("f-hora-inicio").value.trim(),
    horaTermino: $("f-hora-termino").value.trim(),
    objetivo: $("r-objetivo").value.trim(),
    participantes: state.participants,
    temas: state.temas,
    notasRevision: state.notasRevision,
  };
}

/* ---------------------------------------------------------------------- */
/* Manejo de archivo subido                                                */
/* ---------------------------------------------------------------------- */

async function handleFile(file) {
  const status = $("file-status");
  setStatus(status, "Leyendo archivo...", null);
  try {
    let turns = [];
    if (/\.docx$/i.test(file.name)) {
      const lines = await extractDocxParagraphs(file);
      const { turns: t, headerLines } = parseTeamsDocxLines(lines);
      turns = t;
      if (!$("f-fecha").value) {
        const fecha = extractFechaFromHeader(headerLines);
        if (fecha) $("f-fecha").value = fecha;
      }
      if (!$("f-hora-inicio").value) {
        const hi = extractHoraInicioFromHeader(headerLines);
        if (hi) $("f-hora-inicio").value = hi;
      }
      if (!$("f-hora-termino").value && $("f-hora-inicio").value && turns.length) {
        const lastTs = turns[turns.length - 1].ts;
        const secs = parseOffsetToSeconds(lastTs);
        const ht = addSecondsToHora($("f-hora-inicio").value, secs);
        if (ht) $("f-hora-termino").value = ht;
      }
    } else if (/\.vtt$/i.test(file.name)) {
      const text = await file.text();
      turns = parseVTT(text);
    } else {
      throw new Error("Formato no soportado. Sube un archivo .docx o .vtt.");
    }

    if (!turns.length) {
      throw new Error("No se detectaron intervenciones en el archivo. Revisa que sea una transcripción de Teams (.docx) o un .vtt con hablantes identificados.");
    }

    state.turns = turns;
    state.participants = buildParticipants(turns);
    renderParticipants();
    $("participants-wrap").classList.remove("hidden");
    $("file-drop").classList.add("has-file");
    $("file-drop-label").textContent = `Archivo cargado: ${file.name} (${turns.length} intervenciones, ${state.participants.length} participantes)`;
    $("btn-generate").disabled = false;
    setStatus(status, "", null);

    // Si ya había un acta generada de un archivo anterior, se descarta: corresponde a otra transcripción.
    state.temas = [];
    state.notasRevision = [];
    $("r-objetivo").value = "";
    $("panel-resultado").classList.add("hidden");
    setStatus($("generate-status"), "", null);
  } catch (err) {
    console.error(err);
    setStatus(status, err.message || String(err), "error");
    $("btn-generate").disabled = true;
  }
}

/* ---------------------------------------------------------------------- */
/* Generar acta                                                            */
/* ---------------------------------------------------------------------- */

async function onGenerate() {
  const btn = $("btn-generate");
  const progressArea = $("progress-area");
  const progressBar = $("progress-bar");
  const progressText = $("progress-text");
  const genStatus = $("generate-status");

  btn.disabled = true;
  progressArea.classList.remove("hidden");
  setStatus(genStatus, "", null);

  const onProgress = (text, frac) => {
    progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    progressText.textContent = text;
  };

  try {
    if (!state.participants.length) throw new Error("No hay participantes detectados todavía.");
    const inicialesList = state.participants.map((p) => `${p.iniciales} = ${p.nombre}`).join("; ");
    const transcriptText = buildTranscriptText(state.turns, state.participants);

    const { raw, parsed } = await runPipeline({ inicialesList, transcriptText, onProgress });

    if (!parsed) {
      setStatus(
        genStatus,
        "El modelo no devolvió un JSON válido. Revisa el resultado bruto abajo, o intenta de nuevo (a veces basta con reintentar).",
        "error"
      );
      console.warn("Respuesta cruda del modelo:", raw);
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.style.fontSize = "0.8rem";
      pre.textContent = raw;
      genStatus.appendChild(pre);
      return;
    }

    // Completa los datos administrativos solo si el usuario no los escribió a mano
    // y la extracción del .docx tampoco los encontró — nunca pisa lo que ya hay.
    fillIfEmpty("f-proyecto", parsed.proyecto);
    fillIfEmpty("f-acta-numero", parsed.actaNumero);
    fillIfEmpty("f-fecha", parsed.fecha);
    fillIfEmpty("f-hora-inicio", parsed.horaInicio);
    fillIfEmpty("f-hora-termino", parsed.horaTermino);

    state.temas = (parsed.temas || []).map((t) => ({
      titulo: t.titulo || "",
      parrafos: Array.isArray(t.parrafos) ? t.parrafos : [String(t.parrafos || "")],
      fecha: t.fecha || "Por definir",
      encargado: t.encargado || "Por definir",
      estado: t.estado === "Cerrado" ? "Cerrado" : "Pendiente",
    }));
    state.notasRevision = Array.isArray(parsed.notasRevision) ? parsed.notasRevision : [];
    $("r-objetivo").value = parsed.objetivo || "";

    renderTemas();
    renderNotas();
    $("panel-resultado").classList.remove("hidden");
    $("panel-resultado").scrollIntoView({ behavior: "smooth" });
    setStatus(genStatus, "Borrador generado. Revísalo antes de descargar.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(genStatus, err.message || String(err), "error");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------------- */
/* Descarga / copia                                                        */
/* ---------------------------------------------------------------------- */

async function onDownloadDocx() {
  const status = $("result-status");
  setStatus(status, "Generando Word...", null);
  try {
    const datos = collectDatos();
    const blob = await generarDocx(datos);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const nombreProyecto = (datos.proyecto || "acta").replace(/[^\w\-]+/g, "_").slice(0, 60);
    a.href = url;
    a.download = `Acta_${nombreProyecto}_N${datos.actaNumero || "SD"}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(status, "Descarga iniciada.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(status, err.message || String(err), "error");
  }
}

async function onCopyText() {
  const status = $("result-status");
  try {
    const datos = collectDatos();
    await navigator.clipboard.writeText(actaToPlainText(datos));
    setStatus(status, "Acta copiada al portapapeles.", "ok");
  } catch (err) {
    setStatus(status, "No se pudo copiar automáticamente. Selecciona y copia manualmente desde la vista previa.", "warn");
  }
}

/* ---------------------------------------------------------------------- */
/* Inicialización                                                          */
/* ---------------------------------------------------------------------- */

function init() {
  const drop = $("file-drop");
  const fileInput = $("f-file");
  drop.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $("btn-add-participant").addEventListener("click", () => {
    state.participants.push({ nombre: "", iniciales: "", empresa: "", modalidad: "Telemático" });
    renderParticipants();
  });

  $("btn-generate").addEventListener("click", onGenerate);

  $("btn-add-tema").addEventListener("click", () => {
    state.temas.push({ titulo: "", parrafos: [""], fecha: "Por definir", encargado: "", estado: "Pendiente" });
    renderTemas();
  });

  $("btn-add-nota").addEventListener("click", () => {
    state.notasRevision.push("");
    renderNotas();
  });

  $("btn-download-docx").addEventListener("click", onDownloadDocx);
  $("btn-copy-text").addEventListener("click", onCopyText);
}

init();
