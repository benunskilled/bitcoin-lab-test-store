'use strict';

// READ_ONLY=1 (a test copy beside the real app on the same node): nothing may
// change Core's peers - not the dashboard, not the rotation, not the
// background sync.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-ro-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.PEERS_HEALTH_URL = 'off';
process.env.READ_ONLY = '1';
// Nothing listens here: a call that reached Core would fail.
process.env.BITCOIN_RPC_HOST = '127.0.0.1';
process.env.BITCOIN_RPC_PORT = '9';

const config = require('../src/lib/config');
const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const peerRotation = require('../src/lib/peer-rotation');
const { server } = require('../src/dashboard-server');

let baseUrl;

test.before(async () => {
  db.open();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('config reads the read-only flag', () => {
  assert.equal(config.readOnly, true);
});

test('addnode and disconnectnode are never sent to Core', async () => {
  assert.equal(await rpc.addNode('203.0.113.5:8333', 'add'), null);
  assert.equal(await rpc.addNode('203.0.113.5:8333', 'remove'), null);
  assert.equal(await rpc.disconnectNode('203.0.113.5:8333'), null);
  assert.equal(await rpc.disconnectNode(7), null);
});

test('the rotation counts as off, whatever the database says', () => {
  peerRotation.setEnabled(true);
  assert.equal(peerRotation.isEnabled(), false);
});

test('every write route answers 403, the lock aside', async () => {
  for (const p of ['/api/peers/untrust', '/api/peers/manual-add', '/api/peers/add-manual', '/api/peers/disconnect',
    '/api/rotation/toggle', '/api/stratum/toggle', '/api/pools', '/api/reset', '/api/peers/probe']) {
    const { status, body } = await post(p, { address: '203.0.113.5:8333', enabled: true, scope: 'peers', host: 'pool.example', port: 3333, label: 'x' });
    assert.equal(status, 403, p);
    assert.match(body.error, /read-only/);
  }
  for (const method of ['PATCH', 'DELETE']) {
    const res = await fetch(`${baseUrl}/api/pools/1`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 403, `${method} /api/pools/1`);
  }
  // The lock only marks a row in this copy's own table.
  const keep = await post('/api/peers/keep', { address: '203.0.113.5:8333', kept: true });
  assert.notEqual(keep.status, 403);
});

test('/api/status tells the page it is read-only', async () => {
  const s = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(s.readOnly, true);
});
