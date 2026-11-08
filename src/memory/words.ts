/**
 * Text as space-padded lowercase words without accents ("Cellar-App!" → " cellar app "), so a name is found with
 * `includes(words(name))` only as whole words.
 */
export const words = (text: string): string => ` ${text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
