/**
 * Noyau pur de l'ecran « Baremes de cout » (lot 6) : types de la reponse, construction du corps d'une modification (seuls les
 * champs QUI CHANGENT sont envoyes, motif obligatoire), regle « ce qui change le calcul desapprouve », libelles de
 * l'historique. Aucune horloge, aucun DOM, aucun appel reseau.
 *
 * Le serveur reste maitre (`backend/src/api-v2/baremes.routes.ts`) : il reverifie le motif, la validite, la version lue et la
 * separation des taches. Ces regles preparent la saisie et annoncent la consequence AVANT l'enregistrement.
 */

export interface BaremeLigne {
  id: number;
  familleRevetement: string;
  etatDepart: string;
  typeIntervention: string;
  coutKmGnf: string;
  uniteCout: string;
  devise: string;
  code: string | null;
  libelle: string | null;
  source: string;
  version: number;
  actif?: boolean;
  approuveLe: string | null;
  approuvePar: string | null;
  statutApprobation?: "APPROUVE" | "NON_APPROUVE";
  anneeReference: number | null;
  largeurChausseeM: string | null;
  validDe: string | null;
  validA: string | null;
  commentaire: string | null;
}

export interface EvenementBareme {
  id: number;
  version: number;
  evenement: "MODIFICATION" | "APPROBATION" | string;
  champsModifies: string[];
  modifieCalcul: boolean;
  approbationReinitialisee: boolean;
  statutApprobation: string;
  valeursAvant: Record<string, unknown>;
  valeursApres: Record<string, unknown>;
  auteur: { id: string | null; email: string };
  motif: string;
  commentaire: string | null;
  creeLe: string;
}

/** Champs qui entrent dans le calcul d'un cout : les changer retire l'approbation et incremente la version. */
export const CHAMPS_CALCUL = ["coutKmGnf", "uniteCout", "devise", "anneeReference", "largeurChausseeM", "validDe", "validA", "source"] as const;

export const LIBELLE_CHAMP: Record<string, string> = {
  coutKmGnf: "Coût par km", uniteCout: "Unité", devise: "Devise", anneeReference: "Millésime", largeurChausseeM: "Largeur de chaussée",
  validDe: "Début de validité", validA: "Fin de validité", source: "Source", libelle: "Libellé", commentaire: "Commentaire", approbation: "Approbation",
};

export const LONGUEUR_MIN_MOTIF = 5;

export interface Saisie {
  cout: string; annee: string; largeur: string; validDe: string; validA: string; source: string; libelle: string; commentaire: string; motif: string;
}

export function saisieDepuis(l: BaremeLigne): Saisie {
  return {
    cout: l.coutKmGnf, annee: l.anneeReference !== null ? String(l.anneeReference) : "", largeur: l.largeurChausseeM ?? "",
    validDe: l.validDe ?? "", validA: l.validA ?? "", source: l.source, libelle: l.libelle ?? "", commentaire: l.commentaire ?? "", motif: "",
  };
}

export interface CorpsModification {
  coutKmGnf?: string; anneeReference?: number | null; largeurChausseeM?: number | null; validDe?: string | null; validA?: string | null;
  source?: string; libelle?: string; commentaire?: string | null; motif: string; versionAttendue: number;
}

