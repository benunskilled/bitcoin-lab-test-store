'use strict';

// Peer/pool ranking is a slow-moving, historical stat, not a live combat
// feed - it doesn't need sub-10s freshness, and peerRanking() in particular
// runs several joined aggregate queries. Manual actions (add/remove/
// disconnect a peer, delete a pool) already trigger their own immediate
// refreshPeers()/refreshPools() call, so this interval only governs how
// stale the tables are allowed to get from someone else's activity (Core
// itself connecting/dropping peers) between clicks.
const REFRESH_MS = 20000;
// The rotation loop acts at most once every ten minutes, so its panel has no
// reason to be on the same schedule as the peer list.
const ROTATION_REFRESH_MS = 2 * 60 * 1000;
// New blocks no longer arrive by polling at all. /api/events is a
// Server-Sent Events stream the dashboard process feeds from Core's own ZMQ
// notification, so the ranking follows the block when it actually lands -
// and the old 5s poll (720 requests an hour to catch roughly six events) is
// gone entirely.
let lastRaceId = null; // null = "haven't loaded the latest race yet", not "no races"
let lastKnownHeight = null;
let MAX_MANUAL_PEERS = 8; // overwritten from /api/status once loaded (config.maxManualPeers)

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// The peer list writes its durations and pings with these two as well.
function fmtDuration(ms) {
  if (ms == null) return '-';
  // A clock a moment ahead of Core's is not a negative age.
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  // Seconds below a minute, as the peer list writes it: "41s", not "0m".
  if (m === 0) return `${s}s`;
  return `${m}m`;
}

function fmtPct(p) {
  return p == null ? '-' : `${p.toFixed(1)}%`;
}

// Disk used by the measurement data, and traffic. One decimal below a
// gigabyte and two above it, so the number stays readable as the file grows
// past the point where anyone would care about the megabytes. Steps of 1000,
// as the peer list counts them, and the number never apart from its unit.
function fmtBytes(bytes) {
  const mb = bytes / 1e6;
  if (mb < 1000) return `${mb.toFixed(1)}\u00a0MB`;
  return `${(mb / 1000).toFixed(2)}\u00a0GB`;
}

// Software that does not pass blocks on at all. These peers are connected,
// they count in every total, and they can never win a block - a phone wallet
// has nothing to relay, a crawler is there to look, an indexer serves someone
// else's wallet. Measured over 2,270 peers on one node: 790 observations
// between them, not one first.
//
// The test is the user agent, which the peer writes itself, so it is a hint
// and not proof. That is fine for a colour: nothing is excluded from the
// ranking, nothing is decided - a green pill just stops claiming that this
// connection was ever in the running.
//
// Deliberately NOT in here: block-relay-only peers. They refuse transactions
// and pass blocks on, which is the opposite of this list.
//
// These are the peers service's kindRules (peers/kinds.go), same patterns in
// the same order, and it has to stay that way. The peer list and the ranking
// show the same node's peers, and a peer that is marked in one and not the
// other is worse than no marking at all. The Go side names each family; here only
// the answer to "can this thing pass a block on" is needed, so a family that
// relays carries a null reason and is simply a stop.
//
// Order is load-bearing, exactly as it is there: first match wins, so a pool
// node is recognised before anything else gets to read its user agent. A
// solo-pool operator who puts the pool's name in the bracketed comment -
// "/Satoshi:29.1.0(mempool-pool)/" and the like - is running a relaying node,
// and without that rule first the word inside the brackets would have it
// painted as an indexer.
const KIND_RULES = [
  // Core's name misspelt ("/Sat0shi:", "/Satoshi2:"): Disguised in the peer list.
  // What it runs is unknown, so it is not struck - and it comes first, so the
  // rest of its agent is not read as a crawler or a wallet either.
  [/^\/Sat0shi:|^\/Satoshi[0-9X]+:|^Satoshi:/, null, 'whole'],
  // Mining pool software speaking p2p, or a node whose operator says in the
  // bracketed comment that it belongs to a pool. Relays.
  [/ckpool|^\/ckp2p:|^\/CKCoinD:|\([^)]*pool[^)]*\)|^\/P2Pool:|^\/[^:/(]*pool[^:/(]*:/i, null, 'no-mempool'],
  // Bitcoin Classic's "(EB8)" is Bitcoin Cash's block size; SuperBitcoin,
  // Irium and VDS are forks and altcoins of their own. Bitcoin Purity, a hard
  // fork of Knots, says "/Satoshi:29.4/Purity:1.1.0/".
  [/Bitcoin ABC|BUCash|Bitcoin SV|BCHUnlimited|Bitcoin XT|Classic:|\(EB[0-9]|SuperBitcoin|iriumd|vds[_ ]|^\/Aurum:|\/Purity:|^\/dexcash-nodes:/i, 'a client of another chain', 'whole'],
  // Scanners run as a service and scanners run by universities - the second
  // kind announces itself with its department's domain.
  [/kit\.edu|dsn\.tm|dsn\.kastel|\.ac\.|uni-|^\/btcwire:[^/]*\/Satoshi:|^\/rske-research:|^\/acsrg-research:|^\/dataforge-observer:|^\/connector\/$/i, 'a research scanner'],
  // Crawlers, seeders and node counters, including the ones that only say
  // "scan", "seeder", "census" or "monitor".
  [/bitnodes|bluematt-tokio-client|metrika|nodemap|crawl|scan|seeder|census|monitor|observatory|sonar|scout|nebula|watch|listener|argus|readonly|bitdash|logosnaut|dnsseed|survey|lionseed|gnoban|^\/p2p-observer:|^\/p2p-extractor:|^\/bip324-probe:|^\/topology-probe:|^\/p2p-probe:|^\/probe:|^\/btc-peers:|^\/bip110-observer:/i, 'a network crawler'],
  // Address indexers for wallets: they follow the chain and relay nothing.
  [/electrs|electrum|esplora|\/mempool|^NBXplorer-|^\/symphony:/i, 'an address indexer'],
  [/bitcoinj|breadwallet|\/bread:|bither|multibit|wasabi|Bitcoin Wallet|^\/blueberry:|^\/winnow:|^\/BitcoinKit:|^\/WalletKit:|^\/Ladybug:|^\/hodlwallet:|\/spvwallet:/i, 'a wallet'],
  // Lightning wallets on lnd, which follow the chain through neutrino.
  [/neutrino|\/lit:v/i, 'a Lightning wallet'],
  // Other BIP157 light clients: Kyoto, which says "Rust BIP-157". VerifiedX
  // validators follow the chain the same way for a chain of their own: headers,
  // some blocks, no transactions.
  // EMPORION and its new name SYMMARTYS fetch headers for OpenTimestamps
  // verification (bitcoin_headers.py in alexar76/emporion). Bitflash's
  // wallet loads only headers and filter hashes (docs.bitflash.network).
  [/BIP-157|^\/bip157-fetch:|kyoto|^Yuki \/|^\/VerifiedX:|^\/nakamoto:|^\/bitcoin-s:|^Stacks\/|\/CaribouSPV:|^\/EMPORION:|^\/SYMMARTYS:|^\/Bitflash:btc-light\//i, 'a light client'],
];

// Rules marked 'whole' read the whole agent: a pool or another chain may be
// named in the brackets (the pool rule without the word "mempool"). The rest read only the name outside them - a word
// like "monitor" or "electrs" in an operator's label does not make a Core
// node a crawler or an indexer. The peers service's classify does the same.
// The first rule that names this client, as its place in KIND_RULES, or -1.
function kindRuleIndex(client) {
  if (!client) return -1;
  const bare = client.replace(/\([^)]*\)/g, '');
  // "pool" inside "mempool" is no pool: "(mempool.guide)" is a node's label.
  const noMempool = client.replace(/mempool/gi, '');
  return KIND_RULES.findIndex(([re, , reads]) => re.test(reads === 'whole' ? client : reads === 'no-mempool' ? noMempool : bare));
}
// The rule the ranking marks a peer by when the peers service has no word on it.
const MISSPELT_RULE = 0;

function cannotRelayReason(client) {
  const i = kindRuleIndex(client);
  return i < 0 ? null : KIND_RULES[i][1];
}

// Whether any rule names this client at all. The peer list flags a fork only
// on nodes and unknown software, not on a peer it already named as something
// else (a pool, a misspelt Core), so the ranking asks the same.
const namedByKindRule = (client) => kindRuleIndex(client) >= 0;
const otherChainShown = (p) => (p.otherChain && !namedByKindRule(p.client) ? p.otherChain : null);

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// subver (Client) is fully attacker-controlled - any P2P peer can set an
// arbitrary user-agent string - so it must never go into innerHTML
// unescaped. Applied to address/label too as cheap defense in depth.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}



// A table that does not fit its panel first gives up its least important
// columns, a step at a time (data-drop="1".."4" on the <th>: sessions, then
// session, ping and last the client; for the pools seen/miss, then
// host). Only when even that is too wide does each row turn
// into a small card of its own (see
// .table-wrap.cards in style.css) instead of scrolling sideways - on a phone,
// in practice. Cards came too early before: a laptop window a little narrower
// than usual already broke every table into ragged, wrapping lines.
// Decided by measuring, not by a fixed screen width, and for all tables
// together - one panel as cards and the next as a table looked like two
// different pages. The rows are re-rendered all the time, so the labels are
// put back after every change.
const DROP_LEVELS = 4;


function fitTables() {
  const y = window.scrollY;
  const wraps = [...document.querySelectorAll('.table-wrap')];
  for (const w of wraps) {
    const ths = [...w.querySelectorAll('thead th')];
    for (const tr of w.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        const th = ths[i];
        if (!th || td.dataset.label != null) return;
        // A card has no room for "(last 500)": the value next to it says x/500 anyway.
        // A header may name a shorter label for the card (data-card: "Last").
        td.dataset.label = th.dataset.card || th.textContent.replace(/\s*\(.*\)\s*$/, '').trim();
        const col = [...th.classList].find((c) => c.startsWith('col-'));
        if (col) td.dataset.col = col;
        if (th.dataset.drop) td.dataset.drop = th.dataset.drop;
      });
    }
  }
  // Measuring from scratch means taking the cards away and laying out the full
  // table first: the page shrinks and grows again, and whatever the reader was
  // looking at jumps. That is only needed when the window got wider - a page
  // that needed cards at this width still needs them, and one that needed two
  // columns dropped still needs at least that. Otherwise the check starts
  // where the last one ended.
  const width = document.documentElement.clientWidth;
  const wider = width > fitState.width;
  fitState.width = width;
  if (fitState.cards && !wider) return false;
  // What the reader is looking at: the first heading or row at the top of the
  // window. When the layout changes, that stays where it was - restoring the
  // old scroll position instead threw the reader a screen or more down the
  // moment the tables above turned into taller cards. (The panels opt out of
  // the browser's own scroll anchoring, see .card in style.css.)
  const anchor = window.scrollY > 0
    ? [...document.querySelectorAll('h2, h3, .table-wrap tbody tr')].find((e) => {
      // A hidden element has a rect of zeros.
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.top >= 0;
    })
    : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const before = `${fitState.level}${fitState.cards}`;
  const tight = () => wraps.some((w) => w.clientWidth && w.scrollWidth > w.clientWidth + 1);
  if (wider) for (const w of wraps) w.classList.remove('cards');
  let level = wider ? 0 : fitState.level;
  for (; ; level++) {
    for (const w of wraps) w.dataset.drops = String(level);
    if (level === DROP_LEVELS || !tight()) break;
  }
  const cards = level === DROP_LEVELS && tight();
  for (const w of wraps) w.classList.toggle('cards', cards);
  fitState.level = level;
  fitState.cards = cards;
  if (anchor && anchor.isConnected && before !== `${level}${cards}`) {
    window.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop);
    return true;
  }
  if (window.scrollY !== y) window.scrollTo(0, y);
  return false;
}

