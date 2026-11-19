/** HTML that is already escaped (or deliberately trusted) and is inserted verbatim. Its own module so the i18n layer can use it without importing the web layer. */
export class SafeHtml {
  constructor(readonly value: string) {}
}
