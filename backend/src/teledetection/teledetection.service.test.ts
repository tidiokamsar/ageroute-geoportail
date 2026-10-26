import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RefusTeledetection, ajouterPreuves, calculerSynthese, changerEtatSource, changerStatut, deposerPropositions, dispatcherVerification,
  enregistrerProduits, poserVerdict, type DepotTeledetection,
} from "./teledetection.service";

/**
 * Le service avec un client SIMULE : il verifie l'ORDRE et le CONTENU des appels, pas le comportement de la base.
 * Ce que la base fait vraiment (declencheurs, contraintes, journal exige a la validation, empreintes du referentiel)
 * est prouve par `tests-integration/eo-workflow.integration.ts`, contre PostGIS.
 */

const journal: string[] = [];
/** Reponses successives de `$executeRaw` (nombre de lignes inserees) ; 1 par defaut. */
const resultatsInsertion: number[] = [];

/** Fabrique un client simule. `lignes` = reponses successives de `$queryRaw` ; chaque appel est consigne dans `journal`. */
function faux(lignes: unknown[][] = []) {
  journal.length = 0;
  resultatsInsertion.length = 0;
  const file = [...lignes];
  const enc = (nom: string, retour?: unknown) => vi.fn(async (..._a: unknown[]) => { journal.push(nom); return retour; });
  const tx = {
    $queryRaw: vi.fn(async (..._a: unknown[]) => { journal.push("queryRaw"); return file.shift() ?? []; }),
    $executeRaw: vi.fn(async (..._a: unknown[]) => { journal.push("executeRaw"); return resultatsInsertion.shift() ?? 1; }),
    earthObservationProduct: { findFirst: enc("produit.findFirst", null), findUnique: enc("produit.findUnique", null), findUniqueOrThrow: enc("produit.findUniqueOrThrow", {}) },
    propositionTeledetection: {
      updateMany: vi.fn(async (..._a: unknown[]) => { journal.push("proposition.updateMany"); return { count: 1 }; }),
      update: enc("proposition.update", {}),
      findUniqueOrThrow: enc("proposition.findUniqueOrThrow", { id: "p1", statut: "X" }),
      count: enc("proposition.count", 0),
    },
    propositionTeledetectionTransition: { create: enc("journal.create", {}) },
    propositionTeledetectionPreuve: { createMany: enc("preuve.createMany", { count: 0 }) },
    observation: { findMany: vi.fn(async (..._a: unknown[]) => { journal.push("observation.findMany"); return [{ id: "o1" }, { id: "o2" }]; }) },
    mission: {
      findMany: enc("mission.findMany", []),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { journal.push("mission.create"); return { id: "m1", statut: "BROUILLON", ...a.data }; }),
      findUniqueOrThrow: enc("mission.findUniqueOrThrow", { id: "m1" }),
    },
    sourceObservation: { findFirst: enc("source.findFirst", { id: "s1" }), update: vi.fn(async (a: { data: Record<string, unknown> }) => { journal.push("source.update"); return { id: "s1", ...a.data }; }) },
    sourceObservationEtat: { create: enc("etat.create", {}) },
    auditLog: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { journal.push(`audit:${String(a.data.action)}:${String(a.data.entityType)}`); return {}; }) },
  };
  const depot = { ...tx, $transaction: vi.fn(async (f: (t: unknown) => unknown) => f(tx)) };
  return { tx, depot: depot as unknown as DepotTeledetection };
}

const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof RefusTeledetection ? `${e.code}/${e.http}` : `ERREUR:${String(e)}`; } };

