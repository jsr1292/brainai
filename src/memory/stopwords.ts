/**
 * Common English and Spanish words left out of keyword search: they match nearly every memory, so a hit on them says
 * nothing and would mark unrelated memories as recalled. Lowercase and without accents, as `toFtsQuery` normalises.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // English, including contraction fragments ("what's" → "what", "s")
  'a', 'about', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but',
  'by', 'can', 'could', 'd', 'did', 'do', 'does', 'doing', 'don', 'down', 'each', 'for', 'from', 'get', 'got', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'll', 'm', 'may', 'me', 'might', 'more', 'most', 'must', 'my', 'no', 'not', 'of', 'off', 'on', 'once',
  'only', 'or', 'other', 'our', 'out', 'over', 'please', 're', 's', 'shall', 'she', 'should', 'so', 'some', 'such',
  't', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'under', 'up', 'us', 've', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'why', 'will', 'with', 'would', 'you', 'your',
  // Spanish
  'al', 'ante', 'aquel', 'aquella', 'bajo', 'como', 'con', 'contra', 'cual', 'cuales', 'cuando', 'de', 'del', 'desde',
  'donde', 'durante', 'e', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'eran', 'es', 'esa', 'esas', 'ese',
  'eso', 'esos', 'esta', 'estaba', 'estan', 'estar', 'estas', 'este', 'esto', 'estos', 'fue', 'fueron', 'ha', 'habia',
  'han', 'hasta', 'hay', 'hacia', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'menos', 'mi', 'mis', 'muy', 'ni',
  'nos', 'nosotros', 'nuestra', 'nuestras', 'nuestro', 'nuestros', 'o', 'os', 'para', 'pero', 'por', 'porque', 'que',
  'quien', 'quienes', 'se', 'segun', 'ser', 'si', 'sin', 'sino', 'sobre', 'solo', 'son', 'su', 'sus', 'tambien',
  'te', 'tiene', 'tienen', 'tras', 'tu', 'tus', 'u', 'un', 'una', 'unas', 'uno', 'unos', 'usted', 'ustedes', 'y',
  'ya', 'yo',
]);
