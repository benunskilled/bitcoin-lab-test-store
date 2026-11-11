'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('../scripts/migrate-peer-lab');

test('migration preserves committed WAL data, settings and history without overwriting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlab-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'old.db');
  const destination = path.join(dir, 'new', 'bitcoinlab.db');
  process.env.SQLITE_PATH = source;
  process.env.DATA_DIR = dir;
  process.env.LOG_LEVEL = 'error';
  const db = require('../src/lib/db');
  db.open();
  const original = db.instance;
  original.prepare("INSERT OR REPLACE INTO meta VALUES ('heartbeat:peer-profiler', 'running')").run();
  original.prepare("INSERT OR REPLACE INTO meta VALUES ('peer_rotation_enabled', '1')").run();
  original.prepare("INSERT OR REPLACE INTO meta VALUES ('stratum_race_enabled', '1')").run();
  original.prepare("INSERT INTO peer (address, first_seen_at) VALUES ('203.0.113.4:8333', 123)").run();
  original.prepare("INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('203.0.113.4:8333', 'Saved peer', 1, 123)").run();
  original.prepare("INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES ('abc', 100, 123)").run();
  original.prepare("INSERT INTO stratum_race (prevhash, created_at) VALUES ('def', 123)").run();
  original.prepare("INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('Own pool', 'pool.test', 3333, 1, 0, 123)").run();
  const snapshot = {};
  const tables = original.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) snapshot[name] = original.prepare(`SELECT * FROM "${name}"`).all();
  await assert.rejects(migrate(source, destination), /Stop Bitcoin Lab/);
  await migrate(source, destination, { confirmedStopped: true });
  const imported = new Database(destination, { readonly: true });
  for (const { name } of tables) {
    const expected = name === 'meta' ? snapshot[name].filter(row => !row.key.startsWith('heartbeat:')) : snapshot[name];
    assert.deepEqual(imported.prepare(`SELECT * FROM "${name}"`).all(), expected, name);
    assert.deepEqual(original.prepare(`SELECT * FROM "${name}"`).all(), snapshot[name], `source ${name} unchanged`);
  }
  assert.equal(imported.pragma('integrity_check', { simple: true }), 'ok');
  imported.close();
  await assert.rejects(migrate(source, destination, { confirmedStopped: true }), /already exists/);
  original.close();
  const invalid = path.join(dir, 'invalid.db');
  new Database(invalid).close();
  await assert.rejects(migrate(invalid, path.join(dir, 'bad.db'), { confirmedStopped: true }), /not a supported/);
  assert.equal(fs.existsSync(path.join(dir, 'bad.db')), false);
});
