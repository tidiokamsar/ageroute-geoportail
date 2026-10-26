/**
 * Migration de l'HERITAGE : les bases d'avant le cloisonnement par compte (docs/securite/SESSION-HORS-LIGNE.md,
 * section 4). Deux bases en clair, partagees par tous les comptes du telephone :
 *   - `bdri-offline`  (versions 1 a 4) : inspections, defauts, portions, observations en attente ;
 *   - `bdri-roulage`  : le journal de la derniere session de roulage.
 *
 * CONTRAT POUR L'INTEGRATEUR
 *
 *   await migrerHeritage();           // compte ouvert ET coffre DEVERROUILLE (sinon AUCUN_COMPTE / COFFRE_VERROUILLE)
 *   await compterQuarantaine();       // nombre de saisies de l'heritage que ce compte ne peut pas reprendre
 *   await compterHeritage();          // detail, en nombres seulement
 *
 * A appeler UNE FOIS a la premiere ouverture d'un compte, apres le deverrouillage et AVANT la premiere
 * synchronisation. L'appeler a chaque ouverture est sans risque (idempotent) et peu couteux (une ouverture de base).
 *
 * REGLES, DANS L'ORDRE OU ELLES SONT TENUES
 *   1. Seules les saisies dont `ownerUserId` est CE compte (journal : `DEMARRAGE.agentRef`) sont reprises. Aucun
 *      rattachement automatique, jamais : une saisie sans proprietaire n'est pas attribuee au premier compte venu.
 *   2. Chaque saisie est copiee CHIFFREE dans la base du compte, puis RELUE et comparee a l'originale (photos octet
 *      pour octet). Seulement alors, et saisie par saisie, elle est retiree de l'ancienne base.
 *   3. Une saisie sans proprietaire ou d'un autre compte n'est ni attribuee, ni supprimee, ni lisible par l'interface
 *      (aucune API de l'application ne lit les anciennes bases) : QUARANTAINE. Elle reste intacte sur le telephone.
 *   4. Une saisie que ce compte ne peut pas reprendre (photo de plus de 8 Mio, copie divergente) reste dans l'ancienne
 *      base, intacte, et figure dans `nonMigrables`. Rien n'est perdu pour autant.
 *   5. Idempotente. Interrompue n'importe ou (page fermee, quota, verrou), elle se rejoue : une saisie deja copiee n'est pas
 *      copiee deux fois ni ecrasee par une copie plus ancienne (la copie du compte fait foi), une saisie deja retiree n'est plus
 *      vue. Les ecritures du compte ont lieu AVANT tout retrait : la pire interruption laisse une saisie en double (ancienne
 *      base + base du compte), jamais une saisie perdue.
 *   6. La base d'avant n'est jamais supprimee ni mise a niveau : on en retire seulement les saisies reprises.
 *
 * LES CLES localStorage D'AVANT LE CLOISONNEMENT liees au journal repris (envoi confirme, mission, intitule) et l'identifiant
 * d'appareil de synchronisation de ce compte sont recopiees sous le prefixe du compte, puis retirees. Les anciennes copies de
 * referentiels (`bdri_terrain_referentiels`, `bdri_terrain_catalogue_defauts`, `bdri.roulage.referentiels`) ne sont ni
 * reprises ni supprimees : elles se rechargent en ligne et ne sont plus lues par l'application.
 */
import { BASE_OFFLINE_HISTORIQUE, BASE_ROULAGE_HISTORIQUE } from "../session/compteLocal";
import {
  compteCourant, ecrireStockageLocal, estErreurStockageLocal, exigerCompte, exigerDeverrouille, lireStockageLocal,
  majCompteursCourant, NOM_CLE_APPAREIL_SYNC, traduireErreurChiffrement,
} from "./compteCourant";
import { ecrireSaisie, FILES, lireSaisie, NOMS_FILES, PHOTO_TAILLE_MAX_OCTETS, type NomFile, type SaisieBase } from "./offlineDb";
import { stockageIndexedDb } from "./roulageHote";
import type { EntreeJournal } from "../roulage/journal";

