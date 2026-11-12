'use strict';

const http = require('http');

/**
 * The peers service is the app's other half: it knows the same peers, where
 * they are and what kind of software each one runs. This dashboard asks it,
 * container to container, for its word on each peer it marks.
 *
 * It is a separate process that may still be starting or restarting, so a
 * miss is silent and simply means no marks for a while.
 */
const DEFAULT_URL = 'http://peers:8789/api/health';
// Once it answers, it stays up: asking once every five minutes is plenty,
// and a service that is down costs no request on every dashboard poll.
const RECHECK_MS = 5 * 60 * 1000;
// A miss is asked again sooner: after an update the service may still be
// starting when the dashboard asks (28.10.2026).
const RECHECK_MISS_MS = 30 * 1000;
const TIMEOUT_MS = 2000;

// Read per call rather than at load: a test sets it between cases, and there
// is no cost worth saving here.
const target = () => process.env.PEERS_HEALTH_URL || DEFAULT_URL;
let checkedAtMs = 0;
let present = false;
let inFlight = null;

function ask() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    let req;
    try {
      req = http.get(target(), { timeout: TIMEOUT_MS }, (res) => {
        // The body is of no interest; draining it lets the socket close.
        res.resume();
        finish(res.statusCode === 200);
      });
    } catch {
      return finish(false);
    }
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

/**
 * Whether the peers service answered recently. Returns the cached answer
 * without waiting whenever one is fresh enough, and never lets two checks run at once.
 */
async function isUp() {
  if (target() === 'off') return false;
  // A check already running is the answer everyone waits for. This has to come
  // before the freshness test: stamping the clock at the START of a check made
  // every caller during it read the previous answer instead - so the first poll
  // after a restart reported "down" and the page only caught up twenty
  // seconds later.
  if (inFlight) return inFlight;
  if (checkedAtMs && Date.now() - checkedAtMs < (present ? RECHECK_MS : RECHECK_MISS_MS)) return present;
  inFlight = ask().then((ok) => {
    present = ok;
    checkedAtMs = Date.now();
    inFlight = null;
    return ok;
  });
  return inFlight;
}

// What the peers service makes of a peer that the dashboard cannot tell from
// the name alone: a Core name on software that is not Core (Disguised), and
// the pool a node belongs to. The peers service decides that from what the
// peer does - which services it offers, which messages it leaves out - and
// keeping one copy of those checks there keeps the two from contradicting
// each other.
//
// Never waited for: the ranking is answered from what was fetched last, and a
// fetch starts at most once a minute, only while this page is being polled.
// The peers service answers from its own copy of Core's list while that is
// under ten seconds old, and asks Core again otherwise; that can take
// seconds when Core is slow, which is why nobody waits.
const KINDS_EVERY_MS = 60 * 1000;
const KINDS_TIMEOUT_MS = 30 * 1000;
// Three short fields a peer, from /api/kinds: some ten kilobytes for a few
// hundred peers. Anything far larger is not that answer.
const KINDS_MAX_BYTES = 4 * 1024 * 1024;
const kindsTarget = () => target().replace(/\/api\/health$/, '/api/kinds');
let kinds = new Map();
let kindsAtMs = 0;
// The peers service's names outlive a failed answer, but not by long: after
// ten minutes without one they are its old word on peers that have moved on.
const KINDS_STALE_MS = 10 * 60 * 1000;
let kindsOkAtMs = 0;
let kindsInFlight = false;

function fetchKinds() {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(kindsTarget(), { timeout: KINDS_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > KINDS_MAX_BYTES) { req.destroy(); return resolve(null); }
          chunks.push(c);
        });
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
    } catch {
      return resolve(null);
    }
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// What the ranking needs of a peer: its kind, whether its software passes
// blocks on at all, whether it is on 0xB10C's LinkingLion list, and the chain
// of its own it is on, if any. Only what is set; the strings are the peers
// service's, capped.
function kindsOf(body) {
  const out = new Map();
  for (const p of (body && Array.isArray(body.peers)) ? body.peers : []) {
    if (!p || typeof p.addr !== 'string' || typeof p.kind !== 'string') continue;
    const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
    const m = { kind: str(p.kind) };
    if (p.no_relay === true) m.noRelay = true;
    if (p.linking_lion === true) m.lion = true;
    if (str(p.fork)) m.fork = str(p.fork);
    out.set(p.addr, m);
  }
  return out;
}

/**
 * The peers service's word on each peer it marks, by address - from the
 * last answer, without waiting. An empty map when the service is down or not
 * yet asked; a failed fetch keeps the previous answer for up to ten minutes.
 */
function peerKinds() {
  if (target() === 'off') return new Map();
  if (!present) {
    // Down (or not known to be up): ask whether it is, for next time, and
    // say nothing - old marks from before it went down are not shown.
    isUp().catch(() => {});
    kinds = new Map();
    return kinds;
  }
  if (!kindsInFlight && Date.now() - kindsAtMs >= KINDS_EVERY_MS) {
    kindsInFlight = true;
    kindsAtMs = Date.now();
    fetchKinds().then((body) => {
      if (body) { kinds = kindsOf(body); kindsOkAtMs = Date.now(); }
      else if (Date.now() - kindsOkAtMs > KINDS_STALE_MS) kinds = new Map();
    }).finally(() => { kindsInFlight = false; });
  }
  return kinds;
}

// Core's peer list by way of the peers service (/api/peerinfo), for the
// profiler's 15-second poll. The service keeps Core's answer for ten
// seconds and the page's list is drawn from the same copy, so with the page
// open the two ask Core once between them instead of each on its own clock.
// Every field as Core wrote it but addrlocal, and when Core gave it:
// { peers, atMs }. null when the service is not there, slow, or
// has no fresh answer - the caller then asks Core itself, as it always did.
const PEERINFO_TIMEOUT_MS = 25 * 1000; // the service waits up to 20s for Core
const PEERINFO_MAX_BYTES = 32 * 1024 * 1024;
const peersBase = () => (process.env.PEERS_URL || 'http://peers:8789').replace(/\/+$/, '');

function peerInfo() {
  if (process.env.PEERS_URL === 'off') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(peersBase() + '/api/peerinfo', { timeout: PEERINFO_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > PEERINFO_MAX_BYTES) { req.destroy(); return resolve(null); }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || !Array.isArray(body.result)) return resolve(null);
            // When Core gave it: the copy can be up to ten seconds old. A time
            // that cannot be right is replaced by now.
            const now = Date.now();
            const atMs = Number.isFinite(body.at_ms) && body.at_ms <= now && now - body.at_ms < 60 * 1000 ? body.at_ms : now;
            resolve({ peers: body.result, atMs });
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
    } catch {
      return resolve(null);
    }
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Tests need a clean slate between cases.
function reset() {
  checkedAtMs = 0;
  present = false;
  inFlight = null;
  kinds = new Map();
  kindsAtMs = 0;
  kindsOkAtMs = 0;
  kindsInFlight = false;
}

module.exports = { isUp, peerKinds, peerInfo, reset, target };
