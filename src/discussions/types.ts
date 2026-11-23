/**
 * What a connected assistant may do: everything, only take part in discussions, or only read the projects its grant
 * names ('projects': no profile, no saving, no discussions).
 */
export type Access = 'full' | 'discussions' | 'projects';

/** Who is speaking: the assistant's name and the model behind it ('' for the owner). */
export interface Voice { name: string; model: string }

export interface Post {
  id: number; discussionId: string; round: number; kind: 'reply' | 'note';
  author: string; model: string; text: string; createdAt: string;
}

/** A post as stored: with the connection (grant) that wrote it, null for older posts and for the owner. Never shown to assistants. */
export type StoredPost = Post & { grantId: string | null };

/** The post without its grant id: what views and tool replies carry. */
export const publicPost = ({ grantId: _grantId, ...p }: StoredPost): Post => p;

/** A file attached to a discussion; size is in bytes. */
export interface DiscussionFile { name: string; size: number; addedBy: string; addedAt: string }

export interface Discussion {
  id: string; title: string; question: string; project: string | null; openedBy: Voice; openedAt: string;
  round: number; ask: string[]; includeLimited: boolean; closedAt: string | null;
  decision: string | null; decisionMemoryId: string | null;
  /** The grant that opened it; null for a discussion from before grants were recorded or one opened by the owner. */
  openedGrant: string | null;
}

/**
 * Identity of an assistant (connection) name: lower case letters and digits only, so "Claude Code", "claude-code"
 * and "ClaudeCode" name the same assistant. A name with no letter or digit keeps its trimmed lower-case form.
 */
export const nameKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || name.trim().toLowerCase();

/** Identity of a voice for the one-reply-per-round rule: case, outer spaces and repeated spaces do not matter. */
export const voiceKey = (author: string, model: string): string =>
  `${author.trim().toLowerCase()}\u0000${model.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/**
 * Whether a post is the caller's voice: by grant when both sides have one (a name is only what a connection calls
 * itself), by name and model for posts written before grants were recorded. A post with a grant is never the voice of a
 * caller without one.
 */
/** What became of a connection: still there, revoked (at its Full or another level), or no row at all (a restored brain). */
export type GrantState = 'live' | 'gone-full' | 'gone-other' | 'missing';

/** A gone connection's role passes to a Full namesake only when it was Full itself, or its row is missing. */
export const mayTakeOver = (caller: { access?: string }, state: () => GrantState): boolean => {
  if (caller.access !== 'full') return false; // the cheap check first: no lookup for anyone else
  const st = state();
  return st === 'gone-full' || st === 'missing';
};

export function isSameVoice(caller: { name: string; access?: string; grantId?: string | null }, model: string, p: StoredPost, state: (grantId: string) => GrantState = () => 'live'): boolean {
  const norm = (m: string) => m.trim().toLowerCase().replace(/\s+/g, ' ');
  if (p.grantId !== null) {
    if (caller.grantId && p.grantId === caller.grantId) return norm(p.model) === norm(model);
    // The connection that wrote it is gone (revoked, or a restored brain without it): a Full caller with the same name and model carries on as it.
    if (mayTakeOver(caller, () => state(p.grantId!))) return voiceKey(p.author, p.model) === voiceKey(caller.name, model);
    return false;
  }
  return voiceKey(p.author, p.model) === voiceKey(caller.name, model);
}
