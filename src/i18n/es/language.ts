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
};
