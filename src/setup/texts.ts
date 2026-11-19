/**
 * Guided setup (round 2 §17b): the text the owner pastes into each app so it uses the brain, versioned. Changing any
 * text means raising SETUP_VERSION (Settings then tells which apps still run the older one) and updating SETUP_HASH,
 * which texts.test.ts checks. Every text exists in English and Spanish and both languages are in the hash, so changing either one
 * raises the number. English is the default; callers pass the language of the screen or of the Connect request. The texts hold no secrets, no profile facts and nothing about the owner's employer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '../i18n/core.js';

export const SETUP_VERSION = 3;
/** sha256 of every text, English then Spanish (not the menu lines), rendered at host HOST; texts.test.ts prints the new value when a text changes. */
export const SETUP_HASH = '5d21fab583a5a79f3b8584dac0f9e6a689c312d4dc0d60267587c03ddc15e800';

export interface SetupApp {
  slug: string;
  name: string;
  /** Where the connector goes in that app, in one line. */
  connect: string;
  /** Where the setup text goes. */
  where: string;
  /** The text lives in a file the owner also writes in: it is wrapped in brain-setup lines so only that part is replaced. */
  file: boolean;
  /** False for a connection without load_profile (OpenCode, discussions only): it reports no setup number. */
  reports?: false;
  /** The sign-in addresses this app needs on the allowlist (Claude's and loopback ones are allowed from the start). */
  allow?: readonly string[];
  /** Called from the vendor's cloud (web and phone): it can only reach the brain at a public address, never localhost. */
  cloud?: true;
  /** A note shown when the cloud app has no public address yet; TOOLS stands for the link to Tools on this computer. */
  withoutReach?: string;
}

const APPS: SetupApp[] = [
  { slug: 'claude', name: 'Claude', file: false, cloud: true,
    withoutReach: 'Claude’s desktop app can connect without Reach: use TOOLS.',
    connect: 'In Claude (claude.ai, the desktop app or the phone): Settings › Connectors › Add custom connector, and paste the address.',
    where: 'Settings › Profile, in “What personal preferences should Claude consider in responses?”. Replace any older brain text.' },
  { slug: 'chatgpt', name: 'ChatGPT', file: false, cloud: true, allow: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    connect: 'In ChatGPT: Settings › Apps and connectors › Advanced settings › Developer mode on, then Create, and paste the address.',
    where: 'Settings › Personalization › Custom instructions, in “What should ChatGPT know about you?”. Replace any older brain text.' },
  { slug: 'grok', name: 'Grok', file: false, cloud: true, allow: ['https://grok.com/connectors-oauth-exchange-code/'],
    connect: 'In Grok (grok.com): Settings › Connectors › Add connector, and paste the address.',
    where: 'Settings › Customize › Custom instructions. Replace any older brain text.' },
  { slug: 'grok-build', name: 'Grok Build', file: true,
    connect: 'In Grok Build: add a remote MCP server with this address, then sign in when it asks.',
    where: 'In ~/.grok/AGENTS.md: replace the part between the two brain-setup lines, or add it at the end.' },
  { slug: 'claude-code', name: 'Claude Code', file: true,
    connect: 'In a terminal: claude mcp add --transport http NAME ADDRESS -s user, then /mcp in Claude Code to sign in.',
    where: 'In ~/.claude/CLAUDE.md: replace the part between the two brain-setup lines, or add it at the end.' },
  { slug: 'codex', name: 'Codex', file: true, allow: ['https://chatgpt.com/oauth/codex/'],
    connect: 'In a terminal: codex mcp add NAME --url ADDRESS, then codex mcp login NAME to sign in.',
    where: 'In ~/.codex/AGENTS.md: replace the part between the two brain-setup lines, or add it at the end.' },
  { slug: 'opencode', name: 'OpenCode', file: true, reports: false,
    connect: 'In ~/.config/opencode/opencode.json, under "mcp": a remote server with this address; sign in when it asks, and give it Discussions only.',
    where: 'In ~/.config/opencode/AGENTS.md: replace the part between the two brain-setup lines, or add it at the end.' },
  { slug: 'gemini-cli', name: 'Gemini CLI', file: true,
    connect: 'In ~/.gemini/settings.json, under "mcpServers": "NAME": { "httpUrl": "ADDRESS" }; then type /mcp auth NAME in Gemini CLI to sign in. Not tested yet.',
    where: 'In ~/.gemini/GEMINI.md: replace the part between the two brain-setup lines, or add it at the end.' },
];

