import { t } from '../i18n/core.js';

/**
 * What the desktop pages call the computer BrainAI runs on (D6): "this Mac" on a Mac, "this computer" on Windows.
 * Set once by createApp from the platform, as the page mode is.
 */
let name = 'this Mac';

export function setComputer(platform: NodeJS.Platform): void {
  name = platform === 'win32' ? 'this computer' : 'this Mac';
}

/** "this Mac" / "this computer", in a sentence. */
export const thisComputer = (): string => name;
/** "This Mac" / "This computer", at the start of a sentence. */
export const ThisComputer = (): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The same name for a screen, in the request's language ("este Mac"). `thisComputer()` stays English: it is for anything
 * stored or read by an assistant. Call at render time, never at module scope.
 */
export const computerName = (): string => t(name === 'this Mac' ? 'setup.computer.mac' : 'setup.computer.pc');
/** `computerName()` at the start of a sentence ("Este Mac"). */
export const ComputerName = (): string => t(name === 'this Mac' ? 'setup.Computer.mac' : 'setup.Computer.pc');