export type ResultatSaisie =
  | { ok: true; corps: CorpsModification; champs: string[]; changeLeCalcul: boolean }
  | { ok: false; erreurs: string[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateValide(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

/** Construit le corps de la modification : seuls les champs qui CHANGENT, plus le motif et la version lue. */
export function construireModification(l: BaremeLigne, s: Saisie): ResultatSaisie {
  const erreurs: string[] = [];
  const corps: Partial<CorpsModification> = {};
  const champs: string[] = [];

  const cout = s.cout.trim();
  if (!/^[1-9]\d{0,17}$/.test(cout)) erreurs.push("Le coût par kilomètre doit être un entier strictement positif, en GNF, en chiffres seulement.");
  else if (cout !== l.coutKmGnf) { corps.coutKmGnf = cout; champs.push("coutKmGnf"); }

  const annee = s.annee.trim();
  if (annee === "") { if (l.anneeReference !== null) { corps.anneeReference = null; champs.push("anneeReference"); } }
  else if (!/^\d{4}$/.test(annee) || Number(annee) < 1990 || Number(annee) > 2100) erreurs.push("Le millésime doit être une année entre 1990 et 2100.");
  else if (Number(annee) !== l.anneeReference) { corps.anneeReference = Number(annee); champs.push("anneeReference"); }

  const largeur = s.largeur.trim().replace(",", ".");
  if (largeur === "") { if (l.largeurChausseeM !== null) { corps.largeurChausseeM = null; champs.push("largeurChausseeM"); } }
  else if (!/^\d+(\.\d+)?$/.test(largeur) || Number(largeur) <= 0 || Number(largeur) > 30) erreurs.push("La largeur de chaussée doit être un nombre de mètres entre 0 et 30.");
  else if (l.largeurChausseeM === null || Number(largeur) !== Number(l.largeurChausseeM)) { corps.largeurChausseeM = Number(largeur); champs.push("largeurChausseeM"); }

  for (const [cle, brut, courant, nom] of [["validDe", s.validDe, l.validDe, "début"], ["validA", s.validA, l.validA, "fin"]] as const) {
    const v = brut.trim();
    if (v === "") { if (courant !== null) { corps[cle] = null; champs.push(cle); } }
    else if (!dateValide(v)) erreurs.push(`La date de ${nom} de validité doit être une date AAAA-MM-JJ valide.`);
    else if (v !== courant) { corps[cle] = v; champs.push(cle); }
  }
  const de = s.validDe.trim(); const a = s.validA.trim();
  if (de && a && dateValide(de) && dateValide(a) && de > a) erreurs.push("La fin de validité précède le début de validité.");

  const source = s.source.trim();
  if (source === "") erreurs.push("La source du prix est obligatoire.");
  else if (source.length > 120) erreurs.push("La source est limitée à 120 caractères.");
  else if (source !== l.source) { corps.source = source; champs.push("source"); }

  const libelle = s.libelle.trim();
  if (libelle.length > 200) erreurs.push("Le libellé est limité à 200 caractères.");
  else if (libelle !== "" && libelle !== (l.libelle ?? "")) { corps.libelle = libelle; champs.push("libelle"); }

  const commentaire = s.commentaire.trim();
  if (commentaire.length > 2000) erreurs.push("Le commentaire est limité à 2 000 caractères.");
  else if (commentaire !== (l.commentaire ?? "")) { corps.commentaire = commentaire === "" ? null : commentaire; champs.push("commentaire"); }

  const motif = s.motif.trim();
  if (motif.length < LONGUEUR_MIN_MOTIF) erreurs.push(`Le motif est obligatoire (${LONGUEUR_MIN_MOTIF} caractères au moins).`);

  if (champs.length === 0 && erreurs.length === 0) erreurs.push("Aucune valeur ne change : rien à enregistrer.");
  if (erreurs.length > 0) return { ok: false, erreurs };
  return {
    ok: true, corps: { ...corps, motif, versionAttendue: l.version } as CorpsModification, champs,
    changeLeCalcul: champs.some((c) => (CHAMPS_CALCUL as readonly string[]).includes(c)),
  };
}

/** Consequence annoncee AVANT l'enregistrement : le calcul change-t-il, l'approbation est-elle retiree ? */
export function consequenceModification(changeLeCalcul: boolean, approuvee: boolean): string {
  if (!changeLeCalcul) return "Seuls le libellé ou le commentaire changent : la version et l'approbation ne sont pas touchées.";
  return approuvee
    ? "Un champ qui entre dans le calcul change : la version sera incrémentée et l'approbation RETIRÉE. Un autre compte que vous devra approuver de nouveau."
    : "Un champ qui entre dans le calcul change : la version sera incrémentée.";
}

export interface CorpsApprobation { motif: string; commentaire: string; versionAttendue: number }

export function construireApprobation(l: BaremeLigne, motif: string, commentaire: string): { ok: true; corps: CorpsApprobation } | { ok: false; erreurs: string[] } {
  const erreurs: string[] = [];
  if (motif.trim().length < LONGUEUR_MIN_MOTIF) erreurs.push(`Le motif est obligatoire (${LONGUEUR_MIN_MOTIF} caractères au moins).`);
  if (commentaire.trim().length < LONGUEUR_MIN_MOTIF) erreurs.push(`Le commentaire est obligatoire (${LONGUEUR_MIN_MOTIF} caractères au moins).`);
  if (erreurs.length > 0) return { ok: false, erreurs };
  return { ok: true, corps: { motif: motif.trim(), commentaire: commentaire.trim(), versionAttendue: l.version } };
}

/** Raison pour laquelle « Approuver » est inactif, ou null. Un prix sans millesime ni largeur est illisible. */
export function raisonApprobationImpossible(l: BaremeLigne): string | null {
  if (l.approuveLe !== null) return "Cette version est déjà approuvée.";
  const m: string[] = [];
  if (l.anneeReference === null) m.push("le millésime");
  if (l.largeurChausseeM === null) m.push("la largeur de chaussée");
  return m.length > 0 ? `Poser d'abord ${m.join(" et ")} : approuver un prix illisible est refusé.` : null;
}

export function libelleEvenement(e: EvenementBareme): string {
  if (e.evenement === "APPROBATION") return "Approbation";
  return e.modifieCalcul ? (e.approbationReinitialisee ? "Modification (approbation retirée)" : "Modification du calcul") : "Modification descriptive";
}

function valeurLisible(v: unknown): string {
  return v === null || v === undefined || v === "" ? "non renseigné" : String(v);
}

/** « Millésime : non renseigné → 2026 » pour chaque champ modifié ; l'approbation se lit a part. */
export function lignesChangement(e: EvenementBareme): string[] {
  if (e.evenement === "APPROBATION") return [];
  return e.champsModifies
    .filter((c) => c in LIBELLE_CHAMP)
    .map((c) => `${LIBELLE_CHAMP[c]} : ${valeurLisible(e.valeursAvant[c])} → ${valeurLisible(e.valeursApres[c])}`);
}

export function messageActionRefusee(e: unknown, repli: string): { statut: number | null; code: string | null; message: string } {
  const r = (e as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } } | null | undefined)?.response;
  return {
    statut: typeof r?.status === "number" ? r.status : null,
    code: typeof r?.data?.code === "string" ? r.data.code : null,
    message: typeof r?.data?.error === "string" && r.data.error.trim() ? r.data.error : repli,
  };
}

// ---------------------------------------------------------------------------------------------- prix exact

const ESPACE = " ";
const grouper = (chiffres: string): string => chiffres.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE);

