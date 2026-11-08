import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBlock, putBlock, removeBlock } from './rulesBlock.js';
import { setupText } from '../setup/texts.js';

const block = setupText('claude-code', 'personal', 'http://localhost:3100/mcp');

test('the rules block is found with the host it names, for the full and the discussions-only texts', () => {
  const text = `# My notes\n\n${block}\n\nMore notes\n`;
  const found = findBlock(text)!;
  assert.equal(text.slice(found.start, found.end), block);
  assert.equal(found.host, 'localhost:3100');
  assert.equal(findBlock(setupText('opencode', 'personal', 'https://memory.example.com/mcp'))!.host, 'memory.example.com');
  assert.equal(findBlock('no block here\n'), null);
  assert.equal(findBlock('<!-- brain setup 2 -->\nI have a shared memory, the brain (x)\nno end marker\n'), null, 'an opening line with no closing one is no block');
});

test('putting the block replaces only the old block, byte for byte around it', () => {
  const old = setupText('claude-code', 'personal', 'https://memory.example.com/mcp');
  const before = '# Mine\r\nkeep this\r\n\r\n';
  const after = '\r\n\r\nand this, exactly\r\n';
  const text = before + old.replace(/\n/g, '\r\n') + after;
  const out = putBlock(text, block);
  assert.ok(out.startsWith(before) && out.endsWith(after), 'the rest of the file is untouched');
  assert.ok(out.includes(block.replace(/\n/g, '\r\n')), 'CRLF in, CRLF out');
  assert.equal(findBlock(out)!.host, 'localhost:3100');
});

test('with no block, it is appended after one blank line, keeping a final newline; removing it gives the file back', () => {
  for (const [original, back] of [['# Mine\nline\n', '# Mine\nline\n'], ['# Mine\nline', '# Mine\nline\n'], ['', '']]) {
    const out = putBlock(original!, block);
    assert.equal(findBlock(out)!.host, 'localhost:3100');
    assert.ok(out.endsWith('\n'));
    // A file that had no final newline gets one: once appended, the two cannot be told apart.
    assert.equal(removeBlock(out), back, JSON.stringify(original));
  }
  assert.equal(removeBlock(`A\n\n${block}\n\nB\n`), 'A\n\nB\n', 'a block in the middle leaves one blank line');
  assert.equal(putBlock('# Mine\nline\n', block), `# Mine\nline\n\n${block}\n`);
  assert.equal(removeBlock('nothing to remove\n'), 'nothing to remove\n');
});

test('a stray opening marker before a real block never swallows the owner text between them', () => {
  const text = `<!-- brain setup 1 -->\nold half\n\nmine\n${block}\n`;
  const found = findBlock(text)!;
  assert.equal(text.slice(found.start, found.end), block);
  assert.match(putBlock(text, block), /old half\n\nmine\n/);
  assert.match(removeBlock(text), /old half\n\nmine\n/);
});

test("the host is read from looser wording too, such as the owner's own line", () => {
  const owner = '<!-- brain setup 3 -->\nI have a shared memory, the brain (MCP connector "memory", memory.example.net), used by all my assistants.\n<!-- /brain setup -->';
  assert.equal(findBlock(owner)!.host, 'memory.example.net');
  assert.equal(findBlock('<!-- brain setup 2 -->\nthe brain (localhost:3100)\n<!-- /brain setup -->')!.host, 'localhost:3100');
});
