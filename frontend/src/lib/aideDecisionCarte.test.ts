import { describe, expect, it } from "vitest";
import {
  COULEURS_PRIORITE, COULEUR_RESEAU_NEUTRE, EMPRISE_MAX_DEGRES, MODES_VUE, PLAFOND_MARQUEURS, ZOOM_MINIMUM_INTERVENTIONS,
  basculerDansListe, bboxAutour, bboxDeLignes, bboxTropLarge, bboxValide, calculerConstats, cleIcone, couchesPourMode, ecartLongueur, elargirBbox,
  empriseARecharger, etatZoom, filtrerParVue, filtrerReseau, formaterDate, formaterMontant, genreMarqueur, geometrieDessinable, libelleExclusion,
  libelleIntervention, limiterMarqueurs, lireGeoJsonCouche, lireInterventionCarte, lireInterventionsGeo, lireMetaGeo, lireReseau, lireTableauCouche,
  lireTroncature, messageCoucheInvalide, messageHorsGeometrie, messagePlafond, messageTroncature, modeStyleReseau, phraseCouverture, presenterCout,
  presenterScore, resumeFiltres, reseauEnFeatureCollection, statutScoreServeur, styleLigneIntervention, styleMarqueurIntervention, styleReseau,
  svgMarqueurIntervention, trierInterventions, validiteCout, zoomOuverture,
  type Bbox, type InterventionCarte,
} from "./aideDecisionCarte";
import { lireIntervention, type Intervention } from "./aideDecisionInterventions";
import { SYMBOLES } from "../features/geoportail/map/symbology";
import { TRAIT_ETAT_DECLARE } from "../pages/geoportail/affichageTroncon";
import { exclueSynth, incompleteSynth, interventionSynth } from "../components/decision/carte/synthetique.testutil";

/** Toutes les donnees de ce fichier sont SYNTHETIQUES (`synth-*`) : aucune position ni aucun chiffre ne decrit une intervention reelle. */

function interv(i = 1, over: Record<string, unknown> = {}): Intervention {
  return lireIntervention(interventionSynth(i, over))!;
}
const incomplete = (i: number, manquants: { critere: string; libelle: string; raison: string }[], over: Record<string, unknown> = {}) => lireIntervention(incompleteSynth(i, manquants, 22.5, over))!;
const exclue = (i: number, code?: string) => lireIntervention(exclueSynth(i, code))!;

const carte = (id: string, over: Partial<InterventionCarte> = {}): InterventionCarte => ({
  id, code: `SYN-${id}`, nom: null, rang: 1, score: 50, scoreIncomplet: false, statutScore: "CALCULE", etatPhysique: "MAUVAIS", classe: "RN", position: [9.6, -13.7], lignes: null, ...over,
});

describe("emprises : zoom minimal, emprise bornee, rechargement", () => {
  it("bboxValide refuse tout ce qui n'est pas quatre degres coherents", () => {
    expect(bboxValide([-13.8, 9.5, -13.5, 9.8])).toBe(true);
    expect(bboxValide([-13.5, 9.5, -13.8, 9.8])).toBe(false);
    expect(bboxValide([-13.8, 9.5, -13.5])).toBe(false);
    expect(bboxValide([-13.8, 9.5, -13.5, Number.NaN])).toBe(false);
    expect(bboxValide([-181, 9.5, -13.5, 9.8])).toBe(false);
    expect(bboxValide("a,b,c,d")).toBe(false);
  });

  it("une emprise de plus de 10 degres de cote est trop large ; exactement 10 degres passe (borne serveur)", () => {
    expect(EMPRISE_MAX_DEGRES).toBe(10);
    expect(bboxTropLarge([-17, 8, -7, 12])).toBe(false);
    expect(bboxTropLarge([-17, 8, -6.99, 12])).toBe(true);
    expect(bboxTropLarge([-14, 5, -13, 15.1])).toBe(true);
  });

  it("zoom minimal : en dessous, la raison est « zoom » ; zoom suffisant mais emprise trop large, la raison est « emprise »", () => {
    expect(ZOOM_MINIMUM_INTERVENTIONS).toBe(6);
    expect(etatZoom(5, [-14, 9, -13, 10])).toEqual({ suffisant: false, raison: "zoom" });
    expect(etatZoom(Number.NaN, null)).toEqual({ suffisant: false, raison: "zoom" });
    expect(etatZoom(7, [-17, 8, -6, 12])).toEqual({ suffisant: false, raison: "emprise" });
    expect(etatZoom(7, [-14, 9, -13, 10])).toEqual({ suffisant: true, raison: null });
  });

  it("emprise a recharger : rien si la vue est incluse dans la derniere emprise chargee ; la vue elargie sinon ; jamais sous le zoom minimal", () => {
    const chargee: Bbox = [-14, 9, -13, 10];
    expect(empriseARecharger({ chargee, courante: [-13.9, 9.1, -13.1, 9.9], zoom: 9 })).toBeNull();
    const nouvelle = empriseARecharger({ chargee, courante: [-13.5, 9.5, -12.5, 10.5], zoom: 9 });
    expect(nouvelle).not.toBeNull();
    expect(nouvelle![0]).toBeLessThan(-13.5); // marge de 10 %
    expect(empriseARecharger({ chargee: null, courante: [-13.9, 9.1, -13.1, 9.9], zoom: 4 })).toBeNull();
    expect(empriseARecharger({ chargee: null, courante: [-17, 8, -6, 12], zoom: 8 })).toBeNull();
  });

  it("une reponse TRONQUEE n'est pas « l'emprise chargee » : zoomer dedans recharge (sinon des interventions manqueraient)", () => {
    const chargee: Bbox = [-14, 9, -13, 10];
    const dedans: Bbox = [-13.9, 9.1, -13.1, 9.9];
    expect(empriseARecharger({ chargee, courante: dedans, zoom: 9, tronquee: false })).toBeNull();
    expect(empriseARecharger({ chargee, courante: dedans, zoom: 9, tronquee: true })).not.toBeNull();
  });

  it("l'elargissement ne fait jamais depasser la borne du serveur", () => {
    const large: Bbox = [-14, 5, -4.5, 14.5]; // 9,5 degres : une marge de 10 % la ferait refuser
    expect(elargirBbox(large)).toEqual(large);
    expect(bboxTropLarge(elargirBbox([-14, 9, -13, 10]))).toBe(false);
  });

  it("zoom d'ouverture : le plus eloigne dont l'emprise est admise, borne en haut", () => {
    expect(zoomOuverture((z) => z < 8)).toBe(8);
    expect(zoomOuverture(() => false)).toBe(6);
    expect(zoomOuverture(() => true)).toBe(9);
  });

  it("bboxAutour refuse une position illisible", () => {
    expect(bboxAutour(10, -13, 0.1)).toEqual([-13.1, 9.9, -12.9, 10.1]);
    expect(bboxAutour(Number.NaN, -13)).toBeNull();
    expect(bboxAutour(95, -13, 10)).toBeNull();
  });

  it("bboxDeLignes : emprise d'un trace [lat, lon]", () => {
    expect(bboxDeLignes([[[9.5, -13.8], [9.7, -13.6]]])).toEqual([-13.8, 9.5, -13.6, 9.7]);
    expect(bboxDeLignes([])).toBeNull();
  });
});

