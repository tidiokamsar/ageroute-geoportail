import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccumulateurAnomalies,
  CATALOGUE_CODES,
  CODES_ANOMALIE,
  DOCUMENTATION_SEUILS,
  SEUILS_PROVISOIRES,
  classerDoublons,
  classerEtat,
  classerGeometrie,
  classerLongueur,
  classerPk,
  classerRegion,
  classerTroncon,
  construireSeuils,
  detecterChainesPk,
  type AnomalieDetectee,
  type CodeAnomalie,
  type LignePkChaine,
  type MesureRegion,
  type MesureTroncon,
  type PaireVoisine,
} from "./detecteurs.noyau";

/**
 * Detecteurs de qualite (noyau pur) : ce que ces tests defendent.
 *   - chaque code a un detecteur qui le declenche, ET un troncon sain qui ne declenche rien (faux positifs) ;
 *   - les seuils sont des parametres nommes et provisoires, jamais des verites ; la frontiere est testee des deux cotes ;
 *   - un detecteur est un signal : aucune correction proposee ne dit de supprimer ;
 *   - les comptes de l'agregateur sont exacts meme quand la liste des entites est plafonnee.
 */

const SEUILS = construireSeuils();
const MAINTENANT = new Date("2026-10-26T12:00:00Z");

