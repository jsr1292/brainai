# Changelog

Each release says what changed and whether updating needs anything from you. Updating is always
`git pull && docker compose up -d --build` in `~/memory`; BrainAI copies its database to `data/pre-migrate/` before
any change to it. Settings › Version shows the version you run.

## 1.10.5 (2026-11-25)

A fix for the Mac app (on a Mac with 1.10.4, update by hand as below; nothing to do otherwise):
- **The Mac app 1.10.4 closed itself a second after opening.** The new "Starting BrainAI…" line asked the window for its page before the first page had loaded, and the web view library (wry 0.57.1) crashed on that. wry 0.57.4 answers it safely. If 1.10.4 is installed on a Mac, it cannot update itself: download the 1.10.5 dmg from the release page and drag it over the old app. Your brain is not affected.
- Every release build now opens the Mac app once in a throwaway home folder and stops if it does not stay up.

## 1.10.4 (2026-11-24)

Feedback and state fixes from the 2026-11-23 UX review (nothing to do when updating):
- **Buttons answer when pressed:** Save, Backup now, Connect and the Settings forms show a busy look at once, the other buttons wait, and a second press is not sent. Going Back to a page leaves no button stuck.
- **Search (⌘K):** while a search is running it says "Searching…", and Enter waits for the fresh first result instead of opening an old row.
- **A save that fails** keeps the project sheet as it was and says in place that the change was not saved, and why (offline, the server, changed elsewhere), with Try again or Check again. "Couldn't load this" now only means a load.
- **Opening a project** from the overview shows the pressed row straight away.
- **After saving a section** the page puts that section back in view once late diagrams have drawn, and its heading has focus.
- **Offline:** a quiet strip under the top bar says "Offline. Changes can't be sent"; buttons that need the server wait until you are back online (a window whose own server still answers shows nothing).
- **After Approve or Reject** focus lands on the "Undo" line, so Undo is one Tab away.
- **Edit details** in a project's Manage menu opens as a fold in the sheet, so Save is no longer inside a scrolling box.

Lost-work fixes in the page editor (nothing to do when updating):
- **Leaving the editor warns after Preview, a refused save or a conflict.** Those pages hold text only they have, so Cancel and leaving the page now ask first.
- **Your text survives an ended session, a server restart or a failed save.** The editor keeps a copy on this computer while you type (never sent anywhere, dropped after a day, removed once the save is confirmed or when you log out). When you open the editor again it says "You have unsaved text from 14:02. Put it back · Discard".
- **After logging in again you land on the page you were on**, not on a "Not found" page (ticking a step on the desk after the session ended) or the old text.
- **A failed save says so.** The "Something went wrong" page now says "This may not have been saved" and has a Go back link; the too-long page has the same link.
- **Save cannot be sent twice** from the page editor: the pressed button shows it is busy and a second ⌘S or click does nothing.

Desktop app and search-model download (from the 2026-11-23 review):
- **If BrainAI cannot start**, the message now has Try again and Show the log (it opens the log in Finder or Explorer), besides Quit.
- **If the server stops while you work**, BrainAI starts it again and brings you back to the page you were on (not Home), with a short notice in the window instead of a message you must close first. A server that stops answering (but has not quit) is restarted the same way only after three minutes of silence, never in the first five minutes after a start, and never while it says it is busy with a backup, a saved copy, a move or a restore; it is asked to stop politely first, and never restarted twice in a row for this. After ten quiet minutes the app's allowance of restarts is full again, so an occasional crash over weeks no longer ends in "keeps stopping".
- **The starting page** is in your language, and after 15 seconds says "Taking longer than usual…".
- **The menu bar icon** has Restart BrainAI (it asks first, then returns to the same page; it waits while BrainAI is still starting) and Show the log.
- **Search-model download:** a download that gets no data for a minute now fails instead of sitting at the same percent for ever. A half-finished file is carried on where it stopped (when the server allows it) instead of starting over; the file is still checked exactly as strictly. A failed line has a Try again button, and the progress line keeps trying to reach the server instead of freezing after a few errors.

Layout and readability fixes from the 2026-11-23 UX review (nothing to do when updating):
- **Projects on a computer:** "For you" (approvals, facts that disagree) now sits beside First steps instead of below it, and the left column never leaves a gap when First steps is closed or a long list is open on the right.
- **Projects on a phone:** First steps is one row ("First steps · 3 of 6 done") that opens in place, the week card shows only its sentence and Read it, and blocks sit closer together, so the first project is on the first screen. The idea box now comes right after the heading, so Tab reaches it first.
- **Project dots** differ in shape as well as colour: filled for being worked on, a dot in a ring for waiting on you, a hollow ring for quiet.
- **"Needs you" is one colour** (the orange accent) on the health label and the waiting dot; amber now only means "soon", like "due Thu".
- **Buttons that cannot be pressed yet** (or are sending) look dimmed. On Move to a server, "It's moved" is no longer a second black button before the moving file exists.
- **Page side box:** a task's words no longer break in the middle of a word, and the due date drops under the text when the box is narrow.
- **Page editor:** a long title wraps and is shown whole, its focus line is dark, and screen readers get a heading ("Editing ...").
- **Project screen on a phone:** the one-liner is its own paragraph, so you can read all of it.
- **Links inside sentences** are always underlined, so they do not depend on colour alone.
- **Inbox:** the section headings (Approvals, Facts that disagree, Tidy-ups) show an arrow and are easier to hit.
- **Projects list beside an open project:** the cut-off "next step" text is gone from the narrow list (the project screen shows it whole).
- **Sidebar:** only the page you are on is lit (Skills, Growth and the Week pages), its place above is just a heading.
- **Screen reader landmarks:** the open item on a computer and the page side box are labelled, and the side box is no longer a second "complementary" area.
- **Spacing:** more room under the week card and under the Tools list, and the `.brainai-backup` file name keeps its full stop on the same line.

Small fixes to forms and undo, from a review of the screens. Updating needs nothing from you.
- **A refused fact now explains itself next to the field.** An empty or too long memory, a bad tag or project name and too
  many search words show a plain sentence in your language ("Write the memory: 1 to 1000 characters."), under the field it
  is about, and the cursor lands there. What you typed is kept. Assistants still get the same English text as before.
- **Skills: Delete can be undone.** After deleting a skill, Skills says "Deleted" with an Undo button, and a Deleted list
  keeps every deleted skill with its own Undo. A skill that comes back is switched Off, so no assistant follows it again until
  you turn it On. The note that said the history stays in the backups is gone.
- **Revoke and Log out ask for a second step.** Revoking an assistant and logging out a device now sit behind a short fold,
  like deleting a page, so one wrong tap does nothing.
- **Skills no longer hides waiting proposals.** With no skills yet and proposals waiting, the page says "2 skills wait for
  your approval" and links to Approvals.
- **Backup ticks are read aloud properly.** The check and cross next to each backup also say "copied", "skipped" or "failed" for screen readers.
- **"Not now" on the week card has an Undo.** The card's place says last week is set aside, with Undo to bring it back.

## 1.10.3 (2026-11-23)