describe("plafond d'affichage : jamais silencieux", () => {
  const beaucoup = (n: number) => Array.from({ length: n }, (_, k) => carte(`synth-${k}`, { rang: k + 1 }));

  it("au plus 300 marqueurs, les mieux classes d'abord, le reste est COMPTE", () => {
    expect(PLAFOND_MARQUEURS).toBe(300);
    const { affichees, nonAffichees } = limiterMarqueurs(beaucoup(412).reverse());
    expect(affichees).toHaveLength(300);
    expect(nonAffichees).toBe(112);
    expect(affichees[0].rang).toBe(1);
    expect(affichees[299].rang).toBe(300);
  });

  it("l'intervention selectionnee reste dessinee meme au-dela du plafond", () => {
    const { affichees, nonAffichees } = limiterMarqueurs(beaucoup(412), 300, "synth-400");
    expect(affichees).toHaveLength(300);
    expect(affichees.some((i) => i.id === "synth-400")).toBe(true);
    expect(nonAffichees).toBe(112);
  });

  it("les non classees (sans rang) passent en dernier, l'identifiant departage", () => {
    const { affichees } = limiterMarqueurs([carte("b", { rang: null }), carte("a", { rang: null }), carte("z", { rang: 2 })]);
    expect(affichees.map((i) => i.id)).toEqual(["z", "a", "b"]);
  });

  it("messagePlafond : singulier, pluriel, vide si rien n'est cache", () => {
    expect(messagePlafond(0)).toBe("");
    expect(messagePlafond(1)).toBe("1 intervention non affichée, zoomez");
    expect(messagePlafond(112)).toBe("112 interventions non affichées, zoomez");
  });

  it("troncature serveur : « N au total, seules les M plus prioritaires sont affichees : zoomez »", () => {
    const t = lireTroncature({ type: "FeatureCollection", features: [], tronque: true, total: 412 });
    expect(t).toEqual({ tronque: true, total: 412 });
    expect(messageTroncature(t, 300)).toMatch(/^412 interventions au total, seules les 300 plus prioritaires sont affichées : zoomez$/);
    expect(messageTroncature(t, 1)).toContain("seule la plus prioritaire est affichée");
    expect(messageTroncature(t, 0)).toContain("aucune n'est affichée");
  });

  it("une troncature dont le total est illisible est TOUJOURS dite ; une reponse non tronquee ne dit rien", () => {
    const t = lireTroncature({ tronque: true, total: "beaucoup" });
    expect(t?.tronque).toBe(true);
    expect(messageTroncature(t, 300)).toContain("total inconnu");
    expect(lireTroncature({ tronque: false, total: 12 })).toEqual({ tronque: false, total: 12 });
    expect(messageTroncature(lireTroncature({ tronque: false, total: 12 }), 12)).toBe("");
    expect(lireTroncature({ features: [] })).toBeNull();
    expect(lireTroncature(null)).toBeNull();
  });

  it("meta du geojson : interventions sans geometrie du perimetre (elles restent dans la liste) et filtres non appliques", () => {
    expect(lireMetaGeo({ horsGeometrie: 7, filtres: { nonAppliques: [{ filtre: "statutChantier" }] } })).toEqual({ horsGeometrie: 7, filtresNonAppliques: ["statutChantier"] });
    expect(lireMetaGeo({})).toEqual({ horsGeometrie: null, filtresNonAppliques: [] });
    expect(lireMetaGeo(null)).toEqual({ horsGeometrie: null, filtresNonAppliques: [] });
    expect(messageHorsGeometrie(7)).toContain("7 interventions du périmètre n'ont pas de localisation valide");
    expect(messageHorsGeometrie(1)).toContain("1 intervention du périmètre n'a pas de localisation valide");
    expect(messageHorsGeometrie(0)).toBe("");
    expect(messageHorsGeometrie(null)).toBe("");
  });
});

