/**
 * NOYAU DE LA VUE D'UN LOT : ce que le serveur DIT d'un lot au client -- ses etapes, ses actions
 * permises, ses colonnes, son apercu, son curseur. Le client affiche ; il ne decide jamais.
 *
 * LA REGLE QUI GOUVERNE TOUT CE FICHIER : ne jamais laisser croire a un import. L'application ne
 * cree rien dans le referentiel (voir import.service.ts) ; les etapes 3 et 4 du parcours n'ont pas
 * de circuit et le disent, avec leur raison. Aucune valeur n'est inventee : ce qu'on ne peut pas
 * calculer est `null`.
 *
 * Pur : ni base, ni horloge, ni reseau.
 */

import { COLONNES_PIVOT, type Compteurs } from "./pivot.noyau";
import {
  APERCU_COLONNES_MAX, APERCU_MOTIF_MAX, APERCU_VALEUR_MAX, COLONNES_INCONNUES_MAX, estImprimable, lignesEnErreur,
} from "./reception.noyau";

/** Les cinq statuts de l'enum `StatutLotImport`. Un test les compare a l'enum de Prisma. */
export const STATUTS_LOT = ["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"] as const;
export type StatutLot = (typeof STATUTS_LOT)[number];

/** Statuts qu'une ligne peut porter dans l'apercu (IMPORTEE n'existe pas a l'etape 1). */
export const STATUTS_LIGNE_APERCU = ["VALIDEE", "REJETEE", "IGNOREE", "EN_CONFLIT"] as const;

/* ====================================== Etapes ====================================== */

export type EtatEtape = "TERMINEE" | "TERMINEE_AVEC_RESERVES" | "ECHEC" | "EN_COURS" | "NON_DISPONIBLE" | "NON_COMMENCEE";
export type IdEtape = "reception" | "controle_schema" | "echantillon" | "import_autorise";
export interface Etape { id: IdEtape; titre: string; etat: EtatEtape; raison: string }

export interface EntreeVue {
  statut: StatutLot;
  compteurs: Compteurs;
  motifRejetLot: string | null;
}

export const RAISON_ECHANTILLON_INDISPONIBLE = "Aucun circuit de validation d'echantillon n'existe encore : decision DSI requise";
export const RAISON_IMPORT_INDISPONIBLE = "L'ecriture dans le referentiel n'est pas implementee : rien n'a ete cree";

const TITRES: Record<IdEtape, string> = {
  reception: "Réception",
  controle_schema: "Contrôle du schéma",
  echantillon: "Échantillon à valider",
  import_autorise: "Import autorisé",
};

/** « 3 lignes rejetees » / « 1 ligne rejetee » : le pluriel porte sur le nom ET l'adjectif. */
const lignesAdj = (n: number, adj: string) => (n > 1 ? `${n} lignes ${adj}s` : `${n} ligne ${adj}`);

/**
 * Les quatre etapes, dans l'ordre. VALIDE_SCHEMA veut dire « au moins une ligne VALIDEE », meme si
 * 99,9 % des lignes sont rejetees : l'etape de controle est donc `TERMINEE_AVEC_RESERVES` des qu'il
 * y a une ligne rejetee, ignoree ou en conflit.
 */
export function calculerEtapes(e: EntreeVue): Etape[] {
  const c = e.compteurs;
  const etape = (id: IdEtape, etat: EtatEtape, raison: string): Etape => ({ id, titre: TITRES[id], etat, raison });
  const reception = etape("reception", "TERMINEE",
    "Fichier recu, empreinte SHA-256 calculee par le serveur sur les octets recus. Rien n'a ete ecrit dans le referentiel.");

  if (e.statut === "REJETE") {
    return [
      reception,
      etape("controle_schema", "ECHEC", e.motifRejetLot ?? "Le fichier a ete rejete par le controle du schema."),
      etape("echantillon", "NON_COMMENCEE", "Le controle du schema a echoue : aucun echantillon n'est propose."),
      etape("import_autorise", "NON_COMMENCEE", "Le controle du schema a echoue : aucun import n'est possible. Rien n'a ete cree."),
    ];
  }

  const reserves = c.rejetees + c.ignorees + c.enConflit;
  const controleCalcule: Etape = reserves > 0
    ? etape("controle_schema", "TERMINEE_AVEC_RESERVES",
      `${lignesAdj(c.validees, "validee")} sur ${c.lues} ; ${lignesAdj(c.rejetees, "rejetee")}, ${lignesAdj(c.ignorees, "ignoree")}`
      + `${c.enConflit > 0 ? `, ${c.enConflit} en conflit` : ""}. Consultez les erreurs avant toute suite.`)
    : etape("controle_schema", "TERMINEE", `Les ${c.lues} lignes lues respectent le contrat du schema.`);

  if (e.statut === "VALIDE_SCHEMA") {
    return [
      reception, controleCalcule,
      etape("echantillon", "NON_DISPONIBLE", RAISON_ECHANTILLON_INDISPONIBLE),
      etape("import_autorise", "NON_DISPONIBLE", RAISON_IMPORT_INDISPONIBLE),
    ];
  }

  // RECU, IMPORTE_TEST, IMPORTE : dans l'enum, mais l'application ne les produit jamais. On ne
  // les lit JAMAIS comme une avancee : l'etape d'import reste indisponible et le dit.
  const inatteignable = `Statut ${e.statut} non produit par l'application actuelle`;
  if (e.statut === "RECU") {
    return [
      reception,
      etape("controle_schema", "NON_COMMENCEE", `${inatteignable} : aucun controle n'est enregistre pour ce lot.`),
      etape("echantillon", "NON_DISPONIBLE", RAISON_ECHANTILLON_INDISPONIBLE),
      etape("import_autorise", "NON_DISPONIBLE", RAISON_IMPORT_INDISPONIBLE),
    ];
  }
  return [
    reception,
    c.lues > 0 ? controleCalcule : etape("controle_schema", "NON_DISPONIBLE", `${inatteignable} : aucune ligne lue n'est enregistree.`),
    etape("echantillon", "NON_DISPONIBLE", `${inatteignable} : aucune validation d'echantillon n'est enregistree.`),
    etape("import_autorise", "NON_DISPONIBLE",
      `${inatteignable} : l'application n'ecrit pas dans le referentiel. Ne pas lire ce statut comme un import effectif.`),
  ];
}

