'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const peersService = require('../src/lib/peers-service');

test.beforeEach(() => peersService.reset());
test.after(() => { delete process.env.PEERS_HEALTH_URL; });

test('a peers service that answers 200 counts as up, and is asked once', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => { calls += 1; res.writeHead(200); res.end('ok\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await peersService.isUp(), true);
  // The dashboard polls every twenty seconds; a service that is up stays up,
  // so the answer is kept.
  assert.equal(await peersService.isUp(), true);
  assert.equal(calls, 1, 'the second call must come from the cache');

  await new Promise((r) => srv.close(r));
});

test('a peers service that is not there is silent, not an error', async () => {
  // Port 1 on loopback: nothing listens, the connection is refused at once.
  process.env.PEERS_HEALTH_URL = 'http://127.0.0.1:1/api/health';
  assert.equal(await peersService.isUp(), false);
});

test('a peers service that answers something other than 200 does not count', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await peersService.isUp(), false);
  await new Promise((r) => srv.close(r));
});

test('"off" switches the check off without asking anything', async () => {
  process.env.PEERS_HEALTH_URL = 'off';
  assert.equal(await peersService.isUp(), false);
});

test('two callers at once share one request', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls += 1;
    setTimeout(() => { res.writeHead(200); res.end('ok\n'); }, 30);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  const [a, b] = await Promise.all([peersService.isUp(), peersService.isUp()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(calls, 1, 'a second caller must join the request in flight');

  await new Promise((r) => srv.close(r));
});

test('a miss is asked again after thirty seconds, a hit only after five minutes', async (t) => {
  // After an update the peers service may still be starting when the dashboard asks.
  let up = false;
  let calls = 0;
  const srv = http.createServer((req, res) => { calls += 1; res.writeHead(up ? 200 : 503); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  assert.equal(await peersService.isUp(), false);
  up = true;
  t.mock.timers.tick(20_000);
  assert.equal(await peersService.isUp(), false, 'within thirty seconds the miss is kept');
  t.mock.timers.tick(11_000);
  assert.equal(await peersService.isUp(), true, 'after thirty seconds it is asked again');
  t.mock.timers.tick(60_000);
  assert.equal(await peersService.isUp(), true);
  assert.equal(calls, 2, 'a hit is kept for five minutes');

  await new Promise((r) => srv.close(r));
});

test("the peers service's word on every peer is read without waiting", async () => {
  let peerCalls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(200); return res.end('ok\n'); }
    peerCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ peers: [
      { addr: '198.51.100.1:8333', kind: 'Disguised', tell: 'no wtxidrelay' },
      { addr: '198.51.100.2:8333', kind: 'Pool node', pool: 'AtlasPool' },
      { addr: '198.51.100.3:8333', kind: 'Node (Core)' },
      { addr: '198.51.100.4:8333', kind: 'Wallet', label: 'Probably Wasabi Wallet', name: 'Wasabi', no_relay: true },
      { addr: '198.51.100.5:8333', kind: 'Disguised', tell: "on 0xB10C's list", linking_lion: true },
      { addr: '198.51.100.6:8333', kind: 'Node (Knots)', fork: 'BIP110 fork', label: 7 },
      { addr: 7, kind: 'Wallet' },
    ] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await peersService.isUp(), true);
  assert.equal(peersService.peerKinds().size, 0, 'the first call starts the fetch and does not wait for it');
  for (let i = 0; i < 50 && peersService.peerKinds().size === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  const marks = peersService.peerKinds();
  assert.equal(marks.size, 6, 'every peer with an address, not one without');
  assert.deepEqual(marks.get('198.51.100.1:8333'), { kind: 'Disguised' });
  assert.deepEqual(marks.get('198.51.100.2:8333'), { kind: 'Pool node' });
  assert.deepEqual(marks.get('198.51.100.3:8333'), { kind: 'Node (Core)' });
  assert.deepEqual(marks.get('198.51.100.4:8333'), { kind: 'Wallet', noRelay: true });
  assert.deepEqual(marks.get('198.51.100.5:8333'), { kind: 'Disguised', lion: true });
  assert.deepEqual(marks.get('198.51.100.6:8333'), { kind: 'Node (Knots)' }, 'only kind, no-relay and LinkingLion are taken');
  assert.equal(peerCalls, 1, 'within a minute the peers service is asked once');

  await new Promise((r) => srv.close(r));
});

test('without the peers service there are no marks, and its list is not asked for', async () => {
  let peerCalls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url !== '/api/health') peerCalls += 1;
    res.writeHead(503); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await peersService.isUp(), false);
  assert.equal(peersService.peerKinds().size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peerCalls, 0);
  process.env.PEERS_HEALTH_URL = 'off';
  assert.equal(peersService.peerKinds().size, 0);

  await new Promise((r) => srv.close(r));
});
