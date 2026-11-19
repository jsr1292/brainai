import type { Key } from './core.js';

/** The catalog key (and params) of a message people see, kept beside an error's English `.message`. */
export interface Say { key: Key; params?: Record<string, string | number> }

/**
 * An Error whose English `.message` is what assistants and logs read (MCP) and that may carry the same text as a catalog
 * key, which the dashboard shows in the owner's language through `errorText(e)` (src/web/errorText.ts).
 */
export class SayableError extends Error {
  readonly key?: Key;
  readonly params?: Record<string, string | number>;
  constructor(message: string, say?: Say) {
    super(message);
    if (say) { this.key = say.key; if (say.params) this.params = say.params; }
  }
}
