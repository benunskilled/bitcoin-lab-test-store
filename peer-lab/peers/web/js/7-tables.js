  // All inbound peers or the top ten. Opening, what is above stays and the
  // rest rolls out below it; closing from the button at the end, the button
  // stays under the finger and the list rolls up into it. From the bar at
  // the top there is no button there to keep: the list closes, and the
  // card's head comes back to the top of the screen.
  const inboundWrap = () => document.querySelector("#group-inbound .scroll");
  const moreButton = () => document.querySelector("#group-inbound > button.more");
  function showAllInbound(all) {
    foldInPlace({ anchor: all ? inboundWrap : moreButton, box: inboundWrap, open: all, set: (o) => {
      state.showAllInbound = o;
      renderTables();
    } });
  }
  function topOnly() {
    state.showAllInbound = false;
    renderTables();
    const c = $("group-inbound");
    if (c && c.getBoundingClientRect().top < 0) c.scrollIntoView({ block: "start", behavior: glide() });
  }
  function stickOn() {
    const stick = document.querySelector("#tables .stick");
    if (!stick) return;
    const card = stick.parentElement;
    stick.classList.toggle("on", card.querySelector(".group-head").getBoundingClientRect().bottom < 0
      && card.getBoundingClientRect().bottom > 140);
  }
  window.addEventListener("scroll", stickOn, { passive: true });

  function renderTables() {
    // A row reached with the arrow keys keeps the focus through a redraw, and
    // so does the button that redrew it (a sort, "Show all").
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.anchor;
    const focusKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focusKey;
    // A panel left open for a peer that is gone must not pop open when its address comes back.
    const live = new Set(state.data.peers.map((p) => p.group + " " + p.addr));
    // An offline manual peer is a row too, and stays open like any other.
    for (const r of dashboard().offlineManual()) live.add("manual " + r.address);
    for (const k of state.openRows) if (!live.has(k)) state.openRows.delete(k);
    const root = $("tables");
    root.textContent = "";
    root.removeAttribute("aria-busy");
    let picksShown = false;
    for (const g of GROUPS) {
      const { peers, all, kindPool } = groupPeers(g);
      const card = document.createElement("section");
      card.className = "card group-card";
      card.id = "group-" + g;
      const head = groupHead(card, g, peers, all, kindPool);
      if (head.picksShown) picksShown = true;

      if (peers.length) {
        const spread = document.createElement("p");
        spread.className = "kinds spread";
        // 📡: peers that picked your node as one of their three
        // high-bandwidth peers, counted in this group's own rows - not
        // "take blocks from you first": your node pushes to them unasked,
        // whoever else is faster.
        const fed = peers.filter((p) => p.hb_from).length;
        spread.textContent = spreadText(peers) + (g === "manual" ? " \u00b7 " + dashboard().manualSummary() : "")
          + (fed ? " \u00b7 \ud83d\udce1 " + fed + (fed === 1 ? " gets" : " get") + " new blocks from you unasked" : "");
        card.appendChild(spread);
      }

      if (!peers.length) {
        const p = document.createElement("p");
        p.className = "empty";
        // No inbound at all is what most nodes see; say what brings them.
        p.textContent = state.place || state.group
          ? "None here."
          : g === "inbound" ? "No inbound peers - normal for most nodes. For incoming clearnet connections, allow incoming clearnet in your Bitcoin Node app and open port 8333 on your router."
          : "No " + LABEL[g].toLowerCase() + " peers.";
        card.appendChild(p);
        root.appendChild(card);
        continue;
      }

      // Inbound runs to a couple of hundred rows and pushed Outbound and Manual
      // far down the page, so it shows its top ten - in the order of the
      // current sort - with a toggle for the rest. The others never get long.
      const limited = g === "inbound" && peers.length > INBOUND_LIMIT;
      card.appendChild(peerTable(g, peers, limited && !state.showAllInbound));
      if (limited) showAllButton(card, head.summary, g, peers);
      root.appendChild(card);
    }
    // A second kind turned up since a name was picked: no card shows the name
    // chips any more, so the pick goes too rather than filter two kinds unseen.
    // Asked of all cards together: the pick sits in one of them, and asked of
    // each card, any other card without its chips dropped every pick the
    // moment it was made (2.5.0).
    if (state.group && !special(state.group) && !picksShown && (state.sub || state.label)) {
      state.sub = state.label = null;
      queueMicrotask(applyFilters);
    }
    for (const row of root.querySelectorAll(".one-line")) fitOneLine(row);
    fitTables();
    stickOn();
    restoreFocus(root, focused, focusKey);
  }

  // The peers of one group as the filters leave them: `all` before any
  // filter, `kindPool` before this group's own kind filter (its chips count
  // those), `peers` what the table shows.
  function groupPeers(g) {
    let peers = state.data.peers.filter((p) => p.group === g);
    const all = peers.length;
    if (state.place) peers = peers.filter(peerMatchesPlace);
    const kindPool = peers;
    if (state.group) peers = peers.filter(matchesKind);
    // A manual peer that is not connected still holds its slot: it stands
    // in the list with the others, from what the dashboard knows of it.
    // Connected again by the time this list was asked for, though the
    // dashboard's picture is older: it stands once, as connected.
    if (g === "manual" && !state.place && !state.group) {
      const here = new Set(state.data.peers.map((p) => p.addr));
      peers = peers.concat(dashboard().offlineManual().filter((r) => !here.has(r.address)).map(offlinePeer));
    }
    return { peers, all, kindPool };
  }

  // The group's head: its name, the count, the chips of its kinds, and under
  // it the picks of a kind's names. Says whether those picks are shown.
  function groupHead(card, g, peers, all, kindPool) {
    let picksShown = false;
    const summary = document.createElement("div");
    summary.className = "group-head";
    const h = document.createElement("h2");
    const sw = document.createElement("span");
    sw.className = "swatch s-" + g;
    h.append(sw, LABEL[g]);
    foldable(card, h, "group-" + g);
    // The count beside the name - it picks nothing, so it is not among the
    // chips below. Those are the mix of kinds, counted before this group's
    // own kind filter, so a group the filter emptied still offers the way
    // back - and switching kinds is one click.
    const count = document.createElement("span");
    count.className = "kinds chips head-count";
    const n = document.createElement("span");
    n.className = "chip count";
    const ni = document.createElement("i");
    ni.textContent = state.place || state.group ? `${peers.length} of ${all}` : String(all);
    n.append(ni, " peers");
    count.appendChild(n);
    const mix = document.createElement("span");
    mix.className = "kinds chips";
    // How many are catching up from this node right now, and what they took.
    const syncing = kindPool.filter((p) => p.sync_mb);
    // A chip that would pick every peer of the card picks nothing: left out.
    if (syncing.length && (state.group === SYNCING || (!state.group && syncing.length < kindPool.length))) {
      const sc = document.createElement("button");
      sc.type = "button";
      sc.className = "chip kind-pick syncing" + (state.group === SYNCING ? " on" : "");
      const taken = `${syncing.length} syncing from this node, ${mbText(syncing.reduce((t, p) => t + p.sync_mb, 0))} of blocks taken so far`;
      sc.title = state.group === SYNCING ? "Show every kind again" : taken + " - click to show only these";
      sc.setAttribute("aria-pressed", String(state.group === SYNCING));
      const si = document.createElement("i");
      si.textContent = syncing.length;
      const ico = document.createElement("span");
      ico.className = "sync-ico";
      ico.setAttribute("aria-hidden", "true");
      ico.textContent = "\u21bb";
      sc.append(ico, si, " syncing");
      sc.addEventListener("click", () => steady(sc, () => setGroup(SYNCING)));
      mix.appendChild(sc);
    }
    const forked = kindPool.filter(offChain);
    let fc = null;
    if (forked.length && (state.group === FORKED || (!state.group && forked.length < kindPool.length))) {
      fc = document.createElement("button");
      fc.type = "button";
      fc.className = "chip kind-pick forked" + (state.group === FORKED ? " on" : "");
      fc.title = state.group === FORKED ? "Show every kind again"
        : `${forked.length} not on your chain (${[...new Set(forked.map((p) => p.fork || OTHER_CHAIN))].join(", ")}) - click to show only these`;
      fc.setAttribute("aria-pressed", String(state.group === FORKED));
      const fi = document.createElement("i");
      fi.textContent = forked.length;
      fc.append(fi, " other chain");
      fc.addEventListener("click", () => steady(fc, () => setGroup(FORKED)));
    }
    // Only one group here (Outbound and Manual are often all nodes): no chip
    // for it, and its kinds, or their names, show straight away instead.
    const only = kindPool.length ? renderKindMix(mix, kindPool) : null;
    // Nodes of another chain are nodes too: beside "Nodes", else first.
    if (fc) {
      const nodes = mix.querySelector('[data-group="Nodes"]');
      if (nodes) nodes.after(fc);
      else {
        const sync = mix.querySelector(".syncing");
        if (sync) sync.after(fc); else mix.prepend(fc);
      }
    }
    summary.append(h, count);
    if (mix.childElementCount) summary.appendChild(mix);
    card.appendChild(summary);
    const group = state.group && !special(state.group) ? state.group : only;
    if (group) {
      const inGroup = kindPool.filter((p) => groupOf(p.kind) === group);
      renderKindPicks(card, inGroup, group);
      // The names belong to one kind: the one picked, or the only one there is.
      const kinds = new Set(inGroup.map((p) => p.kind));
      const kind = state.kind || (kinds.size === 1 ? [...kinds][0] : null);
      if (kind) {
        picksShown = true;
        renderSubMix(card, kind, inGroup.filter((p) => p.kind === kind), group);
        renderLabelMix(card, inGroup.filter((p) => p.kind === kind), group);
      }
    }
    return { summary, picksShown };
  }

  // The table of one group, sorted as its header says; `top` shows only the
  // first INBOUND_LIMIT rows.
  function peerTable(g, peers, top) {
    const s = state.sort[g] || { key: "first", dir: 1 };
    const col = COLS.find((c) => c.key === s.key) || COLS[COLS.length - 1];
    peers.sort((a, b) => {
      const x = col.val(a), y = col.val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * s.dir;
    });

    const wrap = document.createElement("div");
    wrap.className = "scroll";
    const table = document.createElement("table");
    table.className = "peers";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const c of COLS) {
      const th = document.createElement("th");
      th.scope = "col";
      th.className = "k-" + c.key + (c.cls ? " " + c.cls : "");
      if (c.key === col.key) th.setAttribute("aria-sort", s.dir > 0 ? "ascending" : "descending");
      const b = document.createElement("button");
      b.textContent = c.label;
      b.dataset.focusKey = "sort " + g + " " + c.key;
      b.addEventListener("click", () => steady(b, () => {
        state.sort[g] = { key: c.key, dir: c.key === col.key ? -s.dir : 1 };
        renderTables();
      }));
      if (c.title) b.title = c.title;
      th.appendChild(b);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const p of top ? peers.slice(0, INBOUND_LIMIT) : peers) peerRow(tbody, g, p);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // One peer's row, and its open detail below it if it was left open.
  function peerRow(tbody, g, p) {
    const tr = document.createElement("tr");
    tr.dataset.anchor = g + " " + p.addr;
    // The peer that brought the newest block, for as long as the star
    // is up - one rule for "just delivered", in the row and on the map.
    if (deliveredNow.has(p.addr)) tr.className = "delivered-now";
    // A connection that has brought this node a block, at least once: its address in green, also on an orange row.
    if (deliveredEver.has(p.addr) || deliveredNow.has(p.addr)) tr.classList.add("delivered-ever");
    if (p.no_relay || p.offline) tr.classList.add("weak");
    for (const c of COLS) {
      const td = document.createElement("td");
      if (c.cls) td.className = c.cls;
      td.classList.add("k-" + c.key);
      td.dataset.label = c.label;
      if (c.cell) {
        c.cell(td, p);
      } else {
        const text = c.show ? c.show(p) : c.val(p);
        td.textContent = text === "" ? "–" : text;
        if (text === "") td.classList.add("dim");
      }
      tr.appendChild(td);
    }
    const rowKey = g + " " + p.addr;
    if (arrivedAt.has(rowKey)) tr.classList.add("arrived");
    const reopen = state.openRows.has(rowKey);
    if (reopen) {
      tr.classList.add("open");
      tr.querySelector(".chev")?.setAttribute("aria-expanded", "true");
    }
    // With a mouse, the row's place lights up on the map.
    tr.addEventListener("mouseenter", () => hoverPlace(p, true));
    tr.addEventListener("mouseleave", () => hoverPlace(p, false));
    tr.tabIndex = -1;
    tr.addEventListener("click", (ev) => {
      // Links and buttons keep doing their own thing; so does selecting text.
      if (ev.target.closest("a, button, input, select, textarea") && !ev.target.closest(".chev")) return;
      if (String(window.getSelection()).length > 0) return;
      toggleDetail(tr, p, rowKey);
    });
    tbody.appendChild(tr);
    if (reopen) tbody.appendChild(detailRow(tr, p, rowKey));
  }

  // Inbound's "Show all", and with the whole list open the bar that rides
  // along at the top of the screen.
  function showAllButton(card, summary, g, peers) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.dataset.focusKey = "more " + g;
    more.textContent = state.showAllInbound ? `Show top ${INBOUND_LIMIT} only` : `Show all ${peers.length}`;
    more.addEventListener("click", () => showAllInbound(!state.showAllInbound));
    card.appendChild(more);
    // The whole list open: its name and the way back to the top ten ride
    // along at the top of the screen once the head has scrolled away, so
    // nobody has to scroll to the end to close it.
    if (state.showAllInbound) {
      const stick = document.createElement("div");
      stick.className = "stick";
      const bar = document.createElement("div");
      const name = document.createElement("span");
      const ssw = document.createElement("span");
      ssw.className = "swatch s-" + g;
      name.append(ssw, `${LABEL[g]} · ${peers.length}`);
      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn";
      back.textContent = `Top ${INBOUND_LIMIT}`;
      back.addEventListener("click", topOnly);
      bar.append(name, back);
      stick.appendChild(bar);
      summary.after(stick);
    }
  }

  function restoreFocus(root, focused, focusKey) {
    if (focused) {
      const back = root.querySelector(`tr[data-anchor="${CSS.escape(focused)}"]`);
      if (back) back.focus({ preventScroll: true });
    } else if (focusKey) {
      const back = root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (back) back.focus({ preventScroll: true });
    }
  }

  // A table that does not fit its card turns each row into a small card of
  // its own (see .scroll.cards in style.css) instead of scrolling sideways:
  // every value stays, below each other rather than beside. Decided by
  // measuring, not by a fixed screen width - the columns are as wide as
  // their content, and a closed group has no width to measure until it opens.
  // All groups switch together: one group as cards and the next as a table
  // looked like two different pages.
  // Measuring takes the cards away for a moment, and on a phone the page is
  // then far shorter: Safari clamps the scroll position to it and keeps it
  // there, so a reader far down was thrown up on every refresh. The position
  // is put back before anything is painted.
  //
  // Before that, a tight table gives up what matters least, a step at a time
  // (see [data-drops] in style.css): Connected, then Ping, then Net. The
  // first steps are also taken when the tables would fit but the kind's text
  // would be cut. From CARD_LEVEL on (it would lose its net and First/Blocks)
  // the peers become cards, so the fourth step - Operator - is never shown as
  // a table. The address always stays.
  const DROP_LEVELS = 4, KIND_LEVEL = 3, CARD_LEVEL = 3;
  function fitTables() {
    const y = window.scrollY;
    const wraps = [...document.querySelectorAll("#tables .scroll")];
    // A second reason never decides which columns go: measured with the first
    // alone, and put back below where it fits whole.
    const seconds = [...document.querySelectorAll("#tables [data-one]")];
    for (const e of seconds) e.textContent = e.dataset.one;
    const unalign = () => { for (const w of wraps) w.querySelector("table.peers")?.classList.remove("aligned"); };
    for (const w of wraps) w.classList.remove("cards");
    // Tight when the shared widths (alignColumns) together are wider than
    // the card. Each table is measured there too; asking whether one table
    // overflows on its own counted Kind at its full length again.
    const tight = () => {
      unalign();
      return sharedTooWide(wraps);
    };
    let level = 0;
    for (; ; level++) {
      for (const w of wraps) w.dataset.drops = String(level);
      if (level === DROP_LEVELS) break;
      if (tight()) continue;
      // The sum above is a forecast. What the laid-out table really needs
      // decides: a forecast a few pixels short let Crawler and Core 22.x
      // run 2-3px past the card at 960px.
      alignColumns(wraps);
      if (overflows(wraps)) continue;
      if (level < KIND_LEVEL && kindCut(wraps)) continue;
      break;
    }
    let cards = level === DROP_LEVELS && tight();
    if (!cards) {
      alignColumns(wraps);
      cards = level === DROP_LEVELS && overflows(wraps);
      if (cards) unalign();
    }
    // Cards come as soon as a table would lose its net and First/Blocks
    // (CARD_LEVEL): a card that wide shows more than the three columns left
    // (12.11.2026).
    if (level >= CARD_LEVEL && !cards) { cards = true; unalign(); }
    for (const w of wraps) w.classList.toggle("cards", cards);
    // A second reason only where it fits whole, never cut short (09.11.2026):
    // on a card its own line, in the wide list the grey line it sits in.
    for (const e of seconds) {
      const box = e.closest("small") || e;
      e.textContent = e.dataset.full;
      if (box.scrollWidth > box.clientWidth + 1) e.textContent = e.dataset.one;
    }
    // A phone puts the kind beside the place. Reserve its actual width,
    // including either or both relay marks, instead of a fixed pill-sized gap.
    for (const w of wraps) for (const row of w.querySelectorAll("tr[data-anchor]")) {
      const head = row.querySelector(".kind-head");
      if (cards && head) row.style.setProperty("--kind-space", Math.ceil(head.getBoundingClientRect().width) + 12 + "px");
      else row.style.removeProperty("--kind-space");
    }
    if (window.scrollY !== y) window.scrollTo(0, y);
  }
  const overflows = (wraps) => wraps.some((w) => w.clientWidth && w.scrollWidth > w.clientWidth + 1);
  const kindCut = (wraps) => wraps.some((w) =>
    [...w.querySelectorAll("td.k-kind small.ua")].some((e) => e.offsetWidth && e.scrollWidth > e.clientWidth + 1));

  // Inbound, Outbound and Manual have the same columns, and each table sized
  // them to its own content: Operator, Kind, Net and Ping stood in a
  // different place in every group, so the page read as three. Each column
  // now gets the widest of the three natural widths, the same in every
  // table, and fixed layout spreads the rest of the card's width the same way
  // in each. A closed group has no width to measure and is left out until it
  // opens (the toggle listener runs this again).
  const colKey = (th) => [...th.classList].find((c) => c.startsWith("k-")) || String(th.cellIndex);
  function sharedWidths(wraps) {
    const tables = wraps.map((w) => w.querySelector("table.peers")).filter((t) => t && t.offsetWidth);
    const widths = new Map();
    for (const t of tables) {
      t.classList.add("measure");
      for (const th of t.tHead.rows[0].cells) th.style.width = "";
    }
    for (const t of tables) {
      for (const th of t.tHead.rows[0].cells) {
        widths.set(colKey(th), Math.max(widths.get(colKey(th)) || 0, th.getBoundingClientRect().width));
      }
      t.classList.remove("measure");
    }
    return { tables, widths };
  }
  // For the question whether columns must go, Kind counts as wide as an
  // ordinary entry needs (a pill and a line of what Core saw): one long text
  // among two hundred peers took Operator, Net, Ping and Connected away from
  // all three tables and left Outbound and Manual mostly empty. A longer
  // text is cut and shown whole on hover.
  const KIND_MIN = 200;
  function sharedTooWide(wraps) {
    const { tables, widths } = sharedWidths(wraps);
    let sum = 0;
    // alignColumns never gives Kind less than KIND_MIN, so that is what it
    // counts here too: a short kind (a filter showing only the reason line)
    // passed as fitting and then pushed the table past the card's edge.
    // The others are rounded up the way alignColumns rounds them.
    for (const [k, v] of widths) sum += k === "k-kind" ? KIND_MIN : Math.ceil(v);
    return tables.some((t) => sum > t.parentElement.clientWidth + 1);
  }
  // Kind gets what it needs - cut, and whole on hover, only when there is
  // truly no room - and what the card has left over is shared by every
  // column in proportion to its width. Kind used to take all of it, which was
  // right while it carried the peer's own name; without that it stood half
  // empty across a wide screen (28.10.2026).
  function alignColumns(wraps) {
    const { tables, widths } = sharedWidths(wraps);
    let others = 0;
    for (const [k, v] of widths) if (k !== "k-kind") others += Math.ceil(v);
    for (const t of tables) {
      const spare = t.parentElement.clientWidth - others;
      const kind = Math.max(KIND_MIN, Math.min(spare, Math.ceil(widths.get("k-kind") || 0)));
      const total = others + kind;
      const grow = spare > kind ? (t.parentElement.clientWidth) / total : 1;
      let used = 0;
      const cells = [...t.tHead.rows[0].cells];
      cells.forEach((th, i) => {
        const k = colKey(th);
        const base = k === "k-kind" ? (spare > kind ? kind : Math.max(KIND_MIN, spare)) : Math.ceil(widths.get(k));
        // The last column takes the rounding, so the row ends at the card's edge.
        const w = i === cells.length - 1 && grow > 1 ? t.parentElement.clientWidth - used : Math.floor(base * grow);
        used += w;
        th.style.width = w + "px";
      });
      t.classList.add("aligned");
    }
  }
  let fitTimer = null;
  // Only a change of width can change whether the tables fit; on an iPhone the
  // height changes all the time while Safari's toolbar shrinks and grows.
  let fitWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === fitWidth) return;
    fitWidth = window.innerWidth;
    clearTimeout(fitTimer); fitTimer = setTimeout(fitTables, 100);
  });
  document.addEventListener("toggle", fitTables, true);


  // ---------- start ----------
  setupPanZoom();
  loadWorld()
    .then(() => { if (state.data) renderMarkers(); })
    .catch((e) => { state.worldError = "The world map could not be loaded: " + e.message; showError(state.worldError); });
  startTicker();
  refresh();
