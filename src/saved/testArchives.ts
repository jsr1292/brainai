/** Hand-built archives for tests: names and entry kinds the system tar will not write, and plain tars of a folder. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** A hand-made tar.gz of one entry (a file, or a symlink with `link`), for names the system tar will not write. */
export function handTar(out: string, name: string, link?: string): string {
  const head = Buffer.alloc(512);
  head.write(name, 0);
  head.write('0000644\0', 100);
  head.write('0000000\0', 108);
  head.write('0000000\0', 116);
  head.write('00000000000\0', 124);
  head.write('00000000000\0', 136);
  head.write('        ', 148);
  head.write(link ? '2' : '0', 156);
  if (link) head.write(link, 157);
  head.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const b of head) sum += b;
  head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  writeFileSync(out, gzipSync(Buffer.concat([head, Buffer.alloc(1024)])));
  return out;
}

/** Builds a tar.gz from a folder's listed entries. */
export function tarOf(dir: string, out: string, entries: string[]): string {
  execFileSync('tar', ['-czf', out, '-C', dir, ...entries]);
  return out;
}
