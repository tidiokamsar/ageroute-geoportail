/**
 * Journal des evenements de la session locale (conception : docs/securite/SESSION-HORS-LIGNE.md, section 5).
 *
 * Hors ligne, rien ne peut etre journalise par le serveur sur le moment : l'appareil garde ici une file PAR COMPTE
 * (localStorage, cle `bdri:<empreinte>:evenementsLocaux`) et la depose, par lots bornes, sur
 * `POST /api/auth/evenements-locaux` au retour du reseau.
 *
 * CE QUE LE JOURNAL CONTIENT : un nom d'evenement de la liste fermee, un identifiant client unique (UUID), l'instant
 * du poste (NON FIABLE : le serveur le marque ainsi et date lui-meme la ligne d'audit) et, pour les echecs de PIN
 * regroupes, un nombre d'occurrences. JAMAIS le PIN, jamais un contenu de saisie, jamais un identifiant de compte.
 *
 * CONTRAT DU SERVEUR (lu dans backend/src/modules/auth/evenements-locaux.ts, schema `strict`) : corps
 * `{ appareilId?: uuid, evenements: [{ id: uuid, evenement, horodatageClient: ISO 8601, occurrences?: 1..1000 }] }`,
 * 1 a 50 evenements par lot. L'identifiant d'appareil est porte par le LOT, pas par chaque evenement : un champ en
 * trop fait refuser le lot en entier. Reponse : `{ recus, enregistres, dejaConnus }`. Rejeu idempotent cote serveur
 * (cle compte + identifiant).
 *
 * GARANTIES
 *   - rejeu sans risque : un lot dont la reponse s'est perdue repart avec les memes identifiants, le serveur ne double rien ;
 *   - purge APRES accuse seulement : un echec d'envoi (reseau, 5xx, 401, 429) ne retire rien ;
 *   - un refus 4xx du lot lui-meme (hors 401, 403, 408, 429) est un lot que le serveur ne lira jamais : il est retire
 *     pour ne pas bloquer ceux qui suivent, et compte dans `rejetes` ;
 *   - plafond de taille (`PLAFOND_JOURNAL`) : au-dela, le plus ancien est retire et `perdus` s'incremente ;
 *   - les echecs de deverrouillage consecutifs se regroupent en UN evenement (`occurrences`), ce qui borne aussi la taille.
 *
 * LIMITE CONNUE (conception, section 5) : un attaquant qui controle l'appareil peut omettre ou inventer des
 * evenements. Ce journal est une declaration, pas une preuve.
 */
import { cleLocalStorage } from "./compteLocal";
import type { MotifJournal } from "./noyauSession";

/** Liste fermee du serveur (`EVENEMENTS_LOCAUX`). Tout autre nom ferait refuser le lot. */
export const EVENEMENTS_LOCAUX = [
  "OUVERTURE_HORS_LIGNE",
  "DEVERROUILLAGE",
  "ECHEC_DEVERROUILLAGE",
  "VERROU_INACTIVITE",
  "SESSION_LOCALE_FERMEE",
  "SESSION_LOCALE_EXPIREE",
  "PIN_REINITIALISE",
  "EFFACEMENT_LOCAL",
] as const;
export type EvenementLocal = (typeof EVENEMENTS_LOCAUX)[number];

export const NOM_CLE_JOURNAL = "evenementsLocaux";
/** Maximum accepte par le serveur pour un lot. */
export const TAILLE_LOT_MAX = 50;
/** Evenements gardes au plus : un telephone qui reste des semaines hors ligne ne remplit pas localStorage. */
export const PLAFOND_JOURNAL = 200;
/** Plafond de l'agregat `occurrences` du serveur. */
export const OCCURRENCES_MAX = 1000;
/** Lots envoyes au plus par passage : borne le debit (le serveur accepte 5 lots par 15 minutes et 500 evenements par jour et par compte). */
export const LOTS_MAX_PAR_PASSAGE = 5;

