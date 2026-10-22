/**
 * SERVICE DE L'OUTBOX : inscrire, emettre, rejouer, relancer, abandonner.
 *
 * CE QUE CE SERVICE GARANTIT, ET OU C'EST VERIFIE
 *
 *   seules les donnees VALIDEES entrent     la source est relue ICI (outbox_source_refus) puis a
 *                                           l'insertion par le declencheur de la base, et RELUE a
 *                                           l'envoi : une donnee rejetee ou supprimee entre-temps
 *                                           n'est pas emise
 *   idempotence                             cle = SHA-256 deterministe du contenu ; le meme contenu
 *                                           deux fois rend l'evenement existant, SANS ecriture ni audit
 *   rejeu sans effet de bord                rejouer un evenement ENVOYE ne contacte personne, n'ecrit
 *                                           rien (ni ligne, ni tentative, ni audit)
 *   un seul envoi a la fois                 reclamation par UPDATE conditionnel + bail ; un travailleur
 *                                           mort perd son bail, un autre reprend avec la MEME cle
 *   reprise bornee                          temporisation exponentielle plafonnee, tentatives bornees,
 *                                           puis file morte (ABANDONNE) ; la relance est humaine
 *   audit de chaque transition              dans la meme transaction que la transition
 *   rien n'est invente                      une charge non conforme au contrat, ou portant une cle
 *                                           interne, n'est ni inscrite ni emise
 *
 * LIVRAISON AU MOINS UNE FOIS, EFFET UNIQUE SI LE DESTINATAIRE HONORE LA CLE. Si le travailleur
 * meurt entre l'appel reseau et l'ecriture du resultat, l'evenement sera re-emis avec la meme cle.
 * Que DigitalRoad, SharePoint ou l'ONR deduplique sur cette cle n'est PAS etabli (voir
 * CHAMPS_A_CONFIRMER) : c'est un prerequis du passage au reel.
 *
 * Aucun appel reseau ne se fait dans une transaction.
 */
import { randomBytes } from "node:crypto";
import { canonique, cleIdempotence, ChargeNonCanonique, sha256Hex } from "./canonique";
import { decider, type PolitiqueReprise } from "./etat.noyau";
import type { Adaptateurs } from "./adaptateurs";
import {
  CleDejaPresente, RefusBase, type DepotOutbox, type FiltreListe, type LigneAudit, type TentativeLue,
} from "./outbox.depot";
import type { LecteurSources } from "./sources.depot";
import { trouverChampInterne } from "./sources.noyau";
import {
  DESTINATIONS, ROUTES,
  type DemandeEmission, type Destination, type EvenementOutbox, type IssueEmission, type ResultatEmission,
  type StatutOutbox, type TypeSource,
} from "./types";

export type CodeRefus =
  | "DESTINATION_DESACTIVEE" | "SOURCE_NON_EMISSIBLE" | "SOURCE_INCONNUE" | "CHARGE_NON_CONSTRUISIBLE"
  | "CHARGE_NON_CONFORME" | "CHAMP_INTERNE_DANS_CHARGE" | "CHARGE_TROP_GROSSE"
  | "EVENEMENT_INTROUVABLE" | "TRANSITION_INTERDITE" | "DEJA_ENVOYE" | "MOTIF_REQUIS" | "VERROU_ACTIF";

export class RefusOutbox extends Error {
  constructor(public readonly code: CodeRefus, message: string) { super(message); this.name = "RefusOutbox"; }
}

export interface DepsOutbox {
  depot: DepotOutbox;
  sources: LecteurSources;
  adaptateurs: Adaptateurs;
  /** Pour les NOUVEAUX evenements : leur `tentativesMax` est fige a l'inscription. */
  politique: PolitiqueReprise;
  verrouMs: number;
  horloge?: () => Date;
  /** Identifie le travailleur dans le bail. Par defaut : aleatoire, unique par appel de `creerTravailleur`. */
  travailleur?: string;
  /** Gigue dans [0, 1[ pour la temporisation. Par defaut 0 : delai plein. */
  gigue?: () => number;
}

