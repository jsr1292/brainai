/**
 * Reading the coding tools' JSON settings safely. A file saved by Notepad or PowerShell may start with a UTF-8 byte order
 * mark (JSON.parse refuses it): it is stripped to parse and put back on write. A UTF-16 file (also what older PowerShell's
 * `>` makes) is refused with its own message: BrainAI writes UTF-8 only and will not turn the owner's file into another encoding.
 */
import { existsSync, readFileSync } from 'node:fs';

export type JsonFile = { json: Record<string, unknown>; bom: boolean } | { refuse: 'utf16' | 'json' };

export const BOM = '﻿';

/** The file's text without a UTF-8 BOM (and whether it had one), or 'utf16' when it is UTF-16 (either byte order, BOM-marked). */
export function readTextFile(path: string): { text: string; bom: boolean } | 'utf16' | null {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return 'utf16';
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: buf.subarray(bom ? 3 : 0).toString('utf8'), bom };
}

/** The JSON object in the file; null when there is no file. `check` may throw for a shape BrainAI cannot work with. */
export function readJsonFile(path: string, check?: (json: Record<string, unknown>) => void): JsonFile | null {
  const file = readTextFile(path);
  if (file === null) return null;
  if (file === 'utf16') return { refuse: 'utf16' };
  try {
    const json = JSON.parse(file.text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    check?.(json as Record<string, unknown>);
    return { json: json as Record<string, unknown>, bom: file.bom };
  } catch {
    return { refuse: 'json' };
  }
}

/** The text to write: pretty JSON, a final newline, and the BOM the file came with. */
export const jsonText = (json: unknown, bom: boolean): string => `${bom ? BOM : ''}${JSON.stringify(json, null, 2)}\n`;
