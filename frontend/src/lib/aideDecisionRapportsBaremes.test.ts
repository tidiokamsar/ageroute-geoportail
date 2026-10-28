import { describe, expect, it } from "vitest";
import {
  construireApprobation, construireModification, consequenceModification, libelleEvenement, lignesChangement, messageActionRefusee,
  raisonApprobationImpossible, saisieDepuis, type BaremeLigne, type EvenementBareme,
} from "./aideDecisionRapportsBaremes";

const ligne = (o: Partial<BaremeLigne> = {}): BaremeLigne => ({
  id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: "3500000000", uniteCout: "KM", devise: "GNF",
  code: null, libelle: "Reconstruction bitume", source: "standard_initial", version: 1, approuveLe: null, approuvePar: null,
  anneeReference: null, largeurChausseeM: null, validDe: null, validA: null, commentaire: null, ...o,
});

describe("construireModification : motif obligatoire, seuls les champs qui changent partent", () => {
  it("sans motif : refus avec le message", () => {
    const l = ligne(); const s = { ...saisieDepuis(l), annee: "2026" };
    const r = construireModification(l, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/motif est obligatoire/);
  });
  it("le corps ne contient que ce qui change, plus motif et version lue", () => {
    const l = ligne(); const r = construireModification(l, { ...saisieDepuis(l), annee: "2026", largeur: "6,5", motif: "Arrêté de référence 2026" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.corps).toEqual({ anneeReference: 2026, largeurChausseeM: 6.5, motif: "Arrêté de référence 2026", versionAttendue: 1 });
      expect(r.changeLeCalcul).toBe(true);
    }
  });
  it("rien ne change : refus, pas de requete inutile", () => {
    const l = ligne(); const r = construireModification(l, { ...saisieDepuis(l), motif: "Aucun changement reel" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreurs.join(" ")).toMatch(/Aucune valeur ne change/);
  });
  it("un libelle ou un commentaire seul ne change PAS le calcul : la consequence le dit", () => {
    const l = ligne({ approuveLe: "2026-10-20T00:00:00Z", anneeReference: 2026, largeurChausseeM: "6.5" });
    const r = construireModification(l, { ...saisieDepuis(l), libelle: "Reconstruction bitume (RN)", commentaire: "precision", motif: "Correction de redaction" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changeLeCalcul).toBe(false);
      expect(consequenceModification(r.changeLeCalcul, true)).toMatch(/ne sont pas touchées/);
    }
  });
  it("un changement de prix sur une ligne approuvee annonce le retrait de l'approbation", () => {
    const l = ligne({ approuveLe: "2026-10-20T00:00:00Z", anneeReference: 2026, largeurChausseeM: "6.5" });
    const r = construireModification(l, { ...saisieDepuis(l), cout: "3600000000", motif: "Nouveau bordereau" });
    expect(r.ok && r.changeLeCalcul).toBe(true);
    expect(consequenceModification(true, true)).toMatch(/RETIRÉE/);
  });
  it("valide cout, millesime, largeur, dates et leur ordre", () => {
    const l = ligne(); const s = saisieDepuis(l);
    const msg = (o: Partial<typeof s>) => { const r = construireModification(l, { ...s, motif: "motif valable", ...o }); return r.ok ? "" : r.erreurs.join(" "); };
    expect(msg({ cout: "12,5" })).toMatch(/coût/);
    expect(msg({ cout: "0" })).toMatch(/coût/);
    expect(msg({ annee: "1850" })).toMatch(/millésime/);
    expect(msg({ largeur: "45" })).toMatch(/largeur/);
    expect(msg({ validDe: "2026-02-30" })).toMatch(/date/);
    expect(msg({ validDe: "2027-01-01", validA: "2026-01-01" })).toMatch(/précède/);
    expect(msg({ source: "  " })).toMatch(/source/);
  });
  it("effacer le millesime d'une ligne qui en a un est une modification (null)", () => {
    const l = ligne({ anneeReference: 2026 });
    const r = construireModification(l, { ...saisieDepuis(l), annee: "", motif: "Millésime douteux" });
    expect(r.ok && r.corps.anneeReference).toBeNull();
  });
});

describe("approbation", () => {
  it("motif ET commentaire obligatoires", () => {
    expect(construireApprobation(ligne(), "", "").ok).toBe(false);
    expect(construireApprobation(ligne(), "motif valable", "").ok).toBe(false);
    expect(construireApprobation(ligne(), "", "commentaire valable").ok).toBe(false);
    const r = construireApprobation(ligne({ version: 4 }), " motif valable ", " commentaire valable ");
    expect(r).toEqual({ ok: true, corps: { motif: "motif valable", commentaire: "commentaire valable", versionAttendue: 4 } });
  });
  it("raison d'impossibilite : illisible, deja approuvee, ou rien", () => {
    expect(raisonApprobationImpossible(ligne())).toMatch(/millésime et la largeur/);
    expect(raisonApprobationImpossible(ligne({ anneeReference: 2026 }))).toMatch(/largeur/);
    expect(raisonApprobationImpossible(ligne({ anneeReference: 2026, largeurChausseeM: "6.5", approuveLe: "2026-10-20" }))).toMatch(/déjà approuvée/);
    expect(raisonApprobationImpossible(ligne({ anneeReference: 2026, largeurChausseeM: "6.5" }))).toBeNull();
  });
});

describe("historique et erreurs", () => {
  const ev = (o: Partial<EvenementBareme>): EvenementBareme => ({
    id: 1, version: 2, evenement: "MODIFICATION", champsModifies: ["anneeReference"], modifieCalcul: true, approbationReinitialisee: false, statutApprobation: "NON_APPROUVE",
    valeursAvant: { anneeReference: null }, valeursApres: { anneeReference: 2026 }, auteur: { id: "u", email: "a@x" }, motif: "m", commentaire: null, creeLe: "2026-10-20T00:00:00Z", ...o,
  });
  it("libelles d'evenement et lignes avant → apres (une valeur absente est dite « non renseigné »)", () => {
    expect(libelleEvenement(ev({}))).toBe("Modification du calcul");
    expect(libelleEvenement(ev({ approbationReinitialisee: true }))).toMatch(/approbation retirée/);
    expect(libelleEvenement(ev({ modifieCalcul: false }))).toBe("Modification descriptive");
    expect(libelleEvenement(ev({ evenement: "APPROBATION" }))).toBe("Approbation");
    expect(lignesChangement(ev({}))).toEqual(["Millésime : non renseigné → 2026"]);
    expect(lignesChangement(ev({ evenement: "APPROBATION", champsModifies: ["approbation"] }))).toEqual([]);
  });
  it("le message du serveur (403 AUTO_VALIDATION, 409) est conserve avec son statut et son code", () => {
    expect(messageActionRefusee({ response: { status: 403, data: { error: "Un objet ne peut pas être validé par la personne qui l'a produit.", code: "AUTO_VALIDATION" } } }, "repli"))
      .toEqual({ statut: 403, code: "AUTO_VALIDATION", message: "Un objet ne peut pas être validé par la personne qui l'a produit." });
    expect(messageActionRefusee(new Error("x"), "repli")).toEqual({ statut: null, code: null, message: "repli" });
  });
});