describe("Le noyau ne depend de rien", () => {
  const src = readFileSync(join(__dirname, "detecteurs.noyau.ts"), "utf8");
  it("n'a aucun import", () => {
    expect([...src.matchAll(/^import /gm)]).toHaveLength(0);
  });
  it("ne lit ni l'horloge ni le systeme de fichiers ni la base", () => {
    expect(src).not.toMatch(/Date\.now\(|new Date\(|node:|@prisma|require\(|process\./);
  });
});

/** Un troncon sain : aucune regle ne doit le signaler. */
function sain(sur: Partial<MesureTroncon> = {}): MesureTroncon {
  return {
    id: "t-sain", code: "SAIN-1", regionId: 1, regionNom: "Boké",
    longueurKm: 10, pkDebut: 0, pkFin: 10, etat: "BON", dateDerniereEvaluation: new Date("2026-01-01T00:00:00Z"),
    geomPresente: true, geomVide: false, geomValide: true, raisonInvalide: null,
    geomType: "ST_LineString", geomSrid: 4326, longueurGeomM: 10_000,
    ...sur,
  };
}
const codes = (l: readonly AnomalieDetectee[]): CodeAnomalie[] => l.map((a) => a.code).sort();

describe("Un troncon sain n'est signale par aucun detecteur", () => {
  it("rien", () => {
    expect(classerTroncon(sain(), MAINTENANT, SEUILS)).toEqual([]);
  });
  it("un troncon dont PK debut > 0 est sain", () => {
    expect(classerPk(sain({ pkDebut: 12.5, pkFin: 20 }))).toEqual([]);
  });
  it("un troncon de longueur 0 en PK mais longueur reelle: seul 0/0 compte, pas 0/5", () => {
    expect(classerPk(sain({ pkDebut: 0, pkFin: 5 }))).toEqual([]);
  });
});

describe("(a) PK", () => {
  it("la sentinelle 0/0 est signalee, avec la longueur declaree pour la distinguer d'un troncon nul", () => {
    const [a] = classerPk(sain({ pkDebut: 0, pkFin: 0, longueurKm: 3.2 }));
    expect(a.code).toBe("PK_SENTINELLE_ZERO");
    expect(a.details).toMatchObject({ pkDebut: 0, pkFin: 0, longueurKm: 3.2 });
  });
  it("fin < debut", () => {
    const [a] = classerPk(sain({ pkDebut: 12, pkFin: 4 }));
    expect(a.code).toBe("PK_FIN_INFERIEUR_DEBUT");
    expect(a.gravite).toBe("BLOQUANTE");
    expect(a.details.ecartKm).toBe(8);
  });
  it("fin = debut non nul n'est pas fin < debut", () => {
    expect(classerPk(sain({ pkDebut: 4, pkFin: 4 }))).toEqual([]);
  });
  it("PK absent : null, NaN, infini", () => {
    for (const v of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codes(classerPk(sain({ pkDebut: v })))).toEqual(["PK_ABSENT"]);
      expect(codes(classerPk(sain({ pkFin: v })))).toEqual(["PK_ABSENT"]);
    }
  });
  it("PK negatif", () => {
    expect(codes(classerPk(sain({ pkDebut: -1, pkFin: 5 })))).toEqual(["PK_NEGATIF"]);
  });
  it("PK negatif ET fin < debut : les deux sont dits", () => {
    expect(codes(classerPk(sain({ pkDebut: 3, pkFin: -2 })))).toEqual(["PK_FIN_INFERIEUR_DEBUT", "PK_NEGATIF"]);
  });
});

function ligne(id: string, pkDebut: number, pkFin: number, sur: Partial<LignePkChaine> = {}): LignePkChaine {
  return { id, code: `C-${id}`, regionId: 1, nom: "RN1", sectionPk: "3", pkDebut, pkFin, ...sur };
}

describe("(a) chainage des PK", () => {
  it("une chaine qui s'enchaine n'est pas signalee", () => {
    expect(detecterChainesPk([ligne("a", 0, 10), ligne("b", 10, 25), ligne("c", 25, 30)], SEUILS)).toEqual([]);
  });
  it("chevauchement au-dessus du seuil : porte par le troncon qui commence dedans", () => {
    const r = detecterChainesPk([ligne("a", 0, 10), ligne("b", 8, 20)], SEUILS);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: "PK_CHEVAUCHEMENT", entiteId: "b" });
    expect(r[0].details).toMatchObject({ partenaireId: "a", chevauchementKm: 2 });
    expect(r[0].seuil).toMatchObject({ nom: "PK_CHEVAUCHEMENT_KM", valeur: SEUILS_PROVISOIRES.PK_CHEVAUCHEMENT_KM, statut: "PROVISOIRE" });
  });
  it("frontiere du seuil de chevauchement : egal n'est pas signale, au-dessus l'est", () => {
    const s = SEUILS.PK_CHEVAUCHEMENT_KM;
    expect(detecterChainesPk([ligne("a", 0, 10), ligne("b", 10 - s, 20)], SEUILS)).toEqual([]);
    expect(codes(detecterChainesPk([ligne("a", 0, 10), ligne("b", 10 - s - 0.01, 20)], SEUILS))).toEqual(["PK_CHEVAUCHEMENT"]);
  });
  it("trou au-dessus du seuil", () => {
    const r = detecterChainesPk([ligne("a", 0, 10), ligne("b", 12, 20)], SEUILS);
    expect(r[0]).toMatchObject({ code: "PK_TROU", entiteId: "b" });
    expect(r[0].details.trouKm).toBe(2);
  });
  it("frontiere du seuil de trou", () => {
    const s = SEUILS.PK_TROU_KM;
    expect(detecterChainesPk([ligne("a", 0, 10), ligne("b", 10 + s, 20)], SEUILS)).toEqual([]);
    expect(codes(detecterChainesPk([ligne("a", 0, 10), ligne("b", 10 + s + 0.01, 20)], SEUILS))).toEqual(["PK_TROU"]);
  });
  it("un troncon inclus dans un autre est un chevauchement, et le suivant se compare a la fin la plus grande", () => {
    const r = detecterChainesPk([ligne("a", 0, 20), ligne("b", 5, 8), ligne("c", 20, 30)], SEUILS);
    expect(r.map((x) => `${x.code}:${x.entiteId}`)).toEqual(["PK_CHEVAUCHEMENT:b"]);
  });
  it("deux sections differentes d'une meme route ne se chainent pas (les PK repartent de zero)", () => {
    expect(detecterChainesPk([ligne("a", 0, 10, { sectionPk: "1" }), ligne("b", 0, 10, { sectionPk: "2" })], SEUILS)).toEqual([]);
  });
  it("deux routes differentes de meme section ne se chainent pas", () => {
    expect(detecterChainesPk([ligne("a", 0, 10, { nom: "RN1" }), ligne("b", 0, 10, { nom: "RN2" })], SEUILS)).toEqual([]);
  });
  it("les PK deja signales isolement (0/0, absent, negatif, fin < debut) sont ecartes du chainage", () => {
    const l = [ligne("a", 0, 10), ligne("s", 0, 0), ligne("n", Number.NaN, 4), ligne("neg", -3, 2), ligne("inv", 9, 1), ligne("b", 10, 20)];
    expect(detecterChainesPk(l, SEUILS)).toEqual([]);
  });
  it("l'ordre d'entree ne change pas le resultat", () => {
    const l = [ligne("c", 30, 40), ligne("a", 0, 10), ligne("b", 8, 20)];
    expect(detecterChainesPk(l, SEUILS)).toEqual(detecterChainesPk([...l].reverse(), SEUILS));
  });
});

