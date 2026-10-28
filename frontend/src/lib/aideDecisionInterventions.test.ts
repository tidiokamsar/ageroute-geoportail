import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get } }));

import {
  ReponseInvalide, chargerInterventionsGeo, classerErreur, estErreurAutorisation, lireFiche, lireFicheIntervention, lireListe, listerInterventions,
} from "./aideDecisionInterventions";
import { paramsApi } from "./decision";
import { _reinitialiserSelection, acquitterCentrage, selectionner, definirVueListe } from "./aideDecisionInterventionsHooks";
import type { FiltresDecision } from "../components/decision/types";
import { exclueSynth, ficheSynth, incompleteSynth, interventionSynth, listeSynth } from "../components/decision/carte/synthetique.testutil";

/** Donnees SYNTHETIQUES (`synth-*`) : la forme est celle du backend REEL (`LigneClassee`, enveloppes de priorite.service.ts), aucune valeur n'est reelle. */

beforeEach(() => { h.get.mockReset(); _reinitialiserSelection(); });

describe("lireListe : la forme du backend reel, ou une erreur de forme (jamais une liste vide inventee)", () => {
  it("lit les lignes, le curseur suivant, le total, le decompte du serveur et les filtres non appliques", () => {
    const l = lireListe(listeSynth([interventionSynth(1), interventionSynth(2)], {
      page: { limite: 2, prochainCurseur: "curseur-2", aSuivant: true }, total: 412, totalAffiche: 400,
      resume: { candidats: 412, classes: 400, complets: 380, incomplets: 20, exclus: 12, parMotifExclusion: { ETAT_NON_EVALUE: 12 } },
      filtres: { appliques: {}, nonAppliques: [{ filtre: "statutChantier", valeurs: ["EN_COURS"], raison: "aucun lien structuré" }] },
    }));
    expect(l.items.map((i) => i.id)).toEqual(["synth-1", "synth-2"]);
    expect(l.suivant).toBe("curseur-2");
    expect(l.aSuivant).toBe(true);
    expect(l.total).toBe(412);
    expect(l.totalAffiche).toBe(400);
    expect(l.resume).toMatchObject({ candidats: 412, incomplets: 20, exclus: 12, parMotifExclusion: { ETAT_NON_EVALUE: 12 } });
    expect(l.filtresNonAppliques).toEqual([{ filtre: "statutChantier", valeurs: ["EN_COURS"], raison: "aucun lien structuré" }]);
    expect(l.provisoire).toBe(true);
    expect(l.versionParametres).toBe("parametres-synth-1");
    expect(l.items[0].troncon).toMatchObject({ id: "t-1", code: "SYN-1", regionNom: "Région synthétique" });
    expect(l.items[0].coutEstime?.montantGnf).toBe("1200000000"); // chaine conservee
    expect(l.items[0].longueur?.geometriqueKm).toBeCloseTo(12.2); // le serveur donne des metres
    expect(l.items[0].rang).toBe(1);
    expect(l.items[0].score).toBe(79);
  });

  it("un corps sans tableau `data` est une ERREUR de forme, pas une liste vide (y compris l'ancienne forme `items`)", () => {
    for (const mauvais of [null, {}, { data: "x" }, [], "<html>", { items: [] }]) {
      expect(() => lireListe(mauvais), JSON.stringify(mauvais)).toThrow(ReponseInvalide);
    }
    expect(classerErreur(new ReponseInvalide("forme")).genre).toBe("reponse");
  });

  it("ecarte et COMPTE les lignes sans identifiant ou en double ; total absent ou invalide : null (on ne le devine pas)", () => {
    const l = lireListe({ data: [interventionSynth(1), interventionSynth(1), { rang: 3 }, null], total: -2 });
    expect(l.items).toHaveLength(1);
    expect(l.ignorees).toBe(3);
    expect(l.total).toBeNull();
    expect(l.suivant).toBeNull();
    expect(l.aSuivant).toBe(false);
    expect(l.resume).toBeNull();
  });

  it("un champ absent reste null : pas de zero invente pour le score, le cout, les longueurs", () => {
    const i = lireListe({ data: [{ id: "x" }] }).items[0];
    expect(i).toMatchObject({ score: null, coutEstime: null, coutNonEstimable: null, longueur: null, dateDernierConstat: null, etatPhysique: null, rang: null, troncon: null, statutScore: null, exclusion: null, completude: null });
    expect(i.scoreIncomplet).toBe(false);
    expect(i.localisation).toBe("invalide"); // jamais tenue pour valide sans que le serveur le dise
  });

  it("score INCOMPLET : criteres manquants lus en clair avec libelle et raison", () => {
    const i = lireListe({ data: [incompleteSynth(1, [{ critere: "TRAFIC", libelle: "Trafic", raison: "aucune mesure" }, { critere: "", libelle: "x", raison: "y" }, { critere: "SECURITE", libelle: "Sécurité", raison: "" }], 31)] }).items[0];
    expect(i.scoreIncomplet).toBe(true);
    expect(i.statutScore).toBe("INCOMPLET");
    expect(i.score).toBe(31);
    expect(i.completude).toBe(0.6);
    expect(i.criteresManquants).toEqual([{ critere: "TRAFIC", libelle: "Trafic", raison: "aucune mesure" }, { critere: "SECURITE", libelle: "Sécurité", raison: "raison non précisée" }]);
  });

  it("ligne NON CLASSEE (EXCLU) : ni rang ni score, et son motif d'exclusion", () => {
    const i = lireListe({ data: [exclueSynth(7)] }).items[0];
    expect(i).toMatchObject({ statutScore: "EXCLU", rang: null, score: null, exclusion: { code: "ETAT_NON_EVALUE", motif: "l'état du tronçon n'est pas évalué" } });
  });

  it("coutEstime sans montant en chaine : pas de montant (jamais une conversion qui perdrait des chiffres) ; coutNonEstimable porte son motif", () => {
    const i1 = lireListe({ data: [{ ...interventionSynth(1), coutEstime: { ...interventionSynth(1).coutEstime, montantGnf: 1200000000 } }] }).items[0];
    expect(i1.coutEstime).toBeNull();
    const i2 = lireListe({ data: [{ ...interventionSynth(2), coutEstime: null, coutNonEstimable: { code: "BAREME_ABSENT", motif: "aucun barème" } }] }).items[0];
    expect(i2.coutNonEstimable).toEqual({ code: "BAREME_ABSENT", motif: "aucun barème" });
  });

  it("localisation invalide et son motif ; divergence de longueur lue du serveur", () => {
    const i = lireListe({ data: [{ ...interventionSynth(1), localisation: "invalide", localisationMotif: "géométrie absente", longueur: { metierKm: 15, geometriqueM: 10000, longueurOrigine: "GEOMETRIE", divergence: { signalee: true, ecartRelatif: 0.5, seuilRelatif: 0.1 } } }] }).items[0];
    expect(i.localisation).toBe("invalide");
    expect(i.localisationMotif).toBe("géométrie absente");
    expect(i.longueur).toEqual({ metierKm: 15, geometriqueKm: 10, origine: "GEOMETRIE", divergence: { signalee: true, ecartRelatif: 0.5, seuilRelatif: 0.1 } });
  });
});

