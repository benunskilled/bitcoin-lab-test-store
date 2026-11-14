'use strict';

/**
 * The peer ranking: one statement, one snapshot of the recent window, and the
 * order the rest of the app reads peers in.
 *
 * Both caches here exist for the same reason - this is asked for several times
 * a minute, by the dashboard and by Slot Fill, and it is the only query in
 * the app whose cost would otherwise grow with the node's own lifetime.
 */

const db = require('../db');
const config = require('../config');
const { mapRankingRow } = require('./ranking-row');

// The ranking statement is 60 lines of joins and is re-run several times a
// minute; parsing and planning it every time was measurable, unlike the
// small statements elsewhere in this file. Prepared once, on first use, and
// held for the life of the process (see nthLatencyStmt below for the same
// pattern).
let peerRankingStmt = null;
let liveTipStmt = null;

/**
 * When the new-slot-holder grace period starts: the moment the block
 * `newManualGraceBlocks` back was detected. A manual peer added after that has
 * not yet been through its grace.
 *
 * Counted in blocks rather than measured in hours because the thing being
 * granted is a fair sample, and a sample is blocks. Read as one row - the Nth
 * newest race - rather than counted per peer, which would be a scan of the
 * whole race table for every row of the ranking.
 *
 * Zero when the node has not seen that many blocks at all: nobody can have
 * been through a grace that has not elapsed, so everything with a start date
 * is still inside it.
 */
