import { describe, expect, it } from "vitest";
import {
  chargeBulletin, chargeFiche, chargePivotOuvrage, chargePivotPortion, chargePivotTroncon, trouverChampInterne,
  type SnapshotOuvrage, type SnapshotPortion, type SnapshotTroncon,
} from "./sources.noyau";
import { ChargePivot, verifierChargeContrat } from "./contrats";
import { FICHE_APPROUVEE, LIGNE_TRACE } from "./essais.support";

/**
 * Pas de fuite de champs internes. Chaque snapshot est charge de MARQUEURS dans les colonnes que
 * la charge ne doit jamais porter ; le test cherche ces marqueurs dans la charge emise.
 */
const INTERNE = "SECRET-INTERNE-NE-DOIT-PAS-SORTIR";

const troncon: SnapshotTroncon & Record<string, unknown> = {
  id: "t-1", code: "RN1-001", nom: "Conakry - Coyah", classe: "RN", longueurKm: 2.5, revetement: "BITUME", etat: "BON",
  regionNom: "Conakry", dateDerniereEvaluation: "2026-10-01", geometrie: LIGNE_TRACE,
  // Colonnes d'une ligne reelle qui ne doivent PAS sortir :
  observations: INTERNE, coutRehabEstime: 123456, creeParId: INTERNE, prefecture: INTERNE, sourceReference: INTERNE, deletedAt: null,
};

const ouvrage: SnapshotOuvrage & Record<string, unknown> = {
  id: "o-1", code: "RN1-PONT-12.4", nom: "Pont", type: "PONT", etat: "BON", pk: 12.4, tronconCode: "RN1-001",
  geometrie: { type: "Point", coordinates: [-13.6, 9.64] },
  remarques: INTERNE, travauxAPrevoir: INTERNE, photos: [INTERNE], materiauPiles: INTERNE,
};

const portion: SnapshotPortion & Record<string, unknown> = {
  id: "p-1", tronconId: "t-1", tronconCode: "RN1-001", debutM: 0, finM: 100, etat: "BON", revetement: "BITUME", praticabilite: null,
  valideDu: "2026-01-01", valideAu: null, observeeLe: null, geometrie: null,
  creeParId: INTERNE, clientOperationId: INTERNE, praticabiliteCause: INTERNE,
};

describe("aucun champ interne dans les charges", () => {
  it.each([
    ["troncon", chargePivotTroncon(troncon)],
    ["ouvrage", chargePivotOuvrage(ouvrage)],
    ["portion", chargePivotPortion(portion)],
  ])("pivot %s : aucun marqueur interne, aucune cle interdite", (_n, c) => {
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(JSON.stringify(c.charge)).not.toContain(INTERNE);
    expect(JSON.stringify(c.charge)).not.toContain("123456");
    expect(trouverChampInterne(c.charge)).toBeNull();
    expect(ChargePivot.safeParse(c.charge).success).toBe(true);
  });

  it("bulletin : ni l'auteur de la generation, ni les identifiants des publications, ni le gabarit", () => {
    const texte = "Bulletin";
    const c = chargeBulletin({ id: "b-1", numero: "BR-1", jour: "2026-10-24", texte, empreinteSha256: "x".repeat(64),
      ...({ genereParId: INTERNE, publicationsIds: [INTERNE], gabarit: INTERNE } as object) });
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(JSON.stringify(c.charge)).not.toContain(INTERNE);
      expect(Object.keys(c.charge).sort()).toEqual(["contenu", "empreinteSha256", "jour", "nomFichier", "numeroBulletin", "tailleOctets", "typeMime"]);
    }
  });

  it("fiche : seuls les champs du paragraphe 5.3, meme si la ligne source en porte d'autres", () => {
    const c = chargeFiche({ ...FICHE_APPROUVEE, ...({ creeParId: INTERNE, notesArbitrage: INTERNE } as object) });
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(JSON.stringify(c.charge)).not.toContain(INTERNE);
      expect(verifierChargeContrat("DIGITALROAD", c.charge).ok).toBe(true);
    }
  });

  it("le pivot ne porte AUCUNE des colonnes sensibles de la table des troncons", () => {
    const c = chargePivotTroncon(troncon);
    if (!c.ok) throw new Error(c.motif);
    const props = Object.keys(c.charge.features[0].properties);
    for (const interdit of ["observations", "cout_rehab_estime", "prefecture", "commune", "trafic", "source_reference", "created_by"]) {
      expect(props).not.toContain(interdit);
    }
  });
});

describe("rien n'est invente quand la source est incomplete", () => {
  it("un troncon sans trace n'est pas emis (le pivot exige une geometrie)", () => {
    const c = chargePivotTroncon({ ...troncon, geometrie: null });
    expect(c.ok).toBe(false);
  });

  it("un troncon dont la trace n'est pas une LineString n'est pas emis", () => {
    const c = chargePivotTroncon({ ...troncon, geometrie: { type: "MultiLineString", coordinates: [] } });
    expect(c.ok).toBe(false);
  });

  it("un ouvrage sans position Point n'est pas emis", () => {
    expect(chargePivotOuvrage({ ...ouvrage, geometrie: null }).ok).toBe(false);
  });

  it("une fiche qui n'est pas APPROUVE n'est pas emise", () => {
    for (const statut of ["BROUILLON", "PROPOSE", "ARBITRE", "TRANSMIS", "EN_EXECUTION"]) {
      expect(chargeFiche({ ...FICHE_APPROUVEE, statut }).ok).toBe(false);
    }
  });
});

describe("trouverChampInterne", () => {
  it.each([
    "password", "passwordHash", "motDePasse", "token", "jeton", "apiKey", "authorization", "email", "userId", "creeParId",
    "createdById", "genereParId", "constateParId", "ipAddress", "deletedAt", "clientOperationId", "observations", "remarques",
    "commentaire", "notesInternes", "coutRehabEstime", "travauxAPrevoir",
  ])("detecte la cle %s, a n'importe quelle profondeur", (cle) => {
    expect(trouverChampInterne({ a: { b: [{ [cle]: 1 }] } })).toBe(`$.a.b[0].${cle}`);
  });

  it("detecte les variantes avec tirets bas", () => {
    expect(trouverChampInterne({ cree_par_id: 1 })).not.toBeNull();
    expect(trouverChampInterne({ ip_address: 1 })).not.toBeNull();
  });

  it("ne regarde que les cles : une VALEUR qui ressemble a un mot interdit n'est pas une fuite", () => {
    expect(trouverChampInterne({ nom: "Route du mot de passe", justification: "token" })).toBeNull();
  });

  it("laisse passer les condensats de contenu (empreinte, sha256)", () => {
    expect(trouverChampInterne({ empreinteSha256: "a".repeat(64), empreinteCharge: "b" })).toBeNull();
  });

  it("ne declare aucune des cles du contrat comme interdite", () => {
    const c = chargePivotTroncon(troncon);
    if (!c.ok) throw new Error(c.motif);
    expect(trouverChampInterne(c.charge)).toBeNull();
    expect(trouverChampInterne(chargeFiche(FICHE_APPROUVEE))).toBeNull();
  });
});
