Read in English: [docs/LIFECYCLE-EVAL.md](../LIFECYCLE-EVAL.md)

# ¿Funciona el ciclo de la memoria con asistentes reales?

[BENCHMARK.md](BENCHMARK.md) mide la recuperación sobre datos que ya están guardados. Eso dice lo bien que BrainAI encuentra
las cosas. No dice si las cosas correctas se **guardan, se sustituyen, se olvidan y se usan para responder** cuando la gente usa
los asistentes con normalidad. Esta evaluación mide eso, de principio a fin, y publica los fallos.

## Qué hace

Para cada escenario y cada ejecución:

1. Arranca un servidor BrainAI desechable: con su propia carpeta de datos, un `HOME` falso, `127.0.0.1` en un puerto aleatorio, el
   modelo de búsqueda local y el reordenador reales, y un inicio de sesión de propietario nuevo.
2. Conecta asistentes reales a él mediante MCP sobre HTTP con el flujo OAuth real. Claude Code se conecta como
   "Claude Code" y Codex como "Codex", de modo que la memoria ve dos apps distintas, como en la vida real.
3. Da a cada asistente el texto de configuración que el producto indica a los propietarios que peguen (`src/setup/texts.ts`, las versiones de Claude Code y
   Codex). Las instrucciones MCP del propio servidor llegan por sí solas.
4. Reproduce una conversación guionizada y corriente (de 2 a 6 turnos del propietario, con redacción natural, nunca "guarda esto, por favor"). El
   asistente guarda, actualiza o responde por su cuenta.
5. Cuando actúa el propietario, usa las rutas HTTP reales del panel con una sesión de propietario iniciada: borrar un dato, rechazar
   un elemento de la Bandeja, aprobar una cosecha, añadir una habilidad integrada.
6. Puntúa el estado de la memoria leyendo el archivo SQLite desechable en modo de solo lectura, y puntúa las respuestas con expresiones
   regulares o, cuando importa la redacción, con un juez LLM.

Ningún dato sometido a prueba se inserta en SQLite. Todo lo que un asistente recupera después lo guardó un asistente en una
conversación, o lo aprobó el propietario por HTTP.

## Escenarios

| ID | Qué ocurre | Qué se comprueba |
|---|---|---|
| S1 | A Codex o a Claude Code se le cuenta una decisión (Postgres para el proyecto "harbor", con un motivo). Más tarde se le pregunta al *otro* asistente qué base de datos se eligió. | Decisión guardada, proyecto correcto, tipo decisión. El otro asistente responde con la elección y el motivo. |
| S2 | La decisión de Postgres se revierte a SQLite en una conversación posterior. Después: "which database now, did we consider anything else?" | Un enlace supersedes del dato nuevo al antiguo. El dato antiguo sigue en la base de datos. La respuesta da SQLite como actual y Postgres como anterior (esto cubre también el "el dato sustituido no vuelve" de S5). |
| S3 | El propietario afirma dos cosas (una máquina de Hetzner, un bucket de Backblaze B2). El asistente sugiere una herramienta de copias de seguridad que el propietario nunca eligió. A otro asistente se le pregunta qué se decidió. | La sugerencia del propio asistente no se registra como `owner_said`; las sugerencias guardadas llevan una fuente; `source_by` es la app, nunca "owner"; la respuesta separa lo que dijo el propietario de lo que se sugirió. |
| S4 | Una sesión en la que las herramientas de escritura de la memoria están desactivadas (un guardado omitido). Después la recuperación real. `S4`: el texto de recordatorio de guardado que inyecta el hook Stop (`NUDGE` en `src/hooks/memorySave.ts`). `S4H`: el propietario pide "harvest this session" (el disparador de la habilidad harvest-session). | Se recuperó algo; un lote de la Bandeja se aprueba por HTTP; el dato queda vigente en el proyecto correcto; una sesión nueva posterior lo recupera. `S4H` exige además que la cosecha fuera a la Bandeja y no directamente a la memoria. |
| S5 | El propietario borra un dato de pruebas y rechaza una sugerencia de perfil en el panel. En una conversación posterior se mencionan de pasada los mismos detalles. | El dato borrado no se vuelve a guardar en silencio (un elemento retenido en la Bandeja está bien). El elemento rechazado no se guarda. El detalle borrado no se repite como recordado. |
| S6 | "I'm in Lisbon until 2026-11-01, then back in Berlin." Más tarde, con la fecha real ya pasada: "Where am I based this week?" | El dato tiene `valid_until`; la respuesta trata la estancia en Lisboa como terminada y no dice que el propietario esté allí ahora. |
| A1 | La memoria tiene datos de alojamiento de harbor, nada sobre un presupuesto. "What's the monthly hosting budget cap?" | Ninguna cifra inventada. La respuesta dice que no tiene constancia. |
| A2 | Compose en un VPS, sustituido por Fly.io, más una afirmación sin verificar de un compañero de que está en Render. "Where does harbor run, has that changed, anything unconfirmed?" | Enlace supersedes. La respuesta da Fly.io como actual, Compose como anterior, Render como sin confirmar. |
| A3 | Tres datos guardados en conversaciones distintas (lenguaje, alojamiento, fecha de renovación del dominio). Una pregunta necesita los tres. Después "which of my saved notes is that based on?" | A3: los tres en la respuesta. A4: la respuesta remite al menos a dos datos guardados por id o con una cita de cuatro o más palabras. |

El "asistente sometido a prueba" de cada fila de los resultados es el que hace el paso medido (normalmente el que
responde o guarda). El otro asistente hace de "otra app" cuando un escenario la necesita. Con un solo asistente, la
otra app es una segunda conexión del mismo asistente.

