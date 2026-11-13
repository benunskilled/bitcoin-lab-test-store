  // What is known of a peer, in full: the sentences behind the words in its
  // row, what it announced, the connection, the traffic and where it sits.
  // Opens under the row on a tap or a click (a phone has no hover), and stays
  // open across a refresh.
  const andList = (xs) => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  const NO_SERVICES_WHY = "This peer announced no services at all: it has nothing to offer other nodes";
  const NO_TX_WHY = "Wants no transactions from your node";
  const bytesText = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "\u00a0GB" : n >= 1e6 ? Math.round(n / 1e6) + "\u00a0MB" : n >= 1e3 ? Math.round(n / 1e3) + "\u00a0kB" : n + "\u00a0B";
  // The detail panel's parts: an element, a block with a heading, and one
  // line of the connection.
  const pdEl = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pdBlock = (panel, title) => {
    const b = pdEl("section", "pd-block");
    b.appendChild(pdEl("h4", "", title));
    panel.appendChild(b);
    return b;
  };
  // One line of the connection: name on the left, value on the right, in
  // the size of the traffic table under it. These were tiles in 17px, the
  // largest type in the panel, and at 960px too narrow for "Inbound".
  const pdFact = (label, value) => {
    const s = pdEl("div", "pd-fact");
    s.append(pdEl("span", "", label), pdEl("span", "", value));
    return s;
  };

  // A peer's open detail: what it is, its connection, what it announced, and
  // the buttons for it.
  function peerDetail(p) {
    const panel = pdEl("div", "pd");
    detailWhat(panel, p);
    detailConnection(panel, p);
    detailAnnounced(panel, p);
    // What can be done with this peer: the buttons come from the other
    // script, which also handles their clicks.
    const acts = dashboard().actionsHtml(p.addr);
    if (/<button/.test(acts)) {
      const row = pdEl("div", "pd-actions");
      row.innerHTML = acts;
      panel.appendChild(row);
    }
    return panel;
  }

  // What it is, and why each word in the row is there.
  function detailWhat(panel, p) {
    const what = pdBlock(panel, "What it is");
    // Under a kind filter the row shows only part of it; the panel has all of it.
    if (p.about) {
      for (const line of p.about.split("\n")) {
        const m = /^(Claims|Probably|Also):\s*(.*)$/.exec(line);
        const row = pdEl("p", "pd-about");
        if (m) {
          row.classList.add("tagged");
          // Further reasons stand under the first one, without a word of their own.
          row.append(pdEl("span", "pd-tag " + m[1].toLowerCase(), m[1] === "Also" ? "" : m[1]), pdEl("span", "", m[2]));
        }
        else row.textContent = line;
        what.appendChild(row);
      }
    }
    if (p.seen) what.appendChild(pdEl("p", "pd-about", "In this session: " + p.seen));
    if (p.pool_proof) what.appendChild(pdEl("p", "pd-about", p.pool_proof));
    const flags = [];
    // Each fact once: "never first" already says the peer offers no services or
    // is on a chain of its own, so those flags are folded into it, and "no tx"
    // stays out when the server says the line above already tells it.
    if (p.sync_mb) flags.push(["syncing", `Still syncing: it has taken ${mbText(p.sync_mb)} of blocks from this node`, "sync"]);
    if (p.fork) flags.push([p.fork, p.fork_why + (p.no_relay ? " - it can never deliver one of your blocks first." : "")]);
    else if (p.no_relay) flags.push(["never first", neverNote(p)]);
    if (p.no_services && !p.no_relay) flags.push(["no services", NO_SERVICES_WHY]);
    // A reason of its own (blocks-only connection, blocksonly=1) still stands.
    const plainNoTx = !p.no_tx_why || p.no_tx_why === NO_TX_WHY;
    if (p.no_tx_relay && !(p.no_tx_said && plainNoTx)) flags.push(["no tx", p.no_tx_why || NO_TX_WHY]);
    if (p.chain_unknown && !p.sync_mb) flags.push(["no headers", NO_HEADERS_WHY]);
    if (isPruned(p)) flags.push(["pruned", PRUNED_WHY, "", true]);
    // The fee rate below which it wants no transactions announced. A peer that
    // takes none at all sends the highest there is: "no tx" says that already.
    if (p.min_fee != null && p.min_fee < 1000)
      flags.push([(p.min_fee < 10 ? p.min_fee.toFixed(1).replace(/\.0$/, "") : Math.round(p.min_fee)) + " sat/vB", "Min fee: cheaper transactions are not sent to it", "", true]);
    if (p.app) flags.push(["Umbrel app", p.app, "", true]);
    for (const [word, why, cls] of flags) {
      const row = pdEl("p", "pd-flag-row");
      row.append(pdEl("span", "pd-flag" + (cls ? " " + cls : ""), word), " " + why);
      what.appendChild(row);
    }
    // Pruned, the fee filter and the Umbrel app only add context; they do not
    // take the honest line away.
    const onlyContext = !what.querySelector(".pd-about") && flags.every((f) => f[3]);
    if (!what.querySelector("p") || onlyContext) {
      if (p.kind.startsWith("Node")) {
        // A node with nothing to explain: say what is good about it, from what it did.
        // Not its services: they stand under Announced, and NETWORK_LIMITED in a
        // sentence read as pruned. Not "honest" either: nothing odd is all we know.
        const good = ["says what it is"];
        if (!p.no_tx_relay) good.push("relays transactions");
        if (!p.chain_unknown) good.push("shares its block headers");
        // Ten minutes is what the behaviour rules need before they speak: sooner, only "so far".
        const settled = p.conntime && Date.now() / 1000 - p.conntime >= 600;
        what.insertBefore(pdEl("p", "pd-about", (settled ? "Nothing odd: it " : "Nothing odd so far: it ") + andList(good) + "."), what.querySelector("p"));
      } else if (!what.querySelector("p")) {
        // Nothing to say about the others either: no block rather than a made-up one.
        what.remove();
        panel.classList.add("pd-two");
      }
    }
  }

  // The line: how it is connected, how fast, how long, how much each way.
  function detailConnection(panel, p) {
    const line = pdBlock(panel, "Connection");
    const facts = pdEl("div", "pd-facts");
    if (p.min_ping_ms != null) facts.appendChild(pdFact("Ping", fmtPing(p.min_ping_ms)));
    if (p.conntime) facts.appendChild(pdFact("Connected", ago(Date.now() / 1000 - p.conntime)));
    if (p.offline) facts.appendChild(pdFact("Offline", p.offline_ms ? "for " + ago(p.offline_ms / 1000) : "now"));
    const r = rankOf(p);
    if (r && r.eligible) {
      facts.appendChild(pdFact("First / blocks", r.first + " / " + r.eligible));
    }
    if (r && r.sessionsCount) facts.appendChild(pdFact("Sessions", String(r.sessionsCount)));
    facts.appendChild(pdFact("Link", [LABEL[p.group], typeLabel(p.type).toLowerCase() === p.group ? "" : typeLabel(p.type),
      netLabel(p.network), p.transport].filter(Boolean).join(" \u00b7 ")));

    line.appendChild(facts);
    if (p.tor_exit) {
      const tor = pdEl("p", "pd-flag-row");
      tor.append(pdEl("span", "pd-flag", "Tor exit"), " " + TOR_EXIT_TITLE.replace(/^Tor exit: /, "Reached through a Tor exit: "));
      line.appendChild(tor);
    }
    const total = Math.max(1, p.bytes_sent + p.bytes_recv);
    const traffic = pdEl("div", "pd-traffic");
    // Nothing flows to a peer that is not connected.
    if (p.offline) traffic.hidden = true;
    const bar = pdEl("div", "pd-bar");
    const sent = pdEl("span", "pd-sent"), got = pdEl("span", "pd-got");
    sent.style.flexGrow = String(Math.max(p.bytes_sent / total, 0.02));
    got.style.flexGrow = String(Math.max(p.bytes_recv / total, 0.02));
    bar.append(sent, got);
    traffic.append(pdEl("span", "pd-label", "Traffic"), bar,
      pdEl("span", "pd-small", `\u2191 ${bytesText(p.bytes_sent)} sent to it \u00b7 \u2193 ${bytesText(p.bytes_recv)} from it`));
    if (p.traffic_sent || p.traffic_recv) {
      traffic.append(trafficTypes(p), pdEl("span", "pd-small", "Bytes since this connection began."));
    }
    line.appendChild(traffic);
  }

  // What it announced and where it sits.
  function detailAnnounced(panel, p) {
    const who = pdBlock(panel, "Announced");
    who.appendChild(pdEl("p", "pd-ua", p.subver || "no name sent"));
    const svc = pdEl("div", "pd-svc");
    if (p.services && p.services.length) for (const s of p.services) svc.appendChild(pdEl("span", "pd-chip", s));
    else svc.appendChild(pdEl("span", "pd-chip none", p.no_services ? "no services" : "services unknown"));
    who.appendChild(svc);
    if (p.version) who.appendChild(pdEl("p", "pd-small", "Protocol " + p.version));
    const where = [p.region, p.cc].filter(Boolean).join(", ");
    if (where || p.operator) who.appendChild(pdEl("p", "pd-where", [where, p.operator ? p.operator + (p.asn ? " (AS" + p.asn + ")" : "") : ""].filter(Boolean).join(" \u00b7 ")));
  }

  // The traffic by message type, as a small table of four rows.
  function trafficTypes(p) {
    const breakdown = pdEl("div", "pd-traffic-types");
    breakdown.setAttribute("role", "table");
    breakdown.setAttribute("aria-label", "Traffic by message type, since connection began");
    const headers = pdEl("div", "pd-traffic-group");
    const header = pdEl("div", "pd-traffic-row");
    header.setAttribute("role", "row");
    for (const label of ["Type", "To peer ↑", "From peer ↓"]) {
      const th = pdEl("span", "pd-traffic-heading", label);
      th.setAttribute("role", "columnheader");
      header.appendChild(th);
    }
    headers.setAttribute("role", "rowgroup");
    headers.appendChild(header);
    breakdown.appendChild(headers);
    const body = pdEl("div", "pd-traffic-group");
    for (const [key, label] of [["transactions", "Transactions"], ["blocks", "Blocks / headers"], ["addresses", "Addresses"], ["other", "Other messages"]]) {
      const row = pdEl("div", "pd-traffic-row");
      row.setAttribute("role", "row");
      const name = pdEl("span", "", label);
      name.setAttribute("role", "rowheader");
      row.appendChild(name);
      for (const counters of [p.traffic_sent, p.traffic_recv]) {
        const value = pdEl("span", "", counters && counters[key] != null ? bytesText(counters[key]) : "–");
        value.setAttribute("role", "cell");
        row.appendChild(value);
      }
      body.appendChild(row);
    }
    body.setAttribute("role", "rowgroup");
    breakdown.appendChild(body);
    return breakdown;
  }

  // The detail is a row of its own under the peer, as wide as the table. It
  // adds no width to any column: its content is 0 wide and as wide as the cell.
  function detailRow(tr, p, key) {
    const row = document.createElement("tr");
    row.className = "detail-row";
    const td = document.createElement("td");
    td.colSpan = tr.cells.length;
    td.appendChild(peerDetail(p));
    row.appendChild(td);
    // A tap on the open panel closes it, so a phone need not go back up to
    // the row (04.11.2026). Links and buttons in it keep their own job. Its
    // row comes back into view if it had scrolled away above.
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("a, button, input, select, textarea")) return;
      if (String(window.getSelection()).length > 0) return;
      // Its row on screen: the panel rolls up into it, in place. Scrolled
      // away: shut at once, and the row comes back to the top of the screen.
      const top = tr.getBoundingClientRect().top;
      if (top >= 0) toggleDetail(tr, p, key);
      else {
        setDetail(tr, p, key, false);
        window.scrollBy(0, tr.getBoundingClientRect().top - 8);
      }
      if (backY !== null) backY = window.scrollY;  // and the way back keeps this place
    });
    return row;
  }
  // One at a time: opening a peer closes the one that was open, so the list does
  // not grow without end. The row stays where it was on the screen, its panel
  // rolls out below it (foldInPlace), although a panel above it has just gone.
  function setDetail(tr, p, key, open) {
    for (const row of document.querySelectorAll("#tables tr.detail-row")) row.remove();
    for (const row of document.querySelectorAll("#tables tr.open")) {
      row.classList.remove("open");
      row.querySelector(".chev")?.setAttribute("aria-expanded", "false");
    }
    state.openRows.clear();
    if (open) {
      tr.after(detailRow(tr, p, key));
      tr.classList.add("open");
      tr.querySelector(".chev")?.setAttribute("aria-expanded", "true");
      state.openRows.add(key);
    }
    layers();
  }
  function toggleDetail(tr, p, key) {
    const open = !tr.nextElementSibling?.classList.contains("detail-row");
    foldInPlace({ anchor: tr, box: tr.closest(".card") || tr.closest("table"), open, set: (o) => setDetail(tr, p, key, o) });
  }

