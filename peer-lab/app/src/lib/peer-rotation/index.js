'use strict';

/**
 * Manual slot fill: one pass every ten minutes (every minute while a
 * candidate is on trial), and the toggle that decides
 * whether any of it runs at all. (The directory keeps its old name,
 * peer-rotation, so every existing require keeps resolving; in the app it is
 * no longer a rotation. It fills free manual slots and spreads them, and
 * never moves a working peer out.)
 *
 * What lives where:
 *
 *   rules.js     who may lose a slot when a person adds a peer to a full
 *                set, and how long an offline peer keeps one. No database,
 *                no RPC.
 *   spread.js    where the manual peers are, and which region a free slot
 *                should go to.
 *   addrbook.js  candidates from Core's address book, the networks they may
 *                come from, and Core's bans.
 *   fill.js      the trial: a candidate goes into a free slot, and Core
 *                connects to it or it goes again.
 *   retire.js    frees the slot of a manual peer that went dark.
 *   log.js       the audit trail: rotation_log and promoted_peer.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const queries = require('../queries');
const logger = require('../logger').make('peer-rotation');
const { logAction, recentLog } = require('./log');
const { retireOfflineManualPeers } = require('./retire');
const fill = require('./fill');
const { offlineGraceMs, offlineForMs } = require('./rules');

const META_KEY = 'peer_rotation_enabled';
// A pass every ten minutes (peer-profiler.js), every minute while a candidate
// is on trial (watchTrial).
const PASS_EVERY_MS = 10 * 60 * 1000;
const TRIAL_CHECK_MS = 60 * 1000;

// What the last pass saw and decided, for the line on the page that says what
// Slot Fill is doing. Written by the pass in the profiler, read by the
// dashboard, so it lives in the database. Nothing here asks Core anything
// the pass did not ask anyway.
const STATUS_KEY = 'slot_fill_status';
function writeStatus(status) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(STATUS_KEY, JSON.stringify(status));
}
function readStatus() {
  try {
    const row = db.instance.prepare('SELECT value FROM meta WHERE key = ?').get(STATUS_KEY);
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

// The manual set as the page tells it: how full, and of the peers that are
// offline, which keeps its slot (locked, and Core has held it before) and when
// each other one gives its slot back.
function slotsOf(ranking, now) {
  const trusted = ranking.filter((p) => p.trusted);
  const offline = trusted.filter((p) => !p.live).map((p) => {
    const where = p.where ? p.where.regionName : null;
    if (p.kept && p.everManual) return { address: p.address, where, keeps: true };
    const off = offlineForMs(p, now);
    return { address: p.address, where, freesInMs: off == null ? null : Math.max(0, offlineGraceMs(p.firstPct) - off) };
  });
  return { used: trusted.length, max: config.maxManualPeers, offline };
}

function isEnabled() {
  if (config.readOnly) return false;
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
  return row ? row.value === '1' : false;
}

function setEnabled(enabled) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(META_KEY, enabled ? '1' : '0');
  // What a pass saw before the switch is not what Slot Fill is doing now.
  db.instance.prepare('DELETE FROM meta WHERE key = ?').run(STATUS_KEY);
  logger.info('manual slot fill toggled', { enabled: Boolean(enabled) });
}

/**
 * Switched off, nothing is left half done: a candidate on trial is kept if
 * Core already holds a working connection to it, and otherwise taken out
 * again.
 */
async function settleOnSwitchOff() {
  if (!fill.currentTrial()) return;
  try {
    const [peers, chain] = await Promise.all([rpc.getPeerInfo(), rpc.getBlockchainInfo()]);
    await fill.settle(peers, chain, Date.now(), { force: true });
  } catch (err) {
    // Core not answering: the next time the slot fill runs, it settles then.
    logger.warn('slot fill: could not settle the trial on switching off', { error: err.message });
  }
}

// One pass at a time: the ten-minute timer and the one-minute trial check
// (watchTrial) both come here, and two passes at once could each put a
// candidate on trial.
let running = false;

async function tick() {
  if (running) return { enabled: isEnabled(), retired: 0, started: 0, confirmed: 0, reverted: 0 };
  running = true;
  try {
    return await pass();
  } finally {
    running = false;
  }
}

/**
 * Every minute, from peer-profiler.js: only while a candidate is on trial, so
 * a candidate Core cannot use is out at its own deadline, not at the next
 * ten-minute pass, and the next one goes in at once. Without a trial, and
 * switched off, it does nothing at all.
 */
