  // ---------- map ----------
  async function loadWorld() {
    const r = await fetch(BASE + "world.json");
    state.world = await r.json();
    $("map").setAttribute("viewBox", `0 0 ${state.world.w} ${state.world.h}`);
    const frag = document.createDocumentFragment();
    const addPath = (d, cc) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "land");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      if (cc) p.dataset.cc = cc;
      frag.appendChild(p);
    };
    for (const [cc, d] of Object.entries(state.world.paths)) addPath(d, cc);
    if (state.world.unnamed) addPath(state.world.unnamed, "");
    $("countries").appendChild(frag);
    buildDots();
    applyView();
  }

  // The world view is drawn as a grid of dots rather than filled countries:
  // calmer, and the markers stand out against it. The grid is worked out once,
  // in the browser, by painting every country into an offscreen canvas in its
  // own colour and reading back which country each grid point falls on - so a
  // country with peers can light up its own dots. Zoomed in, the dots fade out
  // and the country shapes fade in (see applyView): a dot grid has nothing to
  // say about regions.
  const DOT_STEP = 4.4;
  let dotsByCC = null;
  function buildDots() {
    const W = state.world.w, H = state.world.h, S = 2;
    const off = document.createElement("canvas");
    off.width = W * S; off.height = H * S;
    const c = off.getContext("2d", { willReadFrequently: true });
    if (!c || typeof Path2D !== "function") return;
    c.scale(S, S);
    const ccs = Object.keys(state.world.paths);
    ccs.forEach((cc, i) => {
      c.fillStyle = `rgb(${(i + 1) & 255},${(i + 1) >> 8},7)`;
      c.fill(new Path2D(state.world.paths[cc]));
    });
    if (state.world.unnamed) { c.fillStyle = "rgb(0,0,9)"; c.fill(new Path2D(state.world.unnamed)); }
    const img = c.getImageData(0, 0, off.width, off.height).data;
    dotsByCC = new Map();
    let all = "";
    for (let y = DOT_STEP / 2, row = 0; y < H; y += DOT_STEP, row++) {
      for (let x = (row % 2) * DOT_STEP / 2; x < W; x += DOT_STEP) {
        const o = (Math.round(y * S) * off.width + Math.round(x * S)) * 4;
        if (img[o + 3] < 200) continue;
        const seg = `M${x.toFixed(1)} ${y.toFixed(1)}h0`;
        all += seg;
        const i = img[o] + (img[o + 1] << 8) - 1;
        if (img[o + 2] === 7 && i >= 0 && ccs[i]) dotsByCC.set(ccs[i], (dotsByCC.get(ccs[i]) || "") + seg);
      }
    }
    const grid = document.createElementNS(NS, "g");
    grid.setAttribute("class", "dots");
    for (const [id, d] of [["dotsAll", all], ["dotsHot", ""]]) {
      const p = document.createElementNS(NS, "path");
      p.id = id;
      p.setAttribute("d", d);
      grid.appendChild(p);
    }
    $("countries").appendChild(grid);
    $("map").classList.add("dotted");
  }

  // A bucket is one marker: a country (world view) or a region (zoomed in).
  // Peers whose region is unknown stay on their country's point.
  function placeKey(p, byRegion) {
    return byRegion && p.rid ? "r" + p.rid : "c" + p.cc;
  }
  function peerMatchesPlace(p) {
    if (!state.place) return true;
    const k = state.place.key;
    return k[0] === "r" ? "r" + p.rid === k : p.cc === k.slice(1);
  }

  function buckets() {
    const byRegion = regionMode();
    const delivered = deliveredNow;
    const by = new Map();
    for (const p of visiblePeers()) {
      if (!p.cc) continue;
      const key = placeKey(p, byRegion);
      let b = by.get(key);
      if (!b) {
        let pt = state.world.points[p.cc];
        let title = regionName(p.cc), sub = "";
        if (key[0] === "r") {
          pt = project(p.lon, p.lat);
          title = p.region;
          sub = regionName(p.cc);
        } else if (byRegion) {
          sub = "region unknown";
        }
        if (!pt) continue;
        by.set(key, (b = { key, title, sub, pt, cc: p.cc, manual: 0, inbound: 0, outbound: 0, total: 0 }));
      }
      b[p.group]++;
      b.total++;
      if (delivered.has(p.addr)) b.delivered = true;
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  }

  const radius = (n) => Math.min(26, 5 + 3.2 * Math.sqrt(n));

  function arcStroke(r, a0, a1) {
    if (a1 <= a0) a1 = a0 + 0.01;
    const x0 = r * Math.sin(a0), y0 = -r * Math.cos(a0);
    const x1 = r * Math.sin(a1), y1 = -r * Math.cos(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  let renderedMode = null;
  function renderMarkers() {
    if (!state.world || !state.data) return;
    renderedMode = regionMode();
    $("mapLevel").textContent = renderedMode ? "Regions" : "Countries";
    $("mapLevelHint").hidden = renderedMode;
    const layer = $("markers");
    layer.textContent = "";
    const bs = buckets();
    const hot = new Set(bs.map((b) => b.cc));
    for (const el of $("countries").children) el.classList.toggle("hot", hot.has(el.dataset.cc));

    // Inbound-only places first, in the background, then outbound and
    // manual on top; within each, largest first, so small markers are drawn
    // on top and stay clickable. The one that delivered the block last of
    // all, so a star is never hidden under a neighbouring country.
    const order = (b) => (b.delivered ? 3 : RANK[leadGroup(b)]);
    for (const b of [...bs].sort((x, y) => order(x) - order(y))) {
      const r = radius(b.total);
      const g = document.createElementNS(NS, "g");
      const selected = state.place && state.place.key === b.key;
      g.setAttribute("class", "marker" + (selected ? " selected" : "") + (b.delivered ? " delivered" : "") +
        (leadGroup(b) === "inbound" ? " back" : ""));
      g.dataset.x = b.pt[0];
      g.dataset.y = b.pt[1];
      g.dataset.key = b.key;
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", `${b.title}${b.sub ? ", " + b.sub : ""}: ${GROUPS.map((k) => b[k] + " " + LABEL[k].toLowerCase()).join(", ")}`);

      // A light, not a pie: the colour is the place's leading group - manual
      // whenever it holds one of yours - and the split is in the tooltip.
      const lead = leadGroup(b);
      const glow = document.createElementNS(NS, "circle");
      glow.setAttribute("class", "glow");
      glow.setAttribute("r", r * 1.9);
      glow.setAttribute("fill", `url(#glow-${lead})`);
      g.appendChild(glow);
      const core = r * 0.38 + 1.4;
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("class", "ring");
      ring.setAttribute("r", core + 4.2);
      g.appendChild(ring);
      // Selection gets its own outline, so a selected place that also
      // delivered the block keeps its orange ring.
      const sel = document.createElementNS(NS, "circle");
      sel.setAttribute("class", "sel");
      sel.setAttribute("r", core + 6.6);
      g.appendChild(sel);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("class", "core c-" + lead);
      dot.setAttribute("r", core);
      g.appendChild(dot);
      // The split between the three groups, as the pie used to show it: a
      // thin ring around the light, one arc per group, a small gap between.
      // The gap never eats a small group: at most half its own arc.
      const minSpan = Math.min(...GROUPS.filter((k) => b[k]).map((k) => (b[k] / b.total) * Math.PI * 2));
      const rr = core + 1.8, gap = b.total > 1 ? Math.min(0.32, minSpan / 2) : 0;
      let a = 0;
      for (const k of GROUPS) {
        if (!b[k]) continue;
        const span = (b[k] / b.total) * Math.PI * 2;
        const s = document.createElementNS(NS, "path");
        s.setAttribute("class", "seg seg-" + k);
        s.setAttribute("d", span >= Math.PI * 2 - 1e-6
          ? `M${-rr} 0A${rr} ${rr} 0 1 1 ${rr} 0A${rr} ${rr} 0 1 1 ${-rr} 0`
          : arcStroke(rr, a + gap / 2, a + span - gap / 2));
        g.appendChild(s);
        a += span;
      }
      if (b.total > 1) {
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", core + 5);
        t.setAttribute("y", -core);
        t.textContent = b.total;
        g.appendChild(t);
      }
      if (b.delivered) {
        const star = document.createElementNS(NS, "text");
        star.setAttribute("class", "delivered-star");
        star.setAttribute("x", 0);
        star.setAttribute("y", -(core + 6));
        star.setAttribute("text-anchor", "middle");
        star.textContent = "\u2605";
        g.appendChild(star);
      }
      g.addEventListener("pointerenter", (e) => showTip(b, e));
      g.addEventListener("pointermove", (e) => moveTip(e));
      g.addEventListener("pointerleave", hideTip);
      g.addEventListener("focus", () => showTip(b, null, g));
      g.addEventListener("blur", hideTip);
      g.addEventListener("click", (e) => { e.stopPropagation(); togglePlace(b); });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePlace(b); }
      });
      layer.appendChild(g);
    }
    const hotDots = $("dotsHot");
    if (hotDots && dotsByCC) hotDots.setAttribute("d", [...hot].map((cc) => dotsByCC.get(cc) || "").join(""));
    renderLinks(bs);
    placeMarkers();
  }

  // Yours first, then the ones this node chose: a place with one outbound
  // peer among thirty inbound ones still shows as outbound. A node with an
  // open port has far more inbound peers, and by majority the map would be
  // all inbound.
  const leadGroup = (b) => (b.manual ? "manual" : b.outbound ? "outbound" : "inbound");
  const RANK = { inbound: 0, outbound: 1, manual: 2 };

  // This node itself, from the region its peers see it in (the server reads
  // getpeerinfo's addrlocal and sends only the region, never the address).
  function homePoint() {
    const h = state.data && state.data.home;
    return h ? project(h.lon, h.lat) : null;
  }

  // A thin arc from every place to this node. They make the map read as what
  // it is - your node's connections - and they are the track a new block
  // travels along (pulseBlock).
  let linkByKey = new Map();
  function arcPath(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const d = Math.hypot(dx, dy);
    const lift = Math.min(90, d * 0.28);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2 - lift;
    return `M${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  function renderLinks(bs) {
    const layer = $("links");
    layer.textContent = "";
    linkByKey = new Map();
    const home = homePoint();
    if (!home) return;
    for (const b of bs) {
      if (Math.hypot(b.pt[0] - home[0], b.pt[1] - home[1]) < 2) continue;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("class", "link l-" + leadGroup(b));
      p.setAttribute("d", arcPath(b.pt, home));
      p.setAttribute("vector-effect", "non-scaling-stroke");
      layer.appendChild(p);
      linkByKey.set(b.key, p);
    }
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "home-mark");
    g.dataset.x = home[0];
    g.dataset.y = home[1];
    const halo = document.createElementNS(NS, "circle");
    halo.setAttribute("r", 11);
    halo.setAttribute("fill", "url(#glow-home)");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", 3.2);
    dot.setAttribute("class", "home-dot");
    const t = document.createElementNS(NS, "title");
    t.textContent = "Your node";
    g.append(halo, dot, t);
    $("markers").appendChild(g);
  }

  // A new block: a light runs from the place that delivered it along its arc
  // to this node, rings spread where it lands, and the wave rolls across the
  // page. Only for a block that arrives while the page is open - not on the
  // first load - and not at all for someone who asked for less motion.
  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function pulseBlock() {
    if ((motionQuery && motionQuery.matches) || document.hidden || !state.world) return;
    const wave = $("blockWave");
    wave.classList.remove("run"); void wave.offsetWidth; wave.classList.add("run");
    const home = homePoint();
    const fx = $("fx");
    const svg = $("map");
    // Sizes in screen pixels: the fx layer is scaled with the map.
    const px = (n) => (n * state.world.w) / (svg.clientWidth || 1000) / state.view.k;
    const from = [...$("markers").querySelectorAll(".marker.delivered")].map((g) => linkByKey.get(g.dataset.key)).filter(Boolean);
    const land = () => {
      if (!home) return;
      for (let i = 0; i < 3; i++) ring(home, i * 220);
    };
    const ring = (pt, delay) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("class", "fx-ring");
      c.setAttribute("cx", pt[0]);
      c.setAttribute("cy", pt[1]);
      c.setAttribute("vector-effect", "non-scaling-stroke");
      fx.appendChild(c);
      const t0 = performance.now() + delay;
      const step = (now) => {
        const k = Math.max(0, (now - t0) / 1500);
        c.setAttribute("r", px(3 + 70 * (1 - Math.pow(1 - Math.min(1, k), 3))));
        c.style.opacity = String(Math.max(0, 1 - k));
        if (k < 1) requestAnimationFrame(step); else c.remove();
      };
      requestAnimationFrame(step);
    };
    if (!from.length) { land(); return; }
    let left = from.length;
    for (const path of from) {
      const len = path.getTotalLength();
      const head = document.createElementNS(NS, "circle");
      head.setAttribute("class", "fx-head");
      fx.appendChild(head);
      // Without non-scaling-stroke: the dash lengths must be in the same units
      // as getTotalLength(), so the width is scaled by hand instead.
      const trail = path.cloneNode();
      trail.removeAttribute("vector-effect");
      trail.setAttribute("class", "fx-trail");
      trail.style.strokeWidth = String(px(2.2));
      fx.appendChild(trail);
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 950), e = 1 - Math.pow(1 - k, 2.2), d = e * len;
        const pt = path.getPointAtLength(d);
        head.setAttribute("cx", pt.x); head.setAttribute("cy", pt.y); head.setAttribute("r", px(2.6));
        trail.setAttribute("stroke-dasharray", `${len * 0.22} ${len}`);
        trail.setAttribute("stroke-dashoffset", String(-(d - len * 0.22)));
        if (k < 1) { requestAnimationFrame(step); return; }
        head.remove(); trail.remove();
        if (--left === 0) land();
      };
      requestAnimationFrame(step);
    }
  }

  function placeMarkers() {
    const { k, x, y } = state.view;
    // Markers keep their on-screen size while the map zooms: they are
    // positioned in viewBox units but scaled by the inverse of the fit ratio.
    const svg = $("map");
    const fit = svg.clientWidth ? state.world.w / svg.clientWidth : 1;
    // On a phone the whole map is ~360px wide; full-size markers would bury Europe.
    const shrink = Math.min(1, Math.max(0.55, (svg.clientWidth || 800) / 800));
    for (const g of $("markers").children) {
      const px = +g.dataset.x * k + x, py = +g.dataset.y * k + y;
      g.setAttribute("transform", `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${(fit * shrink).toFixed(3)})`);
    }
  }

  function togglePlace(b) {
    state.place = state.place && state.place.key === b.key ? null : { key: b.key, label: b.sub && b.key[0] === "r" ? `${b.title}, ${b.sub}` : b.title };
    renderPlaceFilter();
    renderMarkers();
    renderTables();
  }
  function renderPlaceFilter() {
    $("placeFilter").hidden = !state.place;
    $("placeFilterName").textContent = state.place ? state.place.label : "";
    $("kindFilter").hidden = !state.group;
    $("kindFilterName").textContent = [state.group, state.kind !== state.group && state.kind, state.sub, state.label].filter(Boolean).join(" \u00b7 ");
  }

  // Both filters redraw the same three things, and the map is in that list on
  // purpose: after clicking "5 Pool node" the next question is where those
  // five are, and the map answers it without a second click.
  function applyFilters() {
    layers();
    renderPlaceFilter();
    renderUnplaced();
    renderMarkers();
    renderTables();
  }

  function setGroup(group) {
    impliedGroup = false;
    state.group = state.group === group ? null : group;
    state.kind = null;
    state.sub = null;
    state.label = null;
    state.allSubs = false;
    applyFilters();
  }
  // `group` is given when the pick comes from a card that shows its only
  // group's kinds straight away, without a chip of the group to click first.
  // That group came with the pick, so it goes with it: unpicking it again
  // leaves the page unfiltered, as it was, not filtered to that group.
  let impliedGroup = false;
  function pickIn(group) {
    if (!group) return;
    if (!state.group) impliedGroup = true;
    state.group = group;
  }
  function dropImplied() {
    if (impliedGroup && !state.kind && !state.sub && !state.label) state.group = null;
    if (!state.group) impliedGroup = false;
  }
  function setKind(kind, group) {
    pickIn(group);
    state.kind = state.kind === kind ? null : kind;
    state.sub = null;
    state.label = null;
    state.allSubs = false;
    dropImplied();
    applyFilters();
  }
  function setSub(sub, group) {
    pickIn(group);
    state.sub = state.sub === sub ? null : sub;
    dropImplied();
    applyFilters();
  }
  function setLabel(label, group) {
    pickIn(group);
    state.label = state.label === label ? null : label;
    dropImplied();
    applyFilters();
  }

  $("placeFilterClear").addEventListener("click", () => {
    state.place = null;
    applyFilters();
  });
  $("kindFilterClear").addEventListener("click", () => {
    state.group = null;
    state.kind = null;
    state.sub = null;
    state.label = null;
    applyFilters();
  });

  // ---------- tooltip ----------
  const tip = $("tooltip");
  function showTip(b, e, el) {
    tip.textContent = "";
    const h = document.createElement("h3");
    h.textContent = b.title;
    tip.appendChild(h);
    if (b.sub) {
      const s = document.createElement("div");
      s.className = "sub";
      s.textContent = b.sub;
      tip.appendChild(s);
    }
    for (const k of GROUPS) {
      const row = document.createElement("div");
      row.className = "row";
      const sw = document.createElement("span");
      sw.className = "swatch s-" + k;
      const label = document.createElement("span");
      label.textContent = LABEL[k];
      const n = document.createElement("b");
      n.textContent = b[k];
      row.append(sw, label, n);
      tip.appendChild(row);
    }
    tip.hidden = false;
    if (e) moveTip(e);
    else if (el) {
      const wr = $("mapWrap").getBoundingClientRect(), r = el.getBoundingClientRect();
      positionTip(r.right - wr.left, r.top - wr.top);
    }
  }
  function moveTip(e) {
    const wr = $("mapWrap").getBoundingClientRect();
    positionTip(e.clientX - wr.left, e.clientY - wr.top);
  }
  function positionTip(x, y) {
    const wrap = $("mapWrap");
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > wrap.clientWidth - 8) left = x - w - 14;
    if (top + h > wrap.clientHeight - 8) top = y - h - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { tip.hidden = true; }

  // ---------- pan & zoom ----------
  const MAX_K = 24;
  function clampView() {
    const v = state.view, W = state.world.w, H = state.world.h;
    v.k = Math.min(MAX_K, Math.max(1, v.k));
    v.x = Math.min(0, Math.max(W - W * v.k, v.x));
    v.y = Math.min(0, Math.max(H - H * v.k, v.y));
  }
  function applyView() {
    if (!state.world) return;
    clampView();
    const { k, x, y } = state.view;
    for (const id of ["countries", "links", "fx"]) $(id).setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
    // Dots at the world view, country shapes once zoomed in towards regions.
    $("map").style.setProperty("--dots", String(Math.max(0, Math.min(1, (REGION_ZOOM + 0.5 - k) / 1.5))));
    if (!state.data) return;
    if (renderedMode !== regionMode()) {
      hideTip();
      renderMarkers(); // crossing the region threshold regroups the markers
    } else {
      placeMarkers();
    }
  }
  function toSvg(clientX, clientY) {
    const svg = $("map");
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function zoomAt(factor, sx, sy) {
    const v = state.view;
    const nk = Math.min(MAX_K, Math.max(1, v.k * factor));
    const f = nk / v.k;
    v.x = sx - (sx - v.x) * f;
    v.y = sy - (sy - v.y) * f;
    v.k = nk;
    applyView();
  }
  function setupPanZoom() {
    const svg = $("map");
    svg.addEventListener("wheel", (e) => {
      // Zoomed all the way out, turning the wheel further out is the page's:
      // over a map that fills the screen, scrolling past it was impossible.
      // A trackpad pinch arrives as a wheel with ctrlKey: still the map's, or
      // the browser zooms the whole page.
      if (state.view.k <= 1 && e.deltaY > 0 && !e.ctrlKey) return;
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });

    const pointers = new Map();
    let last = null, pinch = null, moved = false;
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".marker")) return;
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, toSvg(e.clientX, e.clientY));
      moved = false;
      if (pointers.size === 1) { last = pointers.get(e.pointerId); svg.classList.add("dragging"); }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      const p = toSvg(e.clientX, e.clientY);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d > 0) zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.d = d;
        moved = true;
      } else if (pointers.size === 1 && last) {
        state.view.x += p.x - last.x;
        state.view.y += p.y - last.y;
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > 0.5) moved = true;
        applyView();
        last = toSvg(e.clientX, e.clientY);
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) { last = null; svg.classList.remove("dragging"); }
      else last = [...pointers.values()][0];
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("dblclick", (e) => {
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(2, p.x, p.y);
    });
    svg.addEventListener("click", () => {
      if (!moved && state.place) {
        state.place = null;
        applyFilters();
      }
    });

    const center = () => [state.world.w / 2, state.world.h / 2];
    $("zoomIn").addEventListener("click", () => zoomAt(1.6, ...center()));
    $("zoomOut").addEventListener("click", () => zoomAt(1 / 1.6, ...center()));
    $("zoomReset").addEventListener("click", () => { state.view = { k: 1, x: 0, y: 0 }; applyView(); });
    window.addEventListener("resize", () => { if (state.data) placeMarkers(); });
    // The route is laid out in pixels from the card's width, so a new width
    // needs a new layout - and a narrow one may need the list instead.
    let routeResize = null, routeWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      if (window.innerWidth === routeWidth) return;
      routeWidth = window.innerWidth;
      clearTimeout(routeResize);
      routeResize = setTimeout(() => { if (state.data) renderBlockCard(); }, 150);
    });
  }


  // ---------- not on the map (collapsible side panel) ----------
  function setSide(open) {
    $("unplaced").hidden = !open;
    $("sideToggle").setAttribute("aria-expanded", String(open));
    store.set(SIDE_KEY, open ? "1" : "0");
    if (state.world && state.data) placeMarkers(); // map width changed
  }
  $("sideToggle").addEventListener("click", () => setSide($("unplaced").hidden));
  // Like every other fold, a tap on what it opened closes it again - unless
  // the reader is selecting text.
  $("unplaced").addEventListener("click", () => {
    if (String(window.getSelection()).length === 0) setSide(false);
  });
  setSide(store.get(SIDE_KEY) === "1"); // collapsed unless opened before

  function renderUnplaced() {
    const rows = new Map();
    let total = 0;
    for (const p of state.data.peers) {
      if (p.cc || !matchesKind(p)) continue;
      let key = netLabel(p.network);
      if (p.network === "ipv4" || p.network === "ipv6") key = "No geo data";
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { manual: 0, inbound: 0, outbound: 0 }));
      r[p.group]++;
      total++;
    }
    $("unplacedCount").textContent = total;
    const body = $("unplacedBody");
    body.textContent = "";
    if (!rows.size) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = "Every peer is on the map.";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const [name, r] of [...rows.entries()].sort()) {
      const tr = document.createElement("tr");
      const th = document.createElement("td");
      th.textContent = name;
      tr.appendChild(th);
      for (const g of GROUPS) {
        const td = document.createElement("td");
        td.textContent = r[g];
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