describe("lireFiche : l'enveloppe du detail, la ligne classee imbriquee dans `intervention`", () => {
  it("fiche complete : motif, limites, historique (recalculs, decisions, parametres), actions, fiches figees, motifs de provisoire", () => {
    const f = lireFiche(ficheSynth(1, { fiches: [{ id: "f1", reference: "FI-1", statut: "PROPOSE", annee: 2026 }] }));
    expect(f.id).toBe("synth-1");
    expect(f.motif).toContain("état dégradé");
    expect(f.limites).toEqual(["Trafic de 2019 (synthétique)."]);
    expect(f.historique?.recalculs).toEqual({ disponible: false, raison: "le classement est calculé à la volée et n'est pas enregistré" });
    expect(f.historique?.decisions[0]).toMatchObject({ de: "BROUILLON", vers: "PROPOSE", motif: "revue synthétique" });
    expect(f.historique?.parametres[0]).toMatchObject({ version: "parametres-synth-1", utilisee: true, approuveeLe: null });
    expect(f.actions?.disponibles).toEqual([]);
    expect(f.actions?.nonDisponibles).toContain("rejeter");
    expect(f.actions?.raison).toContain("Aucun workflow");
    expect(f.fichesFigees).toEqual([{ id: "f1", reference: "FI-1", statut: "PROPOSE", annee: 2026 }]);
    expect(f.motifsProvisoire).toHaveLength(1);
    expect(f.contributions[0]).toMatchObject({ libelle: "État et gravité", poidsPct: 40, valeurNormalisee: 90, points: 36, brut: "MAUVAIS", provenance: "valeurs_qualite" });
    expect(f.contributions[1].brut).toBe("1200"); // mesure numerique rendue en texte, sans perte
  });

  it("fiche minimale : motif, limites, actions et historique restent null (affiches « non fourni »)", () => {
    const f = lireFiche({ intervention: { id: "x" } });
    expect(f).toMatchObject({ motif: null, limites: null, actions: null, historique: null, fichesFigees: [], motifsProvisoire: [], avertissement: null });
  });

  it("un corps sans `intervention` (ou sans identifiant) est une erreur de forme", () => {
    expect(() => lireFiche({ motif: "x" })).toThrow(ReponseInvalide);
    expect(() => lireFiche({ intervention: {} })).toThrow(ReponseInvalide);
    expect(() => lireFiche(null)).toThrow(ReponseInvalide);
  });
});