describe("(b) longueur", () => {
  it("longueur declaree nulle, negative ou non finie", () => {
    for (const v of [0, -2, Number.NaN, null]) {
      expect(codes(classerLongueur(sain({ longueurKm: v }), SEUILS))).toEqual(["LONGUEUR_NON_POSITIVE"]);
    }
  });
  it("ecart relatif au-dessus du seuil", () => {
    const [a] = classerLongueur(sain({ longueurKm: 15, longueurGeomM: 10_000 }), SEUILS);
    expect(a.code).toBe("LONGUEUR_ECART_GEOMETRIE");
    expect(a.details).toMatchObject({ longueurDeclareeKm: 15, longueurGeometriqueKm: 10, ecartAbsoluKm: 5, ecartRelatif: 0.5 });
    expect(a.seuil).toMatchObject({ nom: "LONGUEUR_ECART_RELATIF", statut: "PROVISOIRE" });
  });
  it("frontiere du seuil relatif : egal n'est pas signale", () => {
    expect(classerLongueur(sain({ longueurKm: 11, longueurGeomM: 10_000 }), SEUILS)).toEqual([]);
    expect(codes(classerLongueur(sain({ longueurKm: 11.01, longueurGeomM: 10_000 }), SEUILS))).toEqual(["LONGUEUR_ECART_GEOMETRIE"]);
  });
  it("un petit troncon au fort ecart relatif mais faible ecart absolu n'est pas signale", () => {
    // 30 m declares contre 40 m mesures : 25 %, mais 10 m, sous le minimum absolu.
    expect(classerLongueur(sain({ longueurKm: 0.03, longueurGeomM: 40 }), SEUILS)).toEqual([]);
  });
  it("ecart en defaut (declaree trop courte) est signale aussi", () => {
    expect(codes(classerLongueur(sain({ longueurKm: 5, longueurGeomM: 10_000 }), SEUILS))).toEqual(["LONGUEUR_ECART_GEOMETRIE"]);
  });
  it("sans longueur geometrique exploitable, rien a comparer", () => {
    expect(classerLongueur(sain({ longueurGeomM: null }), SEUILS)).toEqual([]);
    expect(classerLongueur(sain({ longueurGeomM: 0 }), SEUILS)).toEqual([]);
  });
  it("une longueur declaree non positive n'ajoute pas d'ecart", () => {
    expect(codes(classerLongueur(sain({ longueurKm: 0, longueurGeomM: 10_000 }), SEUILS))).toEqual(["LONGUEUR_NON_POSITIVE"]);
  });
  it("un seuil plus strict change le verdict, et le seuil applique le dit", () => {
    const strict = construireSeuils({ LONGUEUR_ECART_RELATIF: 0.01 });
    const [a] = classerLongueur(sain({ longueurKm: 10.5, longueurGeomM: 10_000 }), strict);
    expect(a.seuil?.valeur).toBe(0.01);
    expect(classerLongueur(sain({ longueurKm: 10.5, longueurGeomM: 10_000 }), SEUILS)).toEqual([]);
  });
});

