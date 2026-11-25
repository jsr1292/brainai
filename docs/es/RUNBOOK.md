Read in English: [docs/RUNBOOK.md](../RUNBOOK.md)

# Manual de operación: cómo mantener tu memoria en marcha

Un servidor de memoria de un solo propietario para clientes de IA (solo OAuth, sin claves estáticas). Funciona como un único contenedor de la app detrás de un túnel de Cloudflare. **No se publica ningún puerto**: el túnel es la única entrada.

## 1. Configuración inicial
1. Requisitos previos en tu servidor (Linux, x86_64 o arm64): Docker + Compose, `sqlite3` (lo usa el script de copia de seguridad) y `git`. Compruébalos con `docker compose version`, `sqlite3 --version` y `git --version`. Asegúrate de que Docker arranque con el sistema: `sudo systemctl enable docker`. Añádete al grupo `docker` (`sudo usermod -aG docker $USER`, y luego cierra sesión y vuelve a entrar): los scripts nocturnos de más abajo llaman a Docker sin sudo, y cron no puede responder a una petición de contraseña de sudo.
2. Instala:
   ```bash
   git clone https://github.com/jsr1292/brainai.git ~/memory && cd ~/memory
   mkdir -p data backups overlay
   ```
   `overlay/` guarda tus propios ajustes y textos (mira `overlay.example/`); nunca se sube a git.
3. En el panel de Cloudflare: Networking › Tunnels › crea un túnel (tipo cloudflared). Copia su token: la cadena larga que empieza por `eyJ` en el comando de instalación que te muestra (no ejecutes ese comando; aquí el túnel funciona dentro de Docker). Después, en las Routes del túnel: Add route › Published application, nombre de host `memory.<domain>`, servicio `http://app:3000`. Las etiquetas de Cloudflare cambian de vez en cuando; su guía está en developers.cloudflare.com/tunnel/get-started. Este túnel es la **única** entrada a la app: `docker-compose.yml` no publica ningún puerto, así que el limitador de intentos de inicio de sesión puede fiarse sin problema de la cabecera `cf-connecting-ip`.
4. `cp .env.example .env` y rellénalo:
   - `PUBLIC_URL=https://memory.<domain>`
   - `TUNNEL_TOKEN=<token>`
   - `PUID` / `PGID`: lo que imprimen `id -u` / `id -g` en tu servidor. El contenedor se ejecuta con ese uid:gid, de modo que `./data` sigue siendo escribible y legible para el script de copia de seguridad.
   - `OWNER_TIMEZONE` (por ejemplo `Europe/Berlin`): las semanas y los días la siguen. Si no se define, se usa UTC.
   - `DUPLICATE_THRESHOLD`, `MIN_RECALL_SIMILARITY` y `RECALL_CONFIDENT_SIMILARITY` son opcionales; déjalas comentadas salvo que quieras cambiarlas.

   **`.env` contiene el token del túnel. No lo subas nunca a git** (está en `.gitignore`).
5. Arranca (la primera compilación descarga el modelo de embeddings dentro de la imagen, así que tarda unos minutos): `docker compose up -d --build`
6. Crea la cuenta del propietario (la única que existirá jamás):
   ```bash
   docker compose exec app node dist/cli.js set-password
   docker compose exec app node dist/cli.js setup-totp
   ```
   `set-password` oculta lo que escribes, como cualquier petición de contraseña (comprobado en un terminal real con una instalación limpia, 2026-11-06). `setup-totp` muestra un código QR y un secreto para añadirlos a tu app de autenticación, y después te pide un código para comprobarlo.
7. Comprueba:
   - `https://memory.<domain>` muestra la página de inicio de sesión.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://memory.<domain>/mcp` imprime `401`.
