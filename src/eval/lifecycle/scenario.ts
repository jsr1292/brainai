import type { Brain } from './brain.js';
import type { Session, TurnResult } from './assistants.js';
import type { Verdict } from './judge.js';

/** `notTested`: the situation the check needs never came up (nothing was saved). It is never a pass; `pass` is false. */
export interface Check { tag: string; name: string; pass: boolean; reason: string; kind: 'state' | 'answer' | 'setup'; notTested?: boolean }

export interface Who { kind: 'claude' | 'codex'; connection: string }

export interface Ctx {
  brain: Brain;
  /** The assistant under test: it does the step that is measured. */
  primary: Who;
  /** The other assistant, for work "in another app". With one assistant it is a second connection of the same kind. */
  peer: Who;
  /** Who writes background facts in scenarios that measure answering, not saving: Claude Code when it is in the run, else the assistant under test. */
  seeder: Who;
  /** A fresh conversation with that assistant (own session, new context). */
  session(who: Who, opts?: { today?: string }): Session;
  check(c: Check): void;
  /** LLM judge on an answer; the verdict is also recorded as a check when `tag` is given. */
  judge(tag: string, name: string, question: string, answer: string, rubric: string): Promise<Verdict>;
  /** A step that must work for the scenario to mean anything (a failed one stops the scenario as "setup failed"). */
  setup(name: string, pass: boolean, reason: string): void;
  note(key: string, value: unknown): void;
  /** Things the owner does in the dashboard, over the real HTTP routes. */
  owner: {
    deleteFact(id: string): Promise<void>;
    rejectSuggestion(id: string): Promise<void>;
    approveSuggestion(id: string): Promise<void>;
    approveHarvest(batch: string): Promise<void>;
    addBuiltinSkill(name: string): Promise<void>;
  };
}

export interface Scenario {
  id: string;
  title: string;
  /** What it is for, in one line (goes in the doc). */
  covers: string[];
  run(ctx: Ctx): Promise<void>;
}

export class SetupFailed extends Error {}
export type { TurnResult };
