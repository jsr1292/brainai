#!/usr/bin/env bash
# Removes the sign-in data from a copy of the memory database, in place: the owner's password hash and
# authenticator secret, sessions, known devices, the Macs' folder-report tokens (and their latest reports), OAuth
# tokens, codes and pending requests; client secrets are replaced (so such a client registers again instead of
# passing as a public client). VACUUM rewrites the file so the deleted rows are gone for good. The same statements
# as STRIP_SIGN_IN_SQL in src/backup.ts. Used by backup.sh (every nightly copy) and offsite.sh (again, on what
# leaves the house). known_devices is new in schema 10, device_tokens in schema 17 and image_upload_links (assistants'
# one-use picture upload links) in schema 25; a database from before the app upgraded it skips them.
set -euo pipefail
DB="$1"
DEVICES=""
if [ -n "$(sqlite3 "$DB" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'known_devices'")" ]; then
  DEVICES="DELETE FROM known_devices;"
fi
if [ -n "$(sqlite3 "$DB" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_tokens'")" ]; then
  DEVICES="$DEVICES DELETE FROM folder_reports; DELETE FROM device_tokens;"
fi
if [ -n "$(sqlite3 "$DB" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_upload_links'")" ]; then
  DEVICES="$DEVICES DELETE FROM image_upload_links;"
fi
sqlite3 -bail "$DB" "PRAGMA journal_mode = DELETE; DELETE FROM owner; DELETE FROM sessions; $DEVICES DELETE FROM oauth_tokens; DELETE FROM oauth_codes; DELETE FROM oauth_pending; UPDATE oauth_clients SET metadata = json_set(metadata, '\$.client_secret', lower(hex(randomblob(32)))) WHERE json_extract(metadata, '\$.client_secret') IS NOT NULL; VACUUM;" >/dev/null