export type EtapeMigration = "COPIE" | "VERIFIE" | "RETIRE";

export interface OptionsMigration {
  /**
   * Observateur de l'avancement, appele APRES chaque etape et AVANT la suivante. S'il leve, la migration s'arrete sur
   * cette erreur : c'est le moyen de simuler une interruption (page fermee) au milieu de la migration dans les tests.
   */
  observer?: (evenement: { etape: EtapeMigration; file: NomFile | "journal"; localId: string | null }) => void | Promise<void>;
}

export type EtatJournalHeritage = "AUCUN" | "MIGRE" | "SANS_PROPRIETAIRE" | "AUTRE_COMPTE" | "CONFLIT" | "NON_MIGRABLE";

export interface ResultatMigration {
  /** Saisies copiees, verifiees puis retirees de l'ancienne base. */
  migrees: number;
  /** Saisies deja presentes dans la base du compte (reprise apres interruption) puis retirees de l'ancienne base. */
  dejaMigrees: number;
  /** Saisies de ce compte restees dans l'ancienne base, intactes, avec la raison. */
  nonMigrables: { file: NomFile | "journal"; localId: string | null; raison: string }[];
  sansProprietaire: number;
  autresComptes: number;
  journal: EtatJournalHeritage;
  /** `sansProprietaire` + `autresComptes` + (1 si le journal historique n'est pas celui de ce compte). */
  quarantaine: number;
}

export interface DecompteHeritage {
  /** Saisies qui portent ce compte comme proprietaire et attendent la migration. */
  aMigrer: number;
  sansProprietaire: number;
  autresComptes: number;
  journal: EtatJournalHeritage | "A_MIGRER";
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------
// Acces aux anciennes bases (lecture, retrait). Jamais de mise a niveau, jamais de suppression de base peuplee.
// ---------------------------------------------------------------------------------------------------

/**
 * Ouvre une ancienne base SANS version (donc sans mise a niveau). `null` si elle n'existe pas : ouvrir une base absente la
 * cree vide, alors on le detecte (aucun magasin) et on retire cette coquille que nous venons de creer.
 */
async function ouvrirHeritage(nom: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  if (typeof indexedDB.databases === "function") {
    try {
      const bases = await indexedDB.databases();
      if (!bases.some((b) => b.name === nom)) return null;
    } catch { /* l'enumeration est refusee : on ouvre et on controle les magasins */ }
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(nom);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (db.objectStoreNames.length === 0) {
    db.close();
    try { indexedDB.deleteDatabase(nom); } catch { /* coquille vide laissee : sans consequence */ }
    return null;
  }
  db.onversionchange = () => db.close();
  return db;
}

function requete<T>(db: IDBDatabase, magasin: string, mode: IDBTransactionMode, travail: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(magasin, mode);
    const r = travail(tx.objectStore(magasin));
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction annulee."));
  });
}

const cles = (db: IDBDatabase, magasin: string): Promise<IDBValidKey[]> => requete(db, magasin, "readonly", (s) => s.getAllKeys());
const lire = (db: IDBDatabase, magasin: string, cle: IDBValidKey): Promise<unknown> => requete(db, magasin, "readonly", (s) => s.get(cle));
const retirer = (db: IDBDatabase, magasin: string, cle: IDBValidKey): Promise<unknown> => requete(db, magasin, "readwrite", (s) => s.delete(cle));

// ---------------------------------------------------------------------------------------------------
// Comparaison de l'aller-retour
// ---------------------------------------------------------------------------------------------------

/** Forme canonique (cles triees, `undefined` ecarte) : deux objets equivalents donnent le meme texte. */
function canonique(v: unknown): string {
  const trier = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(trier);
    if (estObjet(x)) {
      const sortie: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) sortie[k] = trier(x[k]);
      return sortie;
    }
    return x;
  };
  return JSON.stringify(trier(v));
}

const estBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;

async function octetsEgaux(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size || a.type !== b.type) return false;
  const [x, y] = [new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer())];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/** Meme saisie, photos comprises octet pour octet. */
async function memeSaisie(a: Record<string, unknown>, b: Record<string, unknown>): Promise<boolean> {
  const { photos: pa, ...ra } = a;
  const { photos: pb, ...rb } = b;
  if (canonique(ra) !== canonique(rb)) return false;
  if (pa === undefined || pb === undefined) return pa === pb;
  if (!Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i += 1) {
    const { blob: ba, ...ma } = pa[i] as { blob: unknown };
    const { blob: bb, ...mb } = pb[i] as { blob: unknown };
    if (canonique(ma) !== canonique(mb) || !estBlob(ba) || !estBlob(bb) || !(await octetsEgaux(ba, bb))) return false;
  }
  return true;
}

/** Ce qui ne change jamais apres la creation d'une saisie : identifiant, date et contenu saisi. */
const noyauImmuable = (s: Record<string, unknown>) => canonique({ localId: s.localId, createdAt: s.createdAt, payload: s.payload });

// ---------------------------------------------------------------------------------------------------
// Saisies
// ---------------------------------------------------------------------------------------------------

class Classee extends Error {
  constructor(readonly raison: string) { super(raison); }
}

/** Verifie ce que le chiffrement exigera, avant d'ecrire quoi que ce soit : une photo illisible ou trop grosse n'est pas migrable. */
function verifierMigrable(item: Record<string, unknown>): void {
  if (item.photos === undefined) return;
  if (!Array.isArray(item.photos)) throw new Classee("PHOTOS_ILLISIBLES");
  for (const p of item.photos) {
    const blob = estObjet(p) ? p.blob : undefined;
    if (!estBlob(blob)) throw new Classee("PHOTO_ILLISIBLE");
    if (blob.size > PHOTO_TAILLE_MAX_OCTETS) throw new Classee("PHOTO_TROP_GROSSE");
  }
}

type IssueSaisie = "MIGREE" | "DEJA_MIGREE";

async function migrerUneSaisie(file: NomFile, legacy: Record<string, unknown>, observer: OptionsMigration["observer"]): Promise<IssueSaisie> {
  const localId = legacy.localId as string;
  let existant: Record<string, unknown> | null = null;
  try {
    existant = (await lireSaisie(file, localId)) as Record<string, unknown> | null;
  } catch (e) {
    if (!estErreurStockageLocal(e, "DONNEES_ALTEREES")) throw e;
    // Une copie illisible n'est pas une copie : on reecrit depuis l'original, qui est toujours la.
  }

  if (existant !== null) {
    // Reprise apres interruption : la copie du compte fait foi (elle a pu avancer depuis, par exemple une synchronisation).
    // On exige seulement qu'elle soit la MEME saisie : identifiant, date et contenu saisi identiques.
    if (noyauImmuable(existant) !== noyauImmuable(legacy)) throw new Classee("COPIE_DIVERGENTE");
    return "DEJA_MIGREE";
  }

  verifierMigrable(legacy);
  try {
    await ecrireSaisie(file, legacy as unknown as SaisieBase, { migration: true });
  } catch (e) {
    if (estErreurStockageLocal(e, "ARGUMENT_INVALIDE") || estErreurStockageLocal(e, "COMPTE_INCOHERENT") || estErreurStockageLocal(e, "PHOTO_TROP_GROSSE")) {
      throw new Classee(e.code);
    }
    throw e;
  }
  await observer?.({ etape: "COPIE", file, localId });

  let relu: Record<string, unknown> | null;
  try {
    relu = (await lireSaisie(file, localId)) as Record<string, unknown> | null;
  } catch (e) {
    if (estErreurStockageLocal(e, "DONNEES_ALTEREES")) throw new Classee("RELECTURE_ILLISIBLE");
    throw e;
  }
  if (relu === null || !(await memeSaisie({ ...legacy, ownerUserId: legacy.ownerUserId }, relu))) throw new Classee("VERIFICATION_ECHOUEE");
  await observer?.({ etape: "VERIFIE", file, localId });
  return "MIGREE";
}

