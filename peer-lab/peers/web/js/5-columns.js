  // ---------- tables ----------

  // The kind is what the peer calls itself, the flags are what Core observed.
  // A claim that does not fit what was observed shows as the reason under the
  // pill (p.tell); the flags themselves are in the panel.
  // A node catching up from this one: a turning arrow, the word and what it
  // has taken. Always first in the grey line under the place.
  // What "no headers" means, on hover: Core never got a block header from the peer.
  // BIP159: NETWORK_LIMITED alone promises only the last 288 blocks. Every
  // Core since 0.16 sets it next to NETWORK, so only a node without NETWORK is
  // pruned. Said of nodes only: a disguised peer's bits are as made up as its name.
  const PRUNED_WHY = "Keeps only recent blocks";
  // The one line a filtered phone card has: the most important thing about
  // the peer that the pill does not say already (09.11.2026). In the syncing
  // filter, what put it there; else whose pool; why a disguise is one, what
  // it did before what it says; for a node another chain, or the software
  // where the pill says only "other", or whether it keeps every block; for the
  // rest what it did, then what it is, and its user agent where nothing is
  // known. Never empty, so every card in a filter is one height.
  const probablyOf = (p) => ((p.about || "").split("\n").find((l) => l.startsWith("Probably: ")) || "").slice("Probably: ".length);
  const cardLine = (p) => {
    if (p.offline) return "holds its slot";
    if (p.sync_mb) return "syncing " + mbText(p.sync_mb);
    if (p.kind === POOL_KIND) return (p.pool || UNKNOWN_POOL) + (/block relay/i.test(p.about || "") ? " \u00b7 block relay" : "");
    if (p.linking_lion) return p.tell || "on 0xB10C's list";
    if (p.kind === "Disguised") return p.tell || probablyOf(p);
    if (p.kind.startsWith("Node")) {
      if (p.fork) return p.fork;
      // A known block relay's address: whose relay it is (peers.go, relayOf).
      if (p.tell) return p.tell;
      if (p.kind === "Node (other)" && p.label) return p.label;
      const s = p.services || [];
      return s.includes("NETWORK") ? "full node" : s.includes("NETWORK_LIMITED") ? "pruned" : s.length ? "serves no blocks" : "";
    }
    return p.tell || p.label || probablyOf(p) || (p.about || "").split("\n")[0] || p.subver || "";
  };
  const isPruned = (p) => p.kind.startsWith("Node") && !!p.services && p.services.includes("NETWORK_LIMITED") && !p.services.includes("NETWORK");
  const NO_HEADERS_WHY = "This peer has never sent Core a block header, so Core cannot tell which chain it follows";
  function mbText(mb) {
    return mb >= 1000 ? (mb / 1000).toFixed(1) + " GB" : mb + " MB";
  }
  function syncSpan(p) {
    const s = document.createElement("span");
    s.className = "syncing";
    // Core counts bytes per connection, so this is the session, not the whole sync.
    s.title = `Syncing from your node: ${mbText(p.sync_mb)} of blocks since it connected`;
    const ico = document.createElement("span");
    ico.className = "sync-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = "\u21bb";
    s.append(ico, " syncing " + mbText(p.sync_mb));
    return s;
  }


  // The mix under a heading counts what is in the table - and each count is
  // the way to those peers. Clicking "5 Pool node" shows exactly those five,
  // here and on the map; clicking it again puts everyone back.
  function renderKindMix(el, peers) {
    const n = new Map();
    // Altcoins are in the "other chain" chip beside these, not a group of their own.
    for (const p of peers) if (p.kind !== OTHER_CHAIN) n.set(groupOf(p.kind), (n.get(groupOf(p.kind)) || 0) + 1);
    const entries = [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // One kind of peer and nothing else: its chip would pick every peer there
    // is, so it picks nothing. The caller shows what it would have opened.
    if (!state.group && entries.length === 1 && entries[0][1] === peers.length) return entries[0][0];
    // Five groups fit a phone in two lines: no "+ n more" here.
    entries.forEach(([group, count]) => {
      // With one group picked the others step aside: on a phone they would
      // fill the screen above the chips that matter now.
      if (state.group && state.group !== group) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip kind-pick" + (state.group === group ? " on" : "");
      const i = document.createElement("i");
      i.textContent = count;
      b.append(i, " " + group);
      b.title = state.group === group ? "Show every kind again" : `Show only ${group}`;
      b.setAttribute("aria-pressed", String(state.group === group));
      b.addEventListener("click", () => steady(b, () => setGroup(group)));
      el.appendChild(b);
    });
    return null;
  }

  // With a group picked, the kinds in it, when there is more than one: the
  // second level, laid out like the names below it. `group` is the group
  // these peers are in, picked or the only one there is: a pick here picks it.
  function renderKindPicks(card, peers, group) {
    const n = new Map();
    for (const p of peers) n.set(p.kind, (n.get(p.kind) || 0) + 1);
    if (n.size < 2 && !state.kind) return;
    const el = document.createElement("div");
    el.className = "kinds chips pool-picks";
    for (const [kind, count] of [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip kind-pick" + (state.kind === kind ? " on" : "");
      const i = document.createElement("i");
      i.textContent = count;
      b.append(i, " " + kind);
      b.title = state.kind === kind ? "Show the whole group again" : `Show only ${kind}`;
      b.setAttribute("aria-pressed", String(state.kind === kind));
      b.addEventListener("click", () => steady(b, () => setKind(kind, group)));
      el.appendChild(b);
    }
    card.appendChild(el);
  }

  // With a kind picked, what those peers are one level down: one chip per
  // pool, version or name, the unknown ones last. Nothing to pick from one.
  function renderSubMix(card, kind, peers, group) {
    const n = new Map();
    for (const p of peers) n.set(subOf(p), (n.get(subOf(p)) || 0) + 1);
    if (n.size < 2 && !state.sub) return;
    // Largest first, like the kinds above: with one line to show, the largest
    // are the ones to see. What is not known by name comes last.
    const last = (s) => s === UNKNOWN_POOL || s === NO_NAME;
    const entries = [...n].sort((a, b) => last(a[0]) - last(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
    const el = document.createElement("div");
    el.className = "kinds chips pool-picks";
    const label = document.createElement("span");
    label.className = "picks-label";
    label.textContent = subLabel(kind);
    el.appendChild(label);
    for (const [sub, count] of entries) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip kind-pick" + (state.sub === sub ? " on" : "");
      const i = document.createElement("i");
      i.textContent = count;
      b.append(i, " " + sub);
      b.title = state.sub === sub ? "Show all of them again" : `Show only ${sub}`;
      b.setAttribute("aria-pressed", String(state.sub === sub));
      b.addEventListener("click", () => steady(b, () => setSub(sub, group)));
      el.appendChild(b);
    }
    card.appendChild(el);
    // One line only: what does not fit waits behind "+ n more", fitted in
    // renderTables before the page is drawn, so nothing flickers.
    if (!state.allSubs) el.classList.add("one-line");
  }

  // The operators' own labels on these nodes, those that more than one node
  // carries: one chip each, beside the versions. A label on a single node is
  // somebody's name for their box, not something to filter by. Nor is one
  // label that every node carries: it would pick them all.
  function renderLabelMix(card, peers, group) {
    const n = new Map();
    for (const p of peers) {
      const l = labelOf(p);
      if (l) n.set(l, (n.get(l) || 0) + 1);
    }
    const entries = [...n].filter(([l, c]) => c > 1 || l === state.label).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!entries.length) return;
    if (entries.length === 1 && entries[0][1] === peers.length && !state.label) return;
    const el = document.createElement("div");
    el.className = "kinds chips pool-picks";
    const head = document.createElement("span");
    head.className = "picks-label";
    head.textContent = "Labels:";
    el.appendChild(head);
    for (const [l, count] of entries) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip kind-pick" + (state.label === l ? " on" : "");
      const i = document.createElement("i");
      i.textContent = count;
      b.append(i, " " + l);
      b.title = state.label === l ? "Show all of them again" : `Show only the nodes labelled ${l}`;
      b.setAttribute("aria-pressed", String(state.label === l));
      b.addEventListener("click", () => steady(b, () => setLabel(l, group)));
      el.appendChild(b);
    }
    card.appendChild(el);
  }

  // How spread out a group is: distinct operators and countries. Operators by
  // the name in the Operator column, not by ASN: a large company runs several
  // ASNs (Amazon has AS16509 and AS14618) and should still count once. Peers
  // that cannot be placed - Tor, I2P, private addresses - have no country, and
  // are named instead of being silently left out. Your Umbrel's own network
  // has an operator line but is no provider, so it is not counted as one.
  function spreadText(peers) {
    const ops = new Set(), ccs = new Set();
    let unplaced = 0;
    for (const p of peers) {
      if ((p.operator || p.asn) && p.network !== "not_publicly_routable") ops.add(p.operator || "AS" + p.asn);
      if (p.cc) ccs.add(p.cc);
      else unplaced++;
    }
    const parts = [];
    if (ops.size) parts.push(ops.size + (ops.size === 1 ? " provider" : " providers"));
    if (ccs.size) parts.push(ccs.size + (ccs.size === 1 ? " country" : " countries"));
    if (unplaced) parts.push(unplaced + " not placed");
    return parts.join(" \u00b7 ");
  }

  const TRANSPORT_TITLE = {
    v1: "Unencrypted - the original P2P protocol",
    v2: "Encrypted (BIP324) - an eavesdropper on the line cannot read what passes between the nodes; it does not prove who is on the other end",
  };

  // Two lines per peer, as in the approved design: what a row is about on
  // top, the detail under it - the software, the AS number, the address -
  // so nothing needs a pointer to be read.
  const placeTitle = (p) => p.network === "not_publicly_routable" ? (p.app || "This Umbrel")
    : p.region || (p.cc ? regionName(p.cc) : netLabel(p.network));
  const neverNote = (p) => !p.no_relay ? ""
    : p.fork ? "On a chain of its own, not yours - it can never deliver one of your blocks first."
    : p.no_services ? "Offers no services, so your node never asks it for blocks - it will not deliver one first."
    : "Software that does not pass blocks on - this peer can never deliver one first.";
  const line = (cls, text) => {
    const e = document.createElement("small");
    e.className = cls;
    e.textContent = text;
    return e;
  };

  const COLS = [
    {
      // Where it is on top, the country and the address under it. Sorted by
      // country first - otherwise Bavaria and Hesse end up on either side of
      // England. Peers without a place sort last.
      key: "peer", label: "Peer", cls: "peer",
      val: (p) => (p.cc ? regionName(p.cc) + "\u0000" + (p.region || "") : "\uffff" + p.addr),
      cell: (td, p) => {
        const who = document.createElement("div");
        who.className = "who";
        // A small arrow at the left: the row opens on a tap or a click.
        // A mouse or finger hits the row; the keyboard reaches the same thing here.
        const chev = document.createElement("button");
        chev.type = "button";
        chev.className = "chev";
        chev.setAttribute("aria-label", "Show everything about this peer");
        chev.setAttribute("aria-expanded", "false");
        chev.textContent = "\u203a";
        who.appendChild(chev);
        const f = document.createElement("span");
        f.className = "flag";
        f.textContent = HIDDEN_FLAG[p.network] || flagOf(p.cc);
        const text = document.createElement("div");
        text.className = "who-text";
        const title = placeTitle(p);
        const b = fit(document.createElement("b"), title);
        b.textContent = title;
        if (HIDDEN[p.network]) b.dataset.tip = HIDDEN[p.network].tip;
        const sub = document.createElement("small");
        if (p.region && p.cc) {
          sub.append(regionName(p.cc) + " ");
        }
        // What the row colour means, said where the peer is named rather
        // than over every cell of the row.
        const got = deliveredNow.has(p.addr) ? "Delivered the newest block first"
          : deliveredEver.has(p.addr) ? "Has delivered a block first" : "";
        fit(sub, p.addr, got);
        if (deliveredNow.has(p.addr)) {
          const star = document.createElement("span");
          star.className = "star";
          star.textContent = "\u2605";
          star.title = "Delivered the block that just landed";
          sub.appendChild(star);
        }
        {
          const a = document.createElement("span");
          a.className = "addr-txt";
          a.textContent = p.addr;
          sub.appendChild(a);
        }
        text.append(b, sub);
        who.append(f, text);
        // A wide card (12.11.2026), where a table would have had to drop
        // columns: the place and the address as on a phone card, then the kind
        // with the provider under it, and with more width First/Blocks, ping
        // and time connected. A phone keeps the card it always had; this one
        // is hidden there and in a table (style.css).
        {
          const pc = document.createElement("div");
          pc.className = "pc";
          const span = (cls, text) => { const e = document.createElement("span"); e.className = cls; if (text != null) e.textContent = text; return e; };
          const land = span("pc-land");
          land.append(span("flag", HIDDEN_FLAG[p.network] || flagOf(p.cc)), title);
          if (deliveredNow.has(p.addr)) land.append(" ", span("star", "\u2605"));
          const sub = span("pc-sub2");
          if (p.region && p.cc) sub.append(regionName(p.cc) + " ");
          sub.append(span("addr-txt", p.addr));
          const what = span("pc-what");
          const label = p.linking_lion ? "LinkingLion" : p.kind;
          const pill = span("kind " + (p.offline ? "never" : p.linking_lion ? "lion" : p.kind === "Disguised" ? "disg" : p.no_relay ? "never" : "first"),
            (p.no_relay ? "\u2298 " : "") + label);
          for (const [active, symbol] of [[p.hb_to, "\u26a1"], [p.hb_from, "\ud83d\udce1"], [isLocked(p), "\ud83d\udd12"]]) if (active) what.append(span("hb", symbol));
          what.append(pill);
          // Filled column by column (style.css): each pair is one column of the card.
          pc.append(land, sub, what, span("pc-net", p.operator || (p.tor_exit ? "Tor exit" : "")));
          // A wider card has room for what a table would have had to drop: how
          // often the peer was first, then ping and time connected. Shown by
          // the card's width; all of it is in the opened row at any width.
          const r = rankOf(p);
          const n = span("pc-x pc-first", r && r.eligible ? r.first + "/" + r.eligible : "\u2013");
          const s = span("pc-x pc-sub", "first/blocks");
          if (r && r.eligible) n.title = s.title = `First for ${r.first} of the ${r.eligible} blocks it was connected for.`;
          pc.append(n, s);
          pc.append(span("pc-y pc-ping", p.min_ping_ms == null ? "\u2013" : fmtPing(p.min_ping_ms)),
            span("pc-y pc-sub", p.offline ? "offline" : p.conntime ? ago(Date.now() / 1000 - p.conntime) : ""));
          who.appendChild(pc);
        }
        td.appendChild(who);
      },
    },
    {
      // Whose machine it is, with the AS number under it. Sorting by this
      // column catches three peers in three countries with the same company.
      key: "operator", label: "Operator", cls: "op", val: (p) => p.operator || "\uffff",
      cell: (td, p) => {
        if (!p.operator && !p.asn) { td.textContent = "–"; td.classList.add("dim"); return; }
        const name = fit(document.createElement("span"), p.operator || "");
        name.className += " op-name";
        name.textContent = p.operator || "";
        td.appendChild(name);
        // The AS number stays faint; "Tor exit" is bright, because it changes
        // what the row means: the place and operator are the exit's.
        if (p.asn || p.tor_exit) {
          const e = line("sub", p.asn ? "AS" + p.asn + (p.tor_exit ? " · " : "") : "");
          if (p.tor_exit) {
            const tor = document.createElement("span");
            tor.className = "tor-exit";
            tor.textContent = "Tor exit";
            e.append(tor);
          }
          td.appendChild(e);
        }
        if (p.tor_exit) td.title = TOR_EXIT_TITLE;
      },
    },
    {
      // What it calls itself and what Core saw, as a pill; the software it
      // announced under it. A peer that can never deliver a block first is
      // dimmed and says so in the pill - not a fault, a wallet is doing what
      // a wallet does.
      key: "kind", label: "Kind", val: (p) => p.kind || "",
      cell: (td, p) => {
        const head = document.createElement("span");
        head.className = "kind-head";
        const marks = document.createElement("span");
        marks.className = "hb-marks";
        head.appendChild(marks);
        for (const [active, symbol, title] of [[p.hb_to, "⚡", HB_TITLE], [p.hb_from, "📡", HB_FROM_TITLE], [isLocked(p), "🔒", LOCKED_TITLE]]) {
          if (!active) continue;
          const mark = document.createElement("span");
          mark.className = "hb";
          mark.textContent = symbol;
          mark.title = title;
          mark.setAttribute("role", "img");
          mark.setAttribute("aria-label", title);
          marks.appendChild(mark);
        }
        const pill = document.createElement("span");
        // Green for every peer that can deliver a block first, grey for those
        // that never can, red for a disguise or LinkingLion even when it could.
        // LinkingLion has its own pill whatever software it claims; the
        // software stays in the line under it.
        pill.className = "kind " + (p.offline ? "never" : p.linking_lion ? "lion" : p.kind === "Disguised" ? "disg" : p.no_relay ? "never" : "first");
        // The pill says the kind and nothing else, for every peer: what Core
        // saw (no services, no tx, no headers) is in the panel. Software that
        // passes no blocks on gets the ⊘ and a muted row; "never first" is
        // said on hover and in the panel (28.10.2026: beside "offers no
        // services" it said the same twice).
        // One layout in every row, and the pill is never cut.
        const label = p.linking_lion ? "LinkingLion" : p.kind;
        if (p.no_relay) {
          const ico = document.createElement("span");
          ico.className = "ico";
          ico.textContent = "⊘";
          pill.append(ico, " ");
        }
        pill.append(label);
        fit(pill, label, [p.about, p.seen ? "In this session: " + p.seen : "", p.linking_lion ? LION_CREDIT : "", neverNote(p), p.fork_why].filter(Boolean).join("\n"));
        head.appendChild(pill);
        td.appendChild(head);
        // The grey line under the pill, on a wide screen only, is for what
        // the pill cannot say: why a peer is Disguised, or what an unknown or
        // nameless one does (p.tell); which pool a pool node is; that a node
        // is syncing from this one, keeps only recent blocks or enforces rules
        // of its own (fork) - its own settings, whoever is faster. What else Core saw (no tx, no headers)
        // is normal for many peers and only in the panel, with why
        // (28.10.2026: one line for the reason, not a list of flags). A phone
        // card is the place, the address and the pill and nothing more.
        // One grey line under the pill, the same words on every width: the
        // most important thing about the peer that the pill does not say
        // (cardLine). A wide table always has it (11.11.2026: "Wallet" alone
        // did not say which); a phone card only with a filter on, so that
        // unfiltered every card stays two lines (09.11.2026). One line,
        // never wrapped - a kind cell is two lines at most.
        {
          const e = document.createElement("small");
          e.className = "card-line" + (state.group ? "" : " unfiltered");
          // Nothing known still takes its line, or the cards would differ.
          const text = cardLine(p) || "\u00a0";
          e.textContent = text;
          // Syncing keeps its turning arrow; a fork and pruned say why on hover.
          if (p.sync_mb) e.replaceChildren(syncSpan(p));
          // On hover: the whole line where it is cut, and why - the reason's
          // whole sentence (p.why), a fork's or pruned's meaning (fit).
          const why = p.fork && text === p.fork ? p.fork_why : text === "pruned" ? PRUNED_WHY : p.why || "";
          if (!p.sync_mb) fit(e, text, why);
          // A second part stays only where it fits whole (fitTables).
          const two = text.split(" \u00b7 ");
          if (two.length > 1) Object.assign(e.dataset, { full: text, one: two[0] });
          td.appendChild(e);
        }
      },
    },
    {
      // Network and P2P version as two small tags; outbound also its type.
      key: "net", label: "Net", val: (p) => netLabel(p.network) + (p.transport || ""),
      cell: (td, p) => {
        const tag = (text, title, cls) => {
          const e = document.createElement("span");
          e.className = cls ? "net " + cls : "net";
          e.textContent = text;
          if (title) e.title = title;
          td.appendChild(e);
        };
        tag(HIDDEN[p.network] ? HIDDEN[p.network].short : netLabel(p.network) || "–",
          HIDDEN[p.network] ? HIDDEN[p.network].tip : "");
        if (p.transport) tag(p.transport, TRANSPORT_TITLE[p.transport] || "");
        if (p.group === "outbound" && p.type) tag(typeLabel(p.type), "", "type");
      },
    },
    {
      key: "ping", label: "Ping", cls: "num", val: (p) => (p.min_ping_ms == null ? Infinity : p.min_ping_ms),
      cell: (td, p) => {
        if (p.min_ping_ms == null) { td.textContent = "–"; td.classList.add("dim"); return; }
        td.textContent = fmtPing(p.min_ping_ms);
      },
    },
    { key: "conntime", label: "Connected", cls: "num", val: (p) => p.conntime, show: (p) => (p.offline ? "offline" + (p.offline_ms ? " " + ago(p.offline_ms / 1000) : "") : ago(Date.now() / 1000 - p.conntime)) },
  ];
  // How often a peer was first: "43/1693", blocks delivered first out of the
  // blocks it was connected for, counted for as long as it has been known. The
  // list is ordered by the first number; between two with the same count the
  // one that needed fewer blocks stands higher, and a peer without a record
  // comes last. Not on a phone card.
  const FIRST_TITLE = "Blocks this peer delivered first, out of the blocks it was connected for. The list is ordered by it.";
  const FIRST_COL = {
    key: "first", label: "First/Blocks", cls: "num", title: FIRST_TITLE,
    val: (p) => { const r = rankOf(p); return r && r.eligible ? -(r.first * 1e7) + r.eligible : Infinity; },
    cell: (td, p) => {
      const r = rankOf(p);
      if (!r || !r.eligible) { td.textContent = "\u2013"; td.classList.add("dim"); return; }
      const b = document.createElement("b");
      b.textContent = r.first + "/" + r.eligible;
      td.append(b);
      td.title = `First for ${r.first} of the ${r.eligible} blocks it was connected for.`;
    },
  };
  COLS.splice(COLS.findIndex((c) => c.key === "ping"), 0, FIRST_COL);

