Read in English: [docs/CLIENTS.md](../CLIENTS.md)

# Conectar tus apps de IA a la memoria compartida

Sustituye `<domain>` por tu dominio en todo lo que sigue. La puesta en marcha del servidor está en `docs/RUNBOOK.md`; hazla primero.

La memoria compartida convive con la memoria integrada de cada app; no la sustituye. Las memorias integradas siguen siendo propias de cada app. La memoria compartida es el único lugar donde todos tus asistentes leen y escriben, y la fuente de verdad para todo lo que importa entre ellos.

## 1. La instrucción personalizada (el mismo texto para todas las apps)
Pégala tal cual:

```
I have a shared memory (MCP connector "memory") used by all my AI assistants. At the start of each conversation, load my profile from it. Before answering anything about past work, my projects or my setup, recall from it. Save decisions, conclusions and lasting facts about me there as we go, and save or update a short status whenever a step of the work finishes; don't wait for the end of the conversation. If the memory connector is missing, needs a login, or a call fails, tell me right away. It is the source of truth for anything that matters across assistants.
```

El servidor envía además sus propias instrucciones. Las herramientas de memoria son `load_profile`, `recall`, `project_brief`, `remember`, `update_memory`, `forget` y `list_projects`. Las herramientas de debate son `open_discussion`, `list_discussions`, `read_discussion`, `reply_to_discussion` y `close_discussion` (mira la sección 5).

Cuando apruebas un inicio de sesión, la página de consentimiento te pide que pongas nombre a la conexión (por ejemplo "Grok Build") y que elijas su nivel de acceso (sección 6). Ese nombre es el que aparece en las publicaciones de los debates, en los datos nuevos y en Ajustes › Conexiones. Puedes cambiarle el nombre a una conexión más tarde en Ajustes › Conexiones.

## 2. Claude Code
1. `claude mcp add --transport http --scope user brainai https://memory.<domain>/mcp`
   (Una instalación que ya usa el nombre `memory` sigue funcionando; solo las instalaciones nuevas usan `brainai`.)
2. En Claude Code ejecuta `/mcp`, elige `brainai` e inicia sesión. El navegador muestra la página de consentimiento: comprueba el nombre del cliente y el sitio de redirección, y aprueba (inicias sesión con tu contraseña y el código del autenticador).
3. Añade el texto de arriba a `~/.claude/CLAUDE.md`.

### Hooks (cargar y guardar sin depender de que el asistente se acuerde)

Los hooks hacen que una herramienta use la memoria por sí sola. En la app de escritorio, **Ajustes › Herramientas en este ordenador › Conectar** los instala para cada herramienta de abajo que los tenga, y Desconectar (o Quitar BrainAI) los retira; una herramienta conectada antes muestra **Añadir recordatorios de guardado**. En un servidor, `./scripts/install-claude-code-hooks.sh` construye los scripts y los copia (`~/.claude/hooks` y `~/.brainai/hooks`), y tú los enlazas en los archivos de hooks de las herramientas como se muestra más abajo. En ambos casos, el archivo de hooks de la herramienta se lee primero y nunca se reescribe cuando no es JSON puro; antes del primer cambio se hace una copia de seguridad a su lado (`.brainai-backup`), y solo se añaden o se quitan las entradas que nombran los scripts propios de BrainAI.

Todos los recordatorios dicen lo mismo, en pocas palabras: *si se tomaron decisiones o cambió el estado y aún no está guardado, guárdalo con `remember` (actualiza el estado del proyecto en vez de añadir otro), o ejecuta la habilidad `harvest-session` para sugerirlo y que el propietario lo apruebe; si no pasó nada duradero, sigue adelante.* Saltan una vez por tramo de trabajo (12 cambios desde el último guardado), nunca dos veces seguidas, y cualquier error deja que la herramienta siga.

Lo que ofrece cada herramienta (comprobado el 2026-11-18 en la documentación oficial) y lo que instala BrainAI:

