/**
 * Where a view already names the project, a fact's leading "<project>:" or "<project> status:" says it twice: drop it
 * (case-insensitive), unless nothing would be left.
 */
export function stripProjectPrefix(text: string, project: string): string {
  const esc = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}(?: status)?:\\s*`, 'i').exec(text);
  return m && text.length > m[0].length ? text.slice(m[0].length) : text;
}
