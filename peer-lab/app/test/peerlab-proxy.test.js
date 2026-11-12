'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { proxyPeers } = require('../src/lib/peers-proxy');

test('the peers service stays same-origin, read-only, and never receives credentials', async (t) => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    if (req.url === '/moved') { res.writeHead(301, { Location: 'https://elsewhere.test/' }); return res.end(); }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = http.createServer((req, res) => {
    if (!proxyPeers(req, res, new URL(req.url, 'http://local'), target)) res.writeHead(404).end();
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); gateway.closeAllConnections(); gateway.close(); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  for (const path of ['/peers?peer=x', '/peers/']) {
    const redirect = await fetch(base + path, { redirect: 'manual' });
    assert.equal(redirect.status, 308, `${path} leads to the page`);
    assert.equal(redirect.headers.get('location'), '/');
  }
  const response = await fetch(base + '/peers/api/peers?peer=x', {
    headers: { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Forwarded-Host': 'evil.test' },
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(requests[0].url, '/api/peers?peer=x');
  for (const name of ['cookie', 'authorization', 'x-forwarded-host']) assert.equal(requests[0].headers[name], undefined);
  assert.equal((await fetch(base + '/peers/api/peers', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/peers/api/peerinfo')).status, 404, "Core's raw list is the profiler's, not the browser's");
  assert.equal(requests.length, 1);
  await fetch(base + '/peers//attacker.test/resource');
  assert.equal(requests[1].url, '//attacker.test/resource');
  assert.equal((await fetch(base + '/peers/moved', { redirect: 'manual' })).headers.get('location'), null, 'a redirect from inside is not passed on');
  upstream.closeAllConnections();
  await new Promise(r => upstream.close(r));
  assert.equal((await fetch(base + '/peers/api/peers')).status, 502);
});
