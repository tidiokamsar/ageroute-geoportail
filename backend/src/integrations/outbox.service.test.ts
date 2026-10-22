import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RefusOutbox, abandonnerEvenement, detailEvenement, enregistrerEvenement, relancerEvenement, rejouerEvenement,
  traiterEvenement, traiterLot, type DepsOutbox,
} from "./outbox.service";
import { depotMemoire } from "./outbox.depot.memoire";
import { sha256Hex } from "./canonique";
import { creerAdaptateurs } from "./adaptateurs";
import { lireConfigIntegrations } from "./config";
import {
  JETON_DE_TEST, adaptateursRapides, bancDeTest, chargeBulletinExemple, chargeFicheExemple, chargeTroncon, envPour, type BancDeTest,
} from "./essais.support";
import type { Destination, EvenementOutbox } from "./types";

/**
 * SERVICE DE L'OUTBOX, contre des simulateurs ecrits par AGEROUTE et un depot en memoire.
 * Rien ici ne touche DigitalRoad, SharePoint ou la BDR / L2R. Les declencheurs et contraintes de la
 * base sont mesures ailleurs (prisma/tests/outbox.test.sql, tests-integration/outbox.integration.mts).
 *
 * Ce qui est defendu :
 *   seules les donnees VALIDEES entrent ; idempotence ; REJEU SANS EFFET DE BORD ; reprise bornee ;
 *   file morte ; verrou anti-double-envoi ; bail expire ; source invalidee entre-temps ; audit de
 *   chaque transition ; destination desactivee = rien.
 */
let banc: BancDeTest;
beforeAll(async () => { banc = await bancDeTest(); });
afterAll(async () => { await banc.fermer(); });

let deps: DepsOutbox;
let base = 0;
/** Ecritures du depot depuis le debut du test. */
const ecr = () => banc.depot.ecritures() - base;
beforeEach(() => {
  base = banc.depot.ecritures();
  for (const s of Object.values(banc.simulateurs)) s?.reinitialiser();
  banc.depot.evenements.length = 0; banc.depot.tentatives.length = 0; banc.depot.audits.length = 0;
  banc.sources.sources.clear(); banc.sources.lectures.length = 0;
  banc.horloge.maintenant = new Date("2026-10-24T08:00:00.000Z");
  deps = banc.deps;
});
afterEach(() => { banc.depot.echecAudit.actif = false; });

const BDR = () => banc.simulateurs.BDR_L2R!;
function poserTroncon(id = "t-1", surcharge: Parameters<typeof chargeTroncon>[1] = {}) {
  banc.sources.poser("Troncon", id, { emissible: true, charge: chargeTroncon(id, surcharge) });
}
const inscrire = (id = "t-1") => enregistrerEvenement(deps, { destination: "BDR_L2R", sourceType: "Troncon", sourceId: id, creeParId: "u-1" });
const evt = (id: string): EvenementOutbox => banc.depot.evenements.find((e) => e.id === id)!;
const transitionsAudit = () => banc.depot.audits.map((a) => (a.after as { transition?: string })?.transition);