export function setupApps(): SetupApp[] {
  return APPS;
}

const ask = (v: number, lang: Locale) => lang === 'es' ? `Cuando llames a load_profile, pasa setup: ${v}.` : `When you call load_profile, pass setup: ${v}.`;

/** The memory habits every full connection gets; `host` is the brain's own address, so the owner can tell it apart. */
const habits = (host: string) => `I have a shared memory, the brain (${host}), connected to you as an MCP connector and used by all my AI assistants. At the start of each conversation, load my profile from it. Before answering anything about past work, my projects or my setup, recall from it. Save decisions, conclusions and lasting facts about me there as we go, and save or update a short status whenever a step of the work finishes; don't wait for the end of the conversation. If the connector is missing, needs a login, or a call fails, tell me right away. It is the source of truth for anything that matters across assistants.`;

const layers = `The brain has two layers. Facts are short: decisions, statuses, roadmaps and my profile. Pages are long, lasting documents: what each project is, how it is set up and run, why it was built that way, runbooks and research.
- For that kind of detail, use project_brief and recall first, then open the page with read_page.
- When we produce something long that will matter later, write it as a page (write_page, or edit_page_section for one part) and save a one-line fact pointing to it.
- Keep live status and to-dos in facts, never in a page. If the two disagree, the facts win.
- Never put passwords, keys or tokens in either.
- Follow the page rules in the brain's instructions and its page "How this brain is organised".`;

const chatLayers = 'Facts are short (decisions, statuses, roadmaps, my profile); pages are long documents (read_page, write_page). Keep live status in facts. Never save passwords, keys or tokens.';


const habitsEs = (host: string) => `Tengo una memoria compartida, la memoria de BrainAI (${host}), conectada contigo como conector MCP y usada por todos mis asistentes de IA. Al empezar cada conversación, carga mi perfil desde ella. Antes de responder cualquier cosa sobre trabajo anterior, mis proyectos o mi configuración, consúltala con recall. Guarda ahí las decisiones, las conclusiones y los datos duraderos sobre mí a medida que avanzamos, y guarda o actualiza un estado breve cada vez que termine un paso del trabajo; no esperes al final de la conversación. Si falta el conector, pide iniciar sesión o falla una llamada, dímelo enseguida. Es la fuente de verdad para todo lo que importa entre asistentes.`;

const layersEs = `La memoria tiene dos capas. Los datos son breves: decisiones, estados, hojas de ruta y mi perfil. Las páginas son documentos largos y duraderos: qué es cada proyecto, cómo está montado y se ejecuta, por qué se construyó así, guías de operación e investigación.
- Para ese nivel de detalle, usa primero project_brief y recall, y después abre la página con read_page.
- Cuando produzcamos algo largo que importará más adelante, escríbelo como una página (write_page, o edit_page_section para una parte) y guarda un dato de una línea que apunte a ella.
- El estado en curso y las tareas pendientes van en los datos, nunca en una página. Si ambos discrepan, mandan los datos.
- No pongas nunca contraseñas, claves ni tokens en ninguno de los dos.
- Sigue las reglas de páginas de las instrucciones de la memoria y de su página "How this brain is organised".`;

