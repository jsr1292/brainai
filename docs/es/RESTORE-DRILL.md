Read in English: [docs/RESTORE-DRILL.md](../RESTORE-DRILL.md)

# Simulacro de restauración

Una copia de seguridad que nunca has restaurado es solo una esperanza. Este simulacro restaura cada tipo de copia guardada
en una máquina limpia y comprueba que la memoria está completa. Está automatizado, así que cualquiera puede repetirlo.

## Qué hace

1. Construye una **memoria de origen** en una carpeta temporal. Nunca toca datos reales, y `HOME` también apunta a una
   carpeta temporal. La memoria se llena a través de los servicios reales y del flujo de inicio de sesión real:
   - datos de varios tipos, con `valid_until`, una fuente y una nota de fuente (puestas por el propietario y por asistentes), claves y etiquetas;
   - una decisión sustituida por otra más nueva (un enlace supersedes), dos datos marcados como en desacuerdo y un alias de proyecto;
   - un dato editado dos veces (filas de historial);
   - un dato que el propietario olvidó y un cambio de un asistente que espera aprobación (un elemento retenido);
   - páginas con varias secciones y tres versiones, un enlace entre páginas, una nota, dos imágenes y una página borrada;
   - un debate con un archivo;
   - una habilidad compartida con dos versiones y un archivo, y una habilidad propuesta por un asistente;
   - el registro de una app con una concesión y con tokens de acceso y de renovación activos, un registro que nunca obtuvo concesión, y el conjunto de inicio de sesión del propietario (contraseña, secreto del autenticador, sesiones, dispositivos, un secreto de cliente).
2. Registra una **huella**: recuentos de filas y hashes de filas de cada tabla que guarda memoria, el sha256 de cada
   archivo de imagen (cada tabla de abajo debe tener filas, para que "idéntico" nunca sea dos tablas vacías que coinciden) y los 3 primeros resultados de 10 preguntas fijas sobre datos y 3 preguntas fijas sobre páginas.
3. Para cada ruta de restauración hace la copia, la restaura en una **máquina nueva y vacía** (carpeta de datos nueva,
   `HOME` nuevo, nada compartido con el origen), arranca en ella la app real y compara con la huella.

## Cómo ejecutarlo

```bash
npm run drill:restore                       # fake search model, writes bench-results/restore-drill-<date>-fake.json
MODEL_DIR=./models npm run drill:restore -- --real-model   # the real default search model (EMBED_MODEL=e5 for the other)
npm run drill:restore -- --out some-folder --no-offsite --keep
```

Tarda unos 5 segundos. El código de salida es 1 si falla alguna comprobación. `bench-results/` lo ignora git.
`src/scripts/restoreDrill.test.ts` ejecuta el mismo simulacro en CI (modelo falso, sin `age`).

## Las rutas de restauración

| Ruta | Copia hecha por | Restaurada con |
|---|---|---|
| a1 instantánea nocturna | el `scripts/backup.sh` real (instantánea más carpeta de copia de imágenes) | RUNBOOK sección 3: `cp`, `PRAGMA integrity_check`, `rsync` de las imágenes, la comprobación de imágenes |
| a2 instantánea desde la app | `backupNow` (`BACKUP_DIR`) | los mismos pasos |
| b1 copia guardada | Guardar una copia de todo (`brainai-saved-<date>.tar.gz`) | el comando real `cli restore` en su propio proceso; una segunda restauración debe rechazarse |
| b2 copia guardada, desde la app | el mismo archivo | `stageRestore`, y después el cambio al arrancar (`applyPendingRestore`) |
| c paquete externo | el `scripts/offsite.sh` real (cifrado con age, un `rclone` de pega que escribe en una carpeta) | descifrar con la clave, desempaquetar, copiar, y el bucle `age -d` del RUNBOOK para las imágenes |
| d1 migración fallida | una migración que de verdad falla a medias | no hay nada que restaurar: el simulacro comprueba que la base de datos queda intacta y que existe una copia |
| d2 actualización fallida | la copia en `data/pre-migrate/` | RUNBOOK sección 3 con esa copia |

## Resultados de las ejecuciones del 2026-11-19

Se ejecutó una vez con cada modelo de búsqueda local real, esquema 43, Node 26. El modelo por defecto (EmbeddingGemma) y el
anterior multilingual-e5-small superan cada uno las 192 comprobaciones: 192 PASS, 0 FAIL, 0 SKIPPED (origen 4, a1 30, a2 30, b1 31, b2 30,
c 32, d1 6, d2 29). La misma ejecución con el modelo falso supera las mismas comprobaciones.

