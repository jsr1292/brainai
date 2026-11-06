# Runbook: running your brain

A single-owner memory server for AI clients (OAuth only, no static keys). It runs as one app container behind a Cloudflare Tunnel. **No ports are published**: the tunnel is the only way in.

## 1. One-time setup
1. Prerequisites on your server (Linux, x86_64 or arm64): Docker + Compose, `sqlite3` (used by the backup script), `git`. Check with `docker compose version`, `sqlite3 --version`, `git --version`. Make sure Docker starts at boot: `sudo systemctl enable docker`. Add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log out and back in): the nightly scripts below call Docker without sudo, and cron cannot answer a sudo prompt.
2. Install:
   ```bash
   git clone https://github.com/jsr1292/cairn.git ~/memory && cd ~/memory
   mkdir -p data backups overlay
   ```
   `overlay/` holds your own settings and texts (see `overlay.example/`); it is never committed.
3. In the Cloudflare dashboard: Networking › Tunnels › create a tunnel (type cloudflared). Copy its token: the long string starting with `eyJ` in the install command it shows (don't run that command; the tunnel runs in Docker here). Then in the tunnel's Routes: Add route › Published application, hostname `memory.<domain>`, service `http://app:3000`. Cloudflare's labels change from time to time; its guide is at developers.cloudflare.com/tunnel/get-started. This tunnel is the **only** way into the app: `docker-compose.yml` publishes no ports, so the login rate limiter can safely trust the `cf-connecting-ip` header.
4. `cp .env.example .env` and fill it in:
   - `PUBLIC_URL=https://memory.<domain>`
   - `TUNNEL_TOKEN=<token>`
   - `PUID` / `PGID`: the output of `id -u` / `id -g` on your server. The container runs as that uid:gid, so `./data` stays writable and readable by the backup script.
   - `OWNER_TIMEZONE` (e.g. `Europe/Berlin`): weeks and days follow it. UTC when it isn't set.
   - `DUPLICATE_THRESHOLD`, `MIN_RECALL_SIMILARITY` and `RECALL_CONFIDENT_SIMILARITY` are optional; leave them commented out unless you want to change them.

   **`.env` holds the tunnel token. Never commit it** (it is in `.gitignore`).
5. Start (the first build downloads the embedding model into the image, so it takes a few minutes): `docker compose up -d --build`
6. Create the owner account (the only account that will ever exist):
   ```bash
   docker compose exec app node dist/cli.js set-password
   docker compose exec app node dist/cli.js setup-totp
   ```
   `set-password` hides what you type, like any password prompt (checked in a real terminal on a clean install, 2026-11-06). `setup-totp` shows a QR code and a secret to add to your authenticator app, then asks for a code to check it.
7. Check:
   - `https://memory.<domain>` shows the login page.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://memory.<domain>/mcp` prints `401`.
8. Nightly backup. The folder `~/memory/backups` must exist first (cron opens the log before the script runs; step 2 created it). Then `crontab -e` and add:
   ```
   30 3 * * * ~/memory/scripts/backup.sh >> ~/memory/backups/backup.log 2>&1
   ```
   The script takes a consistent snapshot of `data/memory.db` into `~/memory/backups/memory-YYYY-MM-DD.db`, checks it with `PRAGMA integrity_check`, and copies it to each folder in `COPY_DIRS` (other drives, a NAS share), which you set in `overlay/scripts.env`:
   ```
   COPY_DIRS=/mnt/ssd/memory-backups /mnt/nas/Backups/memory-backups
   ```
   With no `COPY_DIRS`, the backup stays in `~/memory/backups` only. A copy folder is skipped (with a warning in the log) if the disk or share holding it is not mounted. Files named `memory-*.db` older than 30 days are deleted from those folders; nothing else is ever deleted.

   **Those drives may hold other data. The script only writes to its own `memory-backups` folder.**

   Try it once by hand: `~/memory/scripts/backup.sh`. Settings › Backups and health shows when each copy last succeeded and warns when one was skipped or failed (from `data/backup-status.json`, which the script writes).
9. Nightly Markdown export and git copy. Every page and fact is written as Markdown into a git repo each night (`scripts/export-brain.sh`), and the bare git repos in `~/git` (that export, and any of your own) are copied to your other drives (`scripts/backup-git.sh`). Settings › Backups and health shows them as "not yet" until they first run, then warns if one fails or is more than a day old.
   - Create the folder for bare repos once: `mkdir -p ~/git`. The export makes its own repo there (`~/git/brain-export.git`) on its first run; it never re-creates a missing `~/git`, so a lost folder is noticed instead of silently replaced.
   - In `overlay/scripts.env`, set `GIT_COPY_DIRS` (the folders the repos are copied to, like `COPY_DIRS`) and `EXPORT_GIT_NAME` / `EXPORT_GIT_EMAIL` (the name on the export's commits). See `overlay.example/scripts.env`.
   - `crontab -e` and add, after the backup and before the off-site copy:
     ```
     45 3 * * * ~/memory/scripts/export-brain.sh >> ~/memory/backups/export.log 2>&1
     0 4 * * * ~/memory/scripts/backup-git.sh >> ~/memory/backups/backup-git.log 2>&1
     ```
   - Try both once by hand, export first. The off-site copy (next step) includes the newest export.
10. Weekly off-site copy to Google Drive (`scripts/offsite.sh`), so the memory survives losing the house. It packs the newest nightly backup and a Markdown export into one file, encrypts it to your age public key and uploads it with rclone; copies older than 90 days are deleted there. The private key never touches the server: it lives in your password manager.
   - On your server: `sudo apt install -y age rclone`.
   - On your own computer: install age and rclone (for example `brew install age rclone`), then `age-keygen -o ~/memory-offsite-key.txt`. It prints `Public key: age1…`. Save the whole file's text in your password manager, delete the file, and put the public key (the `age1…` line only) in `~/memory/offsite-recipient.txt` on your server.
   - On your server: `rclone config` → `n` (new remote) → name `gdrive` → storage `drive` → leave client id and secret empty → scope `drive.file` (rclone sees only the files it creates) → leave the rest empty → "Use web browser to automatically authenticate?" `n` → it prints an `rclone authorize "drive" "…"` command: run that on your computer, sign in to Google in the browser, and paste the result back → shared drive `n` → keep.
   - `crontab -e` and add: `15 4 * * 0 $HOME/memory/scripts/offsite.sh >> $HOME/memory/backups/offsite.log 2>&1` (Sundays 04:15). Try it once by hand: `~/memory/scripts/offsite.sh`. The dashboard shows the last off-site copy and warns when it is more than 8 days old or failed (from `data/offsite-status.json`).
   - To restore from it (any computer with age): download the newest `memory-YYYY-MM-DD.tar.gz.age` from the `memory-backups` folder in Google Drive, save the key text from your password manager as `key.txt`, then `age -d -i key.txt memory-….tar.gz.age | tar -xz`. It holds `memory-YYYY-MM-DD.db` (restore it as in section 3) `memory.md` (every memory, readable) and `brain-export/` (every page and fact as Markdown, from the nightly export). Pictures are next to the packs, one encrypted file each under `images/` (section 3, step 5). Delete `key.txt` afterwards.
11. Monitoring: set up a free uptime alert on `https://memory.<domain>` (for example UptimeRobot, or a Cloudflare health check) that emails you if it goes down.

## 2. Day to day
- **Updating:** in `~/memory`, `git pull && docker compose up -d --build`. The site is down for a few seconds. Before any change to the database, the brain copies it to `data/pre-migrate/` (the newest 3 are kept). Settings › Backups and health shows the running version; `CHANGELOG.md` says what changed. If you use Watchtower, it never touches these containers (label `com.centurylinklabs.watchtower.enable=false`).
- **Redirect allowlist** (which AI clients may sign in): `docker compose exec app node dist/cli.js redirects list`, and `redirects add <entry>` / `redirects remove <entry>`.
- **Connected clients:** `docker compose exec app node dist/cli.js clients list`, and `clients revoke <grantId>` (the id shown by `clients list`) to cut one off. New anonymous registrations stop at 200 a day (so nobody can fill the database); if that blocks a real app from connecting, `clients purge-unused` deletes every registration that never got a grant, and the app can register again.
- **Project aliases** (another name a project is saved, briefed and searched under, e.g. an app name for its repo folder): `docker compose exec app node dist/cli.js aliases list`, `aliases add <alias> <project>` (moves any memories filed under the alias) and `aliases remove <alias>`. "Move all" on the dashboard's Tidy up page records one too.
- Logs: `docker compose logs --tail 100 app`.
- **Locked out of the dashboard** after too many failed logins: wait for the time the login page shows, or run `docker compose restart app` in `~/memory`. The login limiter lives in memory, so a restart clears it.

## 3. Restore from backup
Only if `data/memory.db` is damaged or lost. **Done by hand by the owner; nothing automated does this.** Run in `~/memory`:
1. `docker compose stop app`
2. Keep the broken database aside (SQLite would otherwise try to apply a leftover `-wal` or `-shm` file to the restored copy), then copy the chosen backup in its place. Pick the file with `ls backups` (or from one of your `COPY_DIRS`):
   ```bash
   STAMP=$(date +%F-%H%M)
   mv data/memory.db data/memory.db.broken-$STAMP
   rm -f data/memory.db-wal data/memory.db-shm
   cp backups/memory-YYYY-MM-DD.db data/memory.db
   ```
3. Check it: `sqlite3 data/memory.db 'PRAGMA integrity_check'` must print exactly `ok`. If not, don't start the app: try the previous night's backup (repeat from the `cp` line).
4. `chown <PUID>:<PGID> data/memory.db` (the values in `.env`).
5. Pictures (round 2): the picture files are not in the database. With the app still stopped, copy them back from the same night's copy folder, which only ever adds files:
   ```bash
   rsync -a <one of your COPY_DIRS>/images/ data/images/
   ```
   From the off-site copy instead (any computer with age and rclone): `rclone copy gdrive:memory-backups/images ./images-age`, save the key text as `key.txt`, then
   ```bash
   cd images-age && for f in *.age; do d="${f:0:2}"; mkdir -p "../data/images/$d"; age -d -i ../key.txt -o "../data/images/$d/${f%.age}" "$f"; done
   ```
   and copy `data/images/` into `~/memory/data/images/` on your server. Delete `key.txt` afterwards.
   Either way, check that every picture the database lists has its file. This prints nothing when all are there:
   ```bash
   sqlite3 data/memory.db "SELECT substr(id,1,2)||'/'||id||'.'||CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE removed_at IS NULL" | while read -r f; do [ -f "data/images/$f" ] || echo "missing: $f"; done
   ```
   Then `chown -R <PUID>:<PGID> data/images`.
6. Backups hold no sign-in data (no password, authenticator secret, sessions, tokens or client secrets), so set them again before starting: `docker compose run --rm app node dist/cli.js set-password`, then `docker compose run --rm app node dist/cli.js setup-totp` and scan the new code into the authenticator app (the old entry no longer works).
7. `docker compose start app`
8. What is lost: everything saved since that backup was taken (03:30 that night). Re-add those memories by hand.
9. Every AI app has to sign in again, because no tokens are in a backup: reconnect each app when it reports the memory server as disconnected or asks to sign in, as described in `docs/CLIENTS.md`. Their registrations and access levels are kept, except for apps connected after the backup was taken and apps that had a client secret (theirs is replaced in a backup), which register again.

## 4. Remote admin
To reach your server from outside, connect to your home VPN first, then SSH to its local address. **Never open an SSH port, or any other port, to the internet.**

## 5. Recall test

`~/memory/data/recall-test.json` holds real questions an assistant might ask, each with the ids of the memories that should answer it (`[{ "q": "...", "expect": ["<memory id>"], "project": "optional" }]`). It stays out of git because it is personal data. Run it after changing search settings or adding many memories:

```
docker compose exec app node dist/cli.js recall-test
```

It prints how often the right memory came first, in the top 3 and in the top 8, the misses with what came back instead, and questions whose memories were deleted. It changes nothing: no memory is marked as recalled. `recall-holdout.json` next to it holds 20 more questions that were never used for tuning: after changing search settings, check them too (`... recall-test data/recall-holdout.json`) so a change that only fits the main set shows up.
