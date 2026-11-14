'use strict';

/**
 * Time the slot fill could not see.
 *
 * The trial and the offline grace are both measured on the wall clock. Two
 * things break that: Core not answering (restarting, say), and the clock
 * itself stepping. While Core is down it holds no connection to anyone, so a
 * candidate on trial cannot connect and every manual peer looks offline; after
 * a restart the candidate got "no connection" and a week's ban, and an
 * offline manual peer lost its slot for time Core was not even trying. A clock
 * stepping back left the trial waiting for hours; one stepping forward made
 * everybody overdue at once.
 *
 * So each pass in which Core answers notes when it ran. The next one looks at
 * the step since: Core failed in between, the clock went backwards, or more
 * than two passes went by - a gap. After a gap the candidate's trial starts
 * over, nobody is retired in that pass, and the gap's length is kept (for a
 * month) and not counted as offline time.
 */

const db = require('../db');

const LAST_KEY = 'slot_fill_last_pass';
const DOWN_KEY = 'slot_fill_core_down';
const GAPS_KEY = 'slot_fill_gaps';
// Passes run every ten minutes, every minute while a trial is open; two
// passes' worth is more than any normal step.
const MAX_STEP_MS = 20 * 60 * 1000;
const KEEP_GAPS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GAPS = 100;

function read(key) {
  const row = db.instance.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function write(key, value) {
  db.instance
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function drop(key) {
  db.instance.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

function gaps() {
  try {
    const list = JSON.parse(read(GAPS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// A pass found Core not answering.
function coreDown(now = Date.now()) {
  if (read(DOWN_KEY) == null) write(DOWN_KEY, now);
}

// Slot Fill is off: nothing is measured, so the next pass after switching on
// starts from here rather than reading the time it was off as a gap.
function idle(now = Date.now()) {
  write(LAST_KEY, now);
  drop(DOWN_KEY);
}

/**
 * A pass in which Core answered. Returns true after a gap.
 */
function passed(now = Date.now()) {
  const last = Number(read(LAST_KEY));
  const down = read(DOWN_KEY) != null;
  write(LAST_KEY, now);
  drop(DOWN_KEY);
  if (!last) return down;
  const step = now - last;
  if (!down && step >= 0 && step <= MAX_STEP_MS) return false;
  // Forward only: a clock that went back has nothing to take off, and its
  // gap would end before it began.
  if (step > 0) {
    const kept = gaps().filter((g) => g.at > now - KEEP_GAPS_MS && g.at <= now);
    kept.push({ at: now, ms: step });
    write(GAPS_KEY, JSON.stringify(kept.slice(-MAX_GAPS)));
  }
  return true;
}

/**
 * How much of the time from `since` to `now` fell into gaps.
 */
function lostBetween(since, now = Date.now()) {
  let lost = 0;
  for (const g of gaps()) {
    const from = Math.max(since, g.at - g.ms);
    const to = Math.min(now, g.at);
    if (to > from) lost += to - from;
  }
  return lost;
}

module.exports = { coreDown, idle, passed, lostBetween, MAX_STEP_MS };