| Herramienta | Eventos que pueden poner un mensaje delante del modelo | Instalado |
| --- | --- | --- |
| Claude Code | **SessionStart** (`additionalContext`), **Stop** (`decision: "block"` + `reason` continúa el turno), **PreCompact** (la salida estándar en texto plano pasa a ser instrucciones para el resumen de la compactación; también puede bloquear la compactación). **SessionEnd** no puede: no controla decisiones, la salida JSON se descarta, 1,5 s de margen. | SessionStart: cargar el perfil y el resumen. Stop: el recordatorio. PreCompact: el recordatorio, redactado como tarea pendiente en el resumen, solo tras al menos 3 cambios sin guardar. Sin hook de SessionEnd. Los comandos ejecutan `node` a secas (una ruta absoluta solo cuando `node` no está en el PATH); en Windows, Cursor ejecuta los comandos de los hooks con PowerShell (un intérprete absoluto entre comillas necesita `& `), y la documentación de Codex no dice qué shell usa. Scripts `memory-start.mjs`, `memory-save.mjs` en `~/.claude/hooks`, enlazados en `~/.claude/settings.json`. |
| Codex CLI | **Stop** (`decision: "block"` inicia un nuevo mensaje de continuación a partir de `reason`), SessionStart / UserPromptSubmit / PreToolUse / PostToolUse (`additionalContext`). **PreCompact** solo detiene la compactación (no hay mensaje para el modelo); **SessionEnd** es informativo (1 s, no puede mantener el hilo abierto). | Stop (el recordatorio) y PostToolUse (cuenta el trabajo; no imprime nada) en `~/.codex/hooks.json`, script `~/.brainai/hooks/memory-nudge.mjs codex`. Codex te pide que confíes una vez en los hooks nuevos: escribe `/hooks`. |
| Cursor | **stop** (`followup_message` se envía solo como el siguiente mensaje del usuario; límite por defecto de 5 seguimientos), sessionStart / postToolUse (`additional_context`). **preCompact** solo devuelve `user_message` (se muestra al usuario, no al modelo); **sessionEnd** se lanza y se olvida. | stop (el recordatorio) y postToolUse (cuenta el trabajo) en `~/.cursor/hooks.json` (`"version": 1`, entradas planas), script `~/.brainai/hooks/memory-nudge.mjs cursor`. |
| OpenCode | Plugins (no archivos de hooks): se suscriben a eventos con `ctx.event.subscribe` (la lista de eventos incluye `session.idle`, `session.deleted` y `session.compaction.*`) y envían a una sesión con `ctx.session.prompt` / `ctx.session.synthetic`; un hook de sesión `compaction` sustituye el resumen. | **Todavía nada.** La API de plugins se rehízo y su documentación no muestra una carga útil estable de `session.idle` ni un plugin que se pueda soltar y cargar desde `~/.config/opencode/plugins/`; enviar código que no se pudo probar contra ella arriesgaría romper OpenCode al arrancar. OpenCode se apoya en sus reglas y en la habilidad `harvest-session`. |
| Grok Build | Archivos de hooks `~/.grok/hooks/*.json` (y también lee `.claude/settings.json` y `.cursor/hooks.json` de un proyecto). Eventos: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, PostCompact y más, **pero solo PreToolUse puede bloquear, y la documentación no nombra ningún evento que añada texto al contexto del modelo**; la salida estándar de los demás se ignora. | **Nada**: no hay una forma documentada de poner un mensaje delante del agente. Grok se apoya en sus reglas y en la habilidad. |
| Gemini CLI | Archivos de hooks en `settings.json` (`hooks`): **BeforeAgent** y **SessionStart** pueden devolver `hookSpecificOutput.additionalContext`, **AfterAgent** puede forzar un reintento. Comprobado el 2026-11-19 en <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md>. | **Todavía nada.** La configuración de Gemini CLI aún no está probada, y sus hooks necesitan JSON estricto en la salida estándar, que los scripts de BrainAI no escriben para él. Se deja fuera hasta que alguien con un Gemini CLI real pueda probarlo; Gemini se apoya en sus reglas (`GEMINI.md`) y en la habilidad. |
| Claude (app de escritorio, web, móvil) | Sin hooks. | Nada: se apoya en las instrucciones del servidor y en la habilidad. |

