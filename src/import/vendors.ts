/**
 * Where each assistant keeps its built-in memory and how the owner gets it out (C1). The steps follow each vendor's
 * help page, checked 2026-11-18 (cited in docs/IMPORT.md); nothing here is fetched at runtime. Menu names change, so
 * the page also names the help article.
 */
export interface Vendor { id: 'chatgpt' | 'claude' | 'gemini'; name: string; steps: string[]; helpUrl: string; helpTitle: string; extraUrl?: string }

/** The prompt that works in any of the three. */
export const EXPORT_PROMPT = 'List everything you remember about me, one item per line. Include saved memories and what you have picked up about my preferences, work and projects. Plain text only, no commentary.';

export const VENDORS: Vendor[] = [
  {
    id: 'chatgpt', name: 'ChatGPT',
    steps: [
      'Open Settings › Personalization › Memory and choose Manage (some accounts show Manage memories). Copy the list you see there.',
      'Or ask in a chat with the prompt below. It also finds what ChatGPT picked up from past chats, which the list may not show.',
      'Paste the text into the box on this page.',
    ],
    helpUrl: 'https://help.openai.com/en/articles/8590148-memory-faq', helpTitle: 'Memory FAQ (OpenAI Help Center)',
  },
  {
    id: 'claude', name: 'Claude',
    steps: [
      'Open Settings › Your Claude (older layout: Settings › Memory or Capabilities) and choose Manage next to Your memory. Read each topic and copy it.',
      'Or ask in a chat with the prompt below, and ask for a verbatim copy. Claude can give its memory as text this way.',
      'Paste the text into the box on this page.',
    ],
    helpUrl: 'https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude', helpTitle: 'Import and export your memory from Claude',
    extraUrl: 'https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-conversations',
  },
  {
    id: 'gemini', name: 'Gemini',
    steps: [
      'Open Settings & help › Personal context (older layout: Saved info). Copy the info you asked Gemini to save.',
      'Or ask in a chat with the prompt below. This needs a personal Google Account: work and school accounts do not have these features.',
      'Paste the text into the box on this page.',
    ],
    helpUrl: 'https://support.google.com/gemini/answer/16413516', helpTitle: 'Save info and reference past chats in Gemini Apps',
  },
];

export const vendorById = (id: string): Vendor | undefined => VENDORS.find((v) => v.id === id);