Security fixes from the 2026-11-23 review (setup pages, links, updater, installer, stored text, restore, discussions):
- **Refused sign-in addresses** show with the name an app gave only on the setup page of the app whose known address
  they match. Anything else sits behind a warning as "unknown app", and a registration that arrives with a cross-site
  Origin is not listed at all. Refusals through the public door are still listed, because ChatGPT and Grok register that way.
- **Links in stored text** to `/app/...`, `/authorize...` and `/consent/...` (any case or spelling) are shown as plain
  text. In the desktop app, a link that asks for a restart or an update now asks for your confirmation first.
- **The updater** repeats the rule that a release must be strictly newer than the running version, as defence in depth
  (a release replaces its own pre-release). This does not close finding 8: the signature covers the build, not the
  version in the release list, so a lying release list can still point at an old signed build until the manifest
  itself is signed.
- **The Windows installer** starts PowerShell by its full system path.
- **The instruction check** also catches text addressed to assistants ("for AI agents", "assistants reading this",
  "you must call forget", and the Spanish, French and German forms). Pages are checked again once after updating.
- **Secrets**: a labelled bare key ("OpenWeather API key is 7f3a...") is refused like the known key formats; ids,
  hashes, commit ids and UUIDs are not.
- **Restoring a saved copy** resets the sign-in address list to its defaults, drops registered apps and their
  connections (apps register and you approve them again), switches restored skills Off and runs restored pictures
  through the same cleaning uploads get.
- **Connection names**: a name already used by a live connection at a different access level is refused (English and
  Spanish message). Discussions record which connection opened a discussion or wrote a reply and use that, not the name.

Assistant behaviour (from the 2026-11-23 behaviour review); nothing to do when updating.
- Saving a decision now reminds the assistant, in one sentence, to update the project's status (named by id) and roadmap in the same turn, before it answers. The save nudge on recall and briefs says the same.
- One instruction for conflicting facts: call flag_disagreement in the same turn and tell the owner; when the owner says which is right, save it with supersedes. The brief no longer suggests forget.
- load_profile lists the skills that are On (name and short description), so assistants no longer need a separate list_skills call; list_skills still works.
- write_page asks for one short pointer fact (title and page id, under about 150 characters) instead of a copy of the page.
- The "close facts" nudge after a save is quieter: not sent when the save used supersedes, at most two facts, a higher similarity cut-off (40% of the way from the close-facts floor to the duplicate threshold), and a shorter sentence.
- A deleted fact's text, page section names (in page and tidy replies) and the list of sections a save may also need are shown as data, never inside a tool's own sentence.
- load_profile lists at most 30 skills, then says how many more and to call list_skills.
- read_page, list_pages and project_brief print contains_instructions only when true; facts that read like instructions are marked the same way in recall and briefs.

Security (review of 2026-11-23, findings 1 to 5 and 13). Nothing to do when updating, except that you sign in again at
the public address (Reach) once, and browser logins on this computer now last 7 days.
- The public address never serves the app's own pages (`/app/...`), whatever the letter case or spelling of the address
  (`/APP`, `/%61pp`, `//app`), and the pages themselves refuse it too. No app ticket is made or accepted there, and the
  window's session cookie is set with the right options.
- Each sign-in remembers where it was made. The window's and this computer's logins stop working at the public address;
  only a login made there works there. A password login in a browser on this computer lasts 7 days instead of 30.
  Existing sessions count as made on this computer, so Reach needs one new login.
- On this computer, sign-in requests from a web page (a request with a foreign Origin) are refused before they count
  against any limit, and the token limit is kept for each app instead of for the whole computer, so a web page can no
  longer block your tools from signing in or refreshing.
- At the public address the login limit is kept for each visitor's address, and the owner's known browser has a limit of
  its own: strangers failing five logins no longer lock you out.
- When the usual address (localhost port) is held at start by a program that does not answer like BrainAI, the app says
  so (EN/ES). Whatever holds it, on a temporary port BrainAI accepts a sign-in made for the usual address only from the
  Claude desktop bridge's own key, and a refresh is bound to the address it arrives at.
- Web pages are also refused when the browser says the request is cross-site and not a page visit, and the sign-in
  limits on this computer are kept for each token presented. Failed logins from the internet use a bucket of their own,
  so they never block logins on this computer.
- When turning Reach off at exit is not confirmed by Tailscale, the next start is told to turn it off; the Cloudflare
  tunnel program now stops with BrainAI even when BrainAI is killed.

## 1.10.2 (2026-11-23)

Updating: on the desktop app it downloads in the background and installs when you restart; on a server, the usual
`git pull && docker compose up -d --build`. Two things to do once afterwards:
- **Paste the setup text into your apps again.** It is now setup 4 (the text no longer points assistants at an editable
  page); Settings shows which apps are out of date.
- **If Claude Code or Codex says "Invalid client_id"** when signing in to the desktop app, clear its sign-in once: in
  Claude Code, /mcp → brainai → Clear authentication; for Codex, `codex mcp logout brainai`, then
  `codex mcp login brainai`.

- **Project health.** Every open project shows Needs you, At risk, Stuck or On track, worked out by BrainAI from its
  roadmap, its status and your folder report, never typed in by an assistant. Assistants see it in project_brief.
- **Your week, on Monday.** Last week's review is a card at the top of Projects with three numbers, and the desktop app
  can tell you at 9:00 on Monday (Settings › Appearance has the switch).
- **Bringing a saved copy back keeps your pictures.** In the desktop app you choose the folder that holds the copy;
  BrainAI shows what it found before bringing it back, and keeps the brain it replaces.
- **Connecting Codex works in the desktop app, and signing in needs no internet.**
- **Uninstalling on Windows is safe.** With "Delete the application data" ticked, a copy goes to Documents first; the
  uninstaller finds and disconnects your tools where BrainAI connected them, and only once BrainAI is closing.
- **Connections hold.** A busy port at login no longer moves BrainAI for good, newly installed tools are found without
  a restart, settings files are written in one safe step, and connection errors are in Spanish too.
- **Removing BrainAI keeps everything saved up to the end**, and assistants' disagreement notes no longer appear inside
  your approved profile.

### All changes