8. Copia de seguridad nocturna. La carpeta `~/memory/backups` tiene que existir antes (cron abre el registro antes de que se ejecute el script; el paso 2 la creó). Después, `crontab -e` y añade:
   ```
   30 3 * * * ~/memory/scripts/backup.sh >> ~/memory/backups/backup.log 2>&1
   ```
   El script toma una instantánea coherente de `data/memory.db` en `~/memory/backups/memory-YYYY-MM-DD.db`, la comprueba con `PRAGMA integrity_check` y la copia en cada carpeta de `COPY_DIRS` (otros discos, un recurso compartido de un NAS), que defines en `overlay/scripts.env`:
   ```
   COPY_DIRS=/mnt/ssd/memory-backups /mnt/nas/Backups/memory-backups
   ```
   Sin `COPY_DIRS`, la copia de seguridad se queda solo en `~/memory/backups`. Una carpeta de copia se omite (con un aviso en el registro) si el disco o el recurso compartido que la contiene no está montado. Los archivos llamados `memory-*.db` con más de 30 días se borran de esas carpetas; nunca se borra nada más.

   **Esos discos pueden contener otros datos. El script solo escribe en su propia carpeta `memory-backups`.**

   Pruébalo una vez a mano: `~/memory/scripts/backup.sh`. Ajustes › Copias de seguridad muestra cuándo tuvo éxito por última vez cada copia y avisa cuando una se omitió o falló (a partir de `data/backup-status.json`, que escribe el script).
9. Exportación nocturna a Markdown y copia en git. Cada página y cada dato se escribe como Markdown en un repositorio git cada noche (`scripts/export-brain.sh`), y los repositorios git bare de `~/git` (esa exportación y los que tengas tú) se copian a tus otros discos (`scripts/backup-git.sh`). Ajustes › Copias de seguridad los muestra como "aún no" hasta que se ejecutan por primera vez, y después avisa si alguno falla o tiene más de un día.
   - Crea una vez la carpeta para los repositorios bare: `mkdir -p ~/git`. La exportación crea allí su propio repositorio (`~/git/brain-export.git`) la primera vez que se ejecuta; nunca vuelve a crear un `~/git` que falte, para que se note la pérdida de la carpeta en vez de taparla en silencio.
   - En `overlay/scripts.env`, define `GIT_COPY_DIRS` (las carpetas a las que se copian los repositorios, igual que `COPY_DIRS`) y `EXPORT_GIT_NAME` / `EXPORT_GIT_EMAIL` (el nombre que aparece en los commits de la exportación). Mira `overlay.example/scripts.env`.
   - `crontab -e` y añade, después de la copia de seguridad y antes de la copia externa:
     ```
     45 3 * * * ~/memory/scripts/export-brain.sh >> ~/memory/backups/export.log 2>&1
     0 4 * * * ~/memory/scripts/backup-git.sh >> ~/memory/backups/backup-git.log 2>&1
     ```
   - Prueba ambos una vez a mano, primero la exportación. La copia externa (el paso siguiente) incluye la exportación más reciente.
