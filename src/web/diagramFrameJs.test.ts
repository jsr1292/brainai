/* diagram-frame.js: its pure helpers run in node; the page part only runs inside the frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const f = await import(new URL('./static/diagram-frame.js', import.meta.url).href);
const vars = { surface: '#ffffff', raised: '#f4f1ea', line: '#e6e2d9', lineStrong: '#d6d1c5', fg: '#1c1b19', muted: '#6b675f', ink2: '#3a3833', dark: false, palette: Array.from({ length: 12 }, (_, i) => `#0${i.toString(16)}0000`) };

test('the frame draws strictly: no HTML labels, dagre only, size limits, and every top-level setting locked', () => {
  const c = f.frameConfig(vars);
  assert.equal(c.startOnLoad, false);
  assert.equal(c.securityLevel, 'strict');
  assert.equal(c.htmlLabels, false);
  assert.equal(c.flowchart.htmlLabels, false);
  assert.equal(c.layout, 'dagre');
  assert.equal(c.theme, 'base');
  assert.equal(c.maxTextSize, 20000);
  assert.equal(c.maxEdges, 300);
  for (const k of ['securityLevel', 'secure', 'startOnLoad', 'maxTextSize', 'maxEdges', 'dompurifyConfig', 'themeCSS', 'themeVariables', 'theme', 'darkMode', 'look', 'layout', 'fontFamily', 'altFontFamily', 'htmlLabels', 'deterministicIds', 'deterministicIDSeed', 'arrowMarkerAbsolute', 'logLevel', 'handDrawnSeed', 'wrap', 'markdownAutoWrap', 'legacyMathML', 'forceLegacyMathML']) {
    assert.ok(c.secure.includes(k), k);
  }
  for (const k of ['flowchart', 'sequence', 'fontSize']) assert.ok(!c.secure.includes(k), k);
});

test('the frame takes the brain\'s colours, a palette for every colour scale, and the theme', () => {
  const v = f.frameConfig(vars).themeVariables;
  assert.equal(v.primaryTextColor, '#1c1b19');
  assert.equal(v.textColor, '#1c1b19');
  assert.equal(v.lineColor, '#d6d1c5');
  assert.equal(v.edgeLabelBackground, '#ffffff');
  assert.equal(v.darkMode, false);
  for (let i = 0; i < 12; i++) assert.equal(v[`cScale${i}`], vars.palette[i]);
  for (let i = 1; i <= 12; i++) assert.equal(v[`pie${i}`], vars.palette[i - 1]);
  for (let i = 0; i < 8; i++) assert.equal(v[`git${i}`], vars.palette[i]);
  assert.equal(f.frameConfig({ ...vars, dark: true }).themeVariables.darkMode, true);
});

test('HTML labels turned on by a diagram\'s own settings are reported, not drawn', () => {
  const sentence = "This diagram turns on HTML labels, which the brain doesn't draw. Remove the `htmlLabels` setting at its top.";
  assert.equal(f.checkHtmlLabels({ htmlLabels: true }), sentence);
  assert.equal(f.checkHtmlLabels({ htmlLabels: false, flowchart: { htmlLabels: true } }), sentence);
  assert.equal(f.checkHtmlLabels({ htmlLabels: false, flowchart: { htmlLabels: false } }), null);
});

test('a drawing that holds HTML (a foreignObject) is reported, whatever the settings said', () => {
  assert.equal(f.svgHasHtml('<svg><g><foreignObject><div>x</div></foreignObject></g></svg>'), true);
  assert.equal(f.svgHasHtml('<svg><g><text>x</text></g></svg>'), false);
});
