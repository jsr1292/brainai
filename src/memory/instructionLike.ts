/**
 * Phrasing typical of text planted to steer AI assistants (prompt injection). An assistant reading someone else's
 * file or web page could be talked into saving such a line, and every assistant would then recall it, so a match
 * is held for the owner's approval instead of being saved. Narrow on purpose: a false match costs one click.
 */
const PATTERNS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all|any|other|your|the|these)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|directives?|guardrails?)\b/i, 'asks to ignore instructions'],
  [/\b(ignora|ignorar|olvida|olvidar)\b[^.\n]{0,40}\b(instrucciones|reglas|indicaciones)\b/i, 'asks to ignore instructions'],
  [/\b(you are now|from now on,? you|pretend (to be|you are)|act as (an?|the|if)\b)/i, 'speaks to the assistant directly'],
  [/\b(do not|don't|never)\s+(tell|inform|mention|show|notify|alert|ask)\b[^.\n]{0,30}\b(owner|user)\b/i, 'keeps something from the owner'],
  [/\bwithout (asking|telling|confirming|checking|approval|permission|consent)\b/i, "skips the owner's confirmation"],
  [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?)\b/i, 'runs a downloaded script'],
  [/\bpowershell\b[^\n]{0,40}\s-(e|enc|encodedcommand)\s/i, 'runs a downloaded script'],
  [/\b(send|post|upload|forward|exfiltrate)\b[^.\n]{0,60}\bto\s+https?:\/\//i, 'sends data to a web address'],
  [/\b(assistants?|agents?|ai|codex|claude|chatgpt|grok|llms?)\b[^.\n]{0,20}\b(must|should|shall|have to|need to)\b[^.\n]{0,20}\b(always|never|automatically)\b/i, 'sets a standing rule for assistants'],
];

/** A short reason when the text reads like an instruction aimed at AI assistants, otherwise null. */
export function looksLikeInstruction(text: string): string | null {
  for (const [re, reason] of PATTERNS) if (re.test(text)) return reason;
  return null;
}

/**
 * The same check without the two patterns that also match plain descriptions of work: "merged without checking",
 * "told Codex it must always run the tests". For text that is refused outright rather than held for approval, such
 * as Growth observations, which describe exactly those moments. What is left catches text planted to steer assistants.
 */
const DESCRIBES_WORK = new Set(["skips the owner's confirmation", 'sets a standing rule for assistants']);
export function looksLikeInjection(text: string): string | null {
  for (const [re, reason] of PATTERNS) if (!DESCRIBES_WORK.has(reason) && re.test(text)) return reason;
  return null;
}
