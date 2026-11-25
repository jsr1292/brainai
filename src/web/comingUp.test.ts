import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n/index.js';
import { projectList, type HomeViewInput } from './projectsViews.js';

test('home shows coming-up facts in English and Spanish and hides the empty section', () => {
  const input: HomeViewInput = {
    home: {
      sections: [], onTheGo: [], open: [], quiet: [], ideas: [], parked: [], done: [], personal: [], suggestions: [],
      folders: { unmatched: [], receivedAt: null, device: null }, healthCounts: { waiting: 0, stuck: 0 },
    },
    selected: undefined, approvals: { count: 0, first: null }, backupProblem: null, now: new Date('2026-10-01T12:00:00Z'),
  };
  assert.doesNotMatch(projectList(input, 'home').value, /id="coming-up"/);
  const dated = { ...input, comingUp: [{ id: 'fact-1', project: 'wildlog', content: 'Fixture permit renewal', validUntil: '2026-10-01' }] };
  const section = (locale: 'en' | 'es') => runWithLocale(locale, () =>
    projectList(dated, 'home').value.match(/<section aria-labelledby="coming-up">([\s\S]*?)<\/section>/)?.[1] ?? '');
  const english = section('en');
  assert.match(english, /Coming up/);
  assert.match(english, /<time\b[^>]* datetime="2026-10-01">2026-10-01<\/time>/);
  assert.match(english, /Fixture permit renewal/);
  assert.match(section('es'), /Próximas fechas/);
  assert.match(english, /<ul class="meta-line">/);
  const long = { ...input, comingUp: [{ id: 'fact-2', project: 'wildlog', content: `<b>x</b> ${'long '.repeat(80)}`, validUntil: '2026-10-02' }] };
  const row = runWithLocale('en', () => projectList(long, 'home').value);
  assert.doesNotMatch(row, /<b>x<\/b>/);
  assert.match(row, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(row, /(long ){70}/);
  assert.match(row, /…/);
  assert.doesNotMatch(projectList(dated, 'list').value, /id="coming-up"/);
});
