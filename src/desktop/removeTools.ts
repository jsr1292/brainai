/**
 * What taking BrainAI out of the owner's AI tools means, in one place for Settings › Remove BrainAI and the Windows
 * uninstaller (`cli disconnect-tools`): every tool that holds this brain is disconnected (its sign-ins ended through
 * env.endSignIns), the save reminders of Codex and Cursor go even when the connection was already gone, Claude Code's
 * hooks go on their own, The `.brainai-backup` files are never deleted: secret-bearing ones stay beside their originals.
 */
import { t } from '../i18n/core.js';
import { removeToolHooks } from './hooksInstall.js';
import { removeHooks } from './leftovers.js';
import { backupFiles, secretBackups, claudeCodeHasBrainEntry, disconnect, dropLeftoverKey, dropSettingsBackup, tracesOfThisBrain, toolStates, type ToolEnv } from './tools.js';
import type { ToolOutcome } from '../web/removeViews.js';

export interface ToolsOut { tools: ToolOutcome[]; leftTools: { name: string; reason: string }[] }

/** Step 4: every tool that is connected to this brain or holds a piece of it. Reminders found alone go to `kept`. */
export async function takeToolsOut(env: ToolEnv, kept: string[]): Promise<ToolsOut> {
  const host = new URL(env.mcpUrl).host;
  const tools: ToolOutcome[] = [];
  const leftTools: { name: string; reason: string }[] = [];
  for (const tool of await toolStates(env)) {
    if (!tool.installed) continue;
    try {
      if (tool.state === 'other-brainai') {
        dropLeftoverKey(tool.id, env); // our own key stays ours to revoke; the other entry is not touched
        tools.push({ name: tool.name, what: 'left alone', detail: tool.detail });
        continue;
      }
      const traces = tool.state === 'connected' ? 'yes' : await tracesOfThisBrain(tool.id, env);
      if (traces === 'no') {
        // Not connected here, but the save reminders BrainAI added to Codex or Cursor may still be (Connect added them, the connection went).
        if (tool.id !== 'claude-code') {
          const note = removeToolHooks(tool.id, env, false);
          if (note) kept.push(note);
        }
        continue;
      }
      if (traces === 'unreadable') {
        const reason = t('data.remove.unreadable', { host });
        tools.push({ name: tool.name, what: 'unreadable', detail: reason });
        leftTools.push({ name: tool.name, reason });
        continue;
      }
      const r = await disconnect(tool.id, env);
      if (r.ok) tools.push({ name: tool.name, what: 'disconnected' });
      else { tools.push({ name: tool.name, what: 'failed', detail: r.reason }); leftTools.push({ name: tool.name, reason: r.reason }); }
  
    } catch (e) {
      // One tool's failure (a busy database, a locked file) never leaves the tools after it connected.
      const reason = e instanceof Error ? e.message : String(e);
      tools.push({ name: tool.name, what: 'failed', detail: reason });
      leftTools.push({ name: tool.name, reason });
    }
  }
  return { tools, leftTools };
}

/**
 * Step 5: Claude Code's hooks, unless a brain may still use them (also when the server entry was removed by hand). Remove
 * deletes the settings.json backup (it holds tokens and the saved folder never gets it); the uninstaller leaves it.
 */
export async function removeClaudeHooks(env: ToolEnv, kept: string[], handled: string[], opts: { dropBackup: boolean } = { dropBackup: true }): Promise<boolean> {
  const hooks = removeHooks(env, await claudeCodeHasBrainEntry(env));
  if (hooks.kept) kept.push(hooks.kept);
  else if (opts.dropBackup) { const gone = dropSettingsBackup(env); if (gone) handled.push(gone); }
  return hooks.removed.length > 0;
}

/** The `.brainai-backup` files Remove may move into the saved folder: the plain instruction files and hook lists (tools.ts decides which). */
export const movableBackups = (env: ToolEnv): string[] => backupFiles(env);

/** A line saying where the secret-bearing backups stayed (beside their originals, never in the saved folder), or null when there are none. */
export function secretBackupNote(env: ToolEnv): string | null {
  const files = secretBackups(env);
  return files.length > 0 ? t('tools.where.secretBackups', { files: files.join(', ') }) : null;
}
