'use strict';

// The write-source check end to end: an HTTP write the check refuses must be
// answered 403 before anything else looks at it, and change nothing. Every
// request in a test comes from loopback, which the real check always lets
// through, so the test hands the server a check of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-wsrc-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.BITCOIN_RPC_HOST = '127.0.0.1';
process.env.BITCOIN_RPC_PORT = '9';
process.env.PEERS_HEALTH_URL = 'off';

const db = require('../src/lib/db');
const { makeWriteSource } = require('../src/lib/write-source');
const { server, setWriteSourceForTest } = require('../src/dashboard-server');

let baseUrl;
const seen = [];

// Umbrel 2.x as the real check sees it, with the request's address replaced
// by one from another app's container.
const realCheck = makeWriteSource({ gateway: '10.21.0.1', host: 'peerlab_app_proxy_1', lookup: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); } });
let from = '10.21.0.7';
const check = async (address) => { seen.push(address); return realCheck(from); };
check.describe = (address) => realCheck.describe(address);

test.before(async () => {
  db.open();
  setWriteSourceForTest(check);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const pools = () => db.instance.prepare(`SELECT COUNT(*) AS n FROM stratum_pool WHERE label = 'Outside'`).get().n;
const addPool = (headers = { 'Content-Type': 'application/json' }) => fetch(`${baseUrl}/api/pools`, {
  method: 'POST', headers, body: JSON.stringify({ label: 'Outside', host: 'pool.example', port: 3333 }),
});

test('a write from another container is refused and changes nothing', async () => {
  from = '10.21.0.7';
  const res = await addPool();
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only accepted through the app's own page/);
  assert.equal(pools(), 0);
  assert.ok(seen.length > 0 && /127\.0\.0\.1$/.test(seen.at(-1)), 'the check is given the socket address');
});

test('the source is checked before anything else about the write', async () => {
  // Without a JSON content type refuseWrite would answer 415; the outsider
  // must not learn even that.
  from = '10.21.0.7';
  const res = await addPool({ 'Content-Type': 'text/plain' });
  assert.equal(res.status, 403);
});

test('reads stay open to other containers', async () => {
  from = '10.21.0.7';
  const res = await fetch(`${baseUrl}/api/status`);
  assert.equal(res.status, 200);
});

test('a write through Umbrel\'s proxy (the gateway) goes through', async () => {
  from = '10.21.0.1';
  const res = await addPool();
  assert.equal(res.status, 200);
  assert.equal(pools(), 1);
});