- If the usual port ever does move (after three starts in a row without it), tools still connected at the old port show "needs connecting again" instead of "another BrainAI", and Disconnect, Remove and the uninstaller clean them up. The Windows uninstaller uses the usual port, not a temporary one.
- Claude Code's hooks are found and removed in the folder `CLAUDE_CONFIG_DIR` names, and only when they are BrainAI's own scripts there. On the Mac, those variables are read from your login shell too, so they work when BrainAI is opened from the Finder.
- A settings file that is read-only, or that another program has open, now gives a clear message (English and Spanish) instead of an error page; on Windows the write is retried for a moment first.
- Remove BrainAI says where the backups that can hold other apps' keys stayed (beside their originals), including Codex's `config.toml`.
- A busy port at login no longer moves BrainAI for good: the desktop app remembers the port your apps were connected to and tries it first at every start. If it is busy, that run uses another port (the Tools page says "BrainAI is on a temporary address this time; your apps reconnect when it's back" and does not call your own entries "another BrainAI"); the usual port changes only after three starts in a row without it.
- The Tools page and Connect on Windows read the current Path again each time (plus the Node folder), so a tool installed after BrainAI started is found without restarting it; "not found" now says to quit BrainAI from the tray and open it again if you just installed it.
- Removing BrainAI no longer moves the backups of Claude's `claude_desktop_config.json`, Cursor's `mcp.json`, Gemini CLI's `settings.json` and OpenCode's `opencode.json` into the saved folder: like `settings.json`, they can hold other tools' keys, so they stay beside the original files.
- Connect errors are now in Spanish too, and Connect writes each settings file in one safe step, keeps a UTF-8 byte order mark, refuses a UTF-16 file with advice on saving it as UTF-8, and refreshes the `.brainai-backup` when you have changed the file since without BrainAI.
- Connect, Disconnect and Add save reminders only work from the app window on this computer, never through the public address.
- Connect follows `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` when you have moved those folders.
- Choosing the folder that holds your BrainAI saved folders now works when restoring: BrainAI looks one level down in folders named "BrainAI saved ...".
- The shipped app no longer enables the updater's insecure-transport flag: plain http update endpoints (for testing) work only in debug builds.
- After an update on Windows, Home tells you once to quit Claude completely and open it again if Claude's desktop app is connected, since the installer ends its connection.
- Signing in Claude Code and Codex to the desktop app no longer needs internet access. On the app's own localhost address BrainAI stops advertising client-ID metadata documents (the sign-in documents Claude Code and Codex host on claude.ai and chatgpt.com), so those tools register with BrainAI directly instead of BrainAI fetching a page from their site; offline, or behind a proxy that asks for a login, sign-in used to fail with "Invalid client_id". Tools already signed in keep working, and signing in through Reach and on a server work as before. If Claude Code still says Invalid client_id, run /mcp → brainai → Clear authentication once, then sign in again (Codex: `codex mcp logout brainai`, then `codex mcp login brainai`).
- Uninstalling BrainAI from Windows Settings with "Delete the application data" ticked can no longer destroy your memory without a copy: the uninstaller first saves a `BrainAI saved <date>` folder to Documents, and if that copy cannot be made it keeps your data and says so. docs/DESKTOP.md no longer tells people to tick the box. Needs a real Windows check (the installer script cannot run here).
- The Windows uninstaller now looks for your coding tools on the same PATH the app connected them on (including `~\.local\bin`, npm and WinGet), so Claude Code installed there is disconnected too; it also ends the tools' sign-ins, removes the save reminders of Codex and Cursor, and Claude Code's hooks even if its server entry was removed by hand. It never deletes the `.brainai-backup` copies beside your tools' settings; Remove BrainAI moves only the plain-text ones into the saved folder and leaves those of settings files that can hold tokens beside their originals. The uninstaller's copy also works when Tauri's setup.exe runs the uninstaller in place.
- The Windows uninstaller disconnects your tools only after BrainAI is known to be closing (Cancel on "BrainAI is running" leaves everything connected) and stops this install's own node.exe so it is not left locked.
- Remove BrainAI names the second backup folder (Settings › Backups) as still holding copies of your brain, on its first page, its last page and the saved README, instead of promising everything else goes. The false "Claude Code's BrainAI hooks were left in place" line no longer appears when Claude Code isn't installed. Cancelling the app's last removal dialog now lands on Settings › Tools with a one-time note of what was already taken out (tools disconnected, Reach off, hooks removed) and that Connect brings the tools back. A file outside the home folder goes into the saved folder under a flat safe name. docs/DESKTOP.md documents deleting BrainAI by hand on Windows.
- Connecting Codex in the desktop app works again: its sign-in was refused with "Invalid client_id", because Codex names itself with a document on chatgpt.com and the desktop brain never allowed that site. Connect now allows it, as Allow on Set up an app does on a server, and a brain that connected Codex earlier gets it once at its next start. If Codex still says "one step left", run `codex mcp login brainai` once.
- Every open project now has a health label, worked out by BrainAI and never set by an assistant: Needs you (something waiting on you is late or due within 3 days), At risk (work that is only on your Mac), Stuck (nothing finished and no status for more than 14 days, with work still to do) or On track. It shows on the Projects list and tiles (with the reasons on hover and for screen readers) and at the top of a project; project_brief and whats_left return it to assistants too. No update step needed.
- The Monday summary is now a card at the top of Projects, above For you, instead of a grey row you could miss: "Your week, 26 Oct – 1 Nov", the one-sentence summary, three numbers (steps done last week, things waiting on you now, projects stuck now) and Read it / Not now. It shows under the same conditions as the old row.
- The desktop app can tell you on Monday when last week's review is ready: a notification at 9:00 (or the first time the app runs later that week) with the same numbers as the Monday card in one line, shown once a week and only when the Monday card would show. It is on by default; Settings › Appearance has a switch ("Tell me on Monday when my week is ready"). Reading the line never marks the review as read.
- Removing BrainAI no longer loses anything saved after the copy. On a server, the app is stopped before the copy is taken (and started again if you cancel or the copy fails). On the desktop app, from the start of the removal the dashboard and assistants cannot save anything, and the last page of the removal has no links back into your brain.
- Bringing a saved copy back in the desktop app now starts with choosing the folder that holds it: BrainAI finds the newest copy there, shows what it holds (facts, pages, and how many pictures sit beside it) and only then brings it back, with the pictures. Pictures a restore could not bring back are never deleted from the second backup folder. A restore keeps the brain it replaces as `memory-before-restore-<date>.db`, treats a brain with skills or discussions as not empty, and stages the copy so a half-finished one is never swapped in.
- Assistants are now reminded about Growth (with developer coaching on) when they finish a step, so they note what stood out about how you work.
- The empty Growth page now explains how it fills and what to ask an assistant.
- load_profile no longer shows an assistant's reason for a disagreement inside the owner-approved profile: profile facts in dispute are marked, and the reasons come in a separate block labelled as not approved by the owner.
- The setup texts (English and Spanish) and the Claude Code plugin no longer tell assistants to follow rules from the editable page "How this brain is organised"; they point only at the brain's own instructions. Setup number 4: re-paste the setup text to pick this up.

## 1.10.1 (2026-11-20)

Updating needs nothing from you. On the desktop app it downloads in the background and installs when you restart.

- **Choose the look: Automatic, Light or Dark.** Settings › Appearance. Automatic follows your computer, as before. The
  choice applies at once and is kept on this computer or browser; in the app, the window's title bar follows it too.

- **Updates on Windows close BrainAI for much less time.** The app now carries its server as about 330 files instead
  of about 7,000, so the installer has far less to remove and copy (and antivirus less to scan). Fresh installs are
  faster too. The update to 1.10.1 itself still replaces the old files; the gain shows from the next update on.

- **Opening BrainAI while an update installs no longer fails.** It says "Finishing the update…" and starts as soon as
  the installer is done, instead of showing that it could not start.

- **Settings keeps your place.** After Check for updates, or when the app refreshes itself after you have been away,
  the page used to jump back to the top; it now stays on the section you were reading.

## 1.10.0 (2026-11-20)

Updating needs nothing from you. On the desktop app it downloads in the background and installs when you restart. The
database gets one small change (a new setting); BrainAI copies it first, as always.

