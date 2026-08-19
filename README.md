# Generador de actas INERCO Chile — web

Web que convierte una transcripción de reunión (.docx de Teams o .vtt) en un
borrador de acta con el formato institucional de INERCO Chile, y lo descarga
como Word listo para revisar.

## Cómo funciona

1. El archivo subido (.docx/.vtt) se procesa con JavaScript en el propio
   navegador de quien lo usa.
2. El texto de la transcripción se envía a una función del servidor
   (`api/generar-acta.mjs`), que llama a la **API de Gemini** (Google) para
   redactar el borrador. La API key vive solo en esa función, como variable
   de entorno de Vercel — nunca está en el HTML/JS que ve el navegador, así
   que nadie puede robarla mirando el código de la página.
3. El Word final se genera rellenando la plantilla institucional real
   (`assets/plantilla_base_acta.docx`) en el navegador.

**Importante — el contenido de la reunión sí sale de la empresa.** El texto
de la transcripción se manda a la API de Gemini para poder redactar rápido
y con buena calidad, sin que nadie tenga que descargar nada pesado. Con la
key del **tier gratuito** de Google AI Studio, Google puede usar esas
conversaciones para mejorar sus productos (no hay el mismo nivel de
aislamiento de datos que en un plan de pago/empresarial). Antes de usarla
con transcripciones de reuniones con información sensible de clientes o de
proyectos SEIA, conviene confirmarlo con tu tutor o con IT.

## Publicar en Vercel (ya tienes cuenta, se usa la misma que el panel de proyectos)

### Paso 1 — Conseguir la API key de Gemini gratis

1. Entra a [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   con una cuenta de Google.
2. Clic en **"Create API key"**. No pide tarjeta para el tier gratuito.
3. Copia la key (empieza con `AIza...`).

### Paso 2 — Desplegar la carpeta

La forma más simple, sin git ni instalar nada:

1. Entra a [vercel.com/drop](https://vercel.com/drop) ya logueado con tu
   cuenta.
2. Arrastra la carpeta `acta-web` completa (incluye `api/generar-acta.mjs`
   — Vercel lo detecta automáticamente como función serverless, sin
   configuración extra).
3. Elige el equipo/cuenta, ponle un nombre al proyecto y confirma.
4. Vercel te da un link tipo `https://tu-proyecto.vercel.app`.

### Paso 3 — Configurar la key

1. En el proyecto recién creado: **Settings → Environment Variables**.
2. Agrega:
   - `GEMINI_API_KEY` = la key del paso 1.
   - (Opcional) `GEMINI_MODEL` = `gemini-2.0-flash` (valor por defecto si
     no la defines; se puede subir a un modelo más nuevo más adelante sin
     tocar código).
3. Como la variable se agregó después del deploy, hace falta un redeploy
   para que la tome: **Deployments → (los tres puntos del último deploy) →
   Redeploy**.
4. Prueba subiendo una transcripción real y generando un acta. Si algo
   falla, en el proyecto de Vercel: **Deployments → el deploy activo →
   Functions → generar-acta** muestra los logs con el error exacto (por
   ejemplo, si la key no quedó bien configurada).

**Nota sobre actualizaciones futuras:** cada vez que arrastras la carpeta a
`vercel.com/drop` se crea un **proyecto nuevo** (con su propio link), no
actualiza el que ya existe. Para poder actualizar el mismo link con solo
subir cambios, lo mejor es conectar el proyecto a un repositorio de GitHub
(Project Settings → Git) — así cada push actualiza el sitio automáticamente,
igual que el panel de proyectos.

## Probarla en tu propio PC antes de publicar cambios

Para probar cambios de código antes de subirlos, usa la extensión **"Live
Server"** de VS Code — pero ten en cuenta que Live Server **no ejecuta la
función serverless**, así que el botón "Generar acta" fallará en local
(llamará a una función que no existe). Para probar el flujo completo hace
falta la Vercel CLI (`vercel dev`), que si sirve las funciones localmente —
opcional, solo necesario si vas a tocar `api/generar-acta.mjs`.

## Reemplazar la plantilla oficial

Si el equipo consigue la plantilla Word oficial de INERCO en blanco (sin
datos de ningún proyecto), reemplaza el archivo `assets/plantilla_base_acta.docx`
por esa plantilla, manteniendo el mismo nombre. La estructura interna debe
conservar las 5 tablas del original (título, identificación, objetivo,
participantes, cuerpo) en ese orden.

## Estructura

```
acta-web/
├── index.html                       <- interfaz
├── styles.css                        <- estilos
├── app.js                             <- parseo de transcripción, llamada a Gemini, generación del Word
├── api/
│   └── generar-acta.mjs               <- función servidor: llama a Gemini, guarda la API key
├── assets/
│   └── plantilla_base_acta.docx       <- plantilla institucional
└── README.md
```