// The width of the last check and what it decided. The first check always
// counts as wider, so it measures from scratch.
const fitState = { width: -Infinity, level: 0, cards: false };
let fitTimer = null;
const scheduleFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTables, 50); };
// Rows re-rendered are tables again until fitTables has run: it puts the
// labels back and decides between table and cards after every change.
// A class or attribute matters only where it can change the height of the
// page's content: inside main, and not the beating dot or the bar that rides
// along at the top.
const QUIET = '.live-dot, .stick';
const counts = (m) => m.type === 'childList' || (m.target.closest('main') && !m.target.closest(QUIET));
new MutationObserver((list) => {
  if (list.some(counts)) fitTables();
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] });
// Only a change of width can change whether the tables fit. On an iPhone the
// height changes all the time - Safari's toolbar shrinks and grows while the
// page scrolls - and measuring on each of those threw the reader up the page.
let fitWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === fitWidth) return;
  fitWidth = window.innerWidth;
  scheduleFit();
});
document.addEventListener('toggle', scheduleFit, true);

// Whether a cell is cut off depends on the screen, so it is decided when the
// pointer gets there. A link inside keeps its own hint and gets the full
// value in front of it.
document.addEventListener('mouseover', (e) => {
  const td = e.target.closest && e.target.closest('td[data-full]');
  if (!td) return;
  const cut = td.scrollWidth > td.clientWidth;
  const link = td.querySelector('a[data-tip]');
  if (link) link.title = (cut ? td.dataset.full + '\n' : '') + link.dataset.tip;
  else td.title = cut ? td.dataset.full : '';
});

async function refreshStatus() {
  const askedAt = Date.now();
  const s = await api('/api/status');
  if (s.maxManualPeers) MAX_MANUAL_PEERS = s.maxManualPeers;
  applyStratumEnabled(Boolean(s.stratumRaceEnabled));
  // Folded, the Storage card says how big the database is.
  if (s.dbBytes != null) document.getElementById('storage-total').textContent = fmtBytes(s.dbBytes);
  if (Boolean(s.readOnly) !== readOnly) {
    readOnly = Boolean(s.readOnly);
    document.getElementById('readonly-banner').hidden = !readOnly;
    document.getElementById('rotation-toggle').disabled = readOnly;
    document.querySelector('#manual-add-form button[type="submit"]').disabled = readOnly;
    // The list's buttons are drawn from actionsCell: drawn again without them.
    window.dispatchEvent(new Event('peerlab:ranking'));
  }

  setBlockHeight(s.blockHeight, { at: askedAt, fromCore: true });

  // Until the peer list has its first answer, the tiles show what the
  // profiler counted; from then on the list's own numbers (drawTiles) - and
  // the profiler's again if the list has not drawn for 45 seconds (its
  // service down or failing), rather than numbers frozen without a word.
  if (!listCounts || Date.now() - listCountsAt > LIST_COUNTS_MAX_AGE_MS) {
    drawTiles({ inbound: s.live.inbound, outbound: s.live.outbound - s.live.manual, manual: s.live.manual });
  }
}

// The tiles at the top count the same peers as the list under them, from the
// same answer of Core (window.peerLab.liveCounts): two sources a few seconds
// apart, and one of them counting the short feeler and address-fetch
// connections the list leaves out, made the tiles and the list disagree.
let listCounts = null;
let listCountsAt = 0;
const LIST_COUNTS_MAX_AGE_MS = 45000;
// The last field is the colour strip along the tile's foot, in the group's
// own colour. Outbound leaves out the manual peers, which have a tile of
// their own - as in the peer list, so the three groups add up to the total.
// Full relay and block relay are told apart in the Outbound table below.
function drawTiles({ inbound, outbound, manual }) {
  const stats = [
    ['Total', inbound + outbound + manual, ''],
    ['Inbound', inbound, 'inbound'],
    ['Outbound', outbound, 'outbound'],
    ['Manual', manual, 'manual', `of ${MAX_MANUAL_PEERS}`],
  ];
  document.getElementById('live-stats').innerHTML = stats
    .map(([label, n, k, sub]) => `<div class="stat${k ? ' s-' + k : ''}"><div class="l">${label}</div><div class="n">${n}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`)
    .join('');
}

// Shared by the status poll and the live block event, so whichever learns of
// a new height first can show it. The newer news wins: the poll can be
// answering with the previous height at the moment the event arrives with
// the new one, so an answer asked for before the last event is not taken.
// Only Core's own count, asked for later, may set the number back (a reorg,
// a node set back); an event is the block this app recorded last, and may
// be older than Core's tip.
let heightAt = 0;
function setBlockHeight(height, { at = Date.now(), fromCore = false } = {}) {
  const heightEl = document.getElementById('block-height-number');
  // The height is Core's own getblockcount, so it is there from the first
  // status response - it does not wait for a block. Null means Core did not
  // answer, and until one ever does, the slot says so in small type rather
  // than showing a big dash that reads as a fault in this app. The markup
  // starts as "–" instead: that is the fraction of a second before the first
  // response, which is not the same thing as no answer.
  if (height == null) {
    if (lastKnownHeight == null) {
      heightEl.textContent = 'no answer from Bitcoin Core yet';
      heightEl.classList.add('waiting');
    }
    return;
  }
  if (at < heightAt) return;
  if (!fromCore && lastKnownHeight != null && height < lastKnownHeight) return;
  heightAt = at;

  heightEl.classList.remove('waiting');
  heightEl.textContent = height.toLocaleString('en-US');
  if (lastKnownHeight != null && height > lastKnownHeight) {
    heightEl.classList.remove('bump');
    void heightEl.offsetWidth; // restart the animation
    heightEl.classList.add('bump');
  }
  lastKnownHeight = height;
}

// Who mined the block that just landed. Three states, and the difference
// matters: a pool we recognise gets its name, an unknown miner gets the
// text he wrote into his own coinbase (in quotes, so it never reads as a name
// we are vouching for), and a block that says neither reads Unknown - as on
// mempool.space - once its coinbase has been read.
function setBlockPool(race) {
  const el = document.getElementById('block-pool');
  if (!el) return;
  const known = race && race.pool;
  const raw = race && !known && race.poolTag ? race.poolTag : null;
  const unknown = race && !known && !raw && race.poolSource === 'none';
  el.classList.toggle('raw', Boolean(raw));
  el.textContent = '';
  if (known || raw || unknown) {
    const name = document.createElement('b');
    name.textContent = known ? (race.poolName || race.pool) : raw ? `"${raw}"` : 'Unknown';
    el.append('mined by ', name);
    el.title = known ? `Mined by ${race.poolName || race.pool}, from the block's coinbase`
      : raw ? 'No pool we know of. This is the text the miner wrote into the block.'
        : 'No pool we know of, and no name in the block.';
  } else {
    el.removeAttribute('title');
    // A new block comes without its pool: the coinbase is read a few seconds
    // later. Once the line has been there it keeps its height meanwhile -
    // gone and back, it moved the page twice under a reader at the bottom
    // (iPhone, 04.11.2026).
    if (!el.hidden) el.textContent = '\u00a0';
  }
  if (known || raw || unknown) el.hidden = false;
}

// Called with the payload of a `block` event from /api/events (and once on
// connect with the current state), so this no longer fetches anything.
function applyBlockUpdate(race) {
  if (!race) return;

  // The height rides along on this event. Reading it here is what keeps the
  // big number in step with the wave and the highlighted rows - it used to
  // wait for the next 20-second status poll, so it jumped at a moment
  // unrelated to anything the viewer had just seen. Nullable in the schema
  // (it is backfilled by a separate RPC after the race is recorded), so only
  // set it when it is actually there.
  if (race.blockHeight != null) setBlockHeight(race.blockHeight);
  setBlockPool(race);

  const isNewRace = lastRaceId !== null && race.id !== lastRaceId;
  lastRaceId = race.id;
  // The peer list fetches the block card's block, its star and its wave at
  // once rather than at its next poll: one moment for the head and the card.
  if (race.blockHash) window.dispatchEvent(new CustomEvent('peerlab:block', { detail: race.blockHash }));
  if (!isNewRace) return;

  refreshPeers();
}

// Trusted/manual peers show "Remove" (forgets the peer AND force-disconnects
// it - see peer-sync.js removeTrustedPeer) instead of "Add as Manual", and no
// Disconnect: as long as a peer is still addnode'd, Core reconnects it
// within a minute or two, so a bare Disconnect changed nothing that lasted;
// Core reconnects by itself when a connection really hangs.
//
// Both actions always render into a fixed two-slot layout (primary action,
// then Disconnect) using an empty placeholder - never an omitted element -
// for whichever slot doesn't apply to a given row. Without this, a row
// missing its first slot (e.g. a source-obscured peer with no "Add as
// Manual") would have Disconnect visually collapse into the first slot's
// position instead of staying put, making the column misalign row to row.
// The lock: closed means this peer keeps its slot - a person adding a peer to
// a full set never displaces it, and it is not removed when it goes offline.
// Both the state and the control, because they are the same thing to the
// person looking at it. A lock on its own explains nothing, so the title says
// in words what it does and what clicking will do next.
function keepStar(p) {
  const on = Boolean(p.kept);
  const title = on ? 'Kept - click to release' : 'Click to keep';
  return `<button class="keep-star${on ? ' on' : ''}" data-action="keep" data-address="${escapeHtml(p.address)}" data-kept="${on ? '1' : '0'}" title="${title}" aria-pressed="${on}"><span aria-hidden="true">🔒</span><span class="sr-only">Keep this peer</span></button>`;
}