const TAILLE_MAX_CHARGE = 1_048_576;
const maintenant = (d: DepsOutbox) => (d.horloge ?? (() => new Date()))();

export function creerIdentifiantTravailleur(): string {
  return `w-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/* ================================== Inscrire ================================== */

export interface DemandeEnregistrement {
  destination: Destination;
  sourceType: TypeSource;
  sourceId: string;
  creeParId: string;
  ipAddress?: string;
}

export interface Enregistrement {
  evenement: EvenementOutbox;
  /** Vrai si le meme contenu etait deja inscrit : rien n'a ete ecrit. */
  dejaEnregistre: boolean;
}

/**
 * Inscrit un evenement pour une source VALIDEE. Refuse, sans rien ecrire, tout le reste.
 */
export async function enregistrerEvenement(deps: DepsOutbox, d: DemandeEnregistrement): Promise<Enregistrement> {
  if (!(DESTINATIONS as readonly string[]).includes(d.destination)) {
    throw new RefusOutbox("SOURCE_INCONNUE", `destination inconnue : ${String(d.destination)}`);
  }
  const route = ROUTES[d.destination];
  if (!route.sources.includes(d.sourceType)) {
    throw new RefusOutbox("SOURCE_INCONNUE", `la destination ${d.destination} ne recoit pas de source ${d.sourceType} (admises : ${route.sources.join(", ")})`);
  }
  const adaptateur = deps.adaptateurs[d.destination];
  if (!adaptateur) {
    throw new RefusOutbox("DESTINATION_DESACTIVEE", `la destination ${d.destination} est desactivee : rien n'est inscrit`);
  }

  const lecture = await deps.sources.lire(d.destination, d.sourceType, d.sourceId);
  if (!lecture.emissible) {
    throw new RefusOutbox(lecture.code === "SOURCE_INCONNUE" ? "SOURCE_INCONNUE" : lecture.code === "CHARGE_NON_CONSTRUISIBLE" ? "CHARGE_NON_CONSTRUISIBLE" : "SOURCE_NON_EMISSIBLE", lecture.motif);
  }

  const interne = trouverChampInterne(lecture.charge);
  if (interne) throw new RefusOutbox("CHAMP_INTERNE_DANS_CHARGE", `la charge porte une cle interne interdite : ${interne}`);

  const conforme = adaptateur.verifierCharge(lecture.charge);
  if (!conforme.ok) throw new RefusOutbox("CHARGE_NON_CONFORME", conforme.motif);

  let chargeCanonique: string;
  try { chargeCanonique = canonique(lecture.charge); } catch (err) {
    if (err instanceof ChargeNonCanonique) throw new RefusOutbox("CHARGE_NON_CONFORME", err.message);
    throw err;
  }
  if (chargeCanonique.length > TAILLE_MAX_CHARGE) {
    throw new RefusOutbox("CHARGE_TROP_GROSSE", `charge de ${chargeCanonique.length} caracteres, maximum ${TAILLE_MAX_CHARGE}`);
  }

  const empreinteCharge = sha256Hex(chargeCanonique);
  const cle = cleIdempotence({
    destination: d.destination, typeEvenement: route.typeEvenement, sourceType: d.sourceType, sourceId: d.sourceId, empreinteCharge,
  });
  const maintenantLe = maintenant(deps);

  try {
    return await deps.depot.transaction(async (p) => {
      const existant = await p.trouverParCle(d.destination, cle);
      if (existant) return { evenement: existant, dejaEnregistre: true };
      const e = await p.inserer({
        destination: d.destination, typeEvenement: route.typeEvenement, sourceType: d.sourceType, sourceId: d.sourceId,
        cleIdempotence: cle, chargeCanonique, empreinteCharge, tentativesMax: deps.politique.tentativesMax,
        creeParId: d.creeParId, maintenant: maintenantLe,
      });
      await p.auditer({
        userId: d.creeParId, action: "CREATE", entityId: e.id, ipAddress: d.ipAddress,
        after: {
          transition: "(nouveau)>EN_ATTENTE", destination: e.destination, typeEvenement: e.typeEvenement,
          sourceType: e.sourceType, sourceId: e.sourceId, version: e.version, cleIdempotence: e.cleIdempotence,
          empreinteCharge: e.empreinteCharge, statut: e.statut,
        },
      });
      return { evenement: e, dejaEnregistre: false };
    });
  } catch (err) {
    if (err instanceof CleDejaPresente) {
      // Course : un autre appel a inscrit le meme contenu entre la lecture et l'insertion.
      const existant = await deps.depot.lecture.trouverParCle(d.destination, cle);
      if (existant) return { evenement: existant, dejaEnregistre: true };
    }
    if (err instanceof RefusBase && err.sqlState === "23514") {
      // Le declencheur de la base a refuse une source qui a cesse d'etre emissible entre-temps.
      throw new RefusOutbox("SOURCE_NON_EMISSIBLE", err.message);
    }
    throw err;
  }
}

