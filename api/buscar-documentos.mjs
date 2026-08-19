// Dado un id_expediente del SEIA, encuentra sus documentos RCA e ICSARA.
// Puerto a JS del mismo mecanismo probado en Get-DocumentosSEIA.ps1:
// seia.sea.gob.cl carga la tabla de documentos por un endpoint interno
// (xhr_busqueda_expediente.php) que no requiere login ni navegador.

export const config = { maxDuration: 30 };

const TIPOS_INTERES = [
  { etiqueta: "RCA", patron: /Resoluci.n de Calificaci.n Ambiental/i },
  { etiqueta: "ICSARA", patron: /aclaraciones, rectificaciones/i },
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const idExpediente = url.searchParams.get("id_expediente");
    if (!idExpediente || !/^\d+$/.test(idExpediente)) {
      return jsonResponse({ error: "Falta 'id_expediente' (numérico) en la petición." }, 400);
    }

    const seiaUrl = `https://seia.sea.gob.cl/expediente/xhr_busqueda_expediente.php?id_expediente=${idExpediente}`;
    let html;
    try {
      const resp = await fetch(seiaUrl);
      if (!resp.ok) {
        return jsonResponse({ error: `El SEA respondió ${resp.status} al consultar el expediente.` }, 502);
      }
      html = await resp.text();
    } catch (e) {
      return jsonResponse({ error: "No se pudo contactar a seia.sea.gob.cl: " + e.message }, 502);
    }

    const filas = html.split(/(?=<tr[\s>])/).filter((f) => /<tr[\s>]/.test(f));
    const documentos = [];
    for (const fila of filas) {
      const m = fila.match(/<td class='td-primary'><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      if (!m) continue;
      const docUrl = decodeHtml(m[1]);
      const tipo = decodeHtml(m[2]).trim();
      const fechaMatch = fila.match(/class='dt-type-numeric'>([^<]+)</);
      const fecha = fechaMatch ? fechaMatch[1].trim() : "";

      const encontrado = TIPOS_INTERES.find((t) => t.patron.test(tipo));
      if (encontrado) {
        documentos.push({ etiqueta: encontrado.etiqueta, tipo, fecha, url: docUrl });
      }
    }

    return jsonResponse({ totalDocumentosExpediente: filas.length, documentos });
  },
};

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