describe("(c) geometrie", () => {
  it("absente", () => {
    expect(codes(classerGeometrie(sain({ geomPresente: false, geomVide: null, geomValide: null, geomType: null, geomSrid: null, longueurGeomM: null }), SEUILS))).toEqual(["GEOM_ABSENTE"]);
  });
  it("vide : seul GEOM_VIDE est dit", () => {
    expect(codes(classerGeometrie(sain({ geomVide: true, geomValide: null, longueurGeomM: null }), SEUILS))).toEqual(["GEOM_VIDE"]);
  });
  it("invalide, avec la raison de PostGIS", () => {
    const [a] = classerGeometrie(sain({ geomValide: false, raisonInvalide: "Self-intersection[1 1]" }), SEUILS);
    expect(a).toMatchObject({ code: "GEOM_INVALIDE", gravite: "BLOQUANTE" });
    expect(a.details.raison).toBe("Self-intersection[1 1]");
  });
  it("non lineaire et SRID inattendu", () => {
    expect(codes(classerGeometrie(sain({ geomType: "ST_Point" }), SEUILS))).toEqual(["GEOM_NON_LINEAIRE"]);
    expect(codes(classerGeometrie(sain({ geomSrid: 3857 }), SEUILS))).toEqual(["GEOM_SRID_INATTENDU"]);
  });
  it("longueur geometrique nulle, et frontiere du seuil", () => {
    expect(codes(classerGeometrie(sain({ longueurGeomM: 0 }), SEUILS))).toEqual(["GEOM_LONGUEUR_NULLE"]);
    expect(classerGeometrie(sain({ longueurGeomM: SEUILS.LONGUEUR_GEOMETRIQUE_NULLE_M }), SEUILS)).toEqual([]);
  });
  it("un trace invalide de longueur nulle (deux points identiques) donne les deux codes", () => {
    expect(codes(classerGeometrie(sain({ geomValide: false, raisonInvalide: "Too few points", longueurGeomM: 0 }), SEUILS))).toEqual(["GEOM_INVALIDE", "GEOM_LONGUEUR_NULLE"]);
  });
});

describe("(f) etat declare", () => {
  it("un etat constate et date est sain", () => {
    expect(classerEtat(sain(), MAINTENANT, SEUILS)).toEqual([]);
  });
  it("NON_EVALUE seul : signale, sans date", () => {
    expect(codes(classerEtat(sain({ etat: "NON_EVALUE", dateDerniereEvaluation: null }), MAINTENANT, SEUILS))).toEqual(["ETAT_NON_EVALUE"]);
  });
  it("NON_EVALUE avec une date : l'un des deux est faux", () => {
    expect(codes(classerEtat(sain({ etat: "NON_EVALUE" }), MAINTENANT, SEUILS))).toEqual(["ETAT_DATE_SANS_ETAT", "ETAT_NON_EVALUE"]);
  });
  it("etat declare sans date d'evaluation", () => {
    expect(codes(classerEtat(sain({ dateDerniereEvaluation: null }), MAINTENANT, SEUILS))).toEqual(["ETAT_SANS_DATE_EVALUATION"]);
  });
  it("absent et inconnu", () => {
    expect(codes(classerEtat(sain({ etat: null }), MAINTENANT, SEUILS))).toEqual(["ETAT_ABSENT"]);
    expect(codes(classerEtat(sain({ etat: "  " }), MAINTENANT, SEUILS))).toEqual(["ETAT_ABSENT"]);
    expect(codes(classerEtat(sain({ etat: "EXCELLENT" }), MAINTENANT, SEUILS))).toEqual(["ETAT_INCONNU"]);
  });
  it("date future : la tolerance d'un jour est respectee des deux cotes", () => {
    const lendemain = new Date(MAINTENANT.getTime() + 86_400_000 - 1000);
    const dansDeuxJours = new Date(MAINTENANT.getTime() + 2 * 86_400_000);
    expect(classerEtat(sain({ dateDerniereEvaluation: lendemain }), MAINTENANT, SEUILS)).toEqual([]);
    expect(codes(classerEtat(sain({ dateDerniereEvaluation: dansDeuxJours }), MAINTENANT, SEUILS))).toEqual(["ETAT_DATE_FUTURE"]);
  });
  it("l'horloge est un parametre : la meme date est future a une date et pas a une autre", () => {
    const d = new Date("2026-12-01T00:00:00Z");
    expect(codes(classerEtat(sain({ dateDerniereEvaluation: d }), MAINTENANT, SEUILS))).toEqual(["ETAT_DATE_FUTURE"]);
    expect(classerEtat(sain({ dateDerniereEvaluation: d }), new Date("2026-12-02T00:00:00Z"), SEUILS)).toEqual([]);
  });
});