/**
 * Correspondance entre les motifs du noyau et la liste fermee du serveur.
 *   - VERROU_ARRIERE_PLAN rejoint VERROU_INACTIVITE (meme famille : l'application s'est verrouillee seule) ;
 *   - FERMETURE_SESSION, DECONNEXION_HORS_LIGNE et DROITS_MODIFIES rejoignent SESSION_LOCALE_FERMEE ;
 *   - EXPIRATION et HORLOGE_RECULEE rejoignent SESSION_LOCALE_EXPIREE ;
 *   - VERROU_MANUEL n'est pas journalise (geste de l'agent, sans interet pour une enquete).
 */
export function evenementPourMotif(motif: MotifJournal): EvenementLocal | null {
  switch (motif) {
    case "OUVERTURE_HORS_LIGNE": return "OUVERTURE_HORS_LIGNE";
    case "DEVERROUILLAGE": return "DEVERROUILLAGE";
    case "ECHEC_DEVERROUILLAGE": return "ECHEC_DEVERROUILLAGE";
    case "VERROU_INACTIVITE":
    case "VERROU_ARRIERE_PLAN": return "VERROU_INACTIVITE";
    case "FERMETURE_SESSION":
    case "DECONNEXION_HORS_LIGNE":
    case "DROITS_MODIFIES": return "SESSION_LOCALE_FERMEE";
    case "EXPIRATION":
    case "HORLOGE_RECULEE": return "SESSION_LOCALE_EXPIREE";
    case "REINITIALISATION_PIN": return "PIN_REINITIALISE";
    case "EFFACEMENT_LOCAL": return "EFFACEMENT_LOCAL";
    case "VERROU_MANUEL": return null;
  }
}

export interface EntreeJournalLocal {
  readonly id: string;
  readonly evenement: EvenementLocal;
  /** Instant du poste en ISO 8601. NON FIABLE : un poste dont l'horloge est fausse ecrit une date fausse. */
  readonly horodatageClient: string;
  readonly occurrences?: number;
}

export interface CorpsLotEvenements {
  readonly appareilId?: string;
  readonly evenements: readonly EntreeJournalLocal[];
}

/** Ce que le journal exige d'un stockage texte : localStorage le satisfait tel quel. */
export type StockageTexte = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function stockageParDefaut(): StockageTexte | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const MOTIF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const estUuid = (v: unknown): v is string => typeof v === "string" && MOTIF_UUID.test(v);

