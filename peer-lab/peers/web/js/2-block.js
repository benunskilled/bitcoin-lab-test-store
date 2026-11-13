  // ---------- the block that just landed ----------

  // The server says which block arrived last, who mined it, and
  // which peer here delivered it. The mark lasts two minutes - long enough to
  // see on a dashboard somebody just opened, short enough that a star stays a
  // piece of news instead of turning into decoration.
  function liveBlock() {
    const b = state.data && state.data.last_block;
    if (!b || !b.mark_for_ms) return null;
    const age = b.age_ms + Math.max(0, Date.now() - state.receivedAt);
    return age < b.mark_for_ms ? b : null;
  }

  // Refreshed once per render and read by the table and the map, so both
  // always show the same peers starred.
  let deliveredNow = new Set();
  let deliveredEver = new Set();
  // What the measurements know of a peer (window.peerLab, set by the page's
  // other script): blocks delivered first, blocks connected for, the buttons.
  const dashboard = () => window.peerLab;
  // A row for a manual peer Core is not connected to, built from the
  // dashboard's record of it: where it is, what it last called itself.
  const offlinePeer = (r) => ({
    addr: r.address, group: "manual", type: "manual", offline: true, offline_ms: r.offlineSinceMs,
    network: /\.onion/.test(r.address) ? "onion" : /\.i2p/.test(r.address) ? "i2p" : r.address.startsWith("[") ? "ipv6" : "ipv4",
    cc: (r.where && r.where.country) || "", region: "", operator: (r.where && r.where.operator) || "",
    kind: "Offline", subver: r.client || "", services: [], bytes_sent: 0, bytes_recv: 0, min_ping_ms: null, conntime: 0,
    about: "Not connected right now. It still holds its manual slot" + (r.kept ? ", and it is locked." : "."),
  });
  const rankOf = (p) => dashboard().peer(p.addr);

  function deliveredSet() {
    const b = liveBlock();
    return new Set(b && b.first_peers ? b.first_peers : []);
  }

  // The card under the filters: one block, and the three roles it has here.
  // Mined by (from the server's coinbase reading), delivered by (the peers
  // Core credited), raced by (the pools that turned it into work). Each of the
  // three can be missing, and then it says so rather than leaving a gap.
  // Who brought the block and how the own pool did, in two lines (12.11.2026,
  // "I was 2 ms behind him and cannot see it anywhere"). The route, the
  // compact block and every pool are under "Details".
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  function renderVerdict(box, b) {
    box.textContent = "";
    const row = (label, ...value) => {
      const r = document.createElement("div");
      r.className = "b-row";
      const l = document.createElement("span");
      l.className = "b-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "b-value";
      v.append(...value);
      r.append(l, v);
      box.appendChild(r);
      return v;
    };
    const span = (cls, text, title) => { const e = document.createElement("span"); if (cls) e.className = cls; e.textContent = text; if (title) e.title = title; return e; };

    const firsts = b.first_peers || [];
    const known = new Map(((state.data && state.data.peers) || []).map((p) => [p.addr, p]));
    const lead = firsts.map((a) => known.get(a)).find(Boolean);
    const more = firsts.length > 1 ? ` +${firsts.length - 1}` : "";
    if (!firsts.length) row("Brought by", span("miss", "nobody credited"));
    else {
      const where = lead ? (HIDDEN_FLAG[lead.network] ? HIDDEN_FLAG[lead.network] + " " + netLabel(lead.network)
        : lead.cc ? flagOf(lead.cc) + " " + regionName(lead.cc) : netLabel(lead.network)) : "a peer no longer connected";
      const v = row("Brought by", span("", where + more, firsts.join("\n")));
      if (b.first_hb === 1) v.append(" ", span("hb", "\u26a1", HB_TITLE));
    }

    const entries = ((b.stratum && b.stratum.entries) || []).filter((e) => !e.miss && e.latency_ms != null)
      .sort((x, y) => x.latency_ms - y.latency_ms);
    const own = ((b.stratum && b.stratum.entries) || []).find((e) => e.own);
    if (own) {
      const v = row("Your pool", span("b-own", own.label), " ");
      if (own.miss || own.latency_ms == null) v.append(span("miss", "no job for this block"));
      else {
        const place = entries.indexOf(entries.find((e) => e === own)) + 1;
        const best = entries[0], next = entries.find((e) => e !== own);
        const ms = (x) => Math.max(0, Math.round(x)) + "\u00a0ms";
        v.append(span("b-place", ordinal(place)),
          place === 1
            ? (next ? ` \u00b7 ${ms(next.latency_ms - own.latency_ms)} ahead of ${next.label.replace(/ /g, "\u00a0")}` : "")
            : ` \u00b7 ${ms(own.latency_ms - best.latency_ms)} behind ${best.label.replace(/ /g, "\u00a0")}`);
      }
    } else if (entries.length) {
      row("First job", span("", entries[0].label));
    }
  }

  function renderBlockCard() {
    const card = $("blockCard");
    if (!card) return;
    const b = state.data && state.data.last_block;
    card.hidden = !b;
    if (!b) return;
    const more = $("blockMore");
    // The route and the compact block line belong to the details.
    for (const id of ["blockRoute", "blockRecon"]) if ($(id).parentElement !== more) more.insertBefore($(id), $("blockBody"));
    $("blockSummary").hidden = false;
    fillSummary($("blockSummary"), b);
    let verdict = $("blockVerdict");
    if (!verdict) { verdict = document.createElement("div"); verdict.id = "blockVerdict"; verdict.className = "b-verdict"; $("blockSummary").after(verdict); }
    renderVerdict(verdict, b);
    more.classList.add("minor");
    $("blockMoreLabel").textContent = "Details";
    const own = routeStops(b), typical = medianStops(b);
    const view = state.routeView === "median" && typical ? "median" : "block";
    const stops = own || typical ? (view === "median" ? typical : own || typical) : null;
    $("blockRoute").hidden = !stops;
    if (stops) {
      // The route without the winning pool: only your own path, to scale on a wide screen and down a line on a phone, the
      // same stretches and times on both.
      renderRoute($("blockRoute"), b, stops.filter((s) => s.kind !== "win"),
        { view: stops === typical ? "median" : "block", canSwitch: Boolean(own && typical) });
    }
    // Who brought it is in the head; the details need not list it again.
    renderBlockBody(b);
    renderRecon($("blockRecon"), b, own && typical ? view : null);
  }

  // How Core put the block together from its compact form (BIP152), as
  // The server read it from getpeerinfo: from the mempool alone, or after
  // asking a peer for the transactions it did not have - a full round trip -
  // or downloaded in full. This block, or the share over the last hundred
  // blocks - the same "typical" as the route's, and the same switch.
  const RECON_WHY = "A new block arrives as a compact block: short ids for its transactions, " +
    "which your node fills in from its mempool and from transactions it recently turned down. " +
    "Whatever it does not have, it asks the peer for - one more round trip before the block is complete.";
  // No-break spaces keep a number and its unit on one line on a phone.
  const kB = (bytes) => (bytes < 1000 ? "under 1\u00a0kB" : Math.round(bytes / 1000).toLocaleString("en-US") + "\u00a0kB");

  // What was missing as a share of the whole block, once its size is known.
  function shareOfBlock(b) {
    if (!b.block_size || b.recon_missing_bytes == null) return "";
    const p = (100 * b.recon_missing_bytes) / b.block_size;
    return ", " + (p < 1 ? "under 1\u00a0%" : Math.round(p) + "\u00a0%") + " of the block";
  }

  function renderRecon(box, b, routeView) {
    const last = b.recon_last100;
    const has = b.recon || last;
    box.hidden = !has;
    box.textContent = "";
    if (!has) return;
    // The route's switch decides where there is one; otherwise the same
    // choice, remembered the same way, on a switch of the line's own.
    const view = (routeView || state.routeView) === "median" && last ? "median" : "block";

    const head = document.createElement("span");
    head.className = "recon-head";
    head.textContent = "Compact block";
    head.title = RECON_WHY;
    box.appendChild(head);
    if (!routeView && last) {
      const sw = document.createElement("div");
      sw.className = "rt-switch";
      for (const [v, label] of [["block", "This block"], ["median", "Last 100 blocks"]]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.className = v === view ? "on" : "";
        btn.addEventListener("click", () => setRouteView(v));
        sw.appendChild(btn);
      }
      box.appendChild(sw);
    }
    const line = document.createElement("p");
    line.className = "recon-line";
    line.title = RECON_WHY;
    if (view === "block") {
      line.textContent = {
        mempool: "Rebuilt from what your node already had, nothing was missing",
        asked: `Your node had to ask for missing transactions: ${kB(b.recon_missing_bytes || 0)}` + shareOfBlock(b),
        full: "Downloaded in full, not rebuilt",
        unclear: "Not clear for this block",
      }[b.recon] || "Not measured for this block";
    } else {
      const w = last;
      const pct = (n) => Math.round((100 * n) / w.blocks) + "\u00a0%";
      const parts = [`${pct(w.mempool)} rebuilt from what your node had`];
      if (w.asked) parts.push(`${pct(w.asked)} needed missing transactions` + (w.asked_avg_bytes != null ? `, ${kB(w.asked_avg_bytes)} on average` : ""));
      if (w.full) parts.push(`${pct(w.full)} downloaded in full`);
      line.textContent = parts.join(" \u00b7 ") + " ";
      const n = document.createElement("small");
      n.textContent = `\u00b7 ${w.blocks.toLocaleString("en-US")} of the last 100 blocks measured`;
      if (w.blocks < 100) line.appendChild(n);
    }
    box.appendChild(line);
  }

  // The line is parts, not words: "mined by Foundry USA" moves to the next
  // line as one, and the dot in front of a part that starts a line is clipped
  // (see .b-parts), so no line begins with a stray "·" on a phone.
  function fillSummary(sum, b) {
    sum.textContent = "";
    const line = document.createElement("span");
    line.className = "b-line";
    const parts = document.createElement("span");
    parts.className = "b-parts";
    line.appendChild(parts);
    sum.appendChild(line);
    const part = () => {
      const el = document.createElement("span");
      el.className = "b-part";
      parts.appendChild(el);
      return el;
    };
    const add = (into, cls, text, title) => {
      const el = document.createElement("span");
      if (cls) el.className = cls;
      el.textContent = text;
      if (title) el.title = title;
      into.appendChild(el);
      return el;
    };

    add(part(), "b-height", b.height ? "Block " + b.height.toLocaleString("en-US") : "Last block", b.hash || "");
    // Who mined it, without "mined by": the orange name says it, and on a
    // phone the words were what pushed the line to wrap.
    if (b.pool || b.pool_tag) {
      const mined = part();
      // A miner's own text stays on one line and ends in … when it is too long.
      if (!b.pool) mined.classList.add("b-cut");
      // The full name, as on mempool.space: "Foundry USA", not "Foundry".
      const name = b.pool_name || b.pool;
      add(mined, "b-pool" + (name ? "" : " raw"), name || `"${b.pool_tag}"`,
        name ? `Mined by ${name}` : `Mined by a pool we do not know - this is the text in its coinbase: "${b.pool_tag}"`);
    } else if (b.pool_source === "none") {
      // Only once the server has read the coinbase and found nothing: before
      // that, or when it could not read it, nothing was checked yet.
      add(part(), "b-unknown", "Unknown", "Mined by a pool we do not know: neither the payout address nor the coinbase text matched");
    }
    add(part(), "miss", ago(blockAgeMs(b) / 1000) + " ago", "How long ago your node saw this block");
  }

  const blockAgeMs = (b) => b.age_ms + Math.max(0, Date.now() - state.receivedAt);

  // ---------- the route of one block ----------
  //
  // Where the time between "this block exists" and "your pool has a job for
  // it" goes, drawn to scale. The zero is the first new job any pool sent
  // here: when the block was found cannot be known - the header's time is the
  // miner's own, in whole seconds - and the first job is the earliest moment
  // it is visible from this node. After that everything is measured by one
  // clock on one machine, except the last hop into Core, which is estimated
  // as the delivering peer's ping.
  //
  // How many pings, as BIP152 counts them (hopPings): a high-bandwidth peer
  // sends the block unasked, half a ping; any other announces it and is
  // asked, a ping and a half; asking for missing transactions adds one.
  // The server says which kind of peer it was just before the block. It
  // only moves the peer's dot - Core and the pools stand where they were
  // measured.
  const ROUTE_STUB = 140;  // the miner's dashed lead-in, not to scale
  // Not known whether the peer was high-bandwidth (older blocks): one ping,
  // the middle. The typical route counts the same way.
  const hopPings = (hb, recon) => (hb === 1 ? 0.5 : hb === 0 ? 1.5 : 1) + (recon === "asked" ? 1 : 0);
  const HOP_WHY = "Estimated from the peer's ping, as BIP152 counts it: a high-bandwidth peer sends a new block " +
    "without being asked, half a ping; any other announces it first, a ping and a half. Asking for missing " +
    "transactions adds a ping. These are minimums - more missing data or a slow line take longer, and a peer " +
    "still busy with the block - checking it, sending it to others - answers only after that. Measured elsewhere (0xB10C, 2024), asking " +
    "added about 115 ms in the median. Your node's own check of the block is not in it: Core reports a block " +
    "only once it has checked it, so that time is counted in the stretch before, to your peer.";
  // Text cut off with an ellipsis is readable on hover - and only then, a
  // tooltip that repeats what is on screen says nothing. Whether it is cut
  // depends on the screen, so it is decided when the pointer gets there.
  // `tip` is what the element says on hover anyway, cut or not.
  function fit(e, full, tip) {
    e.classList.add("fit");
    e.dataset.full = full;
    if (tip) e.dataset.tip = tip;
    return e;
  }
  document.addEventListener("mouseover", (ev) => {
    const e = ev.target.closest && ev.target.closest(".fit");
    if (!e) return;
    const cut = e.scrollWidth > e.clientWidth;
    const link = e.querySelector("a[data-tip]");
    const lines = [cut ? e.dataset.full : "", e.dataset.tip || ""];
    if (link) link.title = [...lines, link.dataset.tip].filter(Boolean).join("\n");
    // No title at all rather than an empty one: an empty title hides the
    // cell's own (the Tor exit explanation on the operator).
    else if (lines.some(Boolean)) e.title = lines.filter(Boolean).join("\n");
    else e.removeAttribute("title");
  });

  const ROUTE_GAP = 150;   // the closest two stops may sit, so labels never touch

  const hostOf = (a) => (a.startsWith("[") ? a.slice(1, a.indexOf("]")) : a.replace(/:\d+$/, ""));
  // A stop says no time counted from the first job: with the owner's own
  // pool first, every stop before it read "−206 ms" (04.11.2026). The line
  // between two stops says how long that stretch took; the first job is no
  // station, so it says where it stands against your node instead.
  const firstJobWords = (win, stops) => {
    const core = stops.find((st) => st.kind === "core");
    const d = core ? Math.round(core.t - win.t) : 0;
    return d === 0 ? "same moment as your node" : Math.abs(d) + " ms " + (d > 0 ? "before" : "after") + " your node";
  };

  // Which route the card shows: this block, or the typical one. Remembered
  // per browser, because somebody tuning a setup wants the median every time.
  const ROUTE_VIEW_KEY = "peerlab.routeView";
  state.routeView = (() => { try { return localStorage.getItem(ROUTE_VIEW_KEY) || "block"; } catch { return "block"; } })();
  function setRouteView(v) {
    state.routeView = v;
    try { localStorage.setItem(ROUTE_VIEW_KEY, v); } catch { /* private window: fine */ }
    renderBlockCard();
  }

  function routeStops(b) {
    const s = b.stratum;
    if (!s || s.core_ms == null || !(s.entries || []).length) return null;
    const winner = s.entries.find((e) => e.rank === 1 && e.latency_ms != null);
    if (!winner) return null;
    const own = s.entries.find((e) => e.own && e.latency_ms != null) || null;

    const stops = [];
    // The winner is the zero. When it is the owner's own pool the two are one
    // stop, and it is drawn as his.
    if (own !== winner) stops.push({ kind: "win", t: 0, name: winner.label, sub: "first job" });

    const known = new Map(((state.data && state.data.peers) || []).map((p) => [p.addr, p]));
    const credited = (b.first_peers || []).map((addr) => ({ addr, peer: known.get(addr) }));
    // The ping taken from the snapshot that credited the peer is
    // the right one - it is from the moment the block arrived. Only a block
    // from before the server stored it falls back to what Core says now.
    const pingOf = (c) => (c.peer ? (c.peer.min_ping_ms != null ? c.peer.min_ping_ms : c.peer.ping_ms) : null);
    const lead = credited.filter((c) => pingOf(c) != null).sort((x, y) => pingOf(x) - pingOf(y))[0]
      || (credited.length && b.first_ping_ms != null ? credited[0] : null);
    const ping = b.first_ping_ms != null ? b.first_ping_ms : (lead ? pingOf(lead) : null);
    if (lead && ping != null) {
      const p = lead.peer;
      const where = p ? p.region || (p.cc ? regionName(p.cc) : "") : "";
      const more = credited.length > 1 ? ` +${credited.length - 1}` : "";
      stops.push({
        kind: "peer", group: p ? p.group : "", t: s.core_ms - ping * hopPings(b.first_hb, b.recon),
        pings: hopPings(b.first_hb, b.recon), asked: b.recon === "asked", hb: b.first_hb,
        name: hostOf(lead.addr) + more,
        sub: p ? [where, p.operator, p.tor_exit ? "Tor exit" : ""].filter(Boolean) : ["no longer connected"],
        title: credited.map((c) => c.addr).join("\n"),
      });
    }
    stops.push({
      kind: "core", t: s.core_ms, name: "Core",
      // Credited, but with no ping to place it by: named rather than drawn.
      sub: [!(lead && ping != null) && credited.length ? "via " + hostOf(credited[0].addr) : "your node"],
    });
    if (b.template_ms != null) {
      stops.push({ kind: "tpl", t: s.core_ms + b.template_ms, name: "Template", sub: ["ready in Core"], tx: b.template_tx });
    }
    if (own) stops.push({ kind: "own", t: own.latency_ms, name: own.label, sub: ["your job"] });
    for (const st of stops) if (typeof st.sub === "string") st.sub = [st.sub];
    return byTime(stops);
  }

  // Core's template time is kept in whole milliseconds, the pool's job to the
  // fraction, and with small templates the job is ready the same moment:
  // rounding alone can put the job before the template it was built from.
  // It cannot be, so the template waits for it, and the job stretch - the
  // one that says how many transactions the template carried - stays.
  function byTime(stops) {
    const tpl = stops.find((s) => s.kind === "tpl");
    const own = stops.find((s) => s.kind === "own");
    if (tpl && own && own.t < tpl.t) tpl.t = own.t;
    return stops.sort((x, y) => x.t - y.t);
  }

  // The typical block: every stop at its median over the last hundred, each
  // counted from its own first job. Stops are medians of their own, so they
  // are not one real block - they are where each stop usually is, which is
  // the thing that moves when something is changed.
  function medianStops(b) {
    const m = b.route_median;
    if (!m || !m.core) return null;
    const n = (st) => `median of ${st.n} ${st.n === 1 ? "block" : "blocks"}`;
    const stops = [{ kind: "win", t: 0, name: "First pool", sub: ["first job"] }];
    if (m.peer) stops.push({ kind: "peer", t: m.peer.ms, name: "Your peer", sub: ["has the block"], title: n(m.peer), plain: true });
    stops.push({ kind: "core", t: m.core.ms, name: "Core", sub: ["your node"], title: n(m.core) });
    if (m.template) stops.push({ kind: "tpl", t: m.template.ms, name: "Template", sub: ["ready in Core"], title: n(m.template), tx: m.tx && m.tx.ms });
    if (m.own) stops.push({ kind: "own", t: m.own.ms, name: m.own_label || "Your pool", sub: ["your job"], title: n(m.own) });
    return byTime(stops);
  }

  // To scale, but never so close that two labels touch: a stop that would
  // sit nearer than ROUTE_GAP to the one before is pushed along, and the
  // whole row pulled back in from the right. Too narrow for that at all - a
  // phone - and it is a list instead, which says the same thing.
  function placeStops(stops, left, right, need) {
    const gap = (i) => (need && need[i]) || ROUTE_GAP;
    const t0 = stops[0].t, span = Math.max(1, stops[stops.length - 1].t - t0);
    const x = stops.map((s) => left + ((s.t - t0) / span) * (right - left));
    for (let i = 1; i < x.length; i++) x[i] = Math.max(x[i], x[i - 1] + gap(i));
    x[x.length - 1] = Math.min(x[x.length - 1], right);
    for (let i = x.length - 2; i >= 0; i--) x[i] = Math.min(x[i], x[i + 1] - gap(i + 1));
    return x;
  }
  // How far apart two stops must be for the stretch label between them.
  let measureCtx = null;
  function segNeeds(box, stops) {
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = "12px " + getComputedStyle(box).fontFamily;
    const need = stops.map(() => ROUTE_GAP);
    const journey = stops.filter((st) => st.kind !== "win");
    const win = stops.find((st) => st.kind === "win");
    const pairs = [];
    if (win && journey.length && win.t <= journey[0].t) pairs.push([win, journey[0]]);
    for (let i = 1; i < journey.length; i++) pairs.push([journey[i - 1], journey[i]]);
    for (const [a, z] of pairs) {
      const w = measureCtx.measureText(segLabel(a, z)[0]).width + 24;
      const ia = stops.indexOf(a), iz = stops.indexOf(z);
      for (let k = ia + 1; k <= iz; k++) need[k] = Math.max(need[k], w / (iz - ia));
    }
    return need;
  }

  // One stretch, the same words on every width: what happens on it, how
  // long it took, and the longer why for the tooltip. The hop into Core says
  // why it is that long - sent unasked (⚡) or announced first, and whether
  // Core had to ask for missing transactions; "at least" then, because the
  // round trip is only the floor.
  function stretch(a, z) {
    const ms = Math.round(z.t - a.t).toLocaleString("en-US") + "\u00a0ms";
    if (a.kind === "peer" && z.kind === "core") {
      const kind = a.hb === 1 ? "⚡" : a.hb === 0 ? "announced" : "";
      const what = kind && a.asked ? kind + " + asked" : kind || (a.asked ? "asked" : "ping");
      return [what, (a.asked ? "at least\u00a0" : "~") + ms, HOP_WHY];
    }
    if (a.kind === "win" && z.kind === "peer") return ["reaches your peer", ms, ""];
    if (a.kind === "core" && z.kind === "tpl") return ["template", ms, "Core builds a new block template (getblocktemplate)"];
    if (a.kind === "tpl" && z.kind === "own") {
      // The template's size is most of the reason this stretch varies: the
      // pool handles every transaction in it before it can send the job.
      const tx = a.tx != null ? " · " + Math.round(a.tx).toLocaleString("en-US") + " tx" : "";
      return ["job" + tx, ms, "Your pool notices the block and turns the template into a job" +
        (tx ? " - the more transactions the template carries, the longer that takes" : "")];
    }
    // No template timing for this block: the two are one stretch.
    if (a.kind === "core" && z.kind === "own") {
      return ["template + job", ms, "Core builds a new block template (getblocktemplate), your pool notices the block and turns it into a job"];
    }
    return ["", ms, ""];
  }
  // The wide route's label: first what, then how long - as on a phone.
  function segLabel(a, z) {
    const [what, time, why] = stretch(a, z);
    return [what ? what + " · " + time : time, why];
  }




  function renderRoute(box, b, stops, { view, canSwitch }) {
    box.textContent = "";
    const median = view === "median";
    const n = (b.route_median && b.route_median.blocks) || 0;
    if (canSwitch) routeSwitch(box, view, n);
    const miner = median ? "Miner" : b.pool || (b.pool_tag ? `"${b.pool_tag}"` : "unknown miner");
    const W = box.clientWidth - 12;
    // The last label is centred on its dot like the others, so the dot keeps
    // room for half of it - at the edge it looked squeezed.
    const left = ROUTE_STUB, right = W - 60;

    const need = segNeeds(box, stops);
    if (need.slice(1).reduce((x, y) => x + y, 0) > right - left) routeDown(box, stops, miner, median);
    else routeAcross(box, stops, miner, placeStops(stops, left, right, need));
  }

  // The switch between this block's route and the typical one.
  function routeSwitch(box, view, n) {
    const sw = document.createElement("div");
    sw.className = "rt-switch";
    for (const [v, label] of [["block", "This block"], ["median", `Typical \u00b7 last ${n}`]]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.className = v === view ? "on" : "";
      btn.addEventListener("click", () => setRouteView(v));
      sw.appendChild(btn);
    }
    box.appendChild(sw);
  }

  // Narrow: the same stops down a line. Between two stops, what that
  // stretch is and - on the right, flush - how long it took. One rule
  // for every stretch: from the stop above, so never negative. The hop
  // into Core says in short how the compact block went; the compact
  // block line under the route says it in full, as on a wide screen.
  function routeDown(box, stops, miner, median) {
    const ol = document.createElement("ol");
    ol.className = "rt-v";
    const li = (cls, parts, title) => {
      const e = document.createElement("li");
      e.className = cls;
      for (const [text, c] of parts) {
        const s = document.createElement(c === "name" ? "b" : "span");
        s.textContent = text;
        if (c && c !== "name") s.className = c;
        e.appendChild(s);
      }
      if (title) e.title = title;
      ol.appendChild(e);
    };
    li("stop pool", [[miner, "name"], ["mined it"]]);
    // The first job is the zero, not a station (as on the wide route):
    // when it falls inside the hop into Core - a far peer, a long hop -
    // it stands up here with how far before your node it was, and the
    // hop stays whole underneath.
    const win = stops.find((st) => st.kind === "win");
    // As on the wide route: the first job against the first station after
    // it, the peer or - with no peer to place - Core (review 11.11.2026).
    const firstStation = stops.find((st) => st.kind !== "win");
    const line = win && firstStation && win.t > firstStation.t ? stops.filter((st) => st !== win) : stops;
    if (line !== stops) {
      li("gap lead", []);
      li("stop win", [[win.name, "name"], ["first job"]]);
      li("gap lead", [[firstJobWords(win, stops)]]);
    } else li("gap lead", []);
    line.forEach((s, i) => {
      if (i > 0) {
        const prev = line[i - 1];
        // The first job's stretch to the peer says only its time here:
        // the first job's own line says what it is.
        const [what, time, why] = prev.kind === "win" ? ["", ...stretch(prev, s).slice(1)] : stretch(prev, s);
        li("gap", [[what || " "], [time, "t"]], why);
      }
      // Where the peer is stands on the card's first line; here only
      // which one, so every stop fits one line.
      const peer = s.kind === "peer" && !median;
      li("stop " + s.kind + (s.group ? " " + s.group : ""),
        [[peer ? "Your peer" : s.name, "name"], peer ? [s.name, "addr"] : [s.sub.join(" · ")]], s.title);
    });
    box.appendChild(ol);
    // "at least" in words; where it would squeeze its stretch's text past
    // two lines, the sign - a bare number would read as the estimate.
    for (const t of ol.querySelectorAll(".gap .t")) {
      if (!t.textContent.startsWith("at least")) continue;
      const what = t.previousElementSibling;
      const cs = getComputedStyle(what);
      const lh = parseFloat(cs.lineHeight) || 1.3 * parseFloat(cs.fontSize);
      if (what.getBoundingClientRect().height > 2.5 * lh) {
        t.textContent = t.textContent.replace("at least\u00a0", "≥");
      }
    }
  }

  // Wide: the stops along one line, at the places xs (placeStops).
  function routeAcross(box, stops, miner, xs) {
    const rt = document.createElement("div");
    rt.className = "rt";
    box.appendChild(rt);
    const el = (cls, x, html) => {
      const e = document.createElement("div");
      e.className = cls;
      if (x != null) e.style.left = x + "px"; // CSSOM, which the CSP allows
      if (html) e.append(...html);
      rt.appendChild(e);
      return e;
    };
    const txt = (tag, text, cls) => {
      const e = document.createElement(tag);
      e.textContent = text;
      if (cls) e.className = cls;
      return e;
    };

    const stub = el("rt-stub", 6);
    stub.style.width = (xs[0] - 6) + "px";
    const track = el("rt-track", xs[0]);
    track.style.width = (xs[xs.length - 1] - xs[0]) + "px";
    el("rt-dot pool", 6);
    // A raw coinbase text can be long; it stops short of the first stop's
    // label instead of running underneath it.
    const minerLab = el("rt-lab pool first", 0, [fit(txt("b", miner), miner), txt("small", "mined it")]);
    minerLab.style.maxWidth = (xs[0] - 50) + "px";

    stops.forEach((s, i) => {
      el("rt-dot " + s.kind + (s.group ? " " + s.group : ""), xs[i]);
      const name = fit(txt("b", s.name), s.name, s.title);
      const lab = el("rt-lab " + s.kind + (s.plain ? " plain" : ""), xs[i],
        [name, ...s.sub.map((line) => txt("small", line)), ...(s.kind === "win" ? [txt("small", firstJobWords(s, stops))] : [])]);
      if (s.title) lab.title = s.title;
    });

    // Stretches run between the stations the block actually passes -
    // peer, Core, template, your pool. The first job is the zero the times
    // are counted from, not a station: when the peer had the block before
    // any pool sent a job, the zero falls inside the ping, and splitting the
    // ping there would only produce two pieces nobody can read. So the zero
    // keeps its dot and its label below, and the stretch above it stays
    // whole. Only when the zero comes before the peer is there a stretch
    // from it to the peer.
    const at = (st) => xs[stops.indexOf(st)];
    const seg = (a, z) => {
      const [label, why] = segLabel(a, z);
      const e = el("rt-seg", (at(a) + at(z)) / 2, [txt("span", label)]);
      if (why) e.title = why;
    };
    const journey = stops.filter((st) => st.kind !== "win");
    const win = stops.find((st) => st.kind === "win");
    if (win && journey.length && win.t <= journey[0].t) seg(win, journey[0]);
    for (let i = 1; i < journey.length; i++) seg(journey[i - 1], journey[i]);
  }

  function renderBlockBody(b) {
    const body = $("blockBody");
    body.textContent = "";

    // --- who turned it into work ---------------------------------------
    // The list folds (12.11.2026): with every public pool in it
    // it is long. Open by default up to four pools, folded above that, and
    // kept as the reader set it while the page refreshes.
    const n = ((b.stratum && b.stratum.entries) || []).length;
    const race = document.createElement("details");
    const h2 = document.createElement("summary");
    race.className = "pool-fold";
    h2.textContent = `Pools \u00b7 relative to the fastest${n ? " \u00b7 " + n : ""}`;
    race.open = state.poolsOpen != null ? state.poolsOpen : n <= 4;
    race.addEventListener("toggle", () => { state.poolsOpen = race.open; });
    race.appendChild(h2);
    if (!b.stratum || !(b.stratum.entries || []).length) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "No race recorded for this block.";
      race.appendChild(p);
    } else {
      const t = document.createElement("table");
      for (const e of b.stratum.entries) {
        const tr = document.createElement("tr");
        const rank = document.createElement("td");
        rank.className = "num miss";
        rank.textContent = e.rank ? e.rank + "." : "\u2013";
        const label = document.createElement("td");
        label.textContent = e.label;
        if (e.own) {
          label.className = "own";
          label.title = "Your own pool";
        }
        const delta = document.createElement("td");
        delta.className = "num" + (e.miss ? " miss" : "");
        delta.textContent = e.miss
          ? "no job"
          : e.latency_ms === 0 ? "first" : "+" + Math.round(e.latency_ms) + " ms";
        tr.append(rank, label, delta);
        t.appendChild(tr);
      }
      race.appendChild(t);
    }
    body.appendChild(race);
  }

  // Every <details> folds in place: its summary stays, its text rolls out
  // below and back up.
  document.addEventListener("click", (ev) => {
    const summary = ev.target.closest && ev.target.closest("details > summary");
    // The panels under the peer list fold by the other script: two handlers
    // on one fold opened it and shut it again (12.11.2026).
    if (!summary || summary.closest(".panel") || ev.target.closest("a, button, input")) return;
    ev.preventDefault();
    const box = summary.parentElement;
    foldInPlace({ anchor: summary, box, open: !box.open, set: (open) => { box.open = open; } });
  });

  // The block card opens its details, and folds them shut again, with a tap
  // anywhere on it, like every other card - not only on "Details": on a
  // phone that has scrolled away by the time the reader is done, and it
  // comes back into view.
  {
    const card = $("blockCard"), box = $("blockMore");
    card.addEventListener("click", (ev) => {
      if (!card.contains(ev.target) || ev.target.closest("summary, a, button, input, select, textarea, label")) return;
      if (String(window.getSelection()).length > 0) return;
      const summary = box.querySelector(":scope > summary");
      if (!box.open) {
        foldInPlace({ anchor: summary, box, open: true, set: (open) => { box.open = open; } });
        return;
      }
      // Its title on screen: it rolls up into it, in place. Scrolled away:
      // shut at once, and the title comes back to the top of the screen.
      if (summary.getBoundingClientRect().top >= 0) {
        foldInPlace({ anchor: summary, box, open: false, set: (open) => { box.open = open; } });
        return;
      }
      box.open = false;
      const top = card.getBoundingClientRect().top;
      if (top < 0) window.scrollBy(0, top - 8);
    });
  }