describe("seules les donnees VALIDEES entrent", () => {
  it.each([
    ["A_VALIDER", "troncon t-1 au statut A_VALIDER : seul VALIDE est emis"],
    ["REJETE", "troncon t-1 au statut REJETE : seul VALIDE est emis"],
    ["A_CORRIGER", "troncon t-1 au statut A_CORRIGER : seul VALIDE est emis"],
    ["NUL", "troncon t-1 au statut NUL : seul VALIDE est emis"],
    ["supprime", "troncon t-1 supprime logiquement"],
  ])("un troncon %s est refuse : rien n'est inscrit, rien n'est audite", async (_cas, motif) => {
    banc.sources.poser("Troncon", "t-1", { emissible: false, motif });
    await expect(inscrire()).rejects.toMatchObject({ code: "SOURCE_NON_EMISSIBLE" });
    expect(banc.depot.evenements).toHaveLength(0);
    expect(banc.depot.audits).toHaveLength(0);
    expect(ecr()).toBe(0);
  });

  it("une source inconnue est refusee", async () => {
    await expect(inscrire("fantome")).rejects.toMatchObject({ code: "SOURCE_INCONNUE" });
    expect(ecr()).toBe(0);
  });

  it("une source valide est inscrite EN_ATTENTE, avec cle, empreinte, version 1 et un audit CREATE", async () => {
    poserTroncon();
    const { evenement, dejaEnregistre } = await inscrire();
    expect(dejaEnregistre).toBe(false);
    expect(evenement).toMatchObject({ destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", sourceType: "Troncon", sourceId: "t-1", version: 1, statut: "EN_ATTENTE", tentatives: 0 });
    expect(evenement.cleIdempotence).toMatch(/^[0-9a-f]{64}$/);
    expect(evenement.empreinteCharge).toBe(sha256Hex(evenement.chargeCanonique));
    expect(banc.depot.audits).toHaveLength(1);
    expect(banc.depot.audits[0]).toMatchObject({ action: "CREATE", entityId: evenement.id, userId: "u-1" });
  });

  it("la destination ne recoit que ses sources : un troncon ne va pas vers SharePoint", async () => {
    poserTroncon();
    await expect(enregistrerEvenement(deps, { destination: "SHAREPOINT", sourceType: "Troncon", sourceId: "t-1", creeParId: "u-1" }))
      .rejects.toMatchObject({ code: "SOURCE_INCONNUE" });
    expect(ecr()).toBe(0);
  });

  it("une fiche d'intervention ne peut pas etre inscrite tant qu'aucune table de fiches n'existe (la source la refuse)", async () => {
    banc.sources.poser("FicheIntervention", "f-1", { emissible: false, motif: "aucune table de fiches d'intervention" });
    await expect(enregistrerEvenement(deps, { destination: "DIGITALROAD", sourceType: "FicheIntervention", sourceId: "f-1", creeParId: "u-1" }))
      .rejects.toMatchObject({ code: "SOURCE_NON_EMISSIBLE" });
  });

  it("une charge non conforme au contrat n'est pas inscrite", async () => {
    banc.sources.poser("Troncon", "t-1", { emissible: true, charge: { x: 1 } });
    await expect(inscrire()).rejects.toMatchObject({ code: "CHARGE_NON_CONFORME" });
    expect(ecr()).toBe(0);
  });

  it("une charge qui porterait une cle interne n'est pas inscrite, meme si elle passait le contrat", async () => {
    const charge = JSON.parse(JSON.stringify(chargeTroncon()));
    charge.features[0].properties.created_by = "u-9";
    banc.sources.poser("Troncon", "t-1", { emissible: true, charge });
    await expect(inscrire()).rejects.toMatchObject({ code: "CHAMP_INTERNE_DANS_CHARGE" });
    expect(ecr()).toBe(0);
  });

  it("une charge non canonique (nombre non fini) n'est pas inscrite", async () => {
    const charge = JSON.parse(JSON.stringify(chargeTroncon()));
    charge.features[0].properties.longueur_km = Number.NaN;
    banc.sources.poser("Troncon", "t-1", { emissible: true, charge });
    await expect(inscrire()).rejects.toBeInstanceOf(RefusOutbox);
    expect(ecr()).toBe(0);
  });

  it("le declencheur de la base est le filet : une source devenue non valide entre la lecture et l'insertion est refusee", async () => {
    const depot = depotMemoire({ refusSource: () => "troncon t-1 au statut REJETE : seul VALIDE est emis" });
    poserTroncon();
    await expect(enregistrerEvenement({ ...deps, depot }, { destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1", creeParId: "u-1" }))
      .rejects.toMatchObject({ code: "SOURCE_NON_EMISSIBLE" });
    expect(depot.evenements).toHaveLength(0);
  });
});

describe("idempotence", () => {
  it("inscrire deux fois le meme contenu rend le meme evenement, SANS ecriture ni audit supplementaire", async () => {
    poserTroncon();
    const a = await inscrire();
    const ecritures = ecr();
    const b = await inscrire();
    expect(b.dejaEnregistre).toBe(true);
    expect(b.evenement.id).toBe(a.evenement.id);
    expect(banc.depot.evenements).toHaveLength(1);
    expect(banc.depot.audits).toHaveLength(1);
    expect(ecr()).toBe(ecritures);
  });

  it("la cle est deterministe : deux depots independants calculent la meme cle", async () => {
    poserTroncon();
    const a = await inscrire();
    const autre = depotMemoire();
    const b = await enregistrerEvenement({ ...deps, depot: autre }, { destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1", creeParId: "u-2" });
    expect(b.evenement.cleIdempotence).toBe(a.evenement.cleIdempotence);
  });

  it("dix inscriptions simultanees du meme contenu n'en font qu'une", async () => {
    poserTroncon();
    const r = await Promise.all(Array.from({ length: 10 }, () => inscrire()));
    expect(new Set(r.map((x) => x.evenement.id)).size).toBe(1);
    expect(banc.depot.evenements).toHaveLength(1);
    expect(r.filter((x) => !x.dejaEnregistre)).toHaveLength(1);
  });

  it("un contenu modifie cree un NOUVEL evenement (version 2) et ne touche pas l'ancien", async () => {
    poserTroncon("t-1", { longueurKm: 2.5 });
    const a = await inscrire();
    poserTroncon("t-1", { longueurKm: 3.1 });
    const b = await inscrire();
    expect(b.dejaEnregistre).toBe(false);
    expect(b.evenement.version).toBe(2);
    expect(b.evenement.cleIdempotence).not.toBe(a.evenement.cleIdempotence);
    expect(evt(a.evenement.id).chargeCanonique).toContain("2.5");
  });

  it("revenir a un ancien contenu retrouve l'evenement d'origine (meme cle) au lieu d'en creer un troisieme", async () => {
    poserTroncon("t-1", { longueurKm: 2.5 });
    const a = await inscrire();
    poserTroncon("t-1", { longueurKm: 3.1 });
    await inscrire();
    poserTroncon("t-1", { longueurKm: 2.5 });
    const c = await inscrire();
    expect(c.dejaEnregistre).toBe(true);
    expect(c.evenement.id).toBe(a.evenement.id);
    expect(banc.depot.evenements).toHaveLength(2);
  });
});

describe("emission et REJEU SANS EFFET DE BORD", () => {
  it("emet, passe a ENVOYE, enregistre l'accuse, une tentative et les deux transitions auditees", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    const r = await traiterEvenement(deps, evenement.id);
    expect(r).toMatchObject({ traite: true, statut: "ENVOYE", issue: "ACCEPTE" });
    const e = evt(evenement.id);
    expect(e).toMatchObject({ statut: "ENVOYE", tentatives: 1, verrouPar: null, verrouJusqua: null, dernierCode: null });
    expect(e.accuseReference).toMatch(/^SIM-/);
    expect(e.envoyeLe).toEqual(banc.horloge.maintenant);
    expect(BDR().requetes).toHaveLength(1);
    expect(banc.depot.tentatives).toHaveLength(1);
    expect(banc.depot.tentatives[0]).toMatchObject({ numero: 1, issue: "ACCEPTE", codeHttp: 200, travailleur: "w-test" });
    expect(transitionsAudit()).toEqual(["(nouveau)>EN_ATTENTE", "EN_ATTENTE>EN_COURS", "EN_COURS>ENVOYE"]);
  });

  it("REJOUER un evenement deja envoye n'emet rien et ne modifie rien (ligne, tentatives, audit, simulateur)", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    const avant = JSON.stringify(evt(evenement.id));
    const ecritures = ecr();
    const requetes = BDR().requetes.length;
    const audits = banc.depot.audits.length;
    const tentatives = banc.depot.tentatives.length;

    for (let i = 0; i < 3; i += 1) {
      expect(await rejouerEvenement(deps, evenement.id)).toEqual({ traite: false, id: evenement.id, raison: "DEJA_ENVOYE" });
      expect(await traiterEvenement(deps, evenement.id)).toEqual({ traite: false, id: evenement.id, raison: "DEJA_ENVOYE" });
    }
    expect(BDR().requetes).toHaveLength(requetes);
    expect(BDR().effets.size).toBe(1);
    expect(banc.depot.audits).toHaveLength(audits);
    expect(banc.depot.tentatives).toHaveLength(tentatives);
    expect(ecr()).toBe(ecritures);
    expect(JSON.stringify(evt(evenement.id))).toBe(avant);
  });

  it("re-inscrire un contenu deja envoye ne cree rien et ne declenche aucun envoi", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    const ecritures = ecr();
    const b = await inscrire();
    expect(b.dejaEnregistre).toBe(true);
    expect(b.evenement.statut).toBe("ENVOYE");
    expect(ecr()).toBe(ecritures);
    expect(BDR().requetes).toHaveLength(1);
  });

  it("traiter un lot apres envoi n'emet rien de plus", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    const r = await traiterLot(deps, 10);
    expect(r.examines).toBe(0);
    expect(BDR().requetes).toHaveLength(1);
  });

  it("un evenement introuvable ne fait rien", async () => {
    expect(await traiterEvenement(deps, "inconnu")).toEqual({ traite: false, id: "inconnu", raison: "EVENEMENT_INTROUVABLE" });
    expect(BDR().requetes).toHaveLength(0);
  });

  it("l'enveloppe emise ne contient que les champs du contrat, jamais l'identifiant interne de l'evenement ni l'auteur", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    const corps = BDR().requetes[0].corps;
    expect(corps).not.toContain(evenement.id);
    expect(corps).not.toContain("u-1");
    expect(corps).not.toContain(JETON_DE_TEST);
  });

  it("le doublon reconnu par le destinataire vaut ENVOYE", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "doublon" });
    const r = await traiterEvenement(deps, evenement.id);
    expect(r).toMatchObject({ traite: true, statut: "ENVOYE", issue: "DOUBLON_RECONNU", doublon: true });
  });
});

