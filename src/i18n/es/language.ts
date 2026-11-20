import type { language } from '../en/language.js';
import type { Entry } from '../core.js';

export const language_es: Record<keyof typeof language, Entry> = {
  'lang.title': 'Idioma',
  'lang.lede': 'El idioma de las pantallas de BrainAI. No cambia cómo te responden tus asistentes.',
  'lang.auto': 'Automático',
  'lang.autoSub': 'Sigue el idioma de tu navegador: español si pide español y, si no, inglés.',
  'lang.save': 'Guardar',
  'lang.status.auto': 'Automático',
  'lang.name.en': 'English',
  'lang.name.es': 'Español',
  'lang.goto': 'Ajustes › Idioma',
  'theme.title': 'Apariencia',
  'theme.lede': 'Automático sigue el ajuste de tu ordenador.',
  'theme.ledeBrowser': 'Automático sigue el ajuste de tu ordenador. Esta elección se guarda solo en este navegador.',
  'theme.auto': 'Automático',
  'theme.light': 'Claro',
  'theme.dark': 'Oscuro',
  'theme.save': 'Guardar',
  'theme.goto': 'Ajustes › Apariencia',
};