// A manual peer's Remove takes the second slot, under Disconnect, in every
// list: the red buttons stand in one line, the blue Add as Manual in the
// other. In the manual list the lock sits in the first slot.
function actionsCell(p, { lock = '' } = {}) {
  const placeholder = `<span class="action-slot" aria-hidden="true"></span>`;
  // A read-only copy refuses every change to Core's peers (READ_ONLY in
  // dashboard-server.js), so it offers none: the lock alone, which only
  // marks the row in this app's own table.
  if (readOnly) return (p.trusted && lock ? `<span class="action-slot lock-slot">${lock}</span>` : placeholder) + placeholder;

  // Three kinds of peer have nothing this app can do to them, and all three
  // now look the same here: an empty slot.
  //
  // A source-obscured peer's "address" is Docker's own relay gateway, not the
  // peer's real one (see queries/ranking-row.js). A local Umbrel app is not a peer worth
  // acting on. And a Tor, I2P or CJDNS peer reaches us over a network this
  // container cannot dial out on, so there is no address to call back.
  //
  // The third used to print "Tor only" where the button goes, which was a
  // word about the peer standing in a place that is otherwise a reason, and
  // said Tor twice in a row that already begins "Tor peer". The explanation
  // moved to that cell's own tooltip, which is where someone wondering about
  // the row will already be pointing.
  //
  // What must NOT come back is the button: it used to be offered here and
  // always failed with "no node answering on 8333 or 9333", which reads as
  // though the peer had the wrong port open rather than the truth, which is
  // that this container has no way to reach that network at all.
  const remove = `<button class="secondary danger action-slot" data-action="untrust" data-address="${escapeHtml(p.address)}">Remove</button>`;
  if (p.trusted) return (lock ? `<span class="action-slot lock-slot">${lock}</span>` : placeholder) + remove;
  // A peer that can never deliver a block first ("never first") would only
  // hold a manual slot the rotation then has to free again; a disguised one
  // is not to be trusted with it.
  // The peers service's word where it has one, the name rules otherwise.
  const disguised = p.lion || (p.kind ? p.kind === 'Disguised' : kindRuleIndex(p.client) === MISSPELT_RULE);
  const primary = ((p.sourceObscured || p.localUmbrelPeer || p.privateNetwork || disguised || (neverFirstReason(p) && !p.first))
      ? placeholder
      : `<button class="secondary action-slot" data-action="add-manual" data-address="${escapeHtml(p.address)}">Add as Manual</button>`);

  // Disconnect still works fine for a source-obscured peer: it's exactly
  // the (masked) address Core itself uses internally for the connection.
  // A local Umbrel peer (another app on this same host, e.g. electrs) is
  // different - deliberately disconnecting it could interrupt whatever that
  // app is doing, and Core would likely just let it right back in anyway,
  // so there's no real action to offer there either.
  const canDisconnect = p.live && !p.localUmbrelPeer;
  const disconnect = canDisconnect
    ? `<button class="secondary danger action-slot" data-action="disconnect" data-address="${escapeHtml(p.address)}">Disconnect</button>`
    : placeholder;

  return `${primary}${disconnect}`;
}

// The log is a diary, and a diary is mostly interesting at the end: the four
// most recent rows answer "what changed lately". The rest of what the server
// keeps - thirty - is behind "Show all".
const ROTATION_LOG_LIMIT = 4;
let showAllLog = false; // toggled by #rotation-log-toggle
// A reload keeps what was opened, like the scroll position: "Show all" stays.
const OPENED_KEY = 'opened:' + location.pathname;
try {
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav && (nav.type === 'reload' || nav.type === 'back_forward')) {
    const o = JSON.parse(sessionStorage.getItem(OPENED_KEY) || 'null');
    if (o) showAllLog = !!o.log;
  }
  const keep = () => { try { sessionStorage.setItem(OPENED_KEY, JSON.stringify({ log: showAllLog })); } catch { /* private window */ } };
  window.addEventListener('pagehide', keep);
  document.addEventListener('visibilitychange', () => { if (document.hidden) keep(); });
} catch { /* no storage: nothing to keep */ }

// Smooth scrolling, unless the reader asked the system for less motion.
function glide() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// Folding in place (10.11.2026): what was tapped stays where it is on the
// screen. What opens rolls out downwards and what closes rolls up, gently,
// and the page never jumps - not to bring something into view, not because
// the page got shorter at its end. Every fold on the page goes through here,
// the peer list's too (window.peerLab.foldInPlace): a card, a peer's panel,
// "Show all", a "How it works", so they all behave alike and share one
// runway and one count of folds under way.
//
//   anchor  what stays put (what was tapped, or what is above the change),
//           or a function finding it again: a list rebuilt by the fold
//           replaces the button that was tapped
//   box     what grows or shrinks, the same
//   set     puts the page in the open (true) or closed (false) state
const FOLD_MS = 300;
let folding = 0;
// Run when the last fold under way is over: a refresh that came in while it
// rolled waited for it (here and in the peer list, which adds its own).
const afterFolds = [() => flushDeferredRenders()];
// Room below the page's end while something shrinks there: a page that got
// shorter under the reader would otherwise pull everything down with it. It
// goes as soon as the reader scrolls up far enough not to need it.
let runway = 0;
function setRunway(px) {
  runway = Math.max(0, Math.ceil(px));
  document.body.style.paddingBottom = runway ? `${runway}px` : '';
}
window.addEventListener('scroll', () => {
  if (!runway || folding) return;
  const spare = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
  if (spare > 0) setRunway(runway - spare);
}, { passive: true });

function foldInPlace({ anchor, box, set, open }) {
  const find = (x) => (typeof x === 'function' ? x() : x);
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const a0 = find(anchor);
  if (!a0) { set(open); return; }
  const top0 = a0.getBoundingClientRect().top;
  // To where, not by how much: Safari reports a scroll a frame late, and
  // moving by the difference moved twice and swung back and forth.
  const pin = () => {
    // A row redrawn under the fold is gone from the page and says it is at
    // the top: following it would throw the reader up by a screen.
    const a = find(anchor);
    if (!a || !a.isConnected) return;
    const want = a.getBoundingClientRect().top + window.scrollY - top0;
    if (Math.abs(window.scrollY - want) >= 0.5) window.scrollTo(0, want);
  };
  folding += 1;
  // Room at the end for as much as the box could lose, lent before anything
  // is measured: measuring a page that got shorter is already enough for the
  // browser to pull everything down. When the fold is over, only what the
  // reader still needs stays.
  const lent = runway;
  const b0 = find(box);
  const h0 = b0 ? b0.getBoundingClientRect().height : 0;
  setRunway(lent + h0);
  const giveBack = () => {
    const end = document.documentElement.scrollHeight - runway;
    setRunway(Math.max(lent, window.scrollY + window.innerHeight - end));
  };
  // The place-keeping of a refresh waits a frame more: the last changes of a
  // fold reach it after the fold has pinned the anchor, and it would move the
  // page by the top of the window instead.
  const done = () => { pin(); giveBack(); pin(); requestAnimationFrame(() => {
    pin(); folding -= 1;
    if (!folding) for (const f of afterFolds) setTimeout(f, 0);
  }); };
  // Fitted before it is measured: re-rendered rows are cards only once
  // fitTables has run, and the end of the roll would be off by that.
  const settle = (state) => { set(state); fitTables(); };
  // A fold that fails half way must not leave the page thinking it is
  // still folding: the runway and the place-keeping would stay off.
  try { settle(open); } catch (err) { folding -= 1; throw err; }
  const b1 = find(box);
  const h1 = b1 ? b1.getBoundingClientRect().height : 0;
  // A whole list of peers is tens of thousands of pixels: rolled in a third
  // of a second that rushes past at a screen per frame. That opens and shuts
  // in place at once, the rows fading in.
  const huge = Math.abs(h1 - h0) > window.innerHeight * 1.5;
  if (huge && open && !still && b1 && b1.animate) b1.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  if (still || huge || !b1 || !b1.animate || Math.abs(h1 - h0) < 2) { pin(); done(); return; }
  // Closing rolls up what is still there: back to open for the animation,
  // closed at its end.
  if (!open) settle(true);
  const anim = find(box).animate([{ height: `${h0}px`, overflow: 'hidden' }, { height: `${h1}px`, overflow: 'hidden' }],
    { duration: FOLD_MS, easing: open ? 'cubic-bezier(.2,.7,.3,1)' : 'cubic-bezier(.5,0,.3,1)' });
  let frame = requestAnimationFrame(function follow() { pin(); frame = requestAnimationFrame(follow); });
  anim.onfinish = anim.oncancel = () => {
    cancelAnimationFrame(frame);
    try { if (!open) settle(false); } finally { done(); }
  };
}

let lastRotationLog = null; // kept so "Show all" can open without refetching

// The most recent ranking payload, kept so purely visual changes (the "show
// all" toggle) can re-render from it instead of re-fetching the single most
// expensive endpoint this app has just to slice the same array differently.
let lastPeerRanking = null;

// Several things ask for the ranking at once (the poll, a new block, an
// action just taken); an answer that left before a newer one must not be
// drawn over it - a lock just closed would open again for twenty seconds.
let peerRequestSeq = 0;
async function refreshPeers() {
  const seq = ++peerRequestSeq;
  const peers = await api('/api/peers/ranking');
  if (seq !== peerRequestSeq) return;
  // A peer just removed or disconnected is left out until the server no longer
  // lists it as connected or manual, or the wait is over.
  const now = Date.now();
  for (const [address, at] of justGone) {
    const row = peers.find((p) => p.address === address);
    if (now - at > GONE_MS || !row || (!row.live && !row.trusted)) justGone.delete(address);
  }
  lastPeerRanking = peers;
  rankingByAddress = new Map(peers.map((p) => [p.address, p]));
  window.dispatchEvent(new Event('peerlab:ranking'));
}

// The peer list on this page is drawn by the other script (/peers/app.js).
// It asks here for what only the dashboard knows: a peer's record, and the
// buttons that act on it
// - the same buttons as ever, handled by the click handler below.
let rankingByAddress = new Map();
// A read-only test copy (READ_ONLY=1, from /api/status): no button that
// changes Core's peers.
let readOnly = false;
// Peers with an action under way. The list is redrawn by the other script
// while the request runs, with fresh buttons: they are drawn disabled, and a
// click on one is refused here as well, so no action goes out twice.
const pendingPeers = new Set();
window.peerLab = {
  peer: (address) => rankingByAddress.get(address) || null,
  // Manual peers that are not connected: they still hold their slot, and the
  // list shows them so they can be unlocked or removed.
  offlineManual: () => (lastPeerRanking || []).filter((p) => p.trusted && !p.live && !justGone.has(p.address)),
  // "0 of 8 slots free · all kept", for the head of the manual list.
  manualSummary: () => {
    const manual = (lastPeerRanking || []).filter((p) => p.trusted && !justGone.has(p.address));
    const kept = manual.filter((p) => p.kept).length;
    const free = Math.max(0, MAX_MANUAL_PEERS - manual.length);
    return `${free} of ${MAX_MANUAL_PEERS} slots free` + (kept ? ` \u00b7 ${kept === manual.length ? 'all locked' : `${kept} locked`}` : '');
  },
  // How many peers take new blocks from this node first.
  fedCount: () => (lastPeerRanking || []).filter((p) => p.live && p.hbFrom).length,
  foldsOnTap,
  foldTitle,
  // The peer list's counts of connected peers per group, for the tiles.
  liveCounts: (counts) => { listCounts = counts; listCountsAt = Date.now(); drawTiles(counts); },
  foldInPlace,
  flagOf: (cc) => flagOf(cc),
  fmtDuration: (ms) => fmtDuration(ms),
  fmtMs: (ms) => fmtMs(ms),
  countryName: (cc) => countryName(cc),
  folding: () => folding > 0,
  // Called when the last fold under way is over.
  afterFolds: (f) => { afterFolds.push(f); },
  acting: () => actionsInFlight > 0,
  // Disconnected or removed here a moment ago: not in the list any more.
  gone: (address) => justGone.has(address),
  // The peer list's part of Esc: closes something and says true, or false.
  onEscape: (step) => { escapeSteps.push(step); },
  actionsHtml: (address) => {
    const p = rankingByAddress.get(address);
    if (!p) return '';
    const html = actionsCell(p, { lock: p.trusted ? keepStar(p) : '' });
    return pendingPeers.has(address) ? html.replace(/<button /g, '<button disabled ') : html;
  },
};

