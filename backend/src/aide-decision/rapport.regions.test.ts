import { describe, expect, it } from "vitest";
import { construireRapportRegions, jeuReseauRegions, lireRapportRegions } from "./rapport.regions";
import type { LigneEtat } from "./kpi.noyau";

/**
 * Rapport par region : km par etat, NON EVALUE A PART, numerateur et denominateur sur la meme population. Les formules
 * sont celles du lot 2 (`kpi.noyau`) : ce test verifie l'adaptation en lignes de tableau, pas la formule elle-meme.
 */
const ligne = (o: Partial<LigneEtat> & Pick<LigneEtat, "regionId" | "etat" | "km">): LigneEtat => ({
  provenance: "OBSERVED", observeDate: true, statutValidation: "VALIDE", longueurConnue: true, nb: 1,
  derniereEvaluation: new Date("2026-09-01T00:00:00Z"), plusAncienneEvaluation: new Date("2026-09-01T00:00:00Z"), ...o,
});
const noms = new Map([[1, "Kindia"], [2, "Labe"]]);
const lignes: LigneEtat[] = [
  ligne({ regionId: 1, etat: "BON", km: 60 }),
  ligne({ regionId: 1, etat: "MAUVAIS", km: 30 }),
  ligne({ regionId: 1, etat: "CRITIQUE", km: 10 }),
  ligne({ regionId: 1, etat: "NON_EVALUE", km: 500, provenance: "SANS_LIGNE", observeDate: false }),
  ligne({ regionId: 2, etat: "BON", km: 40 }),
];

