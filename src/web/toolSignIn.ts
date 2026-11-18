/**
 * Whether a tool that BrainAI added has also signed in: Connect only adds the server entry; the tool then asks the
 * owner to Allow, which makes an OAuth grant under the tool's own name. Until that grant exists the tool is "added".
 */
import type { GrantInfo } from '../auth/provider.js';
import { appOfGrant } from '../setup/texts.js';
import type { ToolState } from '../desktop/tools.js';

/** The slugs appOfGrant gives each tool (Cursor has none: its grant is matched by name). */
const SLUG: Partial<Record<ToolState['id'], string>> = { 'claude-code': 'claude-code', codex: 'codex', opencode: 'opencode' };

/** A live grant made by this tool: its name starts with the tool's name (as Disconnect ends them), or it is the tool's app. */
export function hasSignedIn(t: Pick<ToolState, 'id' | 'name'>, grants: readonly GrantInfo[]): boolean {
  // Claude's desktop app signs in at Connect time: its key is a grant made by Connect itself, so there is no step left.
  if (t.id === 'claude-desktop') return true;
  return grants.some((g) => !g.revokedAt && (g.clientName.toLowerCase().startsWith(t.name.toLowerCase()) || (SLUG[t.id] !== undefined && appOfGrant(g.clientName) === SLUG[t.id])));
}

/** The states with `signedIn` filled in for each connected tool. */
export function withSignIn(states: ToolState[], grants: readonly GrantInfo[]): ToolState[] {
  return states.map((t) => (t.state === 'connected' ? { ...t, signedIn: hasSignedIn(t, grants) } : t));
}

/** Tools that were added but have not signed in yet. */
export const addedNotSignedIn = (states: ToolState[]): ToolState[] => states.filter((t) => t.installed && t.state === 'connected' && t.signedIn === false);