describe("lecture des features d'intervention (forme du backend reel) : rien n'est invente", () => {
  const point = (props: Record<string, unknown>, coords: unknown = [-13.7, 9.6]) => ({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: props });

  it("lit les proprietes du backend : id, code, nom, rang, score, scoreIncomplet, statutScore, etatPhysique, classe", () => {
    const r = lireInterventionCarte(point({ id: "synth-1", code: "SYN-1", nom: "N", rang: 3, score: 41.2, scoreIncomplet: true, statutScore: "INCOMPLET", etatPhysique: "CRITIQUE", classe: "RN" }));
    expect(r.ok && r.intervention).toMatchObject({ id: "synth-1", code: "SYN-1", rang: 3, score: 41.2, scoreIncomplet: true, statutScore: "INCOMPLET", etatPhysique: "CRITIQUE", classe: "RN", position: [9.6, -13.7], lignes: null });
  });

  it("aucun niveau de priorite n'est invente : un champ `priorite` eventuel est ignore, le genre vient du statut du score", () => {
    const r = lireInterventionCarte(point({ id: "a", rang: 2, statutScore: "CALCULE", priorite: "HAUTE" }));
    expect(r.ok && "priorite" in r.intervention).toBe(false);
    expect(genreMarqueur({ statutScore: "CALCULE", scoreIncomplet: false, rang: 2 })).toBe("CALCULE");
    expect(genreMarqueur({ statutScore: "INCOMPLET", scoreIncomplet: true, rang: 2 })).toBe("INCOMPLET");
    expect(genreMarqueur({ statutScore: "EXCLU", scoreIncomplet: false, rang: null })).toBe("EXCLU");
    expect(genreMarqueur({ statutScore: null, scoreIncomplet: false, rang: null })).toBe("EXCLU"); // sans rang : non classee, on ne la range pas en « calculee »
    expect(genreMarqueur({ statutScore: null, scoreIncomplet: true, rang: 4 })).toBe("INCOMPLET");
  });

  it("un score incomplet absent des proprietes n'est pas deduit : il reste faux (on ne dit pas plus que la donnee)", () => {
    const r = lireInterventionCarte(point({ id: "a" }));
    expect(r.ok && r.intervention.scoreIncomplet).toBe(false);
    expect(r.ok && r.intervention.rang).toBeNull();
    expect(r.ok && r.intervention.statutScore).toBeNull();
  });

  it("ecarte et COMPTE : sans identifiant, sans geometrie, geometrie non dessinable, position hors bornes", () => {
    expect(lireInterventionCarte(point({}))).toEqual({ ok: false, raison: "SANS_IDENTIFIANT" });
    expect(lireInterventionCarte({ properties: { id: "a" } })).toEqual({ ok: false, raison: "GEOMETRIE_ABSENTE" });
    expect(lireInterventionCarte({ properties: { id: "a" }, geometry: { type: "Polygon", coordinates: [] } })).toEqual({ ok: false, raison: "GEOMETRIE_NON_DESSINABLE" });
    expect(lireInterventionCarte(point({ id: "a" }, [-400, 9.6]))).toEqual({ ok: false, raison: "POSITION_INVALIDE" });
    expect(lireInterventionCarte(point({ id: "a" }, [Number.NaN, 9.6]))).toEqual({ ok: false, raison: "POSITION_INVALIDE" });
  });

  it("une ligne de troncon est tracee, son repere est le sommet median", () => {
    const r = lireInterventionCarte({ type: "Feature", properties: { id: "l" }, geometry: { type: "LineString", coordinates: [[-13.8, 9.5], [-13.7, 9.6], [-13.6, 9.7]] } });
    expect(r.ok && r.intervention.position).toEqual([9.6, -13.7]);
    expect(r.ok && r.intervention.lignes).toEqual([[[9.5, -13.8], [9.6, -13.7], [9.7, -13.6]]]);
  });

  it("lireInterventionsGeo : un doublon et une feature illisible sont ecartes ET comptes", () => {
    const fc = { features: [point({ id: "a" }), point({ id: "a" }), point({}), point({ id: "b" }, "x")] };
    const l = lireInterventionsGeo(fc);
    expect(l.interventions.map((i) => i.id)).toEqual(["a"]);
    expect(l.ignorees).toBe(3);
    expect(lireInterventionsGeo(null)).toEqual({ interventions: [], ignorees: 0 });
  });
});