Documentación utilizada: Claude Code <https://code.claude.com/docs/en/hooks> (secciones PreCompact y SessionEnd; comprobado el 2026-11-18: "On these events, your plain-text stdout reaches Claude or the compaction summary: PreCompact: your stdout becomes instructions for the compaction summary", de modo que el recordatorio de PreCompact llega al modelo que escribe el resumen, y no solo a la vista de la transcripción); Codex <https://developers.openai.com/codex/hooks> (ahora servida desde <https://learn.chatgpt.com/docs/hooks>; esquemas en <https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated>); Cursor <https://cursor.com/docs/hooks>; OpenCode <https://opencode.ai/docs/plugins/>, <https://opencode.ai/docs/build/plugins/server> y la lista de eventos en <https://opencode.ai/docs/server/>; Grok Build <https://docs.x.ai/build/features/hooks>.

A mano (usuarios de servidor), el enlazado es, para Claude Code en `~/.claude/settings.json`:

```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-start.mjs" }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-save.mjs" }] }],
  "PreCompact":   [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-save.mjs" }] }]
} }
```

para Codex en `~/.codex/hooks.json` la misma forma con `Stop` y `PostToolUse` ejecutando `node /Users/you/.brainai/hooks/memory-nudge.mjs codex`, y para Cursor en `~/.cursor/hooks.json`: `{ "version": 1, "hooks": { "stop": [{ "command": "node /Users/you/.brainai/hooks/memory-nudge.mjs cursor" }], "postToolUse": [{ "command": "node /Users/you/.brainai/hooks/memory-nudge.mjs cursor" }] } }`.

Los dos scripts de Claude Code, en breve: **SessionStart** (`memory-start.mjs`, al arrancar, con `/clear` y tras una compactación) le dice a la sesión que llame a `load_profile` y `project_brief` para la carpeta en la que se abrió (el nombre de la carpeta del repositorio git, así que `~/Projects/wildlog` → `wildlog`); **Stop** (`memory-save.mjs`) cuenta las ediciones, las escrituras y los comandos de shell desde el último `remember`, `update_memory` o `suggest_memories`.

### Instalar como plugin

En lugar de los tres pasos de arriba más los hooks, Claude Code puede tomarlo todo de un único plugin publicado en el repositorio público de BrainAI (sin tienda de terceros). El plugin lleva la entrada MCP, el texto de la instrucción (como la habilidad `brainai-memory`), los recordatorios de guardado (SessionStart, Stop, PreCompact) y la habilidad `harvest-session`.

```
claude plugin marketplace add jsr1292/brainai
claude plugin install brainai@brainai-plugins
```

Claude Code te pide entonces **brainai_url**, tu propia dirección terminada en `/mcp` (`https://memory.<domain>/mcp`, o la que muestre la app de escritorio). Se guarda en tus ajustes (`claude plugin install brainai@brainai-plugins --config brainai_url=https://memory.<domain>/mcp` la fija sin preguntar; cámbiala más tarde con `/plugin configure brainai@brainai-plugins`), y el plugin en sí no lleva ninguna dirección: su `.mcp.json` dice `"url": "${user_config.brainai_url}"`. Antes de instalar, quita cualquier servidor MCP que hayas añadido a mano (`claude mcp remove memory`, o `claude mcp remove brainai` si lo añadió el Conectar de la app de escritorio), o tendrías dos conexiones al mismo servidor. Después ejecuta `/mcp`, elige el servidor `brainai` que viene del plugin brainai e inicia sesión como en el paso 2. Usa el plugin o el Conectar de escritorio para Claude Code, no los dos, o cada recordatorio saltará dos veces; con el plugin instalado, el Conectar de escritorio para Claude Code lo detecta (`~/.claude/plugins/installed_plugins.json` lista `brainai@brainai-plugins`) y no añade nada por su cuenta. Añade la instrucción personalizada a `~/.claude/CLAUDE.md` solo si quieres tenerla en todas las sesiones con independencia de la habilidad.

