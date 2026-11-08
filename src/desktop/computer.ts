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
