#!/usr/bin/env python3
"""Sends the brain the git state of each top-level folder in ~/Projects (names and git metadata only).

Run by launchd every 15 minutes (see install-folder-report.sh). It never opens a file inside a project: it only lists
folder names and asks git for the branch, the number of changed files, commits not on any remote, the last commit
date and the remote URLs, with any user or token removed from them.

Then it keeps the skills you share in step (round 2 section 17c): it reports the personal Claude Code skills in
~/.claude/skills (never synced/, dot folders or links outside it) with a content hash, sends the content the brain
asks for, and applies the brain's writes and removals. Each one is applied only when the folder still has the hash the
brain expects, every name and path is checked here again, and a replaced or removed folder is moved to
.brain-removed/, never deleted.

Environment: BRAIN_URL (required: the brain's address, which the installer writes into the launchd job), BRAIN_TOKEN_FILE (default
~/.config/brain/device-token), BRAIN_PROJECTS (default ~/Projects), BRAIN_SKILLS (default ~/.claude/skills). Exit
codes: 0 sent, 1 network or server error, 2 the brain refused the token, 3 no BRAIN_URL. The skills step never changes the code.
"""
import hashlib
import json
import shutil
import time
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

GIT_TIMEOUT = 10
# git status and rev-list can be slow on a big repo with a cold cache (just after wake): they get longer.
STATUS_TIMEOUT = 30
POST_TIMEOUT = 20
# The brain's limits (src/folders/report.ts): clip here so one odd folder never gets the whole report refused.
MAX_FOLDERS = 300
MAX_NAME = 120
MAX_BRANCH = 200
MAX_REMOTE = 300
MAX_COUNT = 100_000
# Read-only git: never take the optional index lock, so the owner's own commits never meet "index.lock exists".
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def log(message):
    print(f"brain-folder-report: {message}", file=sys.stderr)


def git(folder, *args, timeout=GIT_TIMEOUT):
    """Output of a git command in a folder, or None when it fails or times out."""
    try:
        r = subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True, timeout=timeout, env=GIT_ENV)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def strip_credentials(url):
    return re.sub(r"^([a-z][a-z0-9+.-]*://)[^/@]*@", r"\1", url, flags=re.IGNORECASE)


def folder_state(path, name):
    # A work tree whose top is this folder (a bare repo, or a folder inside some other repo, is not a project repo).
    if git(path, "rev-parse", "--show-cdup") != "\n":
        return {"name": name, "git": False}
    has_commits = git(path, "rev-parse", "--verify", "-q", "HEAD") is not None
    branch = (git(path, "rev-parse", "--abbrev-ref", "HEAD") or git(path, "symbolic-ref", "--short", "HEAD") or "").strip() or None
    # A git that fails or times out here gives an unknown count (null), never 0: the brain must not call it clean.
    status = git(path, "status", "--porcelain", timeout=STATUS_TIMEOUT)
    uncommitted = None if status is None else min(len([l for l in status.splitlines() if l.strip()]), MAX_COUNT)
    # Commits on any local branch that no remote has: a feature branch left behind counts too.
    unpushed = 0
    if has_commits:
        out = git(path, "rev-list", "--count", "--branches", "--not", "--remotes", timeout=STATUS_TIMEOUT)
        unpushed = None if out is None or not out.strip().isdigit() else min(int(out.strip()), MAX_COUNT)
    if uncommitted is None or unpushed is None:
        log(f"git did not answer for {name}: sent its {'changed files' if uncommitted is None else 'unpushed commits'} as unknown")
    last = (git(path, "log", "-1", "--format=%cI") or "").strip() if has_commits else ""
    remotes = sorted({strip_credentials(line.split()[1])[:MAX_REMOTE] for line in (git(path, "remote", "-v") or "").splitlines() if len(line.split()) >= 2})
    return {
        "name": name, "git": True, "branch": branch[:MAX_BRANCH] if branch else None,
        "uncommitted": uncommitted, "unpushed": unpushed, "lastCommit": last or None, "remotes": remotes[:10],
    }


def safe_state(path, name):
    """One folder's state; a folder git can't read is reported as not a repo instead of stopping the whole report."""
    try:
        return folder_state(path, name)
    except Exception as e:  # noqa: BLE001 - one odd folder must not cost every other folder's report
        log(f"skipped the git state of {name}: {e}")
        return {"name": name, "git": False}