El plugin se genera, nunca se edita: `npm run build:plugins` escribe `plugins/claude-code/brainai/` y `.claude-plugin/marketplace.json` a partir de `src/hooks`, `src/skills/builtin` y `src/setup/texts.ts`, y `src/plugins/plugins.test.ts` falla cuando la copia confirmada se ha desviado, una versión difiere de `package.json` o se ha colado una cadena propia de un propietario. La puerta de publicación publica `plugins/` junto con el resto de los archivos seguidos. Comprueba una compilación con `claude plugin validate plugins/claude-code/brainai` y `claude plugin validate .`.

Formatos de plugin comprobados el 2026-11-18, y por qué solo Claude Code tiene uno:

| Herramienta | Formato encontrado | ¿Plugin creado? |
| --- | --- | --- |
| Claude Code | Estable y totalmente documentado: `.claude-plugin/plugin.json` (`userConfig`, `${user_config.KEY}` en la `url` de MCP, `${CLAUDE_PLUGIN_ROOT}`), `.mcp.json`, `hooks/hooks.json` (forma exec), `skills/<name>/SKILL.md`, y un `.claude-plugin/marketplace.json` que `claude plugin marketplace add <owner>/<repo>` lee de cualquier repositorio de GitHub. <https://code.claude.com/docs/en/plugins-reference>, <https://code.claude.com/docs/en/plugin-marketplaces>, <https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/mcp> | **Sí**, `plugins/claude-code/brainai`. |
| Codex CLI | Documentado: `plugin.json` en la raíz (o `.codex-plugin/plugin.json`), `skills/`, `mcp.json`, `hooks/hooks.json`, tienda en `.agents/plugins/marketplace.json`; la CLI solo gestiona tiendas (`codex plugin marketplace add owner/repo`) y instala mediante `/plugins`. <https://developers.openai.com/codex/plugins/build> (servida desde <https://learn.chatgpt.com/docs/plugins>) | **No.** La documentación no da a un plugin forma de pedirle al usuario su propia dirección, así que la entrada MCP tendría que llevar una URL fija; los hooks de plugin están documentados solo para plugins instalados a mano en la app de escritorio, y necesitan un paso de confianza aparte. Usa el camino manual de los pasos de cada herramienta de la sección 2 y los hooks de Conectar. |
| Cursor | Documentado: `.cursor-plugin/plugin.json`, `mcp.json`, `hooks/hooks.json`, `.cursor-plugin/marketplace.json`. <https://cursor.com/docs/plugins>, <https://cursor.com/docs/reference/plugins> | **No.** Las variables del plugin (`variables` en el manifiesto) las rellena un administrador en el panel de Cursor, e instalar desde un repositorio pasa por una tienda de equipo o por la pública de Cursor; la documentación no da a un propietario individual forma de fijar su propia dirección ni de instalar desde su propio repositorio. Usa el camino manual y los hooks de Conectar. |
| OpenCode | Los plugins son paquetes JavaScript/TypeScript listados en `plugin` dentro de `opencode.json` (`opencode plugin add`); la documentación menciona herramientas, hooks, comandos y agentes, no servidores MCP ni habilidades. <https://opencode.ai/docs/plugins/> | **No.** Un plugin no puede llevar la entrada MCP ni la habilidad, y su API de eventos no tiene un hook de recordatorio de guardado estable y documentado (mira la tabla de hooks de arriba). Usa el camino manual. |
| Grok Build, Claude (escritorio, web, móvil), ChatGPT | Ningún formato de plugin que agrupe un servidor MCP con hooks o habilidades. | **No.** Camino manual. |

### Recoger: `suggest_memories` y la habilidad `harvest-session`

Los hooks solo avisan; el asistente aún tiene que repasar su sesión. `suggest_memories` admite hasta 20 elementos (`content`, `kind` decision, summary o profile, `project`, y opcionalmente `keys`, `valid_until`, `source`, `source_note`) y una etiqueta `session`. No se guarda nada: cada elemento pasa a ser una sugerencia retenida marcada como recogida, pasa las mismas comprobaciones que un `remember` retenido (se rechazan los secretos, se marca el texto que parece una instrucción, y se adjunta como aviso una memoria existente parecida o un dato que borraste), y espera en la Bandeja como el grupo **Recogido de <app> · <etiqueta> · N** dentro de Aprobaciones, con Aprobar todos / Rechazar todos y los botones propios de cada elemento. Cuentan en la insignia de lo que te necesita. Las sugerencias recogidas tienen su propio cupo (60 en espera), aparte de los 20 guardados retenidos normales.