// A flag from the two-letter country code: regional-indicator letters, no
// image files; unknown or missing codes get none. Tor an onion, I2P a globe.
// The peer list draws its flags with these too (window.peerLab).
const HIDDEN_FLAG = { TOR: '\u{1F9C5}', I2P: '\u{1F310}' };
const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
let countryNames = null;
function countryName(cc) {
  try {
    countryNames = countryNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return countryNames.of(cc) || cc;
  } catch {
    return cc;
  }
}

// Where a manual peer is, as one more line under its address: flag and
// provider, or Tor / I2P. The rotation spreads the slots by exactly this, so
// it is shown where the slots are. Country and region are in the tooltip.
function placeHtml(w) {
  const flag = HIDDEN_FLAG[w.region] || flagOf(w.country);
  const text = w.country ? (w.operator || countryName(w.country)) : w.regionName;
  return `<span class="flag">${flag}</span>${escapeHtml(text)}`;
}
function withPlaceLine(cell, p) {
  const w = p.where;
  if (!w) return cell;
  const tip = w.country ? `${countryName(w.country)}, ${w.regionName}` : w.regionName;
  return cell.replace(/<\/td>$/, () => `<small class="addr-place" title="${escapeHtml(tip)}">${placeHtml(w)}</small></td>`);
}

/**
 * Re-rendering a table body wholesale destroys whatever the viewer was in the
 * middle of: the keyboard focus (so tabbing restarts at the top), any text
 * selection (so copying an address fails if a poll lands mid-drag) and, worst,
 * a click - if the row is replaced between mousedown and mouseup the browser
 * finds no shared element and fires no click at all, so the button silently
 * does nothing. With "Add as Manual" taking up to six seconds of port probing,
 * a 20-second poll landing inside that window is routine rather than exotic.
 *
 * So: while an action is in flight or the focus is inside one of these tables,
 * hold the newest data instead of rendering it, and render as soon as the
 * interaction is over. Nothing is lost - only the newest snapshot is kept.
 */
let actionsInFlight = 0;
const deferredRenders = new Map();

// A press in progress: a row replaced between mousedown and mouseup gets no
// click. Kept as a time, not a flag, so a press that never ends (released
// outside the window) cannot hold the tables for longer than two seconds.
let pressedAt = 0;
const pressing = () => pressedAt > 0 && Date.now() - pressedAt < 2000;
document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
const pressOver = () => { pressedAt = 0; setTimeout(flushDeferredRenders, 0); };
// On touch the click comes after pointerup, as a task of its own: flush on
// the click, with pointerup only as the fallback when no click follows.
document.addEventListener('click', pressOver);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => setTimeout(() => { if (pressedAt) pressOver(); }, 400), true);
}
window.addEventListener('blur', pressOver);

// A finger on the glass or a page still gliding: a refresh redrawn under it
// moved the rows the reader was following, and the scroll correction that
// keeps their place cut Safari's glide short with a jolt (iPhone, 28.10.2026).
// The newest data waits until the page has been still for half a second.
let touching = 0;
let scrolledAt = 0;
let settleTimer = null;
const moving = () => (touching > 0 && Date.now() - touching < 15000) || Date.now() - scrolledAt < 500;
const settle = () => {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => (moving() ? settle() : flushDeferredRenders()), 520);
};
window.addEventListener('touchstart', () => { touching = Date.now(); }, { passive: true, capture: true });
for (const type of ['touchend', 'touchcancel']) {
  window.addEventListener(type, () => { touching = 0; settle(); }, { passive: true, capture: true });
}
window.addEventListener('scroll', () => { scrolledAt = Date.now(); settle(); }, { passive: true });

let selectedSince = 0;
function interactionInProgress(selector) {
  if (actionsInFlight > 0 || folding > 0 || pressing() || moving()) return true;
  // Text being selected in this table - an address to copy - is not redrawn
  // from under the reader, as in the peer list; for half a minute at most. A
  // selection elsewhere, or one left standing in an open tab, froze every
  // table with no sign that it was stale (review 11.11.2026).
  const sel = window.getSelection && window.getSelection();
  if (sel && String(sel).length && sel.anchorNode) {
    const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    if (el && el.closest && el.closest(selector)) {
      if (!selectedSince) selectedSince = Date.now();
      if (Date.now() - selectedSince < 30000) return true;
    } else selectedSince = 0;
  } else selectedSince = 0;
  // Keyboard focus only. A mouse click leaves the focus on the button in
  // Chrome, and the tables then stayed frozen until a click elsewhere.
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest(selector) && active.matches(':focus-visible'));
}

function deferRender(key, selector, render) {
  if (interactionInProgress(selector)) {
    deferredRenders.set(key, render);
    return true;
  }
  deferredRenders.delete(key);
  return false;
}

function flushDeferredRenders() {
  if (deferredRenders.size === 0) return;
  const pending = [...deferredRenders.values()];
  deferredRenders.clear();
  for (const render of pending) render();
}

document.addEventListener('focusout', () => {
  // After focus actually lands somewhere else, not while it is in transit.
  setTimeout(flushDeferredRenders, 0);
});
// A selection let go of: what waited for it is drawn now, not at the next update.
document.addEventListener('selectionchange', () => {
  if (deferredRenders.size && !String(window.getSelection()).length) setTimeout(flushDeferredRenders, 0);
});

// A peer that cannot deliver a block - software that does not relay, or a
// peer that offers no services at all, whatever it calls itself - reads
// "never first", and gets no "Add as Manual". The peer list marks the same
// peers with ⊘.
function neverFirstReason(p) {
  const own = cannotRelayReason(p.client) || (p.offersNothing ? 'it offers no services' : null);
  // The peers service's word where it has one, for a connected peer - the
  // same word the peer list shows: a "wallet" that offers blocks is a
  // disguise that may well pass them on, whatever its name says, and the
  // chain is the one it found.
  if (p.kind) {
    if (p.fork) return `it is on a chain of its own (${p.fork}), not yours`;
    return p.noRelay ? own || 'its software passes no blocks on' : null;
  }
  // Without it - not connected, or the peers service is down - by name and
  // service bits, as recorded.
  const chain = otherChainShown(p) ? `it is on a chain of its own (${otherChainShown(p)}), not yours` : null;
  return own || chain;
}

// A row's buttons show when the row is opened - a tap, like a row in the
// peer list - or, with a mouse, while the pointer is over it. Four hundred rows
// with two buttons each was a wall of red and blue on a phone (28.10.2026).
// One row open at a time; it is known by table and peer, so a refresh that
// rebuilds the rows keeps it open.
let openRow = null;
const rowId = (tr) => `${tr.closest('table').id} ${tr.dataset.key}`;
function markOpenRow() {
  for (const tr of document.querySelectorAll('tr.can-act')) {
    const open = rowId(tr) === openRow;
    tr.classList.toggle('open', open);
    tr.setAttribute('aria-expanded', String(open));
  }
}
function toggleRow(tr) {
  const id = rowId(tr);
  foldInPlace({ anchor: tr, box: tr, open: openRow !== id, set: (open) => { openRow = open ? id : null; markOpenRow(); } });
}
document.addEventListener('click', (e) => {
  const tr = e.target.closest && e.target.closest('tr.can-act');
  if (!tr || e.target.closest('button, a, input, label, select')) return;
  // A drag to select an address is not a tap.
  if (String(window.getSelection && window.getSelection()).length) return;
  toggleRow(tr);
});
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches || !e.target.matches('tr.can-act')) return;
  e.preventDefault();
  toggleRow(e.target);
});

// `force` skips the defer gate. That gate exists to stop a background poll
// destroying an interaction in progress - but the show-all toggle IS the
// interaction, and it was being blocked by it: "Add as Manual" holds
// actionsInFlight for up to six seconds of port probing, during which the
// button did nothing. Worse, a second click (the natural response) flipped the
// flag back and overwrote the deferred closure, so the button then did nothing
// at all. A user-initiated, purely local re-render must never be deferred.
// A peer just removed or disconnected stays in the server's data until the
// next connection snapshot (every 15 s) - up to half a minute with the page's
// own refresh. Leave it out of the tables straight away; once the server no
// longer lists it as connected or manual, forget it. If it is still there
// after the wait (the disconnect did not take), it shows again.
const GONE_MS = 40000;
// The page asks again just after Core's next connection snapshot has landed.
const GONE_RECHECK_MS = 17000;
const justGone = new Map(); // address -> time it was removed or disconnected
const recheckGone = () => setTimeout(() => refreshPeers().catch(() => {}), GONE_RECHECK_MS);

// A counter, not a flag. A boolean only covered the time the POST was in
// flight, which left the real race wide open: a GET /api/rotation issued
// *before* the click comes back *after* the POST, carrying the pre-click
// value, and puts the checkbox back. The viewer then sees a green "rotation
// turned on" toast next to an unchecked box, while the server has it on - and
// the obvious reaction, clicking again, genuinely turns it off. Comparing the
// counter across the await discards any response that was already in flight
// when the state changed.
let rotationToggleEpoch = 0;

// Only ever the actions this app writes, and only as a class name from a fixed
// list. This was the single place in the file where a value went into
// innerHTML - into a class attribute AND the text - without escaping. Nothing
// a Bitcoin peer controls can reach it today, which is exactly the kind of
// reasoning that stops being true after a refactor.
const ROTATION_ACTIONS = new Set(['promote', 'retire', 'manual', 'unmanual', 'disconnect']);
function rotationActionClass(action) {
  return ROTATION_ACTIONS.has(action) ? `rotation-${action}` : 'offline';
}

function rotationActionLabel(action) {
  // From Core's address book into a free slot, and Core connected to it.
  if (action === 'promote') return 'Added';
  // Offline past its grace: the slot is free for the next candidate.
  if (action === 'retire') return 'Removed';
  if (action === 'manual') return 'Added by hand';
  if (action === 'unmanual') return 'Removed by hand';
  if (action === 'disconnect') return 'Disconnected by hand';
  return action;
}

async function refreshRotation() {
  const epochAtRequest = rotationToggleEpoch;
  const data = await api('/api/rotation');
  const toggle = document.getElementById('rotation-toggle');
  if (toggle && rotationToggleEpoch === epochAtRequest) toggle.checked = Boolean(data.enabled);
  foldSums();

  lastSlotStatus = { enabled: Boolean(data.enabled), status: data.status || null };
  renderSlotStatus();
  lastRotationLog = data.log || [];
  renderRotationLog(lastRotationLog);
}

