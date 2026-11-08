/**
 * DEPOT EN MEMOIRE, POUR LES TESTS DU SERVICE SANS BASE.
 *
 * Il rejoue les memes conditions que les UPDATE conditionnels de `outbox.depot.ts` (reclamation
 * sous verrou, conclusion par le detenteur du verrou, relance, abandon) et la contrainte d'unicite
 * de la cle. Il ne remplace PAS la base : les declencheurs, les CHECK et la concurrence reelle
 * sont mesures par prisma/tests/outbox.test.sql et tests-integration/outbox.integration.mts.
 *
 * La transaction est un simple appel : pas de retour arriere. Les tests qui en ont besoin
 * l'indiquent (`echecAudit`).
 */
import { randomUUID } from "node:crypto";
import type {
  ConclusionTentative, DepotOutbox, EntreeAudit, FiltreListe, LigneAudit, NouvelEvenement, PortOutbox,
  TentativeAInscrire, TentativeLue,
} from "./outbox.depot";
import { CleDejaPresente, RefusBase } from "./outbox.depot";
import { STATUTS_OUTBOX, type Destination, type EvenementOutbox, type StatutOutbox } from "./types";

export interface OptionsMemoire {
  /** Imite le declencheur de la base : un motif de refus pour une source, ou null. */
  refusSource?: (sourceType: string, sourceId: string) => string | null;
}

export interface DepotMemoire extends DepotOutbox {
  evenements: EvenementOutbox[];
  tentatives: TentativeLue[];
  audits: (EntreeAudit & { id: string; createdAt: Date })[];
  /** Nombre d'ecritures (insert, update, tentative, audit) depuis la creation : un rejeu sans effet ne le change pas. */
  ecritures: () => number;
  /** Fait echouer le prochain audit : l'ecriture metier de la meme transaction doit alors etre ANNULEE par l'appelant. */
  echecAudit: { actif: boolean };
}