describe("reprise apres echec, temporisation, file morte", () => {
  it("un 503 passe a ECHEC, reprise programmee a maintenant + delai, et l'evenement n'est PAS du avant", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    const r = await traiterEvenement(deps, evenement.id);
    expect(r).toMatchObject({ traite: true, statut: "ECHEC", issue: "ECHEC_TEMPORAIRE", code: "HTTP_503" });
    const e = evt(evenement.id);
    expect(e).toMatchObject({ statut: "ECHEC", tentatives: 1, dernierCode: "HTTP_503", verrouPar: null });
    expect(e.prochaineTentativeLe.getTime()).toBe(banc.horloge.maintenant.getTime() + 1_000);
    // Pas encore du : ni traiter ni le lot n'y touchent.
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ traite: false, raison: "NON_DU_OU_VERROUILLE" });
    expect((await traiterLot(deps, 10)).examines).toBe(0);
    expect(BDR().requetes).toHaveLength(1);
  });

  it("une fois l'echeance passee, le lot reprend et l'evenement est ENVOYE", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await traiterEvenement(deps, evenement.id);
    banc.horloge.avancer(1_000);
    const lot = await traiterLot(deps, 10);
    expect(lot.examines).toBe(1);
    expect(lot.resultats[0]).toMatchObject({ traite: true, statut: "ENVOYE" });
    expect(evt(evenement.id)).toMatchObject({ statut: "ENVOYE", tentatives: 2 });
    expect(BDR().requetes).toHaveLength(2);
    expect(BDR().effets.size).toBe(1);
    expect(banc.depot.tentatives.map((t) => [t.numero, t.issue])).toEqual([[1, "ECHEC_TEMPORAIRE"], [2, "ACCEPTE"]]);
  });

  it("le delai double a chaque echec", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().definirDefaut({ type: "erreur5xx" });
    const delais: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const avant = banc.horloge.maintenant.getTime();
      await traiterEvenement(deps, evenement.id, { ignorerEcheance: true });
      delais.push(evt(evenement.id).prochaineTentativeLe.getTime() - avant);
    }
    expect(delais).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("apres tentativesMax echecs, l'evenement part en FILE MORTE avec son motif, et n'est plus jamais pris", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().definirDefaut({ type: "erreur5xx" });
    for (let i = 0; i < 8; i += 1) {
      banc.horloge.avancer(3_600_000);
      await traiterLot(deps, 10);
    }
    const e = evt(evenement.id);
    expect(e).toMatchObject({ statut: "ABANDONNE", tentatives: 8, dernierCode: "HTTP_503" });
    expect(e.motifAbandon).toContain("TENTATIVES_EPUISEES");
    expect(e.abandonneLe).not.toBeNull();
    expect(BDR().requetes).toHaveLength(8);
    banc.horloge.avancer(86_400_000);
    expect((await traiterLot(deps, 10)).examines).toBe(0);
    expect(await rejouerEvenement(deps, evenement.id)).toMatchObject({ traite: false, raison: "ABANDONNE" });
    expect(BDR().requetes).toHaveLength(8);
    expect(banc.depot.tentatives).toHaveLength(8);
  });

  it("un refus definitif (422) part directement en file morte, apres UNE seule tentative", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "refus4xx", statut: 422 });
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ traite: true, statut: "ABANDONNE", code: "HTTP_422" });
    expect(evt(evenement.id).motifAbandon).toContain("REFUS_DEFINITIF");
    expect(BDR().requetes).toHaveLength(1);
  });

  it("un delai depasse est un echec temporaire, borne comme les autres", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "timeout" });
    const rapide = { ...deps, adaptateurs: adaptateursRapides(banc.simulateurs, banc.fetch) };
    expect(await traiterEvenement(rapide, evenement.id)).toMatchObject({ statut: "ECHEC", code: "TIMEOUT" });
  });

  it("un accuse invalide est retente, puis reconnu comme doublon (le destinataire avait traite)", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "accuse-invalide", variante: "texte" });
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ECHEC", issue: "ACCUSE_INVALIDE" });
    banc.horloge.avancer(1_000);
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ENVOYE", issue: "DOUBLON_RECONNU" });
    expect(BDR().effets.size).toBe(1);
  });

  it("chaque tentative est archivee avec son issue, sans corps de reponse ni secret", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "refus4xx", statut: 401 });
    await traiterEvenement(deps, evenement.id);
    const t = banc.depot.tentatives[0];
    expect(t).toMatchObject({ issue: "ECHEC_DEFINITIF", codeHttp: 401, codeErreur: "HTTP_401" });
    expect(JSON.stringify([t, evt(evenement.id), banc.depot.audits])).not.toContain(JETON_DE_TEST);
    expect(JSON.stringify([t, evt(evenement.id), banc.depot.audits])).not.toContain("127.0.0.1");
  });
});