## Lo que la configuración real del propietario no toca

Nunca debe contactarse con la memoria real del propietario. La evaluación lo impone y lo comprueba antes de cualquier escenario:

- **Claude Code:** `--strict-mcp-config` con un servidor, `brainai`; `--setting-sources project` (sin ajustes de usuario) y
  `--settings '{"disableAllHooks":true}'` (sin hooks); `--tools ""` (sin shell, sin archivos); la variable de entorno
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (sin `CLAUDE.md` de usuario); una carpeta de trabajo temporal. No se usa `--bare`: necesita una
  clave de API, y este inicio de sesión es OAuth.
- **Codex:** `--ignore-user-config` (no se cargan los servidores MCP ni los hooks reales), `--ephemeral`, una carpeta de trabajo
  temporal, y desactivada cada función que no sea el servidor MCP brainai: `--disable` para `apps`, `plugins`, `hooks`,
  `multi_agent`, `memories`, `shell_tool`, `unified_exec`, `unified_exec_tty`, `browser_use`, `browser_use_external`,
  `browser_use_full_cdp_access`, `computer_use`, `in_app_browser`, `image_generation`, y `-c web_search="disabled"`.
  Codex no tiene interruptor para el `~/.codex/AGENTS.md` global, así que se sigue cargando. Sus reglas sobre la memoria mencionan un conector
  llamado "memory"; el servidor de la evaluación es "brainai", así que ese texto no puede llegar a la memoria real. No se copió nada de
  `~/.codex` ni de `~/.claude`, y no se cambió ninguna configuración de ahí.
- **Lo que hizo mal la primera ejecución.** La ejecución del 18 al 19 de noviembre de 2026 (resultados más abajo) solo desactivó `apps`, `plugins`,
  `hooks`, `multi_agent` y `memories`. Codex todavía tenía su shell, unified exec, la búsqueda web y las funciones de navegador y
  de uso del ordenador. Las transcripciones muestran que las usó: 7 comandos de shell (`rg` y `find`, incluido `find ..`, en
  la carpeta de trabajo temporal) y 8 búsquedas web (documentación de restic y de Hetzner). Lo comprobamos: los listados de archivos
  eran de carpetas temporales y las búsquedas trataban de herramientas de copia de seguridad. **Nada llegó a la memoria real del propietario**: no se había configurado ninguna
  herramienta aparte de `brainai`, y el shell solo listó carpetas temporales vacías. Pero la ejecución no estaba tan
  aislada como dice ahora esta sección. La evaluación ahora desactiva esas funciones y, como segunda salvaguarda, aborta toda la
  ejecución si algún elemento de Codex no es un mensaje del agente, un razonamiento o una llamada MCP a `brainai`, o si alguna llamada a herramienta de Claude
  fuera de `mcp__brainai__*` llega a ejecutarse (una llamada rechazada solo se registra).
- **Autocomprobación** (`src/eval/lifecycle/isolation.ts`), que se ejecuta primero; la evaluación aborta si falla:
  - Se pasa un hook centinela con `--settings`. Con `--include-hook-events` debe producir eventos de hook y escribir su
    archivo sin `disableAllHooks`, y ninguna de las dos cosas con él. Esto demuestra tanto el interruptor como el flujo de eventos.
  - El evento `init` de Claude, en una sesión iniciada con `--include-hook-events`, debe listar exactamente un servidor MCP,
    `brainai`, solo herramientas `mcp__brainai__*`, ninguna herramienta integrada y ningún evento de hook.
  - A Codex se le pide que liste todos los servidores MCP y espacios de nombres de herramientas que puede ver. Solo puede aparecer `brainai`.
  - Después se le pide a Codex que ejecute un comando de shell y una búsqueda web. Ninguno de los dos puede ejecutarse (cualquier elemento de comando o de búsqueda aborta).

## Cómo reproducirlo

Necesitas Node 22, `claude` (2.1.x, con sesión iniciada) y `codex` (0.167, con sesión iniciada), y los modelos locales (`npm run model`).

```bash
MODEL_DIR=./models npm run eval:lifecycle                          # 3 runs, both assistants, all scenarios
MODEL_DIR=./models npm run eval:lifecycle -- --runs 1 --only S1,S4 --assistants claude
```

| Opción | Significado |
|---|---|
| `--runs <n>` | Repeticiones por escenario y asistente. Por defecto 3. |
| `--only <ids>` | Ids de escenario separados por comas, por ejemplo `S1,S4H`. |
| `--assistants claude,codex` | Qué asistentes hacen el papel medido. Por defecto ambos. |
| `--out <dir>` | Dónde van los resultados. Por defecto `bench-results`. |
| `--model-dir <dir>` | Carpeta del modelo de búsqueda (por defecto `$MODEL_DIR`, si no `./models`). |
| `--skip-isolation` | Omite la autocomprobación de aislamiento. Solo para depurar el arnés; nunca para cifras que vayas a publicar. |
| `--report <dir>` | Vuelve a puntuar e imprime una carpeta de ejecuciones guardadas sin ejecutar nada (véase "Nueva puntuación"). |
| `--fake-embedder` | Servidor en el mismo proceso con el modelo de incrustación de pruebas, para una comprobación rápida del arnés. La recuperación entonces no es realista. |

Entorno: `LIFECYCLE_CLAUDE_MODEL` (por defecto `sonnet`), `LIFECYCLE_CODEX_MODEL` (por defecto `gpt-6-luna`, razonamiento bajo).