/* ===================================== Actions permises ===================================== */

export type CodeAction = "TELECHARGER_ERREURS" | "VOIR_APERCU";
export interface ActionPermise { code: CodeAction; permise: boolean; raison: string | null }

/** Roles qui peuvent consulter les lots (les routes les imposent deja ; ce calcul les redit). */
const ROLES_CONSULTATION = new Set(["ADMIN", "GESTIONNAIRE"]);

/**
 * Aucune action d'approbation ni d'import n'existe : le serveur n'en offre pas, donc il n'en
 * annonce pas. Seules deux actions de LECTURE, avec leur raison quand elles ne sont pas permises.
 */
export function calculerActions(e: EntreeVue, role: string): ActionPermise[] {
  if (!ROLES_CONSULTATION.has(role)) {
    const raison = "Votre role ne permet pas de consulter les lots d'import.";
    return [
      { code: "TELECHARGER_ERREURS", permise: false, raison },
      { code: "VOIR_APERCU", permise: false, raison },
    ];
  }
  const enErreur = lignesEnErreur(e.compteurs);
  return [
    {
      code: "TELECHARGER_ERREURS", permise: enErreur > 0,
      raison: enErreur > 0 ? null : "Aucune ligne rejetee ou ignoree : il n'y a rien a telecharger.",
    },
    {
      code: "VOIR_APERCU", permise: e.compteurs.lues > 0,
      raison: e.compteurs.lues > 0 ? null : "Aucune ligne n'a pu etre lue dans ce fichier : il n'y a rien a apercevoir.",
    },
  ];
}

/* ======================================== Colonnes ======================================== */

/**
 * Colonnes reconnues (celles du pivot) et inconnues (le reste), calculees depuis les cles de la
 * charge originale. `_ligne_brute` est un marqueur interne de la lecture CSV, pas une colonne de la
 * source. `null` si aucune colonne n'est calculable (lot sans ligne).
 */
export function classerColonnes(cles: readonly string[]): { reconnues: string[]; inconnues: string[]; inconnuesTronquees: boolean } | null {
  const ensemble = new Set(cles.filter((c) => c !== "_ligne_brute"));
  if (ensemble.size === 0) return null;
  const reconnues = COLONNES_PIVOT.filter((c) => ensemble.has(c)) as string[];
  const toutes = [...ensemble].filter((c) => !(COLONNES_PIVOT as readonly string[]).includes(c)).sort();
  return { reconnues, inconnues: toutes.slice(0, COLONNES_INCONNUES_MAX), inconnuesTronquees: toutes.length > COLONNES_INCONNUES_MAX };
}

/* ========================================= Apercu ========================================= */

const tronquerTexte = (s: string, max: number): { texte: string; coupe: boolean } =>
  s.length > max ? { texte: s.slice(0, max), coupe: true } : { texte: s, coupe: false };

/**
 * Une ligne pour l'apercu : valeurs en TEXTE tronque a 200 caracteres, au plus 40 colonnes.
 * Le contenu vient du fichier d'un tiers : il est rendu tel quel dans du JSON, et c'est au client de
 * l'echapper a l'affichage (jamais de HTML cote serveur). `tronque` dit si quelque chose a ete coupe.
 */
