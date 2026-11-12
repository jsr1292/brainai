Work memory for Codex and Claude Code
=====================================

A private memory for your AI coding assistants on this laptop. They save decisions, statuses and facts about
your work here and recall them in later sessions. The memory only listens to this computer, and it is separate
from your personal memory at home. Its daily backups go to your work OneDrive (see Backups below), without your
password or authenticator secret.

Install (or update from a newer zip; your memories are kept)
-------
1. Unzip this folder anywhere, for example in Downloads.
2. Open PowerShell in the unzipped WorkMemory folder and run:

     powershell -ExecutionPolicy Bypass -File .\setup.ps1

3. On first install it asks for a dashboard password and shows a QR code for your authenticator app.
4. Your browser opens: log in and approve Codex. Then start a new Codex session.
5. Claude Code (if installed): start it, type /mcp, choose work-memory and Authenticate. If you install Claude Code
   later, run setup again to connect it.

It installs to %LOCALAPPDATA%\WorkMemory and starts by itself whenever you log in. The unzipped folder can be
deleted afterwards.

Using it
--------
- Dashboard: Start menu > "Work memory dashboard" (http://localhost:3100). Always use localhost, not 127.0.0.1.
- Approvals: profile changes, and anything that reads like an instruction to AI assistants, wait on the
  dashboard home page for you to approve.
- Discussions: ask either assistant to "discuss X with Codex" (or "with Claude Code"). It opens a discussion,
  gives its own view, then runs the other one by itself for each round (a few minutes each) and reports where they
  agree and differ. Read it on the dashboard's Discussions tab; you decide. The first time, the assistant asks
  permission to run the other one's command: allow it. Codex may ask to run claude outside its sandbox: allow it.
- Backups: a copy every day in your work OneDrive, folder "Work memory backups" (the newest 14 are kept).
- Export everything to a readable file:  powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\WorkMemory\export.ps1"
- Stop / start, in %LOCALAPPDATA%\WorkMemory:
    powershell -ExecutionPolicy Bypass -File .\stop.ps1      (or .\start.ps1)
- Remove it all (exports to Documents first), in %LOCALAPPDATA%\WorkMemory:
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

If something goes wrong
-----------------------
- Log: %LOCALAPPDATA%\WorkMemory\logs\server.log
- Codex says the memory needs a login:  codex mcp login work-memory
- Claude Code says the memory needs a login: in Claude Code, /mcp > work-memory > Authenticate
- Codex cannot connect and the company uses a proxy: add localhost to NO_PROXY, e.g. in PowerShell
    [Environment]::SetEnvironmentVariable('NO_PROXY', 'localhost,127.0.0.1', 'User')
  then restart Codex.
- Port 3100 already in use: run setup again with another port:  .\setup.ps1 -Port 3110
  (on an existing install, also change PORT and PUBLIC_URL in %LOCALAPPDATA%\WorkMemory\work.env)
- Codex in WSL: WSL cannot reach the laptop's localhost by default. Set networkingMode=mirrored under [wsl2]
  in %USERPROFILE%\.wslconfig, then run  wsl --shutdown.

Licences and terms of use
-------------------------
Work memory's own code is free software under the MIT licence (app\LICENSE).

Its search model, EmbeddingGemma-300m (app\models\onnx-community\embeddinggemma-300m-ONNX), is Gemma. Gemma is
provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms. By installing or using
Work memory you agree to use the model only as those terms allow, and never for anything the Gemma Prohibited Use
Policy forbids (Section 3.2 of the terms; ai.google.dev/gemma/prohibited_use_policy). If you give this zip or the
model to anyone else, you must give them these terms with it. Full copies of the terms and the policy are in
app\licenses (GEMMA-TERMS.md and GEMMA-PROHIBITED-USE-POLICY.md).
