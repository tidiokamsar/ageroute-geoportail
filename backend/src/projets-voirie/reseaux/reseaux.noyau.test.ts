import { afterEach, describe, expect, it } from "vitest";
import { qualifierCible } from "./cible.noyau";
import {
  circuitsParExecutionMax, couvertureMinAssociation, lireTolerances, propositionsParCircuitMax, tolerancesAssociation,
} from "./config";
import { evaluerVertical, qualiteEffective, verifierQualite, type QualiteDescripteur } from "./qualite.noyau";
import {
  COUVERTURE_MIN_DEFAUT, TOLERANCES_DEFAUT_M, actionsPossibles, classeExclue, couverture, proposer, retenirPropositions, toleranceAssociation,
  verifierRelation, verifierTransitionRelation,
} from "./relations.noyau";
import { classeEffective, natureEffective, precisionHorizontaleEffective, verifierDescripteur } from "./types.noyau";

describe("heritage : l'objet, sinon le jeu, sinon l'inconnu (jamais une valeur inventee)", () => {
  it("la nature declaree par l'objet l'emporte sur celle du jeu", () => {
    expect(natureEffective("ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE")).toEqual({ nature: "ACTIF_PHYSIQUE", origine: "OBJET" });
  });
  it("sans descripteur, la nature du jeu s'applique", () => {
    expect(natureEffective(null, "CIRCUIT_LOGIQUE")).toEqual({ nature: "CIRCUIT_LOGIQUE", origine: "JEU" });
    expect(natureEffective(undefined, "AXE")).toEqual({ nature: "AXE", origine: "JEU" });
  });
  it("nature de jeu INCONNUE sans descripteur : INCONNUE, jamais devinee", () => {
    expect(natureEffective(null, "INCONNUE")).toEqual({ nature: "INCONNUE", origine: "INCONNUE" });
    expect(natureEffective(null, undefined)).toEqual({ nature: "INCONNUE", origine: "INCONNUE" });
  });
  it("une nature de descripteur hors de la liste declarable est ignoree", () => {
    expect(natureEffective("AXE", "CIRCUIT_LOGIQUE")).toEqual({ nature: "CIRCUIT_LOGIQUE", origine: "JEU" });
  });
  it("classe de precision : objet, sinon jeu, sinon INCONNUE (nulle) ; la classe n'est jamais deduite", () => {
    expect(classeEffective("A", "D")).toEqual({ classe: "A", origine: "OBJET" });
    expect(classeEffective(null, "D")).toEqual({ classe: "D", origine: "JEU" });
    expect(classeEffective(null, null)).toEqual({ classe: null, origine: "INCONNUE" });
  });
  it("precision horizontale : objet, sinon jeu, sinon nulle (jamais 0)", () => {
    expect(precisionHorizontaleEffective(2, 5)).toBe(2);
    expect(precisionHorizontaleEffective(null, 5)).toBe(5);
    expect(precisionHorizontaleEffective(null, null)).toBeNull();
  });
});

