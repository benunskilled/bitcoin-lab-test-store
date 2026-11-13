'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./logger').make('db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,   -- ip:port, as reported by Bitcoin Core
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS peer_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id INTEGER NOT NULL REFERENCES peer(id),
  core_peer_id INTEGER,           -- Bitcoin Core's own transient peer "id" for this session
  direction TEXT NOT NULL,        -- inbound | outbound
  connection_type TEXT NOT NULL,  -- manual | outbound-full-relay | block-relay-only | inbound | feeler | addr-fetch
  -- Core's own name for the network this connection runs over: ipv4 | ipv6 |
  -- onion | i2p | cjdns | not_publicly_routable. Taken from getpeerinfo rather
  -- than guessed from the address, because the address does not carry it: an
  -- inbound Tor peer arrives from the local Tor proxy and shows up under that
  -- proxy's plain IPv4 address. Guessing from the string classified those as
  -- ordinary local peers. NULL on rows written before this column existed.
  network TEXT,
  subver TEXT,
  -- What the peer said about itself in its version message, and what Core
  -- has learned about its chain since. Recorded, not yet acted on.
  --
  -- A peer that offers no services at all, refuses transactions, and whose
  -- chain Core never learns is not a node that can hand us a block - it is
  -- something else holding a connection open. Today such a peer counts as
  -- eligible for every race exactly like a full node, which quietly inflates
  -- the number every ranking is measured against. Whether that should change
  -- is a question for data, not for an argument, so this writes the three
  -- fields down and changes nothing else.
  --
  -- services: Core's servicesnames, comma-joined. '' means NODE_NONE - the
  -- peer advertises nothing. NULL means Core did not report the field.
  services TEXT,
  -- relay_txes: the version message's fRelay. 0 means "send me no
  -- transactions". NULL for rows written before this column existed.
  relay_txes INTEGER,
  -- synced_headers: overwritten on every poll, unlike the two above which are
  -- fixed for the life of a connection. -1 means Core has never seen a header
  -- from this peer and has no idea what chain it is on.
  synced_headers INTEGER,
  -- hb_to: Core's bip152_hb_to - whether Core has picked this peer as one of
  -- its (at most three) high-bandwidth compact-block peers, which send a new
  -- block straight away instead of announcing it first. Overwritten on every
  -- poll; it changes whenever another peer delivers a block first. NULL for
  -- rows written before this column existed, or when Core did not report it.
  hb_to INTEGER,
  -- hb_from: Core's bip152_hb_from - the other way round: this peer has picked
  -- this node as one of its own high-bandwidth peers, so Core sends it a new
  -- block straight away. Overwritten on every poll like hb_to; no history.
  hb_from INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  min_ping_ms REAL,
  last_ping_ms REAL
);
-- No standalone index on peer_session(peer_id): idx_peer_session_open below
-- starts with the same column, so SQLite already uses it for a plain
-- peer_id lookup. A second copy only cost write amplification on one of the
-- two busiest tables in the schema.
CREATE INDEX IF NOT EXISTS idx_peer_session_open ON peer_session(peer_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_peer_session_peer_started ON peer_session(peer_id, started_at DESC);
-- Partial index over just the currently-open sessions. liveSummary() runs
-- a WHERE ended_at IS NULL filter on every /api/status poll and on every
-- widget refresh; without this it scanned the whole (permanently growing)
-- session table just to count a few dozen live rows.
CREATE INDEX IF NOT EXISTS idx_peer_session_live
  ON peer_session(peer_id, direction, connection_type) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS trusted_peer (
  address TEXT PRIMARY KEY,
  label TEXT,
  -- Set by hand: this peer stays, whatever the measurement says. The rotation
  -- neither displaces it for a better candidate nor retires it when it goes
  -- offline - the two ways a manual peer can otherwise lose its slot. It is
  -- the default for anything added by hand, because typing an address in is
  -- already the decision; a promotion by the rotation itself is not, and
  -- arrives unset, or the loop would freeze itself out of every slot it filled.
  kept INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Parking went with the old rotation (11.11.2026): an install from before
-- then still has the empty table.
DROP TABLE IF EXISTS parked_peer;

-- Address-book candidates the slot fill has put to Core, and whether Core
-- connected to them. One that did not is left alone for a week; the rows are
-- dropped after a month. The candidate on trial right now is in meta
-- (slot_fill_trial), as one JSON value. Per address, the last trial: why it
-- ended (ok, no_connection, no_services, height_unknown, height_wrong,
-- disguised; removed for one taken out by hand; offline for one retired), when
-- it began, and the network (clearnet, tor, i2p) - what the app log said, kept
-- where a restart does not take it.
CREATE TABLE IF NOT EXISTS slot_fill_tried (
  address TEXT PRIMARY KEY,
  tried_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT,
  started_at INTEGER,
  network TEXT
);

CREATE TABLE IF NOT EXISTS relay_race (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_hash TEXT NOT NULL UNIQUE,
  block_height INTEGER,
  detected_at INTEGER NOT NULL,  -- ms since epoch, derived from the hrtime capture
  -- What block attribution saw: how many peers were credited, and the signed
  -- distance from the detection instant to the closest last_block any peer
  -- reported (about -5000 every time on a node whose Core clock is 5 s behind).
  first_count INTEGER,
  nearest_delta_ms INTEGER,
  -- The block's route: when Core had a new template ready after it, the
  -- delivering peer's ping, and how many transactions the template carried.
  template_ms REAL,
  first_ping_ms REAL,
  template_tx INTEGER,
  -- Who mined it, from the coinbase (lib/pool-id.js). pool_source NULL means
  -- not looked at yet, 'none' that the block says nothing.
  pool_name TEXT,
  pool_tag TEXT,
  pool_source TEXT,
  -- How Core rebuilt it from its compact form (reconstruction.js), the bytes
  -- it had to ask for, and its size.
  recon TEXT,
  recon_missing_bytes INTEGER,
  block_size INTEGER,
  -- Whether the delivering peer was high-bandwidth in the poll before it.
  first_hb INTEGER
);

CREATE TABLE IF NOT EXISTS relay_observation (
  race_id INTEGER NOT NULL REFERENCES relay_race(id),
  peer_id INTEGER NOT NULL REFERENCES peer(id),
  -- Always 1, and read by nothing: the presence of the row IS the
  -- eligibility, which is why peer_relay_stats counts rows rather than
  -- summing this. Kept because dropping a column would rewrite a table that
  -- holds millions of rows on a long-lived node, for no gain.
  eligible INTEGER NOT NULL DEFAULT 1,
  first INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, peer_id)
);
-- peer_id first, but never for a query: nothing reads relay_observation by
-- peer alone, and an index that only said (peer_id) was actively harmful -
-- SQLite preferred it for recentRelayStats()'s GROUP BY and walked the entire
-- history to answer a question about the last 500 blocks. Measured on two
-- million observations: 3.7s that way, 32ms as a race_id range search.
--
-- What does need it is the foreign key. relay_observation.peer_id REFERENCES
-- peer(id), so every row DELETE FROM peer removes has to prove no observation
-- points at it, and without an index whose leftmost column is peer_id that
-- proof is a full scan of this table - per deleted peer. The daily prune drops
-- the feeler peers Core churns through by the hundred, which at two million
-- rows took 25 seconds of exclusive write lock, well past the 10s busy_timeout
-- every other process is waiting on, and growing with the history.
--
-- race_id and first ride along so the index can answer the window aggregate on
-- its own if the planner ever reaches for it again; recentRelayStats() pins
-- itself to the primary key regardless (see queries/peer-ranking.js).
CREATE INDEX IF NOT EXISTS idx_relay_obs_peer_race ON relay_observation(peer_id, race_id, first);
-- Partial on purpose: one row per block rather than one per peer per block,
-- which is the difference between 2,208 rows and 415,490 on a node with a
-- fortnight of history. Counting the blocks that credited more than one peer
-- goes from 104 ms to 0.26 ms, which is what makes it affordable on a status
-- poll; the index itself cost 18 ms to build and 28 KB on that same node.
CREATE INDEX IF NOT EXISTS idx_relay_obs_first ON relay_observation(race_id) WHERE first = 1;

-- Running per-peer totals over relay_observation, maintained incrementally by
-- the relay profiler as each race is recorded.
--
-- relay_observation itself is never time-pruned (it IS the long-term ranking
-- data - see config.js), which is right, but it also means it grows without
-- bound: roughly one row per connected peer per block, so a node holding ~50
-- connections accumulates millions of rows a year. peerRanking() used to
-- GROUP BY across that entire table twice on every single poll, so the cost
-- of the main dashboard query grew linearly with the app's own lifetime.
-- Keeping the raw rows and reading one summary row per peer gives identical
-- numbers at constant cost.
CREATE TABLE IF NOT EXISTS peer_relay_stats (
  peer_id INTEGER PRIMARY KEY REFERENCES peer(id),
  eligible INTEGER NOT NULL DEFAULT 0,
  first INTEGER NOT NULL DEFAULT 0
);

-- The rollup is maintained by the database itself rather than by the writer.
-- A summary table that some code path forgets to update is worse than no
-- summary at all - it is wrong data that looks authoritative - and
-- relay_observation is written from the relay profiler and from tests. With
-- these triggers the invariant
--   peer_relay_stats == SELECT peer_id, COUNT(*), SUM(first) FROM relay_observation
-- holds by construction, in the same transaction as the row itself.
CREATE TRIGGER IF NOT EXISTS trg_relay_observation_insert
AFTER INSERT ON relay_observation
BEGIN
  INSERT INTO peer_relay_stats (peer_id, eligible, first)
  VALUES (NEW.peer_id, 1, NEW.first)
  ON CONFLICT(peer_id) DO UPDATE SET
    eligible = peer_relay_stats.eligible + 1,
    first = peer_relay_stats.first + NEW.first;
END;

CREATE TRIGGER IF NOT EXISTS trg_relay_observation_delete
AFTER DELETE ON relay_observation
BEGIN
  UPDATE peer_relay_stats
     SET eligible = eligible - 1, first = first - OLD.first
   WHERE peer_id = OLD.peer_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_relay_observation_update
AFTER UPDATE OF first ON relay_observation
BEGIN
  UPDATE peer_relay_stats
     SET first = first - OLD.first + NEW.first
   WHERE peer_id = NEW.peer_id;
END;

CREATE TABLE IF NOT EXISTS stratum_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(host, port)
);