describe("relance et abandon humains", () => {
  async function enEchec() {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await traiterEvenement(deps, evenement.id);
    return evenement.id;
  }
  async function enFileMorte(tronconId = "t-1") {
    poserTroncon(tronconId);
    const { evenement } = await inscrire(tronconId);
    BDR().programmer({ type: "refus4xx", statut: 422 });
    await traiterEvenement(deps, evenement.id);
    return evenement.id;
  }

  it("relancer un evenement ECHEC : EN_ATTENTE, tentatives remises a zero, relances + 1, du immediatement, audite avec l'auteur et le motif", async () => {
    const id = await enEchec();
    const e = await relancerEvenement(deps, id, { utilisateurId: "u-admin", motif: "service retabli" });
    expect(e).toMatchObject({ statut: "EN_ATTENTE", tentatives: 0, relances: 1, motifAbandon: null });
    const a = banc.depot.audits.at(-1)!;
    expect(a).toMatchObject({ userId: "u-admin", action: "UPDATE", entityId: id });
    expect(a.after).toMatchObject({ transition: "ECHEC>EN_ATTENTE", motif: "service retabli" });
    const r = await traiterEvenement(deps, id);
    expect(r).toMatchObject({ statut: "ENVOYE" });
  });

  it("relancer un evenement de la file morte le remet en file", async () => {
    const id = await enFileMorte();
    expect(evt(id).statut).toBe("ABANDONNE");
    const e = await relancerEvenement(deps, id, { utilisateurId: "u-admin", motif: "destinataire corrige" });
    expect(e).toMatchObject({ statut: "EN_ATTENTE", relances: 1, abandonneLe: null, motifAbandon: null });
    expect(await traiterEvenement(deps, id)).toMatchObject({ statut: "ENVOYE" });
    expect(banc.depot.tentatives.map((t) => t.numero)).toEqual([1, 2]);
  });

  it("relancer un evenement ENVOYE est refuse : il a ete remis, le rejeu est sans effet", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    const ecritures = ecr();
    await expect(relancerEvenement(deps, evenement.id, { utilisateurId: "u-admin", motif: "essai" })).rejects.toMatchObject({ code: "DEJA_ENVOYE" });
    expect(ecr()).toBe(ecritures);
  });

  it("relancer un evenement EN_ATTENTE est refuse (il n'a pas echoue)", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await expect(relancerEvenement(deps, evenement.id, { utilisateurId: "u-admin", motif: "essai" })).rejects.toMatchObject({ code: "TRANSITION_INTERDITE" });
  });

  it.each(["", "  ", "ab"])("relancer et abandonner exigent un motif (%j)", async (motif) => {
    const id = await enEchec();
    await expect(relancerEvenement(deps, id, { utilisateurId: "u", motif })).rejects.toMatchObject({ code: "MOTIF_REQUIS" });
    await expect(abandonnerEvenement(deps, id, { utilisateurId: "u", motif })).rejects.toMatchObject({ code: "MOTIF_REQUIS" });
    expect(evt(id).statut).toBe("ECHEC");
  });

  it("abandonner avec motif : ABANDONNE, motif conserve, audite ; l'evenement reste lisible", async () => {
    const id = await enEchec();
    const e = await abandonnerEvenement(deps, id, { utilisateurId: "u-admin", motif: "donnee remplacee" });
    expect(e).toMatchObject({ statut: "ABANDONNE" });
    expect(e.motifAbandon).toBe("ABANDON_HUMAIN : donnee remplacee");
    expect(banc.depot.evenements.some((x) => x.id === id)).toBe(true);
    expect(banc.depot.audits.at(-1)!.after).toMatchObject({ transition: "ECHEC>ABANDONNE", motif: "donnee remplacee" });
  });

  it("abandonner un evenement ENVOYE ou deja ABANDONNE est refuse", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await traiterEvenement(deps, evenement.id);
    await expect(abandonnerEvenement(deps, evenement.id, { utilisateurId: "u", motif: "essai" })).rejects.toMatchObject({ code: "DEJA_ENVOYE" });
    const id = await enFileMorte("t-9");
    await expect(abandonnerEvenement(deps, id, { utilisateurId: "u", motif: "essai" })).rejects.toMatchObject({ code: "TRANSITION_INTERDITE" });
  });

  it("abandonner un evenement dont le bail est vivant est refuse ; une fois le bail expire, c'est permis", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    await banc.depot.lecture.reclamer({ id: evenement.id, travailleur: "w-autre", maintenant: banc.horloge.maintenant, verrouJusqua: new Date(banc.horloge.maintenant.getTime() + 60_000), ignorerEcheance: false });
    await expect(abandonnerEvenement(deps, evenement.id, { utilisateurId: "u", motif: "essai" })).rejects.toMatchObject({ code: "VERROU_ACTIF" });
    banc.horloge.avancer(61_000);
    await expect(abandonnerEvenement(deps, evenement.id, { utilisateurId: "u", motif: "travailleur mort" })).resolves.toMatchObject({ statut: "ABANDONNE" });
  });

  it("un evenement introuvable est signale", async () => {
    await expect(relancerEvenement(deps, "x", { utilisateurId: "u", motif: "essai" })).rejects.toMatchObject({ code: "EVENEMENT_INTROUVABLE" });
    await expect(abandonnerEvenement(deps, "x", { utilisateurId: "u", motif: "essai" })).rejects.toMatchObject({ code: "EVENEMENT_INTROUVABLE" });
    await expect(detailEvenement(deps, "x")).rejects.toMatchObject({ code: "EVENEMENT_INTROUVABLE" });
  });
});

