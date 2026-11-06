import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceLabel } from './deviceLabel.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('deviceLabel names the OS and browser', () => {
  assert.equal(deviceLabel(IPHONE), 'iPhone · Safari');
  assert.equal(deviceLabel(MAC_CHROME), 'Mac · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Linux · Firefox');
});

test('deviceLabel handles short names, unknown agents and missing agents', () => {
  assert.equal(deviceLabel('iPhone'), 'iPhone');
  assert.equal(deviceLabel('Mac'), 'Mac');
  assert.equal(deviceLabel('curl/8.0'), 'curl/8.0');
  assert.equal(deviceLabel('x'.repeat(100)), 'x'.repeat(60));
  assert.equal(deviceLabel(null), 'Unknown device');
  assert.equal(deviceLabel(''), 'Unknown device');
});