describe("classement des erreurs", () => {
  const http = (status?: number, error?: string) => ({ response: status === undefined ? undefined : { status, data: { error } } });
  it("401/403 sont des refus d'autorisation (jamais retentes) ; sans reponse = reseau ; le message du serveur prime", () => {
    expect(classerErreur(http(403)).genre).toBe("permission");
    expect(classerErreur(http(401)).genre).toBe("session");
    expect(estErreurAutorisation(http(403))).toBe(true);
    expect(estErreurAutorisation(http(500))).toBe(false);
    expect(classerErreur(http()).genre).toBe("reseau");
    expect(classerErreur(http(404)).genre).toBe("introuvable");
    expect(classerErreur(http(400, "emprise trop grande")).message).toBe("emprise trop grande");
    expect(classerErreur(http(500)).genre).toBe("serveur");
    expect(classerErreur(http(429)).genre).toBe("limite");
    expect(classerErreur(http(422, "plus de 1000 tronçons candidats : restreignez le périmètre")).message).toContain("restreignez le périmètre");
  });
});

describe("AD-11 : la liste, la carte et la fiche utilisent LA MEME serialisation des filtres", () => {
  const filtres: FiltresDecision = { regionId: 3, classe: ["RR", "RN"], etat: ["CRITIQUE"], depuis: "2026-01-01", jusqua: "2026-06-30" };

  it("la liste envoie exactement `paramsApi(filtres)` (+ le curseur) ; la carte envoie exactement les memes + la bbox", async () => {
    h.get.mockResolvedValue({ data: listeSynth([]) });
    await listerInterventions(filtres, "curseur-2");
    const [urlListe, optListe] = h.get.mock.calls[0];
    expect(urlListe).toBe("/v2/aide-decision/interventions");
    expect(optListe.params).toEqual({ ...paramsApi(filtres), curseur: "curseur-2" });

    h.get.mockResolvedValue({ data: { type: "FeatureCollection", features: [] } });
    await chargerInterventionsGeo(filtres, [-13.8, 9.5, -13.5, 9.8]);
    const [urlGeo, optGeo] = h.get.mock.calls[1];
    expect(urlGeo).toBe("/v2/aide-decision/interventions.geojson");
    const { bbox, ...filtresGeo } = optGeo.params;
    expect(bbox).toBe("-13.8,9.5,-13.5,9.8");
    const { curseur, ...filtresListe } = optListe.params;
    expect(curseur).toBe("curseur-2");
    expect(filtresGeo).toEqual(filtresListe);
  });

  it("premiere page : aucun parametre `curseur` ; listes en une valeur separee par des virgules (ce que le serveur lit)", async () => {
    h.get.mockResolvedValue({ data: listeSynth([]) });
    await listerInterventions({ classe: ["RN", "RR"] }, null);
    expect(h.get.mock.calls[0][1].params).toEqual({ classe: "RN,RR" });
  });

  it("le filtre d'affichage `statutScore` du serveur n'est envoye que pour les vues que le serveur sait filtrer", async () => {
    h.get.mockResolvedValue({ data: listeSynth([]) });
    await listerInterventions({}, null, "INCOMPLET");
    expect(h.get.mock.calls[0][1].params).toEqual({ statutScore: "INCOMPLET" });
  });

  it("la fiche est lue par identifiant encode", async () => {
    h.get.mockResolvedValue({ data: ficheSynth(1, {}, { ...interventionSynth(1), id: "a/b" }) });
    const f = await lireFicheIntervention("a/b");
    expect(h.get.mock.calls[0][0]).toBe("/v2/aide-decision/interventions/a%2Fb");
    expect(f.id).toBe("a/b");
  });

  it("une reponse qui n'a pas la forme du contrat leve une erreur de forme", async () => {
    h.get.mockResolvedValue({ data: "<html>" });
    await expect(listerInterventions({}, null)).rejects.toBeInstanceOf(ReponseInvalide);
  });
});

describe("magasin de selection : pas de demande de centrage sans clic sur une ligne", () => {
  it("un marqueur (selectionner sans `centrer`) ne leve jamais la demande ; une ligne la leve ; la carte l'acquitte", async () => {
    const { useSelection } = await import("./aideDecisionInterventionsHooks");
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useSelection());
    expect(result.current).toEqual({ id: null, centrageEnAttente: false, vue: "toutes" });
    act(() => selectionner("a"));
    expect(result.current).toMatchObject({ id: "a", centrageEnAttente: false });
    act(() => selectionner("b", { centrer: true }));
    expect(result.current).toMatchObject({ id: "b", centrageEnAttente: true });
    act(() => acquitterCentrage());
    expect(result.current.centrageEnAttente).toBe(false);
    act(() => selectionner("c"));
    expect(result.current).toMatchObject({ id: "c", centrageEnAttente: false });
    act(() => definirVueListe("score-incomplet"));
    expect(result.current.vue).toBe("score-incomplet");
    act(() => selectionner(null, { centrer: true }));
    expect(result.current).toMatchObject({ id: null, centrageEnAttente: false });
  });

  it("une ecriture identique n'emet rien : pas de rendu inutile (anti-boucle)", async () => {
    const { useSelection } = await import("./aideDecisionInterventionsHooks");
    const { renderHook, act } = await import("@testing-library/react");
    let rendus = 0;
    renderHook(() => { rendus += 1; return useSelection(); });
    const avant = rendus;
    act(() => { selectionner("a"); selectionner("a"); selectionner("a"); acquitterCentrage(); });
    expect(rendus - avant).toBeLessThanOrEqual(2);
  });
});