describe("validation du GeoJSON des couches : une couche invalide est ignoree, la page ne plante pas", () => {
  const ligne = { type: "LineString", coordinates: [[-13.8, 9.5], [-13.7, 9.6]] };

  it("refuse {}, null, un texte, un tableau, une FeatureCollection sans features", () => {
    for (const mauvais of [{}, null, undefined, "<html>", [], { type: "FeatureCollection" }, { type: "Feature", geometry: null }, { type: "Inconnu" }]) {
      expect(lireGeoJsonCouche(mauvais).ok, JSON.stringify(mauvais)).toBe(false);
    }
  });

  it("une FeatureCollection a moitie lisible est reduite et l'ecart COMPTE ; entierement illisible : refusee avec sa raison", () => {
    const moitie = lireGeoJsonCouche({ type: "FeatureCollection", features: [{ type: "Feature", geometry: ligne }, { type: "Feature", geometry: null }, { type: "Feature", geometry: { type: "Point", coordinates: ["x", 1] } }] });
    expect(moitie.ok && moitie.ignores).toBe(2);
    expect(moitie.ok && (moitie.donnees as GeoJSON.FeatureCollection).features).toHaveLength(1);
    const rien = lireGeoJsonCouche({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null }] });
    expect(rien).toEqual({ ok: false, raison: "aucun des 1 éléments n'a de géométrie lisible" });
    expect(lireGeoJsonCouche({ type: "FeatureCollection", features: [] }).ok).toBe(true); // rien en base : pas une anomalie
  });

  it("geometrieDessinable : coordonnees finies et bornees seulement", () => {
    expect(geometrieDessinable(ligne)).toBe(true);
    expect(geometrieDessinable({ type: "LineString", coordinates: [] })).toBe(false);
    expect(geometrieDessinable({ type: "Point", coordinates: [200, 0] })).toBe(false);
    expect(geometrieDessinable({ type: "GeometryCollection", geometries: [ligne] })).toBe(true);
    expect(geometrieDessinable({ type: "GeometryCollection", geometries: [] })).toBe(false);
  });

  it("lireTableauCouche : un objet ou null n'est pas une liste ; les elements illisibles sont comptes", () => {
    const garder = (x: unknown) => typeof (x as { lat?: unknown })?.lat === "number";
    expect(lireTableauCouche({ a: 1 }, garder)).toEqual({ ok: false, raison: "la réponse n'est pas une liste" });
    expect(lireTableauCouche(null, garder)).toEqual({ ok: false, raison: "réponse vide" });
    expect(lireTableauCouche([{ lat: 1 }, { lat: "x" }], garder)).toEqual({ ok: true, donnees: [{ lat: 1 }], ignores: 1 });
    expect(lireTableauCouche([{ lat: "x" }], garder).ok).toBe(false);
    expect(messageCoucheInvalide("Ouvrages d'art", "réponse vide")).toBe("Données de la couche « Ouvrages d'art » invalides : couche ignorée (réponse vide).");
  });

  it("lireReseau : geometrie en texte, ecarte et compte les troncons sans identifiant, a geometrie illisible ou en double", () => {
    const t = (over: Record<string, unknown>) => ({ id: "t1", code: "SYN-1", nom: "N", classe: "RN", etat: "BON", etatDeclare: false, region: "R", longueurKm: 3, geometry: JSON.stringify(ligne), ...over });
    const l = lireReseau([t({}), t({ id: "t2", geometry: "{pas du json" }), t({ id: "t1" }), t({ id: undefined }), t({ id: "t3", geometry: JSON.stringify({ type: "LineString", coordinates: [] }) })]);
    expect(l.ok && l.donnees.map((x) => x.id)).toEqual(["t1"]);
    expect(l.ok && l.ignores).toBe(4);
    expect(lireReseau([t({ geometry: "x" })]).ok).toBe(false);
    expect(lireReseau({}).ok).toBe(false);
    const fc = reseauEnFeatureCollection(l.ok ? l.donnees : []);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.id).toBe("t1");
  });
});