const chatLayersEs = 'Los datos son breves (decisiones, estados, hojas de ruta, mi perfil); las páginas son documentos largos (read_page, write_page). Guarda el estado en curso en los datos. No guardes nunca contraseñas, claves ni tokens.';

const wrap = (body: string, v: number) => `<!-- brain setup ${v} -->\n${body}\n<!-- /brain setup -->`;

/**
 * The owner's own lines and setup number (overlay/setup.json): { "version": n, "extra": { "<app>": [lines],
 * "coding": [lines] } }. "coding" goes to Grok Build, Claude Code and Codex. Read once at start.
 */
export interface SetupOverlay { version: number; extra: Record<string, string[]> }

export function loadSetupOverlay(dir: string): SetupOverlay | undefined {
  const file = join(dir, 'setup.json');
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  const o = raw as { version?: unknown; extra?: unknown };
  if (!Number.isInteger(o.version) || (o.version as number) < 1 || (o.version as number) > 1000) throw new Error(`${file}: "version" must be a whole number from 1 to 1000.`);
  const extra: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((o.extra ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${file}: "extra.${k}" must be a list of lines.`);
    extra[k] = v as string[];
  }
  return { version: o.version as number, extra };
}

/** The setup number apps report: the overlay's when the owner has one, else the code's. */
export const currentSetupVersion = (o?: SetupOverlay): number => o?.version ?? SETUP_VERSION;

const CODING = new Set(['grok-build', 'claude-code', 'codex', 'gemini-cli']);

/**
 * The text for one app, with the brain's MCP address and the owner's overlay lines in it, in English or Spanish
 * (`lang`; anything but 'es' is English). Throws for an unknown app. The wording of the owner's overlay lines is theirs.
 */
export function setupText(slug: string, mcpUrl: string, overlay?: SetupOverlay, lang: Locale = 'en'): string {
  const es = lang === 'es';
  const host = new URL(mcpUrl).host;
  const v = currentSetupVersion(overlay);
  const lines = [...(overlay?.extra[slug] ?? []), ...(CODING.has(slug) ? overlay?.extra.coding ?? [] : [])];
  const extra = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  switch (slug) {
    case 'claude':
    case 'chatgpt':
    case 'grok':
      return `${es ? habitsEs(host) : habits(host)}\n${es ? chatLayersEs : chatLayers}\n${extra}${ask(v, lang)}`;
    case 'grok-build':
    case 'claude-code':
    case 'codex':
    case 'gemini-cli':
      return wrap(`${es ? habitsEs(host) : habits(host)}\n\n${es ? layersEs : layers}\n${extra}\n${ask(v, lang)}`, v);
    case 'opencode':
      // Discussions only: that connection has no load_profile, so it reports no setup number.
      if (es) return wrap(`Tengo una memoria compartida, la memoria de BrainAI (${host}), conectada contigo como conector MCP. Tu conexión es solo para debates: cuando te pida unirte a un debate, léelo y publica ahí tu respuesta con las herramientas de debates. No guardes nunca contraseñas, claves ni tokens.${extra ? `\n${extra.trimEnd()}` : ''}`, v);
      return wrap(`I have a shared memory, the brain (${host}), connected to you as an MCP connector. Your connection is for discussions only: when I ask you to join a discussion, read it and post your answer there with the discussion tools. Never save passwords, keys or tokens.${extra ? `\n${extra.trimEnd()}` : ''}`, v);
    default:
      throw new Error(`No setup text for ${slug}`);
  }
}

/** The app a connection most likely is, from its name, for the link to its setup page; null when nothing matches. */
export function appOfGrant(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('claude code')) return 'claude-code';
  if (n.includes('codex')) return 'codex';
  if (n.includes('grok build')) return 'grok-build';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('gemini')) return 'gemini-cli';
  if (n.includes('chatgpt') || n.includes('gpt')) return 'chatgpt';
  if (n.includes('grok')) return 'grok';
  if (n.includes('claude')) return 'claude';
  return null;
}
