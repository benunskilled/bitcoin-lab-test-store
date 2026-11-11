'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { legacyRunning, assertCanRun } = require('../scripts/guard-worker');

test('even an unhealthy old app blocks workers; a stopped app does not', async () => {
  const server = http.createServer((req, res) => res.writeHead(503).end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  assert.equal(await legacyRunning(url), true);
  await assert.rejects(assertCanRun(false, url), /Stop Bitcoin Lab/);
  await assertCanRun(true, url);
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  assert.equal(await legacyRunning(url), false);
});