/**
 * Prix EXACT, sans passer par un flottant (un nombre perd des unites au-dela de 2^53 et « 400000 » ne doit jamais devenir
 * « 0 M »). `cout` est la chaine de chiffres du serveur. Une chaine illisible n'est pas affichee comme un montant.
 */
export function prixExact(cout: string, devise: string): string {
  const t = typeof cout === "string" ? cout.trim() : "";
  if (!/^\d+$/.test(t)) return "Prix illisible";
  return `${grouper(t.replace(/^0+(?=\d)/, ""))}${ESPACE}${devise}/km`;
}

/**
 * Forme abregee « ≈ 3,5 Md GNF/km », calculee en BigInt (arrondi au dixieme). `null` sous un million : le prix exact suffit et
 * aucun arrondi n'est annonce. Un arrondi qui atteindrait 1 000 M passe en milliards.
 */
export function prixAbrege(cout: string, devise: string): string | null {
  const t = typeof cout === "string" ? cout.trim() : "";
  if (!/^\d+$/.test(t)) return null;
  const v = BigInt(t);
  const MILLION = BigInt(1_000_000);
  const MILLIARD = BigInt(1_000_000_000);
  if (v < MILLION) return null;
  const dixiemes = (seuil: bigint) => (v * BigInt(10) + seuil / BigInt(2)) / seuil;
  let seuil = v >= MILLIARD ? MILLIARD : MILLION;
  let d = dixiemes(seuil);
  if (seuil === MILLION && d >= BigInt(10_000)) { seuil = MILLIARD; d = dixiemes(seuil); }
  const entier = d / BigInt(10);
  const dec = d % BigInt(10);
  const texte = dec === BigInt(0) ? grouper(String(entier)) : `${grouper(String(entier))},${dec}`;
  return `≈${ESPACE}${texte}${ESPACE}${seuil === MILLIARD ? "Md" : "M"}${ESPACE}${devise}/km`;
}
