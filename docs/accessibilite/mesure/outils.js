/* Outils de balayage (voir mesure.js et docs/accessibilite/CONTRASTE.md). Suppose mesure.js charge. */
(function () {
  window.__go = async (p, wait = 2800) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); await new Promise((r) => setTimeout(r, wait)); };
  window.__PAGES = ["/", "/geoportail", "/troncons", "/ouvrages", "/chantiers", "/qualite", "/control-tower", "/exploitation/info-route", "/exploitation/patrouilles", "/veille", "/teledetection", "/inspections/releve", "/inspections/releve/enregistrer", "/inspections/terrain/defauts", "/inspections/terrain/portions", "/programmation", "/administration/baremes", "/rapports", "/administration", "/securite", "/points-noirs", "/postes", "/marches", "/inspections", "/documents", "/decision", "/alertes", "/rapports/bailleur", "/ordres-travaux", "/utilisateurs", "/gouvernance", "/inspections/terrain", "/portions/validation", "/inspections/defauts/validation", "/inspections/defauts/catalogue", "/imports", "/veille/configuration"];
  window.__base = window.__base || {};
  window.__scan = async (paths, wait) => {
    const out = [];
    for (const p of paths) {
      await window.__go(p, wait);
      const r = JSON.parse(await window.__a11y.run(p, { max: 200 }));
      r.nodesAll = window.__a11y.derniere.nodes; r.compAll = window.__a11y.derniere.comp;
      window.__base[p] = r;
      out.push(`${p} ok=${r.ok} viol=${r.violationsNoeuds} (estimes ${r.incDegradeEnViolation}) nonRes=${r.incompletes} c1411=${r.composants1411}${r.robuste ? " ROBUSTE runs=" + r.runs + (r.tronque ? " TRONQUE" : "") : ""}`);
    }
    return out.join("\n");
  };
  window.__etat = async (label, fn, wait = 900) => {
    await fn(); await new Promise((r) => setTimeout(r, wait));
    const r = JSON.parse(await window.__a11y.run(label, { max: 200 }));
    r.nodesAll = window.__a11y.derniere.nodes; r.compAll = window.__a11y.derniere.comp; window.__base[label] = r;
    return `${label} ok=${r.ok} viol=${r.violationsNoeuds} c1411=${r.composants1411}${r.robuste ? " ROBUSTE runs=" + r.runs + (r.tronque ? " TRONQUE" : "") : ""}`;
  };
  window.__t = (t) => [...document.querySelectorAll("main button, main a")].find((b) => (b.title || b.getAttribute("aria-label") || b.textContent || "").trim() === t);
  window.__detail = (label) => window.__base[label].nodesAll.map((n) => `${n.fg}/${n.bg} ${n.ratio} req${n.req} ${n.src} ${n.s.slice(-70)} [${n.t}]`);
  window.__agg = () => {
    const g = {};
    for (const [p, r] of Object.entries(window.__base)) for (const n of r.nodesAll) {
      const k = `${n.fg}/${n.bg}|${n.req}`;
      g[k] = g[k] || { k, ratio: n.ratio, n: 0, pages: new Set(), ex: [] };
      g[k].n++; g[k].pages.add(p);
      if (g[k].ex.length < 2) g[k].ex.push(p + " " + n.s.split(" > ").slice(-1)[0].slice(0, 70) + " [" + n.t + "]");
    }
    return Object.values(g).sort((a, b) => b.n - a.n).map((x) => `${x.k} r=${x.ratio} n=${x.n} pages=${x.pages.size} ${x.ex[0]}`);
  };
  window.__resume = () => {
    const b = window.__base;
    const tot = Object.values(b).reduce((a, r) => a + r.violationsNoeuds, 0);
    const okTot = Object.values(b).reduce((a, r) => a + r.ok, 0);
    const c = Object.values(b).reduce((a, r) => a + r.composants1411, 0);
    const parPage = Object.entries(b).filter(([, r]) => r.violationsNoeuds || r.composants1411).map(([p, r]) => `${p}:${r.violationsNoeuds}/c${r.composants1411}`).join(" ");
    return { pages: Object.keys(b).length, nodesEvalues: okTot + tot, violTexte: tot, violComposants: c, parPage };
  };
  // Indicateur de focus : pour chaque element focalisable, couleur de l'anneau (outline ou box-shadow
  // avec etalement) contre le fond voisin. Exige 3:1. A lancer APRES une vraie touche Tab (sinon
  // :focus-visible ne s'applique pas aux boutons et liens focalises par script).
  window.__focus = () => {
    const A = window.__a11y;
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=combobox],[tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && !e.disabled && getComputedStyle(e).visibility !== "hidden"; });
    let ok = 0; const bad = []; const nonFV = [];
    for (const e of els) {
      e.focus();
      if (!e.matches(":focus-visible")) { nonFV.push(A.sel(e)); continue; }
      const cs = getComputedStyle(e);
      const parent = A.fondDerriere(e.parentElement || e);
      const cands = [];
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) {
        const c = A.parse(cs.outlineColor);
        if (c && c.a > 0) cands.push(["outline", A.ratio(A.over(c, parent), parent), A.hex(A.over(c, parent))]);
      }
      if (cs.boxShadow && cs.boxShadow !== "none") {
        for (const x of cs.boxShadow.matchAll(/(rgba?\([^)]+\))\s+(-?\d+)px\s+(-?\d+)px\s+(-?\d+)px\s+(-?\d+)px/g)) {
          const c = A.parse(x[1]);
          if (parseFloat(x[5]) > 0 && c && c.a > 0) cands.push(["ring", A.ratio(A.over(c, parent), parent), A.hex(A.over(c, parent))]);
        }
      }
      const best = cands.sort((a, b) => b[1] - a[1])[0];
      if (!best) bad.push("AUCUN " + A.sel(e));
      else if (best[1] < 3) bad.push(best[0] + " " + best[2] + " " + best[1].toFixed(2) + " " + A.sel(e));
      else ok++;
      e.blur();
    }
    return { n: els.length, ok, nbad: bad.length, bad: bad.slice(0, 6), nonFV: nonFV.length };
  };
  window.__compAgg = () => {
    const agg = {};
    for (const r of Object.values(window.__base)) for (const c of r.compAll) {
      const k = c.quoi.split(" ").slice(0, 2).join(" ") + "/" + c.fondParent + " " + c.best + " " + c.s.split(" > ").slice(-1)[0].replace(/\.flex\.h-9\.w-full|\.w-full/g, "").slice(0, 50);
      agg[k] = (agg[k] || 0) + 1;
    }
    return Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + " x " + k);
  };
})();