```bash
EMBED_MODEL=gemma MODEL_DIR=./models npm run drill:restore -- --real-model   # the default model
EMBED_MODEL=e5 MODEL_DIR=./models npm run drill:restore -- --real-model
```

Ahora el informe registra con qué modelo se ejecutó (`embedder` en el JSON y el nombre del archivo). La primera ejecución publicada,
del 2026-11-18, decía que usó e5, pero su informe no registraba el modelo; estas dos ejecuciones la sustituyen.

| Comprobación | a1 | a2 | b1 | b2 | c | d2 |
|---|---|---|---|---|---|---|
| La comprobación de integridad es correcta | PASS | PASS | PASS | PASS | PASS | PASS |
| La app arranca con los datos restaurados | PASS | PASS | PASS | PASS | PASS | PASS |
| Datos idénticos, cada campo (15 filas, incluidos los embeddings) | PASS | PASS | PASS | PASS | PASS | PASS |
| Historial (3 filas), enlace supersedes (1), desacuerdo (1) idénticos | PASS | PASS | PASS | PASS | PASS | PASS |
| El elemento retenido sigue retenido | PASS | PASS | PASS | PASS | PASS | PASS |
| Páginas, secciones, 5 versiones, enlace entre páginas, nota idénticos | PASS | PASS | PASS | PASS | PASS | PASS |
| Los dos archivos de imagen están presentes, con el mismo sha256 | PASS | PASS | PASS | PASS | PASS | PASS |
| Debate con su archivo, alias, habilidades con versiones y propuesta idénticos | PASS | PASS | PASS | PASS | PASS | PASS |
| Recuperación: los mismos 3 primeros para 10 preguntas; búsqueda de páginas para 3 | PASS | PASS | PASS | PASS | PASS | PASS |
| El dato olvidado sigue borrado, no aparece en la recuperación, y si un asistente lo vuelve a guardar queda retenido | PASS | PASS | PASS | PASS | PASS | PASS |
| El token de acceso antiguo se rechaza (401), el token de renovación antiguo se rechaza (400). Controles: ambos funcionan en el origen | PASS | PASS | PASS | PASS | PASS | no aplica |
| No vuelve ningún dato de inicio de sesión; la contraseña del origen con un código válido del autenticador no inicia sesión (503, hace falta configurarlo). Controles: el origen inicia sesión con ellos | PASS | PASS | PASS | PASS | PASS | no aplica (d2 conserva al propietario e inicia sesión: PASS) |
| Secreto de cliente sustituido; registros y concesiones conservados, comparados por hash de fila (3 clientes, 1 concesión) | PASS | PASS | PASS | PASS | PASS | PASS |

Otras comprobaciones que se superaron:

- b1: `cli restore` imprimió "Restored 14 facts and 2 pages". Una segunda restauración se rechazó ("This brain already has memories") y dejó el archivo exactamente igual, byte por byte.
- c: el paquete contenía la base de datos, `memory.md` y la exportación de páginas en Markdown; las dos imágenes volvieron con el bucle `age -d` documentado.
- d1: la migración falló, la base de datos se quedó en la versión de esquema antigua con las 15 filas de datos, y antes se había creado `pre-migrate-42-to-43-….db`.
- d2: la copia previa a la migración estaba en el esquema antiguo, superó `integrity_check`, y una copia completa conserva los datos de inicio de sesión (propietario 1, tokens 2), como debe ser.

Datos contados: 14 vigentes, 15 filas (una es la olvidada, que se conserva para que olvidar sea definitivo).

### Un fallo que encontró el simulacro, y su corrección

Las copias de `data/pre-migrate/` se creaban con el modo de archivo por defecto (`644`). Son copias completas de la base de datos,
así que contienen el hash de la contraseña, el secreto del autenticador y los hashes de tokens que una copia de seguridad deja fuera.
Cualquier otro usuario de la máquina podía leerlas. La corrección (`src/db.ts`, pruebas en `src/db.test.ts`) es de mejor esfuerzo (un recurso compartido que
rechaza `chmod` solo registra un aviso y nunca impide que BrainAI arranque), y solo quita acceso, nunca lo añade:

- cada copia previa a la migración se crea con `600` antes de que SQLite escriba en ella;
- una carpeta `pre-migrate/` nueva se crea con `700`, y a una existente se le quita el acceso de grupo y de otros en cada copia;
- las copias que dejó una versión anterior pasan a `600` cuando se hace la siguiente copia;
- cuando BrainAI abre la base de datos, `memory.db` y cualquier archivo `-wal` y `-shm` pasan a `600`.