describe("verrou anti-double-envoi", () => {
  it("dix travailleurs simultanes sur le meme evenement : UN SEUL envoi", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "lent", ms: 80 });
    const resultats = await Promise.all(Array.from({ length: 10 }, (_, i) => traiterEvenement({ ...deps, travailleur: `w-${i}` }, evenement.id)));
    expect(resultats.filter((r) => r.traite)).toHaveLength(1);
    expect(resultats.filter((r) => !r.traite).every((r) => !r.traite && (r.raison === "NON_DU_OU_VERROUILLE" || r.raison === "DEJA_ENVOYE"))).toBe(true);
    expect(BDR().requetes).toHaveLength(1);
    expect(BDR().effets.size).toBe(1);
    expect(banc.depot.tentatives).toHaveLength(1);
  });

  it("deux travailleurs qui se disputent un lot ne se partagent pas un evenement", async () => {
    for (let i = 0; i < 5; i += 1) { poserTroncon(`t-${i}`); await inscrire(`t-${i}`); }
    const [a, b] = await Promise.all([traiterLot({ ...deps, travailleur: "w-a" }, 10), traiterLot({ ...deps, travailleur: "w-b" }, 10)]);
    const ids = [...a.resultats, ...b.resultats].filter((r) => r.traite).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
    expect(BDR().effets.size).toBe(5);
    expect(BDR().requetes).toHaveLength(5);
  });

  it("un travailleur mort (bail expire) : un autre reprend avec la MEME cle, et le destinataire ne cree pas un second effet", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    // Le premier travailleur envoie, puis meurt avant d'ecrire le resultat : on le simule en
    // reclamant a la main et en emettant directement.
    const premier = await banc.depot.lecture.reclamer({ id: evenement.id, travailleur: "w-mort", maintenant: banc.horloge.maintenant, verrouJusqua: new Date(banc.horloge.maintenant.getTime() + 60_000), ignorerEcheance: false });
    expect(premier?.statut).toBe("EN_COURS");
    await deps.adaptateurs.BDR_L2R!.emettre({
      evenementId: evenement.id, destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", version: 1,
      cleIdempotence: evenement.cleIdempotence, empreinteCharge: evenement.empreinteCharge, charge: JSON.parse(evenement.chargeCanonique),
    });
    expect(BDR().effets.size).toBe(1);
    // Tant que le bail court, personne ne reprend.
    expect(await traiterEvenement({ ...deps, travailleur: "w-vivant" }, evenement.id)).toMatchObject({ traite: false, raison: "NON_DU_OU_VERROUILLE" });
    banc.horloge.avancer(61_000);
    const r = await traiterEvenement({ ...deps, travailleur: "w-vivant" }, evenement.id);
    expect(r).toMatchObject({ traite: true, statut: "ENVOYE", issue: "DOUBLON_RECONNU" });
    expect(BDR().requetes).toHaveLength(2);
    expect(BDR().requetes[0].corps).toBe(BDR().requetes[1].corps);
    expect(BDR().effets.size).toBe(1);
  });

  it("un travailleur qui a perdu son bail ne peut pas conclure : rien n'est ecrit", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "lent", ms: 300 });
    const lent = traiterEvenement({ ...deps, travailleur: "w-lent" }, evenement.id);
    // On attend que la requete du premier travailleur soit arrivee (et non un delai fixe : sous charge, il serait fragile).
    for (let i = 0; i < 500 && BDR().requetes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(BDR().requetes).toHaveLength(1);
    // Le bail de w-lent expire (l'horloge avance) et un autre travailleur reprend.
    banc.horloge.avancer(banc.config.verrouMs + 1_000);
    const reprise = await traiterEvenement({ ...deps, travailleur: "w-reprise" }, evenement.id);
    expect(reprise).toMatchObject({ traite: true, statut: "ENVOYE" });
    expect(await lent).toEqual({ traite: false, id: evenement.id, raison: "VERROU_PERDU" });
    expect(banc.depot.tentatives).toHaveLength(1);
    expect(BDR().effets.size).toBe(1);
  });
});

