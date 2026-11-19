import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_WORDS, assertNoEnglishLeft, decodeEntities, untranslatedText } from '../testing/noEnglish.js';

test('text outside ⟦…⟧ is reported; code, script, style, comments, brands, numbers and punctuation are not', () => {
  const left = untranslatedText('<p>⟦Hello⟧ world</p><code>npm install</code><pre>ls -la</pre><script>var x = "english";</script><style>.a{content:"x"}</style><!-- note --><p>BrainAI · 12 — ✓</p><input placeholder="Type here" aria-label="⟦Ok⟧"><p>⟦a⟧ ⟦b⟧</p>');
  assert.deepEqual(left.sort(), ['Type here', '⟦Hello⟧ world']);
});

test('the pre-filled brands and units are allowed, alone and as phrases', () => {
  for (const w of ['KB', 'MB', 'GB', 'TB', 'JSON', 'PDF', 'CSV', 'URL', 'MCP', 'OAuth', 'API', 'Chrome', 'Safari', 'Firefox', 'Edge', 'Android', 'iPhone', 'Windows', 'macOS', 'Linux', 'Docker', 'GitHub', 'Hugging Face', 'OpenRouter', 'Tailscale', 'Cloudflare', 'Claude', 'Claude Code', 'Codex', 'Cursor', 'OpenCode', 'Gemini', 'Gemini CLI', 'ChatGPT', 'Grok', 'BrainAI', 'Backblaze', 'B2', 'SQLite']) {
    assert.ok(ALLOWED_WORDS.has(w), w);
    assert.deepEqual(untranslatedText(`<p>${w}</p>`), [], w);
  }
  assert.deepEqual(untranslatedText('<p>⟦Conecta⟧ Claude Code, Gemini CLI, Hugging Face · 1,5 GB · 5GB</p>'), []);
  assert.deepEqual(untranslatedText('<p>Face the Code</p>'), ['Face the Code'], 'a phrase is allowed whole, not word by word');
});

test('fixture data goes in `allow`: a project name or a fact text is not a missed translation', () => {
  const page = '<h1>⟦Project⟧ wildlog cellar</h1><p>Labels stay on the phone</p><p>Something else</p>';
  assert.deepEqual(untranslatedText(page), ['⟦Project⟧ wildlog cellar', 'Labels stay on the phone', 'Something else']);
  assert.deepEqual(untranslatedText(page, { allow: ['wildlog cellar', 'Labels stay on the phone'] }), ['Something else']);
  assert.throws(() => assertNoEnglishLeft(page, 'a page', { allow: ['wildlog cellar'] }), /Labels stay on the phone/);
  assertNoEnglishLeft('<h1>⟦Proyecto⟧ wildlog cellar</h1>', 'a page', { allow: ['wildlog cellar'] });
});

test('HTML entities are decoded: named, decimal and hex', () => {
  assert.equal(decodeEntities('a &amp; b &lt;i&gt; &quot;q&quot; &#39;s&#39; &apos; &nbsp;|&hellip;&mdash;&ndash;&middot;&rsaquo; &#8250; &#x2039; &#x1F600; &bogus;'), 'a & b <i> "q" \'s\' \'  |…—–·› › ‹ 😀 &bogus;');
  // A decoded entity is checked as text: an escaped angle bracket is not hidden markup.
  assert.deepEqual(untranslatedText('<p>&lt;b&gt;Shout&lt;/b&gt;</p>'), ['<b>Shout</b>']);
  assert.deepEqual(untranslatedText('<p>⟦Hola⟧ &amp; &#8250; &middot; 12 &hellip;</p>'), []);
  assert.deepEqual(untranslatedText('<input placeholder="&quot;Search&quot; here">'), ['"Search" here']);
});

test('value= on submit inputs (not on buttons), single-quoted and unquoted attributes, SVG text, data-* labels', () => {
  assert.deepEqual(untranslatedText('<button type="submit" value="save">⟦Guardar⟧</button>'), [], 'a button value is a code');
  assert.deepEqual(untranslatedText('<input type="submit" value="Send now"><input type=button value=Reset><input type="reset" value="Clear">').sort(), ['Clear', 'Reset', 'Send now']);
  assert.deepEqual(untranslatedText('<input type="text" value="user typed this"><input type="hidden" value="secret value"><option value="visible words">⟦x⟧</option>'), []);
  assert.deepEqual(untranslatedText("<input placeholder='Single quoted' aria-label='⟦ok⟧'><a title=Unquoted href=/x>⟦a⟧</a>").sort(), ['Single quoted', 'Unquoted']);
  assert.deepEqual(untranslatedText('<svg><title>Chart of things</title><text x="1">Label here</text><path d="M0 0"/></svg>').sort(), ['Chart of things', 'Label here']);
  assert.deepEqual(untranslatedText('<svg><title>⟦Gráfico⟧</title><text>⟦Etiqueta⟧</text></svg>'), []);
  assert.deepEqual(untranslatedText('<div data-label="Hidden label" data-hint=\'A hint\' data-copy="npm install" data-id="x1" data-kind="decision">⟦x⟧</div>').sort(), ['A hint', 'Hidden label']);
  const goto = JSON.stringify([{ label: 'Skills', href: '/skills', alias: 'Habilidades' }, { label: '⟦Ajustes⟧', href: '/settings' }]).replace(/"/g, '&quot;');
  assert.deepEqual(untranslatedText(`<body data-goto="${goto}">⟦x⟧</body>`), ['Skills'], 'labels are checked, aliases and hrefs are not');
});

test('<pre> is skipped unless asked for; <code> always is', () => {
  const page = '<p>⟦Copia⟧</p><pre>Paste this into the assistant: <code>npm run x</code></pre>';
  assert.deepEqual(untranslatedText(page), []);
  assert.deepEqual(untranslatedText(page, { checkPre: true }), ['Paste this into the assistant: npm run x']);
  assert.deepEqual(untranslatedText('<p>⟦a⟧ <code>english words in code</code></p><pre><code>more code</code></pre>', { checkPre: true }), ['more code']);
});

test('a sentence with a link is clean when each piece is wrapped on its own', () => {
  assert.deepEqual(untranslatedText('<p>⟦This brain lives at ⟧<a href="/x">brain.example</a>⟦. Changes are not copied.⟧</p>').length, 1, 'the link text is a visible word outside the brackets');
  assert.deepEqual(untranslatedText('<p>⟦This brain lives at ⟧<a href="/x">⟦brain⟧</a>⟦. Changes.⟧</p>'), []);
});

test('an `allow` entry is matched as a whole phrase: its single words are not allowed elsewhere', () => {
  assert.deepEqual(untranslatedText('<p>Fixture cellar</p>', { allow: ['Fixture cellar'] }), []);
  assert.deepEqual(untranslatedText('<p>The cellar is cold</p>', { allow: ['Fixture cellar'] }), ['The cellar is cold']);
  assert.deepEqual(untranslatedText('<p>Done.</p><p>⟦Hecho⟧</p>', { allow: ['Fixture decision text'] }), ['Done.']);
});