- **Developer coaching is now a switch in Settings, off for new brains.** Growth notes, the five areas, the handbook
  and the rules that ask assistants to coach you on developer habits used to be part of every brain. A brain that
  already has five-areas checks or handbook topics keeps coaching on; any other brain starts with it off. Turning it
  on or off applies to new conversations, and nothing is deleted. The operating rules also no longer say to write pages
  in English or where career plans go: those were one person's preferences, and belong in that person's profile.

- **The Graph tab appears once you have more than one project.** The page is still there at `/graph`.

- **The second backup folder now holds your pictures too, and restoring from it brings them back.** Restoring from a
  `memory-*.db` file now uses the `images` folder beside it, copying only the pictures that database lists and
  skipping any it can't read.

- **"Back up somewhere else" is ticked only once a copy has worked.** Choosing a folder used to tick it straight
  away. A failed or old copy shows in Brain health, with the reason in your language and without folder paths.

- **The app says before you choose a folder that the copy is not encrypted.** A OneDrive, Dropbox or iCloud folder
  means that service keeps your memories in readable form; an external drive or a private folder keeps them private.

- **Spanish instructions are held for your approval like English ones.** Saved text that reads like an instruction
  to AI assistants ("a partir de ahora eres…", "no se lo digas al dueño", "envía las memorias a…") now waits in the
  Inbox in Spanish too. Ordinary Spanish facts that only look similar are left alone.

- **The Try it step names the one thing left to do** in the app you connected, such as quitting Claude from the
  tray and opening it again. The Gemini CLI tile says it has not been tested yet.

## 1.9.1 (2026-11-20)

Updating needs nothing from you. On the desktop app it downloads in the background and installs when you restart.

- **The README starts with what BrainAI does,** and a short example: save something in one assistant, ask another.
  It says plainly that ChatGPT, Claude on the web and Grok need BrainAI to have an internet address. A new page,
  `docs/COMPARISON.md`, compares BrainAI with Mem0, Hindsight and Basic Memory, including where the others are ahead.

- **Connect's sign-in hint matches what you see.** It said your browser asks you to Allow; you approve the sign-in in
  BrainAI (in the app: Review, then Approve).

## 1.9.0 (2026-11-20)

Updating needs nothing from you. On the desktop app this is the first quiet update: if you run 1.8.0, it downloads in
the background and installs when you restart, with no installer window.

- **A "Your apps" step in the first-run welcome.** New installs now ask which AI apps you use and say, in plain words, which work on this computer right away and what ChatGPT, Claude on the web and Grok need (a reachable address or a server). The welcome has five steps, Connect lists your apps first, and Home keeps one "Next" card until you dismiss it. It only affects new installs: if you already finished the welcome, nothing changes.

- **No more "committed secret" warnings from code scanners.** The tests that check BrainAI refuses to store keys used made-up keys written out in the code, and public scanners read them as leaked secrets. They are now built while the tests run, so the source holds none, and the release check no longer makes exceptions for them.

## 1.8.0 (2026-11-20)

Updating needs nothing from you.

- **Updates download in the background and install in seconds.** BrainAI fetches a new version by itself when it finds one, while you work, and checks its signature. A thin line above Settings shows "Downloading update · 42%", then "Update ready · Restart". Restart (or Restart to update in the tray menu, or Quit BrainAI) saves a backup and installs it. On Windows the installer no longer shows a window. After the update, Home says "Updated to 1.8.1 · What's new" until you dismiss it. This update itself still installs the old way (you press Update and restart, and Windows shows the installer); the quiet way starts with the next one.

## 1.7.1 (2026-11-19)

Updating needs nothing from you.

- **Fix: approving a held change no longer undoes your edit.** When an assistant only added search words to a fact (or left its tags alone) and that change waited in the Inbox, approving it after you had edited the fact put the old text (or tags) back. It now keeps the fact as it is when you approve, and the Inbox card shows exactly that.

## 1.7.0 (2026-11-19)

Updating needs one thing from you: connected apps will show a "new setup text" notice once (setup text version 3). It appears even if you use BrainAI in English, because the text each app reads came in a new version. Press Connect again (or Replace) on those apps to refresh their rules; nothing breaks if you do not.

