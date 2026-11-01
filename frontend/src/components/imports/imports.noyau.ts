import type { Etape, EtatEtape, IdEtape, StatutLot } from "./types";

/**
 * Noyau pur du module « Lots d'import » : libelles, tons, formats et textes de gouvernance.
 *
 * PUR : ni DOM, ni horloge, ni reseau, ni stockage, aucun import hors de ce dossier. Les composants
 * (BadgeStatutLot, IndicateurEtapes, BandeauGouvernance, EtatsListe) ne font que mettre en page ce que ce
 * fichier decide, et chaque decision est testee par table (imports.noyau.test.ts). Le test relit aussi le
 * source pour garder cette purete.
 *
 * REGLE DE FOND (cahier, 6.3 et 6.2) : le statut distingue toujours « recu », « valide techniquement »,
 * « approuve metier », « autorise a ecrire » et « importe », et un etat « en attente » ou « non applique »
 * n'est JAMAIS colore comme une reussite. Seuls `IMPORTE` et une etape `TERMINEE` portent le ton de
 * reussite. Un statut ou un etat inconnu du client (le serveur a pu evoluer) tombe sur le ton neutre, jamais
 * sur un ton de reussite.
 *
 * LA COULEUR NE PORTE JAMAIS L'INFORMATION SEULE : chaque ton est livre avec une icone ET un texte.
 */

// ---------------------------------------------------------------------------------------------------
// Tons
// ---------------------------------------------------------------------------------------------------

export type NomTon = "succes" | "attention" | "echec" | "info" | "neutre";

/** Icones logiques ; les composants les associent a une icone lucide (le noyau ne connait pas React). */
export type NomIcone = "boite" | "sablier" | "fiole" | "coche" | "croix" | "alerte" | "chargement" | "cadenas" | "cercle";

export interface Ton {
  nom: NomTon;
  /**
   * Jetons du design system (styles/tokens.css, index.css) dont les `classes` sont la traduction Tailwind.
   * Les tests relisent le CSS pour y mesurer le contraste, et la config Tailwind pour verifier que chaque
   * classe pointe bien sur le jeton annonce : les deux ne peuvent pas diverger sans qu'un test echoue.
   */
  jetons: { texte: string; fond: string; trait: string };
  /**
   * Classes ecrites EN ENTIER : le JIT de Tailwind ne devine pas une classe assemblee a l'execution.
   * Aucune teinte brute (`bg-green-100`) : uniquement des jetons.
   */
  classes: { puce: string; texte: string; trait: string };
}

export const TONS: Record<NomTon, Ton> = {
  // Reussite. Reserve a `IMPORTE` et a une etape `TERMINEE`.
  succes: {
    nom: "succes",
    jetons: { texte: "etat-bon-texte", fond: "etat-bon-fond", trait: "etat-bon-trait" },
    classes: { puce: "bg-etat-bon-fond text-etat-bon border-etat-bon-trait", texte: "text-etat-bon", trait: "border-etat-bon-trait" },
  },
  // Ambre : en attente, non applique, termine avec reserves. Jamais vert.
  attention: {
    nom: "attention",
    jetons: { texte: "etat-moyen-texte", fond: "etat-moyen-fond", trait: "etat-moyen-trait" },
    classes: { puce: "bg-etat-moyen-fond text-etat-moyen border-etat-moyen-trait", texte: "text-etat-moyen", trait: "border-etat-moyen-trait" },
  },
  echec: {
    nom: "echec",
    jetons: { texte: "etat-critique-texte", fond: "etat-critique-fond", trait: "etat-critique-trait" },
    classes: { puce: "bg-etat-critique-fond text-etat-critique border-etat-critique-trait", texte: "text-etat-critique", trait: "border-etat-critique-trait" },
  },
  // Navy du design system : en cours, import d'essai. Il n'existe pas de jeton de fond « info » : surface attenuee.
  info: {
    nom: "info",
    jetons: { texte: "info", fond: "muted", trait: "info" },
    classes: { puce: "bg-muted text-info border-info", texte: "text-info", trait: "border-info" },
  },
  neutre: {
    nom: "neutre",
    jetons: { texte: "etat-inconnu-texte", fond: "etat-inconnu-fond", trait: "etat-inconnu-trait" },
    classes: { puce: "bg-etat-inconnu-fond text-etat-inconnu border-etat-inconnu-trait", texte: "text-etat-inconnu", trait: "border-etat-inconnu-trait" },
  },
};

