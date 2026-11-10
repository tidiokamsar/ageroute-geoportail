/**
 * CE QUE LES DOCUMENTS PERMETTENT (noyau pur, lot D1 ; contrat CONTRAT-DOCUMENTS.md, section 6). Sans base, sans E/S.
 *
 * Les FONCTIONS et leurs CONDITIONS sont des constantes du contrat (decision 2, section 6) ; les types de document sont des donnees (referentiel
 * TYPE_DOCUMENT du lot T1). Seuls les jeux AUTORISE comptent.
 *
 * INVARIANT D'INDEPENDANCE : une fonction est DISPONIBLE si et seulement si toutes SES conditions sont remplies. Rien d'autre n'intervient : ni un
 * document attendu, ni un type obligatoire non fourni, ni un DWG recu, ni une piece INCOMPLET, ni un autre reseau, ni une autre fonction. Prouve par
 * enumeration de tous les etats dans completude.noyau.test.ts.
 */

import { FONCTIONS_DEBLOQUABLES } from "../territoires/referentiels.noyau";
import type { StatutDocument } from "./etats.noyau";

export type Fonction = (typeof FONCTIONS_DEBLOQUABLES)[number];
export const FONCTIONS: readonly Fonction[] = FONCTIONS_DEBLOQUABLES;

