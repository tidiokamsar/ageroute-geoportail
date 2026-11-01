/* Outil de mesure du contraste dans un navigateur reel (docs/accessibilite/CONTRASTE.md). A COPIER TEMPORAIREMENT
   dans frontend/public/__a11y/ avec axe.min.js (node_modules/axe-core), a charger depuis la page, a ne JAMAIS commiter.
   + controle maison des bordures de composants (1.4.11) et des anneaux de focus. */
(function () {
  const SRC = "/__a11y/axe.min.js";
  function charger() {
    if (window.axe) return Promise.resolve();
    return new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = SRC; s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    });
  }
  function parse(c) {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function hex(c) {
    const h = (v) => Math.round(v).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  function fondDerriere(el) {
    // composite les fonds semi-transparents en remontant ; blanc par defaut
    const pile = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { pile.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = pile.length - 1; i >= 0; i--) base = over(pile[i], base);
    return base;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }
  function sel(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 3; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += "#" + e.id; parts.unshift(s); break; }
      const cl = (e.getAttribute("class") || "").split(/\s+/).filter((x) => x && !/^(hover|focus|group)/.test(x)).slice(0, 3).join(".");
      if (cl) s += "." + cl;
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  // 1.4.11 : delimitation d'un champ = sa bordure ou son fond, ou ceux d'un conteneur proche (3 niveaux)
  function delimitation(el) {
    const cs = getComputedStyle(el);
    const parent = fondDerriere(el.parentElement || el);
    let best = 0, quoi = "aucun";
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = parse(cs.borderTopColor);
    const own = parse(cs.backgroundColor);
    if (bw > 0 && bc && bc.a > 0) { const r = ratio(over(bc, parent), parent); if (r > best) { best = r; quoi = "bordure " + hex(over(bc, parent)); } }
    if (own && own.a > 0) { const r = ratio(over(own, parent), parent); if (r > best) { best = r; quoi = "fond " + hex(over(own, parent)); } }
    // anneau pose en box-shadow (ring-1 de Tailwind) : spread > 0, couleur opaque ou non
    const sh = cs.boxShadow;
    if (sh && sh !== "none") {
      for (const m of sh.matchAll(/(rgba?\([^)]+\))\s+(-?\d+)px\s+(-?\d+)px\s+(-?\d+)px\s+(-?\d+)px/g)) {
        const c = parse(m[1]);
        if (parseFloat(m[5]) >= 1 && parseFloat(m[4]) === 0 && c && c.a > 0) { const r = ratio(over(c, parent), parent); if (r > best) { best = r; quoi = "anneau " + hex(over(c, parent)); } }
      }
    }
    return { best, quoi, parent };
  }
  function composants() {
    const out = [];
    const els = document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, [role=combobox], button[role=checkbox], [role=switch]");
    els.forEach((el) => {
      if (!visible(el) || el.disabled) return;
      let d = delimitation(el);
      let hop = 0;
      for (let e = el.parentElement; d.best < 3 && e && hop < 3 && e !== document.body; e = e.parentElement, hop++) {
        const dd = delimitation(e);
        if (dd.best >= 3) { d = { best: dd.best, quoi: "conteneur " + dd.quoi, parent: dd.parent }; }
      }
      if (d.best < 3) out.push({ s: sel(el), best: +d.best.toFixed(2), quoi: d.quoi, fondParent: hex(d.parent) });
    });
    return out;
  }
  function regrouper(nodes) {
    const g = {};
    nodes.forEach((n) => {
      const k = n.fg + "|" + n.bg + "|" + n.req;
      (g[k] = g[k] || { fg: n.fg, bg: n.bg, ratio: n.ratio, req: n.req, n: 0, ex: [] });
      g[k].n++;
      if (g[k].ex.length < 3) g[k].ex.push(n.s + " [" + n.t + "]");
    });
    return Object.values(g).sort((a, b) => b.n - a.n);
  }
  // Resolution maison des noeuds "incomplets" d'axe dont le fond est un degrade : pire rapport
  // sur l'ensemble des arrets de couleur du degrade (borne basse honnete, pas une moyenne).
  function resoudre(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    let fg = parse(cs.color);
    if (!fg) return null;
    let g = null;
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const pile = [];
    for (let e = el; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.backgroundImage && st.backgroundImage !== "none") {
        if (/gradient/.test(st.backgroundImage)) { g = st.backgroundImage; }
        else return null; // image raster : non resolu
        break;
      }
      const c = parse(st.backgroundColor);
      if (c && c.a > 0) { pile.push(c); if (c.a >= 1) break; }
    }
    if (!g) return null;
    const arrets = (g.match(/rgba?\([^)]+\)/g) || []).map(parse).filter(Boolean);
    if (!arrets.length) return null;
    // fond sous le degrade
    for (let i = pile.length - 1; i >= 0; i--) base = over(pile[i], base);
    const taille = parseFloat(cs.fontSize);
    const gras = parseInt(cs.fontWeight, 10) >= 700;
    const req = taille >= 24 || (taille >= 18.66 && gras) ? 3 : 4.5;
    let pire = Infinity, pireFg = null, pireBg = null;
    arrets.forEach((a) => {
      const bg = over(a, base);
      const f = over(fg, bg);
      const r = ratio(f, bg);
      if (r < pire) { pire = r; pireFg = hex(f); pireBg = hex(bg); }
    });
    return { ratio: pire, req, fg: pireFg, bg: pireBg };
  }
  // Estimation maison (texte vs fond cumule des ancetres) : pour les noeuds qu'axe ne sait pas
  // trancher (chevauchement, erreur interne d'axe). Image raster : non resolu.
  function maison(el) {
    const rg = resoudre(el);
    if (rg) return Object.assign(rg, { src: "degrade" });
    for (let e = el; e; e = e.parentElement) {
      const bi = getComputedStyle(e).backgroundImage;
      if (bi && bi !== "none" && !/gradient/.test(bi)) return null;
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a >= 1) break;
    }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) return null;
    const bg = fondDerriere(el);
    const f = over(fg, bg);
    const taille = parseFloat(cs.fontSize);
    const gras = parseInt(cs.fontWeight, 10) >= 700;
    const req = taille >= 24 || (taille >= 18.66 && gras) ? 3 : 4.5;
    return { ratio: ratio(f, bg), req, fg: hex(f), bg: hex(bg), src: "maison" };
  }
  function texteDirect(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length) return true;
    return false;
  }
  const OPTS = { runOnly: { type: "rule", values: ["color-contrast"] }, resultTypes: ["violations", "incomplete", "passes"], elementRef: true };
  function aErreur(r) {
    return r.incomplete.some((v) => v.nodes.some((n) => n.none.some((c) => c.id === "error-occurred")));
  }
  function ajouter(acc, el, rs, s, t) {
    if (!rs) { acc.inc.push({ s, why: "non resolu" }); return; }
    if (rs.ratio >= rs.req) { acc.incOk++; return; }
    acc.nodes.push({ s: s.slice(0, 110), fg: rs.fg, bg: rs.bg, ratio: +rs.ratio.toFixed(2), req: rs.req + ":1", t, src: rs.src });
  }
  function collecter(acc, r) {
    acc.ok += r.passes.reduce((a, v) => a + v.nodes.length, 0);
    r.violations.forEach((v) => v.nodes.forEach((n) => {
      const d = (n.any[0] && n.any[0].data) || {};
      acc.nodes.push({ s: n.target.join(" ").slice(0, 110), fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, req: d.expectedContrastRatio, t: ((n.element && n.element.textContent) || "").trim().slice(0, 28), src: "axe" });
    }));
    r.incomplete.forEach((v) => v.nodes.forEach((n) => {
      if (n.element) ajouter(acc, n.element, maison(n.element), n.target.join(" "), (n.element.textContent || "").trim().slice(0, 28));
    }));
  }
  async function zone(el, acc, prof) {
    if (acc.runs++ > 600) { acc.tronque = true; return; }
    const r = await window.axe.run({ include: [el] }, OPTS);
    if (!aErreur(r)) { collecter(acc, r); return; }
    acc.zonesEnErreur++;
    if (texteDirect(el) && visible(el)) {
      const rs = maison(el); acc.maisonDirect++;
      ajouter(acc, el, rs, sel(el), (el.textContent || "").trim().slice(0, 28));
    }
    if (!el.children.length || prof > 14) return;
    for (const c of el.children) { if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|IMG|svg)$/.test(c.tagName) || (c.classList && (c.classList.contains('leaflet-pane') || c.classList.contains('leaflet-control-container')))) continue; await zone(c, acc, prof + 1); }
  }
  window.__a11y = {
    ratio, parse, over, hex, fondDerriere, sel, resoudre, maison,
    async run(etiquette, opts) {
      await charger();
      const acc = { nodes: [], inc: [], ok: 0, incOk: 0, zonesEnErreur: 0, maisonDirect: 0, runs: 0 };
      const r = await window.axe.run(document, OPTS);
      if (!aErreur(r)) collecter(acc, r);
      else { acc.robuste = true; await zone(document.body, acc, 0); }
      const comp = composants();
      const res = {
        etiquette, url: location.pathname, ok: acc.ok, violationsNoeuds: acc.nodes.length,
        groupes: regrouper(acc.nodes).slice(0, (opts && opts.max) || 25),
        incOkResolus: acc.incOk, incDegradeEnViolation: acc.nodes.filter((n) => n.src !== "axe").length,
        incompletes: acc.inc.length, incEx: acc.inc.slice(0, 3), composants1411: comp.length, comp: comp.slice(0, 8),
        robuste: !!acc.robuste, zonesEnErreur: acc.zonesEnErreur, runs: acc.runs, tronque: !!acc.tronque,
      };
      window.__a11y.derniere = { nodes: acc.nodes, inc: acc.inc, comp };
      return JSON.stringify(res);
    },
  };
})();