10. Copia externa semanal a Google Drive (`scripts/offsite.sh`), para que la memoria sobreviva a perder la casa. Empaqueta la copia de seguridad nocturna más reciente y una exportación a Markdown en un solo archivo, lo cifra con tu clave pública de age y lo sube con rclone; las copias con más de 90 días se borran allí. La clave privada nunca toca el servidor: vive en tu gestor de contraseñas.
    - En tu servidor: `sudo apt install -y age rclone`.
    - En tu propio ordenador: instala age y rclone (por ejemplo `brew install age rclone`) y ejecuta `age-keygen -o ~/memory-offsite-key.txt`. Imprime `Public key: age1…`. Guarda el texto completo del archivo en tu gestor de contraseñas, borra el archivo y pon la clave pública (solo la línea `age1…`) en `~/memory/offsite-recipient.txt` en tu servidor.
    - En tu servidor: `rclone config` → `n` (nuevo remoto) → nombre `gdrive` → almacenamiento `drive` → deja vacíos el id de cliente y el secreto → ámbito `drive.file` (rclone solo ve los archivos que crea él) → deja vacío el resto → "Use web browser to automatically authenticate?" `n` → imprime un comando `rclone authorize "drive" "…"`: ejecútalo en tu ordenador, inicia sesión en Google en el navegador y pega el resultado de vuelta → unidad compartida `n` → conservar.
    - `crontab -e` y añade: `15 4 * * 0 $HOME/memory/scripts/offsite.sh >> $HOME/memory/backups/offsite.log 2>&1` (los domingos a las 04:15). Pruébalo una vez a mano: `~/memory/scripts/offsite.sh`. El panel muestra la última copia externa y avisa cuando tiene más de 8 días o falló (a partir de `data/offsite-status.json`).
    - Para restaurar desde ella (en cualquier ordenador con age): descarga el `memory-YYYY-MM-DD.tar.gz.age` más reciente de la carpeta `memory-backups` de Google Drive, guarda el texto de la clave de tu gestor de contraseñas como `key.txt` y ejecuta `age -d -i key.txt memory-….tar.gz.age | tar -xz`. Contiene `memory-YYYY-MM-DD.db` (restáuralo como en la sección 3), `memory.md` (cada dato de la memoria, legible) y `brain-export/` (cada página y cada dato en Markdown, de la exportación nocturna). Las imágenes están junto a los paquetes, un archivo cifrado por cada una dentro de `images/` (sección 3, paso 5). Borra `key.txt` después.
11. Supervisión: configura una alerta de disponibilidad gratuita para `https://memory.<domain>` (por ejemplo UptimeRobot, o una comprobación de estado de Cloudflare) que te mande un correo si deja de responder.

## 2. Día a día
- **Actualizar:** en `~/memory`, `git pull && docker compose up -d --build`. El sitio se cae unos segundos. Antes de cualquier cambio en la base de datos, la memoria la copia en `data/pre-migrate/` (se conservan las 3 más recientes). Ajustes › Copias de seguridad muestra la versión en ejecución; `CHANGELOG.md` explica qué cambió. Si usas Watchtower, nunca toca estos contenedores (etiqueta `com.centurylinklabs.watchtower.enable=false`).
- **Lista de redirecciones permitidas** (qué clientes de IA pueden iniciar sesión): `docker compose exec app node dist/cli.js redirects list`, y `redirects add <entry>` / `redirects remove <entry>`.
- **Clientes conectados:** `docker compose exec app node dist/cli.js clients list`, y `clients revoke <grantId>` (el id que muestra `clients list`) para cortar uno. Los registros anónimos nuevos se detienen en 200 al día (para que nadie pueda llenar la base de datos); si eso impide que se conecte una app real, `clients purge-unused` borra todos los registros que nunca llegaron a tener una concesión, y la app puede volver a registrarse.
- **Alias de proyecto** (otro nombre con el que se guarda, se resume y se busca un proyecto, por ejemplo el nombre de una app para la carpeta de su repositorio): `docker compose exec app node dist/cli.js aliases list`, `aliases add <alias> <project>` (mueve los datos archivados bajo el alias) y `aliases remove <alias>`. "Mover todo" en la página Ordenar del panel también registra uno.
- Registros: `docker compose logs --tail 100 app`.
- **Bloqueado en el panel** tras demasiados inicios de sesión fallidos: espera al tiempo que indica la página de inicio de sesión, o ejecuta `docker compose restart app` en `~/memory`. El limitador de inicio de sesión vive en memoria, así que reiniciar lo borra.

