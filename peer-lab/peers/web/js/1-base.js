  // Where this script came from is where its data is: the page may be one level up.
  const BASE = new URL(".", document.currentScript.src).href;
  const GROUPS = ["inbound", "outbound", "manual"];
  const INBOUND_LIMIT = 10;
  // A peer reaching the node through Tor shows the exit's place and operator; the peer itself stays hidden behind it.
  const TOR_EXIT_TITLE = "Tor exit: location and operator are the exit's, not the peer's";
  // Core reports both directions independently.
  const HB_TITLE = "One of Core's three high-bandwidth peers: it may send a new block without being asked first, which gives it a head start of at least one ping.";
  const HB_FROM_TITLE = "This peer has picked your node as one of its three high-bandwidth peers: your node sends it new blocks without being asked first.";
  // A manual peer locked in the dashboard keeps its slot even while offline:
  // the padlock stands in its row, where the legend and the Manual head
  // ("6 locked") promise it, not only in the opened detail.
  const LOCKED_TITLE = "Locked: once it has connected, it keeps its manual slot, even while offline";
  const isLocked = (p) => p.group === "manual" && Boolean(window.peerLab.peer(p.addr)?.kept);
  const LABEL = { manual: "Manual", inbound: "Inbound", outbound: "Outbound" };
  const NS = "http://www.w3.org/2000/svg";
  const REGION_ZOOM = 2.5;                 // from this zoom factor on, markers split into regions
  const IDLE_PAUSE_MS = 30 * 60 * 1000;    // stop asking Core after 30 min without input
  const RANKING_WAIT_MS = 4000;            // how long a new list waits for the ranking asked with it
  // A list waiting for its ranking: the ranking's own event draws nothing.
  let awaitingRanking = false;
  const SIDE_KEY = "peerlab.sideOpen";
  const $ = (id) => document.getElementById(id);

  // A country's English name and its flag, made the same way as in the
  // dashboard's own panels: by the dashboard.
  const regionName = (cc) => window.peerLab.countryName(cc);

  // A peer that was not there at the last refresh lights up once, so what
  // changed since the last look is seen without searching. Not on the first
  // load: then everything would be new.
  const arrivedAt = new Map();
  let knownKeys = null;
  function markArrivals(peers) {
    const keys = new Set(peers.map((p) => p.group + " " + p.addr));
    const now = Date.now();
    if (knownKeys) for (const k of keys) if (!knownKeys.has(k)) arrivedAt.set(k, now);
    for (const [k, t] of arrivedAt) if (now - t > 3000 || !keys.has(k)) arrivedAt.delete(k);
    knownKeys = keys;
  }

  // Smooth scrolling, unless the reader asked the system for less motion.
  const glide = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  // Folding in place: one implementation for the whole page, the
  // dashboard's (its app.js), with one runway at the page's end and one
  // count of folds under way. Anchor and box may be functions that find
  // them again, for a list rebuilt by the fold.
  const foldInPlace = (o) => window.peerLab.foldInPlace(o);

  const state = {
    data: null,           // last /api/peers reply
    world: null,          // world.json
    place: null,          // location filter from clicking a marker: { key, label }
    group: null,          // first level of the kind filter: Nodes, Wallets, Watchers, Disguised, Other
    kind: null,           // kind filter from clicking an entry in a group's kind line
    sub: null,            // one level under the kind: a pool, a version, a name
    label: null,          // beside it, for nodes: the operator's own label, "(FutureBit-Apollo-Node)"
    allSubs: false,       // every chip one level down, not one line of them
    openRows: new Set(),  // rows the reader has opened by a tap or click: "group address"
    sort: {},             // per group: { key, dir }
    view: { k: 1, x: 0, y: 0 },
    paused: false,
    lastHash: null,       // newest block hash seen, to pulse the map when it changes
    lastInput: Date.now(),
    // When the current snapshot arrived here. The block's age comes from the
    // node's clock; how long it has been sitting in this browser is added on
    // top, so the two-minute mark never depends on the browser's own clock
    // agreeing with the node's.
    receivedAt: 0,
    liveShown: false,
    showAllInbound: false, // the inbound table shows its top INBOUND_LIMIT until asked for all
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };

  // Every card folds to its title on a tap, and stays folded on this device:
  // open unless the reader closed it (28.10.2026).
  const FOLD_KEY = "peerlab.folded";
  const folded = new Set((() => { try { return JSON.parse(store.get(FOLD_KEY)) || []; } catch { return []; } })());
  // The dashboard's foldable, with this script's store and fitting.
  // window.peerLab, not dashboard(): this runs before that is declared.
  function foldable(card, title, id) {
    window.peerLab.foldable({
      card, title, id, folded,
      save: () => store.set(FOLD_KEY, JSON.stringify([...folded])),
      // Folded, a chip row measured no width and was left whole: fit it
      // now, and the tables with it, whose lines were measured folded too.
      onOpened: () => {
        for (const row of card.querySelectorAll(".one-line")) fitOneLine(row);
        fitTables();
      },
      onOpening: id === "map" ? () => window.dispatchEvent(new Event("resize")) : null,
    });
  }
  foldable($("mapCard"), $("mapHead"), "map");
  // The legend: folded on a phone the first time, open on a wide screen; after
  // that it stays as the reader left it.
  if ($("keyCard")) {
    if (store.get("peerlab.keyDefault") == null) {
      store.set("peerlab.keyDefault", "1");
      if (window.matchMedia("(max-width: 600px)").matches) { folded.add("key"); store.set(FOLD_KEY, JSON.stringify([...folded])); }
    }
    foldable($("keyCard"), $("keyHead"), "key");
  }
  // The block card does not fold itself (12.11.2026): its head is two short
  // lines, and everything else is in its one fold, "Details".

  // ---------- projection: same Natural Earth polynomial as tools/genmap ----------
  function nePoly(lon, lat) {
    const l = lon * Math.PI / 180, p = lat * Math.PI / 180;
    const p2 = p * p, p4 = p2 * p2;
    return [
      l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
      p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
    ];
  }
  const X_MAX = nePoly(180, 0)[0];
  const Y_MAX = nePoly(0, 84)[1];
  function project(lon, lat) {
    const [x, y] = nePoly(lon, lat);
    const s = 1000 / (2 * X_MAX);
    return [(x + X_MAX) * s, (Y_MAX - y) * s];
  }

  // ---------- polling: only while visible, and not after 30 min idle ----------
  let pollTimer = 0;
  let tickTimer = 0;
  let inFlight = false;

  // A block the dashboard has just announced (its event stream): the block
  // card, the star and the map's wave are asked for it at once, and asked
  // again shortly, a few times at most, until the answer has it. Each block
  // once: the dashboard repeats its latest every 20 seconds, and a service
  // without a block card would otherwise be asked four times each time.
  let wantBlock = "", wantTries = 0, triedBlock = "";
  window.addEventListener("peerlab:block", (e) => {
    if (!e.detail || e.detail === triedBlock || (state.data && state.data.last_block && state.data.last_block.hash === e.detail)) return;
    wantBlock = triedBlock = e.detail;
    wantTries = 3;
    refresh();
  });
  // Exactly one polling chain at a time. Without the inFlight guard, a tab
  // that became visible again while a request was still running started a
  // second chain next to the first, and every such moment added another.
  async function refresh() {
    clearTimeout(pollTimer);
    if (inFlight || document.hidden || state.paused) return;
    if (Date.now() - state.lastInput > IDLE_PAUSE_MS) {
      setPaused(true);
      return;
    }
    let next = 10;
    inFlight = true;
    try {
      const r = await fetch(BASE + "api/peers" + (wantBlock ? "?block=" + wantBlock : ""), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.data = await r.json();
      state.receivedAt = Date.now();
      markArrivals(state.data.peers);
      next = state.data.next_in || state.data.interval || 10;
      state.failed = false;
      // The dashboard fetches its word on the peers on this clock. When it
      // does, the list is drawn once, with both, and not a second time when
      // the ranking comes a moment later.
      const ask = { ranking: null };
      window.dispatchEvent(new CustomEvent("peerlab:list", { detail: ask }));
      if (ask.ranking) {
        awaitingRanking = true;
        try {
          await Promise.race([ask.ranking, new Promise((r) => setTimeout(r, RANKING_WAIT_MS))]);
        } finally {
          awaitingRanking = false;
        }
      }
      renderWhenFree();
      beat();
    } catch (e) {
      state.failed = true;
      renderStatus();
      showError("Peer list not reachable: " + e.message);
    } finally {
      inFlight = false;
    }
    const lb = state.data && state.data.last_block;
    if (wantBlock && lb && lb.hash === wantBlock) wantBlock = "";
    if (wantBlock && wantTries > 0) { wantTries -= 1; next = 1.5; }
    else wantBlock = "";
    clearTimeout(pollTimer);
    if (!document.hidden && !state.paused) pollTimer = setTimeout(refresh, next * 1000 + 250);
  }

  // The dashboard's half of the page rests and wakes with this one.
  function setPaused(p) {
    state.paused = p;
    $("paused").hidden = !p;
    if (p) clearTimeout(pollTimer);
    renderStatus();
    window.dispatchEvent(new CustomEvent("peerlab:paused", { detail: p }));
  }

  let inputStamp = 0;
  const noteInput = () => {
    const now = Date.now();
    if (now - inputStamp < 1000) return; // cheap throttle
    inputStamp = now;
    state.lastInput = now;
  };
  for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) {
    window.addEventListener(ev, noteInput, { passive: true, capture: true });
  }
  $("resume").addEventListener("click", () => {
    state.lastInput = Date.now();
    setPaused(false);
    refresh();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      tickTimer = 0;
    } else {
      startTicker();
      refresh();
    }
  });

  function startTicker() {
    if (!tickTimer) {
      tickTimer = setInterval(() => {
        renderStatus();
        // Two minutes are up between two polls, and a paused dashboard never
        // polls again at all - so the star and the row colour take themselves
        // off rather than waiting for the next answer.
        if (state.liveShown && !liveBlock()) renderWhenFree();
      }, 1000);
    }
  }

  function showError(msg) {
    const el = $("error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ---------- formatting ----------
  // Durations and pings as the dashboard writes them everywhere else.
  const ago = (sec) => window.peerLab.fmtDuration(sec * 1000);
  const typeLabel = (t) => ({
    "outbound-full-relay": "Full relay",
    "block-relay-only": "Block relay",
  }[t] || t || "-");
  // Milliseconds below a second, seconds above.
  const fmtPing = (ms) => window.peerLab.fmtMs(ms);
  const netLabel = (n) => ({
    ipv4: "IPv4", ipv6: "IPv6", onion: "Tor", i2p: "I2P", cjdns: "CJDNS",
    not_publicly_routable: "Private", ipv6_hidden: "IPv6 (address hidden)",
    tor_hidden: "Tor (address hidden)", i2p_hidden: "I2P (address hidden)",
  }[n] || n || "-");
  const HIDDEN = {
    ipv6_hidden: { short: "IPv6", tip: "Inbound IPv6 passes through Docker, which puts its own address in place of the peer's." },
    tor_hidden: { short: "Tor", tip: "Reached through the Tor proxy, which hides the peer's address." },
    i2p_hidden: { short: "I2P", tip: "Reached through the I2P router, which hides the peer's address." },
  };
  // The networks without a country have a sign of their own instead of a flag.
  const HIDDEN_FLAG = {
    not_publicly_routable: "\u{1F3E0}",
    onion: "\u{1F9C5}", tor_hidden: "\u{1F9C5}",
    i2p: "\u{1F310}", i2p_hidden: "\u{1F310}", ipv6_hidden: "\u{1F310}",
  };
  const flagOf = (cc) => window.peerLab.flagOf(cc);

