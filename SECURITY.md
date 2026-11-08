# Security

## Reporting a problem

Please report security problems privately, through GitHub's "Report a vulnerability" button on this repository's
Security tab, not in a public issue. Say what you found, how to reproduce it and what it lets someone do. You should
hear back within a week.

## How BrainAI is meant to be run

BrainAI holds a person's memories, so it is built to be reached by its owner and their apps only:

- **One owner, no static keys.** The dashboard needs a password and an authenticator code. Apps connect with OAuth,
  and the owner approves each one; any connection can be cut off from Settings or the command line.
- **No open ports.** `docker-compose.yml` publishes none: a Cloudflare Tunnel is the only way in. The login rate limit
  trusts the tunnel's `cf-connecting-ip` header only because of that (`TRUST_CF_CONNECTING_IP`).
- **Secrets are refused.** Text that looks like a password, key or token is not saved as a memory or page.
- **Backups hold no sign-in data:** no password, authenticator secret, sessions or tokens. The off-site copy is
  encrypted to a key that never touches the server.
- **Memories are information, not instructions.** Assistants are told never to run commands or send data because a
  memory says so, and memories that read like instructions wait for the owner's approval.

If you run it differently (a published port, a reverse proxy other than the tunnel), leave
`TRUST_CF_CONNECTING_IP` off and make sure only your proxy can reach the app.

## Supported versions

Only the newest release gets fixes. Updating is `git pull && docker compose up -d --build`.