function region(parts: MesureRegion["parts"], sur: Partial<MesureRegion> = {}): MesureRegion {
  return {
    id: "r-1", code: "R-1", regionId: 1, regionNom: "Boké", regionCle: "boke",
    regionNonRenseignee: false, regionALimite: true, perimetre: "NATIONAL", parts, ...sur,
  };
}
const part = (cle: string, p: number, nom = cle) => ({ cle, nom, part: p });

describe("(d) region discordante et hors territoire", () => {
  it("un troncon dans sa region n'est pas signale", () => {
    expect(classerRegion(region([part("boke", 1)]), SEUILS)).toEqual([]);
  });
  it("entierement dans une autre region : discordant, nettement", () => {
    const [a] = classerRegion(region([part("kindia", 1, "Kindia")]), SEUILS);
    expect(a).toMatchObject({ code: "REGION_DISCORDANTE", gravite: "A_TRAITER" });
    expect(a.details).toMatchObject({ regionDeclaree: "Boké", regionDominante: "Kindia", partDansRegionDeclaree: 0, entierementAilleurs: true });
  });
  it("majoritairement ailleurs mais avec une part dans la region declaree : a cheval, moins grave", () => {
    const [a] = classerRegion(region([part("kindia", 0.6), part("boke", 0.4)]), SEUILS);
    expect(a).toMatchObject({ code: "REGION_DISCORDANTE", gravite: "A_SURVEILLER" });
    expect(a.details.entierementAilleurs).toBe(false);
  });
  it("sans majorite nette (45/45/10) : non signale", () => {
    expect(classerRegion(region([part("kindia", 0.45), part("boke", 0.45), part("labe", 0.1)]), SEUILS)).toEqual([]);
  });
  it("region declaree dominante : non signale meme si une autre est touchee", () => {
    expect(classerRegion(region([part("boke", 0.7), part("kindia", 0.3)]), SEUILS)).toEqual([]);
  });
  it("hors de tout le territoire", () => {
    const [a] = classerRegion(region([]), SEUILS);
    expect(a).toMatchObject({ code: "HORS_TERRITOIRE", gravite: "A_TRAITER" });
  });
  it("hors territoire deja documente (perimetre HORS_TERRITOIRE_NATIONAL) : signale mais a surveiller", () => {
    const [a] = classerRegion(region([], { perimetre: "HORS_TERRITOIRE_NATIONAL" }), SEUILS);
    expect(a).toMatchObject({ code: "HORS_TERRITOIRE", gravite: "A_SURVEILLER" });
    expect(a.details.statutDejaDocumente).toBe(true);
  });
  it("region « Non renseigne » alors que le trace tombe dans une region", () => {
    const [a] = classerRegion(region([part("kindia", 1, "Kindia")], { regionNom: "Non renseigné", regionCle: "non renseigne", regionNonRenseignee: true, regionALimite: false }), SEUILS);
    expect(a.code).toBe("REGION_NON_RENSEIGNEE");
    expect(a.details.regionDominante).toBe("Kindia");
  });
  it("region sans limite de meme nom : non verifiable, jamais discordante", () => {
    const [a] = classerRegion(region([part("kindia", 1)], { regionALimite: false }), SEUILS);
    expect(a.code).toBe("REGION_NON_VERIFIABLE");
    expect(a.gravite).toBe("A_SURVEILLER");
  });
  it("le seuil de majorite est un parametre", () => {
    const bas = construireSeuils({ REGION_MAJORITE: 0.3 });
    expect(codes(classerRegion(region([part("kindia", 0.45), part("boke", 0.45), part("labe", 0.1)]), bas))).toEqual([]);
    expect(codes(classerRegion(region([part("kindia", 0.45), part("boke", 0.3), part("labe", 0.25)]), bas))).toEqual(["REGION_DISCORDANTE"]);
  });
  it("une part non finie est ignoree plutot que de compter pour zero", () => {
    expect(codes(classerRegion(region([{ cle: "kindia", nom: "Kindia", part: Number.NaN }]), SEUILS))).toEqual(["HORS_TERRITOIRE"]);
  });
});

