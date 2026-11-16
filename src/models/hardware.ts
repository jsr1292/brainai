import { totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';

export interface Hardware { arch: 'arm64' | 'x64'; platform: NodeJS.Platform; memoryBytes: number; freeDiskBytes: number }

const GB = 1024 ** 3;

/** This computer, as far as choosing models goes: chip, memory, and free space where the data lives. */
export async function readHardware(dataDir: string): Promise<Hardware> {
  const fs = await statfs(dataDir);
  return {
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    platform: process.platform,
    memoryBytes: totalmem(),
    freeDiskBytes: Number(fs.bavail) * Number(fs.bsize),
  };
}

/**
 * "Choose for me": Balanced + Standard on an Apple-silicon Mac (Arm on macOS; a Windows Arm PC goes by its memory) or
 * at least 8 GB memory, with at least 1 GB free disk;
 * Light + Standard otherwise; Light + none below 4 GB whatever the chip (checked first). Strong is never suggested.
 */
export function suggest(hw: Hardware): { search: 'e5' | 'gemma'; rerank: 'mminilm' | null } {
  if (hw.memoryBytes < 4 * GB) return { search: 'e5', rerank: null };
  if (((hw.arch === 'arm64' && hw.platform === 'darwin') || hw.memoryBytes >= 8 * GB) && hw.freeDiskBytes >= GB) return { search: 'gemma', rerank: 'mminilm' };
  return { search: 'e5', rerank: 'mminilm' };
}