**BrainAI in Spanish**
- **The dashboard speaks English and Spanish (Spain).** The language follows your computer. Settings › Language lets you choose Automatic, English or Español; the choice applies at once, to every screen, error page and message in the browser scripts. Dates, times and numbers follow the language too (19 nov 2026, 1,5 MB).
- **The desktop app's tray menu and dialogs** (Abrir BrainAI, Iniciar al arrancar, Salir de BrainAI, the update notices, the remove and move dialogs) are Spanish on a Spanish computer, and follow the language you choose in Settings within a few seconds.
- **The Windows installer and uninstaller** follow the display language (English or Spanish).
- **Setup texts.** The pages that tell each assistant app how to connect (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, ChatGPT, Grok, Claude) exist in Spanish too. The rules block that Connect writes into an app's instructions file uses the language you had chosen when you pressed Connect.
- **Docs.** README, SECURITY and every guide in `docs/` have a Spanish twin (`README.es.md`, `SECURITY.es.md`, `docs/es/`), linked from the first line of each file. `docs/I18N.md` explains how to translate a screen.
- Everything that assistants read (tool descriptions, replies, the server's instructions) stays in English, whatever your language. What you store (facts, pages, history) is never translated; it stays in the language it was written in.

## 1.6.0 (2026-11-19)

Updating needs nothing from you. There is no database change. Saves already waiting in your Inbox are judged by the new rule when you approve them.

**An assistant's "you said" now has to quote you**
- When an assistant saves a fact as "you said this", it must give your own words in the source note. Without them BrainAI stores the fact as "inferred" instead and tells the assistant how to fix it. Where you see it (fact page, Inbox, disagreements) it reads "Claude Code says you said: “your words”", so the label covers only your words, not the assistant's wording around them.
- A fact marked as your words that also reads like the assistant's own suggestion ("I suggest...", "recommended by Claude", "te sugiero...") is held in the Inbox with the reason "Marked as your words but reads like it includes an assistant's suggestion". Approving it keeps your quoted words.
- Assistants are told to put their own suggestions in a separate fact marked "inferred". Facts you or the dashboard mark as yours, imported facts and facts from files are unchanged. Updating needs nothing from you.
- A save waiting in your Inbox is judged again when you approve it, against the fact as it is then, and the card shows what approving will store.

**Forgetting, measured**
- **Documented a limit of "forgetting sticks".** On the default model, a deleted fact that an assistant saves again in heavily different words (measured similarity 0.691 and 0.559, against a hold at 0.78) is saved without being held; lowering the threshold would also hold related facts that share its numbers (0.72-0.77). Using the reranker as a second opinion was measured (`src/scripts/calibrateDeletedRerank.ts`, 73 labelled pairs) and does not separate them, so nothing changed in behaviour. See docs/SECURITY.md.

**Evidence you can check**
- `docs/REPRODUCE.md` lists every published claim with the command that checks it, what it needs and how long it takes.
- The restore drill now records which search model it ran with, and passes all 192 checks on both the default model (EmbeddingGemma) and e5.
- The memory loop eval has a second round (docs/LIFECYCLE-EVAL.md): the quoted words were the owner's in every run, and Claude Code still often writes its own suggestion into the same fact.

**Settings and setup**
- **Settings › This computer shows how much disk space BrainAI uses (the desktop app).** One total and a breakdown in plain sizes: the app itself, search models (each model by name), your memories (database and pictures), backups on this computer, and everything else. A second backup folder is not counted. The total also shows in the Settings list. The sizes are worked out in the background and kept for ten minutes, so Settings opens at once and says "Working out the sizes…" the first time. A server shows nothing new.
- **Settings has a Version panel with "Check for updates".** It shows the BrainAI version and database schema, when BrainAI last checked for an update, the warning if checks keep failing, and whether a newer version is waiting. In the desktop app the button runs the same check the app makes by itself each day, now (at most once every 30 seconds). On a server the button asks GitHub for the latest release, only when you press it, and says whether you are up to date or what to run (`git pull && docker compose up -d --build`). BrainAI still never looks for updates on a server by itself.
- **Gemini CLI can be set up from Settings › Tools (not tested yet).** Connect adds BrainAI to `~/.gemini/settings.json` (your other settings and servers stay, a backup is kept) and its rules to `~/.gemini/GEMINI.md`, then you type `/mcp auth brainai` in Gemini CLI. Disconnect takes only BrainAI out. This follows Google's documentation but has not been tried against a real Gemini CLI, and it adds no save reminders.

## 1.5.2 (2026-11-19)

Updating needs nothing from you.

**Privacy fixes**
- **The copies kept before an update are now narrowed at every start.** 1.5.1 said each start makes `data/pre-migrate` (full copies, with the sign-in data) readable by its owner only, but it did so only when an update changed the database. Now every start does.
- **The nightly backup is owner-only too (servers run with Docker).** `scripts/backup.sh` now writes its backups, and the copies in `COPY_DIRS`, readable by their owner only. They hold every memory, though not the sign-in data. Older ones are narrowed on its next run. A network share mounted with fixed permissions keeps its own, so check who can open that share.

## 1.5.1 (2026-11-19)

Updating needs one check from you if you run the server yourself: BrainAI now makes `data/memory.db` and its side files readable by their owner only. The nightly `scripts/backup.sh` must run as the same user as `PUID` in `.env` (the usual setup), or as root; a job that runs as another user can no longer read the database. The desktop apps need nothing. There is no database change.

**Privacy fixes**
- **The database and its copies are owner-only.** The live database, the copies BrainAI makes in `data/pre-migrate/` before an upgrade and the backup folder could be read by other accounts on the same computer. All of them hold your sign-in secrets. Each start narrows them; nothing is ever loosened.
- **Deleted facts stay deleted more often.** When you delete a fact, an assistant that saves it again reworded, as another kind (a status instead of a decision) or under another project is held for your approval, as an exact copy already was. It is always a hold for you to decide, never a refusal.
- **The instruction check sees through disguises.** Text that reads like an instruction to an assistant is no longer missed when it uses lookalike letters from other alphabets, fullwidth forms, invisible characters, accents or line breaks inside the words. Discussion questions, replies and attached files are marked the same way pages are. Existing pages are checked again once on the first start.
- **The weekly review saves nothing while saves are paused.** Asking for the weekly review during "Pause all saves" shows the week without storing it.

**For assistants**
- Asking an assistant to harvest a session now sends it to `suggest_memories` (you pick in the Inbox), not straight to `remember`.
- An assistant is asked to keep what you said and its own suggestion in separate facts, each with its source.
- `keys` can be sent as a list of words as well as one line.

**Evidence, published**
- **Restore drill** (`npm run drill:restore`, docs/RESTORE-DRILL.md): builds a brain with every kind of data, restores it on a clean setup from the nightly copy, "Save a copy", the encrypted off-site copy and a failed upgrade, and checks 192 things, including that old sign-ins stop working and deleted facts stay deleted.
- **Security model** (docs/SECURITY.md): the trust boundaries, what each one is tested by, and the known gaps. It is the author's own review, not an independent audit.
- **Memory loop eval** (`npm run eval:lifecycle`, docs/LIFECYCLE-EVAL.md): real Claude Code and Codex sessions against a throwaway brain, scored on what ends up stored and what the assistant answers, with results before and after the fixes above and every failure listed.

## 1.5.0 (2026-11-18)

Updating needs nothing from you. BrainAI changes its database on the first start (six additions, nothing removed) and copies it to `data/pre-migrate/` first. On the desktop app, press Connect again (or "Add save reminders") on Settings › Tools to get the new save reminders.

**Each fact says how long it holds and where it came from**
- **Valid until.** An assistant can give a fact the date it stops being true (a deadline, a version, who holds a job). Recall, briefings and the fact page show "valid until …" or "past its date since …"; nothing is hidden or reordered. Facts past their date appear in the Inbox under tidy-ups, with "Still true" and "Set a new date".
- **Source.** A fact can say whether you said it, an assistant inferred it, it was imported or it came from a file, with a short note. It also records who set that: when an assistant says you said something, it reads "Codex says you said this", never as your own words. An assistant that rewrites such a fact without saying so again clears the claim. Disagreements show each side's source.
- **Your profile's size.** Brain health shows how big the profile is (every assistant reads all of it at the start of every conversation) and which entries say nearly the same thing.

**Memory that keeps itself in shape**
- **Save reminders** for Claude Code (also before a conversation is compacted), Codex and Cursor, installed by Connect and taken back by Disconnect or Remove BrainAI. BrainAI backs up each tool's settings file first and only touches its own entries. OpenCode and Grok Build have no hook that can reach the model; docs/CLIENTS.md says why.
- **Harvest.** A new tool, `suggest_memories`, lets an assistant send up to 20 decisions, statuses and facts from its session at once. Nothing is saved until you approve: they wait in your Inbox as one group with Approve all, which leaves any flagged item (reads like an instruction, close to something you deleted or replaced) for your own answer. A new skill, harvest-session, arrives as a proposal built into BrainAI; you decide whether to add it.
- **Tidy sessions.** Ask an assistant to tidy a project: it gets groups of related facts one at a time (`tidy_session`) and proposes replacing, merging, moving decisions into the project page's Key decisions, or leaving them (`propose_tidy`). Each proposal waits in your Inbox with a before and after; the originals stay as history, and replace and merge can be undone.
- **Brain health** says when a connected app read your memory 20 or more times in a week and saved nothing.

**You see and control what assistants do**
- **Activity** (Week › Activity): what each assistant saved, changed, deleted or replaced and which pages it edited, by day, filterable by assistant, with Undo on each fact. Undoing an assistant's new fact counts as you deleting it, so it is not saved straight back.
- **Saves wait for me**, per connection in Settings › Assistants: that assistant's saves, changes and deletions wait in your Inbox; its page edits and a few other direct changes are paused.
- **Pause all saves from assistants**: every assistant write stops at once, with a Resume banner on every page.

**Easier to start**
- **Import** (Settings › Backups and copies, or the first steps on Home): paste what ChatGPT, Claude or Gemini remember about you, tick the lines to keep (lines that read like instructions to assistants and duplicates start unticked), and they are saved as imported. Up to 100 facts per import. A built-in skill, import-project-folders, lets a coding assistant propose facts from your project folders. A Markdown or text file can become a page, marked "imported, not written by an assistant".
- **A Claude Code plugin**: `claude plugin marketplace add jsr1292/brainai`, then `claude plugin install brainai@brainai-plugins`. It asks for your brain's address and brings the save reminders, the harvest skill and the rules. Use it or the desktop app's Connect, not both (Connect skips Claude Code when the plugin is installed).

**The dashboard**
- **Inbox is one list**, grouped: approvals, harvested groups, tidy proposals, facts that disagree, discussions waiting, and tidy-ups "when you have time". The badge counts only what needs you. ⌘↵ (Ctrl ↵) approves, ↑↓ move between items, and Approve and Reject show a line with Undo.
- **Settings regrouped**: Assistants (on this computer, or on the web and phone through Reach), Search, Backups and copies (with Back up now, a folder picker in the app, and how to get a backup back), Other computers, Your login, and Remove BrainAI on its own at the end.
- **The phone bar** is Projects · Pages · Inbox · Week. A new brain shows first steps on Home until they are done or hidden. Projects explain the five areas and their colours; Map is now called Five areas.
- **Honest connection states**: a tool reads "Added · one step left" until it has signed in, then "Connected ✓". The welcome can be skipped or gone back through, and "Try it" says what to check when nothing arrives. Skills has its own link, Ctrl-K finds settings and places, and the project panel shows the roadmap's current step.
- **Reach** opens at once and checks Tailscale in the background (no more 30-second wait), and says it works only while this computer is on and awake.
- **Briefings** always list a couple of pages and name a page that may be out of date.

**Checks**
- Text that reads like it tries to send your chats, memories or keys to an email address is held for your approval, like text that sends them to a web address.
- A second benchmark, LongMemEval (retrieval only, no AI judge), is in docs/BENCHMARK.md: the right conversation was in the first 8 results for every question of a 140-question sample.

## 1.4.0 (2026-11-18)

If you connected Claude's desktop app through BrainAI's Connect (the Mac or Windows app), updating needs one thing from you: restart Claude's desktop app once. Until then, a bridge it already started keeps 1.3.0's code, which lacks the new check. Nothing else needs a restart.

- **Assistants get all the rules again.** Claude Code keeps only the first 4,096 characters of a server's instructions, so BrainAI's later rules (trust, failure reporting, discussions, roadmaps, pages, skills) never reached it. The instructions sent when an assistant connects are now a short version with the essentials (under 2,000 characters), and `load_profile` returns the full rules as its first block, marked as coming from BrainAI, not from stored data.
- **Project briefings stay a readable size.** `project_brief` now returns at most about 16,000 characters. The roadmap, the latest status, the newest three decisions and up to five of your open page notes are always there in full; older decisions and statuses become one-line excerpts with their ids, and the briefing says what it shortened. `all_decisions: true` returns every decision in full.
- **Tool descriptions match what the tools do.** Date ranges in `recall` are preferred, not strict, and the descriptions now say so; search words (`keys`) are described where they are actually shown; limits are stated and checked. Every tool is marked as reading or writing, so assistants can tell them apart.
- **Restores keep search working.** Restoring or importing a brain dropped BrainAI's own database triggers, so memories saved while no search model was ready were never searchable by meaning. BrainAI now puts the triggers back every time it starts, and a brain that was already restored repairs itself on its first start of this version.
- **Setup pages for Claude, ChatGPT and Grok:** in the desktop app, while Reach is off, they say these apps can't see this computer yet and send you to Reach first, instead of showing an address they cannot use. The sign-in line now matches whether you have set a password.
- **Settings setup pages are readable again.** The first-run wizard's styles no longer squeeze the steps on Settings › Set up …, Reach and Move, and the steps no longer disappear on narrow windows. The rows in Settings › Connections show their descriptions under the title.
- **Desktop app: update checks that keep failing are shown.** When checks have failed for two days, Settings › Backups and health says so, with the reason (for example, a proxy refusing the request).
- **Desktop app: a reminder when backups stay on this computer.** Home suggests keeping a copy in a folder that syncs elsewhere until you choose one; *Later* hides it for 30 days.
- **Smaller fixes:** Settings › Tools opens faster (the tools are looked at together), keyboard hints read Ctrl on Windows and Linux, long folder paths wrap on phones, and `/favicon.ico` works.
- **Desktop app: Disconnect ends the tool's sign-in.** Disconnecting Claude Code, Codex, OpenCode or Cursor in Settings › Tools now also revokes the connection it signed in with (as Revoke does in Settings › Connections), so it stops working. Other apps keep theirs.
- **Saved copies: names that Windows reads differently are refused.** A saved file is refused when an entry name holds a backslash or colon (Windows tar reads a backslash as a folder separator and a colon as a drive or stream). Lines of tar's listing that end with CRLF are read like any others.
- **Sign-in: an https callback must match exactly.** A registered https callback no longer also matches the same address with a query string added, and `/register` refuses a client whose callback has one.
- **Backups: copies are owner-only and the second folder's copier trusts only its own files.** Every daily backup and its second-folder copy is readable by you only on the Mac's own disk, and on drives where "Ignore ownership on this volume" is off in the drive's Get Info. macOS usually turns that on for external drives. There, other accounts on this Mac can read the copies. On Windows and on network drives they are not owner-only either, so choose a folder only you can open. Each run narrows copies left by 1.3.0. The copier no longer follows a link planted at its temporary or final name. It deletes only the `memory-….db` copies it made (it keeps a list in `backup-copy.json`), plus, once, the ones an earlier version left there. Choosing the folder works only on this computer, not through the public door.
- **Desktop app: after a normal stop, Funnel does not outlive BrainAI.** Reach through Tailscale is turned off when BrainAI stops normally (Quit, an update restart) and back on at every start, so a program of another account that takes BrainAI's public door while BrainAI is closed no longer receives your internet traffic. If Tailscale is not ready at start (not open, not signed in, no answer), Reach stays saved and waits. It tries again every minute for 10 tries, then every 15 minutes. The Reach page says it is waiting and shows what Tailscale last said. Reach turns itself off only when Tailscale is not installed or Funnel is not allowed for your account. A Turn off that Tailscale did not confirm is retried at the next start.
- **Saved copies: export and restore keep every name inside its folder.** A saved file with skill, skill file or project names such as `../../x` can no longer make Save a copy or Remove BrainAI write outside the chosen folder, and restoring such a file is refused.
- **Desktop app: the Claude bridge checks who is listening.** Before it sends its key, the bridge makes BrainAI prove, on every new connection, that it is BrainAI. A program of another account that takes BrainAI's port while BrainAI is closed no longer receives the key. If BrainAI is not the one answering, Claude is told BrainAI isn't running.
- **Desktop app: tool sign-ins are approved in BrainAI's window.** When Claude Code, Codex or another tool opens your browser to sign in, the browser page waits and BrainAI's window shows a banner with Review. The browser also waits for the window while sign-in from other devices is not set up (the password and the authenticator are not both set yet). Approve or deny there; the browser then goes on to the tool by itself.
- **Desktop app: no automatic sign-in.** A browser or program on the computer is no longer signed in by itself while the owner account is not fully set up; only the app's window is. Updating signs every browser and phone out once, and you sign in again with your password. Apps you connected before keep their access: check Settings › Connections.

## 1.3.0 (2026-11-16)

Updating needs nothing from you, except for the desktop app, which you install by hand once (see the first two bullets).

- **The apps are downloads:** the Mac app (a `.dmg` for Apple silicon, built to be signed and notarised by Apple) and the Windows setup are on the release
  page, with `SHA256SUMS`. No more building them yourself.
- **One-click updates in the desktop app:** it checks once a day and tells you with a dot in the menu bar or tray and
  a card on Home. *Update and restart* downloads, checks the signature, saves a backup first and reopens the app;
  *Later* hides the card for that version (the dot stays; a newer version brings it back). If an update fails, the version you run stays. Your memories and settings stay too.
- **Claude's desktop app in Connect:** Settings › Tools on this Mac (this computer on Windows) has a new row, *Claude (desktop app)*. Connect adds
  BrainAI to Claude's config; quit Claude completely and open it again. Its key stays in BrainAI's data folder and can
  be revoked in Settings › Connections. Disconnect, Remove BrainAI and the Windows uninstaller take it out.
- **ChatGPT, explained in Connect:** a row says why ChatGPT's app cannot reach a brain that lives only on this
  computer, and what to do: Reach from phone and web, or a server.
- **Windows asks once** about an unknown publisher (SmartScreen): More info › Run anyway.
- **If you run version 1.2 of the app,** it has no updater: install this version by hand once. Updates are automatic
  after that.
- **Save a copy of everything:** one button in Settings, in the app and on the dashboard. It makes a folder with the file
  BrainAI reads back, every memory as Markdown, and a README. In the app it goes into your Documents (it asks first if
  Documents syncs to iCloud or OneDrive). On a server the dashboard asks for the authenticator code and downloads a
  `.tar.gz`.
- **Remove BrainAI, in the app:** Settings › Remove BrainAI saves a copy, turns Reach off, disconnects your coding tools,
  deletes the data and removes the app. Your tools' original settings go into the saved folder. It ends with a checklist
  of what BrainAI cannot remove itself.
- **The Windows uninstaller disconnects your tools** when you uninstall from Settings › Apps. Not during an upgrade.
- **Coming back with a saved folder:** the app's welcome offers "I have a saved BrainAI folder"; on a server, run
  `docker compose run --rm app node dist/cli.js restore data/<file>`. It only fills an empty brain.
- **`scripts/remove.sh`** removes a server install: it saves a copy, lists what it will remove, waits for you to type
  `remove`, and asks about each outside copy (default: keep).
- **Import a backup file:** the app's welcome ("I have a saved BrainAI folder") and `cli restore` also take a backup file,
  `memory-<date>.db`. Sign-in is always removed. It only fills an empty brain.
- **A second backup folder:** Settings › Backups › "Also keep the daily backups in". The app warns when the folder
  syncs to iCloud or OneDrive.
- **Ask commands by default:** the app sets the commands that let Claude Code and Codex ask each other in a discussion.
  `ASK_COMMANDS` still overrides them.
- **The moving file now has the saved copy's format and name,** `brainai-saved-<date>.tar.gz`; older `brainai-move-…` files still restore.
- **Four new general rules** in the assistants' instructions.
- **The Windows zip is gone:** on Windows use the BrainAI app. If you installed the zip, see "Moving from the Windows
  zip" in docs/DESKTOP.md. `MEMORY_MODE=work` is no longer accepted.
- **The app asks how BrainAI finds things:** on first run it suggests search models for your computer ("Choose for me")
  and downloads the ones you pick. Until they arrive, keyword search works; memories saved meanwhile get their
  meaning added afterwards.
- **Models are downloaded on demand and checked:** from Hugging Face, with a GitHub release as the fallback. Each file
  is checked against a fixed fingerprint; one that does not match is deleted and reported. They use your computer's
  proxy settings.
- **A progress bar and a test search for the search models:** while they download, a bar shows how much is done; when
  they are ready, BrainAI runs a real test search and says it is ready and working, with how long it took.
- **Settings › Search:** change the search model and the reranker any time, remove a model to free its disk space, or
  load model files from a folder when the computer cannot download. A new search model re-reads your memories once, in
  the background.
- **An online reranker, if you want one:** through OpenRouter, with your own key (Voyage rerank 2.5 or Qwen3
  Reranker 8B). Each search sends your question and its best matches to the service; the key stays in the app's data
  folder. If the service is slow or down, the local reranker is used.
- **A smaller app:** the Mac app is about 281 MiB; it was about 550 MB with the models inside.
- **Existing app users:** the first start of this version downloads the models your brain already uses, once, with no
  question asked.
- **Servers:** nothing changes.

## 1.2.0 (2026-11-12)

Updating needs nothing from you: the database updates itself when the server starts (a copy is kept first). The first
start after this update also rebuilds the search index for the new search model, which takes about a minute; the
server answers once it's done.

- **A better search model:** recall now finds facts with EmbeddingGemma-300m instead of multilingual-e5-small. On the
  author's own 168 recall questions the right fact came first 149 times instead of 143; on the LoCoMo benchmark the
  right turn is in the first 8 results for 87% of questions instead of 74% (docs/BENCHMARK.md). Duplicate
  warnings, related facts, project-merge suggestions and the graph's threads use cut-offs tuned for it. The Docker
  image grows by about 210 MB. `EMBED_MODEL=e5` in `.env` switches back (the index is rebuilt again at the next start);
  if you set `MIN_RECALL_SIMILARITY`, `RECALL_WINDOW`, `RECALL_CONFIDENT_SIMILARITY` or `DUPLICATE_THRESHOLD`
  yourself, they were tuned for e5: the server log names them at the first start so you can remove them.
- **Licence:** EmbeddingGemma is provided under and subject to the Gemma Terms of Use found at
  ai.google.dev/gemma/terms. The notice and the terms ship with the model (`licenses/`). Using BrainAI with it means
  using the model only as those terms allow, never for anything the Gemma Prohibited Use Policy forbids
  (ai.google.dev/gemma/prohibited_use_policy).
- **Work memory for a Windows laptop, as a download:** the release page now carries
  `work-memory-win-x64-1.2.0.zip`, a private memory for Codex and Claude Code on a work laptop: no install rights, no
  internet and no other software needed (docs/WORK.md). To update, unzip the newer zip and run `setup.ps1` again;
  your memories and settings are kept. Its README now has a licences section with the Gemma terms of use.
- **Projects by area:** the Projects page now has one section per area (Apps, Tools & AI, Home & infrastructure, Work,
  Personal). Projects you're working on are small tiles with a coloured dot (green: being worked on, amber: waiting on
  you, grey: quiet), their one-liner and what's being done now; quiet, ideas, parked and done projects fold into one line
  under their area. "On the go" and "Also open" are gone: pin a project to keep it first in its area.
