# BrainAI on a cloud server

The same BrainAI as on a home server (`docs/RUNBOOK.md`), on a small rented Linux machine instead of one at home.

## What you need

- A Linux server (x86_64 or arm64) with about 2 GB of memory, from any provider. BrainAI itself uses about 1 GB;
  building the image needs a little more.
- A domain on Cloudflare, for the tunnel.
- SSH access with a key.

## Setting it up

Follow `docs/RUNBOOK.md`, section 1, as written: Docker, the clone, the Cloudflare Tunnel, `.env`, start, the
password and the authenticator. Coming from the Mac app, use section 4 ("Moving from the app") instead of starting
empty.

## What differs from a home server

- **No ports to open.** The tunnel connects out to Cloudflare, so the provider's firewall can block every incoming
  port except SSH. Keep it that way: BrainAI trusts the tunnel's address header only because nothing else reaches it.
- **Backups leave the machine.** A rented server can disappear with its disks. Point the nightly backup's copies
  (`COPY_DIRS` in `overlay/scripts.env`) at storage elsewhere, or keep the weekly encrypted off-site copy
  (RUNBOOK, section 1), and try a restore once (section 3).
- **Updates and reboots are yours.** Turn on the provider's automatic security updates for the system, and make sure
  Docker starts at boot (`sudo systemctl enable docker`). Updating BrainAI is the same `git pull && docker compose up -d
  --build`.
- **Cost:** the smallest machines from the common providers cost a few euros a month; BrainAI needs no more.