## 3. Restaurar desde una copia de seguridad
Solo si `data/memory.db` está dañado o se ha perdido. **Lo hace a mano el propietario; nada automático hace esto.** Un simulacro con script (`npm run drill:restore`) recorre los mismos pasos en una máquina limpia y comprueba el resultado: `docs/es/RESTORE-DRILL.md`, con lo que una restauración no recupera. Ejecuta en `~/memory`:
1. `docker compose stop app`
2. Aparta la base de datos rota (si no, SQLite intentaría aplicar un archivo `-wal` o `-shm` sobrante a la copia restaurada) y después copia en su lugar la copia de seguridad elegida. Elige el archivo con `ls backups` (o de una de tus `COPY_DIRS`):
   ```bash
   STAMP=$(date +%F-%H%M)
   mv data/memory.db data/memory.db.broken-$STAMP
   rm -f data/memory.db-wal data/memory.db-shm
   cp backups/memory-YYYY-MM-DD.db data/memory.db
   ```
3. Compruébala: `sqlite3 data/memory.db 'PRAGMA integrity_check'` debe imprimir exactamente `ok`. Si no, no arranques la app: prueba con la copia de seguridad de la noche anterior (repite desde la línea `cp`).
4. `chown <PUID>:<PGID> data/memory.db` (los valores de `.env`).
5. Imágenes (ronda 2): los archivos de imagen no están en la base de datos. Con la app todavía parada, cópialos de vuelta desde la carpeta de copia de esa misma noche, que solo añade archivos:
   ```bash
   rsync -a <one of your COPY_DIRS>/images/ data/images/
   ```
   Si lo haces desde la copia externa (en cualquier ordenador con age y rclone): `rclone copy gdrive:memory-backups/images ./images-age`, guarda el texto de la clave como `key.txt` y después
   ```bash
   cd images-age && for f in *.age; do d="${f:0:2}"; mkdir -p "../data/images/$d"; age -d -i ../key.txt -o "../data/images/$d/${f%.age}" "$f"; done
   ```
   y copia `data/images/` en `~/memory/data/images/` en tu servidor. Borra `key.txt` después.
   Sea como sea, comprueba que cada imagen que figura en la base de datos tiene su archivo. Esto no imprime nada cuando están todas:
   ```bash
   sqlite3 data/memory.db "SELECT substr(id,1,2)||'/'||id||'.'||CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE removed_at IS NULL" | while read -r f; do [ -f "data/images/$f" ] || echo "missing: $f"; done
   ```
   Después, `chown -R <PUID>:<PGID> data/images`.
6. Las copias de seguridad no contienen datos de inicio de sesión (ni contraseña, ni secreto del autenticador, ni sesiones, ni tokens, ni secretos de cliente), así que vuelve a definirlos antes de arrancar: `docker compose run --rm app node dist/cli.js set-password`, después `docker compose run --rm app node dist/cli.js setup-totp` y escanea el código nuevo en la app de autenticación (la entrada antigua ya no sirve).
7. `docker compose start app`
8. Lo que se pierde: todo lo guardado desde que se hizo esa copia de seguridad (las 03:30 de esa noche). Vuelve a añadir esos datos a mano.
9. Todas las apps de IA tienen que volver a iniciar sesión, porque ninguna copia de seguridad contiene tokens: reconecta cada app cuando informe de que el servidor de memoria está desconectado o te pida iniciar sesión, como se describe en `docs/es/CLIENTS.md`. Sus registros y niveles de acceso se conservan, salvo los de las apps conectadas después de hacer la copia de seguridad y los de las apps que tenían un secreto de cliente (el suyo se sustituye en una copia de seguridad), que se registran de nuevo.

## 4. Pasar desde la app
Para una memoria que empezó en la app BrainAI de un ordenador y ahora pasa a este servidor, conservando todos los
datos, páginas e imágenes. Después, las apps se reconectan a la dirección del servidor.
1. **En el ordenador:** BrainAI › Ajustes › Pasar a un servidor › **Crear el archivo de traslado**, y después Mostrar en el Finder. El archivo,
   `brainai-saved-<date>.tar.gz`, contiene todos los datos de la memoria en claro, pero ninguna contraseña, autenticador ni inicio de sesión de apps.
