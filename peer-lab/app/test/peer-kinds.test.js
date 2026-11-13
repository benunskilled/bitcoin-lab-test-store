'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * The dashboard marks a peer whose software cannot pass a block on "never
 * first". The peers service makes the same judgement in kinds.go for the ⊘ in
 * the peer list. The two lists drifted once: the Go side had learned about
 * mempool/electrum indexers, university scanners (.ac., uni-) and Bitcoin XT,
 * and the dashboard had not - so one peer could be a relay in the list and a
 * "never first" wallet in the ranking.
 *
 * This reads the real Go file rather than a copy of its patterns, so the two
 * cannot drift again without something failing here. PEERS_DIR says where it
 * is (CI sets it, and then a missing file is a broken checkout); without it,
 * ../../peers is the place to look, and the test skips when it is not there.
 */

const KINDS_GO = process.env.PEERS_DIR
  ? path.join(process.env.PEERS_DIR, 'kinds.go')
  : path.join(__dirname, '..', '..', 'peers', 'kinds.go');
const APP_JS = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'app.js');

// {"Indexer", regexp.MustCompile(`(?i)electrs|...`), false},
const GO_RULE = /^\s*\{"([^"]+)",\s*regexp\.MustCompile\(`(.+?)`\),\s*(true|false)\},\s*$/gm;

function goRules() {
  const src = fs.readFileSync(KINDS_GO, 'utf8');
  const rules = [];
  for (const [, name, pattern, relays] of src.matchAll(GO_RULE)) {
    // Go spells the case-insensitive flag inside the pattern; JavaScript
    // spells it beside it. Everything else in these patterns is the same
    // syntax in both languages.
    const ci = pattern.startsWith('(?i)');
    rules.push({ name, re: new RegExp(ci ? pattern.slice(4) : pattern, ci ? 'i' : ''), relays: relays === 'true' });
  }
  return rules;
}

// The Go side's own answer, by its own rules, in its own order.
// The kinds classify reads with the brackets taken out, from kinds.go itself.
function goBareKinds() {
  const m = fs.readFileSync(KINDS_GO, 'utf8').match(/var readsBareName = map\[string\]bool\{([^}]*)\}/);
  assert.ok(m, 'kinds.go must still define readsBareName');
  return new Set([...m[1].matchAll(/"([^"]+)":\s*true/g)].map((x) => x[1]));
}

function goRelaysBlocks(rules, subver) {
  if (!subver) return true;
  const bare = subver.replace(/\([^)]*\)/g, '');
  const noMempool = subver.replace(/mempool/gi, '');
  const bareKinds = goBareKinds();
  for (const rule of rules) {
    const s = rule.name === 'Pool node' ? noMempool : bareKinds.has(rule.name) ? bare : subver;
    if (rule.re.test(s)) return rule.relays;
  }
  return true; // "Other" - unrecognised software still relays
}

// app.js is a browser script: it touches the DOM at the top level, so it
// cannot simply be required. The classifier is lifted out of the real file and
// run as it is written there.
function dashboardCannotRelayReason() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const start = src.indexOf('const KIND_RULES = [');
  assert.ok(start > 0, 'app.js must still define KIND_RULES');
  const fnStart = src.indexOf('function cannotRelayReason', start);
  assert.ok(fnStart > 0, 'app.js must still define cannotRelayReason');
  const end = src.indexOf('\n}', fnStart) + 2;
  return vm.runInNewContext(`${src.slice(start, end)}\ncannotRelayReason;`);
}