// What Slot Fill is doing, in a sentence or two a person reads, from its last
// check (the server's status, written by the pass itself). Times move on
// between two fetches of it, so the line is drawn again every half minute.
let lastSlotStatus = null;
const minutes = (ms) => (ms < 90 * 1000 ? '1 min' : ms < 90 * 60 * 1000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 3600000)} h`);
function slotStatusText(st, now) {
  if (!st) return { state: 'new', head: 'Starting.', rest: 'Looking at your slots now.', short: 'on · starting' };
  const slots = st.slots || { used: 0, max: MAX_MANUAL_PEERS, offline: [] };
  const free = slots.max - slots.used;
  switch (st.state) {
    case 'core':
    case 'catching_up':
      return { state: 'core', head: 'Waiting for Bitcoin Core', rest: st.state === 'core' ? 'to respond.' : 'to catch up with the chain.', short: 'on · waiting for Core' };
    case 'trial': {
      const t = st.trial;
      const where = t.country ? countryName(t.country) : t.region;
      const doing = { connecting: 'Core is connecting to it.', headers: 'Connected, waiting for its first block.', checking: 'Connected, checking it.' }[t.phase] || 'Core is testing it.';
      return {
        state: 'trial',
        head: `Testing a new peer${where ? ` in ${escapeHtml(where)}` : ''}.`,
        rest: `${doing} Result in about ${minutes(Math.max(60000, t.decideBy - now))}.`,
        short: 'on · testing a peer',
      };
    }
    case 'full': {
      const off = slots.offline || [];
      const peerIn = (o) => (o.where ? `Your peer in ${escapeHtml(o.where)}` : 'One peer');
      const rest = off.length
        ? off.map((o) => (o.keeps ? `${peerIn(o)} is offline, but locked, so it keeps its slot.`
          : o.freesInMs == null ? `${peerIn(o)} is offline.`
          : `${peerIn(o)} is offline and frees its slot in about ${minutes(o.freesInMs)} if it doesn't come back.`)).join(' ')
        : 'Slot Fill adds a peer as soon as one becomes free.';
      return { state: 'full', head: `All ${slots.max} slots are in use.`, rest, short: 'on · all slots in use' };
    }
    default: {
      const l = st.look || {};
      const again = st.nextAt > now ? `Trying again in ${minutes(st.nextAt - now)}.` : 'Trying again shortly.';
      const why = {
        no_book: "Core's address book has no peers to offer yet.",
        no_network: 'Core has no outgoing connection yet to pick a network from.',
        core: 'Bitcoin Core did not respond.',
        refused: "Core didn't take the last peers it was offered.",
      }[l.why] || 'No peer from a missing region found yet.';
      return { state: 'looking', head: `${free} slot${free === 1 ? '' : 's'} free.`, rest: `${why} ${again}`, short: `on · ${free} slot${free === 1 ? '' : 's'} free` };
    }
  }
}
function renderSlotStatus() {
  const box = document.getElementById('slot-status');
  if (!box || !lastSlotStatus) return;
  box.hidden = !lastSlotStatus.enabled;
  if (!lastSlotStatus.enabled) return;
  const t = slotStatusText(lastSlotStatus.status, Date.now());
  box.dataset.state = t.state;
  document.getElementById('slot-now').innerHTML = `<b>${t.head}</b> ${t.rest}`;
  foldSums();
}
setInterval(renderSlotStatus, 30 * 1000);

// Just switched on: the first check runs within seconds (peer-profiler.js),
// so the card asks for it every few seconds until it is there - a minute at
// most - instead of waiting for the slow round.
function watchFirstCheck() {
  let tries = 0;
  const look = async () => {
    tries += 1;
    try { await refreshRotation(); } catch { /* the slow round tries again */ }
    if (lastSlotStatus && lastSlotStatus.enabled && !lastSlotStatus.status && tries < 15) setTimeout(look, 4000);
  };
  setTimeout(look, 3000);
}

// Where a peer is, in the words of a peer card: its country with the flag,
// or the network it came by when the place is not known.
function logPlace(entry) {
  const w = entry.where;
  if (w && w.country) return `<span class="flag">${flagOf(w.country)}</span>${escapeHtml(countryName(w.country))}`;
  if (w && HIDDEN_FLAG[w.region]) return `<span class="flag">${HIDDEN_FLAG[w.region]}</span>${escapeHtml(w.regionName)}`;
  const a = entry.address;
  const net = /\.onion/.test(a) ? 'Tor' : /\.i2p/.test(a) ? 'I2P' : a.startsWith('[') ? 'IPv6' : 'IPv4';
  const flag = HIDDEN_FLAG[net.toUpperCase()];
  return flag ? `<span class="flag">${flag}</span>${net}` : net;
}

// A table row on a wide screen, where the place goes under the address as
// for the manual peers above; on a phone a card like a peer's (the last
// cell, hidden in the table): place and action, then address, why and when.
function rotationEntryRow(entry) {
  // An address can be long (Tor): cut with an ellipsis, the whole of it in a
  // tooltip only when it was cut (the mouseover handler below).
  const addr = `<span class="addr-txt">${escapeHtml(entry.address)}</span>`;
  const address = withPlaceLine(`<td class="cell-truncate" data-full="${escapeHtml(entry.address)}">${addr}</td>`, entry);
  const pill = `<span class="pill ${rotationActionClass(entry.action)}">${escapeHtml(rotationActionLabel(entry.action))}</span>`;
  const when = `${fmtDuration(Date.now() - entry.at)} ago`;
  const why = entry.note ? ` \u00b7 ${escapeHtml(entry.note)}` : '';
  return `
    <tr>
      <td class="hint" title="${escapeHtml(new Date(entry.at).toLocaleString())}">${when}</td>
      <td>${pill}</td>
      ${address}
      <td class="hint"${entry.replacedAddress ? ` title="In for ${escapeHtml(entry.replacedAddress)}"` : ''}>${escapeHtml(entry.note || '-')}</td>
      <td class="log-card" data-label=""><div class="lc-top"><span class="lc-place">${logPlace(entry)}</span>${pill}</div><div class="lc-sub"><span class="lc-what">${addr}${why}</span><span class="lc-when">${when}</span></div></td>
    </tr>`;
}

function renderRotationLog(log) {
  const tbody = document.querySelector('#rotation-log-table tbody');
  if (!tbody) return;

  const visible = showAllLog ? log : log.slice(0, ROTATION_LOG_LIMIT);
  tbody.innerHTML = visible.map((e) => rotationEntryRow(e)).join('')
    || `<tr><td colspan="4" class="hint">Nothing yet.</td></tr>`;

  const toggle = document.getElementById('rotation-log-toggle');
  if (toggle) {
    toggle.hidden = log.length <= ROTATION_LOG_LIMIT;
    toggle.textContent = showAllLog ? `Show latest ${ROTATION_LOG_LIMIT} only` : `Show all ${log.length}`;
  }
}

/**
 * Show the Stratum Race card as running or as off.
 *
 * Everything below the switch is hidden rather than greyed out, because
 * switched off there is nothing behind it that is still true: no pool is
 * connected and no race is being timed, so a table of numbers would be a
 * reading from an instrument that is not plugged in.
 *
 * Skipped while the switch has focus, so a poll landing between the click and
 * the server's answer cannot flip it back under the user's finger - the same
 * problem the pool table solves with deferRender.
 */
function applyStratumEnabled(enabled) {
  const toggle = document.getElementById('stratum-toggle');
  if (!toggle) return;
  if (document.activeElement !== toggle) toggle.checked = enabled;
  foldSums();
  const body = document.getElementById('stratum-body');
  if (body) body.hidden = !enabled;
  const noMiner = document.getElementById('pool-no-miner');
  if (noMiner) noMiner.hidden = enabled;
}

async function refreshPools() {
  // Nothing to ask for while it is off, and nowhere to put the answer.
  if (document.getElementById('stratum-body')?.hidden) return;
  const range = document.querySelector('#stratum-range button.on')?.dataset.range || '10';
  // First, and on its own: the quick-fill buttons need the templates even if
  // the pool list below fails to load.
  refreshLocalPools();
  const pools = await api(`/api/pools?range=${encodeURIComponent(range)}`);
  renderPools(pools);
}

function renderPools(pools) {
  // This table owns the enabled checkboxes, and a poll landing on a
  // just-clicked one puts it straight back.
  if (deferRender('pools', '#pool-table', () => renderPools(pools))) return;
  const tbody = document.querySelector('#pool-table tbody');
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="hint">No pools yet.</td></tr>';
    foldSums();
    return;
  }
  tbody.innerHTML = pools.map((p) => `
    <tr data-key="pool:${p.id}" tabindex="0" class="can-act${p.enabled ? '' : ' pool-off'}">
      <td><b>${escapeHtml(p.label)}</b>${p.wonLastRace ? ' <span class="trophy" title="Won the most recent race">🏆</span>' : ''}${p.enabled ? '' : ' <span class="off-tag">Off</span>'}</td>
      <td class="client">${escapeHtml(`${p.host}:${p.port}`)}</td>
      <td><b>${p.wins}</b></td>
      <td>${fmtPct(p.winPct)}</td>
      <td>${fmtMs(p.lastMs)}</td>
      <td>${fmtMs(p.avgMs)}</td>
      <td>${p.seen}</td>
      <td>${p.misses}</td>
      <td class="pool-enabled">
        <label class="switch-label"><input type="checkbox" data-action="toggle-pool" data-id="${p.id}" ${p.enabled ? 'checked' : ''} /><span class="sr-only">Enabled</span></label>
      </td>
      <td><button class="secondary danger" data-action="delete-pool" data-id="${p.id}">Remove</button></td>
    </tr>
  `).join('');
  markOpenRow();
  foldSums();
}

// The legend and the explanations fold shut again with a tap anywhere on
// them, not only on their title: on a phone the title has scrolled away by
// then, and it comes back into view.
// Only the panels': the block card's folds belong to the other script.
for (const box of document.querySelectorAll('.panel details.how')) {
  box.addEventListener('click', (e) => {
    if (!box.open || e.target.closest('summary, a, button, input')) return;
    if (String(window.getSelection()).length > 0) return;
    // Its title on screen: it rolls up into it, in place. Scrolled away: shut
    // at once, and the title comes back to the top of the screen.
    const summary = box.querySelector(':scope > summary');
    if (summary.getBoundingClientRect().top >= 0) {
      foldInPlace({ anchor: summary, box, open: false, set: (open) => { box.open = open; } });
      return;
    }
    box.open = false;
    const top = box.getBoundingClientRect().top;
    if (top < 0) window.scrollBy(0, top - 8);
  });
}

// ---------------------------------------------------------------------------
// Traffic