/* ================================== Emettre =================================== */

export type RaisonNonTraite =
  | "EVENEMENT_INTROUVABLE" | "DEJA_ENVOYE" | "ABANDONNE" | "DESTINATION_DESACTIVEE" | "NON_DU_OU_VERROUILLE" | "VERROU_PERDU";

export type ResultatTraitement =
  | { traite: false; id: string; raison: RaisonNonTraite }
  | { traite: true; id: string; statut: "ENVOYE" | "ECHEC" | "ABANDONNE"; issue: IssueEmission | null; code: string | null; doublon: boolean };

function resume(e: EvenementOutbox) {
  return { statut: e.statut, tentatives: e.tentatives, relances: e.relances };
}

/**
 * Emet UN evenement. Ne leve pas pour un echec d'emission : l'echec est un etat.
 *
 * Ce qui ne contacte personne et n'ecrit rien : un evenement introuvable, ENVOYE, ABANDONNE, ou
 * dont la destination est desactivee. Seul un evenement du (ou dont le bail a expire) est reclame.
 */
export async function traiterEvenement(
  deps: DepsOutbox, id: string, options: { ignorerEcheance?: boolean } = {},
): Promise<ResultatTraitement> {
  const lu = await deps.depot.lecture.lire(id);
  if (!lu) return { traite: false, id, raison: "EVENEMENT_INTROUVABLE" };
  if (lu.statut === "ENVOYE") return { traite: false, id, raison: "DEJA_ENVOYE" };
  if (lu.statut === "ABANDONNE") return { traite: false, id, raison: "ABANDONNE" };
  const adaptateur = deps.adaptateurs[lu.destination];
  if (!adaptateur) return { traite: false, id, raison: "DESTINATION_DESACTIVEE" };

  const travailleur = deps.travailleur ?? creerIdentifiantTravailleur();
  const debutClaim = maintenant(deps);

  // 1. Reclamation : transaction courte, UPDATE conditionnel, audit.
  const reclame = await deps.depot.transaction(async (p) => {
    const e = await p.reclamer({
      id, travailleur, maintenant: debutClaim, verrouJusqua: new Date(debutClaim.getTime() + deps.verrouMs),
      ignorerEcheance: options.ignorerEcheance === true,
    });
    if (!e) return null;
    await p.auditer({
      userId: null, action: "UPDATE", entityId: id,
      before: { statut: lu.statut, tentatives: lu.tentatives },
      after: { transition: `${lu.statut}>EN_COURS`, statut: "EN_COURS", tentatives: e.tentatives, travailleur, verrouJusqua: e.verrouJusqua?.toISOString() },
    });
    return e;
  });
  if (!reclame) return { traite: false, id, raison: "NON_DU_OU_VERROUILLE" };

  const conclure = async (
    statut: "ENVOYE" | "ECHEC" | "ABANDONNE",
    champs: { tentatives: number; prochaineTentativeLe?: Date | null; code: string | null; message: string | null; accuseReference?: string | null; motifAbandon?: string | null },
    tentative: { debutLe: Date; finLe: Date; issue: IssueEmission; codeHttp: number | null; codeErreur: string | null; message: string | null; accuseReference: string | null } | null,
    issue: IssueEmission | null, doublon: boolean,
  ): Promise<ResultatTraitement> => {
    const fin = maintenant(deps);
    return deps.depot.transaction(async (p) => {
      const apres = await p.conclure({
        id, travailleur, maintenant: fin, statut, tentatives: champs.tentatives,
        prochaineTentativeLe: champs.prochaineTentativeLe ?? null, code: champs.code, message: champs.message,
        accuseReference: champs.accuseReference ?? null, motifAbandon: champs.motifAbandon ?? null,
      });
      // Bail perdu (expire, reprise par un autre travailleur) : rien n'est ecrit, l'autre travailleur conclura.
      if (!apres) return { traite: false as const, id, raison: "VERROU_PERDU" as const };
      if (tentative) await p.inscrireTentative({ evenementId: id, travailleur, ...tentative });
      await p.auditer({
        userId: null, action: "UPDATE", entityId: id,
        before: resume(reclame),
        after: {
          transition: `EN_COURS>${statut}`, statut, tentatives: apres.tentatives, code: champs.code, issue,
          accuseReference: apres.accuseReference, motifAbandon: apres.motifAbandon, doublon, travailleur,
          prochaineTentativeLe: statut === "ECHEC" ? apres.prochaineTentativeLe.toISOString() : undefined,
        },
      });
      return { traite: true as const, id, statut, issue, code: champs.code, doublon };
    });
  };

  // 2. La source est-elle toujours emissible ? Une donnee rejetee ou supprimee depuis l'inscription ne part pas.
  let lecture;
  let resultat: ResultatEmission | null = null;
  try { lecture = await deps.sources.lire(reclame.destination, reclame.sourceType, reclame.sourceId); } catch {
    // La relecture a echoue (base indisponible) : c'est un echec temporaire COMPTE, donc borne.
    resultat = { issue: "ECHEC_TEMPORAIRE", codeErreur: "SOURCE_ILLISIBLE", message: "la source n'a pas pu etre relue avant l'envoi" };
  }
  if (lecture && !lecture.emissible) {
    return conclure("ABANDONNE", {
      tentatives: reclame.tentatives, code: "SOURCE_NON_VALIDE_A_L_ENVOI", message: lecture.motif.slice(0, 400),
      motifAbandon: `SOURCE_NON_VALIDE_A_L_ENVOI : ${lecture.motif}`.slice(0, 480),
    }, null, null, false);
  }

  // 3. La charge figee est-elle intacte ? (La base le verifie aussi ; ceci protege d'une base contournee.)
  if (sha256Hex(reclame.chargeCanonique) !== reclame.empreinteCharge) {
    return conclure("ABANDONNE", {
      tentatives: reclame.tentatives, code: "CHARGE_ALTEREE", message: "l'empreinte de la charge ne correspond plus",
      motifAbandon: "CHARGE_ALTEREE : l'empreinte stockee n'est plus celle de la charge",
    }, null, null, false);
  }

  let charge: unknown;
  try { charge = JSON.parse(reclame.chargeCanonique); } catch {
    return conclure("ABANDONNE", {
      tentatives: reclame.tentatives, code: "CHARGE_ILLISIBLE", message: "la charge n'est pas du JSON",
      motifAbandon: "CHARGE_ILLISIBLE : la charge archivee n'est pas du JSON",
    }, null, null, false);
  }

  // 4. L'emission : HORS transaction. Sautee si la relecture de la source a deja echoue.
  const debutLe = maintenant(deps);
  if (resultat === null) {
    const demande: DemandeEmission = {
      evenementId: reclame.id, destination: reclame.destination, typeEvenement: reclame.typeEvenement, version: reclame.version,
      cleIdempotence: reclame.cleIdempotence, empreinteCharge: reclame.empreinteCharge, charge,
    };
    try { resultat = await adaptateur.emettre(demande); } catch {
      resultat = { issue: "ECHEC_TEMPORAIRE", codeErreur: "EXCEPTION_ADAPTATEUR", message: "exception inattendue dans l'adaptateur" };
    }
  }
  const finLe = maintenant(deps);

  // 5. Le resultat : decision pure, puis ecriture.
  const decision = decider(resultat, {
    tentativesAvant: reclame.tentatives, maintenant: finLe, gigue: deps.gigue?.() ?? 0,
    politique: { tentativesMax: reclame.tentativesMax, delaiBaseMs: deps.politique.delaiBaseMs, delaiPlafondMs: deps.politique.delaiPlafondMs },
  });
  const tentative = {
    debutLe, finLe, issue: resultat.issue,
    codeHttp: resultat.issue === "ACCEPTE" || resultat.issue === "DOUBLON_RECONNU" ? resultat.codeHttp : resultat.codeHttp ?? null,
    codeErreur: resultat.issue === "ACCEPTE" || resultat.issue === "DOUBLON_RECONNU" ? null : resultat.codeErreur,
    message: resultat.issue === "ACCEPTE" || resultat.issue === "DOUBLON_RECONNU" ? null : resultat.message,
    accuseReference: resultat.issue === "ACCEPTE" || resultat.issue === "DOUBLON_RECONNU" ? resultat.accuseReference : null,
  };
  if (decision.statut === "ENVOYE") {
    return conclure("ENVOYE", { tentatives: decision.tentatives, code: null, message: null, accuseReference: decision.accuseReference }, tentative, resultat.issue, decision.doublon);
  }
  if (decision.statut === "ECHEC") {
    return conclure("ECHEC", { tentatives: decision.tentatives, code: decision.code, message: decision.message, prochaineTentativeLe: decision.prochaineTentativeLe }, tentative, resultat.issue, false);
  }
  return conclure("ABANDONNE", { tentatives: decision.tentatives, code: decision.code, message: decision.message, motifAbandon: decision.motifAbandon }, tentative, resultat.issue, false);
}