/** Le bandeau de gouvernance est un avertissement (ambre) : jeton `avertissement` pour le texte. */
export const TON_BANDEAU = {
  jetons: { texte: "avertissement", fond: "etat-moyen-fond", trait: "etat-moyen-trait" },
  classes: { conteneur: "border-etat-moyen-trait bg-etat-moyen-fond text-avertissement" },
} as const;

// ---------------------------------------------------------------------------------------------------
// Statut du lot
// ---------------------------------------------------------------------------------------------------

export interface DescripteurStatut {
  code: string;
  libelle: string;
  /** Une phrase pour le detail ou une infobulle : jamais l'unique porteuse du sens (le libelle suffit). */
  description: string;
  ton: NomTon;
  icone: NomIcone;
  /** `false` : valeur que ce client ne connait pas (affichee neutre, jamais en reussite). */
  connu: boolean;
}

export const STATUTS_LOT: readonly StatutLot[] = ["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"];

const STATUTS: Record<StatutLot, Omit<DescripteurStatut, "code" | "connu">> = {
  RECU: {
    libelle: "Reçu",
    description: "Le fichier est reçu et son empreinte est calculée par le serveur. Rien n'est écrit dans le référentiel.",
    ton: "neutre",
    icone: "boite",
  },
  // Le libelle porte lui-meme « non applique » : un lot dont le schema est valide n'est PAS un lot importe.
  VALIDE_SCHEMA: {
    libelle: "Schéma validé : non appliqué",
    description: "Le fichier respecte le format attendu, mais il n'est pas appliqué : rien n'est écrit dans le référentiel.",
    ton: "attention",
    icone: "sablier",
  },
  IMPORTE_TEST: {
    libelle: "Importé en test",
    description: "Import d'essai. Ce statut existe, mais le serveur ne l'attribue pas encore.",
    ton: "info",
    icone: "fiole",
  },
  IMPORTE: {
    libelle: "Importé",
    description: "Le lot est appliqué au référentiel. Ce statut existe, mais le serveur ne l'attribue pas encore.",
    ton: "succes",
    icone: "coche",
  },
  REJETE: {
    libelle: "Rejeté",
    description: "Le fichier est lisible mais non conforme. Le motif est conservé avec le lot : c'est un résultat, pas une erreur. Rien n'est écrit dans le référentiel.",
    ton: "echec",
    icone: "croix",
  },
};

export function estStatutConnu(statut: unknown): statut is StatutLot {
  return typeof statut === "string" && Object.prototype.hasOwnProperty.call(STATUTS, statut);
}

/** Toujours une reponse, y compris pour un statut inattendu : l'ecran ne tombe pas et ne ment pas. */
export function descripteurStatut(statut: unknown): DescripteurStatut {
  if (estStatutConnu(statut)) return { code: statut, connu: true, ...STATUTS[statut] };
  const code = typeof statut === "string" ? abregerTexte(statut, 40) : "";
  return {
    code,
    connu: false,
    libelle: code === "" ? "Statut inconnu" : `Statut inconnu : ${code}`,
    description: "Ce statut n'est pas reconnu par cette version de l'application. Rien n'indique que le lot a été importé.",
    ton: "neutre",
    icone: "cercle",
  };
}

export function libelleStatut(statut: unknown): string {
  return descripteurStatut(statut).libelle;
}

// ---------------------------------------------------------------------------------------------------
// Etapes du cycle
// ---------------------------------------------------------------------------------------------------

export const ORDRE_ETAPES: readonly IdEtape[] = ["reception", "controle_schema", "echantillon", "import_autorise"];

