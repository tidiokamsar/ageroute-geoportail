import { describe, expect, it } from "vitest";
import {
  classerErreurSources, corpsRegle, provenancePrecision, raisonIncertitude, raisonNonApprobation, texteMesure, totauxParStatut,
  type SaisieRegle,
} from "./projetsVoirieSources";
import { lireComparaison, lireGroupeSources, lirePageResultats, lireResultat, lireVueRegles, lireVueSources } from "./projetsVoirieSourcesApi";

/** Donnees SYNTHETIQUES (identifiants et noms inventes). */
const erreur = (status: number, data: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({ response: { status, data, headers } });

describe("lecteurs S1", () => {
  it("vue des sources : une source unique est un statut normal ; les versions candidates n'existent que si le serveur les rend", () => {
    const vue = lireVueSources({
      reseaux: [
        { role: "RESEAU_TIERS", concessionnaire: { id: "c1", nom: "Operateur A" }, typeReseau: "TELECOM", statut: "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", nbSources: 1, sources: [{ jeuId: "j1", version: 1, nomFichier: "a.kml" }] },
        { role: "AXES_TRAVAUX", statut: "COMPARABLE", sources: [], versionsCandidates: [{ jeuId: "j9", version: 2, nomFichier: "axes.geojson", statut: "CONTROLE", remplace: "j8" }] },
        { role: "INCONNU", statut: "COMPARABLE" },
      ],
    });
    expect(vue.reseaux).toHaveLength(2);
    expect(vue.ignores).toBe(1);
    expect(vue.reseaux[0]).toMatchObject({ statut: "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE", versionsCandidates: null, typeReseauCode: null });
    expect(vue.reseaux[1].versionsCandidates?.[0]).toMatchObject({ jeuId: "j9", remplace: "j8", statut: "CONTROLE" });
    expect(() => lireVueSources({})).toThrow(/Réponse inattendue/);
    expect(lireGroupeSources({ role: "RESEAU_TIERS", statut: "AUTRE" })).toBeNull();
  });
  it("comparaison : donnees masquees, resume en echec, regle et bareme", () => {
    const c = lireComparaison({
      id: "cmp", numero: 3, statut: "ECHEC", mode: "SOURCES", jeux: [{ role: "A", jeuId: "j1" }, { role: "B", jeuId: "j2" }], donneesMasquees: true,
      regle: { regleId: "r", code: "R-1", version: 2, margeM: "1.0", precisionParClasseM: { A: 0.5 } }, resume: { statut: "ECHEC", erreur: { code: "COMPARAISON_TROP_LONGUE", message: "trop long" } },
    });
    expect(c).toMatchObject({ numero: 3, statut: "ECHEC", donneesMasquees: true, regle: { code: "R-1", margeM: 1, precisionParClasseM: { A: 0.5 } }, resume: { erreur: { code: "COMPARAISON_TROP_LONGUE" } } });
    expect(c?.jeux[0]).toMatchObject({ role: "A", jeuId: "j1", nomFichier: null, sha256: null });
    expect(lireComparaison({ id: "x", statut: "EN_COURS" })).toBeNull();
  });
  it("resultat : un rapprochement incertain n'a JAMAIS de mesure, meme si le serveur en rendait une ; un objet B absent (masque) est nul", () => {
    const r = lireResultat({ id: "r1", ordre: 1, statut: "RAPPROCHEMENT_INCERTAIN", objetA: { id: 7, nom: "Cable 1", precisionM: null, originePrecision: "INCONNUE" }, mesure: { hausdorffM: 3 } });
    expect(r).toMatchObject({ mesure: null, objetB: null, objetA: { id: "7" } });
    // Revue m12 : ni mesure ni corridor pour un incertain, meme rendus par le serveur.
    expect(lireResultat({ id: "r9", statut: "RAPPROCHEMENT_INCERTAIN", corridorM: 7.77, mesure: { hausdorffM: 9 } })).toMatchObject({ mesure: null, corridorM: null });
    const d = lireResultat({ id: "r2", statut: "DIVERGENCE", objetA: { id: "1", originePrecision: "OBJET", precisionM: "1" }, mesure: { hausdorffM: 3, longueurHorsCorridorM: 100, longueurAM: 100, partHorsCorridor: 1 }, corridorM: 2 });
    expect(d).toMatchObject({ objetB: null, mesure: { hausdorffM: 3 }, corridorM: 2 });
    const p = lirePageResultats({ resultats: [{ id: "a", statut: "CONCORDANCE" }, { id: "b", statut: "FUSION" }], masque: false, curseurSuivant: "c2" });
    expect(p).toMatchObject({ suivant: "c2", ignores: 1, masque: false });
    expect(p.resultats).toHaveLength(1);
  });
  it("regles : statut, auteur, bareme ; effectives par famille", () => {
    const v = lireVueRegles({ regles: [{ id: "r", code: "R", version: 1, statut: "BROUILLON", creePar: { id: "u1", nomComplet: "Auteur" }, precisionParClasseM: null }], effectives: [{ famille: "TELECOM", code: "S", version: 0 }], avertissements: ["provisoire"] });
    expect(v.regles[0]).toMatchObject({ statut: "BROUILLON", creePar: { id: "u1" }, precisionParClasseM: null });
    expect(v.effectives[0]).toMatchObject({ famille: "TELECOM", code: "S", version: 0 });
  });
});

describe("affichage des resultats", () => {
  it("provenance de la precision : objet, jeu, classe par un bareme approuve (regle et version citees), inconnue, non communiquee", () => {
    expect(provenancePrecision({ precisionM: 1, originePrecision: "OBJET" }, null)).toBe("1 m, déclarée pour l'objet");
    expect(provenancePrecision({ precisionM: 0.5, originePrecision: "JEU" }, null)).toBe("0,5 m, déclarée pour le jeu");
    expect(provenancePrecision({ precisionM: 2, originePrecision: "CLASSE" }, { etat: "NON_ATTESTE", code: "R-B", version: 3, couples: null })).toBe("2 m, attribuée à la classe par le barème de la règle R-B v3 (provenance du corridor non attestée)");
    expect(provenancePrecision({ precisionM: null, originePrecision: "INCONNUE" }, null)).toBe("inconnue");
    expect(provenancePrecision(null, null)).toBe("non communiquée");
  });
  it("raison d'un rapprochement incertain : la ou les precisions en metres qui manquent", () => {
    const o = (p: number | null) => ({ id: "x", nom: null, precisionM: p, originePrecision: p === null ? "INCONNUE" as const : "OBJET" as const });
    expect(raisonIncertitude({ objetA: o(null), objetB: o(null) })).toMatch(/des deux objets/);
    expect(raisonIncertitude({ objetA: o(null), objetB: o(1) })).toMatch(/objet de A/);
    expect(raisonIncertitude({ objetA: o(1), objetB: o(null) })).toMatch(/objet de B/);
  });
  it("mesure d'une divergence ; absente (masquee) : null", () => {
    expect(texteMesure({ corridorM: 2, mesure: { hausdorffM: 3, longueurAM: 100, longueurBM: 100, longueurRecouvrementM: 0, longueurHorsCorridorM: 100, partHorsCorridor: 1, distanceMinM: 3 } }))
      .toBe("distance de Hausdorff 3 m, 100 m hors corridor sur 100 m, soit 100 %, corridor 2 m");
    expect(texteMesure({ corridorM: null, mesure: null })).toBeNull();
  });
  it("totaux dans l'ordre des statuts, zero si absent", () => {
    expect(totauxParStatut({ DIVERGENCE: 2 }).map((t) => t.n)).toEqual([0, 2, 0, 0, 0]);
  });
});

describe("regles : saisie et approbation", () => {
  const vide: SaisieRegle = { famille: "", code: "R-1", margeM: "", rayonAppariementM: "", partHorsCorridorPct: "", A: "", B: "", C: "", D: "", justification: "Bareme convenu avec le concessionnaire" };
  it("un champ vide n'est pas envoye ; la part est saisie en pourcentage ; le bareme est complet ou absent", () => {
    expect(corpsRegle(vide).corps).toEqual({ code: "R-1", justification: "Bareme convenu avec le concessionnaire" });
    expect(corpsRegle({ ...vide, famille: "TELECOM", margeM: "1,5", partHorsCorridorPct: "5", A: "0,5", B: "1", C: "2", D: "5" }).corps)
      .toEqual({ code: "R-1", justification: "Bareme convenu avec le concessionnaire", famille: "TELECOM", margeM: 1.5, partHorsCorridorMax: 0.05, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 } });
    expect(corpsRegle({ ...vide, A: "1" }).erreurs.join(" ")).toMatch(/quatre précisions/);
    expect(corpsRegle({ ...vide, margeM: "200" }).erreurs.join(" ")).toMatch(/Marge/);
    expect(corpsRegle({ ...vide, justification: "court" }).erreurs.join(" ")).toMatch(/justification/);
    expect(corpsRegle({ ...vide, code: "!" }).erreurs.join(" ")).toMatch(/code/);
  });
  it("approbation : ADMIN autre que l'auteur ; l'auteur, un gestionnaire, une regle approuvee : refus explique", () => {
    const r = { statut: "BROUILLON" as const, creePar: { id: "u1", nomComplet: "Auteur" } };
    expect(raisonNonApprobation(r, { id: "u2", role: "ADMIN" })).toBeNull();
    expect(raisonNonApprobation(r, { id: "u1", role: "ADMIN" })).toMatch(/auteur.*autre personne/);
    expect(raisonNonApprobation(r, { id: "u2", role: "GESTIONNAIRE" })).toMatch(/administrateur/);
    expect(raisonNonApprobation({ ...r, statut: "APPROUVEE" }, { id: "u2", role: "ADMIN" })).toMatch(/immuable/);
  });
});