describe("construireRapportRegions", () => {
  const r = construireRapportRegions(lignes, noms, null, new Date("2026-10-29T10:00:00Z"));
  const kindia = r.regions.find((x) => x.region === "Kindia")!;

  it("le non evalue est a part et hors denominateur : 40 % de degrade sur 100 km valides, pas sur 600", () => {
    expect(kindia.kmEligible).toBe(100);
    expect(kindia.kmNonEvalue).toBe(500);
    expect(kindia.degradePct).toBe(40);
    expect(kindia.critiquePct).toBe(10);
    expect(kindia.kmPerimetre).toBe(600);
    expect(kindia.partNonEvaluee).toBeCloseTo(0.8333, 3);
    expect(kindia.disponibilite).toBe("PARTIEL");
  });

  it("le total regroupe les memes lignes que les regions (meme perimetre au numerateur et au denominateur)", () => {
    expect(r.total.kmEligible).toBe(140);
    expect(r.total.kmEligible).toBe(r.regions.reduce((s, x) => s + (x.kmEligible ?? 0), 0));
    expect(r.total.region).toBe("TOTAL national");
    expect(r.total.degradePct).toBeCloseTo((40 / 140) * 100, 0);
  });

  it("un etat jamais constate n'est pas « bon » : il sort de la classe et du denominateur", () => {
    const r2 = construireRapportRegions([ligne({ regionId: 1, etat: "BON", km: 80, provenance: "IMPORTED_UNVERIFIED" })], noms, null, new Date());
    expect(r2.regions[0].kmBon).toBe(0);
    expect(r2.regions[0].kmEtatNonValide).toBe(80);
    expect(r2.regions[0].degradePct).toBeNull();
    expect(r2.regions[0].disponibilite).toBe("NON_DISPONIBLE");
  });

  it("denominateur nul : le taux est NULL, jamais 0", () => {
    const r2 = construireRapportRegions([ligne({ regionId: 2, etat: "NON_EVALUE", km: 10 })], noms, [2], new Date());
    expect(r2.regions[0].degradePct).toBeNull();
    expect(r2.regions[0].critiquePct).toBeNull();
    const csvLigne = jeuReseauRegions(r2).lignes[0];
    expect(csvLigne.degrade_pct).toBeNull();
  });

  it("les troncons sans longueur metier sont comptes, jamais additionnes", () => {
    const r2 = construireRapportRegions([ligne({ regionId: 1, etat: "BON", km: 0, longueurConnue: false, nb: 4 })], noms, null, new Date());
    expect(r2.regions[0].troncons).toBe(4);
    expect(r2.regions[0].tronconsSansLongueurMetier).toBe(4);
    // CONTRAT MODIFIE (revue) : ce test attendait `kmPerimetre` = 0 pour 4 troncons dont AUCUN n'a de longueur : un 0 km se lit comme
    // « le perimetre est vide », alors que sa longueur est INCONNUE. Elle vaut null.
    expect(r2.regions[0].kmPerimetre).toBeNull();
  });

  it("DES TRONCONS A ETAT VALIDE SANS LONGUEUR : les km de leur classe valent null (inconnu), jamais 0, et la ligne le dit", () => {
    const r2 = construireRapportRegions([
      ligne({ regionId: 1, etat: "BON", km: 60 }),
      ligne({ regionId: 1, etat: "MAUVAIS", km: 0, longueurConnue: false, nb: 2 }), // 2 troncons MAUVAIS valides, longueur inconnue
      ligne({ regionId: 1, etat: "NON_EVALUE", km: 0, longueurConnue: false, nb: 3, provenance: "SANS_LIGNE", observeDate: false }),
    ], noms, null, new Date());
    const l = r2.regions[0];
    expect(l.kmBon).toBe(60);
    expect(l.kmMauvais).toBeNull(); // 2 troncons, aucune longueur connue : pas « 0 km mauvais »
    expect(l.kmMoyen).toBe(0); // aucun troncon MOYEN : un vrai zero
    expect(l.kmCritique).toBe(0);
    expect(l.kmNonEvalue).toBeNull(); // 3 troncons non evalues sans longueur
    expect(l.tronconsValidesSansLongueur).toBe(2);
    expect(l.tronconsSansLongueurMetier).toBe(5);
    expect(l.longueurDisponibilite).toBe("PARTIELLE");
    expect(l.disponibilite).toBe("PARTIEL");
    const csv = jeuReseauRegions(r2).lignes[0];
    expect(csv.km_mauvais).toBeNull(); // vide dans le fichier, jamais 0
    expect(csv.km_moyen).toBe(0);
    expect(csv.troncons_valides_sans_longueur).toBe(2);
  });

  it("aucune longueur connue du tout : tous les km sont null, longueurDisponibilite ABSENTE, taux non calculable", () => {
    const r2 = construireRapportRegions([ligne({ regionId: 1, etat: "BON", km: 0, longueurConnue: false, nb: 4 })], noms, null, new Date());
    const l = r2.regions[0];
    expect([l.kmBon, l.kmEligible, l.kmPerimetre]).toEqual([null, null, null]);
    expect(l.longueurDisponibilite).toBe("ABSENTE");
    expect(l.disponibilite).toBe("NON_DISPONIBLE");
    expect(l.degradePct).toBeNull();
    expect(r2.total.kmEligible).toBeNull();
  });

  it("toutes les longueurs connues : COMPLETE, aucun km nul sauf une classe sans troncon (zero reel)", () => {
    const r2 = construireRapportRegions([ligne({ regionId: 2, etat: "BON", km: 40 })], noms, [2], new Date());
    expect(r2.regions[0].longueurDisponibilite).toBe("COMPLETE");
    expect(r2.regions[0].tronconsValidesSansLongueur).toBe(0);
    expect([r2.regions[0].kmBon, r2.regions[0].kmMoyen, r2.regions[0].kmMauvais, r2.regions[0].kmCritique]).toEqual([40, 0, 0, 0]);
  });

  it("dit le perimetre (reseau classe, voirie promue exclue), le statut PROVISOIRE et la mention de longueur metier", () => {
    const texte = r.avertissements.join(" ");
    expect(texte).toMatch(/voirie_locale/);
    expect(texte).toMatch(/longueurs METIER/);
    expect(texte).toMatch(/PROVISOIRE/);
    expect(r.parametres.statutDefinition).toBe("PROVISOIRE");
  });

  it("un compte regional : total libelle « du perimetre », jamais « national »", () => {
    const r2 = construireRapportRegions(lignes.filter((l) => l.regionId === 2), noms, [2], new Date());
    expect(r2.total.region).toBe("TOTAL du perimetre");
    expect(r2.perimetre.national).toBe(false);
    expect(r2.regions.map((x) => x.regionId)).toEqual([2]);
  });

  it("rapport vide : dit, et pas de zero invente", () => {
    const r2 = construireRapportRegions([], noms, [1], new Date());
    expect(r2.regions).toEqual([]);
    expect(r2.avertissements.join(" ")).toMatch(/vide, pas nul/);
  });
});

describe("jeuReseauRegions et lireRapportRegions", () => {
  it("une colonne par grandeur, avec son unite, aucune financiere", async () => {
    const r = await lireRapportRegions(
      { etat: async () => lignes, nomsRegions: async () => noms },
      { regions: null, classes: null, maintenant: new Date("2026-10-29T10:00:00Z") },
    );
    const jeu = jeuReseauRegions(r);
    expect(jeu.colonnes.find((c) => c.cle === "km_bon")?.unite).toBe("km");
    expect(jeu.colonnes.find((c) => c.cle === "degrade_pct")?.unite).toBe("%");
    expect(jeu.colonnes.some((c) => c.financier)).toBe(false);
    expect(jeu.lignes).toHaveLength(3);
  });
});
