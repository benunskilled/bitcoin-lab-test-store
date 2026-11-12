'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const peersService = require('../src/lib/peers-service');

// The profiler's copy of Core's peer list, fetched from a real HTTP server:
// whatever goes wrong, the answer is null and the profiler asks Core itself.
test('peerInfo hands on a good answer and turns every bad one into null', async (t) => {
  let reply = () => ({ status: 200, body: '' });
  const server = http.createServer((req, res) => {
    const r = reply(req);
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(r.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const old = process.env.PEERS_URL;
  process.env.PEERS_URL = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => { server.close(); process.env.PEERS_URL = old; });

  const at = Date.now() - 4000;
  let path = '';
  reply = (req) => { path = req.url; return { status: 200, body: JSON.stringify({ at_ms: at, result: [{ id: 3, addr: '198.51.100.4:8333' }] }) }; };
  const good = await peersService.peerInfo();
  assert.equal(path, '/api/peerinfo');
  assert.deepEqual(good, { peers: [{ id: 3, addr: '198.51.100.4:8333' }], atMs: at });

  reply = () => ({ status: 200, body: JSON.stringify({ at_ms: Date.now() + 3600e3, result: [] }) });
  const future = await peersService.peerInfo();
  assert.ok(Math.abs(future.atMs - Date.now()) < 1000, 'a time from the future is replaced by now');

  for (const bad of [{ status: 503, body: 'no fresh answer' }, { status: 200, body: '{not json' }, { status: 200, body: '{"result":{}}' }]) {
    reply = () => bad;
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await peersService.peerInfo(), null, JSON.stringify(bad));
  }

  process.env.PEERS_URL = 'off';
  assert.equal(await peersService.peerInfo(), null, 'switched off');
  server.close();
  process.env.PEERS_URL = `http://127.0.0.1:${server.address() ? server.address().port : 1}`;
  assert.equal(await peersService.peerInfo(), null, 'nobody listening');
});