function paire(id: string, partenaire: string, sur: Partial<PaireVoisine> = {}): PaireVoisine {
  return {
    id, code: `C-${id}`, regionId: 1, partenaireId: partenaire, partenaireCode: `C-${partenaire}`,
    partenaireRegionId: 1, partenaireSourceReference: null,
    binaireIdentique: false, inverseIdentique: false, hausdorffDeg: 1, ...sur,
  };
}

describe("(e) doublons de geometrie", () => {
  it("aucune paire proche : rien", () => {
    expect(classerDoublons([paire("a", "b")], SEUILS)).toEqual([]);
  });
  it("binaire identique : strict, gravite bloquante", () => {
    const [a] = classerDoublons([paire("a", "b", { binaireIdentique: true, hausdorffDeg: null })], SEUILS);
    expect(a).toMatchObject({ code: "DOUBLON_GEOMETRIE_STRICT", gravite: "BLOQUANTE", entiteId: "a" });
    expect(a.details).toMatchObject({ partenaires: ["b"], sensInverse: false, distanceHausdorffDeg: 0 });
  });
  it("identique au sens inverse : strict, avec sensInverse", () => {
    const [a] = classerDoublons([paire("a", "b", { inverseIdentique: true, hausdorffDeg: 0 })], SEUILS);
    expect(a.code).toBe("DOUBLON_GEOMETRIE_STRICT");
    expect(a.details.sensInverse).toBe(true);
  });
  it("quasi : Hausdorff sous le seuil ; la frontiere est testee", () => {
    const s = SEUILS.DOUBLON_QUASI_TOLERANCE_DEG;
    expect(codes(classerDoublons([paire("a", "b", { hausdorffDeg: s })], SEUILS))).toEqual(["DOUBLON_GEOMETRIE_QUASI"]);
    expect(classerDoublons([paire("a", "b", { hausdorffDeg: s * 1.01 })], SEUILS)).toEqual([]);
  });
  it("le seuil du quasi-doublon est rendu sur l'anomalie", () => {
    const [a] = classerDoublons([paire("a", "b", { hausdorffDeg: 0 })], SEUILS);
    expect(a.seuil).toMatchObject({ nom: "DOUBLON_QUASI_TOLERANCE_DEG", statut: "PROVISOIRE" });
  });
  it("un jumeau strict et un quasi : une seule anomalie stricte qui cite les deux", () => {
    const r = classerDoublons([
      paire("a", "b", { binaireIdentique: true, hausdorffDeg: null }),
      paire("a", "c", { hausdorffDeg: 0 }),
    ], SEUILS);
    expect(r).toHaveLength(1);
    expect(r[0].code).toBe("DOUBLON_GEOMETRIE_STRICT");
    expect(r[0].details.partenaires).toEqual(["b", "c"]);
  });
  it("une paire dont les deux membres sont examines donne une anomalie par entite", () => {
    const r = classerDoublons([
      paire("a", "b", { binaireIdentique: true, hausdorffDeg: null }),
      paire("b", "a", { binaireIdentique: true, hausdorffDeg: null }),
    ], SEUILS);
    expect(r.map((x) => x.entiteId).sort()).toEqual(["a", "b"]);
  });
  it("le partenaire hors region et sa reference de source sont rendus (le jumeau voirie locale est un fait connu)", () => {
    const [a] = classerDoublons([paire("a", "b", { binaireIdentique: true, hausdorffDeg: null, partenaireRegionId: 7, partenaireSourceReference: "voirie_locale:osm:1" })], SEUILS);
    expect(a.details.partenairesRegions).toEqual([7]);
    expect(a.details.partenairesSourceReference).toEqual(["voirie_locale:osm:1"]);
  });
});