/**
 * Rejoue un evenement : l'emet MAINTENANT sans attendre son echeance, s'il n'est pas deja envoye.
 *
 * REJEU SANS EFFET DE BORD (test X-04 de ONR_BDR_TEST_PLAN.md) : un evenement ENVOYE n'est ni
 * emis une seconde fois ni modifie ; on rend `DEJA_ENVOYE` et on s'arrete avant toute ecriture.
 * Un evenement ABANDONNE ne se rejoue pas : il se relance (decision humaine, motivee).
 */
export function rejouerEvenement(deps: DepsOutbox, id: string): Promise<ResultatTraitement> {
  return traiterEvenement(deps, id, { ignorerEcheance: true });
}

export interface ResumeLot {
  examines: number;
  resultats: ResultatTraitement[];
}

/** Emet les evenements dus des destinations ACTIVES, au plus `limite`, un par un. */
export async function traiterLot(deps: DepsOutbox, limite: number): Promise<ResumeLot> {
  const actives = (Object.keys(deps.adaptateurs) as Destination[]).filter((d) => deps.adaptateurs[d]);
  const ids = await deps.depot.lecture.evenementsDus(maintenant(deps), actives, limite);
  const resultats: ResultatTraitement[] = [];
  for (const id of ids) resultats.push(await traiterEvenement(deps, id));
  return { examines: ids.length, resultats };
}