export function formaterLignePourApercu(charge: unknown): { charge: Record<string, string>; tronque: boolean } {
  let tronque = false;
  if (charge === null || typeof charge !== "object" || Array.isArray(charge)) {
    const t = tronquerTexte(JSON.stringify(charge) ?? "", APERCU_VALEUR_MAX);
    return { charge: { valeur: t.texte }, tronque: t.coupe };
  }
  const entrees = Object.entries(charge as Record<string, unknown>);
  if (entrees.length > APERCU_COLONNES_MAX) tronque = true;
  const sortie = entrees.slice(0, APERCU_COLONNES_MAX).map(([k, v]) => {
    const brut = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    const t = tronquerTexte(brut, APERCU_VALEUR_MAX);
    if (t.coupe) tronque = true;
    return [tronquerTexte(k, APERCU_VALEUR_MAX).texte, t.texte] as [string, string];
  });
  // fromEntries : une colonne nommee `__proto__` reste une propriete, elle n'est pas avalee.
  return { charge: Object.fromEntries(sortie), tronque };
}

export function tronquerMotif(motif: string | null): { motif: string | null; coupe: boolean } {
  if (motif === null) return { motif: null, coupe: false };
  const t = tronquerTexte(motif, APERCU_MOTIF_MAX);
  return { motif: t.texte, coupe: t.coupe };
}

export function tronquerIdentifiant(id: string | null): { id: string | null; coupe: boolean } {
  if (id === null) return { id: null, coupe: false };
  const t = tronquerTexte(id, APERCU_VALEUR_MAX);
  return { id: t.texte, coupe: t.coupe };
}

/* ========================================= Curseur ========================================= */

export interface PositionCurseur { importeLe: Date; id: string }

/** Curseur OPAQUE (base64url) d'un couple (importeLe, id) : stable meme si des lots arrivent entre deux pages. */
export function encoderCurseur(p: PositionCurseur): string {
  return Buffer.from(JSON.stringify({ t: p.importeLe.toISOString(), i: p.id }), "utf8").toString("base64url");
}

/** Rend la position, ou `null` pour tout curseur qui n'est pas exactement ce que `encoderCurseur` produit. */
export function decoderCurseur(c: string): PositionCurseur | null {
  if (c.length === 0 || c.length > 200 || !/^[A-Za-z0-9_-]+$/.test(c)) return null;
  let o: unknown;
  try { o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")); } catch { return null; }
  if (o === null || typeof o !== "object") return null;
  const { t, i } = o as { t?: unknown; i?: unknown };
  if (typeof t !== "string" || typeof i !== "string" || i.length === 0 || i.length > 64 || !/^[\w-]+$/.test(i)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : { importeLe: d, id: i };
}

/* ======================================== Historique ======================================== */

export interface EntreeHistorique { date: string; action: string; acteur: string | null; details: string | null }

/**
 * Details SOBRES d'une ecriture d'audit : on ne lit que ce qu'on connait (reference, statut,
 * nombre de lignes lues) et on ne rend jamais le JSON brut -- ni empreinte, ni adresse IP, ni donnee
 * personnelle superflue. Une forme inconnue donne `null`, pas un dump.
 */
export function detailsSobres(action: string, apres: unknown): string | null {
  if (action !== "CREATE" || apres === null || typeof apres !== "object") return null;
  const a = apres as { reference?: unknown; statut?: unknown; compteurs?: { lues?: unknown } };
  if (typeof a.reference !== "string" || typeof a.statut !== "string") return null;
  const sur = (s: string) => (estImprimable(s) && s.length <= 40 ? s : "?");
  const lues = typeof a.compteurs?.lues === "number" ? `, ${lignesAdj(a.compteurs.lues, "lue")}` : "";
  return `Lot ${sur(a.reference)} enregistre : statut ${sur(a.statut)}${lues}.`;
}

/* ========================================== Rapport ========================================== */

export interface RapportLu {
  motifRejetLot: string | null;
  premiersRejets: { numeroLigne: number; statut: string; motif: string | null }[];
  avertissements: string[];
}

/** Lit le rapport jsonb d'un lot sans lui faire confiance : un rapport absent ou de forme inattendue donne des vides. */
export function lireRapport(rapport: unknown): RapportLu {
  const r = (rapport !== null && typeof rapport === "object" ? rapport : {}) as Record<string, unknown>;
  const premiers = Array.isArray(r.premiersRejets) ? r.premiersRejets : [];
  return {
    motifRejetLot: typeof r.motifRejetLot === "string" ? r.motifRejetLot : null,
    premiersRejets: premiers.flatMap((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return typeof o.numeroLigne === "number" && typeof o.statut === "string"
        ? [{ numeroLigne: o.numeroLigne, statut: o.statut, motif: typeof o.motif === "string" ? o.motif : null }] : [];
    }),
    avertissements: Array.isArray(r.avertissements) ? r.avertissements.filter((a): a is string => typeof a === "string") : [],
  };
}
