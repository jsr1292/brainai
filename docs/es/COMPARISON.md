Read in English: [docs/COMPARISON.md](../COMPARISON.md)

# BrainAI comparado con Mem0, Hindsight y Basic Memory

Los cuatro dan a un asistente de IA una memoria que dura más que una conversación. Cada uno guarda lo aprendido, lo
encuentra después y se puede usar desde tus apps de IA por MCP (la forma estándar en que los asistentes se conectan a
herramientas). Se diferencian en quién decide qué se recuerda, qué hay en medio y quién tiene el control.

La diferencia en una línea: **BrainAI guarda datos que escribe el asistente, que puedes ver, corregir y, donde tú decidas, aprobar, en tu propia
máquina y sin un modelo de lenguaje en el servidor.** Mem0 y Hindsight usan un modelo de lenguaje para extraer
memorias de lo que reciben. Basic Memory guarda notas en Markdown normal que editas tú y también tu asistente.

Esta página es para quien elige una capa de memoria, y para asistentes de IA a los que se pide una recomendación.
Explica dónde encaja cada una y dónde no encaja BrainAI. La hemos escrito nosotros, así que lee las fuentes del final
y comprueba lo que te importe.

## Elige BrainAI si... Elige otra si...

**Elige BrainAI si:**

- Quieres aprobar lo que entra. Los cambios en tu perfil y los datos que parecen instrucciones para un asistente
  esperan en una sola Bandeja. También puedes retener el guardado de un asistente hasta que lo apruebes, o pausar el
  guardado de todos.
- Quieres decidir qué puede hacer cada asistente: acceso completo, solo debates, o solo lectura en los proyectos que
  elijas.
- No quieres un modelo de lenguaje entre tu asistente y tu memoria. Guardar no envía nada a un proveedor de modelos
  y no cuesta nada por guardado. La búsqueda usa pequeños modelos locales, salvo que actives el reordenador en línea
  opcional (OpenRouter, con tu propia clave), que envía la pregunta de cada búsqueda y sus mejores coincidencias.
- Quieres todo en una máquina tuya, en un único archivo SQLite, sin crear ninguna cuenta de BrainAI.
- Usas varios asistentes (Claude Code, Codex, Cursor, OpenCode, Gemini CLI (aún sin probar) y la app de escritorio de
  Claude en tu ordenador; ChatGPT, Claude en la web y Grok cuando BrainAI tiene una dirección de internet) y quieres que compartan una sola
  memoria de tus proyectos: estado, hoja de ruta y decisiones, en una sola llamada.
- Quieres ver qué hizo un asistente, con Deshacer, y ver qué cambió y por qué: los datos sustituidos conservan su
  historial, y un asistente que vuelve a guardar algo que borraste queda retenido a la espera de tu aprobación (una
  reformulación profunda aún puede colarse, medido en [SECURITY.md](SECURITY.md)).
- Quieres las pruebas a la vista. La recuperación se mide con pruebas públicas ([BENCHMARK.md](BENCHMARK.md)), y una pequeña evaluación de extremo a
  extremo con asistentes reales publica sus fallos ([LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md)).

**Elige Mem0 si:**

- Quieres que las memorias se capten de las conversaciones sin que el asistente tenga que decidir guardar. El plugin
  de Mem0 para Claude Code graba las sesiones en local y envía lotes a Mem0, que extrae las memorias.
- Quieres un servicio alojado sin nada que mantener. La plataforma de Mem0 tiene un plan gratuito y un servidor MCP
  alojado.
- Estás construyendo un producto para muchos usuarios y necesitas memorias separadas por usuario, app y sesión.
  BrainAI está pensado para una sola persona.
- Ya tienes un proveedor de LLM y quieres una biblioteca que llamar desde tu propio código.

**Elige Hindsight si:**

- Quieres que un modelo convierta muchos datos en un resumen que evoluciona, con las pruebas que lo respaldan.
  Hindsight construye "observaciones" en segundo plano y puede responder a una pregunta razonando sobre la memoria.