export const TITRES_ETAPES: Record<IdEtape, string> = {
  reception: "Réception du fichier",
  controle_schema: "Contrôle du schéma",
  echantillon: "Échantillon à valider",
  import_autorise: "Import autorisé",
};

export interface DescripteurEtat {
  code: string;
  libelle: string;
  ton: NomTon;
  icone: NomIcone;
  /** Trait en tirets : l'etape n'existe pas encore dans l'application (dit par le serveur). */
  pointille: boolean;
  connu: boolean;
}

export const ETATS_ETAPE: readonly EtatEtape[] = ["TERMINEE", "TERMINEE_AVEC_RESERVES", "ECHEC", "EN_COURS", "NON_DISPONIBLE", "NON_COMMENCEE"];

const ETATS: Record<EtatEtape, Omit<DescripteurEtat, "code" | "connu">> = {
  TERMINEE: { libelle: "Terminée", ton: "succes", icone: "coche", pointille: false },
  TERMINEE_AVEC_RESERVES: { libelle: "Terminée avec réserves", ton: "attention", icone: "alerte", pointille: false },
  ECHEC: { libelle: "Échec", ton: "echec", icone: "croix", pointille: false },
  EN_COURS: { libelle: "En cours", ton: "info", icone: "chargement", pointille: false },
  NON_DISPONIBLE: { libelle: "Non disponible", ton: "neutre", icone: "cadenas", pointille: true },
  NON_COMMENCEE: { libelle: "Non commencée", ton: "neutre", icone: "cercle", pointille: false },
};

export function estEtatConnu(etat: unknown): etat is EtatEtape {
  return typeof etat === "string" && Object.prototype.hasOwnProperty.call(ETATS, etat);
}

/** Un etat inattendu est dit « inconnu » en neutre : il n'est jamais promu en etape terminee. */
export function descripteurEtat(etat: unknown): DescripteurEtat {
  if (estEtatConnu(etat)) return { code: etat, connu: true, ...ETATS[etat] };
  return { code: typeof etat === "string" ? abregerTexte(etat, 40) : "", connu: false, libelle: "État inconnu", ton: "neutre", icone: "cercle", pointille: false };
}

export function libelleEtatEtape(etat: unknown): string {
  return descripteurEtat(etat).libelle;
}

export function iconeEtape(etat: unknown): NomIcone {
  return descripteurEtat(etat).icone;
}

/** Les trois etats qui appellent une explication : sans `raison`, on dit qu'elle manque plutot que de l'inventer. */
const ETATS_A_EXPLIQUER: readonly string[] = ["ECHEC", "TERMINEE_AVEC_RESERVES", "NON_DISPONIBLE"];

export const RAISON_MANQUANTE = "Raison non précisée par le serveur.";

/** La raison fournie par le serveur, telle quelle ; jamais deduite par le client. */
export function raisonAffichee(etape: Pick<Etape, "etat" | "raison">): string {
  const raison = typeof etape.raison === "string" ? etape.raison.trim() : "";
  if (raison !== "") return raison;
  return ETATS_A_EXPLIQUER.includes(etape.etat) ? RAISON_MANQUANTE : "";
}

/** « Étape 3 sur 4, non disponible : Échantillon à valider. <raison> » : le nom accessible de l'etape. */
export function nomAccessibleEtape(rang: number, total: number, etape: Pick<Etape, "titre" | "etat" | "raison">): string {
  const etat = libelleEtatEtape(etape.etat);
  const raison = raisonAffichee(etape);
  const debut = `Étape ${rang} sur ${total}, ${etat.charAt(0).toLowerCase()}${etat.slice(1)} : ${etape.titre}`;
  return raison === "" ? `${debut}.` : `${debut}. ${raison}`;
}

/**
 * Quatre etapes toutes `NON_COMMENCEE`, pour la variante « aucun lot selectionne ». Textes ecrits par le
 * client parce qu'il n'y a pas de lot dont le serveur puisse parler ; ils n'affirment rien sur un lot.
 * La premiere dit que le formulaire est disponible, sans jamais se dire terminee.
 */