describe("la source est relue a l'envoi", () => {
  it("une donnee rejetee entre l'inscription et l'envoi n'est PAS emise : ABANDONNE, aucun appel", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    banc.sources.poser("Troncon", "t-1", { emissible: false, motif: "troncon t-1 au statut REJETE : seul VALIDE est emis" });
    const r = await traiterEvenement(deps, evenement.id);
    expect(r).toMatchObject({ traite: true, statut: "ABANDONNE", code: "SOURCE_NON_VALIDE_A_L_ENVOI", issue: null });
    expect(evt(evenement.id).motifAbandon).toContain("SOURCE_NON_VALIDE_A_L_ENVOI");
    expect(BDR().requetes).toHaveLength(0);
    expect(banc.depot.tentatives).toHaveLength(0);
  });

  it("une donnee supprimee logiquement entre-temps n'est pas emise non plus", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    banc.sources.poser("Troncon", "t-1", { emissible: false, motif: "troncon t-1 supprime logiquement" });
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ABANDONNE" });
    expect(BDR().requetes).toHaveLength(0);
  });

  it("une relecture impossible de la source est un echec temporaire COMPTE (borne), sans appel reseau", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    const casse = { ...deps, sources: { lire: async () => { throw new Error("base indisponible"); } } };
    const r = await traiterEvenement(casse, evenement.id);
    expect(r).toMatchObject({ statut: "ECHEC", code: "SOURCE_ILLISIBLE" });
    expect(evt(evenement.id).tentatives).toBe(1);
    expect(BDR().requetes).toHaveLength(0);
  });

  it("une charge archivee dont l'empreinte ne correspond plus n'est pas emise (base contournee)", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    evt(evenement.id).chargeCanonique = evt(evenement.id).chargeCanonique.replace("RN1-001", "RN9-999");
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ABANDONNE", code: "CHARGE_ALTEREE" });
    expect(BDR().requetes).toHaveLength(0);
  });

  it("c'est la charge FIGEE a l'inscription qui part, pas l'etat courant de la source", async () => {
    poserTroncon("t-1", { longueurKm: 2.5 });
    const { evenement } = await inscrire();
    poserTroncon("t-1", { longueurKm: 9.9 });
    await traiterEvenement(deps, evenement.id);
    expect(BDR().requetes[0].corps).toContain("2.5");
    expect(BDR().requetes[0].corps).not.toContain("9.9");
  });
});