export const CONDITIONS = ["PLAN_AXES_AUTORISE", "RESEAU_AUTORISE", "DEUX_SOURCES_MEME_RESEAU", "DECISION_DEPLACEMENT"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** `null` : fonction NON LIVREE (aucune condition ne la rend disponible dans cette version). */
export const CONDITIONS_PAR_FONCTION: Readonly<Record<Fonction, readonly Condition[] | null>> = {
  ANALYSE_2D: ["PLAN_AXES_AUTORISE", "RESEAU_AUTORISE"],
  CONFLITS: ["PLAN_AXES_AUTORISE", "RESEAU_AUTORISE"],
  COMPARAISON_SOURCES: ["DEUX_SOURCES_MEME_RESEAU"],
  RECOLEMENT: ["DECISION_DEPLACEMENT"],
  EXPORT_DOSSIER: null,
};

export const LIBELLES_FONCTION: Readonly<Record<Fonction, string>> = {
  ANALYSE_2D: "Analyse 2D (longueurs dans la chaussee et l'emprise)",
  CONFLITS: "Analyse des conflits (dossiers persistes)",
  COMPARAISON_SOURCES: "Comparaison de deux sources d'un meme reseau",
  RECOLEMENT: "Recolement d'un reseau deplace",
  EXPORT_DOSSIER: "Export du dossier technique",
};

export const LIBELLES_CONDITION: Readonly<Record<Condition, string>> = {
  PLAN_AXES_AUTORISE: "Un plan d'axes autorise",
  RESEAU_AUTORISE: "Un reseau de concessionnaire autorise",
  DEUX_SOURCES_MEME_RESEAU: "Deux sources autorisees d'un meme reseau (meme concessionnaire, meme type)",
  DECISION_DEPLACEMENT: "Une decision de deplacement de reseau approuvee",
};

/** Role de jeu qui remplit une condition (lien avec `roleJeu` des types de document) ; nul : la condition n'est pas une piece importee. */
export const ROLE_PAR_CONDITION: Readonly<Record<Condition, string | null>> = {
  PLAN_AXES_AUTORISE: "AXES_TRAVAUX",
  RESEAU_AUTORISE: "RESEAU_TIERS",
  DEUX_SOURCES_MEME_RESEAU: "RESEAU_TIERS",
  DECISION_DEPLACEMENT: null,
};

export interface ReseauEtat { cle: string; concessionnaireId: string | null; concessionnaireNom: string | null; typeReseau: string | null; nbSources: number }

/** Etat d'un projet tel que les fonctions le voient : jeux AUTORISE et decisions seulement. */
export interface EtatProjet { nbAxesAutorises: number; reseaux: readonly ReseauEtat[]; nbDecisionsDeplacement: number }

export type EtatFonction = "DISPONIBLE" | "INDISPONIBLE" | "NON_LIVREE";

export function conditionsRemplies(e: EtatProjet): Record<Condition, { remplie: boolean; nb: number }> {
  const deux = e.reseaux.filter((r) => r.nbSources >= 2).length;
  return {
    PLAN_AXES_AUTORISE: { remplie: e.nbAxesAutorises > 0, nb: e.nbAxesAutorises },
    RESEAU_AUTORISE: { remplie: e.reseaux.length > 0, nb: e.reseaux.length },
    DEUX_SOURCES_MEME_RESEAU: { remplie: deux > 0, nb: deux },
    DECISION_DEPLACEMENT: { remplie: e.nbDecisionsDeplacement > 0, nb: e.nbDecisionsDeplacement },
  };
}

export function etatsFonctions(e: EtatProjet): Record<Fonction, EtatFonction> {
  const c = conditionsRemplies(e);
  const sortie = {} as Record<Fonction, EtatFonction>;
  for (const f of FONCTIONS) {
    const cond = CONDITIONS_PAR_FONCTION[f];
    sortie[f] = cond === null ? "NON_LIVREE" : cond.every((x) => c[x].remplie) ? "DISPONIBLE" : "INDISPONIBLE";
  }
  return sortie;
}

const disponibles = (e: EtatProjet): Set<Fonction> => new Set(FONCTIONS.filter((f) => etatsFonctions(e)[f] === "DISPONIBLE"));

// ------------------------------------------------------------------------------------------------ Pieces manquantes

export interface TypeDocumentEntree { code: string; libelle: string; actif: boolean; obligatoire: boolean; fonctionsDebloquees: readonly string[]; roleJeu: string | null }
export interface DocumentEntree {
  id: string; ligneeId: string; version: number; typeCode: string; titre: string; statut: StatutDocument; format: string | null; concessionnaireId: string | null;
}

export type CodePiece = "PLAN_AXES_AUTORISE" | "RESEAU_AUTORISE" | "SECONDE_SOURCE" | "DECISION_DEPLACEMENT";
const CONDITION_DE_PIECE: Readonly<Record<CodePiece, Condition>> = {
  PLAN_AXES_AUTORISE: "PLAN_AXES_AUTORISE", RESEAU_AUTORISE: "RESEAU_AUTORISE", SECONDE_SOURCE: "DEUX_SOURCES_MEME_RESEAU", DECISION_DEPLACEMENT: "DECISION_DEPLACEMENT",
};

export interface DocumentVuPiece { id: string; version: number; titre: string; statut: StatutDocument; format: string | null; typeCode: string }

export type PieceManquante =
  | { nature: "CONDITION"; code: CodePiece; libelle: string; reseau: { concessionnaireId: string | null; concessionnaire: string | null; typeReseau: string | null } | null;
      fonctions: Fonction[]; suffiraitPour: Fonction[]; typesDocument: { code: string; libelle: string }[]; documents?: DocumentVuPiece[] }
  | { nature: "TYPE_OBLIGATOIRE"; typeDocument: { code: string; libelle: string }; roleJeu: string | null; fonctions: Fonction[]; suffiraitPour: Fonction[]; documents?: DocumentVuPiece[] }
  | { nature: "DOCUMENT"; document: DocumentVuPiece; fonctions: Fonction[] };

/** Statuts d'une piece qui MANQUE encore au dossier (en attente, recue non examinee, a reprendre, ou rejetee sans version plus recente). */
export const STATUTS_PIECE_MANQUANTE: readonly StatutDocument[] = ["ATTENDU", "RECU", "EN_ANALYSE", "INCOMPLET", "A_CORRIGER", "REJETE"];

const estFonction = (v: string): v is Fonction => (FONCTIONS as readonly string[]).includes(v);

export interface EntreeCompletude {
  etat: EtatProjet;
  types: readonly TypeDocumentEntree[];
  /** Documents non retires VISIBLES du compte (un lecteur ne recoit que les VALIDE : l'appelant filtre). */
  documents: readonly DocumentEntree[];
  /** Nombre de jeux AUTORISE par role (types obligatoires fournis par un jeu). */
  jeuxAutorisesParRole: Readonly<Record<string, number>>;
  /** Les documents en cours ne sont montres qu'a un compte qui decide. */
  decideur: boolean;
}

export interface Completude {
  fonctions: { code: Fonction; libelle: string; etat: EtatFonction; conditions: { code: Condition; libelle: string; remplie: boolean; nb: number }[] }[];
  reseaux: { concessionnaireId: string | null; concessionnaire: string | null; typeReseau: string | null; nbSources: number; comparable: boolean }[];
  piecesManquantes: PieceManquante[];
  documents: { total: number; parStatut: Partial<Record<StatutDocument, number>> };
}

/** Dernieres versions de chaque lignee parmi les documents visibles. */
function dernieres(docs: readonly DocumentEntree[]): DocumentEntree[] {
  const m = new Map<string, DocumentEntree>();
  for (const d of docs) { const x = m.get(d.ligneeId); if (!x || d.version > x.version) m.set(d.ligneeId, d); }
  return [...m.values()];
}

const vuePiece = (d: DocumentEntree): DocumentVuPiece => ({ id: d.id, version: d.version, titre: d.titre, statut: d.statut, format: d.format, typeCode: d.typeCode });

export function calculerCompletude(x: EntreeCompletude): Completude {
  const etats = etatsFonctions(x.etat);
  const conds = conditionsRemplies(x.etat);
  const actuelles = disponibles(x.etat);
  const indisponibles = FONCTIONS.filter((f) => etats[f] === "INDISPONIBLE");
  const typesActifs = x.types.filter((t) => t.actif);
  const derniers = dernieres(x.documents);
  const manquants = derniers.filter((d) => STATUTS_PIECE_MANQUANTE.includes(d.statut));
  const suffit = (apres: EtatProjet): Fonction[] => FONCTIONS.filter((f) => !actuelles.has(f) && disponibles(apres).has(f));
  const typesDuRole = (role: string | null) => (role === null ? [] : typesActifs.filter((t) => t.roleJeu === role).map((t) => ({ code: t.code, libelle: t.libelle })));
  const documentsDesTypes = (codes: string[], concessionnaireId?: string | null) => manquants
    .filter((d) => codes.includes(d.typeCode) && (concessionnaireId === undefined || d.concessionnaireId === null || d.concessionnaireId === concessionnaireId))
    .map(vuePiece);

  const pieces: PieceManquante[] = [];
  const pieceCondition = (code: CodePiece, apres: EtatProjet, reseau: ReseauEtat | null) => {
    const condition = CONDITION_DE_PIECE[code];
    const typesDocument = typesDuRole(ROLE_PAR_CONDITION[condition]);
    pieces.push({
      nature: "CONDITION", code,
      libelle: code === "SECONDE_SOURCE" ? (reseau ? "Une seconde source autorisee de ce reseau" : LIBELLES_CONDITION.DEUX_SOURCES_MEME_RESEAU) : LIBELLES_CONDITION[condition],
      reseau: reseau ? { concessionnaireId: reseau.concessionnaireId, concessionnaire: reseau.concessionnaireNom, typeReseau: reseau.typeReseau } : null,
      fonctions: indisponibles.filter((f) => (CONDITIONS_PAR_FONCTION[f] ?? []).includes(condition)),
      suffiraitPour: suffit(apres),
      typesDocument,
      ...(x.decideur ? { documents: documentsDesTypes(typesDocument.map((t) => t.code), reseau ? reseau.concessionnaireId : undefined) } : {}),
    });
  };
  if (!conds.PLAN_AXES_AUTORISE.remplie) pieceCondition("PLAN_AXES_AUTORISE", { ...x.etat, nbAxesAutorises: 1 }, null);
  if (!conds.RESEAU_AUTORISE.remplie) {
    pieceCondition("RESEAU_AUTORISE", { ...x.etat, reseaux: [...x.etat.reseaux, { cle: "(nouveau)", concessionnaireId: null, concessionnaireNom: null, typeReseau: null, nbSources: 1 }] }, null);
  }
  if (!conds.DEUX_SOURCES_MEME_RESEAU.remplie) {
    if (x.etat.reseaux.length === 0) {
      pieceCondition("SECONDE_SOURCE", { ...x.etat, reseaux: [{ cle: "(nouveau)", concessionnaireId: null, concessionnaireNom: null, typeReseau: null, nbSources: 2 }] }, null);
    } else {
      for (const r of x.etat.reseaux) {
        pieceCondition("SECONDE_SOURCE", { ...x.etat, reseaux: x.etat.reseaux.map((y) => (y.cle === r.cle ? { ...y, nbSources: y.nbSources + 1 } : y)) }, r);
      }
    }
  }
  if (!conds.DECISION_DEPLACEMENT.remplie) pieceCondition("DECISION_DEPLACEMENT", { ...x.etat, nbDecisionsDeplacement: 1 }, null);

  // Types obligatoires non fournis : fourni = un jeu AUTORISE de son role, ou un document VALIDE de ce type.
  for (const t of typesActifs.filter((y) => y.obligatoire)) {
    const parJeu = t.roleJeu !== null && (x.jeuxAutorisesParRole[t.roleJeu] ?? 0) > 0;
    const parDocument = x.documents.some((d) => d.typeCode === t.code && d.statut === "VALIDE");
    if (parJeu || parDocument) continue;
    const fonctions = t.fonctionsDebloquees.filter(estFonction).filter((f) => etats[f] === "INDISPONIBLE");
    // Si le type est fourni par un jeu de son role, les conditions de ce role deviennent remplies (ce qu'une piece de ce seul type debloquerait).
    let apres: EtatProjet = x.etat;
    if (t.roleJeu === "AXES_TRAVAUX") apres = { ...x.etat, nbAxesAutorises: x.etat.nbAxesAutorises + 1 };
    else if (t.roleJeu === "RESEAU_TIERS" && x.etat.reseaux.length === 0) apres = { ...x.etat, reseaux: [{ cle: "(nouveau)", concessionnaireId: null, concessionnaireNom: null, typeReseau: null, nbSources: 1 }] };
    pieces.push({
      nature: "TYPE_OBLIGATOIRE", typeDocument: { code: t.code, libelle: t.libelle }, roleJeu: t.roleJeu, fonctions, suffiraitPour: suffit(apres),
      ...(x.decideur ? { documents: documentsDesTypes([t.code]) } : {}),
    });
  }

  // Documents en cours ou rejetes sans version plus recente (comptes qui decident seulement).
  if (x.decideur) {
    for (const d of manquants) {
      const t = x.types.find((y) => y.code === d.typeCode);
      pieces.push({ nature: "DOCUMENT", document: vuePiece(d), fonctions: (t?.fonctionsDebloquees ?? []).filter(estFonction).filter((f) => etats[f] === "INDISPONIBLE") });
    }
  }

  const parStatut: Partial<Record<StatutDocument, number>> = {};
  for (const d of x.documents) parStatut[d.statut] = (parStatut[d.statut] ?? 0) + 1;
  return {
    fonctions: FONCTIONS.map((f) => ({
      code: f, libelle: LIBELLES_FONCTION[f], etat: etats[f],
      conditions: (CONDITIONS_PAR_FONCTION[f] ?? []).map((c) => ({ code: c, libelle: LIBELLES_CONDITION[c], remplie: conds[c].remplie, nb: conds[c].nb })),
    })),
    reseaux: x.etat.reseaux.map((r) => ({ concessionnaireId: r.concessionnaireId, concessionnaire: r.concessionnaireNom, typeReseau: r.typeReseau, nbSources: r.nbSources, comparable: r.nbSources >= 2 })),
    piecesManquantes: pieces,
    documents: { total: x.documents.length, parStatut },
  };
}

/** Reseaux d'un projet depuis ses jeux AUTORISE de role RESEAU_TIERS : meme identite que l'eligibilite du lot S1 (concessionnaire, famille de type). */
export function reseauxDepuisJeux(jeux: readonly { role: string; concessionnaireId: string | null; concessionnaireNom: string | null; typeReseau: string | null }[]): ReseauEtat[] {
  const m = new Map<string, ReseauEtat>();
  for (const j of jeux) {
    if (j.role !== "RESEAU_TIERS") continue;
    const cle = `${j.concessionnaireId ?? ""}|${j.typeReseau ?? ""}`;
    const r = m.get(cle);
    if (r) r.nbSources++;
    else m.set(cle, { cle, concessionnaireId: j.concessionnaireId, concessionnaireNom: j.concessionnaireNom, typeReseau: j.typeReseau, nbSources: 1 });
  }
  return [...m.values()].sort((a, b) => a.cle.localeCompare(b.cle));
}