// One agent per alternative in every rule on the Go side, plus the awkward
// ones. Real strings, in the shape peers actually send them.
const AGENTS = [
  // Pool software, and an operator naming their pool in the bracketed comment.
  '/ckpool/', '/ckp2p:1.0/', '/Satoshi:29.1.0(PyBLOCK-POOL)/Knots:20250903/',
  // The case that makes the order matter: "mempool" is an indexer's name and
  // also the letters "pool" inside a bracketed comment. Whichever way it is
  // judged, both services have to judge it the same way.
  '/Satoshi:28.0.0(mempool.space)/', '/mempool/', '/mempool.space:1.0/',
  // Other chains.
  '/Bitcoin ABC:28.0.0/', '/BUCash:1.9.0/', '/Bitcoin SV:1.1.0/', '/BCHUnlimited:1.10.0/', '/Bitcoin XT:0.11.0/',
  // Scanners, as a service and as a university department.
  '/bitcoin@dsn.tm.kit.edu/', '/dsn.kastel:1/', '/node.cs.ac.uk:1.0/', '/uni-goettingen.de/',
  // A word in an operator's bracketed label: a Core node, in both services.
  '/Satoshi:25.0.0(node.cs.ac.uk)/', '/Satoshi:29.0.0(my-monitor)/', '/Satoshi:29.0.0(electrum-backend)/',
  '/Satoshi:28.0.0(neutrino)/', '/Satoshi:29.0.0(lit:v1)/',
  '/bitnodes.io:0.1/', '/metrika:1.0/', '/nodemap/', '/some-crawler:2/', '/portscanner/',
  // Indexers and wallets.
  '/electrs:0.10.0/', '/electrumx:1.16/', '/esplora/',
  '/bitcoinj:0.15/', '/breadwallet:1.0/', '/bither/', '/MultiBit:0.5/', '/wasabi:2.0/', '/Bitcoin Wallet:9.0/',
  '/WalletKit:0.1.0/', '/bread:2.1/', '/btcwire:0.5.0/spvwallet:0.1.0/', '/btcwire:0.4.1/lit:v0.1/', '/nakamoto:0.3.0/', '/btcwire:0.4.1/Satoshi:0.19/', '/neutrino:0.2.0/', '/Rust BIP-157:0.6.0/rust-bitcoin:0.32.8/',
  // Crawlers that only say scan / seeder / census / monitor, seen on a real node.
  '/bitcoin-seeder:0.01/', '/btc-range-scan:0.1.0/', '/BTC-Nodes:2026-09-24/Sonar/', '/census:0.1.7/',
  '/btc-node-observatory:0.1.0/', '/go-bitnode-monitor:firstseen/', '/atlas-scout:0.1/', 'nebula/2.4.1-85b3e43',
  // Core's name misspelt: Disguised in the peer list, and relaying in both - what it
  // really runs is unknown.
  '/Sat0shi:31.0.0/', '/Satoshi2:0.18.3/', '/SatoshiX:0.18.0/', 'Satoshi:22.0.0',
  // Bitcoin Cash under another name, forks, more watchers, other node software.
  '/Classic:1.3.4(EB8)/', '/BitcoinUnlimited:1.0.3(EB16; AD12)/', '/SuperBitcoin:0.16.0.2/', '/iriumd:1.9.66/', 'vds_0.9.53', 'VDS 0.9.9.1', '/your-fork:0.1/', '/btcwire:0.5.0/CaribouSPV:0.0.1-beta/',
  '/NodeWatch-BTC:0.2/', '/aver-btc-listener:0.1/', 'bitdash.io', '/BitArgus:0.1/',
  '/btcwire:0.5.0/btcd:0.25.0/', '/libbitcoin:4.0.0/', '/bcoin:v1.0.0-beta.14/', '/Gocoin:1.10.0pre/',
  // A Utreexo node: named in the peer list, relaying in both.
  '/Floresta:0.9.1/', '/Floresta:0.9.1/mandacaru:0.15.2/',
  // Clients identified in public source on 29 October.
  '/BitcoinRocks:31.1.1/', '/bip110-observer:0.1/', '/EMPORION:0.3/', '/SYMMARTYS:0.3/',
  // Identified in public sources on 11 November.
  '/Bitflash:btc-light/', '/21datalab-crawler:0.1/', 'nebula/2.4.1-65580d4', '/nebula:v3.0.0-20261019105927-e59406bbe71e/',
  // Names with no public source stay with what relays; names that say probe,
  // peers or bip157 get the kind they say (3 November).
  '/your-fork:0.1/', '/cryptexplorer:0.1.0/', '/BlockSail:0.1/', '/trinetra:0.1/', '/multiseed:0.1/',
  '/topology-probe:0.1/', '/p2p-probe:0.1/', '/probe:1.0/', '/btc-peers:0.1/', '/BTC-Nodes:1.0/Probe/', '/bitcoin-peers:0.1.0/', '/logos-peer-list:0.1/', '/nodes.mom.market:0.1/', '/btcwire:0.5.0/bitcoinstats.com:0.1/', '/p2p-extractor:0.1/', '/bip157-fetch:0.1/', '/dexcash-nodes:0.1.0/',
  // Software that does relay, and software nobody here has heard of.
  '/Satoshi:29.0.0/', '/Satoshi:28.1.0/Knots:20250903/', '/btcwire:0.5.0/', '/Sat0shi:31.0.0/', '',
  // The three the apps used to judge differently.
  '/Satoshi:27.0.0(mempool.guide)/electrs:0.10.0/', '/btc-mempool:1/', '/Sat0shi:31.0.0/crawler:1/', '/CKCoinD:1.0/',
];