CREATE TABLE IF NOT EXISTS stratum_race (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prevhash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stratum_observation (
  race_id INTEGER NOT NULL REFERENCES stratum_race(id),
  pool_id INTEGER NOT NULL REFERENCES stratum_pool(id),
  latency_ms REAL,               -- NULL = miss (no notify within the race timeout)
  rank INTEGER,
  PRIMARY KEY (race_id, pool_id)
);
-- (pool_id, latency_ms) also serves every plain pool_id lookup, so there is
-- no separate index on pool_id alone. It was built for the median/P90
-- lookups (gone since 04.11.2026) and is kept: the plain pool_id lookups
-- still need an index, and this one is already on every install.
CREATE INDEX IF NOT EXISTS idx_stratum_obs_pool_latency ON stratum_observation(pool_id, latency_ms);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Audit trail for the manual slots (src/lib/peer-rotation/log.js): a peer
-- the slot fill added or retired, and one added or disconnected by hand, so
-- the dashboard can show what changed without the user having to dig through
-- container logs. Trimmed to its last thirty rows on every write, never by
-- age. (The name is from the rotation it used to log.)
CREATE TABLE IF NOT EXISTS rotation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,             -- promote | retire | manual | disconnect
  address TEXT NOT NULL,
  first_pct REAL,
  eligible INTEGER,
  replaced_address TEXT,            -- the peer a manual add pushed out
  replaced_first_pct REAL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_rotation_log_at ON rotation_log(at DESC);

-- Every IP the rotation has ever made manual, one row each, forever.
--
-- rotation_log cannot answer "how many peers were ever promoted": it is
-- trimmed to the last thirty actions on every write, so the count silently
-- shrinks as the loop keeps working. This table is the durable half of that
-- question and nothing else - no percentages, no timestamps beyond the first,
-- because the peer's own record already lives in peer_relay_stats.
--
-- Keyed by IP rather than by address on purpose. A promoted inbound peer joins
-- under its listening port, so the same host appears once as 203.0.113.5:51234
-- and again as 203.0.113.5:8333; counting addresses would count it twice. The
-- primary key makes the de-duplication a property of the schema rather than
-- something every reader has to remember - but only as far as every writer
-- spells a host the same way. There is exactly one spelling, the bare host
-- that address.js's hostFromAddress returns, so an
-- IPv6 peer is 2001:db8::5 here and never [2001:db8::5].
CREATE TABLE IF NOT EXISTS promoted_peer (
  ip TEXT PRIMARY KEY,
  first_promoted_at INTEGER NOT NULL
);

-- The node's traffic per UTC day (see lib/traffic.js).
CREATE TABLE IF NOT EXISTS traffic_day (
  day  TEXT PRIMARY KEY,
  recv INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0
);
`;

// label, host, port - sourced from public solo-pool directories (Aug 2026).
// Purely a starting point: every row is a normal stratum_pool row the user
// can disable or delete like any other, nothing is special-cased in code.
const DEFAULT_POOLS = [
  ['AtlasPool', 'solo.atlaspool.io', 3333],
  ['EU CKPool', 'eusolo.ckpool.org', 3333],
  ['Braiins Solo', 'solo.stratum.braiins.com', 3333],
  ['SoloHash DE', 'solo-de.solohash.co.uk', 3333],
  ['SoloMining.de', 'pool.solomining.de', 3333],
  ['Satoshi Radio', 'pool.satoshiradio.nl', 3333],
  ['2Miners Solo BTC', 'solo-btc.2miners.com', 2323],
  ['Parasite Pool', 'parasite.wtf', 42069],
];

// A VACUUM is only worth its exclusive lock if this share of the file is
// actually free space waiting to be reclaimed.
const VACUUM_MIN_FREE_FRACTION = 0.1;

let db;

/**
 * SQLITE_BUSY in any of its forms - "database is locked", BUSY_SNAPSHOT,
 * BUSY_RECOVERY. better-sqlite3 puts the extended code on `code`.
 */
function isBusy(err) {
  return /^SQLITE_BUSY/.test(String(err && err.code)) || /database is locked/.test(String(err && err.message));
}

// A short synchronous pause: open() is synchronous and runs before anything
// else in the process, so there is nothing else to let run in the meantime.
function pauseMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Open the shared database, and on a fresh install keep trying while the
 * other three processes set it up.
 *
 * All four open the same new file in the same second. busy_timeout covers
 * most of what follows, but not all of it: the very first switch to WAL, and
 * a read transaction asked to upgrade after another process wrote, can still
 * answer "database is locked" at once - on GitHub's Linux runners 2 of 60
 * processes in test/first-start.test.js did, where macOS showed none. Every
 * step here is idempotent (CREATE ... IF NOT EXISTS, INSERT OR IGNORE
 * seeding), so the whole setup is simply run
 * again on a fresh connection a moment later, up to about half a minute.
 */
function open() {
  if (db) return db;
  const dir = path.dirname(config.sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      return openOnce();
    } catch (err) {
      try {
        if (db) db.close();
      } catch {
        // the connection is being thrown away either way
      }
      db = null;
      if (!isBusy(err) || attempt >= 40) throw err;
      logger.debug('database busy while setting up, trying again', { attempt, error: err.message });
      pauseMs(100 + Math.floor(Math.random() * 400));
    }
  }
}

function openOnce() {
  db = new Database(config.sqlitePath);
  // First, before anything that takes a lock. On a fresh install all four
  // processes open this file at the same moment, and switching it to WAL is
  // itself a write: with the timeout still at its default of zero, the
  // losers of that race failed with SQLITE_BUSY and the process died on its
  // first boot. Why ten seconds is explained below.
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Four separate processes (dashboard, peer-profiler, relay-profiler,
  // stratum-race) each hold their OWN connection to this same file. WAL
  // mode lets them read concurrently, but a writer can still briefly block
  // another writer - and since v1.9.0, peer-profiler's daily retention
  // prune (a multi-statement transaction) and its weekly VACUUM hold a
  // write lock far longer than the single-row inserts every other process
  // normally does. Without a busy_timeout, any OTHER connection's write
  // that lands during that window fails immediately with SQLITE_BUSY
  // instead of just waiting the (usually well under a second) for it to
  // clear - for stratum-race.js specifically, an unhandled failure there
  // used to crash the whole process, silently dropping every pool
  // connection and losing in-flight race data (see stratum-race.js). This
  // makes every connection wait up to 10s and retry instead - the timeout
  // set at the top of this function.
  db.exec(SCHEMA);
  seedDefaultPools();
  logger.info('database ready', { path: config.sqlitePath });
  return db;
}

function seedDefaultPools() {
  const already = db.prepare(`SELECT value FROM meta WHERE key = 'pools_seeded'`).get();
  if (already) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 1, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    // Re-check inside the transaction: all four processes call open() at once, and on a fresh
    // install all four read "not seeded yet". meta.key is a PRIMARY KEY, so
    // without this the losers of that race threw SQLITE_CONSTRAINT_PRIMARYKEY
    // straight out of open() and died on first boot - the relay profiler
    // included, whose downtime is the one thing that cannot be reconstructed
    // afterwards.
    const raced = db.prepare(`SELECT value FROM meta WHERE key = 'pools_seeded'`).get();
    if (raced) return false;
    for (const [label, host, port] of DEFAULT_POOLS) insert.run(label, host, port, now);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('pools_seeded', '1')`).run();
    return true;
  });
  // IMMEDIATE: the write lock is taken up front. A deferred transaction reads
  // the flag first and only then asks to write, and when another process
  // committed in between, SQLite refuses the upgrade at once with
  // SQLITE_BUSY_SNAPSHOT - no busy_timeout applies to that.
  if (tx.immediate()) logger.info('seeded default stratum pools', { count: DEFAULT_POOLS.length });
}