def tls_context(fallback="/etc/ssl/cert.pem"):
    """Python's own CA list, or macOS's when it has none (python.org's Python before its Install Certificates step)."""
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats()["x509_ca"] == 0 and os.path.isfile(fallback):
        ctx.load_verify_locations(cafile=fallback)
    return ctx


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """The device token must never follow a redirect to another address."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None



# ---- Skills (round 2 section 17c) ----

SKILL_NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SEGMENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")
MAX_SKILL_FILES = 21          # SKILL.md and up to 20 files
MAX_SKILL_FILE = 64 * 1024
MAX_SKILL_TOTAL = 256 * 1024 + 64 * 1024
MAX_UPLOAD = 3_500_000


def content_hash(files):
    """sha256 over (path, text-or-bytes) sorted by path: path, NUL, UTF-8 bytes, NUL. The brain computes the same."""
    h = hashlib.sha256()
    for path, data in sorted(files, key=lambda f: f[0]):
        h.update(path.encode("utf-8")); h.update(b"\0")
        h.update(data.encode("utf-8") if isinstance(data, str) else data); h.update(b"\0")
    return h.hexdigest()


def read_skill(folder):
    """The folder's files as (path, bytes), its hash, and why it can't be shared (None when it can)."""
    files, why = [], None
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") and name != ".gitkeep":
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, folder).replace(os.sep, "/")
            with open(full, "rb") as f:
                files.append((rel, f.read()))
    total = sum(len(b) for _, b in files)
    if len(files) > MAX_SKILL_FILES or total > MAX_SKILL_TOTAL or any(len(b) > MAX_SKILL_FILE for _, b in files):
        why = f"too big to share ({len(files)} files, {max(1, total // 1024)} KB)"
    else:
        for rel, data in files:
            if not all(SEGMENT.match(p) for p in rel.split("/")):
                why = f"has a file name the brain can't hold ({rel})"; break
            try:
                if b"\0" in data:
                    raise UnicodeDecodeError("utf-8", data, 0, 1, "NUL")
                data.decode("utf-8")
            except UnicodeDecodeError:
                why = f"holds a file that isn't text ({rel})"; break
    if why is None:
        extra = extra_frontmatter(next((b for p, b in files if p == "SKILL.md"), b""))
        if extra:
            why = f"has frontmatter the brain can't hold yet ({', '.join(extra)})"
    return files, content_hash(files), why


def extra_frontmatter(skill_md):
    """Frontmatter keys beyond name and description (disable-model-invocation, allowed-tools...): sharing would drop them."""
    m = re.match(r"^---\r?\n(.*?)\r?\n---", skill_md.decode("utf-8", "replace"), re.S)
    keys = re.findall(r"^([A-Za-z0-9_-]+):", m.group(1), re.M) if m else []
    return sorted({k for k in keys if k not in ("name", "description")})


def describe(skill_md):
    m = re.search(r"^description:\s*(.*)$", skill_md.decode("utf-8", "replace"), re.M)
    d = (m.group(1).strip() if m else "").strip('"').strip("'")
    return d[:1024]


def skill_folders(root):
    """The personal skills: named like a skill, holding SKILL.md, not synced/ or a dot folder, not a link outside."""
    real_root = os.path.realpath(root)
    out = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if name.startswith(".") or name == "synced" or not SKILL_NAME.match(name) or not os.path.isdir(path):
            continue
        if os.path.islink(path) and not os.path.realpath(path).startswith(real_root + os.sep):
            continue
        if os.path.isfile(os.path.join(path, "SKILL.md")):
            out.append((name, path))
    return out


def post_json(url, token, path, payload):
    req = urllib.request.Request(f"{url}{path}", data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", "User-Agent": "brain-folder-report"})
    with urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=tls_context())).open(req, timeout=POST_TIMEOUT) as r:
        body = r.read()
        return json.loads(body) if body else None


def move_aside(root, name):
    """A folder the brain replaces or removes goes to .brain-removed/<name>-<time>, never deleted."""
    aside = os.path.join(root, ".brain-removed")
    os.makedirs(aside, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest, n = os.path.join(aside, f"{name}-{stamp}"), 1
    while os.path.exists(dest):
        n += 1
        dest = os.path.join(aside, f"{name}-{stamp}-{n}")
    shutil.move(os.path.join(root, name), dest)


def apply_action(root, a):
    """One write or removal, only when everything checks out here; returns what was done, or why it was skipped."""
    kind, name, expect = a.get("kind"), a.get("name"), a.get("expect")
    if kind not in ("write", "remove") or not isinstance(name, str) or not SKILL_NAME.match(name) or name == "synced":
        return f"skipped an action with a bad name ({str(name)[:40]})"
    target = os.path.join(root, name)
    if os.path.islink(target) or not os.path.realpath(target).startswith(os.path.realpath(root) + os.sep):
        return f"skipped {name}: not a plain folder in the skills folder"
    current = read_skill(target)[1] if os.path.isdir(target) else None
    if current != expect:
        return f"skipped {kind} {name}: changed on this Mac since the brain last saw it"
    if kind == "remove":
        move_aside(root, name)
        return f"moved {name} to .brain-removed"
    files = a.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_SKILL_FILES:
        return f"skipped write {name}: no files or too many"
    checked = []
    for f in files:
        path, text = (f or {}).get("path"), (f or {}).get("text")
        if not isinstance(path, str) or not isinstance(text, str) or not path or not all(SEGMENT.match(p) for p in path.split("/")):
            return f"skipped write {name}: a bad file path ({str(path)[:60]})"
        checked.append((path, text))
    folded = [p.lower() for p, _ in checked]
    if len(set(folded)) != len(folded) or any(q.startswith(p + "/") for p in folded for q in folded):
        return f"skipped write {name}: paths that collide on this Mac (case, or a file and a folder)"
    if "SKILL.md" not in [p for p, _ in checked]:
        return f"skipped write {name}: no SKILL.md"
    tmp = os.path.join(root, f".brain-tmp-{name}")
    shutil.rmtree(tmp, ignore_errors=True)
    for path, text in checked:
        full = os.path.join(tmp, *path.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as out:
            out.write(text)
    if os.path.exists(target):
        move_aside(root, name)
    os.rename(tmp, target)
    return f"wrote {name}"


def skills_step(url, token, root):
    """Report the skills, upload what the brain wants, apply its actions. Errors are logged, never raised."""
    if not os.path.isdir(root):
        return
    try:
        found = []
        for name, path in skill_folders(root):
            files, digest, why = read_skill(path)
            skill_md = next((b for p, b in files if p == "SKILL.md"), b"")
            found.append({"name": name, "description": describe(skill_md), "hash": digest, "files": len(files),
                          "bytes": sum(len(b) for _, b in files), "shareable": why, "_files": files})
        answer = post_json(url, token, "/api/skills/report", {"skills": [{k: v for k, v in s.items() if k != "_files"} for s in found]})
    except urllib.error.HTTPError as e:
        log(f"skills: the brain answered {e.code}")
        return
    except Exception as e:  # never let the skills step break the folder report
        log(f"skills: {e}")
        return
    answer = answer if isinstance(answer, dict) else {}
    wanted = {w for w in answer.get("want", []) if isinstance(w, str)} if isinstance(answer.get("want"), list) else set()
    # The upload is its own step: if it fails, the brain asks again next run, and the actions below still run.
    try:
        batch, size = [], 0
        for s in found:
            if s["name"] not in wanted or s["shareable"] is not None:
                continue
            item = {"name": s["name"], "hash": s["hash"], "files": [{"path": p, "text": b.decode("utf-8")} for p, b in s["_files"]]}
            item_size = len(json.dumps(item))
            if batch and size + item_size > MAX_UPLOAD:
                post_json(url, token, "/api/skills/upload", {"skills": batch}); batch, size = [], 0
            batch.append(item); size += item_size
        if batch:
            post_json(url, token, "/api/skills/upload", {"skills": batch})
    except Exception as e:
        log(f"skills: sending content failed: {e}")
    actions = answer.get("actions") if isinstance(answer.get("actions"), list) else []
    for a in actions:
        try:
            log(apply_action(root, a if isinstance(a, dict) else {}))
        except Exception as e:  # one bad action never stops the others
            log(f"skills: skipped an action that failed: {e}")
    log(f"skills: reported {len(found)}, asked for {len(wanted)}")

def main():
    url = os.environ.get("BRAIN_URL", "").rstrip("/")
    if not url:
        log("no BRAIN_URL: run install-folder-report.sh --url <your brain>")
        return 3
    token_file = os.path.expanduser(os.environ.get("BRAIN_TOKEN_FILE", "~/.config/brain/device-token"))
    root = os.path.expanduser(os.environ.get("BRAIN_PROJECTS", "~/Projects"))
    try:
        with open(token_file, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError as e:
        log(f"no device token at {token_file} ({e.strerror})")
        return 2
    names = sorted(n for n in os.listdir(root)
                   if not n.startswith(".") and n.strip() and os.path.isdir(os.path.join(root, n)) and "/" not in n and len(n) <= MAX_NAME)
    folders = [safe_state(os.path.join(root, n), n) for n in names[:MAX_FOLDERS]]
    body = json.dumps({"folders": folders}).encode("utf-8")
    req = urllib.request.Request(f"{url}/api/folder-report", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", "User-Agent": "brain-folder-report"})
    try:
        with urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=tls_context())).open(req, timeout=POST_TIMEOUT) as r:
            log(f"sent {len(folders)} folders ({r.status})")
    except urllib.error.HTTPError as e:
        detail = e.read()[:200].decode("utf-8", "replace") if e.fp else ""
        log(f"the brain answered {e.code} {detail}".rstrip())
        return 2 if e.code == 401 else 1
    except (urllib.error.URLError, OSError) as e:
        log(f"could not reach {url}: {e}")
        return 1
    skills_step(url, token, os.path.expanduser(os.environ.get("BRAIN_SKILLS", "~/.claude/skills")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