describe("descripteur : coherence role / nature / geometrie / type", () => {
  const base = { role: "RESEAU_TIERS", typeGeom: "LIGNE" as const, natureEff: "CIRCUIT_LOGIQUE" as const, typeObjet: null };
  it("accepte un circuit logique lineaire, un equipement ponctuel, un actif physique de toute geometrie", () => {
    expect(verifierDescripteur(base).ok).toBe(true);
    expect(verifierDescripteur({ ...base, natureEff: "EQUIPEMENT", typeGeom: "POINT", typeObjet: "VANNE" }).ok).toBe(true);
    for (const g of ["LIGNE", "POINT", "POLYGONE"] as const) expect(verifierDescripteur({ ...base, natureEff: "ACTIF_PHYSIQUE", typeGeom: g, typeObjet: "AUTRE" }).ok).toBe(true);
  });
  it("refuse les plans d'axes et les limites de route", () => {
    for (const role of ["AXES_TRAVAUX", "LIMITES_ROUTE"]) expect(verifierDescripteur({ ...base, role })).toMatchObject({ ok: false, code: "ROLE_NON_QUALIFIABLE" });
    expect(verifierDescripteur({ ...base, role: "AUTRE" }).ok).toBe(true);
  });
  it("refuse un circuit ponctuel et un equipement lineaire", () => {
    expect(verifierDescripteur({ ...base, typeGeom: "POINT" })).toMatchObject({ ok: false, code: "NATURE_INCOMPATIBLE_GEOMETRIE" });
    expect(verifierDescripteur({ ...base, natureEff: "EQUIPEMENT", typeGeom: "LIGNE" })).toMatchObject({ ok: false, code: "NATURE_INCOMPATIBLE_GEOMETRIE" });
  });
  it("refuse un type qui n'appartient pas a la nature, et un type sans nature connue", () => {
    expect(verifierDescripteur({ ...base, typeObjet: "VANNE" })).toMatchObject({ ok: false, code: "TYPE_OBJET_INCONNU_POUR_NATURE" });
    expect(verifierDescripteur({ ...base, natureEff: "INCONNUE", typeObjet: "FIBRE" })).toMatchObject({ ok: false, code: "TYPE_OBJET_SANS_NATURE" });
    expect(verifierDescripteur({ ...base, natureEff: "INCONNUE", typeObjet: null }).ok).toBe(true);
  });
});

