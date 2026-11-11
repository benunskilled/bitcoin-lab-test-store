'use strict';

// Runs both real HTTP modules against synthetic data, with no Bitcoin RPC or
// worker processes. Build the Go binary and set PEERLAB_MAP_BINARY first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function main() {
  if (!process.env.PEERLAB_MAP_BINARY) throw new Error('Set PEERLAB_MAP_BINARY to the built map binary.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-smoke-'));
  process.env.DATA_DIR = temporary;
  process.env.SQLITE_PATH = path.join(temporary, 'sqlite', 'bitcoinlab.db');
  process.env.LAB_READ_ONLY = '1';
  process.env.LOG_LEVEL = 'error';
  const db = require('../src/lib/db');
  const { server } = require('../src/dashboard-server');
  let child;
  try {
    db.open();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const portProbe = net.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    process.env.PEERLAB_MAP_URL = `http://127.0.0.1:${port}`;
    process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${port}/api/health`;
    child = spawn(process.env.PEERLAB_MAP_BINARY, [], {
      env: { ...process.env, PEERMAP_MOCK: '1', PEERMAP_PORT: String(port), PEERMAP_SIBLING_HEALTH_URL: base + '/api/health' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { ready = (await fetch(base + '/map/api/health')).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'map starts through the unified origin');
    const overview = await (await fetch(base)).text();
    assert.match(overview, /<h1>Peer Lab<\/h1>/);
    for (const anchor of ['live-peer-card', 'slot-fill', 'stratum-race', 'storage-card']) {
      assert.ok(overview.includes(`id="${anchor}"`), anchor);
    }
    const map = await (await fetch(base + '/map/')).text();
    assert.match(map, /<h1>Peer Lab<\/h1>/);
    const peers = await (await fetch(base + '/map/api/peers')).json();
    assert.ok(peers.peers.length > 0, 'real map module returns mock peers');
    assert.equal(peers.sibling, true, 'map can reach the integrated measurement module');
    for (const resource of ['/peerlab.js', '/peerlab.css', '/map/app.js', '/map/style.css', '/map/world.json', '/api/widget/traffic']) {
      assert.equal((await fetch(base + resource)).status, 200, resource);
    }
    assert.match(await (await fetch(base + '/app.js')).text(), /const base = '\/map\/'/);
    assert.match(await (await fetch(base + '/map/app.js')).text(), /const base = "\/"/);
    console.log('Peer Lab cross-module HTTP smoke test passed. No live node or peer writes used.');
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('close', resolve));
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (db.instance) db.instance.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
