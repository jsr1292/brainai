Read in English: [docs/ARCHITECTURE.md](../ARCHITECTURE.md)

# Cómo está construida la memoria

Un proceso de Node (TypeScript, Express 5) con una base de datos SQLite (better-sqlite3), en un contenedor de Docker detrás de un
túnel de Cloudflare. Todo lo que muestra el panel se renderiza en el servidor; el navegador solo ejecuta scripts pequeños.

## Las piezas

| Carpeta | Qué hace |
|---|---|
| `src/index.ts`, `src/cli.ts` | Arrancan el servidor; la línea de comandos del dueño (contraseña, autenticador, clientes, redirecciones, exportación). |
| `src/config.ts` | Todos los ajustes, leídos del entorno (`.env.example` los enumera). |
| `src/db.ts` | Abre la base de datos y ejecuta las migraciones numeradas, después de copiar el archivo en `data/pre-migrate/`. |
| `src/auth/` | OAuth para las apps (registro, consentimiento, tokens), la contraseña y el autenticador del dueño, las sesiones, el límite de intentos de inicio de sesión. |
| `src/mcp/` | El servidor MCP: las herramientas que ve cada app y las instrucciones que recibe, según el nivel de acceso. |
| `src/memory/` | Datos: guardar, recuperar (búsqueda por palabras clave y por embeddings), duplicados, sustitución, rechazo de secretos, resúmenes y hojas de ruta. |
| `src/learning/` | Las cinco áreas con las que se revisa cada proyecto (el trabajo está a salvo, línea de meta, automatización, alertas, mantenimiento), "ahora no", los temas del manual del dueño y los recuentos semanales del Mapa. |
| `src/pages/` | Páginas: documentos Markdown con secciones, historial, comprobaciones de frescura y la exportación a Markdown. |
| `src/projects/` | Proyectos, sus alias y dónde vive cada uno (carpetas que comunican tus ordenadores). |
| `src/review/`, `src/growth/` | La revisión semanal y las sugerencias de perfil que esperan aprobación. |
| `src/discussions/` | Debates: una pregunta, varios asistentes, respondida por rondas. |
| `src/skills/` | Habilidades compartidas, sus versiones y propuestas, y mantenerlas sincronizadas con un ordenador. |
| `src/images/` | Imágenes en las páginas: comprobadas byte a byte, sin metadatos, servidas desde `data/images`. |
| `src/folders/` | Tokens de dispositivo y los informes que envía un ordenador sobre las carpetas de sus proyectos. |
| `src/setup/` | El texto de configuración de cada app, con las líneas del overlay del dueño añadidas. |
| `src/web/` | El panel: rutas, vistas y los archivos estáticos. |
| `scripts/` | Tareas del lado del host: copia nocturna, copia a git, exportación a Markdown, copia externa semanal, el informador del ordenador. |

## Cosas que conviene saber

- **Los embeddings se ejecutan en la app,** con un modelo local descargado al compilar (EmbeddingGemma-300m por defecto,
  multilingual-e5-small con `EMBED_MODEL=e5`), así que la recuperación funciona sin conexión y ningún texto sale del servidor. Cada modelo tiene
  sus propios umbrales de similitud (`src/memory/embeddingProfile.ts`).
- **Las migraciones solo van hacia delante.** Cada una está numerada y se ejecuta una sola vez; antes se copia la base de datos y se
  conservan las tres copias más recientes.
- **El overlay** (`overlay/`) es el único lugar para los textos propios del dueño y los ajustes de los scripts; el código nunca escribe en él.
- **Las pruebas** usan el ejecutor de pruebas de Node (`npm test`), un proceso por archivo, con una base de datos en memoria y un
  generador de embeddings simulado, salvo que una prueba diga otra cosa.
