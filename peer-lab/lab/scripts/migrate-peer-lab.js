'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

// An offline, non-destructive import. The original is opened read-only and the
// SQLite backup API includes committed WAL pages. No blind copying of .db files.
async function migrate(source, destination, { confirmedStopped = false } = {}) {
  if (!confirmedStopped) throw new Error('Stop Bitcoin Lab and all Peer Lab services first; pass --confirm-stopped.');
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) throw new Error('Source and destination must be different.');
  if (fs.existsSync(destination) || fs.existsSync(destination + '-wal') || fs.existsSync(destination + '-shm')) {
    throw new Error('Destination already exists; refusing to overwrite Peer Lab data.');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + '.import-' + crypto.randomUUID();
  let original;
  let copy;
  try {
    original = new Database(source, { readonly: true, fileMustExist: true });
    if (original.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Source integrity check failed.');
    for (const table of ['meta', 'peer', 'trusted_peer', 'relay_race', 'stratum_pool', 'stratum_race']) {
      if (!original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error('Source is not a supported Bitcoin Lab database.');
      }
    }
    await original.backup(temporary);
    copy = new Database(temporary, { fileMustExist: true });
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Imported database integrity check failed.');
    // Runtime liveness is not history and must not make stopped workers look alive.
    copy.prepare("DELETE FROM meta WHERE key LIKE 'heartbeat:%'").run();
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
    copy.close(); copy = null;
    fs.chmodSync(temporary, 0o600);
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Atomic no-replace publication, even if another import raced this one.
    fs.linkSync(temporary, destination);
    const dir = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return { migrated: true };
  } finally {
    if (copy) copy.close();
    if (original) original.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(temporary + suffix, { force: true });
  }
}

if (require.main === module) {
  const [source, destination, confirmation] = process.argv.slice(2);
  if (!source || !destination || confirmation !== '--confirm-stopped') {
    console.error('Usage: node scripts/migrate-peer-lab.js SOURCE.db DESTINATION.db --confirm-stopped');
    process.exitCode = 1;
  } else {
    migrate(source, destination, { confirmedStopped: true }).then(() => {
      console.log('Migration verified. Original data unchanged. Start Peer Lab; keep Bitcoin Lab stopped.');
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { migrate };