function anom(code: CodeAnomalie, id: string, regionId: number | null, mesure: number | null = null): AnomalieDetectee {
  return { code, gravite: CATALOGUE_CODES[code].gravite, entiteType: "Troncon", entiteId: id, entiteCode: id, regionId, details: {}, seuil: null, mesure };
}

describe("Agregation : comptes par code et par region", () => {
  it("le compte est EXACT au-dela du plafond de la liste", () => {
    const acc = new AccumulateurAnomalies(3);
    for (let i = 0; i < 25; i++) acc.ajouter(anom("PK_SENTINELLE_ZERO", `t${String(i).padStart(2, "0")}`, 1));
    const r = acc.resultat();
    const c = r.parCode.find((x) => x.code === "PK_SENTINELLE_ZERO")!;
    expect(c.nombre).toBe(25);
    expect(c.entites).toHaveLength(3);
    expect(c.tronque).toBe(true);
    expect(r.total).toBe(25);
  });
  it("la liste garde les plus grosses mesures, puis l'identifiant, de facon deterministe", () => {
    const entree = [anom("LONGUEUR_ECART_GEOMETRIE", "b", 1, 0.5), anom("LONGUEUR_ECART_GEOMETRIE", "a", 1, 0.5), anom("LONGUEUR_ECART_GEOMETRIE", "c", 1, 2), anom("LONGUEUR_ECART_GEOMETRIE", "d", 1, 0.1)];
    const a1 = new AccumulateurAnomalies(2); a1.ajouterTout(entree);
    const a2 = new AccumulateurAnomalies(2); a2.ajouterTout([...entree].reverse());
    expect(a1.resultat().parCode[0].entites.map((e) => e.entiteId)).toEqual(["c", "a"]);
    expect(a2.resultat().parCode[0].entites.map((e) => e.entiteId)).toEqual(["c", "a"]);
  });
  it("sans plafonnement, tout est liste et rien n'est tronque", () => {
    const acc = new AccumulateurAnomalies(10);
    acc.ajouterTout([anom("GEOM_INVALIDE", "x", 2), anom("GEOM_INVALIDE", "y", 2)]);
    const c = acc.resultat().parCode[0];
    expect(c.entites).toHaveLength(2);
    expect(c.tronque).toBe(false);
  });
  it("compte par region, y compris sans region", () => {
    const acc = new AccumulateurAnomalies(5);
    acc.ajouterTout([anom("GEOM_INVALIDE", "x", 2), anom("PK_SENTINELLE_ZERO", "y", 2), anom("PK_SENTINELLE_ZERO", "z", null), anom("PK_SENTINELLE_ZERO", "w", 1)]);
    const r = acc.resultat();
    expect(r.parRegion).toEqual([
      { regionId: 1, total: 1, parCode: { PK_SENTINELLE_ZERO: 1 } },
      { regionId: 2, total: 2, parCode: { GEOM_INVALIDE: 1, PK_SENTINELLE_ZERO: 1 } },
      { regionId: null, total: 1, parCode: { PK_SENTINELLE_ZERO: 1 } },
    ]);
  });
  it("les codes bloquants passent avant les codes frequents", () => {
    const acc = new AccumulateurAnomalies(2);
    for (let i = 0; i < 100; i++) acc.ajouter(anom("ETAT_NON_EVALUE", `e${i}`, 1));
    acc.ajouter(anom("GEOM_INVALIDE", "g", 1));
    expect(acc.resultat().parCode[0].code).toBe("GEOM_INVALIDE");
  });
  it("un plafond de 0 garde les comptes et aucune entite", () => {
    const acc = new AccumulateurAnomalies(0);
    acc.ajouter(anom("GEOM_INVALIDE", "x", 1));
    const c = acc.resultat().parCode[0];
    expect(c.nombre).toBe(1);
    expect(c.entites).toEqual([]);
    expect(c.tronque).toBe(true);
  });
  it("un plafond invalide est refuse", () => {
    expect(() => new AccumulateurAnomalies(-1)).toThrow();
    expect(() => new AccumulateurAnomalies(1.5)).toThrow();
  });
  it("la gravite d'un code nuance est la plus elevee rencontree", () => {
    const acc = new AccumulateurAnomalies(5);
    acc.ajouter({ ...anom("HORS_TERRITOIRE", "a", 1), gravite: "A_SURVEILLER" });
    acc.ajouter({ ...anom("HORS_TERRITOIRE", "b", 1), gravite: "A_TRAITER" });
    expect(acc.resultat().parCode[0].gravite).toBe("A_TRAITER");
  });
});