describe("erreurs typees du lot S1", () => {
  it.each([
    [409, { code: "JEUX_NON_COMPARABLES", motif: "RESEAU_DIFFERENT" }, "conflit", /même réseau/],
    [409, { code: "SEPARATION_DES_TACHES" }, "conflit", /autre personne/],
    [409, { code: "DOSSIER_DEJA_OUVERT", conflitId: "k" }, "conflit", /déjà ouvert/],
    [409, { code: "RESULTAT_NON_DIVERGENT" }, "conflit", /divergence mesurée/],
    [404, { code: "COMPARAISON_INTROUVABLE" }, "introuvable", /lisible pour votre compte/],
    [422, { code: "COMPARAISON_TROP_VOLUMINEUSE", objetsMax: 20000 }, "validation", /20 000 objets/],
    [503, { code: "PROJET_OCCUPE" }, "serveur", /en cours/],
    [504, { code: "COMPARAISON_TROP_LONGUE" }, "serveur", /délai/],
  ])("%s %o", (status, data, genre, motif) => {
    const e = classerErreurSources(erreur(status, data));
    expect(e.genre).toBe(genre);
    expect(e.message).toMatch(motif);
  });
  it("429 COMPARAISON_TROP_FREQUENTE : le delai a attendre ; hors ligne : reseau", () => {
    expect(classerErreurSources(erreur(429, { code: "COMPARAISON_TROP_FREQUENTE", retryAfterS: 42 })).message).toMatch(/42 secondes/);
    expect(classerErreurSources(new Error("Network Error")).genre).toBe("reseau");
  });
});
