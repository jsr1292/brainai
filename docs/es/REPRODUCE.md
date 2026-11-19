Read in English: [docs/REPRODUCE.md](../REPRODUCE.md)

# Comprueba nuestras afirmaciones

La documentación de BrainAI afirma cosas sobre lo que hace: la recuperación encuentra el dato correcto, una copia de seguridad restaura todo, los límites de seguridad se mantienen, los asistentes usan bien el ciclo de la memoria. Cada afirmación viene con un comando, para que puedas comprobarla en tu propio
ordenador en lugar de fiarte de nuestra palabra. Todo lo de abajo se ejecuta con datos desechables en carpetas temporales; nada
toca una memoria que ya tengas.

Si tus resultados son distintos de los nuestros, abre una incidencia con el archivo de resultados (cada comando dice dónde escribe uno), tu
sistema operativo, la versión de Node y el commit que ejecutaste. Un problema de seguridad va por la vía privada de `SECURITY.es.md`.

## Preparación (una vez)

Necesitas Node 22 o superior, `git` y `sqlite3`. `age` es opcional (la vía externa del simulacro de restauración lo usa; sin él
esa vía se indica como omitida, nunca como superada).

```bash
git clone https://github.com/jsr1292/brainai.git && cd brainai
npm ci
npm run model        # downloads the local search models into ./models (about 275 MB); only the model runs need them
```

## Qué ejecutar

| Afirmación | Dónde está escrita | Comando | Tiempo | Necesita |
|---|---|---|---|---|
| Pasa toda la batería de pruebas (unas 3.350 pruebas, incluidas todas las de seguridad) | — | `npm test` | unos 5 min | — |
| Los límites de confianza se mantienen: permisos, pausa y "los guardados esperan", autenticación del panel, CSRF/Origin, XSS, texto con forma de instrucción, archivos hostiles | [docs/es/SECURITY.md](SECURITY.md) | `node --import tsx --test src/security/*.test.ts` | unos 10 s | — |
| Cada tipo de copia de seguridad se restaura en una máquina limpia: 192 comprobaciones | [docs/es/RESTORE-DRILL.md](RESTORE-DRILL.md) | `npm run drill:restore` | unos 5 s | `age` para la vía c |
| Lo mismo, con el modelo de búsqueda real por defecto | [docs/es/RESTORE-DRILL.md](RESTORE-DRILL.md) | `MODEL_DIR=./models npm run drill:restore -- --real-model` | unos 10 s | los modelos |
| Lo mismo, con el modelo e5 anterior | [docs/es/RESTORE-DRILL.md](RESTORE-DRILL.md) | `EMBED_MODEL=e5 MODEL_DIR=./models npm run drill:restore -- --real-model` | unos 10 s | los modelos |
| Los modelos de búsqueda se comportan como se calibraron (duplicados, preguntas fuera de tema, reformulaciones) | comentarios en `src/memory/embeddingProfile.ts` | `npm run test:model` | unos 5 s | los modelos |
| Los asistentes reales guardan, recuperan, sustituyen y olvidan datos correctamente, fallos incluidos | [docs/es/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md) | `MODEL_DIR=./models npm run eval:lifecycle` | unos 45 min, unos 6 $ | `claude` y `codex`, con sesión iniciada |
| Recuperación en LongMemEval: se encuentra la conversación correcta | [docs/es/BENCHMARK.md](BENCHMARK.md) | `npm run bench:longmemeval -- --sample 20` | unas 2 horas la primera vez (140 preguntas), de 1 a 2 min después | los modelos, una descarga |
| Recuperación en LoCoMo | [docs/es/BENCHMARK.md](BENCHMARK.md) | `npm run bench:locomo` | unos 3 min | los modelos, una descarga |

Los resultados van a `bench-results/` (ignorada por git) salvo que un comando diga otra cosa.

## Qué esperar

- **Las pruebas y el simulacro de restauración** dan el mismo resultado siempre: todo pasa, o el simulacro termina con 1 y
  nombra la comprobación que falló.
- **La evaluación del ciclo de la memoria** maneja asistentes reales, así que cada ejecución varía. Compara escenario por escenario con las tablas
  de [docs/es/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md), no el total: 3 ejecuciones por escenario son una prueba de humo, no una estimación
  de fiabilidad. Un primer intento más barato es un asistente, una ejecución: `MODEL_DIR=./models npm run eval:lifecycle -- --runs 1 --assistants claude`
  (unos 6 minutos). Usa tus propias cuentas de Claude Code y Codex, así que cuesta lo que cuesten sus turnos. Antes de que se ejecute ningún
  escenario, comprueba que los asistentes no pueden alcanzar nada más que la memoria desechable (ni otros servidores MCP, ni hooks,
  ni shell, ni búsqueda web para Codex) y se detiene si pueden. Las ejecuciones guardadas se pueden volver a puntuar sin ejecutar nada:
  `npm run eval:lifecycle -- --report <folder>`.
- **Los benchmarks** descargan sus conjuntos de datos de commits fijados y comprueban su SHA-256 antes de puntuar; un archivo que
  no coincide se rechaza.

## Qué no pueden demostrar estas comprobaciones

Son nuestras propias pruebas. Demuestran que el código hace lo que dice la documentación en los casos que se nos ocurrieron; no son una
auditoría de seguridad independiente, y no dicen nada sobre cómo aguanta BrainAI durante semanas de uso por personas distintas de su
autor. Las carencias conocidas están enumeradas en [docs/es/SECURITY.md](SECURITY.md) y [docs/es/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md).