2. **El servidor:** haz los pasos 1-4 de *Configuración inicial* (Docker, el clon, el túnel, `.env`), pero no lo arranques todavía. Si ya está en marcha,
   páralo primero: `docker compose stop app`. Su `data/` no debe contener otra memoria (`data/memory.db`): esto la sustituye.
3. **Copia el archivo** en `~/memory/data/` del servidor, la única carpeta que ve el contenedor (por ejemplo
   `scp brainai-saved-*.tar.gz you@server:memory/data/`), y después, en `~/memory`:
   ```bash
   docker compose run --rm app node dist/cli.js restore data/brainai-saved-<date>.tar.gz
   ```
   Comprueba el archivo y después trae todos los datos y las imágenes a `data/`, con el usuario propietario correcto. Solo rellena una
   memoria vacía: si `data/` ya contiene datos, lo dice y no cambia nada. Un archivo `brainai-move-…` más antiguo también sirve.
4. **Define el inicio de sesión**, que el archivo no incluye: `docker compose run --rm app node dist/cli.js set-password`, y después
   `docker compose run --rm app node dist/cli.js setup-totp`.
5. **Arráncalo:** `docker compose up -d --build`. El servidor actualiza la base de datos a su propia versión (antes se guarda una copia en
   `data/pre-migrate/`). Inicia sesión en tu dirección: los datos están ahí. Después, los pasos 7-8 de *Configuración inicial*
   (las comprobaciones y la copia de seguridad nocturna). Cuando el servidor funcione, borra el archivo de `data/`, donde guarda todos los datos
   en claro junto a la base de datos: `rm data/brainai-saved-<date>.tar.gz`.
6. **Reconecta cada app** desde Ajustes › Configurar una app del servidor (`docs/es/CLIENTS.md`): también las herramientas de programación del
   ordenador, que apuntaban a la app.
7. **En el ordenador:** Ajustes › Pasar a un servidor › **Ya está pasado**, con la dirección del servidor. Entonces la app indica a cualquier
   app que siga apuntando a ella dónde vive la memoria, y ofrece **Quitar BrainAI de este Mac**: guarda una copia, desconecta las
   herramientas y quita la app y sus datos. Borra el archivo de traslado cuando el servidor funcione.

## Dejar BrainAI
Para quitar BrainAI de este servidor definitivamente, ejecuta esto en `~/memory`, con tu propio usuario (no con sudo):
```bash
scripts/remove.sh
```
1. **Primero guarda una copia** en tu carpeta personal (`BrainAI saved <date>`) e imprime la línea `scp` que la trae a
   tu ordenador. También puedes descargar una desde el panel (Ajustes › Guardar una copia de todo: te pide
   el código de tu autenticador y descarga un `.tar.gz`). Espera a que pulses Intro. Si falla el guardado, no se quita nada.
2. **Lista lo que va a quitar** y espera a que escribas `remove`. Es decir: las líneas de BrainAI en tu crontab (copia de seguridad,
   exportación a Markdown, copia externa), sus contenedores y volúmenes y su propia imagen, la exportación a Markdown (`~/git/brain-export.git`,
   y los archivos que escribió en `~/brain-export`, nada más de ahí) y `~/memory` con sus datos. La tarea de copia en git
   también hace copia de tus propios repositorios de `~/git`, así que su línea de crontab solo se quita si `~/git` no contiene nada más. Nunca
   toca nada que no reconozca como de BrainAI.
3. **Las copias externas** se preguntan una por una y se conservan salvo que respondas `y`: las instantáneas nocturnas de tus otros
   discos, las copias del historial git de la exportación y las copias cifradas de Google Drive. Cada pregunta dice qué hay:
   cuántos archivos y de cuándo para las instantáneas y Drive, la fecha del último cambio para la copia en git. La propia configuración de rclone no se toca.