La habilidad `harvest-session` (texto en `src/skills/builtin/harvest-session.md`) le explica al propio modelo de la herramienta cómo hacerlo. Te llega una sola vez, en el primer arranque, como una propuesta de habilidad de "BrainAI" en la Bandeja; solo la añades tú (una habilidad con ese nombre que ya exista nunca se propone encima).

## 3. Claude (web, escritorio, móvil)
1. Personalizar → Conectores → Añadir conector personalizado.
2. URL: `https://memory.<domain>/mcp`
3. Autenticación: **Iniciar sesión ahora**.
4. Cliente OAuth: **Usar la identidad publicada de Claude**. Si falla, usa **Registrar automáticamente**.
5. Comprueba la página de consentimiento y aprueba.
6. Añade el texto de arriba en Ajustes → Perfil → preferencias personales.

Las direcciones de retorno web de Claude (`claude.ai` y `claude.com`) y las direcciones locales de bucle (loopback) están permitidas desde el principio, así que no hace falta configurar nada para ellas.

## 4. Grok y ChatGPT
Sus direcciones de redirección no están permitidas por defecto. La forma fácil: abre Ajustes › Configurar una app › Grok (o ChatGPT) y pulsa **Permitir que Grok inicie sesión** antes de conectar. Si la app sigue fallando, la dirección que intentó aparece en esa página bajo **Rechazadas hace poco**, con un botón Permitir. El resto de esta sección es lo mismo desde un terminal.
1. Grok: grok.com/connectors → New Connector → Custom, URL `https://memory.<domain>/mcp`. ChatGPT: Developer Mode (solo si tu plan lo permite), añade un conector con la misma URL.
2. La conexión falla con: `Redirect URI … is not on this server's allowlist`. El propio error contiene el comando exacto que hay que ejecutar. Algunas apps (Grok) muestran solo `invalid_client_metadata`; el motivo completo y el comando están entonces en `docker compose logs --tail 100 app` (busca `Client registration rejected`).
   Dirección de Grok, verificada el 2026-10-18: `https://grok.com/connectors-oauth-exchange-code/`.
3. En tu servidor, en `~/memory`, ejecuta el comando del error, con esta forma:
   ```bash
   docker compose exec app node dist/cli.js redirects add <entry>
   ```
4. Vuelve a intentar la conexión, comprueba la página de consentimiento, aprueba y añade el texto a las instrucciones personalizadas de la app.

Comprueba lo que está permitido en cualquier momento: `docker compose exec app node dist/cli.js redirects list`.

Codex (CLI, extensión del IDE, app) se identifica con un documento en chatgpt.com e inicia sesión a través de una dirección de bucle (loopback), que siempre está permitida. El servidor solo lee esos documentos de sitios que están en la lista de permitidos, así que un servidor donde nunca se conectó ChatGPT responde `Invalid client_id` hasta que chatgpt.com esté en ella: pulsa **Permitir que Codex inicie sesión** en Ajustes › Configurar una app › Codex, o ejecuta `redirects add https://chatgpt.com/oauth/codex/`. Cualquiera de las dos entradas de chatgpt.com (la de Codex o la de ChatGPT) deja que el servidor lea documentos de cliente de todo chatgpt.com, así que permitir una cubre las dos apps. La dirección de ChatGPT (`https://chatgpt.com/connector_platform_oauth_redirect`) se comprobó por última vez en una conexión real en octubre de 2026; si ChatGPT usa ahora otra, aparece bajo **Rechazadas hace poco**. `codex mcp add <name> --url …/mcp` inicia sesión por sí solo. Codex pregunta antes de cada llamada a una herramienta, salvo que la sección del servidor en `~/.codex/config.toml` tenga `default_tools_approval_mode = "approve"` (verificado con Codex 0.156.1, 2026-10-20).