// ---------------------------------------------------------------------------------------------------
// Journal de roulage
// ---------------------------------------------------------------------------------------------------

function identiteJournal(entrees: EntreeJournal[]): { sessionId: string | null; agentRef: string | null } {
  const debut = entrees.find((e) => e.type === "DEMARRAGE");
  if (!debut || debut.type !== "DEMARRAGE") return { sessionId: null, agentRef: null };
  return { sessionId: debut.sessionId, agentRef: typeof debut.agentRef === "string" && debut.agentRef !== "" ? debut.agentRef : null };
}

async function lireJournalHeritage(db: IDBDatabase): Promise<EntreeJournal[]> {
  if (!db.objectStoreNames.contains("journal")) return [];
  const brut = (await requete(db, "journal", "readonly", (s) => s.getAll())) as unknown[];
  return brut.filter((e): e is EntreeJournal => estObjet(e) && typeof e.seq === "number" && typeof e.type === "string").sort((a, b) => a.seq - b.seq);
}

/** Cles localStorage d'avant le cloisonnement, liees a une session de roulage : recopiees sous le prefixe du compte puis retirees. */
function migrerClesSession(sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  for (const [ancienne, nouvelle] of [
    [`bdri.roulage.envoi.${sessionId}`, `roulage.envoi.${sessionId}`],
    [`bdri.roulage.mission.${sessionId}`, `roulage.mission.${sessionId}`],
    [`bdri.roulage.intitule.${sessionId}`, `roulage.intitule.${sessionId}`],
  ] as const) {
    try {
      const valeur = localStorage.getItem(ancienne);
      if (valeur === null) continue;
      if (lireStockageLocal(nouvelle) !== null || ecrireStockageLocal(nouvelle, valeur)) localStorage.removeItem(ancienne);
    } catch { /* stockage indisponible : l'ancienne cle reste, sans consequence */ }
  }
}