export function depotMemoire(options: OptionsMemoire = {}): DepotMemoire {
  const evenements: EvenementOutbox[] = [];
  const tentatives: TentativeLue[] = [];
  const audits: (EntreeAudit & { id: string; createdAt: Date })[] = [];
  let nEcritures = 0;
  const echecAudit = { actif: false };

  const copie = (e: EvenementOutbox): EvenementOutbox => ({ ...e });
  const chercher = (id: string) => evenements.find((e) => e.id === id);

  const port: PortOutbox = {
    async trouverParCle(destination, cle) {
      const e = evenements.find((x) => x.destination === destination && x.cleIdempotence === cle);
      return e ? copie(e) : null;
    },
    async inserer(n: NouvelEvenement) {
      if (evenements.some((x) => x.destination === n.destination && x.cleIdempotence === n.cleIdempotence)) throw new CleDejaPresente();
      const refus = options.refusSource?.(n.sourceType, n.sourceId) ?? null;
      if (refus) throw new RefusBase("23514", `outbox_evenements : source refusee : ${refus}`);
      const version = 1 + Math.max(0, ...evenements
        .filter((x) => x.destination === n.destination && x.typeEvenement === n.typeEvenement && x.sourceType === n.sourceType && x.sourceId === n.sourceId)
        .map((x) => x.version));
      const e: EvenementOutbox = {
        id: randomUUID(), destination: n.destination, typeEvenement: n.typeEvenement, sourceType: n.sourceType,
        sourceId: n.sourceId, version, cleIdempotence: n.cleIdempotence, chargeCanonique: n.chargeCanonique,
        empreinteCharge: n.empreinteCharge, statut: "EN_ATTENTE", tentatives: 0, tentativesMax: n.tentativesMax, relances: 0,
        prochaineTentativeLe: n.maintenant, verrouPar: null, verrouJusqua: null, dernierCode: null, dernierMessage: null,
        accuseReference: null, envoyeLe: null, abandonneLe: null, motifAbandon: null, creeParId: n.creeParId,
        createdAt: n.maintenant, updatedAt: n.maintenant,
      };
      evenements.push(e);
      nEcritures += 1;
      return copie(e);
    },
    async lire(id) { const e = chercher(id); return e ? copie(e) : null; },
    async evenementsDus(maintenant, destinations: readonly Destination[], limite) {
      return evenements
        .filter((e) => destinations.includes(e.destination)
          && (((e.statut === "EN_ATTENTE" || e.statut === "ECHEC") && e.prochaineTentativeLe <= maintenant)
            || (e.statut === "EN_COURS" && e.verrouJusqua !== null && e.verrouJusqua < maintenant)))
        .sort((a, b) => a.prochaineTentativeLe.getTime() - b.prochaineTentativeLe.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limite).map((e) => e.id);
    },
    async reclamer(p) {
      const e = chercher(p.id);
      if (!e) return null;
      const du = (e.statut === "EN_ATTENTE" || e.statut === "ECHEC") && (e.prochaineTentativeLe <= p.maintenant || p.ignorerEcheance);
      const expire = e.statut === "EN_COURS" && e.verrouJusqua !== null && e.verrouJusqua < p.maintenant;
      if (!du && !expire) return null;
      Object.assign(e, { statut: "EN_COURS", verrouPar: p.travailleur, verrouJusqua: p.verrouJusqua, updatedAt: p.maintenant });
      nEcritures += 1;
      return copie(e);
    },
    async conclure(c: ConclusionTentative) {
      const e = chercher(c.id);
      if (!e || e.statut !== "EN_COURS" || e.verrouPar !== c.travailleur) return null;
      Object.assign(e, {
        statut: c.statut, tentatives: c.tentatives,
        prochaineTentativeLe: c.prochaineTentativeLe ?? e.prochaineTentativeLe,
        verrouPar: null, verrouJusqua: null, dernierCode: c.code, dernierMessage: c.message,
        accuseReference: c.accuseReference,
        envoyeLe: c.statut === "ENVOYE" ? c.maintenant : null,
        abandonneLe: c.statut === "ABANDONNE" ? c.maintenant : null,
        motifAbandon: c.motifAbandon, updatedAt: c.maintenant,
      });
      nEcritures += 1;
      return copie(e);
    },
    async relancer(p) {
      const e = chercher(p.id);
      if (!e || (e.statut !== "ECHEC" && e.statut !== "ABANDONNE")) return null;
      Object.assign(e, { statut: "EN_ATTENTE", tentatives: 0, relances: e.relances + 1, prochaineTentativeLe: p.maintenant, abandonneLe: null, motifAbandon: null, updatedAt: p.maintenant });
      nEcritures += 1;
      return copie(e);
    },
    async abandonnerManuellement(p) {
      const e = chercher(p.id);
      if (!e) return null;
      const permis = e.statut === "EN_ATTENTE" || e.statut === "ECHEC" || (e.statut === "EN_COURS" && e.verrouJusqua !== null && e.verrouJusqua < p.maintenant);
      if (!permis) return null;
      Object.assign(e, { statut: "ABANDONNE", abandonneLe: p.maintenant, motifAbandon: p.motif, verrouPar: null, verrouJusqua: null, updatedAt: p.maintenant });
      nEcritures += 1;
      return copie(e);
    },
    async inscrireTentative(t: TentativeAInscrire) {
      const numero = 1 + Math.max(0, ...tentatives.filter((x) => x.evenementId === t.evenementId).map((x) => x.numero));
      tentatives.push({ ...t, id: randomUUID(), numero });
      nEcritures += 1;
    },
    async lister(f: FiltreListe) {
      const tous = evenements
        .filter((e) => (!f.statut || e.statut === f.statut) && (!f.destination || e.destination === f.destination))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { evenements: tous.slice(f.decalage, f.decalage + f.limite).map(copie), total: tous.length };
    },
    async compter() {
      const sortie = Object.fromEntries(STATUTS_OUTBOX.map((s) => [s, 0])) as Record<StatutOutbox, number>;
      for (const e of evenements) sortie[e.statut] += 1;
      return sortie;
    },
    async tentativesDe(id) { return tentatives.filter((t) => t.evenementId === id).map((t) => ({ ...t })); },
    async journalDe(id): Promise<LigneAudit[]> {
      return audits.filter((a) => a.entityId === id).map((a) => ({ id: a.id, userId: a.userId, action: a.action, before: a.before ?? null, after: a.after ?? null, createdAt: a.createdAt }));
    },
    async auditer(e: EntreeAudit) {
      if (echecAudit.actif) throw new Error("echec d'audit simule");
      audits.push({ ...e, id: randomUUID(), createdAt: new Date() });
      nEcritures += 1;
    },
  };

  return {
    evenements, tentatives, audits, echecAudit,
    ecritures: () => nEcritures,
    lecture: port,
    transaction: (f) => f(port),
  };
}