describe("destination desactivee", () => {
  it("rien n'est inscrit pour une destination sans adaptateur", async () => {
    poserTroncon();
    const sansBdr = { ...deps, adaptateurs: creerAdaptateurs(lireConfigIntegrations({})) };
    await expect(enregistrerEvenement(sansBdr, { destination: "BDR_L2R", sourceType: "Troncon", sourceId: "t-1", creeParId: "u-1" }))
      .rejects.toMatchObject({ code: "DESTINATION_DESACTIVEE" });
    expect(ecr()).toBe(0);
    expect(banc.sources.lectures).toEqual([]);
  });

  it("un evenement dont la destination a ete desactivee ensuite n'est ni reclame ni emis", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    const coupe = { ...deps, adaptateurs: {} };
    expect(await traiterEvenement(coupe, evenement.id)).toEqual({ traite: false, id: evenement.id, raison: "DESTINATION_DESACTIVEE" });
    expect(await traiterLot(coupe, 10)).toEqual({ examines: 0, resultats: [] });
    expect(evt(evenement.id).statut).toBe("EN_ATTENTE");
    expect(BDR().requetes).toHaveLength(0);
  });
});

describe("audit de chaque transition", () => {
  it("le chemin ECHEC puis ENVOYE laisse une trace pour chaque transition, dans l'ordre", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await traiterEvenement(deps, evenement.id);
    banc.horloge.avancer(1_000);
    await traiterEvenement(deps, evenement.id);
    expect(transitionsAudit()).toEqual([
      "(nouveau)>EN_ATTENTE", "EN_ATTENTE>EN_COURS", "EN_COURS>ECHEC", "ECHEC>EN_COURS", "EN_COURS>ENVOYE",
    ]);
    const detail = await detailEvenement(deps, evenement.id);
    expect(detail.journal).toHaveLength(5);
    expect(detail.tentatives).toHaveLength(2);
  });

  it("l'audit ne contient ni la charge, ni le jeton, ni le corps des reponses", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "erreur5xx" });
    await traiterEvenement(deps, evenement.id);
    const texte = JSON.stringify(banc.depot.audits);
    expect(texte).not.toContain(JETON_DE_TEST);
    expect(texte).not.toContain("RN1-001");
    expect(texte).not.toContain("coordinates");
  });

  it("les transitions du systeme n'ont pas d'auteur ; celles d'un humain portent son identifiant", async () => {
    poserTroncon();
    const { evenement } = await inscrire();
    BDR().programmer({ type: "refus4xx", statut: 422 });
    await traiterEvenement(deps, evenement.id);
    await relancerEvenement(deps, evenement.id, { utilisateurId: "u-admin", motif: "corrige" });
    expect(banc.depot.audits.map((a) => a.userId)).toEqual(["u-1", null, null, "u-admin"]);
  });
});