## 4b. Gemini CLI (aún sin probar)
La configuración de BrainAI para Gemini CLI sigue la documentación de Google (<https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>, <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md>), pero no se ha probado con un Gemini CLI real. En la app de escritorio, **Ajustes › Herramientas en este ordenador › Conectar** hace los pasos de abajo cuando encuentra `gemini` en tu PATH; Desconectar (o Quitar BrainAI) quita solo la entrada `brainai` y las reglas de BrainAI.
1. En `~/.gemini/settings.json` añade (conserva tus otras claves y servidores; un servidor remoto Streamable HTTP usa `httpUrl`, `url` es para SSE):
   ```json
   { "mcpServers": { "brainai": { "httpUrl": "https://memory.<domain>/mcp" } } }
   ```
   O, en un terminal: `gemini mcp add --transport http --scope user brainai https://memory.<domain>/mcp`.
2. En Gemini CLI escribe `/mcp auth brainai`; tu navegador muestra la página de consentimiento: apruébala.
3. Añade el texto de la sección 1 (o el texto de Ajustes › Configurar una app › Gemini CLI) a `~/.gemini/GEMINI.md`, el archivo de contexto global de Gemini CLI.

BrainAI no configura recordatorios de guardado (hooks) para Gemini CLI: mira la tabla de la sección Hooks.

## 5. Debates
Un debate es una pregunta que responden varios de tus asistentes, por rondas, hasta que decides. Úsalo cuando estés atascado con una dirección, quieras ideas o quieras que un asistente revise lo que construyó otro. Los debates no son memoria: nada de ellos llega a la búsqueda (recall), a tu perfil ni a los resúmenes de proyecto, salvo la decisión que guardas al final.

1. **Abre uno desde cualquier asistente.** Di, por ejemplo, "abre un debate sobre cómo debería gestionar wildlog una despensa pequeña". El asistente escribe la pregunta y el contexto que necesitan los demás. Los asistentes del Mac (Claude Code, Grok Build, OpenCode) pueden adjuntar archivos del proyecto; los asistentes web no ven tu código, así que abre los debates sobre código desde el Mac.
2. **La ronda 1 es a ciegas.** Pide a cada asistente que "lea el debate de wildlog y dé su opinión". Un asistente no puede ver las otras respuestas hasta haber publicado la suya, así que no se limita a darle la razón a quien fue primero. Cada asistente y cada modelo responde una vez por ronda.
3. **Pregunta a los demás desde el panel.** Debates, dentro de Proyectos, te muestra a quién te falta preguntar. En la página de un debate, cada asistente que no ha respondido tiene un botón "Preguntar en..." (para las apps web), que abre un chat nuevo con la petición ya escrita, y un botón Copiar (para los asistentes del Mac) para pegar tú mismo la petición. Si una app no acepta una petición escrita de antemano, el botón la copia en su lugar.
4. **Tus notas y las rondas siguientes.** La ronda 2 empieza cuando han respondido todos a quienes preguntaste, o antes si pulsas "Empezar ya la ronda 2". A partir de ahí todos lo ven todo y se les pide que digan en qué se equivocan los demás, no que los resuman. Añade una nota ("que sea barato") en la página del debate y todos los asistentes la ven. Pulsa "Empezar la siguiente ronda" para más rondas.
5. **Decide.** Escribe la decisión en el panel (elige un proyecto si el debate no tiene ninguno), o dile a cualquier asistente "cierra el debate de wildlog: ordenaremos por ventana de consumo". Eso guarda un dato de decisión, así que todos los asistentes lo conocen. El debate se queda en el panel, solo de lectura. Los asistentes cierran un debate solo cuando se lo dices.

El servidor nunca contacta con un asistente; tú diriges cada ronda. Se les dice a quienes abren un debate que dejen tus datos personales fuera de la pregunta. Un debate tiene además un interruptor "Incluir asistentes con acceso solo a debates" (activado por defecto). Desactívalo si el tema es privado: las conexiones con acceso Solo debates ya no podrán verlo ni responderlo. Desactivarlo más tarde lo oculta a partir de entonces, pero no puede deshacer lo que ya se leyó.

