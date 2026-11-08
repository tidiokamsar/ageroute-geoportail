import { describe, expect, it } from "vitest";
import { etapeVoisine, etatInitial, reduire, retourPossible, type EtatAssistant } from "./projetsVoirieImportEtat";
import { lireApercu, lireDeltaDetail, lireInventaire } from "./projetsVoirieImport";
import { lireReponseDepot } from "./projetsVoirieApi";
import { apercu, deltaDetail, inventaireCsv, reponseDepot } from "../components/projets-voirie/assistant/assistantImport.testutil";

/** Etat de l'assistant : en memoire seulement, invalidation des resultats, gel apres le depot. */

const fichier = new File(["x"], "a.csv");
const inv = lireInventaire(inventaireCsv());
const ap = lireApercu(apercu());
const sim = lireReponseDepot(reponseDepot());
const dep = lireReponseDepot(reponseDepot({}, false));

function pret(): EtatAssistant {
  let s = etatInitial();
  s = reduire(s, { type: "FICHIER", fichier });
  s = reduire(s, { type: "INVENTAIRE", inventaire: inv });
  s = reduire(s, { type: "LECTURE", patch: { epsgSource: "32629" } });
  s = reduire(s, { type: "APERCU", apercu: ap });
  s = reduire(s, { type: "SIMULATION", simulation: sim });
  return s;
}

describe("etat initial et navigation", () => {
  it("sept etapes, depot d'abord ; reprise : comparaison puis approbation", () => {
    expect(etatInitial().etapes).toEqual(["depot", "format", "crs", "mapping", "controles", "delta", "approbation"]);
    expect(etatInitial().etape).toBe("depot");
    expect(etatInitial(true).etapes).toEqual(["delta", "approbation"]);
    expect(etatInitial(true).etape).toBe("delta");
  });
  it("une etape hors liste est refusee", () => {
    expect(reduire(etatInitial(true), { type: "ALLER", etape: "crs" }).etape).toBe("delta");
    expect(reduire(etatInitial(), { type: "ALLER", etape: "crs" }).etape).toBe("crs");
  });
  it("etapeVoisine aux extremites", () => {
    expect(etapeVoisine(etatInitial(), -1)).toBeNull();
    expect(etapeVoisine({ ...etatInitial(), etape: "approbation" }, 1)).toBeNull();
    expect(etapeVoisine(etatInitial(), 1)).toBe("format");
  });
});