/* ============================ Actions humaines ============================ */

function motifValide(motif: string | undefined | null): string {
  const m = (motif ?? "").trim();
  if (m.length < 3) throw new RefusOutbox("MOTIF_REQUIS", "un motif d'au moins 3 caracteres est obligatoire");
  return m.slice(0, 480);
}

/** Remet un evenement ECHEC ou ABANDONNE en file. Jamais un evenement ENVOYE. */
export async function relancerEvenement(
  deps: DepsOutbox, id: string, a: { utilisateurId: string; motif: string; ipAddress?: string },
): Promise<EvenementOutbox> {
  const motif = motifValide(a.motif);
  const lu = await deps.depot.lecture.lire(id);
  if (!lu) throw new RefusOutbox("EVENEMENT_INTROUVABLE", `evenement ${id} introuvable`);
  if (lu.statut === "ENVOYE") throw new RefusOutbox("DEJA_ENVOYE", "un evenement ENVOYE ne se relance pas : il a ete remis, et son rejeu est sans effet");
  if (lu.statut !== "ECHEC" && lu.statut !== "ABANDONNE") {
    throw new RefusOutbox("TRANSITION_INTERDITE", `seul un evenement ECHEC ou ABANDONNE se relance (statut ${lu.statut})`);
  }
  return deps.depot.transaction(async (p) => {
    const e = await p.relancer({ id, maintenant: maintenant(deps) });
    if (!e) throw new RefusOutbox("TRANSITION_INTERDITE", "l'evenement a change d'etat pendant la relance");
    await p.auditer({
      userId: a.utilisateurId, action: "UPDATE", entityId: id, ipAddress: a.ipAddress,
      before: { statut: lu.statut, tentatives: lu.tentatives, motifAbandon: lu.motifAbandon, dernierCode: lu.dernierCode },
      after: { transition: `${lu.statut}>EN_ATTENTE`, statut: "EN_ATTENTE", tentatives: 0, relances: e.relances, motif },
    });
    return e;
  });
}

