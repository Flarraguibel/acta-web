// Prueba de extracción estructurada de RCA/ICSARA con Gemini.
// Recibe un PDF (base64) y devuelve los datos clave ya estructurados.
// Misma API key que generar-acta.mjs (variable de entorno de Vercel).

const DEFAULT_MODEL = "gemini-3.6-flash";

// Los PDF de RCA pueden ser largos (cientos de páginas) y Gemini tarda más en
// procesarlos; el límite por defecto de Vercel se queda corto.
export const config = { maxDuration: 60 };

const SCHEMA = {
  type: "OBJECT",
  properties: {
    tipoDocumento: { type: "STRING", enum: ["RCA", "ICSARA", "Otro"] },
    proyecto: { type: "STRING" },
    titular: { type: "STRING" },
    region: { type: "STRING" },
    tipoEvaluacion: { type: "STRING", enum: ["EIA", "DIA", "No especificado"] },
    sectorProductivo: { type: "STRING" },
    fechaDocumento: { type: "STRING" },
    resultado: { type: "STRING", enum: ["Aprobado", "Aprobado con condiciones", "Rechazado", "No aplica"] },
    condicionesExigencias: { type: "ARRAY", items: { type: "STRING" } },
    componentesAmbientales: { type: "ARRAY", items: { type: "STRING" } },
    normativaCitada: { type: "ARRAY", items: { type: "STRING" } },
    plazosCumplimiento: { type: "ARRAY", items: { type: "STRING" } },
    observaciones: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          organismo: { type: "STRING" },
          tema: { type: "STRING" },
          resumen: { type: "STRING" },
        },
        required: ["organismo", "tema", "resumen"],
      },
    },
  },
  required: ["tipoDocumento", "proyecto", "resultado", "condicionesExigencias", "componentesAmbientales", "observaciones"],
};

const SYSTEM_PROMPT = `Eres un asistente que estructura documentos del SEIA (Sistema de Evaluación de Impacto Ambiental de Chile) para un equipo de consultoría ambiental. El documento es la única fuente de verdad: si un dato no está en él, no lo inventes, deja el campo vacío ("" o lista vacía []).

- "condicionesExigencias": solo si el documento es una RCA. Cada condición/exigencia impuesta al titular, como frase corta y concreta, conservando cifras y referencias técnicas exactas.
- "componentesAmbientales": los componentes evaluados o afectados que el documento trata explícitamente (ej. "Calidad del aire", "Ruido", "Flora y vegetación", "Fauna", "Medio Humano", "Patrimonio cultural", "Recursos hídricos"). Usa los nombres tal como los usa el documento, no una lista fija.
- "normativaCitada": leyes, decretos, normas o artículos citados explícitamente.
- "plazosCumplimiento": plazos concretos asociados a condiciones (ej. "180 días desde la RCA para presentar plan de manejo").
- "observaciones": solo si el documento es un ICSARA. Cada observación/consulta que un organismo hace al titular: quién la hace (organismo), sobre qué tema/componente, y un resumen breve (una o dos frases) de qué se pide o cuestiona. No transcribas texto largo.
- No inventes resultado, plazos ni cifras que no estén explícitos en el documento.`;

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Método no permitido, usa POST." }, 405);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: "GEMINI_API_KEY no está configurada en Vercel." }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Cuerpo de la petición inválido, se esperaba JSON." }, 400);
    }

    const { pdfBase64 } = body || {};
    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return jsonResponse({ error: "Falta 'pdfBase64' en la petición." }, 400);
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: "Estructura este documento del SEIA siguiendo las instrucciones del sistema. Responde solo con el JSON." },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    };

    let geminiResp;
    try {
      geminiResp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return jsonResponse({ error: "No se pudo contactar a la API de Gemini: " + e.message }, 502);
    }

    let data;
    try {
      data = await geminiResp.json();
    } catch (e) {
      return jsonResponse({ error: "Respuesta no válida de la API de Gemini." }, 502);
    }

    if (!geminiResp.ok) {
      return jsonResponse(
        { error: data?.error?.message || `Error ${geminiResp.status} de la API de Gemini.` },
        geminiResp.status
      );
    }

    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) {
      const reason = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : "";
      return jsonResponse({ error: "Gemini no devolvió texto" + reason + "." }, 502);
    }

    return jsonResponse({ text });
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