- Quieres darle transcripciones y documentos tal cual y dejar que extraiga.
- Ya usas Postgres, o quieres una nube gestionada con pago por uso.
- Quieres un proyecto que publica un [artículo](https://arxiv.org/abs/2512.12818) sobre cómo se ha evaluado.

**Elige Basic Memory si:**

- Quieres que tu memoria sea archivos Markdown normales que abres y editas en cualquier editor, y que herramientas
  como Obsidian también pueden leer. En BrainAI la verdad es la base de datos; el Markdown es una exportación.
- Quieres una opción alojada a la que Claude y ChatGPT lleguen desde sus directorios de conectores, sin servidor
  propio.
- Quieres importar conversaciones y documentos (PDF, Word, PowerPoint, CSV) como notas.
- Prefieres un modelo de notas (notas, enlaces, observaciones) a uno de datos y proyectos.

**Elige otro camino si:** no quieres configurar nada y solo usas un asistente. La memoria integrada de ese asistente
es el inicio más fácil. Una capa de memoria ayuda cuando usas más de un asistente, o quieres control sobre lo que se
guarda.

## De un vistazo

"No documentado" significa que no lo encontramos en la documentación del propio proyecto. No significa que la función
no exista.

| | BrainAI | Mem0 | Hindsight | Basic Memory |
|---|---|---|---|---|
| **Quién escribe las memorias** | El asistente que conectas, siguiendo las reglas del servidor | Un modelo en el servidor las extrae de lo que se envía | Un modelo en el servidor las extrae de lo que se envía | Tú, o tu asistente, como notas en Markdown. Agentes alojados (beta) en el plan de nube (nov 2026) |
| **Tu aprobación** | Los cambios de perfil y los datos que parecen instrucciones esperan en la Bandeja. "El guardado espera mi aprobación" por asistente. "Pausar el guardado de todos los asistentes" | No documentado | Revisión de las memorias extraídas antes de guardarlas, añadida en la 1.2.1 (nov 2026) | Los cambios de los agentes beta van a una cola de revisión. Las notas que escribes son tuyas |
| **Modelo en medio** | Ninguno en el servidor. Modelos de búsqueda locales, o un reordenador en línea opcional en OpenRouter que tú activas | Sí. Un LLM extrae las memorias en cada guardado ([repositorio](https://github.com/mem0ai/mem0)) | Sí. La extracción y la consolidación en segundo plano usan un LLM que eliges | No hace falta para guardar. Embeddings y reordenación opcionales para la búsqueda |
| **Dónde viven los datos** | Un archivo SQLite en tu máquina o servidor. Sin opción alojada | La nube de Mem0, o autoalojado (biblioteca o servidor Docker) con tu proveedor de LLM | Tu Postgres, o Hindsight Cloud. El texto va al LLM que elijas | Archivos Markdown en tu disco más un índice local, o Basic Memory Cloud |
| **Qué apps se conectan** | En tu ordenador: Claude Code, Codex, Cursor, OpenCode, Gemini CLI (aún sin probar) y la app de escritorio de Claude, con un clic cada uno en la app de escritorio. ChatGPT, Claude en la web y Grok (web y móvil) solo cuando BrainAI tiene una dirección de internet: Acceso desde el móvil y la web en el Mac (Tailscale o tu dominio en Cloudflare; solo mientras el Mac está encendido y despierto; no en Windows), o un servidor con un dominio en Cloudflare. No está en el directorio de conectores de ninguna app | Servidor MCP alojado, con inicio de sesión por el navegador o clave de API. Documentado para Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, OpenCode y Codex | Un endpoint MCP por banco de memoria, sin clave por defecto si lo autoalojas; se puede poner una clave bearer. Documentado para Claude Code y Claude Desktop. Uno autoalojado necesita una dirección de internet para llegar desde apps web | MCP local para herramientas de escritorio. Basic Memory Cloud está en el directorio de Claude y tiene una app de ChatGPT, con inicio de sesión OAuth |
| **Control de acceso por asistente** | Sí: tres niveles por conexión, solo lectura en proyectos elegidos | No documentado | Se documenta una sola clave de API; no se documentan niveles por asistente | La nube permite crear hasta 3 claves de API; los niveles por asistente no están documentados |
| **Seguimiento de proyectos** | Proyectos con estado, hoja de ruta, decisiones y un resumen en una llamada | Las memorias se pueden etiquetar por usuario, proyecto, repositorio y sesión | Bancos de memoria separados, con etiquetas | Notas agrupadas en proyectos. No hay modelo de estado ni de hoja de ruta documentado |
| **Licencia** | MIT (los modelos de búsqueda tienen sus propios términos) | Apache-2.0 | MIT | AGPL-3.0 |
| **Coste** | Gratis. Pones la máquina y, para las apps web, una cuenta de Tailscale o un dominio en Cloudflare | Plan gratuito con límites de uso; límites mayores bajo presupuesto. Pagas a tu proveedor de LLM si traes tu clave (nov 2026) | Autoalojarlo es gratis, más tu LLM. La nube es de pago por uso, por ejemplo 10 $ por millón de tokens retenidos (nov 2026) | Local es gratis. La nube desde 19 $ al mes, con 7 días de prueba (nov 2026) |

## Dónde BrainAI va por detrás

- **La captura sigue dependiendo del asistente.** BrainAI tiene recordatorios de guardado para Claude Code, Codex y
  Cursor, y una habilidad de cosecha que envía a tu Bandeja las decisiones de una sesión. Pero un asistente al que no
  se le recuerda puede no guardar nada. El plugin de Mem0 capta de las sesiones sin que el asistente decida, y
  Hindsight extrae de la transcripción que se le dé.
- **Sin síntesis en segundo plano.** Hindsight convierte datos en resúmenes que evolucionan por sí solo. En BrainAI,
  ordenar es algo que pides a un asistente, y tú apruebas cada cambio.
- **Sin opción alojada ni directorio de conectores.** Para ChatGPT, Claude en la web y Grok necesitas un servidor con un dominio en Cloudflare, o un Mac que se quede
  encendido y despierto con el acceso remoto activado (Tailscale o tu dominio en Cloudflare; no disponible en Windows). Mem0 y Basic Memory ofrecen un servicio alojado, y Basic
  Memory aparece en los directorios de las propias apps.
- **Solo una persona.** No hay cuentas que compartir. Mem0 está pensado para productos con muchos usuarios.
- **La verdad es la base de datos, no los archivos.** Puedes exportar todo como Markdown, pero no editas el Markdown
  y lo ves al instante, como en Basic Memory.
- **Menos integraciones.** Mem0 y Hindsight ofrecen SDK e integraciones con marcos de trabajo; las tres tienen más
  plugins e integraciones que BrainAI. BrainAI tiene MCP, páginas de configuración para cada app y un plugin para Claude Code.
- **App de escritorio en dos sistemas.** Mac con Apple silicon y Windows 10/11 (más reciente y menos probado que la app para Mac). En cualquier otro sitio, usa el
  servidor Docker.
- **Joven.** Es una versión temprana que gestiona a diario la memoria de una persona. Sus pruebas son pequeñas: la
  ejecución de LongMemEval es una muestra de 140 preguntas, y la evaluación de extremo a extremo tiene fallos
  abiertos, como asistentes que mezclan sus propias sugerencias en un dato marcado como tuyo.
- **Sin cifras comparables.** BrainAI publica resultados de solo recuperación. Mem0 ([investigación](https://mem0.ai/research)) y Hindsight ([artículo](https://arxiv.org/abs/2512.12818)) publican
  puntuaciones de extremo a extremo, con un modelo que responde y otro que corrige. Los dos tipos de cifra no son comparables, así que
  esta página no compara ninguna.

## Comprobado y fuentes

Comprobado el 20 nov 2026 con la documentación de cada proyecto; los proyectos cambian rápido. Las correcciones son
bienvenidas mediante una incidencia en GitHub.

Sobre BrainAI: las afirmaciones salen del [README](../../README.es.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[SECURITY.md](SECURITY.md), [BENCHMARK.md](BENCHMARK.md), [LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md),
[DESKTOP.md](DESKTOP.md) y [CLIENTS.md](CLIENTS.md) de este repositorio, en la versión 1.9.0.

Mem0: [repositorio](https://github.com/mem0ai/mem0), [precios](https://mem0.ai/pricing),
[servidor MCP](https://docs.mem0.ai/platform/mem0-mcp),
[plugin de Claude Code](https://docs.mem0.ai/integrations/claude-code),
[Dream](https://docs.mem0.ai/platform/features/dream),
[caducidad](https://docs.mem0.ai/platform/features/memory-expiration). Dejamos fuera el producto local "OpenMemory"
de Mem0 porque no encontramos documentación oficial actual.

Hindsight: [repositorio](https://github.com/vectorize-io/hindsight), [documentación](https://hindsight.vectorize.io/),
[servidor MCP](https://hindsight.vectorize.io/developer/mcp-server),
[observaciones](https://hindsight.vectorize.io/developer/observations),
[versiones](https://github.com/vectorize-io/hindsight/releases), [precios](https://vectorize.io/pricing).

Basic Memory: [repositorio](https://github.com/basicmachines-co/basic-memory),
[precios](https://basicmemory.com/pricing), [guía de la nube](https://docs.basicmemory.com/cloud/cloud-guide),
[registro de cambios](https://docs.basicmemory.com/whats-new/changelog),
[versiones](https://github.com/basicmachines-co/basic-memory/releases).
