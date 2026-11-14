  // ---------- render ----------
  // "syncing" is not a kind but is picked like one: the chip beside the count.
  const SYNCING = "syncing";
  // Peers that can never bring you a block because they are not on your chain: altcoins and forks of
  // their own, and Knots nodes on a chain split off from yours (BIP110, BLAKE2b). One filter for both,
  // like syncing; the pill still says which is which.
  const FORKED = "other chain";
  const OTHER_CHAIN = "Other chain";
  const offChain = (p) => !!p.fork || p.kind === OTHER_CHAIN;
  const special = (g) => g === SYNCING || g === FORKED;
  // Under a kind its peers are picked the same way, one level down: pools by
  // name, nodes by version, everything else by the software it names.
  const POOL_KIND = "Pool node", UNKNOWN_POOL = "unknown pool", NO_NAME = "no name";
  const uaName = (p) => {
    const parts = (p.subver || "").split("/").map((s) => s.trim()).filter(Boolean);
    // "nebula/2.4.1", "Yuki / 0.0.1": the last part may be only a version.
    let i = parts.length - 1;
    while (i > 0 && /^v?\d[\w.+-]*$/.test(parts[i])) i--;
    const name = (parts[i] || "").split(/[:(]/)[0].trim();
    // "Bither1.6.2", "vds_0.9.53", "BTC RPC Proxy v0.8.1": one chip per program.
    const bare = name.replace(/(?:[\s_-]+v?|([A-Za-z]))\d+(\.\d+)+$/, "$1") || name;
    return bare === "Satoshi" ? "Core" : bare === "Schildbach Bitcoin Wallet" ? "Bitcoin Wallet" : bare || NO_NAME;
  };
  // What a node's operator wrote in brackets after the version - an
  // "(FutureBit-Apollo-Node)", a "(MiniBolt node)" - as written. Nodes only:
  // elsewhere the brackets are part of the program's own name.
  const labelOf = (p) => {
    if (!p.kind.startsWith("Node")) return null;
    const m = /\(([^)]*)\)/.exec(p.subver || "");
    return m && m[1].trim() ? m[1].trim() : null;
  };
  const subOf = (p) => {
    if (p.kind === POOL_KIND) return p.pool || UNKNOWN_POOL;
    if (p.kind.startsWith("Node")) {
      const v = /^\/Satoshi:(\d+)\.(\d+)/.exec(p.subver || "");
      // Knots names a release by the Core it is built on, down to the second
      // number (v29.3.knots20260507), and nearly all of it is on one major:
      // by the major alone every Knots peer was "29.x", one chip, none shown.
      if (v && p.kind === "Node (Knots)" && /\/Knots:/.test(p.subver)) return v[1] + "." + v[2];
      if (v) return (v[1] === "0" ? "0." + v[2] : v[1]) + ".x";
    }
    // What it pretends to be - a Core node or a wallet; who is behind it
    // (LinkingLion) is its pill's to say.
    if (p.kind === "Disguised") {
      if (/bitcoinj|breadwallet|\/bread:|multibit|bither|wallet/i.test(p.subver || "")) return "as wallet";
      return /^\/?Satoshi/i.test(p.subver || "") ? "as Core" : "as " + uaName(p);
    }
    // One program under many names (RESET), a borrowed name (Wasabi) or who
    // runs a scanner: the server knows which rule it was and names the chip.
    return p.name || uaName(p);
  };
  // Swiping back, or the back button, closes what is open - a panel, then
  // the filters - before it leaves the page, as in an app. One history entry
  // stands for "something is open"; closing it by hand takes that entry back.
  const somethingOpen = () => state.openRows.size > 0 || !!state.group || !!state.place;
  // Going back by hand can take the page back with it: Safari puts it where it
  // was when the entry was made, so clearing a filter at the top of the page
  // threw the reader down to the chip that set it (iPhone, 04.11.2026). Where
  // the reader is when they close is kept, and put back.
  let backY = null;
  function layers() {
    try {
      const ours = history.state && history.state.peerLayer;
      if (somethingOpen() && !ours) history.pushState({ peerLayer: true }, "");
      else if (!somethingOpen() && ours) { backY = window.scrollY; history.back(); }
    } catch { /* sandboxed frame */ }
  }
  window.addEventListener("popstate", () => {
    if (backY !== null) {
      const y = backY;
      backY = null;
      window.scrollTo(0, y);
      requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y); });
      return;
    }
    if (!somethingOpen()) return;
    if (state.openRows.size) state.openRows.clear();
    else { state.group = null; state.kind = null; state.sub = null; state.label = null; state.place = null; }
    applyFilters();
  });

  // On a phone the page is several screens long. Scrolling back up shows a
  // small bar with the sections - top, then each table - and it goes again
  // when the reader scrolls on down or is back at the top.
  const jumpBar = document.createElement("nav");
  jumpBar.className = "jump-bar";
  jumpBar.setAttribute("aria-label", "Jump to");
  document.body.appendChild(jumpBar);
  let lastY = window.scrollY;
  // A jump up is a scroll up too: without this the bar came straight back
  // and covered the heading it had just jumped to (82 px on a phone).
  let jumpedUntil = 0;
  function fillJumpBar() {
    jumpBar.textContent = "";
    const go = (label, target) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        const y = target ? target.getBoundingClientRect().top + window.scrollY - 8 : 0;
        jumpedUntil = Date.now() + 1200;
        window.scrollTo({ top: Math.max(0, y), behavior: glide() });
        jumpBar.classList.remove("shown");
      });
      jumpBar.appendChild(b);
    };
    go("\u2191 Top", null);
    for (const g of GROUPS) {
      const c = document.getElementById("group-" + g);
      // Short, so the bar fits a phone without sliding sideways.
      if (c) go({ inbound: "In", outbound: "Out", manual: "Manual" }[g], c);
    }
    // The cards under the list, where the page has them.
    for (const [label, id] of [["Slot Fill", "slot-fill"], ["Stratum", "stratum-race"], ["Traffic", "traffic-card"]]) {
      const c = document.getElementById(id);
      if (c) go(label, c);
    }
  }
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    if (Date.now() < jumpedUntil) { lastY = y; return; }
    const phone = window.matchMedia("(max-width: 600px)").matches;
    const up = y < lastY - 4, down = y > lastY + 4;
    // With a mouse the bar sits quietly in a corner whenever the reader is
    // far down; on a phone it comes only on the way back up.
    const show = phone ? up && y > window.innerHeight : y > window.innerHeight;
    const hide = phone ? down || y < window.innerHeight / 2 : y < window.innerHeight;
    jumpBar.classList.toggle("corner", !phone);
    if (show) {
      if (!jumpBar.classList.contains("shown")) { fillJumpBar(); jumpBar.classList.add("shown"); }
    } else if (hide) jumpBar.classList.remove("shown");
    if (up || down) lastY = y;
  }, { passive: true });

  function hoverPlace(p, on) {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const g = document.querySelector(`#markers .marker[data-key="${CSS.escape(placeKey(p, renderedMode))}"]`);
    if (g) g.classList.toggle("hover", on);
  }

  // The keyboard, as in a desktop app: Esc closes what is open (a panel, then
  // the filters) - asked by the dashboard's one Esc handler, in its turn -
  // the arrow keys go from row to row, Enter opens one.
  dashboard().onEscape(() => {
    if (!somethingOpen()) return false;
    if (state.openRows.size) state.openRows.clear();
    else { state.group = null; state.kind = null; state.sub = null; state.label = null; state.place = null; }
    applyFilters();
    return true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const rows = [...document.querySelectorAll("#tables tr[data-anchor]")].filter((r) => r.offsetParent);
    const at = rows.indexOf(document.activeElement);
    if (e.key === "Enter") {
      if (at >= 0) { rows[at].click(); e.preventDefault(); }
      return;
    }
    if (at < 0 && !(e.target === document.body || e.target === document.documentElement)) return;
    const next = at < 0 ? rows.find((r) => r.getBoundingClientRect().top >= 0) : rows[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", behavior: glide() });
  });

  // A tap on a chip redraws the tables; the card it sits in stays where the
  // finger left it, as in any app - the list below changes, the page does not
  // jump under the reader.
  function steady(btn, change) {
    const card = btn.closest("section[id]");
    const id = card && card.id, top = card && card.getBoundingClientRect().top;
    change();
    const now = id && document.getElementById(id);
    if (!now) return;
    const d = now.getBoundingClientRect().top - top;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
  }
  function moreChip(el, hidden, flag) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip kind-pick more-chips";
    b.textContent = "+ " + hidden + " more";
    b.title = "Show every chip";
    b.addEventListener("click", () => steady(b, () => { state[flag] = true; renderTables(); }));
    el.appendChild(b);
  }
  // Hides chips from the end, the picked one never, until the row and its
  // "+ n more" fit; then lets the row wrap again for the chips that are left.
  function fitOneLine(el) {
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    if (fits()) return;
    const chips = [...el.querySelectorAll("button.kind-pick")].reverse();
    moreChip(el, 0, "allSubs");
    const more = el.lastElementChild;
    let hidden = 0;
    for (const c of chips) {
      if (c.classList.contains("on")) continue;
      c.hidden = true;
      more.textContent = "+ " + ++hidden + " more";
      if (fits()) break;
    }
  }
  const SUB_LABEL = { [POOL_KIND]: "Pools:", Disguised: "Claims:", "Lightning wallet": "lnd:" };
  const subLabel = (kind) => SUB_LABEL[kind] || (kind.startsWith("Node") ? "Versions:" : "Names:");
  // Nineteen kinds were one long row of chips, several of them with a single
  // peer. The first level is three families of them and every other kind on
  // its own; the kind is the second, the name the third. A family "Other"
  // held the kind "Other", and picking it showed "Other" a second time. An
  // indexer (electrs, Fulcrum) is there for wallets, and alone it was a chip
  // for one peer, mostly the node's own.
  const groupOf = (kind) =>
    kind.startsWith("Node") || kind === POOL_KIND ? "Nodes"
    : kind === "Wallet" || kind === "Lightning wallet" || kind === "Other light client" || kind === "Indexer" ? "Wallets"
    : kind === "Crawler" || kind === "Research scanner" ? "Watchers"
    : kind;
  const matchesKind = (p) => !state.group || (state.group === SYNCING ? !!p.sync_mb : state.group === FORKED ? offChain(p)
    : groupOf(p.kind) === state.group && (!state.kind || p.kind === state.kind) && (!state.sub || subOf(p) === state.sub) && (!state.label || labelOf(p) === state.label));

  const visiblePeers = () =>
    (state.data ? state.data.peers.filter(matchesKind) : []);
  const regionMode = () => state.view.k >= REGION_ZOOM;

  // Every refresh rebuilds the tables and the map, and with them whatever the
  // reader had in hand: an address half selected for copying, a keyboard
  // focus, a tooltip that kept showing the old numbers. So a refresh waits
  // while something is selected, pressed or focused by keyboard - for 30 s at
  // most - and comes the moment that is over. The tooltip is closed by it.
  let pressedAt = 0;
  let heldSince = 0;
  let renderPending = false;
  const HOLD_MAX_MS = 30000;
  // Also while a finger is on the glass or the page still glides: the rows
  // the reader was following moved under it, and the scroll correction that
  // keeps their place cut Safari's glide short with a jolt (iPhone,
  // 28.10.2026). The refresh comes once the page has been still for half a
  // second.
  let touching = 0;
  let scrolledAt = 0;
  let settleTimer = 0;
  const moving = () => (touching && Date.now() - touching < 15000) || Date.now() - scrolledAt < 500;
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => (moving() ? settle() : freed()), 520);
  };
  window.addEventListener("touchstart", () => { touching = Date.now(); }, { passive: true, capture: true });
  for (const t of ["touchend", "touchcancel"]) {
    window.addEventListener(t, () => { touching = 0; settle(); }, { passive: true, capture: true });
  }
  window.addEventListener("scroll", () => { scrolledAt = Date.now(); settle(); }, { passive: true });
  function busy() {
    if (moving()) return true;
    // An action on a peer under way: its buttons are not drawn again until
    // its answer is in (the dashboard holds its own tables for it too).
    if (dashboard().acting()) return true;
    // A fold rolling: a refresh would rebuild what it is rolling (foldInPlace).
    if (dashboard().folding()) return true;
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) return true;
    if (pressedAt && Date.now() - pressedAt < 2000) return true;
    const a = document.activeElement;
    return Boolean(a && a !== document.body && a.matches && a.matches(":focus-visible") && a.closest(".peers, #map"));
  }
  // The dashboard has new numbers, or has just acted on a peer.
  window.addEventListener("peerlab:ranking", () => { if (state.data && !awaitingRanking) renderWhenFree(); });
  window.addEventListener("peerlab:acted", () => setTimeout(refresh, 1200));
  function renderWhenFree() {
    if (busy() && (!heldSince || Date.now() - heldSince < HOLD_MAX_MS)) {
      if (!heldSince) heldSince = Date.now();
      renderPending = true;
      return;
    }
    heldSince = 0;
    renderPending = false;
    hideTip();
    render();
  }
  const freed = () => { if (renderPending) setTimeout(renderWhenFree, 0); };
  dashboard().afterFolds(freed);
  document.addEventListener("pointerdown", () => { pressedAt = Date.now(); }, true);
  document.addEventListener("click", () => { pressedAt = 0; freed(); });
  for (const t of ["pointerup", "pointercancel"]) {
    document.addEventListener(t, () => setTimeout(() => { if (pressedAt) { pressedAt = 0; freed(); } }, 400), true);
  }
  document.addEventListener("selectionchange", freed);
  document.addEventListener("focusout", freed);
  window.addEventListener("blur", () => { pressedAt = 0; freed(); });

  // A reload puts the reader back where they were. The browser tries it before
  // the peers have arrived, finds a short page and settles near the top. So the position is kept here, set again once the
  // tables are in, and let go when the reader moves the page, when the page has
  // grown to it, or after six seconds.
  let reloadY = null;
  let restoredY = null;  // where this code last put the page
  try {
    // Always manual: with the browser's own restore on, it and this code pull the page two ways.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const nav = performance.getEntriesByType("navigation")[0];
    const key = "scrollY:" + location.pathname;
    if (nav && (nav.type === "reload" || nav.type === "back_forward")) {
      const v = Number(sessionStorage.getItem(key));
      if (v > 0) reloadY = v;
    }
    // Still waiting to be restored, the page is short: keep the position that waits.
    // The filters come back with the position: a reload should not undo a pick.
    const fkey = "filters:" + location.pathname;
    if (nav && (nav.type === "reload" || nav.type === "back_forward")) {
      const f = JSON.parse(sessionStorage.getItem(fkey) || "null");
      if (f) Object.assign(state, { group: f.group || null, kind: f.kind || null, sub: f.sub || null, label: f.label || null, place: f.place || null });
    }
    const save = () => {
      try {
        sessionStorage.setItem(key, String(reloadY !== null ? reloadY : Math.round(window.scrollY)));
        sessionStorage.setItem(fkey, JSON.stringify({ group: state.group, kind: state.kind, sub: state.sub, label: state.label, place: state.place }));
      } catch { /* private window */ }
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
    const letGo = () => { reloadY = null; };
    for (const ev of ["wheel", "touchstart", "keydown", "mousedown"]) window.addEventListener(ev, letGo, { passive: true });
    // A drag on the scrollbar or a fling is the reader's, not ours.
    window.addEventListener("scroll", () => { if (reloadY !== null && restoredY !== null && Math.abs(window.scrollY - restoredY) > 40) letGo(); }, { passive: true });
    setTimeout(letGo, 6000);
  } catch {
    // No storage: nothing is saved, so the browser's own restore has to do.
    try { history.scrollRestoration = "auto"; } catch { /* old browser */ }
  }
  function restoreReloadY() {
    if (reloadY === null) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(reloadY, max));
    restoredY = window.scrollY;
    if (max >= reloadY) reloadY = null;
  }

  // What the reader is looking at stays where it is on a refresh. Keeping
  // the scroll position alone is not that: when anything above grows or
  // shrinks - a kind chip wrapping to another line, the block card, the list
  // of peers not on the map - everything below moves. Chrome makes up for it
  // itself (scroll anchoring); Safari does not, and the page jumped up and
  // down there on its own. The anchor is the topmost table row
  // on screen, else the topmost card.
  // A row is held by its place in its group's table, never by the peer in it
  // (28.10.2026): sorted by ping or anything else,
  // a page that followed one peer up or down the list jumped under a reader
  // who was only looking. When a peer moves, another one stands in its
  // place; the list does not move.
  const anchorRows = (card) => [...card.querySelectorAll("tr[data-anchor]")];
  function readAnchor() {
    if (window.scrollY < 1) return null;
    const onScreen = (e) => { const r = e.getBoundingClientRect(); return r.height && r.bottom > 0 && r.top < innerHeight; };
    const e = [...document.querySelectorAll("#tables tr[data-anchor]")].find(onScreen)
      || [...document.querySelectorAll("main .card[id]")].find(onScreen);
    if (!e) return null;
    const card = e.closest(".card[id]");
    const i = e.dataset.anchor ? anchorRows(card).indexOf(e) : -1;
    return { card: card.id, i, top: e.getBoundingClientRect().top };
  }
  function holdAnchor(a) {
    if (!a) return;
    const card = document.getElementById(a.card);
    // A table that got shorter than the place: its last row stands nearest.
    const rows = card && a.i >= 0 ? anchorRows(card) : [];
    const e = card && (a.i < 0 ? card : rows[Math.min(a.i, rows.length - 1)]);
    if (!e || !e.getBoundingClientRect().height) return;
    const d = e.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
  }

  function render() {
    // Read before anything changes: rebuilding the tables makes the page
    // shorter for a moment, and Safari clamps the scroll position to it.
    const y = window.scrollY;
    const anchor = readAnchor();
    const d = state.data;
    // A peer just disconnected or removed here leaves the list at once, not
    // when this service next asks Core: its answer can be ten seconds old.
    d.peers = d.peers.filter((p) => !dashboard().gone(p.addr));
    // The tiles at the top count these same peers.
    const counts = { manual: 0, inbound: 0, outbound: 0 };
    for (const p of d.peers) counts[p.group]++;
    dashboard().liveCounts(counts);
    $("demo").hidden = !d.demo;
    showError([d.error ? "Bitcoin Core: " + d.error + (d.fetched_at ? " - showing the last good peer list." : "") : "", state.worldError || ""].filter(Boolean).join(" "));
    $("version").textContent = "v" + (d.version || "dev");

    renderStatus();
    deliveredNow = deliveredSet();
    deliveredEver = new Set((d.last_block && d.last_block.delivered_ever) || []);
    state.liveShown = Boolean(liveBlock()) || deliveredNow.size > 0;
    renderBlockCard();
    renderMarkers();
    renderUnplaced();
    renderTables();
    if (window.scrollY !== y) window.scrollTo(0, y);
    if (!dashboard().folding()) holdAnchor(anchor);
    restoreReloadY();
    const hash = d.last_block && d.last_block.hash;
    if (hash && state.lastHash && hash !== state.lastHash) pulseBlock();
    if (hash) state.lastHash = hash;
  }

  // Nodes are what passes blocks on (every "Node (...)" kind and pool nodes),
  // disguised is everything pretending, LinkingLion included; the rest -
  // wallets, crawlers, indexers, unknown - are "others", so the three add up.
  // Named once, in the tooltip and the Disguised explanation, not on every card.
  const LION_CREDIT = "Tracked by 0xB10C, b10c.me";
  const isNode = (p) => p.kind.startsWith("Node (") || p.kind === "Pool node";
  // A dot in front of the status line beats once when fresh peers arrive.
  const liveDot = document.createElement("span");
  liveDot.className = "live-dot";
  liveDot.setAttribute("aria-hidden", "true");
  // Off again once it has beaten: the status line is rewritten every second
  // for its tooltip's clock, and putting the dot back with the class on beats it anew.
  liveDot.addEventListener("animationend", () => liveDot.classList.remove("beat"));
  function beat() {
    liveDot.classList.remove("beat");
    void liveDot.offsetWidth; // restart the animation
    liveDot.classList.add("beat");
  }

  function renderStatus() {
    const d = state.data;
    if (!d) return;
    const since = d.fetched_at ? ago(Date.now() / 1000 - d.fetched_at) + " ago" : "never";
    const mode = state.paused ? "paused" : `every ${d.interval}s while open`;
    const disguised = d.peers.filter((p) => p.kind === "Disguised" || p.linking_lion).length;
    const nodes = d.peers.filter((p) => !(p.kind === "Disguised" || p.linking_lion) && isNode(p)).length;
    const others = d.peers.length - nodes - disguised;
    const el = $("status");
    el.textContent = `${d.peers.length} peers: ${nodes} nodes, ${disguised} disguised, ${others} others`;
    // Grey whenever what is shown is not fresh: paused, unreachable, or Core
    // failing and the last good list standing in.
    liveDot.classList.toggle("stale", state.paused || state.failed || !!d.error);
    el.prepend(liveDot);
    // The dot says it is live; when and how often only on hover.
    el.title = `Updated ${since} · ${mode}`;
  }