export function etapesAucunLot(): Etape[] {
  return ORDRE_ETAPES.map((id, i): Etape => ({
    id,
    titre: TITRES_ETAPES[id],
    etat: "NON_COMMENCEE",
    raison: i === 0
      ? "Disponible : formulaire ci-dessous."
      : id === "controle_schema" ? "Commence après la réception d'un lot." : "Aucun lot sélectionné.",
  }));
}

/** Rang (0) de l'etape `EN_COURS`, ou -1. Seule celle-ci porte `aria-current="step"`. */
export function indiceEtapeEnCours(etapes: readonly Pick<Etape, "etat">[]): number {
  return etapes.findIndex((e) => e.etat === "EN_COURS");
}

export interface ResumeEtapes {
  total: number;
  terminees: number;
  reserves: number;
  echecs: number;
  enCours: number;
  nonDisponibles: number;
  nonCommencees: number;
  inconnues: number;
  phrase: string;
}

const pluriel = (n: number, singulier: string, plur: string) => (n >= 2 ? plur : singulier);

/** Compte les etats et en tire une phrase (nom accessible de la liste d'etapes). */
export function resumeEtapes(etapes: readonly Pick<Etape, "etat">[] | null | undefined, options: { aucunLot?: boolean } = {}): ResumeEtapes {
  const liste = etapes ?? [];
  const r: ResumeEtapes = { total: liste.length, terminees: 0, reserves: 0, echecs: 0, enCours: 0, nonDisponibles: 0, nonCommencees: 0, inconnues: 0, phrase: "" };
  for (const e of liste) {
    switch (e.etat) {
      case "TERMINEE": r.terminees += 1; break;
      case "TERMINEE_AVEC_RESERVES": r.reserves += 1; break;
      case "ECHEC": r.echecs += 1; break;
      case "EN_COURS": r.enCours += 1; break;
      case "NON_DISPONIBLE": r.nonDisponibles += 1; break;
      case "NON_COMMENCEE": r.nonCommencees += 1; break;
      default: r.inconnues += 1;
    }
  }
  if (options.aucunLot) {
    r.phrase = `Aucun lot sélectionné : les ${r.total} étapes du cycle ne sont pas commencées.`;
    return r;
  }
  if (r.total === 0) {
    r.phrase = "Aucune étape à afficher.";
    return r;
  }
  const morceaux: string[] = [];
  if (r.terminees) morceaux.push(`${r.terminees} ${pluriel(r.terminees, "terminée", "terminées")}`);
  if (r.reserves) morceaux.push(`${r.reserves} ${pluriel(r.reserves, "terminée", "terminées")} avec réserves`);
  if (r.echecs) morceaux.push(`${r.echecs} en échec`);
  if (r.enCours) morceaux.push(`${r.enCours} en cours`);
  if (r.nonDisponibles) morceaux.push(`${r.nonDisponibles} ${pluriel(r.nonDisponibles, "non disponible", "non disponibles")}`);
  if (r.nonCommencees) morceaux.push(`${r.nonCommencees} ${pluriel(r.nonCommencees, "non commencée", "non commencées")}`);
  if (r.inconnues) morceaux.push(`${r.inconnues} dans un état inconnu`);
  r.phrase = `Avancement du lot, ${r.total} ${pluriel(r.total, "étape", "étapes")} : ${morceaux.join(", ")}.`;
  return r;
}

// ---------------------------------------------------------------------------------------------------
// Gouvernance (textes)
// ---------------------------------------------------------------------------------------------------

export const TITRE_GOUVERNANCE = "Recevoir un lot n'est pas importer.";

/**
 * Les cinq etats en UNE phrase. Elle dit aussi ce qu'un depot atteint au mieux (« validé techniquement »,
 * statut VALIDE_SCHEMA), pour ne pas laisser croire que les etats suivants existent deja.
 */
export const PHRASE_GOUVERNANCE =
  "Reçu, validé techniquement, approuvé par le métier, autorisé à écrire et importé sont cinq états distincts : déposer un fichier ne mène au mieux qu'à « validé techniquement », jamais à l'écriture dans le référentiel.";

export const LIBELLE_REGLES = "Voir les règles de réception";

