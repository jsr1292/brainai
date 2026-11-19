import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n/core.js';
import { updateLine } from '../desktop/updateState.js';
import { toolName } from '../desktop/tools.js';
import { reasonText } from './errorText.js';
import { reasonLine } from './healthViews.js';
import { roadmapLine } from './dashboardViews.js';
import { weekNav } from './subnav.js';
import { backError } from './back.js';

test('integration pass: screen texts follow the language while the stored English stays', () => {
  const u = { version: '1.7.0', current: '1.6.0', state: 'installing' } as Parameters<typeof updateLine>[0];
  assert.match(updateLine(u).title, /is ready \(you have 1\.6\.0\)/);
  runWithLocale('es', () => {
    assert.match(updateLine(u).title, /está listo \(tienes 1\.6\.0\)/);
    assert.equal(toolName({ id: 'claude-desktop', name: 'Claude (desktop app)' }), 'Claude (app de escritorio)');
    assert.match(reasonText('is close to a fact you deleted on 2 Nov 2026 and runs a downloaded script'), /^está cerca de un dato que eliminaste|^.*2 nov 2026.* y /);
    assert.match(reasonLine({ text: 'x', href: '/', say: { key: 'health.r.overdue', params: { project: 'p', text: 'job' } }, dueDay: '2026-11-03' }), /vencía el 3 nov/);
    assert.match(roadmapLine('Now: a\nNext: b')!, /^Ahora: a · Siguiente: b$/);
    assert.match(weekNav('last').value, /aria-label="Semana"/);
    assert.match(backError('failed')!, /No se ha podido guardar/);
  });
  assert.equal(roadmapLine('Now: a\nNext: b'), 'Now: a · Next: b');
});