describe("changerStatut", () => {
  const demande = { propositionId: "p1", vers: "NON_CONCLUANTE", auteur: "u1", motif: "Terrain impraticable" };

  it("ecrit le journal AVANT la mise a jour, puis l'audit, dans la meme transaction", async () => {
    const { depot, tx } = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    await changerStatut(depot, demande);
    expect(tx.propositionTeledetectionTransition.create).toHaveBeenCalledTimes(1);
    expect(journal.indexOf("journal.create")).toBeLessThan(journal.indexOf("proposition.updateMany"));
    expect(journal.indexOf("proposition.updateMany")).toBeLessThan(journal.findIndex((j) => j.startsWith("audit:")));
    expect(journal).toContain("audit:UPDATE:PropositionTeledetection");
    expect(depot.$transaction).toHaveBeenCalledTimes(1);
  });

  it("le journal porte de, vers, auteur, motif et commentaire", async () => {
    const { depot, tx } = faux([[{ statut: "A_VERIFIER", regionId: null, motifAttente: null }]]);
    await changerStatut(depot, { ...demande, commentaire: " a revoir " });
    expect(tx.propositionTeledetectionTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ propositionId: "p1", de: "A_VERIFIER", vers: "NON_CONCLUANTE", auteurId: "u1", motif: "Terrain impraticable", commentaire: "a revoir", motifAttente: null }),
    });
  });

  it("un verdict est audite VALIDATE (CONFIRMEE) ou REJECT (INFIRMEE), pose l'auteur du verdict et derive le constat des observations", async () => {
    const a = faux([[{ statut: "EN_ATTENTE", regionId: 1, motifAttente: "AUTRE" }]]);
    await changerStatut(a.depot, { ...demande, vers: "CONFIRMEE", observationIds: ["o1", "o2"] });
    expect(journal).toContain("audit:VALIDATE:PropositionTeledetection");
    expect(a.tx.propositionTeledetection.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", statut: "EN_ATTENTE" },
      data: expect.objectContaining({ statut: "CONFIRMEE", verifieeParId: "u1", motifVerdict: "Terrain impraticable", constatRef: "observation:o1;observation:o2", motifAttente: null }),
    });
    expect(a.tx.propositionTeledetectionPreuve.createMany).toHaveBeenCalledTimes(1);
    const b = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    await changerStatut(b.depot, { ...demande, vers: "INFIRMEE", constatRef: "mission:X" });
    expect(journal).toContain("audit:REJECT:PropositionTeledetection");
  });

  it("un motif d'attente est inscrit pour EN_ATTENTE, et seulement pour lui", async () => {
    const { depot, tx } = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    await changerStatut(depot, { ...demande, vers: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE" });
    expect(tx.propositionTeledetection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ statut: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE" }) }));
  });

  it("une proposition inconnue : 404, rien n'est ecrit", async () => {
    const { depot, tx } = faux([[]]);
    expect(await code(changerStatut(depot, demande))).toBe("PROPOSITION_INEXISTANTE/404");
    expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
  });

  it("un verdict deja rendu : VERDICT_DEFINITIF (409), ni journal, ni mise a jour, ni audit", async () => {
    const { depot, tx } = faux([[{ statut: "CONFIRMEE", regionId: 1, motifAttente: null }]]);
    expect(await code(changerStatut(depot, { ...demande, vers: "INFIRMEE", constatRef: "x" }))).toBe("VERDICT_DEFINITIF/409");
    expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
    expect(tx.propositionTeledetection.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("une transition hors table : TRANSITION_INTERDITE (409)", async () => {
    const { depot } = faux([[{ statut: "NON_CONCLUANTE", regionId: 1, motifAttente: null }]]);
    expect(await code(changerStatut(depot, demande))).toBe("TRANSITION_INTERDITE/409");
  });

  it("le perimetre est controle AVANT la transition : un compte hors zone n'apprend rien du statut", async () => {
    const regional = { national: false as const, regions: new Set([2]) };
    const { depot, tx } = faux([[{ statut: "CONFIRMEE", regionId: 1, motifAttente: null }]]);
    expect(await code(changerStatut(depot, { ...demande, perimetre: regional }))).toBe("HORS_PERIMETRE/403");
    expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
    const sansRegion = faux([[{ statut: "A_VERIFIER", regionId: null, motifAttente: null }]]);
    expect(await code(changerStatut(sansRegion.depot, { ...demande, perimetre: regional }))).toBe("HORS_PERIMETRE/403");
  });

  it("un compte de la bonne region, ou national, decide", async () => {
    const a = faux([[{ statut: "A_VERIFIER", regionId: 2, motifAttente: null }]]);
    expect(await code(changerStatut(a.depot, { ...demande, perimetre: { national: false, regions: new Set([2]) } }))).toBe("OK");
    const b = faux([[{ statut: "A_VERIFIER", regionId: null, motifAttente: null }]]);
    expect(await code(changerStatut(b.depot, { ...demande, perimetre: { national: true } }))).toBe("OK");
  });

  it("une observation inconnue est refusee avant toute ecriture", async () => {
    const { depot, tx } = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    tx.observation.findMany.mockResolvedValueOnce([{ id: "o1" }]);
    expect(await code(changerStatut(depot, { ...demande, observationIds: ["o1", "o9"] }))).toBe("OBSERVATION_INEXISTANTE/404");
    expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
  });

  describe("preuves et perimetre (constat EO-FIX-BACK 2)", () => {
    const regional = { national: false as const, regions: new Set([1]) };
    const ligne = [{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }];

    it("un compte regional ne cite que les observations de son perimetre : la requete porte la region, pas un filtre apres coup", async () => {
      const { depot, tx } = faux([ligne, [{ id: "o1" }]]);
      expect(await code(changerStatut(depot, { ...demande, observationIds: ["o1"], perimetre: regional }))).toBe("OK");
      const sql = JSON.stringify(tx.$queryRaw.mock.calls[1]);
      expect(sql).toContain('troncons');
      expect(sql).toContain('missions');
      expect(tx.observation.findMany).not.toHaveBeenCalled();
    });

    it("observation d'une autre region ou inexistante : la MEME reponse (404, meme code), sans identifiant dans le message", async () => {
      const hors = faux([ligne, []]); // la base ne rend rien : hors perimetre
      const inexistante = faux([ligne, []]);
      const messages: string[] = [];
      for (const [f, id] of [[hors, "00000000-0000-4000-8000-0000000000aa"], [inexistante, "00000000-0000-4000-8000-0000000000bb"]] as const) {
        try { await changerStatut(f.depot, { ...demande, observationIds: [id], perimetre: regional }); } catch (e) {
          expect(e).toBeInstanceOf(RefusTeledetection);
          messages.push(`${(e as RefusTeledetection).code}/${(e as RefusTeledetection).http}/${(e as Error).message}`);
        }
        expect(f.tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
        expect(f.tx.propositionTeledetectionPreuve.createMany).not.toHaveBeenCalled();
      }
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe(messages[1]);
      expect(messages[0]).toMatch(/^OBSERVATION_INEXISTANTE\/404\//);
      expect(messages[0]).not.toMatch(/[0-9a-f]{8}-/);
    });

    it("une citation partielle (une visible, une non) est refusee en entier : rien n'est ecrit", async () => {
      const { depot, tx } = faux([ligne, [{ id: "o1" }]]);
      expect(await code(changerStatut(depot, { ...demande, observationIds: ["o1", "o2"], perimetre: regional }))).toBe("OBSERVATION_INEXISTANTE/404");
      expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
    });

    it("ajouterPreuves applique le meme perimetre ; un compte national garde la lecture sans region", async () => {
      const a = faux([ligne, []]);
      expect(await code(ajouterPreuves(a.depot, { propositionId: "p1", observationIds: ["o9"], auteur: "u1", perimetre: regional }))).toBe("OBSERVATION_INEXISTANTE/404");
      const b = faux([ligne]);
      expect(await code(ajouterPreuves(b.depot, { propositionId: "p1", observationIds: ["o1"], auteur: "u1", perimetre: { national: true } }))).toBe("OK");
      expect(b.tx.observation.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it("une decision concurrente (statut change entre-temps) est refusee", async () => {
    const { depot, tx } = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    tx.propositionTeledetection.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await code(changerStatut(depot, demande))).toBe("STATUT_CHANGE_ENTRE_TEMPS/409");
  });

  it("un client DEJA dans une transaction n'en ouvre pas de seconde", async () => {
    const { tx } = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    expect(await code(changerStatut(tx as unknown as DepotTeledetection, demande))).toBe("OK");
  });
});

describe("poserVerdict (ancienne API, conservee)", () => {
  it("passe par changerStatut, donc journalise, et garde ses anciens codes", async () => {
    const a = faux([[{ statut: "A_VERIFIER", regionId: 1, motifAttente: null }]]);
    await poserVerdict(a.depot, "p1", { statut: "CONFIRMEE", motif: "m", constatRef: "c" }, { auteurId: "u1" });
    expect(a.tx.propositionTeledetectionTransition.create).toHaveBeenCalledTimes(1);
    const b = faux([[{ statut: "INFIRMEE", regionId: 1, motifAttente: null }]]);
    expect(await code(poserVerdict(b.depot, "p1", { statut: "CONFIRMEE", motif: "m", constatRef: "c" }, { auteurId: "u1" }))).toBe("VERDICT_DEJA_RENDU/409");
    expect(await code(poserVerdict(b.depot, "p1", { statut: "EN_ATTENTE", motif: "m", constatRef: "c" }, { auteurId: "u1" }))).toBe("VERDICT_INVALIDE/400");
  });
});

describe("ajouterPreuves", () => {
  it("ajoute sans decider : aucun journal de transition, aucun changement de statut", async () => {
    const { depot, tx } = faux([[{ statut: "EN_ATTENTE", regionId: 1 }]]);
    tx.propositionTeledetectionPreuve.createMany.mockResolvedValueOnce({ count: 2 });
    await ajouterPreuves(depot, { propositionId: "p1", observationIds: ["o1", "o1", "o2"], auteur: "u2" });
    expect(tx.propositionTeledetectionPreuve.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ observationId: "o1" }), expect.objectContaining({ observationId: "o2" })], skipDuplicates: true });
    expect(tx.propositionTeledetectionTransition.create).not.toHaveBeenCalled();
    expect(tx.propositionTeledetection.updateMany).not.toHaveBeenCalled();
  });
  it("refuse sur un verdict, hors perimetre, sans observation", async () => {
    expect(await code(ajouterPreuves(faux([[{ statut: "INFIRMEE", regionId: 1 }]]).depot, { propositionId: "p1", observationIds: ["o1"], auteur: "u" }))).toBe("VERDICT_DEFINITIF/409");
    expect(await code(ajouterPreuves(faux([[{ statut: "A_VERIFIER", regionId: 1 }]]).depot, { propositionId: "p1", observationIds: ["o1"], auteur: "u", perimetre: { national: false, regions: new Set([9]) } }))).toBe("HORS_PERIMETRE/403");
    expect(await code(ajouterPreuves(faux().depot, { propositionId: "p1", observationIds: [], auteur: "u" }))).toBe("OBSERVATION_INVALIDE/400");
  });
});

describe("deposerPropositions", () => {
  const produit = { id: "pr1", dateAcquisition: new Date("2026-10-02"), synthetique: false, deletedAt: null };
  const ok = { type: "INONDATION" as const, geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["Resolution native 10 m"] };
  const d = { produitId: "pr1", methodeNom: "seuil", methodeVersion: "v1", propositions: [ok] };

  it("refuse sans limites AVANT toute lecture de la base", async () => {
    const { depot, tx } = faux();
    expect(await code(deposerPropositions(depot, { ...d, propositions: [{ ...ok, limites: [] }] }, { auteurId: "u" }))).toBe("LIMITES_REQUISES/400");
    expect(tx.earthObservationProduct.findFirst).not.toHaveBeenCalled();
  });
  it("refuse une methode sans version, ou absente", async () => {
    expect(await code(deposerPropositions(faux().depot, { ...d, methodeVersion: "" }, { auteurId: "u" }))).toBe("METHODE_INCOMPLETE/400");
    expect(await code(deposerPropositions(faux().depot, { produitId: "pr1", propositions: [ok] }, { auteurId: "u" }))).toBe("METHODE_REQUISE/400");
  });
  it("refuse une tolerance hors bornes, un lot vide, un produit inconnu", async () => {
    expect(await code(deposerPropositions(faux().depot, { ...d, toleranceRattachementM: 0 }, { auteurId: "u" }))).toBe("TOLERANCE_INVALIDE/400");
    expect(await code(deposerPropositions(faux().depot, { ...d, toleranceRattachementM: 5001 }, { auteurId: "u" }))).toBe("TOLERANCE_INVALIDE/400");
    expect(await code(deposerPropositions(faux().depot, { ...d, propositions: [] }, { auteurId: "u" }))).toBe("LOT_VIDE/400");
    expect(await code(deposerPropositions(faux().depot, d, { auteurId: "u" }))).toBe("PRODUIT_INEXISTANT/404");
  });
  it("refuse un lot synthetique sur un produit reel", async () => {
    const { depot, tx } = faux();
    tx.earthObservationProduct.findFirst.mockResolvedValueOnce(produit as never);
    expect(await code(deposerPropositions(depot, { ...d, synthetique: true }, { auteurId: "u" }))).toBe("SYNTHETIQUE_INCOHERENT/400");
  });
  it("sans tolerance : aucune recherche de troncon, une insertion par proposition, un audit", async () => {
    const { depot, tx } = faux();
    tx.earthObservationProduct.findFirst.mockResolvedValueOnce(produit as never);
    const r = await deposerPropositions(depot, { ...d, propositions: [ok, ok] }, { auteurId: "u" });
    expect(r).toMatchObject({ deposees: 2, rattachees: 0, nonRattachees: 2, toleranceRattachementM: null });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(journal.filter((j) => j.startsWith("audit:"))).toEqual(["audit:CREATE:PropositionTeledetection"]);
  });
  it("avec tolerance : une recherche de troncons par proposition, la confiance est comptee", async () => {
    const { depot, tx } = faux([[{ id: "t1", code: "T1", d: 10 }]]);
    tx.earthObservationProduct.findFirst.mockResolvedValueOnce(produit as never);
    tx.propositionTeledetection.count.mockResolvedValueOnce(1 as never);
    const r = await deposerPropositions(depot, { ...d, toleranceRattachementM: 100 }, { auteurId: "u" });
    expect(r.parConfianceRattachement).toMatchObject({ HAUTE: 1, AUCUN: 0 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("Le service n'ecrit JAMAIS dans le referentiel", () => {
  const src = readFileSync(join(__dirname, "teledetection.service.ts"), "utf8");
  it("aucune ecriture SQL ne vise troncons, portions ou ouvrages", () => {
    expect(src).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(troncons|portions|ouvrages)"?/i);
  });
  it("aucun delegue Prisma du referentiel n'est ecrit (troncon, portion, ouvrage)", () => {
    expect(src).not.toMatch(/\.(troncon|portion|ouvrage)\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
  it("le type du depot ne porte meme pas les delegues du referentiel", () => {
    const type = src.slice(src.indexOf("type ClientTx"), src.indexOf("export type DepotTeledetection"));
    expect(type).not.toMatch(/"(troncon|portion|ouvrage)"/);
  });
});

describe("enregistrerProduits", () => {
  const p = (id: string, extra: Record<string, unknown> = {}) => ({
    palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: new Date("2026-10-05"), resolutionM: 10, couvertureNuagesPct: 10,
    incertitude: "x", provenance: "x", licence: "x", versionTraitement: "L2A", fournisseur: "COPERNICUS", identifiantFournisseur: id,
    collection: "SENTINEL-2", capteur: "MSI", niveauTraitement: "L2A", emprise: { type: "Polygon", coordinates: [] }, ...extra,
  });
  it("un lot vide ou invalide est refuse sans toucher la base", async () => {
    const { depot } = faux();
    expect(await code(enregistrerProduits(depot, [], { auteurId: "u" }))).toBe("LOT_VIDE/400");
    expect(await code(enregistrerProduits(depot, [p("a"), p("b", { collection: "" })], { auteurId: "u" }))).toBe("CHAMP_MANQUANT/400");
    expect(depot.$transaction).not.toHaveBeenCalled();
  });
  it("rapport {nouveaux, dejaConnus} : une insertion qui ne rend rien est un produit deja connu, relu par son identifiant fournisseur", async () => {
    const { depot, tx } = faux();
    resultatsInsertion.push(1, 0);
    tx.earthObservationProduct.findFirst.mockResolvedValueOnce({ id: "connu-1" } as never);
    const r = await enregistrerProduits(depot, [p("a"), p("b")], { auteurId: "u" });
    expect(r).toMatchObject({ nouveaux: 1, dejaConnus: 1 });
    expect(r.produits.map((x) => [x.identifiantFournisseur, x.nouveau])).toEqual([["a", true], ["b", false]]);
    expect(r.produits[1].id).toBe("connu-1");
    expect(journal.filter((j) => j.startsWith("audit:"))).toEqual(["audit:CREATE:EarthObservationProduct"]);
  });
  it("une source inconnue est refusee avant toute insertion", async () => {
    const { depot, tx } = faux();
    tx.sourceObservation.findFirst.mockResolvedValueOnce(null as never);
    expect(await code(enregistrerProduits(depot, [p("a", { sourceCode: "FANTOME" })], { auteurId: "u" }))).toBe("SOURCE_INCONNUE/404");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("la date d'acquisition de la source n'est mise a jour que par des produits reels", async () => {
    const reel = faux();
    await enregistrerProduits(reel.depot, [p("a", { sourceCode: "SENTINEL2" })], { auteurId: "u" });
    expect(reel.tx.$executeRaw).toHaveBeenCalledTimes(2); // l'insertion, puis la date de la source
    const synth = faux();
    await enregistrerProduits(synth.depot, [p("b", { sourceCode: "SENTINEL2", synthetique: true })], { auteurId: "u" });
    expect(synth.tx.$executeRaw).toHaveBeenCalledTimes(1); // l'insertion seule : pas de date de source
  });
});

describe("changerEtatSource", () => {
  it("un changement d'etat ecrit l'historique AVANT la mise a jour, avec l'auteur et le message", async () => {
    const { depot, tx } = faux([[{ id: "s1", etat: "NON_CONFIGUREE", requiertIdentifiants: false }]]);
    const r = await changerEtatSource(depot, "SENTINEL2", { vers: "ACCESSIBLE", message: "200 OK" }, { auteurId: "u1" });
    expect(r).toMatchObject({ changement: true, de: "NON_CONFIGUREE", vers: "ACCESSIBLE" });
    expect(tx.sourceObservationEtat.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceId: "s1", de: "NON_CONFIGUREE", vers: "ACCESSIBLE", message: "200 OK", auteurId: "u1" }) });
    expect(journal.indexOf("etat.create")).toBeLessThan(journal.indexOf("source.update"));
    expect(journal).toContain("audit:UPDATE:SourceObservation");
  });
  it("un etat inchange met a jour le message et la date sans ecrire d'historique", async () => {
    const { depot, tx } = faux([[{ id: "s1", etat: "ACCESSIBLE", requiertIdentifiants: false }]]);
    const r = await changerEtatSource(depot, "SENTINEL2", { vers: "ACCESSIBLE", message: "toujours joignable" }, { auteurId: "u1" });
    expect(r.changement).toBe(false);
    expect(tx.sourceObservationEtat.create).not.toHaveBeenCalled();
    expect(tx.sourceObservation.update).toHaveBeenCalledTimes(1);
  });
  it("source inconnue : 404 ; TRAITEMENT_OPERATIONNEL sans echelon : 400, rien d'ecrit", async () => {
    expect(await code(changerEtatSource(faux([[]]).depot, "X", { vers: "ACCESSIBLE", message: "m" }, { auteurId: "u" }))).toBe("SOURCE_INEXISTANTE/404");
    const { depot, tx } = faux([[{ id: "s1", etat: "ACCESSIBLE", requiertIdentifiants: false }]]);
    expect(await code(changerEtatSource(depot, "S", { vers: "TRAITEMENT_OPERATIONNEL", message: "m", preuveTraitement: "r" }, { auteurId: "u" }))).toBe("ECHELON_NON_ATTEINT/400");
    expect(tx.sourceObservationEtat.create).not.toHaveBeenCalled();
    expect(tx.sourceObservation.update).not.toHaveBeenCalled();
  });
});

describe("dispatcherVerification", () => {
  const ligne = { statut: "A_VERIFIER", missionId: null, type: "INONDATION", regionId: 4, tronconCode: "RN1-A" };
  it("la mission recoit la region de la proposition, son emprise (SQL) et le troncon dans l'intitule", async () => {
    const { depot, tx } = faux([[ligne]]);
    await dispatcherVerification(depot, "p1", {}, { auteurId: "u1" });
    expect(tx.mission.create).toHaveBeenCalledWith({ data: expect.objectContaining({ regionId: 4, type: "SURVEILLANCE", intitule: expect.stringContaining("RN1-A"), createurId: "u1" }) });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?");
    expect(sql).toMatch(/UPDATE "missions" SET "emprise" = ST_Envelope\(ST_Expand/);
    expect(tx.propositionTeledetection.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { missionId: "m1" } });
  });
  it("une proposition non rattachee donne une mission sans region (inconnue), pas une region inventee", async () => {
    const { depot, tx } = faux([[{ ...ligne, regionId: null, tronconCode: null }]]);
    await dispatcherVerification(depot, "p1", {}, { auteurId: "u1" });
    expect(tx.mission.create).toHaveBeenCalledWith({ data: expect.objectContaining({ regionId: null, intitule: expect.not.stringContaining("troncon ") }) });
  });
  it("refuse une proposition jugee, deja munie d'une mission, hors perimetre ou inconnue", async () => {
    expect(await code(dispatcherVerification(faux([[{ ...ligne, statut: "CONFIRMEE" }]]).depot, "p1", {}, { auteurId: "u" }))).toBe("VERDICT_DEJA_RENDU/409");
    expect(await code(dispatcherVerification(faux([[{ ...ligne, missionId: "m0" }]]).depot, "p1", {}, { auteurId: "u" }))).toBe("MISSION_DEJA_DEPECHEE/409");
    expect(await code(dispatcherVerification(faux([[ligne]]).depot, "p1", {}, { auteurId: "u", perimetre: { national: false, regions: new Set([9]) } }))).toBe("HORS_PERIMETRE/403");
    expect(await code(dispatcherVerification(faux([[]]).depot, "p1", {}, { auteurId: "u" }))).toBe("PROPOSITION_INEXISTANTE/404");
  });
  it("une proposition en attente peut recevoir sa mission", async () => {
    expect(await code(dispatcherVerification(faux([[{ ...ligne, statut: "EN_ATTENTE" }]]).depot, "p1", {}, { auteurId: "u" }))).toBe("OK");
  });
});

describe("calculerSynthese", () => {
  const maintenant = new Date("2026-10-25T12:00:00Z");
  /** Reponses de $queryRaw dans l'ordre : par statut, etats des sources, derniere acquisition. */
  const reponses = (parStatut: unknown[], etats: string[], derniere: unknown[] = []) => [parStatut, etats.map((etat) => ({ etat })), derniere];

  it("aucun verdict : taux nul (jamais 0), zeros vrais, aucune derniere acquisition inventee", async () => {
    const { depot } = faux(reponses([], ["NON_CONFIGUREE", "EN_ATTENTE_CONFIGURATION"]));
    const s = await calculerSynthese(depot, { maintenant });
    expect(s.propositions).toEqual({ aVerifier: 0, enAttente: 0, nonConcluantes: 0, confirmees: 0, infirmees: 0, prioritaires: 0 });
    expect(s.tauxConfirmation).toMatchObject({ valeur: null, jugees: 0, echantillonSuffisant: false, seuil: 30 });
    expect(s.derniereAcquisition).toBeNull();
    expect(s.fraicheur).toEqual({ dateCalcul: maintenant.toISOString(), ageDerniereAcquisitionJours: null });
    expect(s.sources).toMatchObject({ total: 2, actives: 0 });
  });
  it("compteurs par statut, taux = confirmees / jugees, prioritaires cumules", async () => {
    const { depot } = faux(reponses([
      { statut: "A_VERIFIER", n: 5, prioritaires: 2 }, { statut: "EN_ATTENTE", n: 1, prioritaires: 1 }, { statut: "NON_CONCLUANTE", n: 2, prioritaires: 0 },
      { statut: "CONFIRMEE", n: 6, prioritaires: 0 }, { statut: "INFIRMEE", n: 2, prioritaires: 0 },
    ], ["ACCESSIBLE"], [{ id: "pr9", source: "SENTINEL2", date: new Date("2026-10-12T00:00:00Z"), resolutionM: 10 }]));
    const s = await calculerSynthese(depot, { maintenant, depuis: new Date("2026-10-01"), jusqua: new Date("2026-10-31") });
    expect(s.propositions).toEqual({ aVerifier: 5, enAttente: 1, nonConcluantes: 2, confirmees: 6, infirmees: 2, prioritaires: 3 });
    expect(s.tauxConfirmation).toMatchObject({ confirmees: 6, infirmees: 2, jugees: 8, valeur: 0.75, echantillonSuffisant: false });
    expect(s.derniereAcquisition).toEqual({ produitId: "pr9", source: "SENTINEL2", date: "2026-10-12T00:00:00.000Z", resolutionM: 10 });
    expect(s.fraicheur.ageDerniereAcquisitionJours).toBe(13);
    expect(s.periode.depuis).toBe(new Date("2026-10-01").toISOString());
  });
  it("les donnees SYNTHETIQUES sont exclues des compteurs et de la derniere acquisition (mutation survivante M5a, constat EO-FIX-BACK 10)", async () => {
    // Le client simule ne filtre rien : on defend donc ce qui est ENVOYE a la base. Sans l'exclusion, un jeu de demonstration compterait
    // dans les chiffres de production, et la derniere acquisition serait celle d'un produit synthetique.
    const { depot, tx } = faux(reponses([{ statut: "A_VERIFIER", n: 1, prioritaires: 0 }], ["NON_CONFIGUREE"], []));
    await calculerSynthese(depot, { maintenant });
    const requetes = tx.$queryRaw.mock.calls.map((c) => JSON.stringify(c));
    const compteurs = requetes.find((q) => q.includes("GROUP BY"))!;
    const derniere = requetes.find((q) => q.includes("LIMIT 1"))!;
    expect(compteurs).toContain('NOT pt.\\"synthetique\\"');
    expect(derniere).toContain('NOT p.\\"synthetique\\"');
  });
  it("une region hors du perimetre du compte est refusee", async () => {
    const regional = { national: false as const, regions: new Set([1]) };
    expect(await code(calculerSynthese(faux().depot, { perimetre: regional, regionId: 2 }))).toBe("HORS_PERIMETRE/403");
  });
  it("les compteurs n'ont aucune constante metier : le taux passe par calculerTauxConfirmation et son seuil nomme", () => {
    const src = readFileSync(join(__dirname, "teledetection.service.ts"), "utf8");
    const bloc = src.slice(src.indexOf("export async function calculerSynthese"), src.indexOf("// ============================================================ lectures conservees"));
    expect(bloc).toContain("calculerTauxConfirmation(");
    expect(bloc).not.toMatch(/\b(30|0\.\d+)\b/);
  });
});