/**
 * Les regles de reception. SOURCES (rien d'autre n'est affirme) :
 *   - docs/imports/CONTRAT-API-LOTS-IMPORT.md : principes, POST /api/v2/imports (codes 400, lot REJETE = resultat) ;
 *   - ROAD_SURVEY_IMPORT_SPEC.md, paragraphe 4 (regles « B.4 ») et paragraphe 3 (statut VALIDEE) ;
 *   - en-tete de backend/src/import/import.service.ts (empreinte serveur, idempotence, pas d'`appliquer`).
 * Ce que ces sources disent ne pas exister est ecrit « non disponible ».
 */
export const REGLES_RECEPTION: readonly { id: string; texte: string }[] = [
  { id: "ecriture", texte: "Recevoir un lot n'écrit rien dans le référentiel." },
  { id: "empreinte", texte: "L'empreinte du fichier (SHA-256) est calculée par le serveur sur les octets reçus. Elle n'est jamais fournie par l'utilisateur." },
  { id: "doublon", texte: "Le même fichier reçu deux fois pour la même source ne crée pas de nouveau lot : le lot existant est rendu et rien n'est écrit." },
  { id: "format", texte: "Si le contenu ne correspond pas au format déclaré, le fichier est refusé et rien n'est enregistré." },
  { id: "rejete", texte: "Un fichier lisible mais non conforme est enregistré comme lot « Rejeté », avec son motif : un lot rejeté est un résultat, pas une erreur. Les lignes rejetées ou ignorées sont exportables en CSV." },
  { id: "ligne", texte: "Une ligne conforme est « validée » mais en attente d'application : elle n'est ni importée ni rejetée." },
  { id: "referentiel", texte: "Les données importées n'écrasent jamais le référentiel, et aucune fusion ni suppression automatique n'est faite." },
  { id: "application", texte: "L'application au référentiel, l'approbation de l'échantillon et l'autorisation d'import : non disponible. Aucune de ces actions n'existe pour l'instant." },
];

// ---------------------------------------------------------------------------------------------------
// Messages de liste (cahier, 5.2 et AT-13, AT-14)
// ---------------------------------------------------------------------------------------------------

export const MESSAGE_AUCUN_LOT = "Aucun lot reçu. Sélectionnez un fichier et renseignez les informations obligatoires pour commencer.";
export const MESSAGE_AUCUN_RESULTAT = "Aucun résultat pour ces filtres.";
export const AIDE_AUCUN_RESULTAT = "Aucun des lots reçus ne correspond à votre recherche. Effacez les filtres pour revoir tous les lots.";
export const MESSAGE_ERREUR_LISTE = "La liste des lots n'a pas pu être chargée.";
export const MESSAGE_ERREUR_DROITS = "Votre profil ne permet pas de consulter les lots d'import.";
/** Une erreur n'est pas un vide : sans cette phrase, l'agent pourrait croire qu'aucun lot n'existe. */
export const AIDE_ERREUR_LISTE = "Ce n'est pas une liste vide : les lots déjà reçus n'ont pas disparu. Vous pouvez réessayer.";
export const AIDE_ERREUR_DROITS = "Seuls les profils administrateur et gestionnaire peuvent consulter les lots d'import.";

/** 403 : le profil n'a pas le droit. Tout autre cas (reseau, 5xx, absence de code) : la liste n'a pas pu etre chargee. */
export function messageErreurListe(statutHttp?: number | null): { message: string; aide: string; droits: boolean } {
  if (statutHttp === 403) return { message: MESSAGE_ERREUR_DROITS, aide: AIDE_ERREUR_DROITS, droits: true };
  return { message: MESSAGE_ERREUR_LISTE, aide: AIDE_ERREUR_LISTE, droits: false };
}

// ---------------------------------------------------------------------------------------------------
// Formats : taille, date, nom de fichier, texte
// ---------------------------------------------------------------------------------------------------

export const TAILLE_INCONNUE = "Taille inconnue";
const NBSP = " ";
const FINE = " ";
const UNITES_TAILLE: readonly (readonly [string, bigint])[] = [["Ko", 1024n], ["Mo", 1024n ** 2n], ["Go", 1024n ** 3n]];