4. **Termina con una lista de comprobación** de lo que solo puedes quitar tú: el túnel de Cloudflare y su dirección, los conectores de
   Claude, ChatGPT y Grok, el texto de configuración pegado en cada app, la alerta de disponibilidad y la clave de la copia externa en tu propio
   ordenador. La misma lista está en el `README.txt` de la carpeta guardada.

Si `docker compose down` falla, se detiene ahí y te dice cómo terminar: arréglalo y vuelve a ejecutar el script. Para entonces,
las líneas del crontab ya no están.

## Volver desde una copia guardada
Para una instalación nueva, o después del script anterior. Haz los pasos 1-4 de *Configuración inicial* (pero no lo arranques), copia el
`brainai-saved-<date>.tar.gz` de la carpeta guardada en `~/memory/data/` del servidor (por ejemplo
`scp brainai-saved-*.tar.gz you@server:memory/data/`) y después sigue la sección 4, pasos 3-5 (el comando `restore`, el
inicio de sesión, el arranque). Cuando el servidor funcione, borra el archivo de `data/`: `rm data/brainai-saved-<date>.tar.gz`. Si
descargaste la copia desde el panel, descomprímela primero (`tar -xzf "BrainAI saved <date>.tar.gz"`): el archivo que quieres
está dentro. La carpeta `Markdown/` es para leer; BrainAI no la vuelve a leer.

## Ajustes que puedes definir en `.env`
- **Debates sin retransmitir (`ASK_COMMANDS`):** un objeto JSON con el nombre del asistente (conexión) y el comando de shell, con
  `{prompt}`, por ejemplo `{"Codex":"codex exec --skip-git-repo-check \"{prompt}\""}`. Al asistente que abrió un
  debate se le dice que dé primero su propia opinión y que después ejecute el comando de cada asistente consultado que tenga un comando
  y no haya respondido en esta ronda; el prompt contiene solo el id del debate. Cuando todos han respondido en la ronda 2 o
  posterior, se le dice que informe al propietario, que decide o empieza otra ronda. Solo el que abre recibe comandos, y
  solo cuando él mismo tiene un comando (un asistente de línea de comandos en el ordenador del propietario, no una app de chat), nunca el
  suyo, de modo que un asistente al que consulta no puede consultar a su vez a los demás. Los nombres coinciden sin distinguir mayúsculas, espacios ni
  guiones. El servidor nunca ejecuta un comando por sí mismo. Por ejemplo, para Claude Code y Grok Build en tu ordenador:
  `{"Claude Code":"claude -p \"{prompt}\" --allowedTools mcp__memory","Grok Build":"grok -p \"{prompt}\" --allow
  \"MCPTool(memory__*)\" --permission-mode dontAsk"}`: cada asistente consultado solo puede usar sus herramientas de memoria. La
  app de escritorio define por defecto comandos para Claude Code y Codex; `ASK_COMMANDS` los sustituye.
- **Datos retenidos:** un guardado o una actualización de una IA que suena a instrucción para asistentes (`src/memory/instructionLike.ts`)
  espera en Inicio, en el panel, a que lo apruebes, igual que un cambio de perfil. Los guardados del propio propietario nunca se retienen.
- **`BACKUP_DIR`** (desactivado por defecto): una instantánea en un solo archivo, con fecha y comprobada, al arrancar y cada 24 horas;
  se conservan las `BACKUP_KEEP` más recientes (por defecto 14). La instalación con Docker sigue usando `scripts/backup.sh`. Ninguna
  copia de seguridad contiene datos de inicio de sesión (hash de la contraseña, secreto del autenticador, sesiones, tokens, secretos de cliente): tras una restauración,
  ejecuta de nuevo `set-password` y `setup-totp` y reconecta los asistentes.
- **`cli export [file]`:** todos los datos activos como Markdown legible.