describe("styles : la priorite n'est JAMAIS en couleur d'etat", () => {
  const couleursEtat = new Set(Object.values(SYMBOLES).flatMap((s) => [s.trait.toLowerCase(), s.texte.toLowerCase(), s.fond.toLowerCase()]));

  it("MUTATION DE CONTROLE : aucune teinte de priorite (fond, bord) n'est une teinte de l'echelle d'etat physique", () => {
    expect(Object.keys(COULEURS_PRIORITE).sort()).toEqual(["CALCULE", "EXCLU", "INCOMPLET"]);
    for (const [genre, c] of Object.entries(COULEURS_PRIORITE)) {
      for (const teinte of [c.fond, c.bord]) expect(couleursEtat.has(teinte.toLowerCase()), `${genre} ${teinte}`).toBe(false);
    }
  });

  it("le trace d'une intervention n'a jamais la couleur d'un etat, meme selectionne (dore = selection, jamais un etat)", () => {
    for (const sel of [false, true]) for (const inc of [false, true]) {
      expect(couleursEtat.has(styleLigneIntervention(sel, inc).color.toLowerCase())).toBe(false);
    }
  });

  it("le marqueur porte une FORME propre (hexagone) et le rang : ni cercle, ni losange, ni triangle d'etat", () => {
    const svg = svgMarqueurIntervention(styleMarqueurIntervention(carte("a", { rang: 12 })));
    expect(svg).toContain("<polygon");
    expect(svg).toContain(">12<");
    expect(svg).not.toContain("<circle cx=\"16\" cy=\"16\" r=\"10.5\"");
    expect(svg).toContain('aria-hidden="true"');
  });

  it("un score INCOMPLET se voit : contour pointille et disque « ? » ; un score complet n'a ni l'un ni l'autre", () => {
    const complet = svgMarqueurIntervention(styleMarqueurIntervention(carte("a")));
    const incomplet = svgMarqueurIntervention(styleMarqueurIntervention(carte("a", { scoreIncomplet: true, statutScore: "INCOMPLET" })));
    expect(complet).not.toContain("stroke-dasharray");
    expect(complet).not.toContain(">?<");
    expect(incomplet).toContain("stroke-dasharray");
    expect(incomplet).toContain(">?<");
    expect(incomplet).not.toBe(complet);
    expect(libelleIntervention(carte("a", { scoreIncomplet: true, statutScore: "INCOMPLET" }))).toContain("score incomplet");
    expect(libelleIntervention(carte("a"))).toContain("score complet");
  });

  it("une non classee est GRISE, sans rang (« · »), sans « ? », et son nom accessible dit « non classée »", () => {
    const i = carte("x", { rang: null, score: null, statutScore: "EXCLU" });
    const st = styleMarqueurIntervention(i);
    expect(st.fond).toBe(COULEURS_PRIORITE.EXCLU.fond);
    expect(st.etiquette).toBe("·");
    expect(svgMarqueurIntervention(st)).not.toContain(">?<");
    expect(libelleIntervention(i)).toBe("Intervention non classée SYN-x, sans score, état mauvais");
  });

  it("les trois genres different par le fond ; la selection ajoute un halo ; la cle d'icone distingue genre, rang et selection", () => {
    const fonds = new Set([carte("a"), carte("a", { scoreIncomplet: true, statutScore: "INCOMPLET" }), carte("a", { rang: null, statutScore: "EXCLU" })].map((i) => styleMarqueurIntervention(i).fond));
    expect(fonds.size).toBe(3);
    expect(svgMarqueurIntervention(styleMarqueurIntervention(carte("a")), { selectionne: true })).toContain("rgba(245,166,35,0.35)");
    const cles = new Set([cleIcone(carte("a"), false), cleIcone(carte("a"), true), cleIcone(carte("a", { scoreIncomplet: true, statutScore: "INCOMPLET" }), false), cleIcone(carte("a", { rang: 2 }), false)]);
    expect(cles.size).toBe(4);
  });

  it("reseau : colore par l'etat en vue « Etat actuel » (pointille si declare), fond gris ailleurs", () => {
    const t = { etat: "CRITIQUE", etatDeclare: true, classe: "RN" };
    expect(styleReseau(t, "etat")).toMatchObject({ color: SYMBOLES.CRITIQUE.trait, dashArray: TRAIT_ETAT_DECLARE });
    expect(styleReseau({ ...t, etatDeclare: false }, "etat").dashArray).toBeUndefined();
    expect(styleReseau(t, "neutre")).toMatchObject({ color: COULEUR_RESEAU_NEUTRE });
    expect(styleReseau(t, "neutre").dashArray).toBeUndefined();
    expect(modeStyleReseau("etat")).toBe("etat");
    expect(modeStyleReseau("priorites")).toBe("neutre");
    expect(styleReseau({ etat: "VALEUR_INCONNUE", etatDeclare: false, classe: "XX" }, "etat").color).toBe(SYMBOLES.NON_EVALUE.trait);
  });

  it("l'etiquette du rang tient dans l'hexagone : « 999+ » au-dela de 999, « · » sans rang", () => {
    expect(styleMarqueurIntervention(carte("a", { rang: 1500 })).etiquette).toBe("999+");
    expect(styleMarqueurIntervention(carte("a", { rang: null })).etiquette).toBe("·");
  });
});

describe("modes de vue et couches", () => {
  it("Chantiers et Budget sont DESACTIVES avec leur raison : jamais un mode vide et muet", () => {
    const ch = MODES_VUE.find((m) => m.id === "chantiers")!;
    const bu = MODES_VUE.find((m) => m.id === "budget")!;
    expect(ch.disponible).toBe(false);
    expect(bu.disponible).toBe(false);
    expect(ch.raison).toMatch(/bailleur.*texte libre/);
    expect(bu.raison).toMatch(/B-08/);
    expect(MODES_VUE.filter((m) => m.disponible).map((m) => m.id)).toEqual(["etat", "priorites"]);
  });

  it("le mode regle le reseau et les priorites ; les couches de contexte restent au choix", () => {
    const base = { reseau: false, priorites: false, chantiers: true, ouvrages: false, pointsNoirs: false, limites: true };
    expect(couchesPourMode("priorites", base)).toMatchObject({ reseau: true, priorites: true, chantiers: true });
    expect(couchesPourMode("etat", { ...base, priorites: true })).toMatchObject({ reseau: true, priorites: false, chantiers: true });
  });
});

