import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyWithoutTitle, checkFile, FileRefused, MAX_FILE_BYTES, titleFor } from './fileUpload.js';
import { parseMultipart } from './multipart.js';

const buf = (s: string) => Buffer.from(s, 'utf8');

test('a .md or .txt file is accepted', () => {
  assert.equal(checkFile('notes.md', buf('# Hello\nbody')).text, '# Hello\nbody');
  assert.equal(checkFile('notes.TXT', buf('plain text')).name, 'notes.TXT');
});

test('other types are refused, PDF with its own sentence', () => {
  assert.throws(() => checkFile('a.docx', buf('x')), /Only \.md and \.txt/);
  assert.throws(() => checkFile('a.pdf', buf('x')), /PDF files are not supported yet/);
  assert.throws(() => checkFile('a.md.exe', buf('x')), FileRefused);
});

test('over 1 MB, empty and binary content are refused', () => {
  assert.throws(() => checkFile('a.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 97)), /larger than 1 MB/);
  assert.throws(() => checkFile('a.txt', Buffer.alloc(0)), /empty/);
  assert.throws(() => checkFile('a.txt', Buffer.from([0x50, 0x4b, 0x00, 0x03])), /not plain text/);
  assert.throws(() => checkFile('a.md', Buffer.from([0xff, 0xfe, 0xfa])), /not plain text/);
  assert.throws(() => checkFile('a.md', buf('abc\u0001def')), /not plain text/);
});

test('a file with a secret is refused', () => {
  assert.throws(() => checkFile('a.md', buf('Notes\napi_key: abcdef123456789xyz')), /password, key or token/);
});

test('the title is the first heading, else the file name', () => {
  assert.equal(titleFor('x.md', 'intro\n\n## **Server setup** ##\ntext'), 'Server setup');
  assert.equal(titleFor('home-network_notes.txt', 'no headings here'), 'home network notes');
  assert.equal(titleFor('C:\\docs\\plan.md', ''), 'plan');
});

test('the multipart reader finds the file and its fields', () => {
  const b = '----x1';
  const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\nhi\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="n.md"\r\nContent-Type: text/markdown\r\n\r\n# T\r\nline\r\n--${b}--\r\n`);
  const parts = parseMultipart(`multipart/form-data; boundary=${b}`, body)!;
  assert.equal(parts.length, 2);
  assert.equal(parts[1]!.filename, 'n.md');
  assert.equal(parts[1]!.data.toString(), '# T\r\nline');
  assert.equal(parseMultipart('text/plain', body), null);
});

test('a 100k line of hashes and spaces finds its title in well under 100 ms', () => {
  for (const line of ['#' + ' \t'.repeat(50_000), '# ' + '#'.repeat(100_000), '#\t' + ' '.repeat(100_000) + 'x']) {
    const t = Date.now();
    titleFor('x.md', `${line}\nbody`);
    assert.ok(Date.now() - t < 100, `took ${Date.now() - t} ms`);
  }
});

test('a Windows file is stored with plain line breaks', () => {
  assert.equal(checkFile('a.md', buf('# T\r\nline one\r\nline two')).text, '# T\nline one\nline two');
});

test('the first H1 is dropped from the body only when it is the title', () => {
  assert.equal(bodyWithoutTitle('# Release checklist\n\n## Steps\nGo', 'Release checklist'), '## Steps\nGo');
  assert.equal(bodyWithoutTitle('# Release checklist\n\n## Steps', 'Another title'), '# Release checklist\n\n## Steps');
  assert.equal(bodyWithoutTitle('intro\n# Later\nx', 'Later'), 'intro\nx');
  assert.equal(bodyWithoutTitle('## Release\nx', 'Release'), '## Release\nx');
  assert.equal(bodyWithoutTitle('# Only title', 'Only title'), '# Only title');
});

test('a malformed multipart body is refused, not guessed at', () => {
  const b = 'bb';
  const ok = (s: string) => parseMultipart(`multipart/form-data; boundary=${b}`, Buffer.from(s));
  assert.equal(ok(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nx\r\n--${b}--\r\n`)!.length, 1);
  assert.equal(ok(`--${b}Xjunk\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nx\r\n--${b}--`), null, 'no CRLF after the first delimiter');
  assert.equal(ok(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nx\n--${b}--`), null, 'the next delimiter is not preceded by CRLF');
  assert.equal(ok(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nx`), null, 'no closing delimiter');
  const inside = ok(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nline --${b} not a delimiter\r\n--${b}--`)!;
  assert.equal(inside[0]!.data.toString(), `line --${b} not a delimiter`);
});