Si otro usuario (un trabajo de copia de seguridad ejecutado como otra persona) necesita leer `data/memory.db`, dale el mismo propietario en lugar de depender del acceso de grupo.

## Lo que una restauración no devuelve (excepciones)

- **El inicio de sesión.** Una copia de seguridad no incluye contraseña, secreto del autenticador, sesiones, dispositivos conocidos, tokens de informes de carpeta,
  enlaces de subida ni tokens y códigos de OAuth. Tras una restauración el propietario vuelve a configurar la contraseña y el autenticador
  (RUNBOOK paso 6), y todas las apps vuelven a iniciar sesión. El simulacro demuestra que los tokens y la contraseña antiguos se rechazan.
  El simulacro no ejecuta `set-password` ni `setup-totp` (piden datos por teclado); solo comprueba que no hay datos de inicio de sesión.
- **Los secretos de cliente** se sustituyen por otros aleatorios, así que una app que tenía uno se registra de nuevo. Los registros y las concesiones
  (los niveles de acceso) se conservan. Una concesión sin tokens no hace nada hasta que la app vuelve a iniciar sesión.
- **Todo lo guardado después de hacer la copia.**
- **Las copias previas a la migración son la única copia completa.** Conservan los datos de inicio de sesión. Trátalas como la propia base de datos.
- **Restaurar un `memory-<date>.db` suelto con `cli restore` no trae imágenes**: las lista como borradas. Para conservar las
  imágenes, usa la sección 3 del RUNBOOK (copia el archivo y después `rsync` de las imágenes), como hacen las rutas a1 y a2. Una copia guardada
  (`.tar.gz`) lleva sus imágenes. El simulacro no prueba `cli restore` con el archivo suelto.
- **Las imágenes borradas definitivamente** hace más de 30 días salen de las carpetas de copia y de la carpeta externa, así que no vuelven.
- **La exportación en Markdown** (también dentro del paquete externo) es para leerla. BrainAI no la vuelve a leer.
- **Los disparadores de búsqueda** se reconstruyen cuando la base de datos restaurada se abre por primera vez (el registro dice "restored 9 of BrainAI's own
  database triggers"). No se pierde nada, pero el primer arranque imprime esa línea.
- **Lo borrado vuelve borrado.** Los datos olvidados y las páginas borradas están en la copia, siguen borrados, así que olvidar es definitivo.

## Lo que el simulacro no cubre

Se copia el archivo completo de la base de datos, así que estas tablas viajan con él, pero el simulacro no las rellena ni las compara:
`observations`, `observation_evidence`, `page_imports`, `page_file_imports`, `weekly_reviews`, `tidy_proposals`,
`meaning_links` (se reconstruye a partir de los vectores), `skill_links`, `device_skills` y el registro de uso (`tool_calls`).

## Lo que el simulacro no pudo simular

- **Una versión antigua real.** No hay código antiguo que ejecutar. Para d1 y d2 el "esquema antiguo" es la base de datos de origen con la última migración
  deshecha (una receta en `DOWNGRADES` en `src/scripts/restoreDrill.ts`, solo para el esquema 43; también explica cómo hacer que falle la siguiente migración). La versión anterior se sustituye abriendo la
  copia restaurada sin migrar (`openDb` con `upTo`). Si llega una migración nueva sin receta, d1 y d2 informan SKIPPED y la prueba de CI falla hasta que se añada una receta (un comentario sobre `MIGRATIONS` en `src/db.ts` lo explica).
- **d1 usa un fallo inventado** (la tabla de la migración ya existe). Es un fallo real dentro de una migración real, pero no una versión mala de verdad.
- **Docker, `chown` y el cron del servidor.** Los scripts se ejecutan en el Mac sobre carpetas de `/tmp`. La propiedad de los archivos (el `chown` de los pasos 4 y 5 del RUNBOOK) y el contenedor no forman parte del simulacro.
- **rclone y la nube.** La prueba externa usa un `rclone` de pega que copia a una carpeta local. `age` es real, con una clave desechable.
  Si `age` no está instalado, la ruta c informa SKIPPED y no se instala nada.
- **Tokens por una red real.** Las apps se arrancan en el mismo proceso, y los tokens se prueban por HTTP en un puerto local.
- **La segunda carpeta de copia de la app de escritorio** (`BackupCopy`) copia el mismo archivo `memory-<date>.db` que a2, así que no se ejecuta por separado.