// Held for the life of the process rather than compiled per call. This is on
// two hot paths - once per connected peer per 15-second poll, and once per
// connected peer inside the relay profiler's per-block write transaction - so
// at ~200 peers it was compiling 400 statements every poll. Measured: the peer
// poll went 4.58ms -> 1.45ms and the block write transaction 8.25ms -> 4.00ms,
// which is time this process holds the write lock against the other three.
//
// Lazily initialised because `db` does not exist until open() runs. Reading
// first is deliberate: after the first sighting of a peer the row is always
// already there, so the common path is a single indexed SELECT and no write.
let getPeerStmt = null;
let insertPeerStmt = null;
function getOrCreatePeer(address) {
  if (!getPeerStmt) {
    getPeerStmt = db.prepare(`SELECT * FROM peer WHERE address = ?`);
    insertPeerStmt = db.prepare(`INSERT OR IGNORE INTO peer (address, first_seen_at) VALUES (?, ?)`);
  }
  const existing = getPeerStmt.get(address);
  if (existing) return existing;
  insertPeerStmt.run(address, Date.now());
  return getPeerStmt.get(address);
}

// DELETEs (queries.pruneOldData) free up rows but SQLite never shrinks the
// file on disk for them on its own - only VACUUM actually reclaims that
// space. VACUUM briefly needs up to ~2x the file's current size and
// rewrites the whole thing, so it's throttled to at most once a week
// (tracked in `meta`) rather than run after every prune - the DB stays
// small enough at this app's scale that a weekly rewrite is unnoticeable,
// but there's no reason to pay that I/O cost daily for no extra benefit.
const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
function maybeVacuum() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_vacuum_at'`).get();
  const last = row ? Number(row.value) : 0;
  if (Date.now() - last < VACUUM_INTERVAL_MS) return false;

  // A calendar is the wrong trigger for this. VACUUM rewrites the entire file
  // under an exclusive lock, and this file is append-only in every way that
  // matters: relay_observation and relay_race are deliberately never pruned
  // (they ARE the ranking), so the only deletions are transient peer sessions
  // and expired stratum history - a rounding error against the relay data.
  // Measured on a year-old database: freelist_count was 0, and the VACUUM took
  // eleven seconds on NVMe to reclaim nothing. On the SD or USB storage an
  // Umbrel usually runs on, considerably longer.
  //
  // That matters beyond wasted I/O. The exclusive lock outlasts the 10s
  // busy_timeout that db.js sets *because of* this VACUUM, so a block landing
  // inside the window loses its race - the one kind of data this app cannot
  // reconstruct. Ask the file whether there is anything to reclaim instead,
  // which makes this a no-op in the normal case and lets it run after an
  // unusually large prune, the only case it was ever for.
  const freePages = db.pragma('freelist_count', { simple: true });
  const totalPages = db.pragma('page_count', { simple: true });
  if (!totalPages || freePages / totalPages < VACUUM_MIN_FREE_FRACTION) {
    // Still stamp it, so this check runs weekly rather than on every prune.
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(Date.now()));
    logger.debug('skipped VACUUM - nothing worth reclaiming', { freePages, totalPages });
    return false;
  }
  logger.info('running VACUUM', { freePages, totalPages });
  db.exec('VACUUM');
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(Date.now()));
  return true;
}