describe("filtres : application aux couches de contexte, resume", () => {
  const troncons = ["RN", "RR"].flatMap((classe) => ["BON", "CRITIQUE"].map((etat, k) => ({ id: `${classe}-${etat}`, code: "c", nom: "n", classe, etat, etatDeclare: false, region: k ? "Kindia" : "Labé", longueurKm: 1, geometrie: { type: "Point" as const, coordinates: [0, 0] } })));

  it("region, classe et etat se combinent", () => {
    expect(filtrerReseau(troncons, { classe: ["RN"], etat: ["CRITIQUE"] }, null).troncons.map((t) => t.id)).toEqual(["RN-CRITIQUE"]);
    expect(filtrerReseau(troncons, { regionId: 3 }, "Kindia").troncons.map((t) => t.id)).toEqual(["RN-CRITIQUE", "RR-CRITIQUE"]);
  });

  it("region non resolue (liste des regions indisponible) : le filtre n'est PAS applique et la carte le sait", () => {
    const r = filtrerReseau(troncons, { regionId: 3 }, null);
    expect(r.regionNonAppliquee).toBe(true);
    expect(r.troncons).toHaveLength(4);
    expect(filtrerReseau(troncons, {}, null).regionNonAppliquee).toBe(false);
  });

  it("basculerDansListe : ajoute, retire, et rend undefined quand la liste est vide (le filtre disparait)", () => {
    expect(basculerDansListe(undefined, "RN")).toEqual(["RN"]);
    expect(basculerDansListe(["RN"], "RR")).toEqual(["RN", "RR"]);
    expect(basculerDansListe(["RN"], "RN")).toBeUndefined();
  });

  it("resumeFiltres : null sans filtre, texte lisible sinon", () => {
    expect(resumeFiltres({}, null)).toBeNull();
    const r = resumeFiltres({ regionId: 3, classe: ["RN"], etat: ["CRITIQUE"], depuis: "2026-01-01", jusqua: "2026-06-30" }, "Kindia");
    expect(r).toContain("région Kindia");
    expect(r).toContain("Routes nationales (RN)");
    expect(r).toContain("état Critique");
    expect(r).toContain("période du 01/01/2026 au 30/06/2026");
    expect(resumeFiltres({ regionId: 3 }, null)).toBe("région n° 3");
  });
});

describe("presentation du score : un score INCOMPLET n'est jamais un score complet (AD-06)", () => {
  it("MUTATION DE CONTROLE : complet = le nombre ; incomplet = « Score incomplet » + valeur partielle ; non classee = motif ; absent = jamais 0", () => {
    expect(presenterScore(42.5, false)).toEqual({ genre: "complet", libelle: "Score 42,5", valeur: "42,5", motif: null });
    expect(presenterScore(42.5, true)).toEqual({ genre: "incomplet", libelle: "Score incomplet", valeur: "42,5", motif: null });
    expect(presenterScore(null, true)).toEqual({ genre: "incomplet", libelle: "Score incomplet", valeur: null, motif: null });
    expect(presenterScore(null, false)).toEqual({ genre: "absent", libelle: "Score non calculé", valeur: null, motif: null });
    expect(presenterScore(0, false).genre).toBe("complet"); // un vrai zero reste un zero
    expect(presenterScore(null, false, { code: "ETAT_NON_EVALUE", motif: "état non évalué" })).toEqual({ genre: "exclu", libelle: "Non classée", valeur: null, motif: "état non évalué : état non évalué" });
  });

  it("libelleExclusion : motifs connus en clair, code inconnu lisible tel quel", () => {
    expect(libelleExclusion("COUVERTURE_INSUFFISANTE")).toBe("couverture des critères insuffisante");
    expect(libelleExclusion("MOTIF_NOUVEAU")).toBe("motif nouveau");
  });
});