describe("les trois destinations, de bout en bout", () => {
  it("SharePoint : le bulletin archive est emis une fois, et le rejeu est sans effet", async () => {
    banc.sources.poser("BulletinRoutier", "b-1", { emissible: true, charge: chargeBulletinExemple() });
    const { evenement } = await enregistrerEvenement(deps, { destination: "SHAREPOINT", sourceType: "BulletinRoutier", sourceId: "b-1", creeParId: "u-1" });
    expect(evenement.typeEvenement).toBe("DEPOT_BULLETIN_ROUTIER");
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ENVOYE" });
    expect(await rejouerEvenement(deps, evenement.id)).toMatchObject({ raison: "DEJA_ENVOYE" });
    expect(banc.simulateurs.SHAREPOINT!.requetes).toHaveLength(1);
  });

  it("DigitalRoad : le service sait emettre une fiche APPROUVEE si une source la fournit (simulee ici)", async () => {
    // Aucune table de fiches n'existe : cette source est INJECTEE par le test. Elle prouve que la
    // mecanique tient pour DigitalRoad, pas qu'une fiche puisse etre inscrite dans l'etat actuel du produit.
    banc.sources.poser("FicheIntervention", "fiche-2027-001", { emissible: true, charge: chargeFicheExemple() });
    const { evenement } = await enregistrerEvenement(deps, { destination: "DIGITALROAD", sourceType: "FicheIntervention", sourceId: "fiche-2027-001", creeParId: "u-1" });
    expect(await traiterEvenement(deps, evenement.id)).toMatchObject({ statut: "ENVOYE" });
    const q = banc.simulateurs.DIGITALROAD!.requetes[0];
    expect(q.enveloppeConforme).toBe(true);
    // L'accuse est conserve mais aucun statut de fiche n'est ecrit : le service ne connait pas de fiche.
    expect(evt(evenement.id).accuseReference).toMatch(/^SIM-DIGITALROAD/);
  });

  it("les destinations sont independantes : la panne de l'une ne bloque pas l'autre", async () => {
    poserTroncon();
    banc.sources.poser("BulletinRoutier", "b-1", { emissible: true, charge: chargeBulletinExemple() });
    const a = await inscrire();
    const b = await enregistrerEvenement(deps, { destination: "SHAREPOINT", sourceType: "BulletinRoutier", sourceId: "b-1", creeParId: "u-1" });
    BDR().definirDefaut({ type: "erreur5xx" });
    const lot = await traiterLot(deps, 10);
    expect(lot.examines).toBe(2);
    expect(evt(a.evenement.id).statut).toBe("ECHEC");
    expect(evt(b.evenement.id).statut).toBe("ENVOYE");
  });
});

describe("lecture", () => {
  it("compte les evenements par etat", async () => {
    poserTroncon("t-1"); poserTroncon("t-2");
    const a = await inscrire("t-1"); await inscrire("t-2");
    await traiterEvenement(deps, a.evenement.id);
    const c = await deps.depot.lecture.compter();
    expect(c).toEqual({ EN_ATTENTE: 1, EN_COURS: 0, ENVOYE: 1, ECHEC: 0, ABANDONNE: 0 });
  });
});

// Reference pour eviter un import mort si la liste des destinations evolue.
const _DESTINATIONS: Destination[] = ["DIGITALROAD", "SHAREPOINT", "BDR_L2R"];
void _DESTINATIONS;
void envPour;