async function watchTrial() {
  if (!isEnabled() || !fill.currentTrial()) return null;
  return tick();
}

/**
 * One pass - a complete no-op unless the toggle is on.
 *
 *   settle  keeps the candidate on trial if Core holds a working connection
 *           to it, or takes it out once the trial is over.
 *   retire  frees the slot of a manual peer that has not been there for
 *           longer than its record buys it - never the candidate still on
 *           trial, which is the trial's to judge.
 *   start   puts the next candidate into a free slot, if nothing is on trial.
 *
 * All read the same getpeerinfo, taken first. If Core does not answer,
 * nothing happens: every peer would look offline.
 */
async function pass() {
  const idle = { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0 };
  if (!isEnabled()) {
    // Switched off with a trial still open - Core did not answer at that
    // moment: it is settled here, the next time Core does.
    if (fill.currentTrial()) await settleOnSwitchOff();
    return idle;
  }
  let peers;
  let chain;
  try {
    [peers, chain] = await Promise.all([rpc.getPeerInfo(), rpc.getBlockchainInfo()]);
  } catch (err) {
    logger.debug('slot fill: Core not answering, skipping this pass', { error: err.message });
    writeStatus({ at: Date.now(), nextAt: Date.now() + (fill.currentTrial() ? TRIAL_CHECK_MS : PASS_EVERY_MS), state: 'core' });
    return { ...idle, enabled: true };
  }
  const trialBefore = fill.currentTrial();
  const settled = await fill.settle(peers, chain);
  // A candidate taken out: the next one goes in this pass, on a fresh
  // getpeerinfo without the one just dropped. If Core does not answer now,
  // the next pass does it.
  if (settled === 'reverted') {
    try {
      peers = fill.withoutSession(await rpc.getPeerInfo(), trialBefore.address);
    } catch (err) {
      logger.debug('slot fill: Core not answering after a candidate went, next pass', { error: err.message });
      writeStatus({ at: Date.now(), nextAt: Date.now() + PASS_EVERY_MS, state: 'core' });
      return { ...idle, enabled: true, reverted: 1 };
    }
  }
  // Switched off while this pass waited for Core: the switch has been
  // answered already, so nothing more is removed or added from here on.
  if (!isEnabled()) return { ...idle, enabled: false, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0 };
  const onTrial = fill.currentTrial();
  const ranking = queries.peerRanking();
  const retired = await retireOfflineManualPeers(ranking, onTrial && onTrial.address, peers, isEnabled);
  // Switched off while the retiring waited for Core: no candidate goes in.
  if (!isEnabled()) {
    return { ...idle, enabled: false, retired, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0 };
  }
  // One move per pass: nothing new while a candidate is on trial.
  let started = onTrial
    ? 0
    : await fill.start(retired > 0 ? queries.peerRanking() : ranking, peers, chain);
  // Switched off while this pass was adding: the switch-off could not see the
  // row yet, so the candidate is taken out here, rather than left in a slot
  // no later pass would look at.
  if (started && !isEnabled()) {
    await fill.abandon(started);
    started = 0;
  }
  if (isEnabled()) reportPass(peers, chain);
  return {
    enabled: true, retired, started: started ? 1 : 0, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0,
  };
}

// Switched on and not yet checked (switching on clears the status): the
// profiler runs the first pass at its next poll, seconds away.
function waitsForFirstPass() {
  return isEnabled() && readStatus() == null;
}

// The status after a pass: a candidate on trial, the set full, or why no
// candidate went into a free slot.
function reportPass(peers, chain) {
  const now = Date.now();
  const trial = fill.currentTrial();
  const slots = slotsOf(queries.peerRanking(), now);
  const base = { at: now, nextAt: now + (trial ? TRIAL_CHECK_MS : PASS_EVERY_MS), slots };
  if (trial) return writeStatus({ ...base, state: 'trial', trial: fill.trialView(trial, peers, now) });
  if (chain.initialblockdownload) return writeStatus({ ...base, state: 'catching_up' });
  if (slots.used >= slots.max) return writeStatus({ ...base, state: 'full' });
  const look = fill.lastLook() || { why: 'none_fit' };
  return writeStatus({ ...base, state: 'looking', look });
}

module.exports = {
  PASS_EVERY_MS,
  readStatus,
  waitsForFirstPass,
  isEnabled,
  setEnabled,
  settleOnSwitchOff,
  watchTrial,
  logAction,
  recentLog,
  retireOfflineManualPeers,
  offlineGraceMs,
  tick,
};