describe("Seuils provisoires", () => {
  it("chaque seuil est documente et declare PROVISOIRE", () => {
    for (const nom of Object.keys(SEUILS_PROVISOIRES) as (keyof typeof SEUILS_PROVISOIRES)[]) {
      expect(DOCUMENTATION_SEUILS[nom].statut).toBe("PROVISOIRE");
      expect(DOCUMENTATION_SEUILS[nom].origine.length).toBeGreaterThan(20);
      expect(DOCUMENTATION_SEUILS[nom].unite).toBeTruthy();
    }
    expect(Object.keys(DOCUMENTATION_SEUILS).sort()).toEqual(Object.keys(SEUILS_PROVISOIRES).sort());
  });
  it("construireSeuils surcharge et refuse l'invalide", () => {
    expect(construireSeuils({ PK_TROU_KM: 2 }).PK_TROU_KM).toBe(2);
    expect(construireSeuils().PK_TROU_KM).toBe(SEUILS_PROVISOIRES.PK_TROU_KM);
    expect(() => construireSeuils({ PK_TROU_KM: -1 })).toThrow(/invalide/);
    expect(() => construireSeuils({ PK_TROU_KM: Number.NaN })).toThrow(/invalide/);
    expect(() => construireSeuils({ INCONNU: 1 } as never)).toThrow(/inconnu/);
  });
});

describe("Catalogue : un signal, jamais une action", () => {
  it("chaque code a une description et une correction proposee, et aucune ne commence par supprimer", () => {
    for (const code of CODES_ANOMALIE) {
      const d = CATALOGUE_CODES[code];
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.correctionProposee.length).toBeGreaterThan(10);
      expect(d.correctionProposee.toLowerCase()).not.toMatch(/^supprimer/);
    }
    expect(Object.keys(CATALOGUE_CODES).sort()).toEqual([...CODES_ANOMALIE].sort());
  });
  it("les codes sont uniques et en majuscules", () => {
    expect(new Set(CODES_ANOMALIE).size).toBe(CODES_ANOMALIE.length);
    for (const c of CODES_ANOMALIE) expect(c).toMatch(/^[A-Z][A-Z_]+$/);
  });
  it("les six familles attendues sont couvertes", () => {
    const familles = new Set(CODES_ANOMALIE.map((c) => CATALOGUE_CODES[c].famille));
    expect([...familles].sort()).toEqual(["DOUBLON", "ETAT", "GEOMETRIE", "LONGUEUR", "PK", "REGION"]);
  });
});