function newManualGraceStartedAt() {
  const row = db.instance
    .prepare(`SELECT detected_at AS at FROM relay_race ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(Math.max(0, config.newManualGraceBlocks - 1));
  return row ? row.at : 0;
}

function slotFillTrialAddress() {
  try {
    const row = db.instance.prepare(`SELECT value FROM meta WHERE key = 'slot_fill_trial'`).get();
    return row ? JSON.parse(row.value).address || null : null;
  } catch {
    return null;
  }
}

function peerRanking() {
  const now = Date.now();
  if (!peerRankingStmt) {
    peerRankingStmt = db.instance.prepare(peerRankingSql());
  }
  if (!liveTipStmt) {
    // The tip as the live peers know it, for the fork flag: the small live
    // index, ~200 rows.
    liveTipStmt = db.instance.prepare(
      'SELECT MAX(synced_headers) AS tip FROM peer_session INDEXED BY idx_peer_session_live WHERE ended_at IS NULL');
  }
  const graceFrom = newManualGraceStartedAt();
  const liveTip = liveTipStmt.get()?.tip || 0;
  const rows = peerRankingStmt.all().map(mapRankingRow(now, graceFrom, liveTip));

  // The manual peer the slot fill has on trial (peer-rotation/fill.js): in its
  // slot, but only for good once Core has connected to it.
  const onTrial = slotFillTrialAddress();
  if (onTrial) {
    for (const r of rows) {
      if (r.trusted && r.address === onTrial) {
        r.onTrial = true;
        r.status = 'TESTING';
      }
    }
  }

  // Ordered by the blocks delivered first; between two with the same count
  // the one that needed fewer blocks for it, then the lower ping, and the
  // address so the order never wobbles.
  return rows.sort((a, b) => {
    const sa = a.score == null ? -1 : a.score;
    const sb = b.score == null ? -1 : b.score;
    if (sa !== sb) return sb - sa;
    if (a.eligible !== b.eligible) return a.eligible - b.eligible;
    const pa = a.minPingMs == null ? Infinity : a.minPingMs;
    const pb = b.minPingMs == null ? Infinity : b.minPingMs;
    if (pa !== pb) return pa - pb;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
}

/**
 * The peer table is deliberately never pruned for any peer that has ever been
 * connected when a block landed (see config.js) - it only grows. This query
 * therefore has to say what it wants: peers that are connected right now, or
 * that are manual. Nothing else is displayed by the dashboard or acted on by
 * Slot Fill, and without the filter every request materialised, sorted
 * and serialised every peer the node had ever seen in order to render ten rows.
 *
 * The two aggregate joins are correlated subqueries rather than derived tables
 * for the same reason: as derived tables SQLite computed them across the whole
 * of peer_session before the join could discard them again.
 */
function peerRankingSql() {
  return `SELECT
         p.id,
         p.address,
         tp.label AS trustedLabel,
         tp.created_at AS trustedSince,
         (tp.address IS NOT NULL) AS trusted,
         COALESCE(tp.kept, 0) AS kept,
         COALESCE(prs.eligible, 0) AS eligible,
         COALESCE(prs.first, 0) AS first,
         os.direction AS liveDirection,
         os.connection_type AS liveConnectionType,
         -- Core's network for the live session, falling back to the most
         -- recent closed one so an offline manual peer keeps its label.
         COALESCE(os.network, latest.network) AS coreNetwork,
         os.min_ping_ms AS liveMinPingMs,
         os.last_ping_ms AS liveLastPingMs,
         os.hb_to AS liveHb,
         os.hb_from AS liveHbFrom,
         -- Correlated rather than a derived table: as a GROUP BY over the
         -- whole of peer_session it was computed for every peer that table
         -- has ever held, then thrown away by the join.
         (SELECT COUNT(*) FROM peer_session s WHERE s.peer_id = p.id) AS sessionsCount,
         -- Has Core ever actually held a manual connection to this peer? Not
         -- the same as being in the manual set: an address can sit there for
         -- days without Core ever getting a connection to stand up, which is
         -- what a peer that only ever dialled IN looks like. The padlock's
         -- protection against retiring hangs on this, so a bad address cannot
         -- hold one of eight slots forever.
         EXISTS (SELECT 1 FROM peer_session s WHERE s.peer_id = p.id AND s.connection_type = 'manual') AS everManual,
         -- What the peer said about itself comes from a session in which it
         -- said something: one that got as far as its version message (a
         -- client name) or a ping, which Core only sends after the
         -- handshake. A connection that never finished its handshake reports
         -- no client and no services - not the same as a peer that announces
         -- none. Taking "latest" by start time picked such a connection when
         -- Core opened two in the same second, or retried a peer and failed,
         -- and a working node read "offers no services" for hours. NULL when
         -- no session ever finished: unknown, not "nothing".
         COALESCE(os.subver, known.subver) AS client,
         CASE WHEN os.subver IS NOT NULL OR os.min_ping_ms IS NOT NULL THEN os.services ELSE known.services END AS services,
         COALESCE(os.synced_headers, latest.syncedHeaders) AS syncedHeaders,
         latest.latestEndedAt AS latestEndedAt
       FROM peer p
       LEFT JOIN trusted_peer tp ON tp.address = p.address
       -- Two GROUP BY passes over the whole of relay_observation used to sit
       -- here. That table is deliberately never pruned, so their cost grew
       -- with every block the node ever saw; peer_relay_stats holds the same
       -- totals as one row per peer, kept exact by triggers on
       -- relay_observation itself (see db.js), so it cannot drift.
       LEFT JOIN peer_relay_stats prs ON prs.peer_id = p.id
       LEFT JOIN peer_session os ON os.peer_id = p.id AND os.ended_at IS NULL
       LEFT JOIN (
         -- Most recent session's subver + end time per peer, live or not, so
         -- a currently-offline manual peer still shows the client it last
         -- ran, and how long ago it dropped (ended_at is NULL for the
         -- session actually still live, in which case there's nothing to
         -- report here - offline duration only ever comes from a peer's
         -- most recent CLOSED session).
         SELECT ps.peer_id, ps.subver, ps.network, ps.services, ps.synced_headers AS syncedHeaders, ps.ended_at AS latestEndedAt
         FROM peer_session ps
         WHERE ps.id = (
           SELECT id FROM peer_session ps2
           WHERE ps2.peer_id = ps.peer_id
           ORDER BY started_at DESC LIMIT 1
         )
       ) latest ON latest.peer_id = p.id
       -- Driven by p.id, so it runs once per peer: newest first along
       -- idx_peer_session_peer_started, stopping at the first that finished.
       LEFT JOIN peer_session known ON known.id = (
         SELECT k.id FROM peer_session k
         WHERE k.peer_id = p.id AND (k.subver IS NOT NULL OR k.min_ping_ms IS NOT NULL)
         ORDER BY k.started_at DESC LIMIT 1
       )
       -- Only what anything actually consumes: live peers and manual ones.
       --
       -- Written as a subquery on p.id rather than as a predicate reading
       -- "os.peer_id IS NOT NULL OR tp.address IS NOT NULL", which reads more
       -- naturally and is a trap: as a predicate on the join result it can only be applied AFTER
       -- the join, so SQLite walked every row of the peer table - which by
       -- design never shrinks - doing five index seeks each, to return ~200
       -- rows. The plan opened with SCAN p, and the cost tracked the number of
       -- peers the node had ever seen: 1.6ms on a fresh install, 8ms after a
       -- year, 23ms on a busy one. This form drives the query from the two
       -- small sets instead, and the plan opens with a primary-key search.
       WHERE p.id IN (
         SELECT peer_id FROM peer_session INDEXED BY idx_peer_session_live WHERE ended_at IS NULL
         UNION
         SELECT id FROM peer WHERE address IN (SELECT address FROM trusted_peer)
       )
       -- No ORDER BY: peerRanking() sorts these rows in JavaScript.
       `;
}

module.exports = { peerRanking };