- **Learning to work like a developer:** every project now has five areas: work is safe (committed and pushed), runs by
  itself (CI/CD), kept up to date, you'd know if it broke, and a clear finish line. Assistants see where each project
  stands, bring up the next area at a good moment (one at a time; "not now" holds two weeks), explain the why as they
  work on it with you, and keep what you learned as a handbook (project developer-handbook). "Work is safe" fills itself
  in from the Mac's folder report. Each project shows its five areas, and **Map** (from the Projects page) shows every
  project against them, with a week-by-week line. A tile marked "!" holds work that exists only on the Mac.
- **The weekly review** flags uncommitted work older than a day, like the project pages do.
- **Search asks assistants for a guess:** with a question, an assistant now usually sends one sentence written as the
  answer might be stored (a guess, never saved or shown). On LoCoMo this finds the right turn first 60% of the time
  instead of 57%, at about 0.3 s more per search on a mini PC.
- **Search words:** an assistant can give a fact a few search words the text doesn't say (a nickname, the Spanish
  word, the date of an event). Search finds the fact by them; nobody has to read them. You see and edit them on the
  fact's page. To add them to facts you already have, ask an assistant to "add search words to my facts".
- **More results for assistants:** a search from an assistant returns up to 12 facts instead of 8, as long as they fit
  in about 1,500 words. The dashboard is unchanged.