// Recomputes the rollup from the raw observations. Not used on any hot path -
// it exists so the invariant is testable, and as a repair hatch.
function rebuildRelayStats() {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM peer_relay_stats`).run();
    db.prepare(
      `INSERT INTO peer_relay_stats (peer_id, eligible, first)
       SELECT peer_id, COUNT(*), COALESCE(SUM(first), 0) FROM relay_observation GROUP BY peer_id`,
    ).run();
  });
  tx();
}

/**
 * Throw away all peer measurement data and start counting again, keeping the
 * manual peers themselves.
 *
 * The point of the feature: after changing something that invalidates the
 * history - switching Core to clearnet-only, moving the node, fixing a bug in
 * how blocks were timed - the lifetime percentages describe a world that no
 * longer exists, and there is no honest way to read them. The eight peers
 * found the hard way should not have to be found again for that.
 *
 * The manual set survives, and two things make that true rather than merely
 * nominal. A manual peer at 0 of 0 blocks sits inside the new-peer grace, so
 * no challenger displaces it while the new record builds. But a manual peer that happens to be offline is judged by
 * a different rule - how long it has been away - and that rule reads two
 * things a plain wipe destroys:
 *
 *   - its manual sessions, which say Core has really held it (everManual).
 *     Without them a protected peer reads as an address that never stood up,
 *     the one kind of protected peer the rotation does retire.
 *   - trusted_peer.created_at, the clock an offline peer with no closed
 *     session is timed from. Left at the day it was added, a peer reset while
 *     offline was already past its grace on the next tick.
 *
 * So the manual sessions of manual peers are kept, with their peer rows, and
 * created_at is set to now: every manual peer starts the new record with a
 * fresh offline grace, as if it had just joined.
 *
 * relay_observation is emptied with the delete trigger dropped for the
 * duration. It maintains peer_relay_stats one row at a time, which is right
 * for a handful of rows and wrong for a hundred thousand - and pointless here,
 * since the rollup is being cleared in the same breath.
 */
function resetPeerData() {
  const before = storageBreakdown().peerData;
  const tx = db.transaction(() => {
    db.prepare(`DROP TRIGGER IF EXISTS trg_relay_observation_delete`).run();
    try {
      db.prepare(`DELETE FROM relay_observation`).run();
      db.prepare(`DELETE FROM peer_relay_stats`).run();
      db.prepare(`DELETE FROM relay_race`).run();
      db.prepare(
        `DELETE FROM peer_session
          WHERE NOT (connection_type = 'manual'
                     AND peer_id IN (SELECT p.id FROM peer p JOIN trusted_peer tp ON tp.address = p.address))`,
      ).run();
      db.prepare(`DELETE FROM slot_fill_tried`).run();
      db.prepare(`DELETE FROM rotation_log`).run();
      // Goes with the rest, not on its own. Everything the funnel shows -
      // seen, judged, delivered - is derived from the tables above and returns
      // to zero here; a "kept" count that survived would leave the header
      // reading "0 seen, 0 judged, 0 delivered, 8 kept", which is not a
      // statistic but a contradiction.
      db.prepare(`DELETE FROM promoted_peer`).run();
      db.prepare(`DELETE FROM peer WHERE id NOT IN (SELECT peer_id FROM peer_session)`).run();
    } finally {
      // Recreated inside the same transaction, so a failure anywhere above
      // rolls the whole thing back and cannot leave the rollup unmaintained.
      db.prepare(
        `CREATE TRIGGER trg_relay_observation_delete
         AFTER DELETE ON relay_observation
         BEGIN
           UPDATE peer_relay_stats
              SET eligible = eligible - 1, first = first - OLD.first
            WHERE peer_id = OLD.peer_id;
         END`,
      ).run();
    }
    // Give every surviving manual peer its (empty) peer row back, so it shows
    // up in the ranking immediately instead of only once Core reconnects it.
    const addresses = db.prepare(`SELECT address FROM trusted_peer`).all();
    const insert = db.prepare(`INSERT OR IGNORE INTO peer (address, first_seen_at) VALUES (?, ?)`);
    for (const row of addresses) insert.run(row.address, Date.now());
    db.prepare(`UPDATE trusted_peer SET created_at = ?`).run(Date.now());
    return addresses.length;
  });
  const keptManualPeers = tx();
  logger.warn('peer measurement data reset', { keptManualPeers, freedBytes: before.bytes, deletedRows: before.rows });
  return { keptManualPeers, freedBytes: before.bytes, deletedRows: before.rows };
}

/**
 * Throw away the stratum pool history. The configured pools themselves stay -
 * only their measured races and latencies go.
 */
function resetPoolHistory() {
  const before = storageBreakdown().poolHistory;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM stratum_observation`).run();
    db.prepare(`DELETE FROM stratum_race`).run();
  });
  tx();
  logger.warn('stratum pool history reset', { freedBytes: before.bytes, deletedRows: before.rows });
  return { freedBytes: before.bytes, deletedRows: before.rows };
}