// Grid labels are round numbers, so they get no decimals: "15 GB", not "15.00 GB".
// Steps of 1000, like the totals and every other byte count on the page.
function axisBytes(v, unit) {
  if (v === 0) return '0';
  const name = { 1: 'B', 1000: 'kB', [1000 ** 2]: 'MB', [1000 ** 3]: 'GB', [1000 ** 4]: 'TB' }[unit] || 'B';
  const n = v / unit;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${name}`;
}

// Bars per UTC day, as in the approved design: sent as a rounded orange bar,
// received in blue in front of it, on one scale so the two compare by eye.
// The grid keeps its values, quietly; each day says its numbers on hover.
// Drawn at the size it is shown, in pixels: a fixed 1300-wide picture scaled
// down to a phone made its 11px labels 3px, and scaled-up labels then no
// longer fitted beside the axis.
function trafficChartSvg(days, W) {
  const H = W < 600 ? 170 : 220, top = 14, base = H - 20;
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent || 0, d.recv || 0)));
  // A round step for the grid: 1, 2 or 5 times a unit.
  const unit = 1000 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1000)));
  const raw = max / unit / 3;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= raw) * unit;
  const top_ = Math.ceil(max / step) * step;
  const y = (v) => base - (base - top) * (v / top_);
  const left = 10 + 6.5 * Math.max(...[0, step, top_].map((v) => axisBytes(v, unit).length));
  const slot = (W - left) / days.length;
  // A date label every 5 days, or every 10 where 5 would run into each other.
  const every = slot * 5 >= 44 ? 5 : 10;
  const bw = slot * 0.64;
  let g = '<defs><linearGradient id="traffic-sent" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb04a"/><stop offset="1" stop-color="#c26a06"/></linearGradient></defs>';
  for (let v = 0; v <= top_ + 1; v += step) {
    g += `<line class="grid" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${escapeHtml(axisBytes(v, unit))}</text>`;
  }
  days.forEach((d, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    if (d.sent != null) {
      const tip = `<title>${escapeHtml(`${d.day}: ↑ ${fmtBytes(d.sent)} · ↓ ${fmtBytes(d.recv)}`)}</title>`;
      g += `<rect class="sent" x="${x}" y="${y(d.sent)}" width="${bw}" height="${base - y(d.sent)}" rx="3">${tip}</rect>`;
      g += `<rect class="recv" x="${x}" y="${y(d.recv)}" width="${bw}" height="${base - y(d.recv)}" rx="2">${tip}</rect>`;
    }
    const last = i === days.length - 1;
    if ((i % every === 0 && days.length - 1 - i >= every / 2) || last) {
      // The newest date ends at the right edge rather than past it.
      g += `<text class="axis" x="${last ? W : left + i * slot + slot / 2}" y="${H - 4}" text-anchor="${last ? 'end' : 'middle'}">${escapeHtml(d.day.slice(5))}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

async function refreshTraffic() {
  const t = await api('/api/traffic');
  // The arrows carry the colours of the bars, so they are the legend too.
  const arrows = (v) => `<span class="up">↑ ${escapeHtml(fmtBytes(v.sent))}</span><span class="down">↓ ${escapeHtml(fmtBytes(v.recv))}</span>`;
  document.getElementById('traffic-sum').textContent = t.since ? `today ↑ ${fmtBytes(t.today.sent)} ↓ ${fmtBytes(t.today.recv)}` : '';
  document.getElementById('traffic-totals').innerHTML = t.since
    ? [['Today', t.today], ['Last 7 days', t.week], ['Last 30 days', t.month]]
      .map(([l, v]) => `<div class="t"><div class="l">${l}</div><div class="v">${arrows(v)}</div></div>`)
      .join('')
    : '<p class="hint">Nothing recorded yet - the first numbers appear within an hour of the app starting.</p>';
  lastTrafficDays = t.since ? t.days : null;
  drawTrafficChart();
}

let lastTrafficDays = null;
function drawTrafficChart() {
  const el = document.getElementById('traffic-chart');
  if (!el) return;
  el.innerHTML = lastTrafficDays && el.clientWidth ? trafficChartSvg(lastTrafficDays, el.clientWidth) : '';
}
let trafficWidth = 0;
window.addEventListener('resize', () => {
  const el = document.getElementById('traffic-chart');
  if (!el || el.clientWidth === trafficWidth) return;
  trafficWidth = el.clientWidth;
  drawTrafficChart();
});

async function refreshAll() {
  // Block updates are not in here: they arrive on their own via the
  // /api/events stream, not by polling. Rotation is not in here either - it
  // only ever changes on its own ten-minute tick, so it has its own, much
  // slower schedule (see startRefreshLoop).
  const results = await Promise.allSettled([
    refreshStatus(), refreshPeers(), refreshPools(), refreshHealth(),
  ]);
  // A failed refresh used to be completely invisible: allSettled swallowed
  // the rejection, nothing was logged, and the tables simply kept showing
  // whatever they had - hours-old numbers presented exactly like fresh ones.
  const failed = results.filter((r) => r.status === 'rejected');
  foldSums();
  reportRefreshHealth(failed.map((r) => r.reason));
}


// Two consecutive failed rounds before saying anything: a single miss during
// a container restart or a brief RPC hiccup is normal and self-corrects on
// the next pass, and a banner that cries wolf gets ignored when it matters.
let consecutiveFailedRefreshes = 0;
function reportRefreshHealth(errors) {
  const banner = document.getElementById('refresh-banner');
  if (!banner) return;
  if (errors.length === 0) {
    consecutiveFailedRefreshes = 0;
    banner.hidden = true;
    return;
  }
  consecutiveFailedRefreshes += 1;
  console.warn('dashboard refresh failed', errors);
  if (consecutiveFailedRefreshes < 2) return;
  banner.hidden = false;
  banner.textContent = `The dashboard has not been able to refresh for ${consecutiveFailedRefreshes} rounds (${errors[0].message}). The numbers below are stale.`;
}

// A client-side slice of the log already in hand, as for the live peers.
document.getElementById('rotation-log-toggle').addEventListener('click', (e) => {
  const opening = !showAllLog;
  const wrap = document.getElementById('rotation-log-table').closest('.table-wrap');
  foldInPlace({ anchor: opening ? wrap : e.currentTarget, box: wrap, open: opening, set: (all) => {
    showAllLog = all;
    if (lastRotationLog) renderRotationLog(lastRotationLog);
  } });
});

// A tap anywhere on a card folds it or opens it, not only on its title, the
// same on every card (12.11.2026). What does something of its own keeps it:
// buttons, links, fields, the peer rows, a fold inside the card, the map.
// Selecting text folds nothing, and neither does a tap on something a redraw
// has just taken off the page.
const OWN_TAP = 'a, button, input, select, textarea, label, summary, details, .fold-title, [role="button"], tbody, svg, .map-wrap, .unplaced';
// A card's title folds it, through a real button inside the heading: the
// heading stays a heading to a screen reader, and the button is reached with
// Tab and pressed with Enter or Space like any other. Returns the button, for
// its aria-expanded.
function foldTitle(title) {
  title.classList.add('fold-title');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fold-btn';
  btn.append(...title.childNodes);
  title.append(btn);
  return btn;
}

function foldsOnTap(card, flip) {
  card.addEventListener('click', (e) => {
    if (!card.contains(e.target)) return;
    const own = e.target.closest(OWN_TAP);
    if (own && own !== card) return;
    if (String(window.getSelection()).length > 0) return;
    flip(e);
  });
}

// Every card folds to its title on a tap and stays so on this device: open
// unless the reader closed it (28.10.2026). Storage keeps its own <details>.
const FOLD_KEY = 'peerlab.panelsFolded';
const folded = (() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } })();
// The card was called Manual Slot Fill until 10.11.2026: folded under that
// name, it stays folded under the new one.
if (folded.delete('Manual Slot Fill')) folded.add('Slot Fill');
for (const card of document.querySelectorAll('main > section.panel')) {
  const title = card.querySelector(':scope > h2');
  if (!title) continue;
  const id = card.id || title.firstChild.textContent.trim();
  const btn = foldTitle(title);
  const show = () => {
    foldSums();
    card.classList.toggle('folded', folded.has(id));
    btn.setAttribute('aria-expanded', String(!folded.has(id)));
  };
  const flip = (e) => {
    if (e.target.closest('a, input, button:not(.fold-btn)')) return;
    // What is on screen: a card opened for a peer link is open, whatever the
    // stored state says.
    const opening = card.classList.contains('folded');
    foldInPlace({ anchor: title, box: card, open: opening, set: (open) => {
      if (open) folded.delete(id); else folded.add(id);
      show();
    } });
    // Kept as the reader left it, not as it is half way: closing rolls up
    // from open and is folded only at the end.
    if (opening) folded.delete(id); else folded.add(id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* private window */ }
    if (opening) window.dispatchEvent(new Event('resize')); // the traffic chart measures its width
  };
  title.addEventListener('click', flip);
  foldsOnTap(card, flip);
  show();
}
{
  const storage = document.getElementById('storage-card');
  foldsOnTap(storage, () => foldInPlace({ anchor: storage.querySelector(':scope > summary'), box: storage,
    open: !storage.open, set: (open) => { storage.open = open; } }));
}

// A folded card still says the one thing worth knowing about it, beside its
// title: the switches and how many pools race. Traffic writes its own.
function foldSums() {
  const rot = document.getElementById('rotation-toggle');
  // Folded, the card says what Slot Fill is doing in a few words.
  document.getElementById('rotation-sum').textContent = !rot.checked ? 'off'
    : lastSlotStatus && lastSlotStatus.enabled ? slotStatusText(lastSlotStatus.status, Date.now()).short : 'on';
  const pools = document.querySelectorAll('#pool-table input[data-action="toggle-pool"]:checked').length;
  document.getElementById('stratum-sum').textContent = document.getElementById('stratum-toggle').checked
    ? `on · ${pools} ${pools === 1 ? 'pool' : 'pools'}` : 'off';
}

// Add and Test share the same input and the same result line, and both take
// seconds (a version probe against each candidate port, with a 3s timeout
// each), so both disable the form while they run - otherwise a second click
// starts a second probe against the same address and the two results
// overwrite each other in whichever order they happen to finish.
function manualAddBusy(busy, message) {
  const resultEl = document.getElementById('manual-add-result');
  document.getElementById('manual-test-button').disabled = busy;
  document.querySelector('#manual-add-form button[type=submit]').disabled = busy || readOnly;
  resultEl.className = busy ? 'hint' : resultEl.className;
  if (message != null) resultEl.textContent = message;
}

function manualAddResult(text, kind) {
  const resultEl = document.getElementById('manual-add-result');
  resultEl.textContent = text;
  resultEl.className = kind === 'error' ? 'hint result-error' : 'hint result-ok';
}

document.getElementById('manual-test-button').addEventListener('click', async () => {
  const input = document.getElementById('manual-add-input');
  if (!input.value.trim()) return;
  manualAddBusy(true, 'testing…');
  try {
    const result = await api('/api/peers/probe', { method: 'POST', body: JSON.stringify({ host: input.value }) });
    // Naming the port is the useful half of the answer for an inbound peer:
    // it is the port that peer's node actually listens on, which is never the
    // one its inbound connection to us came from.
    manualAddResult(`reachable - a node answered at ${result.address}. Nothing was added.`, 'ok');
  } catch (err) {
    manualAddResult(`not reachable - ${err.message}`, 'error');
  } finally {
    manualAddBusy(false);
  }
});

