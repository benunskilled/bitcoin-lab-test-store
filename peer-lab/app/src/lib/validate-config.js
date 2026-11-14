'use strict';

/**
 * Checks the numbers in config.js once, at load, and refuses to start on a
 * setting that cannot mean anything.
 *
 * Every value there arrives as `Number(process.env.X)`, which turns a typo
 * into `NaN` rather than into an error. `NaN` does not throw anywhere: it
 * makes `setInterval` fire as fast as the event loop allows, makes every
 * comparison in Slot Fill false, and makes a division produce another
 * `NaN` that is stored as NULL. The app keeps running and quietly does
 * nothing correct, which is the worst of the available failure modes - worse
 * than a crash, because a crash is visible in the app's logs on the first
 * restart.
 *
 * Ranges, not just types. A poll interval of 0 is a number and a busy loop
 * against Core's RPC.
 *
 * The upper bounds are deliberately loose. They are there to catch a wrong
 * unit - milliseconds typed where hours were meant - not to have an opinion
 * about how somebody runs their node.
 */

// [min, max], both inclusive. `integer: false` for the two that are genuinely
// fractional; everything else counts something and must be whole.
const RULES = {
  dashboardPort: { min: 1, max: 65535 },
  maxManualPeers: { min: 1, max: 8, note: "Bitcoin Core's own MAX_ADDNODE_CONNECTIONS is 8" },
  newManualGraceBlocks: { min: 0, max: 100000 },
  manualPerRegion: { min: 1, max: 8 },
  offlineGraceHours: { min: 0, max: 8760, integer: false },
  offlineGraceDeliveredHours: { min: 0, max: 8760, integer: false },
  stratumRaceTimeoutMs: { min: 100, max: 600000 },
  stratumIdleTimeoutMs: { min: 1000, max: 7 * 24 * 60 * 60 * 1000 },
  stratumHistoryRetentionDays: { min: 1, max: 36500 },
  feelerPeerRetentionDays: { min: 1, max: 36500 },
  neverFirstPeerRetentionDays: { min: 1, max: 36500 },
  peerPollIntervalMs: { min: 1000, max: 3600000, note: 'below a second this is a busy loop against Core' },
  trafficFlushMs: { min: 1000, max: 86400000, note: 'below a second this writes to the database all the time' },
};

// The env var a given config key came from, so the message names what the
// operator actually typed rather than an internal property name.
const ENV_NAMES = {
  dashboardPort: 'DASHBOARD_PORT',
  trafficFlushMs: 'TRAFFIC_FLUSH_MS',
  maxManualPeers: 'MAX_MANUAL_PEERS',
  newManualGraceBlocks: 'NEW_MANUAL_PEER_GRACE_BLOCKS',
  manualPerRegion: 'MANUAL_PER_REGION',
  offlineGraceHours: 'OFFLINE_GRACE_HOURS',
  offlineGraceDeliveredHours: 'OFFLINE_GRACE_DELIVERED_HOURS',
  stratumRaceTimeoutMs: 'STRATUM_RACE_TIMEOUT_MS',
  stratumIdleTimeoutMs: 'STRATUM_IDLE_TIMEOUT_MS',
  stratumHistoryRetentionDays: 'STRATUM_HISTORY_RETENTION_DAYS',
  feelerPeerRetentionDays: 'FEELER_PEER_RETENTION_DAYS',
  neverFirstPeerRetentionDays: 'NEVER_FIRST_PEER_RETENTION_DAYS',
  peerPollIntervalMs: 'PEER_POLL_INTERVAL_MS',
};

/**
 * Returns the list of problems, newest-first is meaningless here so simply in
 * declaration order. An empty array means the config is usable.
 *
 * Deliberately returns rather than throws, so the test suite can read the
 * messages and assertConfig below decides what to do about them.
 */
function checkConfig(config) {
  const problems = [];

  for (const [key, rule] of Object.entries(RULES)) {
    const value = config[key];
    const name = ENV_NAMES[key];
    const where = rule.note ? ` (${rule.note})` : '';

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${name} is not a number: ${JSON.stringify(process.env[name] ?? value)}`);
      continue;
    }
    if (rule.integer !== false && !Number.isInteger(value)) {
      problems.push(`${name} must be a whole number, got ${value}`);
      continue;
    }
    if (value < rule.min || value > rule.max) {
      problems.push(`${name} must be between ${rule.min} and ${rule.max}${where}, got ${value}`);
    }
  }

  return problems;
}

/**
 * Called once from config.js. Prints every problem rather than only the first,
 * so somebody fixing a compose file is not sent round the loop once per typo,
 * and exits non-zero: Docker restarts the container, the same message appears
 * again, and it is visible in the app's logs instead of being invisible in its
 * behaviour.
 */
function assertConfig(config, { exit = (code) => process.exit(code), log = console.error } = {}) {
  const problems = checkConfig(config);
  if (problems.length === 0) return;
  log('Peer Lab cannot start - the configuration is not usable:');
  for (const problem of problems) log(`  - ${problem}`);
  log('See peer-lab/app/docs/configuration.md in the repository for what each setting means.');
  exit(1);
}

module.exports = { checkConfig, assertConfig, RULES, ENV_NAMES };