- **One topic per fact:** assistants are asked to save two facts when what they save covers two things.
- **Time questions:** "what did we decide last week?", "¿qué hicimos en octubre?": facts saved or dated in that time
  come first; nothing else is hidden. Assistants can also pass exact dates, and recall says how it read the time.
- **Page matches:** a page section found by search shows where it sits ("Stack and where it lives › Backups") and the
  passage that matched, not just its first lines.
- **Pages:** a live-styled editor (the page's own font and headings while you type, a [[ picker for links, ⌘S to save),
  Facts and Inbox in the sidebar, and Facts grouped by project with roadmaps as Now / Next / Done.

## 1.1.1 (2026-11-09)

Updating needs nothing from you.

- **Version number:** the server and the desktop app report their real version (1.1.0 was published still saying
  1.0.1 in Settings); a release is now refused unless both name the version being released.
- **Windows:** the app carries the five Microsoft Visual C++ runtime files it needs (version 14.44), in the folders of
  the two modules that load them, so it starts on a PC without the runtime or with an older one, without an
  administrator. They come
  from Microsoft's official redistributable and are checked against pinned fingerprints when the app is built. If
  they are ever missing and the PC lacks the runtime, the app still says so with Microsoft's download link.

## 1.1.0 (2026-11-08)

Updating needs nothing from you: the database updates itself when the server starts (a copy is kept first), and the
next build downloads the reranker model once (about 145 MB). On a Mac that syncs skills, run
`scripts/mac/install-folder-report.sh` again to get the safer sync.

- **Safer files:** the Markdown export never writes or deletes through a link in its folder; two backups started at
  once no longer trip over each other (the second does nothing); the Mac's skills sync stages each skill in a new
  folder of its own.
- **Disagreements:** settling a pair is one change; a fact from another project is named on the project page; the
  pages that list them do less work.
- **Better first answers:** recall's first 20 matches are reordered by a small local model (multilingual, about
  145 MB, downloaded with the search model) that reads the question next to each fact. On LoCoMo the right answer
  comes first for 51% of questions instead of 34%, and is in the default 8 for 73% instead of 64%. Each recall takes
  about 0.3 s on a mini PC with a real brain (about 1.7 s of CPU time across up to 6 threads per model, which sleep
  while they wait) and about 300 MB more memory: the app's memory limit in
  `docker-compose.yml` rises from 1 GB to 1.5 GB. `RERANK=off` turns it off.