document.getElementById('manual-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('manual-add-input');
  manualAddBusy(true, 'connecting…');
  try {
    const result = await api('/api/peers/manual-add', { method: 'POST', body: JSON.stringify({ host: input.value }) });
    justGone.delete(result.address);
    manualAddResult(result.warning ? `added ${result.address} - ${result.warning}` : `added ${result.address}`, 'ok');
    input.value = '';
    refreshPeers();
    refreshRotation();
  } catch (err) {
    manualAddResult(err.message, 'error');
  } finally {
    manualAddBusy(false);
  }
});

document.getElementById('pool-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('pool-label');
  const host = document.getElementById('pool-host');
  const port = document.getElementById('pool-port');
  const resultEl = document.getElementById('pool-add-result');
  // One request at a time: a double click added the pool, then failed on it.
  const submit = e.target.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  clearTimeout(poolResultTimer);
  try {
    await api('/api/pools', {
      method: 'POST',
      body: JSON.stringify({ label: label.value, host: host.value, port: Number(port.value) }),
    });
    resultEl.textContent = 'added';
    label.value = ''; host.value = ''; port.value = '';
    refreshPools();
    poolResultTimer = setTimeout(() => { resultEl.textContent = ''; }, 5000);
  } catch (err) {
    resultEl.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});
let poolResultTimer = null;

// Each action only refreshes the table(s) it can actually affect, rather
// than re-fetching /api/status, /api/peers/ranking, /api/pools and
// /api/blocks/latest on every single click - those already refresh on
// their own schedule (REFRESH_MS above) or arrive on the event stream.
const PEER_ACTIONS = new Set(['add-manual', 'untrust', 'disconnect', 'keep']);
const POOL_ACTIONS = new Set(['delete-pool']);

// A successful "Add as Manual" used to give ZERO on-screen feedback: the
// peer just silently moved out of the Outbound table into the Manual Peers
// panel on the next refresh. If you weren't looking at that panel, it
// looked exactly like the button did nothing at all - even though it
// worked. This toast makes every row action (pending -> success/error)
// explicit and visible, wherever on the page you're looking.
let toastTimer = null;
function showToast(message, kind) {
  const el = document.getElementById('action-toast');
  clearTimeout(toastTimer);
  el.textContent = message;
  el.className = `action-toast ${kind}`;
  el.hidden = false;
  if (kind !== 'pending') {
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 9000 : 5000);
  }
}

// Quick-fill for the solo pools available in the Umbrel app store. The list,
// with the container name and internal stratum port of each and why those
// differ from what a miner on the LAN uses, lives in src/lib/local-pools.js;
// /api/pools/local hands it over together with which of them are installed.
// The buttons are always there - a pool declined in the "found" note below
// can still be added any time.
let localPoolTemplates = {};