describe("presentation du cout : devise, source, validite, motif, jamais 0", () => {
  it("montant formate sur la CHAINE (precision), avec devise, source du bareme et validite", () => {
    const c = presenterCout(interv(1), "2026-10-26");
    expect(c.genre).toBe("estime");
    expect(c.libelle).toBe("1 200 000 000 GNF");
    expect(c.detail).toBe("source : barème synthétique ; valide jusqu'au 01/01/2099 ; estimation provisoire");
    expect(c.validite).toBe("valide");
  });

  it("un cout perime le dit ; sans fin de validite : « validité inconnue »", () => {
    const perime = interv(1, { coutEstime: { ...interventionSynth(1).coutEstime, bareme: { ...interventionSynth(1).coutEstime.bareme, validA: "2026-01-01" } } });
    expect(presenterCout(perime, "2026-10-26")).toMatchObject({ validite: "perime", detail: expect.stringContaining("périmé depuis le 01/01/2026") });
    const inconnu = interv(1, { coutEstime: { ...interventionSynth(1).coutEstime, bareme: { ...interventionSynth(1).coutEstime.bareme, validA: null } } });
    expect(presenterCout(inconnu, "2026-10-26")).toMatchObject({ validite: "inconnue", detail: expect.stringContaining("validité inconnue") });
    expect(validiteCout("pas une date", "2026-10-26")).toBe("inconnue");
    expect(validiteCout("2026-10-26", "2026-10-26")).toBe("valide");
  });

  it("« Coût non estimable » (avec le motif du serveur) et « Coût non renseigné » : jamais 0 GNF", () => {
    const cne = interv(1, { coutEstime: null, coutNonEstimable: { code: "BAREME_ABSENT", motif: "aucun barème pour ce traitement" } });
    expect(presenterCout(cne, "2026-10-26")).toMatchObject({ genre: "non-estimable", libelle: "Coût non estimable", detail: "aucun barème pour ce traitement" });
    const nr = presenterCout(interv(1, { coutEstime: null }), "2026-10-26");
    expect(nr.libelle).toBe("Coût non renseigné");
    expect(nr.libelle).not.toMatch(/\b0\b/);
  });

  it("formaterMontant : milliers sur la chaine, decimales conservees, texte non numerique rendu tel quel", () => {
    expect(formaterMontant("999")).toBe("999");
    expect(formaterMontant("12345678901234567890")).toBe("12 345 678 901 234 567 890");
    expect(formaterMontant("1234.50")).toBe("1 234,50");
    expect(formaterMontant("abc")).toBe("abc");
  });
});

describe("longueurs : metier et geometrique separees, divergence CELLE DU SERVEUR, jamais corrigee", () => {
  it("rend `divergence.signalee` du serveur sans la recalculer", () => {
    const l = interv(1, { longueur: { metierKm: 15, geometriqueM: 10000, longueurOrigine: "LONGUEUR_KM", divergence: { signalee: true, ecartRelatif: 0.5, seuilRelatif: 0.1 } } }).longueur;
    expect(l).toMatchObject({ metierKm: 15, geometriqueKm: 10 });
    expect(ecartLongueur(l)).toEqual({ ecartKm: 5, ecartRelatif: 0.5, signale: true });
    const ok = interv(1, { longueur: { metierKm: 11, geometriqueM: 10000, divergence: { signalee: false, ecartRelatif: 0.1, seuilRelatif: 0.1 } } }).longueur;
    expect(ecartLongueur(ok)?.signale).toBe(false);
  });
  it("sans divergence connue ou sans longueur : pas de calcul", () => {
    expect(ecartLongueur(null)).toBeNull();
    expect(ecartLongueur(interv(1, { longueur: { metierKm: 3, geometriqueM: 3000 } }).longueur)).toBeNull();
    expect(ecartLongueur(interv(1, { longueur: { metierKm: null, geometriqueM: null, divergence: { signalee: null, ecartRelatif: null } } }).longueur)).toEqual({ ecartKm: null, ecartRelatif: null, signale: false });
  });
});

describe("dates", () => {
  it("formate telle qu'ecrite, sans fuseau ; illisible : null", () => {
    expect(formaterDate("2026-10-23")).toBe("23/10/2026");
    expect(formaterDate("2026-10-23T23:59:00Z")).toBe("23/10/2026");
    expect(formaterDate("23/10/2026")).toBeNull();
    expect(formaterDate("2026-13-01")).toBeNull();
    expect(formaterDate(null)).toBeNull();
  });
});