if (process.env.PEERS_DIR && !fs.existsSync(KINDS_GO)) {
  throw new Error(`PEERS_DIR is set, but there is no ${KINDS_GO}`);
}
const SKIP_WITHOUT_GO = fs.existsSync(KINDS_GO)
  ? false
  : `no peers service at ${KINDS_GO} - set PEERS_DIR to compare the two`;

test('the dashboard and the peers service judge every peer the same way', { skip: SKIP_WITHOUT_GO }, () => {
  const rules = goRules();
  assert.ok(rules.length >= 8, 'the Go rules must actually have been parsed');
  const cannotRelayReason = dashboardCannotRelayReason();

  for (const agent of AGENTS) {
    const dashboardRelays = cannotRelayReason(agent) === null;
    assert.equal(
      dashboardRelays,
      goRelaysBlocks(rules, agent),
      `${JSON.stringify(agent)} is judged differently by the two services`,
    );
  }
});

test('a peer that sent no user agent at all is given the benefit of the doubt', () => {
  const cannotRelayReason = dashboardCannotRelayReason();
  for (const nothing of ['', null, undefined]) {
    assert.equal(cannotRelayReason(nothing), null, 'not knowing is not the same as knowing it cannot');
  }
});

test('the reason shown names the family the Go side named', () => {
  // The colour is what has to match, but a peer marked "a wallet" in one app
  // and "an address indexer" in the other is still two answers to one
  // question. The names differ in wording by design ("Indexer" vs "an address
  // indexer"), so this checks they are about the same thing.
  const cannotRelayReason = dashboardCannotRelayReason();
  const expectations = [
    ['/Bitcoin XT:0.11.0/', 'another chain'],
    ['/node.cs.ac.uk:1.0/', 'research scanner'],
    ['/uni-goettingen.de/', 'research scanner'],
    ['/mempool.space:1.0/', 'indexer'],
    ['/electrumx:1.16/', 'indexer'],
    ['/EMPORION:0.3/', 'light client'],
    ['/SYMMARTYS:0.3/', 'light client'],
    ['/Bitflash:btc-light/', 'light client'],
    ['/21datalab-crawler:0.1/', 'crawler'],
    ['nebula/2.4.1-65580d4', 'crawler'],
    ['/bip110-observer:0.1/', 'crawler'],
  ];
  for (const [agent, fragment] of expectations) {
    const reason = cannotRelayReason(agent) || '';
    assert.ok(reason.includes(fragment), `${agent}: "${reason}" should mention "${fragment}"`);
  }
});
