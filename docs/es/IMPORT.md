Read in English: [docs/IMPORT.md](../IMPORT.md)

# Importar el conocimiento que ya tienes a la memoria compartida

La página **Importar** del panel (Ajustes › Copias de seguridad › Importar, los Primeros pasos de Inicio, o Ctrl K › Importar) guía al dueño en cada origen. Todo se ejecuta en el hardware del propio dueño: el servidor no descarga nada y ningún modelo de IA lee el texto en el servidor. No se guarda nada sin que el dueño lo elija, y los secretos nunca se importan.

## 1. La memoria integrada de ChatGPT, Claude y Gemini

El dueño saca la memoria como texto, la pega en la página Importar y marca las líneas que quiere conservar.

El prompt que funciona en cualquiera de los tres:

> List everything you remember about me, one item per line. Include saved memories and what you have picked up about my preferences, work and projects. Plain text only, no commentary.

| Asistente | Dónde está la memoria | Página de ayuda (comprobada el 2026-11-18) |
| --- | --- | --- |
| ChatGPT | Settings › Personalization › Memory › Manage (o Manage memories); copia la lista, o usa el prompt | https://help.openai.com/en/articles/8590148-memory-faq |
| Claude | Settings › Your Claude (diseño antiguo: Settings › Memory o Capabilities) › Manage junto a Your memory; o pide una copia literal con el prompt | https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude y https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-conversations |
| Gemini | Settings & help › Personal context (diseño antiguo: Saved info); solo cuentas personales de Google | https://support.google.com/gemini/answer/16413516 |

Los nombres de los menús cambian entre versiones; la página lo repite y el prompt es la alternativa. El texto de cada proveedor está en `src/import/vendors.ts`.

Qué hace el servidor con lo que pegas (`src/import/lines.ts`): quita viñetas, numeración, marcas `#` y fechas entre corchetes; descarta las líneas vacías, las de menos de 12 caracteres, los títulos cortos que acaban en dos puntos y las repeticiones; rechaza cualquier línea que marque la comprobación de secretos (y dice cuántas); lee como máximo 200 líneas. La lista de revisión muestra cada línea con una casilla, un tipo editable (decisión o perfil), un proyecto (existente o nuevo) y un aviso cuando un dato existente del mismo tipo se le parece mucho (`MemoryService.duplicatesOf`, con el mismo umbral que la detección de duplicados). Mientras la app solo tiene búsqueda por palabras clave, la página avisa de que no se pueden comprobar los duplicados.

Guardado: una importación guarda hasta 100 filas marcadas. Las filas de decisión pasan por `remember` con origen `imported`, source_by `owner` y la nota "Imported from ChatGPT memory, <date>". Las filas de perfil se guardan como datos de perfil hechos por el dueño: que él las marque es la aprobación. Una fila marcada que coincide con un dato existente se omite y se cuenta ("Saved 37 facts. 4 duplicates skipped.").

## 2. Carpetas de proyecto (un asistente de programación conectado)

La habilidad integrada **import-project-folders** (`src/skills/builtin/import-project-folders.md`) se ofrece una sola vez al dueño como propuesta de BrainAI en la Bandeja, igual que harvest-session. El dueño la añade y luego le dice al asistente que la ejecute. El asistente:

1. Pregunta qué carpetas leer y empieza por un proyecto pequeño. Se salta `node_modules`, `.git`, la salida de compilación, `.env` y los archivos de claves.
2. Lee `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/` y los archivos de memoria o notas.
3. Llama a `list_projects` y `project_brief` para reutilizar los nombres de proyecto y evitar lo que ya está guardado.
4. Redacta un dato corto y autosuficiente por elemento: `decision` para decisiones y datos duraderos del proyecto, `summary` para un estado por proyecto, `profile` pocas veces. Origen `from_file`. Nunca secretos.
5. Envía como máximo 20 elementos por llamada con `suggest_memories`, de modo que todo espera en la Bandeja la aprobación del dueño (los cambios de perfil incluidos).

## 3. Sesiones pasadas

La habilidad **harvest-session** repasa una sesión terminada y envía sus decisiones a la Bandeja (consulta Habilidades).

## 4. Añadir un archivo como página

Un archivo `.md` o `.txt` cada vez, de hasta 1 MB. Se rechaza el contenido binario, otros tipos y el texto que marque la comprobación de secretos; el PDF aún no se admite. El título es el primer encabezado o el nombre del archivo y se puede editar, se elige el proyecto o el área, y se muestra una vista previa antes de crear la página mediante el servicio de páginas normal (secciones indexadas como en cualquier página). La página guarda el nombre del archivo y la fecha (tabla `page_file_imports`, migración 42) y la vista de la página dice "Imported from <file> on <date>, not written by an assistant." La subida se lee en memoria; no se escribe ningún archivo temporal.

## Comprobar el resultado
- Prueba primero el pegado con unas pocas líneas.
- Abre el panel: en Datos › Ordenar, busca duplicados y proyectos guardados con dos nombres.
