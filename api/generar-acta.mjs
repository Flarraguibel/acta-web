// Proxy hacia la API de Gemini: mantiene la API key en el servidor (variable de
// entorno de Vercel), nunca en el navegador. El cliente nunca ve GEMINI_API_KEY.

const DEFAULT_MODEL = "gemini-3.6-flash";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Método no permitido, usa POST." }, 405);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY no está configurada en Vercel (Project Settings → Environment Variables)." },
        500
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Cuerpo de la petición inválido, se esperaba JSON." }, 400);
    }

    const { systemPrompt, userPrompt, wantJSON, responseSchema } = body || {};
    if (!userPrompt || typeof userPrompt !== "string") {
      return jsonResponse({ error: "Falta 'userPrompt' en la petición." }, 400);
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
    if (wantJSON) {
      generationConfig.responseMimeType = "application/json";
      if (responseSchema) generationConfig.responseSchema = responseSchema;
    }

    const payload = {
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig,
    };
    if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

    const MAX_ATTEMPTS = 3;
    let geminiResp, data;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        geminiResp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        return jsonResponse({ error: "No se pudo contactar a la API de Gemini: " + e.message }, 502);
      }

      try {
        data = await geminiResp.json();
      } catch (e) {
        return jsonResponse({ error: "Respuesta no válida de la API de Gemini." }, 502);
      }

      // 503 = modelo sobrecargado del lado de Google, suele resolverse solo en unos segundos.
      const overloaded = geminiResp.status === 503;
      if (!overloaded || attempt === MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
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
    headers: { "Content-Type": "application/json" },
  });
}