/**
 * How much disk this app's data actually occupies, write-ahead log included.
 *
 * Worth surfacing rather than leaving to be discovered: relay_observation is
 * deliberately never pruned - it is the ranking - so the file only ever grows,
 * at roughly four megabytes a day on a node with a couple of hundred peers -
 * measured, 23 MB over 5.7 days and 864 blocks at about 200 peers, so a gigabyte
 * and a half a year. That is a fine price for the measurement, but nobody should
 * have to find it out by running out of disk.
 *
 * The WAL is counted because it is real disk usage and can be a large fraction
 * of the total between checkpoints. A missing file is simply zero - the sizes
 * are for display, and a failed stat must never take the status endpoint down.
 */
function sizeBytes() {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(config.sqlitePath + suffix).size;
    } catch { /* not there (yet) - contributes nothing */ }
  }
  return total;
}

// The two groups the user can clear independently, and what each is made of.
// Everything not listed here is configuration or the manual peers themselves,
// and is never touched by a reset.
const PEER_DATA_TABLES = [
  'relay_race', 'relay_observation', 'peer_relay_stats',
  'peer', 'peer_session', 'rotation_log', 'promoted_peer',
];
const POOL_HISTORY_TABLES = ['stratum_race', 'stratum_observation'];

/**
 * Bytes on disk per group, plus row counts, so the reset dialog can say what
 * it is about to delete instead of asking for blind confirmation.
 *
 * Uses SQLite's dbstat virtual table, which is exact - it reports the pages
 * actually occupied, indexes included - and expensive: it walks every page in
 * the file. That is why this is its own endpoint rather than part of the
 * status poll. Called when someone opens the reset panel, not every twenty
 * seconds.
 *
 * Indexes are charged to the table they belong to, which is the whole point:
 * relay_observation's index is a large part of what deleting it would free.
 */
function storageBreakdown() {
  const owner = new Map();
  for (const row of db.prepare(`SELECT name, tbl_name FROM sqlite_schema WHERE type IN ('table','index')`).all()) {
    owner.set(row.name, row.tbl_name);
  }

  const bytesByTable = new Map();
  for (const row of db.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`).all()) {
    const table = owner.get(row.name) || row.name;
    bytesByTable.set(table, (bytesByTable.get(table) || 0) + row.bytes);
  }

  const group = (tables) => {
    let bytes = 0;
    let rows = 0;
    for (const t of tables) {
      bytes += bytesByTable.get(t) || 0;
      try {
        rows += db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch { /* table not present in an older schema - contributes nothing */ }
    }
    return { bytes, rows };
  };

  return {
    peerData: group(PEER_DATA_TABLES),
    poolHistory: group(POOL_HISTORY_TABLES),
    totalBytes: sizeBytes(),
  };
}

module.exports = {
  open,
  get instance() { return db; },
  getOrCreatePeer,
  maybeVacuum,
  sizeBytes,
  storageBreakdown,
  resetPeerData,
  resetPoolHistory,
  PEER_DATA_TABLES,
  rebuildRelayStats,
  seedDefaultPools,
};
