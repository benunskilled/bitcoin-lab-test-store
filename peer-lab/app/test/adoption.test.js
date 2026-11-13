'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-adoption-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.MAX_MANUAL_PEERS = '2';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const { adoptExternalManualPeers } = require('../src/lib/peer-sync');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  mock.restoreAll();
  db.instance.exec('DELETE FROM trusted_peer;');
});

const rows = () => db.instance.prepare(`SELECT address, kept FROM trusted_peer ORDER BY address`).all();

test('an addnode somebody else configured is adopted as protected', async () => {
  // A -addnode= line in bitcoin.conf, or a peer set in Umbrel's own settings:
  // a person chose it. Adopted unprotected, the rotation would later be free
  // to `addnode remove` it - undoing a choice this app never made.
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: '198.51.100.7:8333' }]);
  const result = await adoptExternalManualPeers();
  assert.equal(result.adopted, 1);
  assert.deepEqual(rows(), [{ address: '198.51.100.7:8333', kept: 1 }]);
});

test('adoption stops at the manual-peer limit and leaves the rest alone', async () => {
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('203.0.113.1:8333', NULL, 0, 1)`)
    .run();
  mock.method(rpc, 'getAddedNodeInfo', async () => [
    { addednode: '203.0.113.1:8333' },
    { addednode: '198.51.100.7:8333' },
    { addednode: '198.51.100.8:8333' },
    { addednode: '198.51.100.9:8333' },
  ]);
  const result = await adoptExternalManualPeers();
  assert.equal(result.adopted, 1, 'one free slot, one adoption');
  assert.equal(rows().length, 2, 'never more rows than MAX_MANUAL_PEERS');
  // Core's own list is handed on untouched; nothing was removed from it.
  assert.equal(result.addedNodes.length, 4);
});

test('the same node in another spelling is not adopted a second time', async () => {
  // Core echoes an addnode in the spelling it was given; the app had stored it
  // in another. Compared as strings they were two peers, and the echo became a
  // second row taking a second slot.
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('[2a01:4f8::1]:8333', NULL, 0, 1)`)
    .run();
  mock.method(rpc, 'getAddedNodeInfo', async () => [
    { addednode: '[2a01:4f8:0:0::1]:8333' },
    { addednode: '2A01:4F8::1' },
  ]);
  const result = await adoptExternalManualPeers();
  assert.equal(result.adopted, 0);
  assert.deepEqual(rows(), [{ address: '[2a01:4f8::1]:8333', kept: 0 }]);
});

test('adding a node that is already a manual peer under another spelling takes no second slot', async () => {
  const { addTrustedPeer } = require('../src/lib/peer-sync');
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('[2a01:4f8::1]:8333', NULL, 0, 1)`)
    .run();
  mock.method(rpc, 'getPeerInfo', async () => []);
  const calls = [];
  mock.method(rpc, 'addNode', async (a, c) => { calls.push(`${c} ${a}`); });
  const result = await addTrustedPeer('[2a01:4f8:0:0::1]:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /already a manual peer/);
  assert.equal(rows().length, 1);
  assert.deepEqual(calls, []);
});

test('a peer the app dropped while Core refused the remove is removed again, not adopted back', async () => {
  const peerSync = require('../src/lib/peer-sync');
  db.instance.prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('198.51.100.30:8333', NULL, 0, 1)`).run();
  const calls = [];
  mock.method(rpc, 'addNode', async (a, c) => { calls.push(`${c} ${a}`); throw new Error('RPC addnode: timed out'); });
  mock.method(rpc, 'disconnectNode', async () => {});
  await peerSync.removeTrustedPeer('198.51.100.30:8333');
  assert.deepEqual(rows(), []);

  // Next sync: Core still lists it. It must not come back as a protected peer.
  mock.restoreAll();
  const retried = [];
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: '198.51.100.30:8333' }]);
  mock.method(rpc, 'addNode', async (a, c) => { retried.push(`${c} ${a}`); });
  const result = await peerSync.adoptExternalManualPeers();
  assert.equal(result.adopted, 0);
  assert.deepEqual(rows(), []);
  assert.deepEqual(retried, ['remove 198.51.100.30:8333']);
  db.instance.exec(`DELETE FROM meta WHERE key = 'pending_addnode_removal'`);
});

