/** A small multipart/form-data reader for the one file upload (C4): the body is already in memory, nothing touches disk. */
export interface Part { name: string; filename?: string; data: Buffer }

export function parseMultipart(contentType: string | undefined, body: Buffer): Part[] | null {
  const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary || boundary.length > 200) return null;
  const first = Buffer.from(`--${boundary}`);
  const sep = Buffer.from(`\r\n--${boundary}`);
  const parts: Part[] = [];
  // The body starts with the first delimiter (a preamble before it is allowed and ignored).
  let at = body.indexOf(first);
  if (at < 0) return null;
  let delimLen = first.length;
  while (true) {
    const after = at + delimLen;
    const tail = body.subarray(after, after + 2).toString('latin1');
    if (tail === '--') break; // the closing delimiter
    if (tail !== '\r\n') return null; // a delimiter is followed by CRLF (or "--")
    const start = after + 2;
    const next = body.indexOf(sep, start);
    if (next < 0) return null;
    const chunk = body.subarray(start, next);
    const split = chunk.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = chunk.subarray(0, split).toString('utf8');
      const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
      if (name !== undefined) parts.push({ name, filename, data: chunk.subarray(split + 4) });
    }
    at = next;
    delimLen = sep.length;
  }
  return parts;
}