/** Abandon humain, motive : sort un evenement de la file sans l'effacer. */
export async function abandonnerEvenement(
  deps: DepsOutbox, id: string, a: { utilisateurId: string; motif: string; ipAddress?: string },
): Promise<EvenementOutbox> {
  const motif = motifValide(a.motif);
  const lu = await deps.depot.lecture.lire(id);
  if (!lu) throw new RefusOutbox("EVENEMENT_INTROUVABLE", `evenement ${id} introuvable`);
  if (lu.statut === "ENVOYE") throw new RefusOutbox("DEJA_ENVOYE", "un evenement ENVOYE ne s'abandonne pas : il a ete remis");
  if (lu.statut === "ABANDONNE") throw new RefusOutbox("TRANSITION_INTERDITE", "l'evenement est deja abandonne");
  if (lu.statut === "EN_COURS" && (lu.verrouJusqua === null || lu.verrouJusqua >= maintenant(deps))) {
    throw new RefusOutbox("VERROU_ACTIF", "l'evenement est en cours d'emission : attendre la fin de la tentative ou l'expiration du bail");
  }
  return deps.depot.transaction(async (p) => {
    const e = await p.abandonnerManuellement({ id, maintenant: maintenant(deps), motif: `ABANDON_HUMAIN : ${motif}` });
    if (!e) throw new RefusOutbox("TRANSITION_INTERDITE", "l'evenement a change d'etat pendant l'abandon");
    await p.auditer({
      userId: a.utilisateurId, action: "UPDATE", entityId: id, ipAddress: a.ipAddress,
      before: resume(lu),
      after: { transition: `${lu.statut}>ABANDONNE`, statut: "ABANDONNE", motif },
    });
    return e;
  });
}

/* ================================== Lire ================================== */

export interface DetailEvenement {
  evenement: EvenementOutbox;
  tentatives: TentativeLue[];
  journal: LigneAudit[];
}

export async function detailEvenement(deps: DepsOutbox, id: string): Promise<DetailEvenement> {
  const evenement = await deps.depot.lecture.lire(id);
  if (!evenement) throw new RefusOutbox("EVENEMENT_INTROUVABLE", `evenement ${id} introuvable`);
  const [tentatives, journal] = await Promise.all([deps.depot.lecture.tentativesDe(id), deps.depot.lecture.journalDe(id)]);
  return { evenement, tentatives, journal };
}

export function listerEvenements(deps: DepsOutbox, f: FiltreListe) {
  return deps.depot.lecture.lister(f);
}

export async function etatOutbox(deps: DepsOutbox): Promise<Record<StatutOutbox, number>> {
  return deps.depot.lecture.compter();
}