## 5. Administración remota
Para llegar a tu servidor desde fuera, conéctate primero a tu VPN doméstica y después entra por SSH a su dirección local. **No abras nunca un puerto SSH, ni ningún otro puerto, a internet.**

## 6. Prueba de recuerdo

`~/memory/data/recall-test.json` contiene preguntas reales que podría hacer un asistente, cada una con los ids de los datos que deberían responderla (`[{ "q": "...", "expect": ["<memory id>"], "project": "optional" }]`). No entra en git porque son datos personales. Ejecútala después de cambiar los ajustes de búsqueda o de añadir muchos datos:

```
docker compose exec app node dist/cli.js recall-test
```

Imprime con qué frecuencia el dato correcto salió el primero, entre los 3 primeros y entre los 8 primeros, los fallos con lo que salió en su lugar, y las preguntas cuyos datos se borraron. No cambia nada: ningún dato se marca como recordado. `recall-holdout.json`, a su lado, contiene 20 preguntas más que nunca se usaron para ajustar: tras cambiar los ajustes de búsqueda, compruébalas también (`... recall-test data/recall-holdout.json`) para que se note un cambio que solo se ajusta al conjunto principal.

## 7. Despliegue, pruebas antes de subir y simulacro de la copia externa (en el Mac)
- **Una vez por clon:** `git config core.hooksPath scripts/hooks`, e indica dónde está tu servidor (los scripts no traen ninguna dirección): `git config brainai.deploy.ssh <usuario>@<servidor>` y `git config brainai.deploy.url https://<tu-dominio>` (o las variables `DEPLOY_SSH` y `DEPLOY_URL`). El hook actúa sobre el remoto llamado `minipc`; para un push por URL, `git config brainai.deploy.pushurl <esa url>`. Después, cada `git push` de `main` al remoto `minipc` (o a la dirección del mini PC) ejecuta antes `npm run typecheck` y `npm test`, salvo que ese commit ya se haya probado: `scripts/test-and-record.sh` ejecuta ambos y apunta el sha del commit en `.git/brainai-green`, y un push que pasa también lo hace. Otros remotos y ramas no se tocan. Solo en emergencia: `BRAINAI_SKIP_TESTS=1 git push minipc main` se las salta con un aviso fuerte.
- **Despliegue:** `scripts/deploy-minipc.sh` (prueba antes `--dry-run`: imprime cada comando y no ejecuta ninguno). Se niega con cambios sin confirmar, fuera de `main`, o si HEAD no está anotado como verde (`--force-untested` lo permite). Sube el código; en el servidor copia la base de datos a `data/memory-pre-<versión>-<fecha>-<hora>-<sha>.db` (modo 600), hace `git pull --ff-only` y `docker compose up -d --build`; espera hasta 2 minutos y comprueba: la versión en ejecución es la de `package.json`, la versión del esquema (se muestra), la app está Up, ninguna línea con `error` o `fatal` en los últimos 2 minutos de logs, y `POST /mcp` sin token responde 401. Si algo falla, imprime los pasos para volver atrás.
- **Simulacro de la copia externa** (comprueba que la copia de Google Drive se abre con tu clave; requiere `brew install age`): `pbpaste | scripts/offsite-drill.sh -` con el texto de la clave en el portapapeles (luego límpialo: `pbcopy </dev/null`; con Portapapeles Universal la clave pudo llegar a tus otros dispositivos Apple), o `scripts/offsite-drill.sh ruta/key.txt`. Descarga la copia más reciente por ssh, la descifra y la abre en una carpeta temporal (se borra siempre; la clave nunca se escribe en disco), comprueba `integrity_check`, los recuentos de datos y páginas frente al servidor, la exportación Markdown y la edad de la copia (más de 8 días es FAIL), e imprime PASS o FAIL. No escribe nada en el servidor; con `--record`, el resultado (PASS o FAIL) se escribe en `data/offsite-drill.json` y Ajustes › Copias de seguridad muestra la línea "Prueba de restauración".