describe("constats calcules (panneau Insights) : des comptes, jamais un texte statique", () => {
  const lot = [
    incomplete(1, [{ critere: "TRAFIC", libelle: "Trafic", raison: "absent" }, { critere: "SECURITE", libelle: "Sécurité", raison: "absent" }]),
    incomplete(2, [{ critere: "TRAFIC", libelle: "Trafic", raison: "périmé" }], { etatPhysique: "CRITIQUE" }),
    interv(3, { localisation: "invalide", coutEstime: null, coutNonEstimable: { code: "X", motif: "m" } }),
    interv(4, { etatPhysique: "CRITIQUE" }),
    exclue(5),
  ];

  it("lot complet : compte chaque constat sur les lignes, avec le critere le plus souvent manquant", () => {
    const { constats, couverture } = calculerConstats(lot, 5, false);
    const par = Object.fromEntries(constats.map((c) => [c.code, c]));
    expect(par.score_incomplet.nombre).toBe(2);
    expect(par.score_incomplet.libelle).toBe("2 interventions au score incomplet");
    expect(par.score_incomplet.detail).toContain("Trafic (2 interventions)");
    expect(par.non_classees.nombre).toBe(1);
    expect(par.sans_localisation.libelle).toBe("1 intervention sans localisation valide");
    expect(par.critiques.nombre).toBe(2);
    expect(par.cout_non_estimable.nombre).toBe(1);
    expect(couverture).toMatchObject({ chargees: 5, total: 5, complet: true });
    expect(constats.map((c) => c.vue)).toEqual(["score-incomplet", "non-classees", "sans-localisation", "critiques", "cout-non-estimable"]);
    expect(constats.every((c) => c.portee === "chargees")).toBe(true);
  });

  it("lot PARTIEL avec decompte du serveur : score incomplet et non classees viennent du `resume` (tout le perimetre), le reste des lignes chargees", () => {
    const resume = { candidats: 412, classes: 400, complets: 380, incomplets: 20, exclus: 12, parMotifExclusion: { ETAT_NON_EVALUE: 9, COUVERTURE_INSUFFISANTE: 3 } };
    const { constats, couverture } = calculerConstats(lot, 412, true, resume);
    const par = Object.fromEntries(constats.map((c) => [c.code, c]));
    expect(par.score_incomplet).toMatchObject({ nombre: 20, portee: "perimetre", libelle: "20 interventions au score incomplet" });
    expect(par.non_classees).toMatchObject({ nombre: 12, portee: "perimetre" });
    expect(par.non_classees.detail).toBe("Motifs : état non évalué (9), couverture des critères insuffisante (3).");
    expect(par.sans_localisation.portee).toBe("chargees");
    expect(couverture.complet).toBe(false);
    expect(couverture.phrase).toContain("comptes du serveur sur tout le périmètre");
    expect(couverture.phrase).toContain("5 interventions chargées (412 au total)");
  });

  it("lot partiel SANS decompte du serveur : tout est calcule sur les lignes chargees et la phrase le dit", () => {
    const { couverture, constats } = calculerConstats(lot, 412, true);
    expect(couverture.phrase).toBe("Calculé sur les 5 interventions chargées (412 au total) : ils peuvent changer en chargeant la suite.");
    expect(constats.every((c) => c.portee === "chargees")).toBe(true);
    expect(phraseCouverture(50, null, false)).toContain("total inconnu");
    expect(phraseCouverture(48, 48, true)).toBe("Calculé sur les 48 interventions du périmètre filtré.");
  });

  it("un constat a zero est un VRAI zero dit en mots (« Aucune ... »), sans detail", () => {
    const { constats } = calculerConstats([interv(1)], 1, false);
    expect(constats.every((c) => c.nombre === 0 && c.detail === null)).toBe(true);
    expect(constats[0].libelle).toBe("Aucune intervention au score incomplet");
  });

  it("filtrerParVue : chaque vue ne garde que ce qu'elle dit ; le serveur filtre « score incomplet » et « non classees » (statutScore)", () => {
    expect(filtrerParVue(lot, "score-incomplet").map((i) => i.id)).toEqual(["synth-1", "synth-2"]);
    expect(filtrerParVue(lot, "non-classees").map((i) => i.id)).toEqual(["synth-5"]);
    expect(filtrerParVue(lot, "sans-localisation").map((i) => i.id)).toEqual(["synth-3"]);
    expect(filtrerParVue(lot, "critiques").map((i) => i.id)).toEqual(["synth-2", "synth-4"]);
    expect(filtrerParVue(lot, "cout-non-estimable").map((i) => i.id)).toEqual(["synth-3"]);
    expect(filtrerParVue(lot, "toutes")).toHaveLength(5);
    expect(statutScoreServeur("score-incomplet")).toBe("INCOMPLET");
    expect(statutScoreServeur("non-classees")).toBe("EXCLU");
    expect(statutScoreServeur("critiques")).toBeUndefined();
    expect(statutScoreServeur("toutes")).toBeUndefined();
  });
});

describe("tri de la liste : les absences passent en dernier, le tri est stable", () => {
  const lot = [
    lireIntervention({ ...interventionSynth(1), prioriteTechnique: { ...interventionSynth(1).prioriteTechnique, score: null }, dernierConstat: { date: null }, regionNom: null })!,
    interv(2, { prioriteTechnique: { ...interventionSynth(2).prioriteTechnique, score: 10 }, dernierConstat: { date: "2026-05-01" }, regionNom: "Zinguinchor" }),
    interv(3, { prioriteTechnique: { ...interventionSynth(3).prioriteTechnique, score: 90 }, dernierConstat: { date: "2025-01-01" }, regionNom: "Labé" }),
    interv(4, { prioriteTechnique: { ...interventionSynth(4).prioriteTechnique, score: 90 }, dernierConstat: { date: "2026-09-01" } }),
  ];
  it("score decroissant, sans valeur en dernier, egalite departagee par l'ordre du serveur", () => {
    expect(trierInterventions(lot, "score").map((i) => i.id)).toEqual(["synth-3", "synth-4", "synth-2", "synth-1"]);
  });
  it("constat le plus ancien d'abord ; date absente en dernier", () => {
    expect(trierInterventions(lot, "constat").map((i) => i.id)).toEqual(["synth-3", "synth-2", "synth-4", "synth-1"]);
  });
  it("region alphabetique ; region absente en dernier ; rang = ordre du serveur inchange", () => {
    expect(trierInterventions(lot, "region").map((i) => i.id)).toEqual(["synth-3", "synth-4", "synth-2", "synth-1"]);
    expect(trierInterventions(lot, "rang").map((i) => i.id)).toEqual(["synth-1", "synth-2", "synth-3", "synth-4"]);
    expect(lot.map((i) => i.id)).toEqual(["synth-1", "synth-2", "synth-3", "synth-4"]); // l'entree n'est pas mutee
  });
});
