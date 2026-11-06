import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const randomToken = (): string => randomBytes(32).toString('base64url');
