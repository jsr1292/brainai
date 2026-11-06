/** The brain's version, from package.json, shown in Settings so an update can be checked (open source O1). */
import { readFileSync } from 'node:fs';

export const BRAIN_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