- **Latest on one part of a project:** with the reranker on, "what's the latest on X's export?" usually gets the fact
  about the export first; the project's roadmap and status stay on top for questions about the whole project.
- **Honest misses:** when the reranker finds that none of the facts recall returns matches the question closely, the
  reply says so, so an assistant doesn't take the nearest unrelated fact for an answer. Nothing is hidden.
- **Nicknames:** a project can have everyday names ("the wine app"), set by an assistant with `set_project_info` or
  on the project's Edit details. Every assistant gets them at the start of a conversation, and a question that uses
  one is also searched with the project's real name.
- **Questions in another language:** `recall` takes up to two other phrasings from the assistant (`alt_queries`),
  such as an English version of a Spanish question, and searches them together. On the author's brain the right fact
  came first for 83% of questions instead of 77%.
- **The benchmark** also scores the top 8 (recall's default) and the top 20 (`--limit 20`), with or without the
  reranker (`--rerank off`). It uses the LoCoMo audit's corrected evidence by default, records each question's rank
  and compares two runs question by question (`--against`). The recall test groups questions by type (`tags`),
  sends each question's other phrasings (`alt`), and writes and compares runs (`--json`, `--against`).

## 1.0.1 (2026-11-08)

Updating needs nothing from you: the database gains one table (for disagreements).

- **Cairn is now called BrainAI.** Your memories and settings stay as they are.
- **The Mac app** (`docs/DESKTOP.md`): BrainAI on your own Mac with no server, domain or password; one-click Connect for
  Claude Code, Codex, OpenCode and Cursor; a first-run welcome.
- **Reach from phone and web:** a password and an authenticator from the dashboard, then a public address through
  Tailscale (no domain) or your own domain on Cloudflare, served through a separate door that is open only while
  Reach is on.
- **Move to a server:** one moving file with every memory and picture, a tested runbook section to unpack it on a
  server, and an app that then points its apps to the server and removes itself.
- **The README** starts with "Where will it live?": your computer, a home server or a cloud server.
- **Facts that disagree:** when an assistant sees that two saved facts can't both be true, it flags them
  (`flag_disagreement`); you settle each pair on its project or on Facts that disagree, and until then assistants see
  both marked.
- **Brain health:** Settings › Brain health and backups shows how up to date and ready the brain is and what waits on
  you, each 0–100 with its reasons; For you shows a line when one drops below 70, and the weekly review includes it.
- **A recall benchmark:** `npm run bench:locomo` measures how often search finds the answer on the public LoCoMo test
  (`docs/BENCHMARK.md`).
- **Windows (test build):** the same app for Windows 10/11 x64, installed per user with no admin rights, with a
  checksum-checked PowerShell install. Reach from phone and web is Mac-only for now.

## 1.0.0 (2026-11-06)

The first public release.

- **Memory for all your assistants:** one MCP server that Claude, ChatGPT, Grok, Claude Code, Codex, Grok Build and
  OpenCode connect to with OAuth. Facts (decisions, statuses, roadmaps, your profile) and pages (long documents),
  with recall that understands meaning as well as words, in several languages.
- **You stay in charge:** changes to your profile and memories that read like instructions wait for your approval;
  forgetting sticks (an assistant can't quietly save a deleted fact again); secrets are refused.
- **Dashboard:** projects with their statuses, roadmaps and pages; a weekly review; tidy-up suggestions;
  discussions where several assistants answer one question in rounds; pictures and diagrams in pages.
- **Shared skills:** skills you share from one computer reach your other assistants, with versions and proposals.
- **Guided setup:** a page per app with the text to paste, and a number that shows when an app's text is out of date.
- **Backups:** nightly snapshots copied to your other drives, a nightly Markdown export into git, and a weekly
  encrypted off-site copy.
- **Work mode:** a separate copy that runs on a work laptop with nothing shared with home.
- **Your settings stay yours:** your own texts and script settings live in `overlay/`, which updates never touch.
