Read in English: [docs/DESKTOP.md](../DESKTOP.md)

# La app de escritorio de BrainAI

La app de BrainAI ejecuta BrainAI en tu propio ordenador, sin servidor, sin dominio y sin terminal: en un Mac con Apple silicon
y en Windows 10 u 11 (x64). Descárgala de la [última versión](https://github.com/jsr1292/brainai/releases/latest).

## Instalarla

- **Mac:** abre `BrainAI_<version>_aarch64.dmg` y arrastra BrainAI a Aplicaciones. Cada versión se prepara para que Apple la firme y
  la notarice, de modo que se abra sin avisos (mira «Una versión firmada para otros Macs»).
- **Windows:** mira «En Windows» más abajo.

Si usas la versión 1.2, no tiene actualizador: instala esta versión encima a mano, una sola vez. Tu memoria se conserva.

## Actualizar

La app comprueba una vez al día (y Ajustes › Versión › Buscar actualizaciones comprueba ahora). Cuando hay una versión nueva firmada, la
app la descarga sola en segundo plano y comprueba su firma; tú sigues trabajando. Una línea fina sobre Ajustes, en
la barra lateral, muestra «Descargando actualización · 42 %», y la información del icono de la bandeja dice lo mismo.

- Cuando termina la descarga, la actualización está **lista**: la barra lateral dice «Actualización lista · Reiniciar», el menú de la
  bandeja tiene **Reiniciar para actualizar**, y una tarjeta en Inicio cuenta qué hay de nuevo, con **Reiniciar ahora**. Reiniciar guarda una copia de seguridad de tu
  memoria, instala la actualización y vuelve a abrir la app, en unos segundos. Tu memoria, tus ajustes y tus herramientas conectadas se quedan como estaban.
  En Windows el instalador se ejecuta en silencio (sin ventana ni preguntas de permiso: instala solo para tu usuario).
- **Salir de BrainAI** desde la bandeja con una actualización lista hace la copia y la instala sin volver a abrir, así que la próxima vez
  que abras BrainAI ya será la versión nueva. Si falla la copia o la instalación, BrainAI sale igualmente (espera la copia hasta un minuto como máximo) y explica el motivo en
  `logs/update.log`. Mientras tanto la ventana se oculta y el icono de la bandeja dice «Instalando la actualización…».
- **Más tarde** oculta la tarjeta de Inicio para esa versión. El punto y la línea de la barra lateral se quedan, y una versión más nueva hace volver la tarjeta.
- La actualización descargada vive solo en memoria. Si BrainAI se detiene antes de instalarla, la próxima comprobación la descarga de nuevo.
- Si falla la descarga, la tarjeta muestra el motivo con **Reintentar**, y se vuelve a intentar pasadas 6 horas y luego cada 24. Una descarga que no supera la comprobación de la firma no se repite sola para esa versión; una versión más nueva lo borra. No aparece ninguna ventana.
- Después de una actualización, la primera vez que se abre la app, Inicio dice «Actualizado a 1.7.2 · Novedades» (**Novedades** muestra las
  notas de la versión). Se queda hasta que pulses **Cerrar** o llegue la siguiente actualización.
- En Windows la app desaparece unos segundos mientras se actualiza (se cierra, el instalador se ejecuta sin ventana y la app se vuelve a abrir). Si no se puede cerrar la versión anterior, la actualización se detiene antes de sustituir nada.
- Si algo falla por el camino, la versión que usas se queda como estaba.

## Qué hace

- Al abrir la app, se inicia BrainAI y su panel aparece en la ventana de la app, con la sesión ya iniciada. En una instalación nueva, la
  primera pantalla te lleva a conectar tu primer asistente.
- Un icono de cerebro aparece en la barra de menús: **Abrir BrainAI**, **Iniciar al arrancar** (activado tras el primer arranque), **Salir de BrainAI**
  (el menú sigue el idioma del ordenador, o el que elijas en Ajustes › Idioma).
  Cerrar la ventana deja BrainAI en marcha; Salir de BrainAI lo detiene.
- Solo las apps de este Mac pueden llegar a él, y no hay contraseña, hasta que actives el acceso desde el móvil y la web (más abajo).
  En este ordenador, BrainAI se usa desde su propia ventana. Sin contraseña, un navegador no tiene la sesión iniciada: muestra
  «Abre la ventana de BrainAI». Solo la ventana (con su ticket de un solo uso) o la contraseña dan una sesión.

## Conectar tus herramientas

La primera vez, la app se abre con una breve bienvenida: tu nombre (opcional), luego las herramientas de programación que encuentra en este Mac,
cada una con **Conectar**, y después «Pruébalo», que muestra el primer dato que guarda un asistente. Los mismos botones están en
Ajustes › Herramientas en este Mac, con **Desconectar**.

| Herramienta | Qué hace Conectar | Después |
|---|---|---|
| Claude Code | `claude mcp add --transport http --scope user brainai …`, y sus reglas en `~/.claude/CLAUDE.md` | En Claude Code: `/mcp` → brainai → Authenticate |
| Codex | `codex mcp add brainai --url …`, herramientas aprobadas en `~/.codex/config.toml`, reglas en `~/.codex/AGENTS.md` | Se abre tu navegador para iniciar sesión |
| OpenCode | `mcp.brainai` en `~/.config/opencode/opencode.json`, reglas en `~/.config/opencode/AGENTS.md` | `opencode mcp auth brainai` |
| Cursor | `mcpServers.brainai` en `~/.cursor/mcp.json` | Pega las reglas que se muestran en Cursor › Settings › Rules |
| Gemini CLI (aún sin probar) | `mcpServers.brainai.httpUrl` en `~/.gemini/settings.json`, reglas en `~/.gemini/GEMINI.md`; se detecta cuando `gemini` está en tu PATH | En Gemini CLI: `/mcp auth brainai` |

El inicio de sesión de cada herramienta abre tu navegador, que espera y te dice que abras la ventana de BrainAI. Allí un aviso muestra la herramienta; pulsa Revisar y luego Aprobar o Denegar. Después el navegador sigue solo hacia la herramienta. (Con una contraseña puesta para el acceso remoto, el navegador inicia sesión con la contraseña y muestra la página de consentimiento, como antes.) Conectar nunca cambia una herramienta que ya usa
otro BrainAI (por ejemplo, un servidor doméstico, con el nombre `memory`) a menos que pulses **Sustituir**, e incluso entonces
deja en paz esa otra entrada. Antes de cada cambio se hace una copia de seguridad de cada archivo a su lado, como `<name>.brainai-backup`, y
solo se escribe lo que queda entre las líneas `<!-- brain setup -->`. Un `opencode.jsonc` (con comentarios) no se
reescribe: añade OpenCode a mano desde Ajustes › Configurar una app.

### Claude (app de escritorio)

La propia app de Claude (la de la ventana de chat, no Claude Code) está en la misma lista, como **Claude (desktop app)**.
Conectar añade una entrada `brainai` al archivo `claude_desktop_config.json` de Claude: en el Mac, en
`~/Library/Application Support/Claude/`; en Windows, en `%APPDATA%\Claude\`. La entrada ejecuta el propio Node de BrainAI con
`dist/cli.js claude-bridge`, un pequeño ayudante que pasa las preguntas de Claude a BrainAI en este ordenador. Sus ajustes
son `BRAINAI_DATA_DIR` y `BRAINAI_PORT_FILE`.

- **Un paso después de Conectar:** cierra Claude del todo y ábrelo de nuevo. En el Mac es ⌘Q. En Windows, ciérralo
  desde el icono de la bandeja. Cerrar la ventana no basta.
- **La clave** es un archivo en la carpeta de datos de BrainAI (`claude-desktop-key`; en el Mac, solo tú puedes leerlo). Nunca se escribe en
  la configuración de Claude. Aparece en Ajustes › Conexiones como «Claude (desktop app)», y revocarla ahí desconecta
  Claude.
- **«Hay que volver a conectarla»** aparece si se revocó la clave, si BrainAI pasó a otro puerto o si se movió la app.
  Pulsa Conectar y queda arreglado. Conectar se rechaza mientras BrainAI se ejecuta desde la imagen de disco: muévelo antes
  a Aplicaciones.
- **Si BrainAI no está en marcha,** Claude lo dice. Si Claude se inicia al arrancar el ordenador antes que BrainAI, espera hasta 30
  segundos a que BrainAI esté listo.
- **Para quitarlo,** pulsa Desconectar. Quitar BrainAI y el desinstalador de Windows hacen lo mismo: sacan la entrada
  y revocan la clave. Una actualización la conserva.
- **Windows, versión de Microsoft Store:** Conectar escribe `%APPDATA%\Claude\claude_desktop_config.json`. La versión de la Store
  de Claude puede guardar su configuración en otro sitio. Si Claude no muestra BrainAI tras reiniciarlo, esa es la razón
  más probable.

### ChatGPT

No hay Conectar para ChatGPT. Su app no puede llegar a una memoria que vive solo en este ordenador. En su lugar, en el Mac,
activa **Acceso desde el móvil y la web** (más abajo) y añade después BrainAI en ChatGPT en la web. En Windows, donde ese acceso no está disponible, pon BrainAI en un servidor
(mira «Pasar a un servidor»); un servidor funciona también desde el Mac. Los usuarios técnicos pueden mirar además el
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) de OpenAI para desarrolladores.

## Acceso desde el móvil y la web

Ajustes › Acceso desde el móvil y la web permite que Claude, ChatGPT y Grok en la web y en tu móvil usen también el BrainAI de este Mac,
con toda tu memoria y todas las herramientas que conectaste:

1. **Pon una contraseña** y luego **añade BrainAI a tu aplicación de autenticación** (escanea el código QR y confirma con un código). A partir de entonces
   un navegador pide las dos cosas; la ventana de la app sigue con la sesión iniciada.
2. **Actívalo.** BrainAI usa Tailscale Funnel para dar al Mac una dirección pública, `https://<mac>.<tailnet>.ts.net`, gratis y
   sin dominio. Instala antes la app de Tailscale e inicia sesión; la primera vez, Tailscale puede pedirte que permitas Funnel
   para tu cuenta (la página muestra el enlace).
3. Conecta cada app web desde su página de configuración, que ahora muestra la dirección pública. Las herramientas de este Mac siguen usando
   `http://localhost`.

El móvil y la web solo llegan a BrainAI mientras el Mac esté encendido y activo. **Desactivar** cierra la dirección pública; las herramientas locales siguen
funcionando y la contraseña se conserva. Cada inicio de sesión queda ligado a la dirección en la que se hizo, así que la conexión de una app web solo
funciona por la dirección pública y la de una herramienta local solo en este Mac.

Tailscale reenvía a una puerta aparte que BrainAI abre solo mientras el acceso remoto está activado, y todo lo que pasa por ella se trata
como internet. BrainAI desactiva Funnel cuando se detiene (Salir de BrainAI, un reinicio por actualización) y lo vuelve a activar en cada arranque, de modo que tras una parada normal Tailscale
nunca sigue reenviando a una puerta que BrainAI ya no tiene. Si Tailscale no está listo al arrancar (por ejemplo, porque aún no has iniciado
sesión), el acceso remoto queda guardado y BrainAI espera. Vuelve a intentarlo cada minuto durante los 10 primeros intentos y luego cada 15 minutos, mientras
Tailscale no esté listo. La página del acceso remoto dice que está esperando y muestra lo último que dijo Tailscale. Entretanto, Funnel está desactivado.
El acceso remoto se desactiva solo únicamente cuando Tailscale no está instalado o Funnel no está permitido para tu cuenta. Si Desactivar no logra llegar a Tailscale,
BrainAI lo recuerda (`funnel-off-pending` en su carpeta de datos) y lo pide de nuevo en el siguiente arranque. Tras un fallo o un
corte de luz, Funnel puede quedar activado hasta el siguiente arranque: desactívalo en Tailscale (`tailscale funnel --https=443 off`) si
BrainAI no se va a volver a arrancar. Una vez puestas, la contraseña y la aplicación de autenticación no se cambian desde el panel.

### Tu propio dominio (Cloudflare)

Si tienes un dominio en Cloudflare, el acceso remoto puede usarlo en lugar de Tailscale: `https://brain.<tu dominio>`.

1. Instala `cloudflared` (`brew install cloudflared`).
2. **Inicia sesión en Cloudflare:** la página de Cloudflare se abre en tu navegador; inicia sesión y elige el dominio. BrainAI guarda este
   inicio de sesión, y todo lo demás que da a `cloudflared`, en su propia carpeta de datos (`cloudflared/`): tu propio
   `~/.cloudflared` nunca se lee ni se cambia. ¿Elegiste el dominio equivocado? **Usar otro dominio de Cloudflare** vuelve a iniciar sesión.
3. **Elige el nombre** y pulsa **Activar.** BrainAI crea un túnel para este Mac, añade el nombre en el DNS de Cloudflare, inicia
   el túnel y comprueba que BrainAI responde allí antes de decir Activado. Un nombre que ya está en uso se rechaza: BrainAI nunca
   sustituye un registro DNS. Las credenciales del túnel se quedan en la carpeta de datos de BrainAI.

El túnel funciona mientras el acceso remoto está activado y BrainAI está en marcha. **Desactivar** lo detiene; el nombre se queda en Cloudflare (mostrando
la página «tunnel offline» de Cloudflare) y se vuelve a usar la próxima vez. Para quitarlo del todo, borra el registro y el
túnel (llamado `brainai-…`) en el panel de Cloudflare (Networking › Tunnels).

*Aún no se ha probado con una cuenta real de Tailscale o Cloudflare*: se ha construido y probado con sustitutos de sus comandos.

## Pasar a un servidor

Para una memoria que deba estar encendida todo el tiempo: Ajustes › Pasar a un servidor.

1. **Crea el archivo de traslado:** un archivo con todos los datos, páginas e imágenes, y ninguno de tus datos de inicio de sesión.
   Es el mismo archivo comprimido que contiene una copia guardada (mira «Dejar BrainAI»). Se queda en la carpeta de datos de BrainAI hasta que lo copies;
   Mostrar en el Finder lo localiza.
2. **Prepara el servidor** y lleva allí el archivo: `docs/es/RUNBOOK.md`, «Pasar desde la app». El servidor tiene su propia
   contraseña y su propia aplicación de autenticación, y cada app se conecta a la dirección del servidor desde sus Ajustes.
3. **Ya está pasado:** indica la dirección del servidor. Este Mac dirá entonces a cualquier app que aún apunte a él dónde vive la memoria,
   desactivará el acceso remoto y ofrecerá **Quitar BrainAI de este Mac**, el mismo Quitar BrainAI que hay en Ajustes (más abajo).
   **Al final no lo he pasado** deshace el paso 3.

## Dejar BrainAI

**Guardar una copia de todo** (Ajustes) guarda tu memoria cuando quieras y no cambia nada más. Crea una carpeta
llamada `BrainAI saved <date>` en tus Documentos y después ofrece Mostrar en el Finder (Mostrar en el Explorador en Windows). Si tu
carpeta Documentos se sincroniza con iCloud Drive o OneDrive, la app lo avisa antes, porque la copia contiene todos los datos en
texto sin cifrar: te sugiere tu carpeta personal en su lugar, aunque puedes elegir Documentos igualmente. La carpeta contiene:

- `brainai-saved-<date>.tar.gz`: todos los datos, páginas e imágenes, en el único archivo que BrainAI sabe restaurar. No lleva dentro ninguna contraseña,
  aplicación de autenticación ni inicio de sesión de apps.
- `Markdown/`: cada página y cada dato como archivos de texto sencillos que puedes leer en cualquier sitio.
- `README.txt`: qué es la carpeta, cómo restaurarla y la lista de lo que BrainAI no pudo quitar.
- `Original tool settings/`: tras quitar BrainAI, los ajustes de tus herramientas tal como estaban antes de que BrainAI los cambiara. Esto
  incluye la configuración de Claude y el `mcp.json` de Cursor, que pueden contener las claves de otros servidores MCP que uses: mantén la
  carpeta en privado.

**Quitar BrainAI** (Ajustes) hace lo siguiente, en orden. Si falla el paso 1, se detiene; a partir de ahí, un paso que falle se anota en la última página y los demás se ejecutan igualmente:

1. Guarda una copia y la comprueba. Si falla, no se quita nada.
2. Desactiva el acceso remoto y borra el túnel de Cloudflare que BrainAI creó, si lo había.
3. Desconecta Claude Code, Codex, OpenCode, Cursor, Gemini CLI y la app de escritorio de Claude (su entrada se va y su clave se revoca), y quita las reglas de BrainAI. Tu propio texto se queda. Una herramienta
   conectada a otro BrainAI se deja en paz.
4. Quita los ganchos de Claude Code y el informe de carpetas de BrainAI, si los tenías, y mueve los ajustes originales de las herramientas
   (`<name>.brainai-backup`) a la carpeta guardada.
5. Cuando eliges **Terminar de quitar BrainAI** en la última página, la app pregunta a su servidor si la eliminación terminó
   con una copia guardada (si no, lo dice y no quita nada) y después te pregunta a ti, nombrando la carpeta guardada. Solo después de
   **Quitar BrainAI** ahí deja de iniciarse BrainAI al arrancar el ordenador y se borra su carpeta de datos.
6. Quita la app: en un Mac se mueve ella misma a la Papelera al cerrarse; en Windows ejecuta su propio desinstalador.

La última página muestra la lista y dónde está la carpeta guardada. La lista cubre lo que vive fuera de este ordenador:
los conectores de Claude, ChatGPT y Grok en la web y en el móvil, y el texto que pegaste en sus instrucciones.

**Arrastrar la app a la Papelera** no hace nada de esto, y BrainAI no puede detectarlo. Si ya lo hiciste, tus herramientas siguen
apuntando a ella: desconecta BrainAI en cada herramienta. Para terminar de quitarlo, borra estas tres cosas:
`~/Library/Application Support/io.github.jsr1292.brainai`, `~/Library/LaunchAgents/BrainAI.plist` y
`BrainAI.app` si todavía está. La memoria está en la primera carpeta: copia antes `data/memory.db` a otro sitio si
quieres conservarla.

## Volver

En una instalación nueva, la primera pantalla tiene **Tengo una carpeta guardada de BrainAI**. Elige el archivo `brainai-saved-<date>.tar.gz`
que hay dentro de la carpeta guardada (también sirve un archivo `brainai-move-…` más antiguo). BrainAI lo comprueba, se reinicia y recupera cada dato, página,
imagen y aprobación. Después la bienvenida sigue con la conexión de tus herramientas.

Solo trae una copia a una memoria vacía. Si BrainAI ya contiene datos, lo dice y no hace nada. No vuelve nada relativo
al inicio de sesión: tus apps inician sesión de nuevo. Una copia de un BrainAI más nuevo que el tuyo se rechaza; actualiza primero la app.

La misma opción acepta también un archivo de copia de seguridad, `memory-<date>.db`, de una carpeta de copias (la propia de la app o la carpeta
`backups/` de un servidor). Recupera los datos y las páginas; las imágenes no están en un archivo de copia de seguridad, así que sus páginas conservan su texto (la bienvenida dice
cuántas son). El inicio de sesión se quita siempre, así que inicia sesión de nuevo donde se te pida.

## Pasar desde el zip de Windows

El zip de BrainAI para Windows (una instalación privada en `%LOCALAPPDATA%\WorkMemory`, con scripts de PowerShell) ya no existe. En Windows
usa la app de BrainAI. Para llevar a la app lo que contiene el zip:

1. Haz que la instalación del zip de Windows escriba una copia de seguridad nueva. Abre PowerShell en `%LOCALAPPDATA%\WorkMemory` y ejecuta
   `powershell -ExecutionPolicy Bypass -File .\stop.ps1`, y después `powershell -ExecutionPolicy Bypass -File .\start.ps1`.
   Escribe un archivo de copia de seguridad al arrancar; espera aproximadamente un minuto.
2. Copia el `memory-<date>.db` más reciente a tus Documentos. Si se configuró OneDrive para trabajo o centros educativos, está en la carpeta
   «Work memory backups» de ese OneDrive; si no, está en `%LOCALAPPDATA%\WorkMemory\backups`. Comprueba que el archivo esté
   en Documentos antes del siguiente paso: quitar la instalación del zip borra su propia carpeta de copias de seguridad.
3. Quita la instalación del zip de Windows: en `%LOCALAPPDATA%\WorkMemory` ejecuta
   `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1` y escribe `delete` cuando lo pida. También escribe una exportación en Markdown
   en Documentos y desconecta Codex y Claude Code.
4. Si la app de BrainAI ya está en este ordenador porque la probaste, desinstálala primero con «Delete the application
   data» marcado (borrar los datos de la aplicación): una importación solo llena una memoria vacía. Guarda antes una copia si contiene datos que quieras conservar.
5. Instala la app de BrainAI, elige **Tengo una carpeta guardada de BrainAI** en la bienvenida y selecciona ese archivo.
6. Conecta tus herramientas en el paso siguiente.

Inicia sesión de nuevo donde se te pida: el inicio de sesión nunca se traslada.

## Modelos de búsqueda

La app no incluye los modelos de búsqueda. La primera vez que se abre, pregunta cómo debe encontrar las cosas BrainAI y sugiere
lo que encaja con este ordenador; marcas lo que quieras y solo descarga eso. Hasta que lleguen los modelos, la búsqueda por palabras clave
funciona. Un dato guardado entretanto recibe su significado cuando los modelos estén listos.

| | Qué hace | Tamaño |
|---|---|---|
| **Ligero** (búsqueda) | Encuentra datos por su significado: el más rápido. multilingual-e5-small, licencia MIT | 135 MB |
| **Equilibrado** (búsqueda) | Lo mismo, algo más preciso y unos 10 ms más lento por búsqueda. EmbeddingGemma 300M, Gemma Terms of Use (la descarga incluye el aviso de Google y las condiciones) | 219 MB |
| **Estándar** (reordenador) | Pone la coincidencia correcta en primer lugar entre las primeras. mmarco-mMiniLMv2-L12, Apache-2.0 | 136 MB |
| **Ninguno** (reordenador) | Se salta ese paso: nada que descargar, algo menos exacto | 0 |

**Elegir por mí** decide según el ordenador: con menos de 4 GB de memoria, Ligero y sin reordenador; en Apple silicon, o con 8 GB
de memoria o más (y al menos 1 GB de disco libre), Equilibrado y Estándar; en otro caso, Ligero y Estándar. Se probó un reordenador más grande,
bge-reranker-v2-m3, y no se adoptó (`docs/superpowers/notes/2026-11-13-strong-reranker-trial.md`).

Los modelos viven en la carpeta de datos de la app, en `models/` (mira «Dónde está cada cosa»). Las descargas vienen de Hugging Face; una
versión de GitHub es la fuente de reserva (aún no publicada, así que hoy solo funciona Hugging Face). Usan los ajustes de proxy
del ordenador. Cada archivo se comprueba contra una huella fija (SHA-256); un archivo que no coincide se
borra y se avisa.

**Una instalación existente** conserva los modelos que su memoria ya usa: en el primer arranque de esta versión, la app descarga
esos mismos modelos, sin preguntar nada.

### Ajustes › Búsqueda

Cambia los modelos cuando quieras. Un modelo de búsqueda nuevo vuelve a leer todos los datos una vez, en segundo plano; un reordenador nuevo funciona
de inmediato. **Quitar** en un modelo descargado libera su espacio en disco (un modelo en uso no se puede quitar). **Cargar archivos de un modelo desde
una carpeta** es para un ordenador que no puede descargar: elige una carpeta con los archivos de un modelo; cada uno se comprueba antes de
copiar nada, y un archivo incorrecto se rechaza.

### Reordenador en línea (OpenRouter)

En lugar del reordenador local puedes usar uno de OpenRouter, con tu propia clave de OpenRouter (Ajustes › Búsqueda ›
Clave de OpenRouter):

- **Voyage rerank 2.5** (`voyageai/rerank-2.5`): no entrena con lo que envías, pero puede conservarlo.
- **Qwen3 Reranker 8B** (`qwen/qwen3-reranker-8b`): no conserva nada (retención de datos cero); algo más lento.

En cada búsqueda se envían al servicio tu pregunta y unas 20 mejores coincidencias. Por lo demás, nada sale de este ordenador.
La clave se guarda solo en la carpeta de datos (el archivo `openrouter-key`, que solo tú puedes leer), nunca en tu
memoria, en una copia guardada, en una copia de seguridad ni en una página. Si el servicio va lento o está caído, esa búsqueda usa el reordenador local.

*Los servidores son distintos:* guardan `EMBED_MODEL` y `RERANK` en `.env`, con los modelos incluidos en la imagen.

## Dónde está cada cosa

| | |
|---|---|
| Tu memoria | `~/Library/Application Support/io.github.jsr1292.brainai/data/memory.db` |
| Copias de seguridad diarias (las 14 más recientes) | `…/io.github.jsr1292.brainai/backups/`, y una segunda carpeta si pones una (Ajustes › Copias de seguridad) |
| Modelos de búsqueda descargados | `…/io.github.jsr1292.brainai/models/` |
| El registro del servidor | `…/io.github.jsr1292.brainai/logs/server.log` |
| Su puerto | `…/io.github.jsr1292.brainai/brainai.json` (3100, salvo que lo tuviera ocupado otro programa) |

**Una segunda carpeta de copias de seguridad:** Ajustes › Copias de seguridad › «Guardar también las copias diarias en» copia cada copia de seguridad diaria a una carpeta
que elijas (una unidad externa, una carpeta sincronizada). Allí conserva los 14 archivos `memory-….db` más recientes (BACKUP_KEEP) y quita los más
antiguos; no toca nada más de la carpeta. Solo tú puedes leer las copias en el propio disco del Mac, y en las unidades donde «Ignorar la propiedad en este volumen» está desactivado (compruébalo en Obtener información de la unidad). macOS suele activarlo en las unidades externas, así que allí otras cuentas de este Mac pueden leer las copias. En Windows y en las unidades de red tampoco son solo del propietario, así que elige una carpeta que solo puedas abrir tú. La app borra solo las copias que hizo ella, y además, una vez, las que dejó allí una versión anterior. Si esa carpeta se sincroniza con iCloud Drive o OneDrive, la app te avisa,
porque las copias de seguridad contienen todos los datos en texto sin cifrar.

Actualizar o reinstalar la app nunca toca la carpeta de datos. Para quitar BrainAI, usa **Quitar BrainAI** (siguiente sección).

Las apps se conectan a `http://localhost:<port>/mcp` (Ajustes › Configurar una app muestra la dirección exacta y los pasos). Si
alguna vez hay que cambiar el puerto porque otro programa lo ha ocupado, la app lo dice y hay que volver a conectar las apps.

## En Windows

La misma app, con el icono de la bandeja del sistema (junto al reloj) en lugar de la barra de menús. Lo que cambia:

- **Instalación:** ejecuta `BrainAI_<version>_x64-setup.exe`. Se instala solo para ti, sin permisos de administrador, en
  `%LOCALAPPDATA%\BrainAI`. Windows pregunta una vez por un editor desconocido (la app no está firmada con un
  certificado de pago); elige **Más información › Ejecutar de todas formas**. O, desde PowerShell, una línea descarga el instalador, comprueba su suma de verificación
  y lo ejecuta sin esa pantalla:
  `irm https://github.com/jsr1292/brainai/releases/latest/download/install-app.ps1 | iex`. Sin conexión, dale al script el
  archivo: `powershell -ExecutionPolicy Bypass -File install-app.ps1 -Installer .\BrainAI_<version>_x64-setup.exe` (con
  `SHA256SUMS` a su lado).
- **El runtime de Visual C++ de Microsoft** viene con la app: los cinco archivos que necesitan su motor de búsqueda y el cifrado de contraseñas
  (`vcruntime140*.dll`, `msvcp140*.dll`, versión 14.44) están en las carpetas de los dos módulos que los cargan
  (los de onnxruntime y argon2, dentro de `server\node_modules`), donde Windows mira primero, así que funciona en un PC sin
  el runtime, o con uno más antiguo, y no necesita administrador. Son archivos propios de Microsoft, tomados del redistribuible
  oficial de Microsoft y comprobados contra huellas fijadas al construir la app; cada versión de BrainAI
  lleva la versión con la que se construyó. Siguen siendo de Microsoft, redistribuidos bajo los términos de código distribuible de
  la licencia de Visual Studio de Microsoft, no bajo la licencia MIT de BrainAI.
- **Dónde está cada cosa:** tu memoria, las copias de seguridad y el registro están en `%LOCALAPPDATA%\io.github.jsr1292.brainai\` (`data\`,
  `backups\`, `models\`, `logs\server.log`). Las actualizaciones y las reinstalaciones conservan esa carpeta.
- **Conectar** encuentra Claude Code, Codex, OpenCode y Cursor igual que en el Mac (incluido el `claude.cmd` de npm y similares),
  y la app de escritorio de Claude (mira «Claude (app de escritorio)» más arriba).
- **El acceso desde el móvil y la web** es solo para Mac por ahora: en Windows, usa BrainAI desde las apps de este ordenador o pásalo a
  un servidor.
- **Quitarlo:** usa **Quitar BrainAI** en la app (mira «Dejar BrainAI»): guarda una copia y después ejecuta el desinstalador
  en silencio y borra la carpeta de datos. Desinstalar desde Configuración › Aplicaciones › BrainAI también desconecta tus herramientas de programación
  (no lo hace cuando una actualización sustituye la app). No guarda ninguna copia: la carpeta de datos se queda salvo que marques «Delete the
  application data» (borrar los datos de la aplicación), y la carpeta que se conserva es tu copia. Iniciar al arrancar se quita con la app.

## Cómo funciona

La app es una pequeña envoltura Tauri (`desktop/src-tauri`, Rust) alrededor del mismo servidor que la instalación en un servidor doméstico. En
cada arranque:

1. toma el puerto de `brainai.json`, o el primero libre entre 3100 y 3199 tanto en `127.0.0.1` como en `[::1]`;
2. genera una clave aleatoria nueva e inicia el Node incluido con el servidor en modo local (`LOCAL_MODE=true`, la zona
   horaria del Mac, los datos en la carpeta de arriba, nada más de tu entorno);
3. pide al servidor que demuestre que tiene la clave (`GET /app/hello`, un HMAC de un reto nuevo), de modo que la clave nunca se
   envía a otro programa que esté en ese puerto;
4. cambia la clave por un ticket de un solo uso (`POST /app/ticket`) y abre la ventana en `/app/open?ticket=…`.

El servidor se detiene limpiamente cuando la app se cierra, y también si la app se fuerza a cerrar o falla (vigila una tubería de
la app). Si el servidor se detiene por sí solo, la app lo arranca de nuevo en el mismo puerto y lo dice. Un segundo arranque muestra
la ventana de la app que ya está en marcha en lugar de iniciar otro servidor. Tras un reinicio rápido, la app espera unos segundos a
su puerto habitual en lugar de cambiar. Los enlaces a otros sitios se abren en tu navegador.

## Compilarla

En un Mac con Apple silicon, con Node 22 y Rust (`rustup`):

```bash
desktop/scripts/stage-server.sh          # the server, its darwin-arm64 dependencies and Node 22 (no models)
cd desktop && npm install && npx tauri build --bundles app
```

La app queda en `desktop/src-tauri/target/release/bundle/macos/BrainAI.app` (unos 281 MiB: las dependencias del servidor
y Node; sin modelos, que la app descarga en su carpeta de datos una vez elegidos). `cd desktop/src-tauri &&
cargo test` ejecuta las pruebas de la envoltura; las del servidor son `npm test` en la raíz del repositorio.

**La app de Windows** se compila en el mismo Mac, con compilación cruzada para Windows x64. Una sola vez, instala las herramientas (cargo-xwin
descarga el SDK de Windows y el runtime de C de Microsoft, lo que implica aceptar la licencia de Microsoft para ellos):

```bash
brew install nsis llvm lld cabextract
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
```

Después, `desktop/scripts/build-windows.sh` prepara el servidor para Windows y escribe
`dist-windows/BrainAI_<version>_x64-setup.exe` y su `SHA256SUMS`. También prepara el runtime de Visual C++ de Microsoft
(`scripts/windows/vcruntime.sh`): descarga una vez el `VC_redist.x64.exe` de Microsoft (se guarda en `~/.cache/brainai`),
lo rechaza si su huella no coincide con la fijada, descomprime los cinco archivos con cabextract y comprueba también la huella de cada
uno. Un runtime más nuevo (correcciones de seguridad de Microsoft) significa actualizar esas huellas fijadas.

## Una versión firmada para otros Macs

Los Macs de otras personas solo abren una app firmada con un certificado **Developer ID Application** y notarizada por Apple.
Un certificado «Apple Development» no basta. La firma muestra el nombre del titular del certificado a cualquiera que
compruebe la app. `scripts/publish/build-apps.sh` automatiza esto (mira «Publicar una versión» más abajo). La primera versión real
con Developer ID y notarización aún está por llegar, así que puede necesitar ajustes. Esto es lo que hace, por si quieres
hacerlo a mano.

La notarización exige el hardened runtime, bajo el cual Node solo puede compilar JavaScript y cargar los módulos nativos del servidor
con los permisos de `desktop/src-tauri/Entitlements.plist` (`allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation`), y todos los archivos nativos del paquete firmados:

```bash
desktop/scripts/stage-server.sh
desktop/scripts/sign-resources.sh "$APPLE_SIGNING_IDENTITY"     # the .node and .dylib files in the staged server
cd desktop && npx tauri build --bundles app,dmg                  # signs the app and Node, then notarises
```

Tauri firma y notariza cuando están definidas estas variables (consulta la guía «macOS code signing» de Tauri para ver los nombres actuales):
`APPLE_SIGNING_IDENTITY` (el nombre del certificado, tal como lo muestra `security find-identity -v -p codesigning`), y para
la notarización una clave de la API de App Store Connect (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) o
`APPLE_ID`, `APPLE_PASSWORD` (una contraseña específica de app) y `APPLE_TEAM_ID`.

Con `CI=true` en el entorno, la compilación se salta la disposición de la ventana del Finder para el dmg (que necesita permiso para controlar
el Finder y agota el tiempo desde una terminal sin él). El dmg sigue conteniendo la app y el enlace a Aplicaciones. Da a tu
terminal ese permiso (Ajustes del Sistema › Privacidad y seguridad › Automatización) para conservar la disposición.

## Publicar una versión

Para quienes mantienen el proyecto. Una versión es el código fuente en el repositorio público, las dos apps y los archivos de actualización que comprueban las apps.

**Las claves.** Todo vive fuera del repositorio:
- La **clave del actualizador** firma cada actualización, y cada app instalada la comprueba: `~/.config/brainai/updater.key`, con su
  contraseña en el Llavero del Mac (`brainai-updater`). Guarda una copia de ambas en un lugar seguro. Si se pierden, las apps
  instaladas no podrán volver a actualizarse nunca, y todo el mundo tendrá que instalar a mano.
- El **certificado Developer ID Application** está en el llavero de inicio de sesión. La **contraseña de notarización** (una contraseña
  de Apple específica de app) está en el Llavero (`brainai-notary`). `~/.config/brainai/release.env` contiene `APPLE_ID` y
  `APPLE_TEAM_ID`.

**Los pasos.** Primero escribe la entrada `## <version>` en `CHANGELOG.md`, sube la versión en `package.json` y
`desktop/src-tauri/tauri.conf.json`, y haz commit. Después, en este orden (un paso que falla detiene el resto, y nada es
público antes del paso 4):

1. `scripts/publish/release.sh <denylist> <public-repo-url> <version> --dry-run`: la puerta de control, las pruebas, y las comprobaciones de versión y
   de registro de cambios. No se envía nada.
2. `scripts/publish/build-apps.sh <version>`: compila, firma y notariza la app del Mac, compila el instalador de Windows y
   escribe `dist-release/<version>/` con `latest.json`, `release-notes.md` y `SHA256SUMS`.
3. `scripts/publish/check-release-files.sh <denylist> dist-release/<version>`: los archivos no contienen palabras privadas.
4. `scripts/publish/release.sh <denylist> <public-repo-url> <version> --no-tests`: sube el código fuente y la etiqueta.
5. `scripts/publish/upload-models.sh --if-missing`: pone los archivos de los modelos de búsqueda en la versión preliminar `models-v1` (la
   reserva cuando Hugging Face no está accesible), salvo que ya estén allí. Rechaza un archivo cuyo SHA-256 difiera
   del fijado, y la versión nunca se marca como «latest».
6. `scripts/publish/upload-release.sh <version> dist-release/<version>`: crea la versión como la más reciente (o sube los archivos
   encima, si una ejecución se cortó), y luego descarga `latest.json` y `SHA256SUMS` de la dirección pública y los comprueba.

Después, prueba el dmg y el instalador de Windows a mano en una cuenta o un ordenador limpios.

**Una compilación de prueba.** `scripts/publish/build-apps.sh <version> --ad-hoc` firma con una identidad desechable, se salta la notarización
y escribe `dist-release/<version>-adhoc`, que nunca se sube.

**Sin la clave del actualizador** puedes compilar y ejecutar la app para ti, como en «Compilarla» más arriba: solo que no genera
archivos de actualización, así que a esa copia nunca se le ofrece una actualización. `build-apps.sh` se niega a ejecutarse sin la clave, de modo que una versión
nunca puede publicar archivos desde los que nadie pueda actualizar.