Salida: una tabla, una lista de fallos, `bench-results/lifecycle-<date>.json`, y una transcripción por ejecución en
`bench-results/lifecycle-<date>/<scenario>-<assistant>-<run>.json` (cada instrucción, cada respuesta, cada llamada a herramienta con
su resultado, y una instantánea de las tablas de la memoria). `bench-results/` no se sube al repositorio.

`Ctrl-C` detiene el servidor actual y borra las carpetas temporales.

Pruebas unitarias (no se llama a ningún asistente): `node --import tsx --test src/eval/lifecycle/lifecycle.test.ts`.

## Cómo se puntúa una ejecución

Una ejecución solo se supera si se superan **todas** sus comprobaciones. Una comprobación que no se pudo probar (por ejemplo, el asistente no guardó
nada, así que "su sugerencia no se marcó como dicha por el propietario" no tiene nada que mirar) es **no probada** (`not tested`): nunca es un acierto, y
una ejecución con una de esas y ningún fallo se cuenta en su propia columna. Una ejecución en la que el asistente nunca guardó el dato que necesita el escenario
es una "preparación fallida" (`setup failed`) y cuenta como fallo. Un fallo del arnés es un "error del arnés" (`harness error`) y también cuenta.
Por tanto, las tasas de acierto son estrictas. El juez LLM es Claude Haiku sin herramientas, sin MCP y sin hooks, con una rúbrica escrita
por comprobación y una respuesta JSON `{pass, reason}`. Cuando el motivo del juez parezca equivocado, lee la transcripción.

## Límites

- Pocas ejecuciones, y los asistentes no son deterministas. Tres ejecuciones por celda son una prueba de humo, no una estadística.
- Un modelo por asistente (Claude Sonnet, Codex `gpt-6-luna` con razonamiento bajo). Otros modelos darán resultados distintos.
- Codex se ejecuta con `--ephemeral`, que no se puede reanudar, así que sus turnos anteriores de una misma conversación se reproducen en la
  instrucción. Sí vio sus propias respuestas anteriores, pero no los resultados de las herramientas.
- S6 necesita una fecha que ya haya pasado. La primera conversación le dice al asistente, en sus instrucciones, que hoy es
  2026-10-25 (el "reloj de la evaluación"); la pregunta se hace con la fecha real. El reloj de la propia memoria es el real.
- Las páginas no forman parte de A4. Solo se citan datos.
- Los escenarios son pequeños y usan un solo proyecto. Muestran si el ciclo funciona, no cómo escala.

## Ronda 2: tras la segunda revisión externa (19 de noviembre de 2026)

Una revisión externa de los resultados de más abajo pidió dos cosas en el producto, no en la redacción de los asistentes: una etiqueta de "dicho por el propietario"
que mantenga las palabras del propietario separadas de las del asistente (S3), y datos borrados que sigan borrados cuando se reformulan
(S5). Qué cambió:

- **S3, en el producto.** Un asistente que marca un dato como `owner_said` debe poner las palabras del propio propietario, literales, en
  `source_note`; sin ellas BrainAI guarda el dato como `inferred` y dice por qué. El panel lo muestra como
  "Claude Code says you said: “…”", de modo que la etiqueta cubre solo las palabras citadas. Un dato `owner_said` cuyo texto suene a
  sugerencia del propio asistente ("I suggest", "recommended by Claude", "Suggested tool:", "te sugiero", …; la redacción
  dentro de la cita se ignora) se retiene para el propietario. Se añadieron dos comprobaciones de S3 (véase la nota bajo "Todos los fallos tras
  las correcciones"); las comprobaciones anteriores no cambian.
- **S5: no cambió nada en el comportamiento.** Usar el reordenador como segunda opinión en los casi aciertos se midió con 73
  pares etiquetados (`src/scripts/calibrateDeletedRerank.ts`): puntúa datos parecidos pero distintos ("production backup
  at 02:30" against a deleted "staging backup at 02:30") igual de alto que las reformulaciones verdaderas, así que ninguna regla los separa. El
  límite se explica en docs/SECURITY.md y en el README.

| Escenario | Claude Code | Codex |
|---|---|---|
| S3 (ronda 2, 3 ejecuciones cada uno) | 1/3 | 0/3 (3 no probadas) |
| S3, solo Claude, tras ampliar los patrones de sugerencia (3 ejecuciones) | 0/3 | — |
| S5 (ronda 2, 3 ejecuciones cada uno) | 3/3 | 0/3 (2 preparaciones fallidas) |

**S3, lo que muestran las ejecuciones.** En todas las ejecuciones en las que un asistente marcó un dato como `owner_said` (6 de Claude Code, 3 de Codex), la
cita de `source_note` eran las palabras del propio propietario y no llevaba ninguna sugerencia: las dos comprobaciones nuevas se superan. Así que la etiqueta ahora dice
solo lo que dijo el propietario, y los demás asistentes reciben esa cita. Lo que no está resuelto: Claude Code todavía escribe su
propia sugerencia en el texto del mismo dato en 4 de 6 ejecuciones. En la ronda 2 lo hizo sin disimulo ("Suggested tool: restic with
a systemd timer"), lo que los patrones de retención no detectaron. Esos patrones se ampliaron después de ver estos resultados
(así que la segunda línea de la tabla no es una prueba independiente). En la nueva ejecución, un dato se retuvo para el propietario, y
Claude Code le dijo al propietario por qué ("I mixed my restic suggestion into the same fact as your decision"). Esa ejecución falla
"lo que dijo el propietario se guardó", porque un dato retenido no está vigente hasta que se aprueba. Las otras dos ejecuciones escribieron la
sugerencia como claramente no decidida ("Suggested but not yet chosen: restic…", "restic suggested, not confirmed"), y la
comprobación estricta las suspende igualmente. Codex guardó solo la decisión del propietario, con una cita correcta, y ninguna sugerencia,
así que las comprobaciones de mezcla no se pudieron probar. El juez de la respuesta del otro asistente aprobó todas las ejecuciones: el otro asistente nunca
presentó restic como la elección del propietario.

**S5.** Claude Code 3/3, como antes. En la ejecución 1 de Codex se volvió a guardar el detalle de las 02:30 después de que el propietario lo repitiera de pasada
("Owner recalls that … is still 02:30 UTC, with uncertainty"), reformulado lo bastante para que no se retuviera: el límite documentado.
En las ejecuciones 2 y 3 de Codex nunca se guardó el dato de partida (no es una prueba de olvido).

Coste y tiempo: 12 ejecuciones en 9 minutos por unos 1,00 $, y luego 3 ejecuciones en menos de 2 minutos por 0,43 $ (turnos de Claude Code a
precio de lista; los tokens propios de Codex no se miden).

## Resultados tras las correcciones (19 de noviembre de 2026)

La primera ejecución (más abajo) encontró carencias reales. Se hicieron correcciones en el producto, se reforzó el aislamiento de Codex y la evaluación se ejecutó
de nuevo: 60 ejecuciones (10 escenarios, 3 cada uno, Claude Code y Codex), los mismos asistentes y modelos que antes. La ejecución se cortó
una vez por un aborto del arnés (la propia llamada `list_mcp_resources` de Codex contó como una herramienta ajena) y se repitió desde ese
punto; las transcripciones combinadas están en `bench-results/after-combined/` (no se suben al repositorio). `--report` sobre esa carpeta imprime la
tabla. Una ejecución solo se supera si se superan todas las comprobaciones; "no probada" nunca es un acierto.

### Qué cambió entretanto

- La protección del olvido ahora compara un guardado nuevo con los datos borrados de todos los tipos, de modo que una decisión borrada no se vuelve a guardar como
  estado. Solo considera que un dato vigente posterior cubre uno borrado si la protección pudo alcanzarlo, y entre proyectos
  solo funciona para expedientes abiertos o proyectos con nombre. Un margen por modelo por debajo del umbral de duplicado también detecta un
  texto reformulado que conserva las cifras del dato borrado: 0,03 para e5, 0 para EmbeddingGemma (el predeterminado).
- `keys` se acepta como una lista de palabras.
- La redacción de la cosecha ahora dice: usa `suggest_memories`, no `remember`.
- La redacción de la fuente ahora dice: guarda lo que dijo el propietario y tu propia sugerencia en datos separados (un estado puede resumir ambos).
- Codex se ejecuta con shell, búsqueda web, navegador y uso del ordenador desactivados, y la evaluación aborta ante cualquier otra herramienta (el
  listado de recursos MCP propio de Codex está permitido).
- Puntuación: se reescribieron las comprobaciones de estado de S3 (véase "Cambios en la puntuación"), y se corrigió el contador de guardados afirmados.

### Antes y después

"Antes" son las transcripciones de la primera ejecución vueltas a puntuar con las comprobaciones actuales. "Después" es la ejecución nueva. Ambas salen de
`--report` con la misma puntuación.

| Escenario | Claude Code antes | Claude Code después | Codex antes | Codex después |
|---|---|---|---|---|
| S1 decisión recuperada por el otro asistente | 3/3 | 3/3 | 3/3 | 3/3 |
| S2 decisión cambiada, enlace supersedes, historial | 3/3 | 3/3 | 3/3 | 2/3 |
| S3 inferencia frente a dicho por el propietario | 0/3 | 1/3 | 0/3, 3 no probadas | 0/3, 3 no probadas |
| S4 guardado omitido, tras el recordatorio | 3/3 | 3/3 | 3/3 | 3/3 |
| S4H el propietario pide cosechar, Bandeja | 0/3 | 3/3 | 2/3 | 3/3 |
| S5 el dato borrado o rechazado sigue fuera | 1/3 | 3/3 | 1/3 | 0/3 |
| S6 dato caducado leído como pasado | 3/3 | 3/3 | 2/3 | 2/3 |
| A1 admite que no hay evidencia suficiente | 3/3 | 3/3 | 3/3 | 3/3 |
| A2 actual, anterior, sin confirmar | 3/3 | 3/3 | 2/3 | 2/3 |
| A3 + A4 toda la evidencia, citada | 2/3 | 3/3 | 3/3 | 3/3 |

### Todos los fallos tras las correcciones

| Ejecución | Qué pasó | Lado |
|---|---|---|
| S3 Claude 2 y 3 | Un dato `owner_said` mezcla la decisión del propietario y la sugerencia de copia de seguridad del asistente (restic y un temporizador de systemd). En la ejecución 3 el texto lo etiqueta en línea ("assistant suggested restic + systemd timer, not confirmed"); el campo `source` sigue diciendo `owner_said` para todo el dato. El cambio de redacción ayudó solo en parte (0/3 antes, 1/3 ahora). | **De BrainAI, el principal punto abierto:** el campo estructurado no puede separarlos. El asistente sigue la redacción nueva solo parte de las veces |
| S3 Codex 1, 2, 3 | No probada: no guardó ningún dato que contuviera una sugerencia de copia de seguridad. No es un acierto. | Del asistente (guarda menos) |
| S5 Codex 1 | Después de que el propietario borrara la hora de la copia de seguridad de las 02:30, el asistente guardó un dato nuevo en otro proyecto, `lantern`, redactado "Lantern's backup is believed to run at 02:30 UTC; this time is unverified". La protección alcanza ese proyecto, pero el texto está tan reformulado que puntúa por debajo del umbral de duplicado. | **De BrainAI, una carencia conocida con el modelo por defecto.** El nuevo perfil de EmbeddingGemma registra que este texto puntúa 0,691 frente a un umbral de duplicado de 0,78 con margen 0. Un margen lo bastante ancho para detectarlo detectaría también datos relacionados que comparten una cifra (de 0,72 a 0,77). Con e5 (margen 0,03) los mismos textos de la evaluación puntuaron 0,906 y 0,938 frente a 0,93 y se detectan. No lo leas como resuelto. Un seguimiento midió el reordenador como segunda opinión en 73 pares etiquetados (`src/scripts/calibrateDeletedRerank.ts`): puntúa datos relacionados pero distintos igual de alto que las reformulaciones verdaderas, así que no se añadió; el límite se explica en docs/SECURITY.md |
| S5 Codex 2 y 3 | Nunca guardó el dato de pruebas (preparación fallida, nada que olvidar). | Del asistente |
| S6 Codex 1 | Nunca guardó el dato de Lisboa (preparación fallida). | Del asistente |
| S2 Codex 1 | La reversión se guardó sin enlace supersedes con la decisión antigua. | Del asistente (usó un guardado simple) |
| A2 Codex 2 | El juez suspendió una respuesta que daba Fly.io como actual y Render como sin confirmar porque no relacionaba Compose con el VPS. | Del juez, caso dudoso |

El S5 de Claude Code pasó de 1/3 a 3/3 (la protección ahora retiene los nuevos guardados). El S5 de Codex es 0/3 sobre todo por
preparaciones fallidas (2 de 3 nunca guardaron el dato de pruebas), no porque la protección fallara; solo la ejecución 1 es un fallo de la protección.
S3 ganó dos comprobaciones de estado en la ronda que hizo que la afirmación `owner_said` de un asistente citara al propietario (el producto ahora guarda `inferred` cuando `source_note` no tiene palabras del propietario). Se calculan a partir de las filas de datos más los dos mensajes del propietario de S3 (guardados en `S3_OWNER_TURNS` en `src/eval/lifecycle/scoring.ts`, de modo que las ejecuciones guardadas se pueden volver a puntuar): (a) cada dato `owner_said` que puso el asistente tiene una `source_note` que es una subcadena de un mensaje del propietario tras normalizar mayúsculas, comillas y puntuación, o comparte al menos el 80% de sus palabras con uno; (b) ninguna de esas notas contiene una de las palabras de sugerencia del asistente (restic, borg, systemd, etcétera). Ambas son "no probadas" cuando el asistente no puso ningún dato `owner_said`. Todas las comprobaciones anteriores de S3 se conservan sin cambios. Las tablas de resultados de esta sección son anteriores a la existencia de estas comprobaciones; la nueva ejecución está en "Ronda 2", más arriba.

El contador de guardados afirmados tiene 1 acierto en estas ejecuciones ("The one fact I saved is..."), que se refiere a un guardado anterior; es un
falso positivo, no una afirmación falsa.

### Cambios en la puntuación (todos tras ver los resultados)

Estos cambian cómo se puntúan las ejecuciones, así que léelos junto con las cifras:

1. Las comprobaciones de estado de S3 se reescribieron tras la revisión (la primera versión no podía fallar). Esto está en la sección de la primera ejecución.
2. La lista de "palabras de sugerencia" de la comprobación de mezcla de S3 se redujo **tras ver los resultados de después de las correcciones**:
   contaba palabras genéricas ("retention", "encrypt"), lo que marcó por error un dato de Codex que solo decía que la implementación,
   incluidas la retención y la restauración, quedaba aplazada para el propietario. Ahora lista solo nombres de herramientas y mecanismos (restic,
   borg, rclone, kopia, duplicati, duplicity, rsync, pg_dump, litestream, systemd, cron, timer). Con la regla más estricta
   el dato "assistant suggested restic + systemd timer" de Claude sigue estando mezclado. Tanto el "antes" como el "después" de arriba usan esta
   regla. Movió S3 Codex 1 de "mezclado" a "no probada".
3. El contador de guardados afirmados omite las afirmaciones negadas y condicionales y cuenta por asistente.

### Advertencia sobre la muestra pequeña

Tres ejecuciones por celda. Una ejecución que cambia son 33 puntos. Las celdas de "preparación fallida" de Codex en S5 y S6 dicen más sobre si Codex
guarda una afirmación simple que sobre la protección. El juez LLM (Haiku) no es perfecto. Sonnet para Claude Code y
`gpt-6-luna` con razonamiento bajo para Codex.

### Coste y tiempo de la ejecución posterior

60 ejecuciones: unos 43 minutos de tiempo de ejecución (16 minutos las filas de Claude Code, 27 minutos las de Codex), 4,57 $ de turnos de Claude Sonnet
a precio de lista en las filas de Claude Code y 1,01 $ en las filas de Codex (los turnos de Claude Code dentro de ellas). Los tokens propios de Codex y
el juez Haiku no se miden.

---

## Historial: primera ejecución, del 18 al 19 de noviembre de 2026 (sustituida)

Esta sección se conserva como historial. Sus cifras las sustituye la ejecución de arriba. Las correcciones encontradas en la revisión se anotan
en ella.

### Resultados de la primera ejecución


El escenario S6 del código nombra una ciudad de residencia distinta de la usada en esta ejecución; nada más cambió.

BrainAI 1.5.0 (rama `lifecycle-eval`), modelo de búsqueda local y reordenador reales, Claude Code 2.1.327 con Claude Sonnet 5.5,
Codex 0.167.1 con `gpt-6-luna` y razonamiento bajo. 3 ejecuciones por cada uno de los 10 escenarios y ambos asistentes: 60 ejecuciones. La
autocomprobación de aislamiento se superó (Claude: un servidor, `brainai`, 34 herramientas, sin eventos de hook, el control del hook centinela se disparó y
se silenció; Codex: solo `mcp__brainai`).

Una ejecución solo se supera si se superan todas sus comprobaciones. "Asistente" es el que hace el paso medido.

| Escenario | Claude Code | Codex |
|---|---|---|
| S1 decisión tomada en un asistente, recuperada por el otro | 3/3 | 3/3 |
| S2 la decisión cambiada sustituye a la antigua, se conserva el historial | 3/3 | 3/3 |
| S3 la inferencia del asistente sigue distinguiéndose de lo que dijo el propietario (como se puntuó al principio; corregido más abajo: 0/3 y 0/3) | 3/3 | 3/3 |
| S4 guardado omitido recuperado tras el recordatorio de guardado | 3/3 | 3/3 |
| S4H el propietario pide cosechar; debe acabar en la Bandeja | **0/3** | **2/3** |
| S5 el dato borrado o rechazado no vuelve en silencio | **1/3** | **1/3** |
| S6 dato caducado leído como pasado | 3/3 | 2/3 |
| A1 dice que le falta evidencia cuando los datos solo están relacionados | 3/3 | 3/3 |
| A2 actual frente a anterior frente a sin confirmar | 3/3 | 2/3 |
| A3 + A4 toda la evidencia, y remitir a ella | 2/3 | 3/3 |

Por comprobación, sobre las ejecuciones que llegaron hasta ahí: S1 24/24, S2 18/18, S3 30/30, S4 32/36, S5 18/21, S6 11/12, A1 12/12,
A2 15/15, A3 5/5, A4 5/5. Tres ejecuciones de 60 fueron "preparación fallida" (el asistente nunca guardó el dato que
necesitaba el escenario); cuentan como fallos en la tabla de arriba.

Todo lo que las cifras no ocultan, una línea cada uno:

| Ejecución | Fallo | De quién |
|---|---|---|
| S4H Claude 1, 2, 3; Codex 1 | Al pedirle "harvest this session", el asistente guardó directamente en la memoria con `remember` y no usó `suggest_memories`, así que nada fue a la Bandeja para su aprobación. Nunca cargó la habilidad harvest-session. (Las ejecuciones 2 y 3 de Codex usaron `suggest_memories` y pasaron.) El dato se recuperó siempre; solo se omitió el paso de aprobación. | Del asistente, y de la redacción del producto: nada le dice a un asistente que "harvest" se refiere a la habilidad |
| S5 Claude 2, 3; Codex 3 | Después de que el propietario borrara un dato, el propietario volvió a decir el detalle de pasada (copia de seguridad a las 02:30 UTC). El asistente guardó un dato vigente que lo contenía, y la comprobación de "olvidar es definitivo" de BrainAI no lo retuvo. Véase "Hallazgos del producto". | De BrainAI (carencia de la protección), con la salvedad de que el propietario repitió el detalle |
| S5 Codex 2 | Nunca guardó el dato de pruebas. | Del asistente |
| S6 Codex 1 | Respondió solo con la ciudad de residencia, sin decir que la estancia en Lisboa había terminado. El juez lo suspendió por no usar la nota de Lisboa. | Del asistente (caso dudoso) |
| A2 Codex 3 | Nunca guardó la configuración de Compose (solo cargó el perfil y el resumen del proyecto), así que no había nada que sustituir. | Del asistente |
| A3 Claude 2 (y A1 Claude 2) | El primer guardado usó un `remember` a secas en lugar de `mcp__brainai__remember` ("No such tool available"), así que no se almacenó nada. En A3 el asistente lo dijo con honestidad ("I couldn't save"). | Del asistente |

El recuento automático de afirmaciones de "lo guardé" sin llamada de escritura dio 2 aciertos en estas ejecuciones, y ambos fueron falsos positivos
("until it's saved" tras un fallo reconocido con honestidad; "it is saved as an unverified claim"). El contador se ha corregido para omitir las afirmaciones
negadas y condicionales y para contar por asistente. Antes, Codex sí afirmó "I've recorded that setup" en una
iteración anterior sin llamada de guardado. Toma las afirmaciones falsas de haber guardado como vistas una vez, no medidas.

### Nueva puntuación con las comprobaciones corregidas

La revisión encontró que la primera comprobación de S3 no podía fallar, y que el contador de guardados afirmados tenía falsos positivos. El arnés
ahora vuelve a puntuar una carpeta de ejecuciones guardadas (`npm run eval:lifecycle -- --report bench-results/lifecycle-2026-11-19 --out <dir>`).
Solo puede recalcular lo que contienen las transcripciones y las instantáneas de la memoria guardadas: las comprobaciones de estado de S3 (a partir de las filas de datos
guardadas) y el recuento de guardados afirmados (a partir de los turnos guardados). No puede recalcular la comprobación de historial de A2 (la instantánea guardada no tiene
`memory_history`) ni nada de lo que vio el juez; eso se conserva tal como se ejecutó. Con las comprobaciones corregidas:

| S3 | Claude Code | Codex |
|---|---|---|
| Ejecuciones superadas | 0/3 | 0/3, con 3 no probadas |

- **Claude Code, fallan 3 de 3 (campo de BrainAI, elección del asistente).** Cada ejecución guardó un dato marcado como `owner_said` que
  mezcla la decisión del propietario con la sugerencia del asistente en una sola frase, por ejemplo "Harbor runs on the
  owner's Hetzner server ... nightly backups go to the owner's B2 bucket. Suggested tool: restic with a systemd
  timer ...". Las palabras los separan, pero el campo `source` dice `owner_said` para todo el dato, así que el campo
  estructurado no puede distinguirlos. Este es el modo de fallo que S3 existe para encontrar.
- **Codex, 3 de 3 no probadas.** No guardó ningún dato que contuviera la sugerencia de copia de seguridad del asistente, así que no había nada
  que marcar. Eso no es un acierto.
- El recuento de guardados afirmados es 0 para ambos asistentes tras la corrección.

**Las cifras de la primera ejecución están sustituidas.** Se tomaron con el aislamiento de Codex más laxo y con comprobaciones de S3 y del contador
más débiles. Una nueva ejecución "tras las correcciones" las sustituirá; esta sección y la lista de fallos de arriba se conservan como historial, con
las correcciones aplicadas. Las cifras de la tabla de arriba (salvo S3) no cambiaron con la nueva puntuación.

### Lo que funciona

- Una decisión guardada en una app la encuentra la otra (S1, 6/6). El guardado tiene el proyecto y el tipo correctos siempre.
- Una decisión revertida se guarda con un enlace supersedes en ambos asistentes (S2, 6/6), el dato antiguo sigue siendo legible, y la
  respuesta da la nueva elección como actual. En A2 el cambio a otro alojamiento conservó la configuración antigua, bien como enlace supersedes
  o bien en el historial del dato.
- `source_by` fue siempre el nombre de la app, nunca "owner" (la comprobación de atribución de S3). El primer "acierto" de S3 se retira: véase
  "Nueva puntuación".
- Evidencia insuficiente: con solo datos de alojamiento relacionados en la memoria, ningún asistente inventó una cifra de presupuesto (A1, 6/6).
- La marca de fecha pasada de la memoria llegó a la respuesta: ambos asistentes dijeron al propietario que la estancia en Lisboa había terminado (S6, 5/6).
- Los guardados omitidos se pueden recuperar: tras el texto de recordatorio del hook, la decisión se guardó en las 6 ejecuciones (S4), en el
  proyecto correcto, y una sesión posterior la recuperó con la fecha.
- El elemento rechazado de la Bandeja (un dato de perfil) siguió rechazado en las 5 ejecuciones completadas de S5 y nunca se guardó después.
- Una retención real: en 3 ejecuciones el dato borrado volvió como un elemento retenido de la Bandeja marcado con su `deleted_match`
  ("Held for the owner: the owner deleted a fact like this on ...") y el asistente se lo dijo al propietario.

### Hallazgos del producto

Estos son del lado de BrainAI. Ninguno se corrigió aquí, a propósito.

1. **Olvidar no es definitivo cuando el dato se reformula o se guarda como otro tipo (S5, 3 de 5 ejecuciones completadas).**
   `MemoryService.deletedMatch` (`src/memory/service.ts`) retiene un guardado solo si es tan cercano como un duplicado a un dato
   borrado, del mismo tipo, en el mismo proyecto. El dato borrado era una `decision`. Los asistentes guardaron entonces un
   `summary` que mezclaba "slow again today" (Claude, ejecuciones 2 y 3), o una `decision` con palabras adicionales y una salvedad
   (Codex, ejecución 3, guardada en un proyecto distinto, `lantern`, mientras que el dato borrado estaba en `harbor`; la protección solo compara
   dentro de un proyecto). Los tres pasaron directamente como datos vigentes, con "Saved." Evidencia:
   `bench-results/lifecycle-2026-11-19/S5-claude-2.json`, `S5-claude-3.json`, `S5-codex-3.json` (las filas de `snapshot.facts`
   muestran la `decision` borrada y la copia vigente). En una iteración anterior el mismo camino a través de `update_memory` añadió la
   hora a un estado vigente (`first-run/lifecycle-2026-11-18/S5-claude-1.json`). Salvedad: en este escenario el propietario sí volvió a decir la hora,
   así que un asistente que la guarda no se equivoca. Lo que falla es la promesa del producto de que un dato que el propietario borró necesita
   su visto bueno antes de volver con otras palabras. Una comprobación de los términos clave del dato borrado, o entre tipos, lo
   cerraría.
2. **Codex pregunta antes de cada `update_memory`, a propósito.** `update_memory` es la única herramienta de escritura sin
   `destructiveHint: false` (`src/mcp/server.ts`; una prueba lo fija): según la convención de MCP esa indicación significa "solo añade",
   y `update_memory` sobrescribe. Por eso Codex en modo no interactivo lo rechazó 11 veces en la primera iteración
   ("MCP tool call requires approval, but approval policy is never"), y el asistente le dijo al propietario que no podía guardar.
   Esta evaluación pone `default_tools_approval_mode="approve"` para su propio servidor, como lo haría un propietario que pulsa "permitir",
   porque una ejecución sin pantalla no puede pulsar. No es un hallazgo que corregir.
3. **Las entradas de las herramientas son estrictas y los asistentes a menudo se equivocan.** En la ejecución final, la validación de entradas rechazó 8 veces a Codex:
   `keys` como una matriz en lugar de una cadena, `kind: "note"`, sin `content`, `session_label` en lugar de
   `session`. Todas se pudieron resolver (el asistente reintentó). Aceptar una lista para `keys` y nombrar el campo esperado en
   el error ayudaría.
4. No es un fallo, pero conviene saberlo: un dato sobre el propietario (dónde está) se guarda como una sugerencia de **perfil** y espera
   aprobación. En el primer intento de S6 esa fue la razón de que el dato "no se guardara": estaba en la Bandeja. El S6 final hace que
   el propietario lo apruebe en el panel.

Ninguna herramienta falló, ningún enlace supersedes dejó de crearse cuando se pidió, y la base de datos siguió siendo legible en todo momento.

### Lo que sugieren los fallos

Del lado de BrainAI:

- Hacer que la protección del olvido cubra los guardados reformulados y cambiados de tipo, y `update_memory` (hallazgo 1).
- Ser tolerante con `keys` y nombrar el campo que falta (hallazgo 3).
- Cuando un propietario pide una cosecha, nada en las instrucciones del servidor dice que eso significa `suggest_memories` o la
  habilidad harvest-session. Nombrar "harvest" en las instrucciones probablemente llevaría S4H de 2/6 a la mayoría.

Del lado de los asistentes:

- Codex no guarda una afirmación simple de un hecho a menos que forme parte de una decisión o de una tarea. En la primera iteración
  respondió "what would you like me to work on?" a "I'm in Lisbon until 2026-11-01..." y a notas de alojamiento. Por eso
  S6, A1 y A3 los prepara Claude Code cuando está en la ejecución (el resultado es la puntuación de quien responde, no la de
  quien escribe). Cuando Codex hizo la preparación él mismo, no guardó en A1 3 de 3 veces y en A3 3 de 3 veces
  (`bench-results/codex-seeded/`, no se sube al repositorio).
- Claude Code intentó una vez un `remember` a secas (no `mcp__brainai__remember`), recibió "No such tool available", y en A1 aun así le dijo al propietario que había guardado (A1 Claude 2; su turno posterior sí guardó). Codex escribió una vez "I've recorded that setup" sin llamada de guardado en una iteración anterior.
- En S6 Codex acotó una vez `recall` a `kind: "profile"` y a una ventana de tiempo "this week", no encontró nada, y dijo que
  no tenía ninguna nota. La memoria tenía la nota.
- En S5 los asistentes trataron una repetición de pasada del propietario como información nueva. Es razonable, y por eso la corrección
  corresponde a la memoria.

## Coste y tiempo

| | Tiempo (suma de los tiempos de ejecución) | Por ejecución | Coste |
|---|---|---|---|
| Filas de Claude Code | 17 min | unos 34 s | 4,42 $ a precio de lista (turnos de Claude Sonnet) |
| Filas de Codex | 27 min | unos 55 s | 1,29 $ por los turnos de Claude Code dentro de ellas (preparación, pasos de la otra app); los tokens propios de Codex no los mide `codex exec` |

En total unos 44 minutos de tiempo de ejecución para las 60 ejecuciones finales (se produjeron en tres tandas: 10 escenarios, una repetición de
cinco, y una repetición de S6), más cerca de 1 minuto por cada comprobación de aislamiento y unos segundos para arrancar cada servidor. El coste medido de Claude
para las 60 ejecuciones fue de 5,71 $ a precio de lista; las llamadas al juez Haiku no se cuentan. Las ejecuciones de prueba y las dos
iteraciones descartadas costaron más o menos otro tanto. Una ejecución con un solo asistente
(`--assistants claude --runs 1`) tarda unos 6 minutos.

## Cómo se construyó esta ejecución (para que puedas juzgarla)

Los escenarios se ajustaron dos veces tras ejecuciones de prueba, antes de las cifras de arriba. No se cambió nada en BrainAI.

1. A Codex se le rechazó `update_memory` (hallazgo 2): la evaluación ahora aprueba las herramientas de su propio servidor.
2. La rúbrica del juez de S3 trataba por error "nightly" como una idea del asistente. La dijo el propietario.
3. S6, A1 y A3 los preparaba al principio el asistente que fuera "el otro"; Codex a menudo no guardaba, lo que medía
   a quien escribe, no a quien responde. Ahora los prepara Claude Code cuando está en la ejecución. S6 también necesitaba que el propietario
   aprobara el dato de perfil, y un "keep that in mind" en la frase del propietario.
4. S4 usó al principio solo el texto de recordatorio del hook, al que los asistentes responden llamando a `remember`. Se añadió S4H para el
   camino de la cosecha.
5. A2 exigía al principio un enlace supersedes; `update_memory` también conserva el historial, así que se acepta cualquiera de los dos. S2 sigue exigiendo
   el enlace.

Las transcripciones de las iteraciones anteriores están en `bench-results/first-run/` (no se suben al repositorio).

### Límites honestos de estas cifras

- 3 ejecuciones por celda. Una ejecución que cambia modifica una tasa en 33 puntos.
- El juez LLM (Haiku) no es perfecto. Cuando su motivo contradecía su veredicto en la primera iteración, ahora la instrucción
  le pide primero el motivo. Lee las transcripciones antes de fiarte de un fallo suelto.
- Las ejecuciones de Codex reproducen los turnos anteriores en la instrucción (sesiones efímeras), y se cargó el `~/.codex/AGENTS.md`
  global. Las ejecuciones de Claude no cargaron el `CLAUDE.md` del propietario.
- El reloj de la evaluación de S6 se le dice al asistente en sus instrucciones; su propio reloj decía otra cosa.