## 6. Niveles de acceso
Cada conexión tiene uno de tres niveles:
- **Acceso completo:** las herramientas de memoria y las de debate. Es el valor por defecto.
- **Solo debates:** solo las herramientas de debate: abrir, listar, leer y responder. No puede cargar tu perfil, buscar, ni guardar ni ver ningún dato, y no puede cerrar un debate (la decisión se convierte en un dato, así que la registras tú en el panel).
- **Solo lectura, proyectos elegidos:** búsqueda, resúmenes de proyecto, listar proyectos, trabajo reciente y lo que queda, limitado a los proyectos que marques. No puede ver tu perfil ni ningún otro proyecto, no puede guardar, cambiar ni borrar nada, y no participa en los debates. Lee exactamente los nombres marcados: si un proyecto marcado se renombra o se fusiona más tarde con otro, la conexión no lee nada de él (fusionar no debe abrir el acceso al otro proyecto), y Ajustes › Conexiones te pide que marques el nombre nuevo. Cuando una app ya está conectada con Acceso completo, o con niveles distintos, su siguiente página de consentimiento no preselecciona nada, de modo que una segunda cuenta de ella (un ChatGPT del trabajo junto al personal) nunca recibe Acceso completo con un clic rápido: eliges cada vez. Una app conectada solo como Solo debates o Solo lectura vuelve a tener ese nivel preseleccionado (los proyectos aún hay que marcarlos).

Eliges el nivel en la página de consentimiento al aprobar un inicio de sesión, y puedes cambiarlo (y los proyectos marcados) en cualquier momento en Ajustes › Conexiones (se aplica a la siguiente petición de esa conexión). Elige Solo debates para los asistentes cuyo proveedor de modelo no quieres que vea tu perfil ni tus memorias, por ejemplo OpenCode con GLM o MiniMax. Aun así pueden participar en debates. Elige Solo lectura para un asistente que deba conocer algunos proyectos pero nada más sobre ti, por ejemplo un ChatGPT del trabajo que lea los proyectos del trabajo: lo que lea acaba en el historial de chat de esa cuenta.

Un conector nuevo de ChatGPT recibe su propia dirección de redirección: si su inicio de sesión falla con `Invalid client_id` o con un error de redirección, añade la dirección de la página de error con `redirects add <address>`.

## 7. Conviene saber
- **Reutilizar un token de renovación = desconexión.** Si una app reutiliza un token de renovación antiguo más de 15 segundos después de que se cambiara por uno nuevo (por ejemplo, tras un fallo de red en mitad de una renovación), el servidor lo trata como un posible robo y desconecta esa app. Es deliberado. La reutilización dentro de esos 15 segundos se permite, porque varios terminales de Claude Code comparten un mismo inicio de sesión y pueden renovar a la vez. Para reconectar, abre los ajustes del conector de la app y conéctate o inicia sesión de nuevo. Lo mismo vale después de revocar una app en Ajustes › Conexiones.
- **El panel en tu móvil:** abre `https://memory.<domain>` y elige "Añadir a pantalla de inicio" (iPhone: hoja de compartir de Safari; Android: menú de Chrome → "Instalar app").
- **Los inicios de sesión del panel duran 30 días.** Puedes cerrarlos a distancia desde Ajustes › Tu acceso.
- **Cortar el acceso a una app:** `docker compose exec app node dist/cli.js clients list`, y luego `clients revoke <grantId>`.

## 8. Comprobaciones antes de empezar a usarlo
Antes, crea en el panel un dato de perfil (por ejemplo, qué ejecuta tu servidor doméstico). Después:
1. En una sesión nueva de Claude Code, pregunta "¿qué ejecuta mi servidor doméstico?". Responde bien sin explicaciones.
2. Pide a Claude Code que guarde una decisión. Luego pregunta a Claude en la web: "según lo que hemos trabajado, ¿qué decidimos sobre la autenticación del servidor de memoria?". Responde bien.
3. `https://memory.<domain>` sin iniciar sesión muestra solo la página de inicio de sesión, y `curl -s -o /dev/null -w '%{http_code}' -X POST https://memory.<domain>/mcp` imprime `401`.
4. En tu servidor, `docker compose exec app node dist/cli.js clients list` funciona (demuestra que se cargan los módulos nativos de la imagen x86_64).
5. Cuando escribes tu contraseña en `set-password`, no se muestra ningún carácter.
