'use strict';

// Runs both real HTTP modules against synthetic data, with no Bitcoin RPC or
// worker processes. Build the Go binary and set PEERS_BINARY first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// The page in a real browser, both scripts together: the peer list drawn,
// the tiles counting the same peers, a card folding with a tap anywhere and
// opening with the keyboard, Esc closing one thing, and no script error.
// Needs Playwright with Chromium (CI installs both; SMOKE_BROWSER=1).
async function browserSmoke(base, peers) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const errors = [];
  try {
    for (const width of [1400, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on('pageerror', (e) => errors.push(`${width}px: ${e.message}`));
      await page.goto(base + '/');
      await page.waitForSelector('#tables tr[data-anchor]', { timeout: 20000 });
      const groups = { inbound: 0, outbound: 0, manual: 0 };
      for (const p of peers.peers) groups[p.group] += 1;
      const tiles = await page.$$eval('#live-stats .stat .n', (ns) => ns.map((n) => Number(n.textContent)));
      assert.deepEqual(tiles.slice(1), [groups.inbound, groups.outbound, groups.manual], `${width}px: the tiles count the list's peers`);
      const folded = () => page.$eval('#keyCard', (c) => c.classList.contains('folded'));
      if (await folded()) {
        await page.focus('#keyHead .fold-btn');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(700);
        assert.equal(await folded(), false, `${width}px: Enter on its title opens the card`);
      }
      // Not the title: the list inside the card.
      await page.click('#keyCard .key-list li:nth-child(2)');
      await page.waitForTimeout(700);
      assert.equal(await folded(), true, `${width}px: a tap inside the card folds it`);
      await page.click('#keyCard', { position: { x: 300, y: 20 } });
      await page.waitForTimeout(700);
      assert.equal(await folded(), false, `${width}px: and a tap on the folded card opens it`);
      await page.click('#storage-card > summary');
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#storage-card', (d) => d.open), false, `${width}px: Esc closes Data`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width}px: nothing slides sideways (${overflow}px)`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(errors, [], 'no script error on the page');
  console.log('Peer Lab browser smoke test passed.');
}

async function main() {
  if (!process.env.PEERS_BINARY) throw new Error('Set PEERS_BINARY to the built map binary.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-smoke-'));
  process.env.DATA_DIR = temporary;
  process.env.SQLITE_PATH = path.join(temporary, 'sqlite', 'peerlab.db');
  process.env.READ_ONLY = '1';
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
    process.env.PEERS_URL = `http://127.0.0.1:${port}`;
    process.env.PEERS_HEALTH_URL = `http://127.0.0.1:${port}/api/health`;
    child = spawn(process.env.PEERS_BINARY, [], {
      env: { ...process.env, PEERS_DEMO: '1', PEERS_PORT: String(port), DASHBOARD_HEALTH_URL: base + '/api/health' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { ready = (await fetch(base + '/peers/app.js')).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'the peers service answers through the page origin');
    const overview = await (await fetch(base)).text();
    assert.match(overview, /<h1>Peer Lab<\/h1>/);
    for (const anchor of ['mapCard', 'tables', 'slot-fill', 'stratum-race', 'storage-card']) {
      assert.ok(overview.includes(`id="${anchor}"`), anchor);
    }
    const peers = await (await fetch(base + '/peers/api/peers')).json();
    assert.ok(peers.peers.length > 0, 'the peers service returns its demo peers');
    for (const resource of ['/app.js', '/style.css', '/favicon.png', '/peers/app.js', '/peers/world.json', '/api/widget/traffic']) {
      assert.equal((await fetch(base + resource)).status, 200, resource);
    }
    // What the service answers the dashboard and the profiler is not passed on:
    // the page loads only its script, its map and its peer list from there.
    for (const internal of ['/peers/api/peerinfo', '/peers/api/kinds', '/peers/api/health']) {
      assert.equal((await fetch(base + internal)).status, 404, internal);
    }
    // /peers/ is no page of its own: it leads to the page.
    const redirect = await fetch(base + '/peers/', { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/');
    console.log('Peer Lab cross-module HTTP smoke test passed. No live node or peer writes used.');
    if (process.env.SMOKE_BROWSER === '1') await browserSmoke(base, peers);
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
