'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// app.js is a browser script; the status line is lifted out of the real file
// and run as it is written there.
function slotStatusText() {
  const src = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/app.js'), 'utf8');
  const start = src.indexOf('const minutes = ');
  const fnStart = src.indexOf('function slotStatusText', start);
  assert.ok(start > 0 && fnStart > 0, 'app.js must still define minutes and slotStatusText');
  const end = src.indexOf('\n}', fnStart) + 2;
  const prelude = 'const MAX_MANUAL_PEERS = 8; const escapeHtml = (s) => String(s);';
  return vm.runInNewContext(`${prelude}\n${src.slice(start, end)}\nslotStatusText;`);
}

// The page draws the line again every half minute from the status the last
// pass wrote, up to ten minutes earlier; the time left is counted from then.
test('the time until an offline peer frees its slot counts down between passes', () => {
  const text = slotStatusText();
  const at = 1_000_000_000_000;
  const st = { at, state: 'full', slots: { used: 8, max: 8, offline: [{ where: 'Europe', freesInMs: 30 * 60 * 1000 }] } };
  assert.match(text(st, at).rest, /about 30 min/);
  assert.match(text(st, at + 10 * 60 * 1000).rest, /about 20 min/, 'ten minutes later, ten minutes less');
});