async function migrerJournal(compteId: string, observer: OptionsMigration["observer"]): Promise<{ etat: EtatJournalHeritage; nonMigrable?: string }> {
  const db = await ouvrirHeritage(BASE_ROULAGE_HISTORIQUE);
  if (db === null) return { etat: "AUCUN" };
  try {
    const entrees = await lireJournalHeritage(db);
    if (entrees.length === 0) return { etat: "AUCUN" };
    const { sessionId, agentRef } = identiteJournal(entrees);
    if (agentRef === null || sessionId === null) return { etat: "SANS_PROPRIETAIRE" };
    if (agentRef !== compteId) return { etat: "AUTRE_COMPTE" };

    const journal = stockageIndexedDb({ tailleLot: 500 });
    if (journal === null) return { etat: "NON_MIGRABLE", nonMigrable: "INDEXEDDB_INDISPONIBLE" };
    try {
      // GARDE : le compte courant doit rester `compteId` d'un bout a l'autre. Cette migration est asynchrone (relectures,
      // observateur) ; si l'agent change de compte entre-temps, copier ou, pire, VIDER l'ancienne base sous un autre compte
      // perdrait ou detournerait un releve.
      if (compteCourant()?.compteId !== compteId) return { etat: "NON_MIGRABLE", nonMigrable: "COMPTE_CHANGE" };
      const dejaLa = await journal.toutes();
      if (dejaLa.length > 0 && identiteJournal(dejaLa).sessionId !== sessionId) {
        // Le compte a deja SA session dans son journal : l'ecraser perdrait un releve. On laisse l'ancien intact.
        return { etat: "CONFLIT" };
      }
      if (compteCourant()?.compteId !== compteId) return { etat: "NON_MIGRABLE", nonMigrable: "COMPTE_CHANGE" };
      // Copie (idempotente : une entree rejouee remplace son identique), puis relecture complete.
      for (const e of entrees) journal.ajouter(e);
      const relues = await journal.toutes();
      await observer?.({ etape: "COPIE", file: "journal", localId: sessionId });
      const parSeq = new Map(relues.map((e) => [e.seq, e]));
      for (const e of entrees) {
        const r = parSeq.get(e.seq);
        if (!r || canonique(r) !== canonique(e)) return { etat: "NON_MIGRABLE", nonMigrable: "VERIFICATION_ECHOUEE" };
      }
      await observer?.({ etape: "VERIFIE", file: "journal", localId: sessionId });
      // Dernier controle AVANT le retrait irreversible de l'ancienne base.
      if (compteCourant()?.compteId !== compteId) return { etat: "NON_MIGRABLE", nonMigrable: "COMPTE_CHANGE" };
    } finally {
      journal.fermer?.();
    }
    await requete(db, "journal", "readwrite", (s) => s.clear());
    await observer?.({ etape: "RETIRE", file: "journal", localId: sessionId });
    // Si le compte a change pendant le retrait, les cles et le compteur du compte COURANT ne sont pas ceux de cette session : on
    // les laisse (les anciennes cles restent, sans consequence).
    if (compteCourant()?.compteId === compteId) {
      migrerClesSession(sessionId);
      if (lireStockageLocal(`roulage.envoi.${sessionId}`) !== null) majCompteursCourant({ releves: 0 });
    }
    return { etat: "MIGRE" };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------

let enCours: Promise<ResultatMigration> | null = null;

/** Migre l'heritage du compte courant (voir l'en-tete). Deux appels simultanes partagent la meme execution. */
export function migrerHeritage(options: OptionsMigration = {}): Promise<ResultatMigration> {
  if (enCours !== null) return enCours;
  const execution = executerMigration(options).finally(() => { enCours = null; });
  enCours = execution;
  return execution;
}

async function executerMigration(options: OptionsMigration): Promise<ResultatMigration> {
  const ctx = exigerCompte();
  exigerDeverrouille(ctx);
  const resultat: ResultatMigration = { migrees: 0, dejaMigrees: 0, nonMigrables: [], sansProprietaire: 0, autresComptes: 0, journal: "AUCUN", quarantaine: 0 };

  const db = await ouvrirHeritage(BASE_OFFLINE_HISTORIQUE);
  if (db !== null) {
    try {
      for (const file of NOMS_FILES) {
        const magasin = FILES[file].magasin;
        if (!db.objectStoreNames.contains(magasin)) continue;
        for (const cle of await cles(db, magasin)) {
          const legacy = await lire(db, magasin, cle);
          if (legacy === undefined) continue; // retiree entre-temps (autre onglet) : rien a faire
          if (!estObjet(legacy) || typeof legacy.localId !== "string" || legacy.localId === "") {
            resultat.sansProprietaire += 1; // enregistrement sans identifiant exploitable : jamais touche
            continue;
          }
          const proprietaire = legacy.ownerUserId;
          if (typeof proprietaire !== "string" || proprietaire === "") { resultat.sansProprietaire += 1; continue; }
          if (proprietaire !== ctx.compteId) { resultat.autresComptes += 1; continue; }

          let issue: IssueSaisie;
          try {
            issue = await migrerUneSaisie(file, legacy, options.observer);
          } catch (e) {
            const traduite = traduireErreurChiffrement(e);
            if (traduite instanceof Classee) { resultat.nonMigrables.push({ file, localId: legacy.localId, raison: traduite.raison }); continue; }
            throw traduite; // quota, verrou, compte ferme : on s'arrete, rien n'est perdu, la prochaine ouverture reprend
          }
          await retirer(db, magasin, cle);
          await options.observer?.({ etape: "RETIRE", file, localId: legacy.localId });
          if (issue === "MIGREE") resultat.migrees += 1; else resultat.dejaMigrees += 1;
        }
      }
    } finally {
      db.close();
    }
  }

  const j = await migrerJournal(ctx.compteId, options.observer);
  resultat.journal = j.etat;
  if (j.nonMigrable) resultat.nonMigrables.push({ file: "journal", localId: null, raison: j.nonMigrable });
  if (j.etat === "NON_MIGRABLE" && !j.nonMigrable) resultat.nonMigrables.push({ file: "journal", localId: null, raison: "NON_MIGRABLE" });

  migrerAppareilSync(ctx.compteId);
  resultat.quarantaine = resultat.sansProprietaire + resultat.autresComptes + (j.etat === "SANS_PROPRIETAIRE" || j.etat === "AUTRE_COMPTE" ? 1 : 0);
  return resultat;
}

/** L'identifiant d'appareil de synchronisation de ce compte (cle d'avant le cloisonnement, deja liee a son identifiant). */
function migrerAppareilSync(compteId: string): void {
  if (typeof localStorage === "undefined" || compteCourant()?.compteId !== compteId) return;
  const ancienne = `bdri.sync.device.${compteId}`;
  try {
    const valeur = localStorage.getItem(ancienne);
    if (valeur === null) return;
    if (lireStockageLocal(NOM_CLE_APPAREIL_SYNC, compteId) !== null || ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, valeur, compteId)) localStorage.removeItem(ancienne);
  } catch { /* sans consequence : l'appareil se reenregistre */ }
}

/** Detail de l'heritage pour un compte, en NOMBRES seulement. Lecture seule, sans cle. */
export async function compterHeritage(compteId?: string): Promise<DecompteHeritage> {
  const id = compteId ?? exigerCompte().compteId;
  const d: DecompteHeritage = { aMigrer: 0, sansProprietaire: 0, autresComptes: 0, journal: "AUCUN" };
  const db = await ouvrirHeritage(BASE_OFFLINE_HISTORIQUE);
  if (db !== null) {
    try {
      for (const file of NOMS_FILES) {
        const magasin = FILES[file].magasin;
        if (!db.objectStoreNames.contains(magasin)) continue;
        const toutes = (await requete(db, magasin, "readonly", (s) => s.getAll())) as unknown[];
        for (const s of toutes) {
          const proprietaire = estObjet(s) ? s.ownerUserId : undefined;
          if (typeof proprietaire !== "string" || proprietaire === "") d.sansProprietaire += 1;
          else if (proprietaire === id) d.aMigrer += 1;
          else d.autresComptes += 1;
        }
      }
    } finally {
      db.close();
    }
  }
  const dj = await ouvrirHeritage(BASE_ROULAGE_HISTORIQUE);
  if (dj !== null) {
    try {
      const entrees = await lireJournalHeritage(dj);
      if (entrees.length > 0) {
        const { agentRef } = identiteJournal(entrees);
        d.journal = agentRef === null ? "SANS_PROPRIETAIRE" : agentRef === id ? "A_MIGRER" : "AUTRE_COMPTE";
      }
    } finally {
      dj.close();
    }
  }
  return d;
}

/**
 * Nombre de saisies de l'heritage que ce compte ne reprendra PAS : sans proprietaire ou d'un autre compte (le journal
 * historique compte pour un s'il n'est pas le sien). Un nombre, jamais un contenu : l'interface peut dire « N saisies
 * anciennes restent en quarantaine sur ce telephone » et rien de plus.
 */
export async function compterQuarantaine(compteId?: string): Promise<number> {
  const d = await compterHeritage(compteId);
  return d.sansProprietaire + d.autresComptes + (d.journal === "SANS_PROPRIETAIRE" || d.journal === "AUTRE_COMPTE" ? 1 : 0);
}