describe("invalidation : un resultat ne vaut que pour les options qui l'ont produit", () => {
  it("changer le fichier repart de zero (lecture, inventaire, apercu, simulation)", () => {
    const s = reduire(pret(), { type: "FICHIER", fichier: new File(["y"], "b.csv") });
    expect(s.inventaire).toBeNull(); expect(s.apercu).toBeNull(); expect(s.simulation).toBeNull();
    expect(s.lecture.epsgSource).toBe("");
    expect(s.saisie.fichier?.name).toBe("b.csv");
  });
  it("changer le CRS efface l'apercu, la simulation ET la confirmation hors zone", () => {
    let s = reduire(pret(), { type: "LECTURE", patch: { confirmerHorsZone: true } });
    expect(s.lecture.confirmerHorsZone).toBe(true);
    s = reduire(s, { type: "LECTURE", patch: { epsgSource: "32628" } });
    expect(s.apercu).toBeNull(); expect(s.simulation).toBeNull(); expect(s.lecture.confirmerHorsZone).toBe(false);
  });
  it("confirmer sans changer de CRS conserve la confirmation", () => {
    const s = reduire(pret(), { type: "LECTURE", patch: { confirmerHorsZone: true } });
    expect(s.lecture.confirmerHorsZone).toBe(true);
    expect(s.apercu).toBeNull();
  });
  it("changer de couche vide la correspondance de champs ; changer le mapping efface l'apercu", () => {
    let s = reduire(pret(), { type: "MAPPING", champ: "nom", colonne: "axe" });
    expect(s.lecture.mapping).toEqual({ nom: "axe" });
    expect(s.apercu).toBeNull();
    s = reduire(s, { type: "LECTURE", patch: { couche: "c1" } });
    expect(s.lecture.mapping).toEqual({});
    s = reduire(s, { type: "MAPPING", champ: "nom", colonne: "axe" });
    s = reduire(s, { type: "MAPPING", champ: "nom", colonne: "" });
    expect(s.lecture.mapping).toEqual({});
  });
  it("changer une option CSV efface les resultats, la correspondance et la confirmation", () => {
    let s = reduire(pret(), { type: "MAPPING", champ: "nom", colonne: "axe" });
    s = reduire(s, { type: "LECTURE", patch: { confirmerHorsZone: true } });
    s = reduire(s, { type: "LECTURE_CSV", patch: { delimiteur: ";" } });
    expect(s.lecture.csv.delimiteur).toBe(";");
    expect(s.lecture.mapping).toEqual({}); expect(s.lecture.confirmerHorsZone).toBe(false); expect(s.apercu).toBeNull();
  });
  it("changer une metadonnee du jeu efface la simulation, pas l'apercu", () => {
    const s = reduire(pret(), { type: "SAISIE", patch: { role: "AXES_TRAVAUX" } });
    expect(s.simulation).toBeNull();
    expect(s.apercu).not.toBeNull();
  });
  it("un nouvel inventaire efface l'apercu et la simulation", () => {
    const s = reduire(pret(), { type: "INVENTAIRE", inventaire: inv });
    expect(s.apercu).toBeNull(); expect(s.simulation).toBeNull();
  });
  it("hors zone : l'apercu est efface, le blocage est conserve avec son compte", () => {
    const s = reduire(pret(), { type: "HORS_ZONE", nbElements: 4, nbObjets: 10 });
    expect(s.apercu).toBeNull();
    expect(s.horsZone).toEqual({ nbElements: 4, nbObjets: 10 });
    expect(reduire(s, { type: "APERCU", apercu: ap }).horsZone).toBeNull();
  });
});

describe("apres le depot, plus rien en amont ne bouge", () => {
  const depose = () => reduire(pret(), { type: "DEPOT", depot: dep });
  it("fichier, saisie, lecture, mapping : ignores", () => {
    const s = depose();
    expect(reduire(s, { type: "FICHIER", fichier: null })).toBe(s);
    expect(reduire(s, { type: "SAISIE", patch: { role: "AUTRE" } })).toBe(s);
    expect(reduire(s, { type: "LECTURE", patch: { epsgSource: "32628" } })).toBe(s);
    expect(reduire(s, { type: "LECTURE_CSV", patch: { delimiteur: "," } })).toBe(s);
    expect(reduire(s, { type: "MAPPING", champ: "nom", colonne: "x" })).toBe(s);
  });
  it("retour possible : avant le depot oui ; apres, seulement de l'approbation vers la comparaison et tant qu'aucune decision n'est prise", () => {
    expect(retourPossible({ ...pret(), etape: "crs" })).toBe(true);
    expect(retourPossible(etatInitial())).toBe(false);
    const d = depose();
    expect(retourPossible({ ...d, etape: "delta" })).toBe(false);
    expect(retourPossible({ ...d, etape: "approbation" })).toBe(true);
    expect(retourPossible({ ...d, etape: "approbation", issue: "AUTORISE" })).toBe(false);
    expect(retourPossible({ ...etatInitial(true), etape: "approbation" })).toBe(true);
    expect(retourPossible(etatInitial(true))).toBe(false);
  });
  it("delta, issue et retour arriere s'enregistrent", () => {
    let s = depose();
    s = reduire(s, { type: "DELTA", delta: lireDeltaDetail(deltaDetail()) });
    s = reduire(s, { type: "ISSUE", issue: "AUTORISE" });
    s = reduire(s, { type: "RETOUR", version: 2 });
    expect(s.delta?.jeu.version).toBe(3); expect(s.issue).toBe("AUTORISE"); expect(s.retour).toEqual({ version: 2 });
  });
});
