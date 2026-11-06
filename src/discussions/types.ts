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

/** A file attached to a discussion; size is in bytes. */
export interface DiscussionFile { name: string; size: number; addedBy: string; addedAt: string }

export interface Discussion {
  id: string; title: string; question: string; project: string | null; openedBy: Voice; openedAt: string;
  round: number; ask: string[]; includeLimited: boolean; closedAt: string | null;
  decision: string | null; decisionMemoryId: string | null;
}

/**
 * Identity of an assistant (connection) name: lower case letters and digits only, so "Claude Code", "claude-code"
 * and "ClaudeCode" name the same assistant. A name with no letter or digit keeps its trimmed lower-case form.
 */
export const nameKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || name.trim().toLowerCase();

/** Identity of a voice for the one-reply-per-round rule: case, outer spaces and repeated spaces do not matter. */
export const voiceKey = (author: string, model: string): string =>
  `${author.trim().toLowerCase()}\u0000${model.trim().toLowerCase().replace(/\s+/g, ' ')}`;
