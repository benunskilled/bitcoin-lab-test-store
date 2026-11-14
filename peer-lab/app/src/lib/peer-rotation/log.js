'use strict';

/**
 * The slot fill's audit trail: what it changed, and what a person changed by
 * hand, written down and read back for the dashboard. `rotation_log` is a
 * window - exactly what the dashboard shows and not one row more.
 */

const db = require('../db');
const { whereOf } = require('../queries/ranking-row');

// The dashboard shows the newest four and opens up to all of them. A slot
// fill changes something a few times a week, so this is weeks of history.
const LOG_ENTRIES = 30;

function logAction(entry) {
  db.instance
    .prepare(
      `INSERT INTO rotation_log (at, action, address, replaced_address, note)
       VALUES (@at, @action, @address, @replacedAddress, @note)`,
    )
    .run({
      at: Date.now(),
      action: entry.action,
      address: entry.address,
      replacedAddress: entry.replacedAddress || null,
      note: entry.note || null,
    });

  // Nothing is kept that is not shown. The dashboard offers the newest
  // LOG_ENTRIES behind its "Show all" button, so the table holds
  // exactly that many and the rest goes on the way in - no retention window to
  // reason about, no daily sweep, and no way for a misbehaving loop to leave
  // fifty thousand rows behind before anyone looks.
  //
  // By id, the order of writing (AUTOINCREMENT), not by `at`: two actions in
  // one tick can share a millisecond, and after the clock steps back a new
  // action carries an older `at` than all the rest and would be the one
  // deleted.
  db.instance
    .prepare(`DELETE FROM rotation_log WHERE id NOT IN (SELECT id FROM rotation_log ORDER BY id DESC LIMIT ?)`)
    .run(LOG_ENTRIES);
}

// Where each peer is goes with it, for the flag under its address: looked up
// now, from the address, as for the manual peers above the log.
function recentLog(limit = LOG_ENTRIES) {
  return db.instance
    .prepare(
      `SELECT id, at, action, address, replaced_address AS replacedAddress, note
       FROM rotation_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((e) => ({ ...e, where: whereOf(e.address) }));
}

module.exports = { logAction, recentLog, LOG_ENTRIES };