describe("vertical : aucune conclusion 3D, jamais de valeur deduite", () => {
  const nul = { profondeurM: null, altitudeM: null, referenceVerticale: null, precisionVerticaleM: null };
  it("profondeur et altitude absentes : etat ABSENTE, aucune conclusion 3D", () => {
    const v = evaluerVertical(nul);
    expect(v).toMatchObject({ etat: "ABSENTE", evaluable: false, conclusion3D: null });
    expect(v.motifs[0]).toMatch(/aucune conclusion 3D/);
  });
  it("une profondeur sans reference verticale est INCOMPLETE", () => {
    expect(evaluerVertical({ ...nul, profondeurM: 1.2 })).toMatchObject({ etat: "INCOMPLETE", evaluable: false, conclusion3D: null });
  });
  it("meme avec profondeur et reference, rien n'est evaluable ni conclu : l'evaluation 3D n'existe pas encore", () => {
    const v = evaluerVertical({ profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel", precisionVerticaleM: 0.2 });
    expect(v).toMatchObject({ etat: "FOURNIE", evaluable: false, conclusion3D: null });
    expect(v.motifs.join(" ")).toMatch(/n'est pas implémentée/);
  });
  it("l'altitude seule suffit a ne plus etre ABSENTE ; une reference blanche ne compte pas", () => {
    expect(evaluerVertical({ ...nul, altitudeM: 12 }).etat).toBe("INCOMPLETE");
    expect(evaluerVertical({ ...nul, altitudeM: 12, referenceVerticale: "  " }).etat).toBe("INCOMPLETE");
  });
  it("une profondeur nulle (0 m) est une valeur fournie, pas une absence", () => {
    expect(evaluerVertical({ ...nul, profondeurM: 0, referenceVerticale: "surface" }).etat).toBe("FOURNIE");
  });
});

describe("qualite effective", () => {
  const desc = (o: Partial<QualiteDescripteur> = {}): QualiteDescripteur => ({ classePrecision: null, precisionHorizontaleM: null, precisionVerticaleM: null, profondeurM: null, altitudeM: null, referenceVerticale: null, ...o });
  const jeu = { classePrecision: null, precisionHorizontaleM: null, precisionVerticaleM: null };

  it("classe absente partout : inconnue, aucune precision inventee", () => {
    const q = qualiteEffective(null, jeu);
    expect(q).toMatchObject({ classePrecision: null, origineClasse: "INCONNUE", precisionHorizontaleM: null, precisionVerticaleM: null });
    expect(q.vertical).toMatchObject({ etat: "ABSENTE", profondeurM: null, altitudeM: null, evaluable: false });
  });
  it("le descripteur l'emporte sur le jeu, champ par champ", () => {
    const q = qualiteEffective(desc({ classePrecision: "A", precisionHorizontaleM: 0.1 }), { classePrecision: "D", precisionHorizontaleM: 5, precisionVerticaleM: 3 });
    expect(q).toMatchObject({ classePrecision: "A", origineClasse: "OBJET", precisionHorizontaleM: 0.1, precisionVerticaleM: 3 });
  });
  it("sans descripteur, le jeu s'applique ; la profondeur n'est jamais heritee du jeu (il n'en porte pas)", () => {
    const q = qualiteEffective(null, { classePrecision: "C", precisionHorizontaleM: 2, precisionVerticaleM: null });
    expect(q).toMatchObject({ classePrecision: "C", origineClasse: "JEU", precisionHorizontaleM: 2 });
    expect(q.vertical.profondeurM).toBeNull();
  });
  it("une profondeur fournie sans reference reste INCOMPLETE", () => {
    expect(qualiteEffective(desc({ profondeurM: 1 }), jeu).vertical.etat).toBe("INCOMPLETE");
  });
  it("verifierQualite : reference sans valeur refusee, precisions strictement positives et bornees", () => {
    expect(verifierQualite(desc({ referenceVerticale: "terrain" }))).toMatchObject({ ok: false, code: "REFERENCE_VERTICALE_SANS_VALEUR" });
    expect(verifierQualite(desc({ referenceVerticale: "terrain", profondeurM: 1 })).ok).toBe(true);
    for (const v of [0, -1, 100_001, Number.NaN]) expect(verifierQualite(desc({ precisionHorizontaleM: v }))).toMatchObject({ ok: false, code: "PRECISION_INCOHERENTE" });
    expect(verifierQualite(desc({ precisionVerticaleM: 0 }))).toMatchObject({ ok: false, code: "PRECISION_INCOHERENTE" });
  });
});

describe("relations : natures et geometries admises", () => {
  const circuit = { nature: "CIRCUIT_LOGIQUE" as const, typeGeom: "LIGNE" as const };
  const infraL = { nature: "ACTIF_PHYSIQUE" as const, typeGeom: "LIGNE" as const };
  const chambre = { nature: "ACTIF_PHYSIQUE" as const, typeGeom: "POINT" as const };
  const equip = { nature: "EQUIPEMENT" as const, typeGeom: "POINT" as const };

  it("PORTE_PAR : circuit logique lineaire -> infrastructure physique lineaire", () => {
    expect(verifierRelation("PORTE_PAR", circuit, infraL, false).ok).toBe(true);
    expect(verifierRelation("PORTE_PAR", infraL, circuit, false)).toMatchObject({ ok: false, code: "NATURE_RELATION_INCOMPATIBLE" });
    expect(verifierRelation("PORTE_PAR", circuit, chambre, false)).toMatchObject({ ok: false, code: "GEOMETRIE_RELATION_INCOMPATIBLE" });
    expect(verifierRelation("PORTE_PAR", circuit, { nature: "INCONNUE", typeGeom: "LIGNE" }, false)).toMatchObject({ ok: false, code: "NATURE_RELATION_INCOMPATIBLE" });
  });
  it("CONTENU_DANS : equipement ponctuel -> infrastructure physique ponctuelle ou surfacique", () => {
    expect(verifierRelation("CONTENU_DANS", equip, chambre, false).ok).toBe(true);
    expect(verifierRelation("CONTENU_DANS", equip, { nature: "ACTIF_PHYSIQUE", typeGeom: "POLYGONE" }, false).ok).toBe(true);
    expect(verifierRelation("CONTENU_DANS", equip, infraL, false)).toMatchObject({ ok: false, code: "GEOMETRIE_RELATION_INCOMPATIBLE" });
    expect(verifierRelation("CONTENU_DANS", chambre, equip, false)).toMatchObject({ ok: false, code: "NATURE_RELATION_INCOMPATIBLE" });
  });
  it("un objet n'est pas relie a lui-meme", () => {
    expect(verifierRelation("PORTE_PAR", circuit, infraL, true)).toMatchObject({ ok: false, code: "RELATION_SUR_SOI" });
  });
});

describe("relations : machine a etats (jamais appliquee silencieusement)", () => {
  const J = "Controle effectue avec le concessionnaire";
  it("une proposition se valide ou se refuse", () => {
    expect(verifierTransitionRelation("valider", "PROPOSEE", J)).toEqual({ ok: true, vers: "VALIDEE" });
    expect(verifierTransitionRelation("refuser", "PROPOSEE", J)).toEqual({ ok: true, vers: "REFUSEE" });
  });
  it("une relation validee se revoque, et seulement elle", () => {
    expect(verifierTransitionRelation("revoquer", "VALIDEE", J)).toEqual({ ok: true, vers: "REVOQUEE" });
    for (const s of ["PROPOSEE", "REFUSEE", "REVOQUEE"] as const) expect(verifierTransitionRelation("revoquer", s, J)).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
  });
  it("une relation refusee ou revoquee peut etre validee par une personne qui reconsidere", () => {
    expect(verifierTransitionRelation("valider", "REFUSEE", J)).toEqual({ ok: true, vers: "VALIDEE" });
    expect(verifierTransitionRelation("valider", "REVOQUEE", J)).toEqual({ ok: true, vers: "VALIDEE" });
  });
  it("on ne valide pas ce qui l'est deja, on ne refuse que ce qui est propose", () => {
    expect(verifierTransitionRelation("valider", "VALIDEE", J)).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
    for (const s of ["VALIDEE", "REFUSEE", "REVOQUEE"] as const) expect(verifierTransitionRelation("refuser", s, J)).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
  });
  it("toute transition exige une justification de 10 caracteres au moins (espaces ignores)", () => {
    expect(verifierTransitionRelation("valider", "PROPOSEE", "court")).toMatchObject({ ok: false, code: "JUSTIFICATION_REQUISE" });
    expect(verifierTransitionRelation("valider", "PROPOSEE", "          ")).toMatchObject({ ok: false, code: "JUSTIFICATION_REQUISE" });
    expect(verifierTransitionRelation("valider", "PROPOSEE", "1234567890")).toMatchObject({ ok: true });
  });
  it("actions offertes par statut", () => {
    expect(actionsPossibles("PROPOSEE")).toEqual(["valider", "refuser"]);
    expect(actionsPossibles("VALIDEE")).toEqual(["revoquer"]);
    expect(actionsPossibles("REFUSEE")).toEqual(["valider"]);
    expect(actionsPossibles("REVOQUEE")).toEqual(["valider"]);
  });
});

describe("tolerance de superposition liee a la classe de precision", () => {
  const t = TOLERANCES_DEFAUT_M;
  const e = (o: Partial<Parameters<typeof toleranceAssociation>[0]> = {}) => ({ classeCircuit: null, classeInfra: null, precisionCircuitM: null, precisionInfraM: null, table: t, ...o });

  it("prend le MAXIMUM des tolerances de classe de chaque objet : le moins precis commande", () => {
    expect(toleranceAssociation(e({ classeCircuit: "A", classeInfra: "C" })).toleranceM).toBe(t.C);
    expect(toleranceAssociation(e({ classeCircuit: "D", classeInfra: "A" })).toleranceM).toBe(t.D);
    expect(toleranceAssociation(e({ classeCircuit: "B", classeInfra: "B" })).toleranceM).toBe(t.B);
  });
  it("classe inconnue : tolerance dediee (provisoire), jamais celle d'une classe meilleure", () => {
    expect(toleranceAssociation(e()).toleranceM).toBe(t.INCONNUE);
    expect(toleranceAssociation(e({ classeCircuit: "A" })).toleranceM).toBe(t.INCONNUE); // l'autre objet est inconnu : il commande
  });
  it("une precision horizontale declaree plus grande que la tolerance de classe l'emporte ; elle n'est jamais ajoutee", () => {
    const r = toleranceAssociation(e({ classeCircuit: "A", classeInfra: "A", precisionCircuitM: 3, precisionInfraM: 0.2 }));
    expect(r.toleranceM).toBe(3);
    expect(r.methode).toBe("maximum");
    expect(r.toleranceM).not.toBe(3 + 0.2 + t.A);
    expect(r.composantes).toEqual({ classeCircuitM: t.A, classeInfraM: t.A, precisionCircuitM: 3, precisionInfraM: 0.2 });
  });
  it("la classe E est exclue de toute association automatique (pas de faux trace)", () => {
    expect(classeExclue("E")).toBe(true);
    expect(classeExclue("D")).toBe(false);
    expect(classeExclue(null)).toBe(false);
    expect(() => toleranceAssociation(e({ classeCircuit: "E" }))).toThrow(/classe E/);
    expect(() => toleranceAssociation(e({ classeInfra: "E" }))).toThrow(/classe E/);
  });
  it("les tolerances par defaut croissent de A a D (plus la donnee est approximative, plus la tolerance est large)", () => {
    expect(t.A).toBeLessThan(t.B);
    expect(t.B).toBeLessThan(t.C);
    expect(t.C).toBeLessThan(t.D);
  });
});

describe("decision de proposition par superposition", () => {
  it("couverture = part de la longueur du circuit dans la tolerance de l'infrastructure", () => {
    expect(couverture({ longueurCircuitM: 100, longueurDansToleranceM: 95 })).toBe(0.95);
    expect(couverture({ longueurCircuitM: 100, longueurDansToleranceM: 120 })).toBe(1);
    expect(couverture({ longueurCircuitM: 0, longueurDansToleranceM: 0 })).toBe(0);
  });
  it("propose a partir du seuil, jamais en dessous ; un circuit de longueur nulle n'est jamais propose", () => {
    expect(proposer({ longueurCircuitM: 100, longueurDansToleranceM: 90 }, COUVERTURE_MIN_DEFAUT)).toEqual({ propose: true, couverture: 0.9 });
    expect(proposer({ longueurCircuitM: 100, longueurDansToleranceM: 89.9 }, COUVERTURE_MIN_DEFAUT).propose).toBe(false);
    expect(proposer({ longueurCircuitM: 0, longueurDansToleranceM: 0 }, 0.5).propose).toBe(false);
  });
  it("retient au plus K propositions par circuit, les mieux couvertes, dans un ordre deterministe", () => {
    const c = [
      { circuitId: "2", infraId: "20", couverture: 0.95 }, { circuitId: "1", infraId: "11", couverture: 0.91 }, { circuitId: "1", infraId: "9", couverture: 0.99 },
      { circuitId: "1", infraId: "10", couverture: 0.99 }, { circuitId: "2", infraId: "21", couverture: 0.92 },
    ];
    const r = retenirPropositions(c, 2);
    expect(r.map((x) => `${x.circuitId}>${x.infraId}`)).toEqual(["1>9", "1>10", "2>20", "2>21"]);
    expect(retenirPropositions([...c].reverse(), 2)).toEqual(r);
    expect(retenirPropositions(c, 0)).toEqual([]);
  });
});

describe("nature de la cible d'un conflit : infrastructure physique ou simple circuit logique", () => {
  const e = (o: Partial<Parameters<typeof qualifierCible>[0]> = {}) => ({ nature: "INCONNUE" as const, origineNature: "INCONNUE" as const, nbSupportsValides: 0, nbSupportsProposes: 0, ...o });

  it("infrastructure physique", () => {
    expect(qualifierCible(e({ nature: "ACTIF_PHYSIQUE", origineNature: "OBJET" }))).toMatchObject({ qualification: "INFRASTRUCTURE_PHYSIQUE", supportPhysique: null });
  });
  it("circuit logique porte par une infrastructure validee : l'infrastructure est concernee", () => {
    const c = qualifierCible(e({ nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", nbSupportsValides: 2 }));
    expect(c).toMatchObject({ qualification: "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE", supportPhysique: { valides: 2, proposes: 0 } });
    expect(c.libelle).toMatch(/infrastructure physique qui est concernée/);
  });
  it("simple circuit logique : support non etabli, meme avec une proposition en attente", () => {
    const c = qualifierCible(e({ nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", nbSupportsProposes: 1 }));
    expect(c).toMatchObject({ qualification: "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", supportPhysique: { valides: 0, proposes: 1 } });
    expect(c.libelle).toMatch(/simple circuit logique/);
  });
  it("equipement, nature inconnue", () => {
    expect(qualifierCible(e({ nature: "EQUIPEMENT", origineNature: "OBJET" })).qualification).toBe("EQUIPEMENT");
    expect(qualifierCible(e()).qualification).toBe("NATURE_INCONNUE");
  });
});

describe("reglages : tolerances et bornes", () => {
  const sauve = { ...process.env };
  afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in sauve)) delete process.env[k]; Object.assign(process.env, sauve); });

  it("lit une table complete", () => {
    expect(lireTolerances("A=0.3,B=0.8, C = 1.5 ,D=4,INCONNUE=3")).toEqual({ A: 0.3, B: 0.8, C: 1.5, D: 4, INCONNUE: 3 });
  });
  it("toute irregularite redonne le defaut : cle manquante, inconnue, doublon, valeur hors bornes, forme illisible, classe E", () => {
    for (const brut of ["A=1,B=1,C=1,D=1", "A=1,B=1,C=1,D=1,INCONNUE=1,E=1", "A=1,A=2,B=1,C=1,D=1,INCONNUE=1", "A=0,B=1,C=1,D=1,INCONNUE=1", "A=1,B=1,C=1,D=1,INCONNUE=101", "A=-1,B=1,C=1,D=1,INCONNUE=1", "n'importe quoi", "A=1;B=1"]) {
      expect(lireTolerances(brut), brut).toEqual(TOLERANCES_DEFAUT_M);
    }
    expect(lireTolerances(undefined)).toEqual(TOLERANCES_DEFAUT_M);
    expect(lireTolerances("  ")).toEqual(TOLERANCES_DEFAUT_M);
  });
  it("les autres reglages ont des bornes et retombent sur le defaut hors bornes", () => {
    expect(couvertureMinAssociation()).toBe(COUVERTURE_MIN_DEFAUT);
    process.env.PROJETS_VOIRIE_ASSOC_COUVERTURE_MIN = "0.75";
    expect(couvertureMinAssociation()).toBe(0.75);
    for (const v of ["0.2", "1.5", "abc"]) { process.env.PROJETS_VOIRIE_ASSOC_COUVERTURE_MIN = v; expect(couvertureMinAssociation(), v).toBe(COUVERTURE_MIN_DEFAUT); }
    process.env.PROJETS_VOIRIE_ASSOC_PAR_CIRCUIT_MAX = "3";
    expect(propositionsParCircuitMax()).toBe(3);
    for (const v of ["0", "21", "2.5"]) { process.env.PROJETS_VOIRIE_ASSOC_PAR_CIRCUIT_MAX = v; expect(propositionsParCircuitMax(), v).toBe(5); }
    process.env.PROJETS_VOIRIE_ASSOC_CIRCUITS_MAX = "50";
    expect(circuitsParExecutionMax()).toBe(3_000);
    process.env.PROJETS_VOIRIE_ASSOC_TOLERANCES_M = "A=1,B=2,C=3,D=4,INCONNUE=5";
    expect(tolerancesAssociation().D).toBe(4);
  });
});