/**
 * Taille en o / Ko / Mo (Go au-dela), depuis la CHAINE decimale du serveur (un BigInt serialise).
 * Aucun `Number()` : 9007199254740993 octets ne s'arrondissent pas en silence. Binaire (1 Ko = 1024 o), un
 * chiffre apres la virgule, TRONQUE et non arrondi : on ne gonfle jamais une taille (1048575 o = « 1023,9 Ko »,
 * pas « 1024 Ko »). Une chaine vide, negative, decimale ou non numerique donne « Taille inconnue », jamais « 0 o ».
 */
export function formaterTaille(tailleOctets: unknown): string {
  if (typeof tailleOctets !== "string") return TAILLE_INCONNUE;
  const t = tailleOctets.trim();
  if (!/^\d{1,30}$/.test(t)) return TAILLE_INCONNUE;
  const n = BigInt(t);
  if (n < 1024n) return `${n.toString()}${NBSP}o`;
  let choix = UNITES_TAILLE[0];
  for (const u of UNITES_TAILLE) if (n >= u[1]) choix = u;
  const dixiemes = (n * 10n) / choix[1];
  // Groupes de trois a partir de cinq chiffres (usage francais : « 1023,9 Mo », mais « 10 240 Mo »).
  const brut = (dixiemes / 10n).toString();
  const entier = brut.length >= 5 ? brut.replace(/\B(?=(\d{3})+(?!\d))/g, FINE) : brut;
  const decimale = dixiemes % 10n;
  return `${entier}${decimale === 0n ? "" : `,${decimale.toString()}`}${NBSP}${choix[0]}`;
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const DATE_INCONNUE = "Date inconnue";
export const DATE_ILLISIBLE = "Date illisible";

const FORME_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * Date en francais (« 25 octobre 2026 à 14 h 05 », « 1er novembre 2026 » pour une date seule), depuis une
 * chaine ISO 8601.
 *
 * DETERMINISTE : aucune horloge, aucun fuseau de la machine (`toLocaleString` varie avec le poste et la
 * version d'ICU, donc ne se teste pas par table). L'instant est affiche en UTC, qui est l'heure legale de la
 * Guinee (Conakry, GMT toute l'annee). Une heure sans decalage (« 2026-10-25T14:05:00 ») est lue en UTC,
 * comme le serveur la serialise (`Z`). Une valeur absente donne « Date inconnue », une valeur qui n'est pas
 * une date (mois 13, 30 fevrier, texte libre) « Date illisible » : jamais une date inventee.
 */
export function formaterDate(iso: unknown, options: { heure?: boolean } = {}): string {
  if (iso === null || iso === undefined || (typeof iso === "string" && iso.trim() === "")) return DATE_INCONNUE;
  if (typeof iso !== "string") return DATE_ILLISIBLE;
  const m = FORME_ISO.exec(iso.trim());
  if (!m) return DATE_ILLISIBLE;
  const annee = Number(m[1]);
  const mois = Number(m[2]);
  const jour = Number(m[3]);
  if (annee < 1000 || mois < 1 || mois > 12 || jour < 1 || jour > 31) return DATE_ILLISIBLE;
  const civile = new Date(Date.UTC(annee, mois - 1, jour));
  if (civile.getUTCMonth() !== mois - 1 || civile.getUTCDate() !== jour) return DATE_ILLISIBLE;

  const sansHeure = `${jour === 1 ? "1er" : String(jour)} ${MOIS[mois - 1]} ${annee}`;
  if (m[4] === undefined) return sansHeure;

  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (h > 23 || mi > 59 || s > 59) return DATE_ILLISIBLE;
  let decalageMin = 0;
  const z = m[7];
  if (z !== undefined && z !== "Z") {
    const brut = z.slice(1).replace(":", "");
    const dh = Number(brut.slice(0, 2));
    const dm = brut.length > 2 ? Number(brut.slice(2, 4)) : 0;
    if (dh > 23 || dm > 59) return DATE_ILLISIBLE;
    decalageMin = (z.startsWith("-") ? -1 : 1) * (dh * 60 + dm);
  }
  // Instant ramene a UTC : « 23:30-02:00 » est le lendemain a 01:30, la date affichee doit suivre.
  const u = new Date(Date.UTC(annee, mois - 1, jour, h, mi - decalageMin, s));
  const dateU = `${u.getUTCDate() === 1 ? "1er" : String(u.getUTCDate())} ${MOIS[u.getUTCMonth()]} ${u.getUTCFullYear()}`;
  if (options.heure === false) return dateU;
  return `${dateU} à ${u.getUTCHours()}${NBSP}h${NBSP}${String(u.getUTCMinutes()).padStart(2, "0")}`;
}

/** Vrai pour un signe qui ne doit jamais s'afficher : controle, invisible, ou capable d'inverser le sens de lecture. */
function estSigneInvisible(cp: number): boolean {
  return (
    cp < 32 || (cp >= 127 && cp <= 159) ||
    (cp >= 0x200b && cp <= 0x200f) || // espaces de largeur nulle, marques gauche-droite
    (cp >= 0x202a && cp <= 0x202e) || // inclusions et FORCAGES de sens (RLO : « gnp.csv » lu « csv.png »)
    (cp >= 0x2060 && cp <= 0x2069) || // joint de mots, isolats de sens
    cp === 0xfeff || cp === 0x00ad
  );
}

/** Retire controles et signes de sens, ramene les blancs a une espace, rogne. Le nom est une donnee de l'utilisateur. */
export function nettoyerTexte(texte: unknown): string {
  if (typeof texte !== "string") return "";
  let sortie = "";
  for (const signe of texte) {
    const cp = signe.codePointAt(0) ?? 0;
    if (cp === 9 || cp === 10 || cp === 13 || cp === 0x2028 || cp === 0x2029 || cp === 0xa0) sortie += " ";
    else if (!estSigneInvisible(cp)) sortie += signe;
  }
  return sortie.replace(/ {2,}/g, " ").trim();
}

/** Decoupe en graphemes quand le moteur sait le faire (une lettre accentuee, un emoji ne sont pas coupes en deux). */
function decouper(texte: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(texte), (s) => s.segment);
  }
  return Array.from(texte);
}

/** Texte nettoye et abrege a `max` signes avec « … » (detail technique d'une erreur, statut inconnu). */
export function abregerTexte(texte: unknown, max = 200): string {
  const propre = nettoyerTexte(texte);
  const signes = decouper(propre);
  const plafond = Number.isFinite(max) ? Math.max(2, Math.floor(max)) : 200;
  if (signes.length <= plafond) return propre;
  return `${signes.slice(0, plafond - 1).join("").trimEnd()}…`;
}

export const NOM_FICHIER_INCONNU = "Nom de fichier inconnu";

/**
 * Nom de fichier abrege pour l'affichage, SANS le fausser : l'extension est conservee (« rapport-d-inspe….csv »),
 * les signes de controle et de sens sont retires (un « invoice‮gnp.csv » ne doit pas se lire « invoice.png »),
 * aucun signe n'est coupe en deux, et le nom complet reste a la charge de l'appelant (infobulle, detail).
 * Le plancher de `max` est 12 : en dessous, une troncature ne dit plus rien.
 */
export function tronquerNomFichier(nom: unknown, max = 40): string {
  const propre = nettoyerTexte(nom);
  if (propre === "") return NOM_FICHIER_INCONNU;
  const signes = decouper(propre);
  const plafond = Number.isFinite(max) ? Math.max(12, Math.floor(max)) : 40;
  if (signes.length <= plafond) return propre;
  const point = signes.lastIndexOf(".");
  let extension = point > 0 ? signes.slice(point) : [];
  if (extension.length > 10) extension = [];
  let debut = plafond - 1 - extension.length;
  if (debut < 4) { extension = []; debut = plafond - 1; }
  return `${signes.slice(0, debut).join("").trimEnd()}…${extension.join("")}`;
}