/** UUID v4. `crypto.randomUUID` partout ou il existe, sinon construit depuis `getRandomValues`. */
export function genererUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const o = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(o);
  else for (let i = 0; i < 16; i += 1) o[i] = Math.floor(Math.random() * 256);
  o[6] = (o[6] & 0x0f) | 0x40;
  o[8] = (o[8] & 0x3f) | 0x80;
  const h = Array.from(o, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Contenu {
  v: 1;
  entrees: EntreeJournalLocal[];
  perdus: number;
}

const EVENEMENTS_CONNUS = new Set<string>(EVENEMENTS_LOCAUX);

/** Forme ISO 8601 avec fuseau, celle que le serveur exige (`datetime({ offset: true })`) : `Date.parse` seul est plus lache. */
const HORODATAGE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function entreeValide(e: unknown): e is EntreeJournalLocal {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return estUuid(o.id) && typeof o.evenement === "string" && EVENEMENTS_CONNUS.has(o.evenement)
    && typeof o.horodatageClient === "string" && HORODATAGE_ISO.test(o.horodatageClient) && !Number.isNaN(Date.parse(o.horodatageClient))
    && (o.occurrences === undefined || (Number.isInteger(o.occurrences) && (o.occurrences as number) >= 1 && (o.occurrences as number) <= OCCURRENCES_MAX));
}

export interface OptionsJournal {
  /** Empreinte du compte (compteLocal.ts) : le journal est PAR COMPTE. */
  readonly empreinte: string;
  readonly stockage?: StockageTexte | null;
  readonly identifiant?: () => string;
  /** Horloge du poste, en ms. Injectee pour les tests. */
  readonly maintenant?: () => number;
}

export interface JournalLocal {
  /** Ajoute un evenement. Ne leve jamais : un stockage plein ou refuse perd l'evenement, pas la session. */
  ajouter(evenement: EvenementLocal, maintenantMs?: number): void;
  ajouterMotif(motif: MotifJournal, maintenantMs?: number): void;
  lire(): EntreeJournalLocal[];
  nombre(): number;
  /** Evenements retires faute de place depuis la creation du journal. */
  perdus(): number;
  /** Les `max` plus anciens evenements, dans l'ordre. */
  lot(max?: number): EntreeJournalLocal[];
  /** Retire les evenements envoyes avec succes ; garde (sous un nouvel identifiant) ceux qui ont grossi pendant l'envoi. */
  acquitter(envoyes: readonly EntreeJournalLocal[]): void;
  /** Retire tout (utilise seulement par les tests et par l'effacement qui ne doit rien garder). */
  vider(): void;
}

export function creerJournal(options: OptionsJournal): JournalLocal {
  const cle = cleLocalStorage(options.empreinte, NOM_CLE_JOURNAL);
  const stockage = () => (options.stockage === undefined ? stockageParDefaut() : options.stockage);
  const identifiant = options.identifiant ?? genererUuid;
  const horloge = options.maintenant ?? (() => Date.now());

  function lireContenu(): Contenu {
    const s = stockage();
    if (s === null) return { v: 1, entrees: [], perdus: 0 };
    try {
      const brut = s.getItem(cle);
      if (!brut) return { v: 1, entrees: [], perdus: 0 };
      const o = JSON.parse(brut) as { entrees?: unknown; perdus?: unknown };
      // LECTURE BORNEE : le stockage est modifiable par quiconque tient l'appareil, et le plafond n'etait applique qu'a l'ECRITURE.
      // Un contenu forge de 20 000 entrees etait lu en entier (et envoye ensuite). On ne retient que les `PLAFOND_JOURNAL` plus
      // RECENTES (comme l'ecriture, qui retire les plus anciennes) et on ignore le reste, avant meme de les valider.
      const entrees = Array.isArray(o.entrees) ? o.entrees.slice(-PLAFOND_JOURNAL).filter(entreeValide) : [];
      return { v: 1, entrees, perdus: Number.isInteger(o.perdus) && (o.perdus as number) >= 0 ? (o.perdus as number) : 0 };
    } catch {
      return { v: 1, entrees: [], perdus: 0 };
    }
  }

  function ecrireContenu(c: Contenu): void {
    const s = stockage();
    if (s === null) return;
    try {
      if (c.entrees.length === 0 && c.perdus === 0) s.removeItem(cle);
      else s.setItem(cle, JSON.stringify(c));
    } catch { /* quota ou stockage refuse : la trace est perdue, l'application continue */ }
  }

  const journal: JournalLocal = {
    ajouter(evenement, maintenantMs) {
      const c = lireContenu();
      const dernier = c.entrees[c.entrees.length - 1];
      // Echecs consecutifs : un seul evenement, avec son nombre. Le serveur sait lire `occurrences`.
      if (evenement === "ECHEC_DEVERROUILLAGE" && dernier?.evenement === evenement && (dernier.occurrences ?? 1) < OCCURRENCES_MAX) {
        c.entrees[c.entrees.length - 1] = { ...dernier, occurrences: (dernier.occurrences ?? 1) + 1 };
        ecrireContenu(c);
        return;
      }
      c.entrees.push({ id: identifiant(), evenement, horodatageClient: new Date(maintenantMs ?? horloge()).toISOString() });
      while (c.entrees.length > PLAFOND_JOURNAL) { c.entrees.shift(); c.perdus += 1; }
      ecrireContenu(c);
    },
    ajouterMotif(motif, maintenantMs) {
      const e = evenementPourMotif(motif);
      if (e !== null) journal.ajouter(e, maintenantMs);
    },
    lire: () => lireContenu().entrees,
    nombre: () => lireContenu().entrees.length,
    perdus: () => lireContenu().perdus,
    lot(max = TAILLE_LOT_MAX) {
      return lireContenu().entrees.slice(0, Math.max(0, Math.min(max, TAILLE_LOT_MAX)));
    },
    acquitter(envoyes) {
      if (envoyes.length === 0) return;
      const c = lireContenu();
      const parId = new Map(envoyes.map((e) => [e.id, e]));
      const restant: EntreeJournalLocal[] = [];
      for (const e of c.entrees) {
        const parti = parId.get(e.id);
        if (!parti) { restant.push(e); continue; }
        const delta = (e.occurrences ?? 1) - (parti.occurrences ?? 1);
        // Des echecs se sont ajoutes a cette entree PENDANT l'envoi : le serveur a deja l'identifiant, il ignorerait un
        // second envoi. Le surplus repart sous un nouvel identifiant.
        if (delta > 0) restant.push({ id: identifiant(), evenement: e.evenement, horodatageClient: e.horodatageClient, occurrences: delta });
      }
      ecrireContenu({ ...c, entrees: restant });
    },
    vider() {
      const s = stockage();
      try { s?.removeItem(cle); } catch { /* rien a faire */ }
    },
  };
  return journal;
}

// ---------------------------------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------------------------------

export interface ResultatEnvoiJournal {
  /** Evenements acquittes par le serveur. */
  envoyes: number;
  /** Evenements retires parce que le serveur a refuse le lot lui-meme (4xx). */
  rejetes: number;
  /** Evenements encore en file apres le passage. */
  restants: number;
  /** Un envoi a echoue (reseau, serveur, authentification) : le reste repart au prochain passage. */
  echec: boolean;
}

/** Erreur d'envoi : `statut` absent = aucune reponse HTTP (reseau coupe). */
export interface ErreurEnvoi { readonly statut?: number }

const STATUTS_A_RETENTER = new Set([401, 403, 408, 429]);
const enCours = new Set<string>();

/**
 * Depose le journal par lots de 50 au plus, `LOTS_MAX_PAR_PASSAGE` lots au plus par passage. Un seul passage a la fois
 * par compte. Ne leve jamais. `poster` doit lever (avec `statut` si une reponse HTTP a ete recue) quand le serveur n'a
 * pas acquitte le lot.
 */
export async function envoyerJournal(
  options: OptionsJournal,
  poster: (corps: CorpsLotEvenements) => Promise<void>,
  reglages: { appareilId?: string | null; tailleLot?: number; lotsMax?: number } = {},
): Promise<ResultatEnvoiJournal> {
  const journal = creerJournal(options);
  const resultat: ResultatEnvoiJournal = { envoyes: 0, rejetes: 0, restants: journal.nombre(), echec: false };
  if (enCours.has(options.empreinte)) return resultat;
  enCours.add(options.empreinte);
  try {
    const lotsMax = reglages.lotsMax ?? LOTS_MAX_PAR_PASSAGE;
    for (let i = 0; i < lotsMax; i += 1) {
      const lot = journal.lot(reglages.tailleLot ?? TAILLE_LOT_MAX);
      if (lot.length === 0) break;
      const corps: CorpsLotEvenements = estUuid(reglages.appareilId) ? { appareilId: reglages.appareilId, evenements: lot } : { evenements: lot };
      try {
        await poster(corps);
        journal.acquitter(lot);
        resultat.envoyes += lot.length;
      } catch (e) {
        const statut = (e as ErreurEnvoi | null)?.statut;
        if (typeof statut === "number" && statut >= 400 && statut < 500 && !STATUTS_A_RETENTER.has(statut)) {
          journal.acquitter(lot); // lot illisible pour le serveur : le garder bloquerait tous les suivants
          resultat.rejetes += lot.length;
          continue;
        }
        resultat.echec = true;
        break;
      }
    }
  } finally {
    enCours.delete(options.empreinte);
    resultat.restants = journal.nombre();
  }
  return resultat;
}