test('a read-only copy mirrors Core: a manual peer Core dropped leaves, a new one gets its slot', async () => {
  // The test-store copy never removes anything itself, so without this its
  // table only grew: removed peers stayed as offline manuals, and once the
  // limit was full the new ones were never adopted at all.
  const config = require('../src/lib/config');
  const insert = db.instance.prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 0, 1)`);
  insert.run('203.0.113.1:8333');
  insert.run('203.0.113.2:8333');
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: '203.0.113.2:8333' }, { addednode: '198.51.100.7:8333' }]);
  config.readOnly = true;
  try {
    const result = await adoptExternalManualPeers();
    assert.equal(result.adopted, 1);
    assert.deepEqual(rows().map((r) => r.address), ['198.51.100.7:8333', '203.0.113.2:8333']);
  } finally {
    config.readOnly = false;
  }
});

test('a read-only copy sends no addnode of its own, even past the RPC guard', async () => {
  // rpc.js refuses addnode in a read-only copy already. These two paths
  // decide not to ask at all: a remove still pending from before, and the
  // restore of a peer Core has forgotten.
  const config = require('../src/lib/config');
  const peerSync = require('../src/lib/peer-sync');
  db.instance.prepare(`INSERT INTO meta (key, value) VALUES ('pending_addnode_removal', ?)`)
    .run(JSON.stringify({ '198.51.100.31:8333': Date.now() }));
  db.instance.prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('203.0.113.9:8333', NULL, 0, 1)`).run();
  const sent = [];
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: '198.51.100.31:8333' }]);
  mock.method(rpc, 'addNode', async (a, c) => { sent.push(`${c} ${a}`); });
  config.readOnly = true;
  try {
    const { addedNodes } = await adoptExternalManualPeers();
    await peerSync.syncTrustedToAddnode(addedNodes);
    await peerSync.syncTrustedToAddnode([]);
    assert.deepEqual(sent, []);
  } finally {
    config.readOnly = false;
    db.instance.exec(`DELETE FROM meta WHERE key = 'pending_addnode_removal'`);
  }
});

test('the real app keeps a manual peer Core has forgotten (it re-adds it after a Core restart)', async () => {
  db.instance.prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('203.0.113.1:8333', NULL, 0, 1)`).run();
  mock.method(rpc, 'getAddedNodeInfo', async () => []);
  const sent = [];
  mock.method(rpc, 'addNode', async (a, c) => { sent.push(`${c} ${a}`); });
  const { addedNodes } = await adoptExternalManualPeers();
  assert.deepEqual(rows().map((r) => r.address), ['203.0.113.1:8333']);
  await require('../src/lib/peer-sync').syncTrustedToAddnode(addedNodes);
  assert.deepEqual(sent, ['add 203.0.113.1:8333'], 'and the sync hands it back to Core');
});

// Remove runs in the dashboard, adoption in the profiler: two processes. A
// mark kept in one process's memory is never seen by the other, so the mark
// must live in the database. Here a second copy of peer-sync stands in for
// the dashboard and removes the peer while the adoption is asking Core.
test('a peer removed by hand in the other process is not adopted back', async () => {
  const X = '198.51.100.7:8333';
  db.instance.prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 0, 1)`).run(X);
  const sync = require.resolve('../src/lib/peer-sync');
  const profilerCopy = require(sync);
  delete require.cache[sync];
  const dashboardCopy = require(sync);
  delete require.cache[sync];
  require.cache[sync] = { id: sync, filename: sync, loaded: true, exports: profilerCopy };
  let coreList = [{ addednode: X }];
  mock.method(rpc, 'getPeerInfo', async () => []);
  mock.method(rpc, 'addNode', async (a, cmd) => { if (cmd === 'remove') coreList = coreList.filter((n) => n.addednode !== a); });
  mock.method(rpc, 'getAddedNodeInfo', async () => {
    const before = coreList.slice();
    await dashboardCopy.removeTrustedPeer(X);
    return before;
  });
  await profilerCopy.adoptExternalManualPeers();
  mock.restoreAll();
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0, 'the removed peer stays removed');
});