// Pools found on this Umbrel and not yet added are offered once, until the
// user adds or declines them. Declined ones are remembered in this browser
// only; the quick-fill buttons stay either way.
const POOLS_DISMISSED_KEY = 'lab.localPoolsDismissed';
function dismissedPools() {
  try { return new Set(JSON.parse(localStorage.getItem(POOLS_DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
let foundPools = [];
// "A", "A and B", "A, B and C"
function listLabels(labels) {
  return labels.length < 3 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

async function refreshLocalPools() {
  let list;
  try { list = await api('/api/pools/local'); } catch { return; }
  localPoolTemplates = Object.fromEntries(list.map((p) => [p.key, p]));
  const dismissed = dismissedPools();
  foundPools = list.filter((p) => p.installed && !p.added && !dismissed.has(p.key));
  const box = document.getElementById('pool-found');
  if (!box) return;
  box.hidden = foundPools.length === 0;
  if (foundPools.length) {
    document.getElementById('pool-found-text').textContent =
      `Found on this Umbrel: ${foundPools.map((p) => p.label).join(', ')}.`;
  }
}

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, address, id, template } = btn.dataset;

  if (action === 'add-found-pools') {
    btn.disabled = true;
    const added = [];
    for (const p of foundPools) {
      try {
        await api('/api/pools', { method: 'POST', body: JSON.stringify({ label: p.label, host: p.host, port: p.port }) });
        added.push(p);
      } catch (err) {
        showToast(`Could not add ${p.label}: ${err.message}`, 'error');
      }
    }
    btn.disabled = false;
    // Offered once: a pool added here and removed later is not offered again.
    // One that could not be added stays on offer.
    const dismissed = dismissedPools();
    added.forEach((p) => dismissed.add(p.key));
    try { localStorage.setItem(POOLS_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch { /* private window */ }
    if (added.length) showToast(`Added ${listLabels(added.map((p) => p.label))} to Stratum Race.`, 'success');
    await refreshLocalPools();
    refreshPools();
    return;
  }
  if (action === 'dismiss-found-pools') {
    const dismissed = dismissedPools();
    foundPools.forEach((p) => dismissed.add(p.key));
    try { localStorage.setItem(POOLS_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch { /* private window: shows again next time */ }
    document.getElementById('pool-found').hidden = true;
    return;
  }
  if (action === 'fill-pool-template') {
    if (!localPoolTemplates[template]) await refreshLocalPools();
    const t = localPoolTemplates[template];
    if (!t) return;
    document.getElementById('pool-label').value = t.label;
    document.getElementById('pool-host').value = t.host;
    document.getElementById('pool-port').value = t.port;
    // DATUM hands out no work until it has a payout address (Umbrel's own
    // setup notes for the app), the other four run as installed (theirs):
    // said here, or DATUM's misses look like a fault.
    document.getElementById('pool-add-result').textContent = template === 'datum'
      ? 'The other pool apps work straight away. DATUM sends work only once a Bitcoin address is set in its Config tab.' : '';
    document.getElementById('pool-add-form').querySelector('button[type="submit"]').focus();
    return;
  }
  const isPeerOrPoolAction = PEER_ACTIONS.has(action) || POOL_ACTIONS.has(action);
  const peerAction = PEER_ACTIONS.has(action) && address;
  if (peerAction) {
    if (pendingPeers.has(address)) return;
    pendingPeers.add(address);
  }
  const originalLabel = btn.textContent;
  if (isPeerOrPoolAction) {
    btn.disabled = true;
    // The lock is an icon, not a label - replacing its text with an ellipsis
    // would leave an empty-looking cell for the moment the request takes.
    if (action !== 'keep') btn.textContent = '…';
    // Hold off the periodic re-render for the duration. Without this a poll
    // landing mid-action replaced this very button with a fresh, enabled one
    // - so the action could be fired a second time, and the reset in the
    // finally block below wrote to an element no longer in the document.
    actionsInFlight += 1;
  }

  // Probing a host on 8333 then 9333 can take up to ~6s (3s timeout per
  // port) - show what's actually happening instead of leaving the UI
  // looking frozen/unresponsive during that wait.
  if (action === 'add-manual') showToast(`Adding ${address} as manual peer - probing port 8333, then 9333…`, 'pending');
  if (action === 'untrust') showToast(`Removing ${address}…`, 'pending');
  if (action === 'disconnect') showToast(`Disconnecting ${address}…`, 'pending');
  if (action === 'delete-pool') showToast('Removing pool…', 'pending');

  try {
    if (action === 'add-manual') {
      const result = await api('/api/peers/add-manual', { method: 'POST', body: JSON.stringify({ address }) });
      // Added back within the wait after a removal: it belongs in the tables again.
      justGone.delete(address);
      justGone.delete(result.address);
      showToast(
        result.warning
          ? `Added and locked as manual peer: ${result.address} - ${result.warning}`
          : `Added and locked as manual peer: ${result.address}. It now shows in the Manual Peers panel below.`,
        'success',
      );
    }
    if (action === 'untrust') {
      await api('/api/peers/untrust', { method: 'POST', body: JSON.stringify({ address }) });
      justGone.set(address, Date.now());
      recheckGone();
      showToast(`Removed ${address} as manual peer and disconnected it.`, 'success');
    }
    if (action === 'disconnect') {
      await api('/api/peers/disconnect', { method: 'POST', body: JSON.stringify({ address }) });
      // A manual peer stays manual and Core dials it again, so only a non-manual one leaves the tables.
      const was = (lastPeerRanking || []).find((p) => p.address === address);
      if (!was || !was.trusted) justGone.set(address, Date.now());
      recheckGone();
      showToast(`Disconnected ${address}.`, 'success');
    }
    if (action === 'keep') {
      const kept = btn.dataset.kept !== '1';
      await api('/api/peers/keep', { method: 'POST', body: JSON.stringify({ address, kept }) });
      showToast(
        kept
          ? `${address} is locked: it keeps its slot, even offline.`
          : `${address} is unlocked: it gives up its slot if it stays offline.`,
        'success',
      );
    }
    if (action === 'delete-pool') {
      await api(`/api/pools/${id}`, { method: 'DELETE' });
      showToast('Pool removed.', 'success');
    }

    // The Slot Fill log notes a hand-made change at once; without this it would
    // wait for the slow two-minute round.
    if (PEER_ACTIONS.has(action)) {
      refreshPeers();
      refreshRotation();
      window.dispatchEvent(new Event('peerlab:acted'));
    }
    if (POOL_ACTIONS.has(action)) refreshPools();
  } catch (err) {
    showToast(
      action === 'add-manual' ? `Could not add ${address} as manual: ${err.message}` : err.message,
      'error',
    );
  } finally {
    if (peerAction) pendingPeers.delete(address);
    if (isPeerOrPoolAction) {
      actionsInFlight -= 1;
      if (btn.isConnected) {
        btn.disabled = false;
        // Only what was replaced: the lock's two spans would come back as plain text.
        if (action !== 'keep') btn.textContent = originalLabel;
      }
      flushDeferredRenders();
    }
  }
});

document.body.addEventListener('change', async (e) => {
  const chk = e.target.closest('input[data-action="toggle-pool"]');
  if (chk) {
    const enabled = chk.checked;
    actionsInFlight += 1;
    try {
      await api(`/api/pools/${chk.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      showToast(enabled ? 'Pool enabled.' : 'Pool disabled.', 'success');
      refreshPools();
    } catch (err) {
      // Was an alert(), the one blocking dialog in the whole app - it also
      // froze the refresh loop until someone clicked it away.
      if (chk.isConnected) chk.checked = !enabled;
      showToast(`Could not change the pool: ${err.message}`, 'error');
    } finally {
      actionsInFlight -= 1;
      flushDeferredRenders();
    }
    return;
  }

  if (e.target.id === 'stratum-toggle' || e.target.id === 'rotation-toggle' || e.target.dataset.action === 'toggle-pool') foldSums();
  if (e.target.id === 'stratum-toggle') {
    const enabled = e.target.checked;
    try {
      const result = await api('/api/stratum/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      const body = document.getElementById('stratum-body');
      foldInPlace({ anchor: e.target, box: body.closest('section') || body, open: Boolean(result.enabled), set: (on) => applyStratumEnabled(on) });
      showToast(
        result.enabled
          ? 'Stratum Race turned on. Pool connections open within half a minute.'
          : 'Stratum Race turned off. Pool connections close within half a minute.',
        'success',
      );
      if (result.enabled) refreshPools();
    } catch (err) {
      if (e.target.isConnected) e.target.checked = !enabled;
      showToast(`Could not change Stratum Race: ${err.message}`, 'error');
    }
    return;
  }

  if (e.target.id === 'rotation-toggle') {
    rotationToggleEpoch += 1;
    const enabled = e.target.checked;
    try {
      // The server answers with the state it actually stored - use that
      // rather than assuming the click won.
      const result = await api('/api/rotation/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      rotationToggleEpoch += 1;
      if (e.target.isConnected) e.target.checked = Boolean(result.enabled);
      showToast(result.enabled ? 'Slot Fill turned on.' : 'Slot Fill turned off.', 'success');
      refreshRotation();
      if (result.enabled) watchFirstCheck();
    } catch (err) {
      rotationToggleEpoch += 1;
      if (e.target.isConnected) e.target.checked = !enabled;
      showToast(`Could not change Slot Fill: ${err.message}`, 'error');
    }
    return;
  }

});

document.getElementById('stratum-range').addEventListener('click', (e) => {
  const pick = e.target.closest('button[data-range]');
  if (!pick || pick.classList.contains('on')) return;
  for (const b of pick.parentElement.children) {
    b.classList.toggle('on', b === pick);
    b.setAttribute('aria-pressed', String(b === pick));
  }
  refreshPools();
});

// Background services (peer-profiler, relay-profiler, stratum-race) have no
// HTTP port of their own, so a crashed or wedged one used to be invisible
// here - the tables simply stopped changing. Each writes a heartbeat, and
// this surfaces a stale one where it will actually be seen.
async function refreshHealth() {
  const banner = document.getElementById('service-banner');
  if (!banner) return;
  let report;
  try {
    report = await api('/api/health');
  } catch (err) {
    // Can't reach our own API - the refresh banner covers that case, and
    // hiding this one avoids two banners saying the same thing.
    banner.hidden = true;
    throw err;
  }
  const down = Object.entries(report.services || {})
    .filter(([, v]) => !v.ok)
    .map(([name]) => name);
  if (down.length > 0) {
    banner.hidden = false;
    banner.textContent = down.length === 1
      ? `The ${down[0]} service is not reporting in. Check its container logs - data it collects is not being recorded right now.`
      : `${down.length} background services are not reporting in (${down.join(', ')}). Check the app's container logs.`;
    return;
  }

  // Every service alive and still nothing arriving. Reported before
  // attribution, because a stalled subscription means no new blocks at all -
  // the attribution check is then frozen on old data and would say nothing.
  const zmq = report.zmq;
  if (zmq && zmq.ok === false) {
    const hours = Math.floor(zmq.quietMs / 3600000);
    banner.hidden = false;
    banner.textContent = zmq.everReceived
      ? `No block has arrived from Bitcoin Core for ${hours} hours. The connection reports itself as fine, `
        + 'which it always does - check that Bitcoin Node is running and still publishing over ZMQ.'
      : 'No block has ever arrived from Bitcoin Core. Nothing is being measured - check that Bitcoin Node '
        + 'is running and that its ZMQ block notifications are switched on.';
    return;
  }

  // The clocks, read straight off Core's Date header rather than inferred from
  // the damage. Ahead of the attribution warning because it is the cause of it,
  // it is the more accurate of the two, and it can be said before First % has
  // had a chance to stick at zero.
  const clock = report.coreClock;
  if (clock && clock.ok === false) {
    const seconds = (Math.abs(clock.offsetMs) / 1000).toFixed(1);
    banner.hidden = false;
    banner.textContent = `Bitcoin Core's clock is about ${seconds} seconds `
      + `${clock.offsetMs < 0 ? 'behind' : 'ahead of'} this app's. Block attribution needs them within `
      + 'a couple of seconds, so First % will stay at 0 until they agree.';
    return;
  }

  // Every service alive and still nothing being measured. Attribution matches
  // Core's last_block against the instant ZMQ delivered the block, so a few
  // seconds of disagreement between the two clocks credits nobody, ever, while
  // every other part of the page looks perfectly normal.
  const attribution = report.attribution;
  if (attribution && attribution.ok === false) {
    const seconds = attribution.skewMs == null ? null : Math.abs(attribution.skewMs) / 1000;
    banner.hidden = false;
    banner.textContent = attribution.reason === 'clock'
      ? `No peer has been credited with any of the last ${attribution.blocks} blocks. `
        + `Bitcoin Core's clock looks about ${seconds.toFixed(1)} seconds `
        + `${attribution.skewMs < 0 ? 'behind' : 'ahead of'} this app's.`
      : `No peer has been credited with any of the last ${attribution.blocks} blocks, `
        + 'so First % cannot fill up. Check the relay profiler\'s logs.';
    return;
  }

  banner.hidden = true;
}

/**
 * Self-scheduling refresh loop.
 *
 * Two things setInterval got wrong here. It kept firing while a previous
 * pass was still in flight, so a slow response let requests pile up on top
 * of each other; and it kept polling forever in a background tab, so a
 * dashboard left open in some window went on querying the node all day.
 * This waits for each pass to finish before scheduling the next, pauses
 * entirely while the page is hidden, and refreshes once immediately when it
 * becomes visible again so it is never showing stale data on return.
 */
function startRefreshLoop() {
  let timer = null;
  let rotationTimer = null;

  const schedule = () => {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(run, REFRESH_MS);
  };

  const run = async () => {
    if (document.hidden) return;
    try {
      await refreshAll();
    } finally {
      schedule();
    }
  };

  // The rotation panel changes at most once per rotation tick - ten minutes -
  // so it does not belong in the 20-second round with the live tables. It was
  // fetching and re-rendering fifty log rows thirty times per possible change,
  // into a panel that starts collapsed.
  const runRotation = async () => {
    if (document.hidden) return;
    try {
      // Traffic is written once an hour, so it rides on this slow round too.
      await Promise.all([refreshRotation(), refreshTraffic()]);
    } catch (err) {
      console.warn('rotation or traffic refresh failed', err);
    } finally {
      clearTimeout(rotationTimer);
      if (!document.hidden) rotationTimer = setTimeout(runRotation, ROTATION_REFRESH_MS);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      clearTimeout(rotationTimer);
    } else {
      run();
      runRotation();
    }
  });

  run();
  runRotation();
}

/**
 * Live block events. EventSource reconnects on its own after a dropped or
 * ended stream (the server ends each one after a few minutes), and the server
 * replays the current block on connect, so no state is lost across a drop.
 *
 * What it does not retry is a refusal: an answer that is not a stream at all -
 * 503 when every slot is taken, or the proxy's error page while the app
 * restarts - closes the source for good. Without this the page went on showing
 * new heights from the status poll but never played the wave again.
 */
const EVENT_STREAM_RETRY_MS = 30 * 1000; // matches the server's Retry-After

function startEventStream() {
  const source = new EventSource('/api/events');
  source.addEventListener('block', (e) => {
    try {
      applyBlockUpdate(JSON.parse(e.data));
    } catch (err) {
      /* malformed frame - the next event supersedes it */
    }
  });
  source.addEventListener('error', () => {
    if (source.readyState !== EventSource.CLOSED) return; // reconnecting by itself
    setTimeout(startEventStream, EVENT_STREAM_RETRY_MS);
  });
}

/**
 * Storage panel. Its numbers come from their own endpoint because getting them
 * exactly means walking every page of the database - too expensive to poll, so
 * it is fetched when the panel is opened and again after a reset.
 */
async function refreshStorage() {
  let s;
  try {
    s = await api('/api/storage');
  } catch (err) {
    return; // the panel simply shows nothing rather than breaking the page
  }
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('storage-total', fmtBytes(s.totalBytes));
  set('reset-peers-size', `${fmtBytes(s.peerData.bytes)} · ${s.peerData.rows.toLocaleString('en-US')} rows`);
  set('reset-pools-size', `${fmtBytes(s.poolHistory.bytes)} · ${s.poolHistory.rows.toLocaleString('en-US')} rows`);
  set('reset-peers-detail', `${s.peerData.rows.toLocaleString('en-US')} rows, ${fmtBytes(s.peerData.bytes)}, will be deleted.`);
  set('reset-pools-detail', `${s.poolHistory.rows.toLocaleString('en-US')} rows, ${fmtBytes(s.poolHistory.bytes)}, will be deleted.`);
}

// Two steps rather than a browser confirm(): the warning can then say what is
// actually about to go, in rows and megabytes, instead of asking whether the
// user is sure about something unspecified.
function wireReset(scope) {
  const ask = document.getElementById(`reset-${scope}`);
  const panel = document.getElementById(`reset-${scope}-confirm`);
  const yes = document.getElementById(`reset-${scope}-yes`);
  const no = document.getElementById(`reset-${scope}-no`);
  if (!ask || !panel || !yes || !no) return;

  // At the page's end the question could open below the screen: brought up
  // only as far as it needs.
  ask.addEventListener('click', () => { panel.hidden = false; ask.hidden = true; panel.scrollIntoView({ block: 'nearest', behavior: glide() }); });
  no.addEventListener('click', () => { panel.hidden = true; ask.hidden = false; });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope }) });
    } catch (err) {
      // Said out loud: a silent failure here read as data that was deleted.
      // Not "nothing was deleted": a timeout can come after the delete.
      showToast(`Reset failed: ${err.message}`, 'error');
      refreshStorage();
      return;
    } finally {
      yes.disabled = false;
      panel.hidden = true;
      ask.hidden = false;
    }
    await refreshStorage();
    await refreshStatus();
    // What each reset empties: peer data includes the slot fill log, pool
    // history the pool table.
    if (scope === 'pools') await refreshPools();
    else await Promise.all([refreshPeers(), refreshRotation()]);
  });
}

// Every <details> folds in place too: its summary stays, its text rolls out
// below and back up.
document.addEventListener('click', (e) => {
  const summary = e.target.closest && e.target.closest('.panel details > summary, details.panel > summary');
  if (!summary || e.target.closest('a, button, input')) return;
  e.preventDefault();
  const details = summary.parentElement;
  foldInPlace({ anchor: summary, box: details, open: !details.open, set: (open) => { details.open = open; } });
});
document.getElementById('storage-card').addEventListener('toggle', (e) => {
  if (e.target.open) refreshStorage();
});
wireReset('peers');
wireReset('pools');

startRefreshLoop();
startEventStream();


// Esc closes what a click opened, one thing per press, as in a desktop app:
// the reset question, an open pool row, what the peer list has open (a
// peer's panel, then its filters), then the storage card. The one handler on
// the page, so one press never closes two things.
const escapeSteps = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  const confirm = [...document.querySelectorAll('.reset-confirm')].find((c) => !c.hidden);
  if (confirm) {
    confirm.querySelector('[id$="-no"]')?.click();
    e.preventDefault();
    return;
  }
  if (openRow) {
    openRow = null;
    markOpenRow();
    e.preventDefault();
    return;
  }
  for (const step of escapeSteps) {
    if (step()) { e.preventDefault(); return; }
  }
  const storage = document.getElementById('storage-card');
  if (storage && storage.open) { storage.open = false; e.preventDefault(); }
});
