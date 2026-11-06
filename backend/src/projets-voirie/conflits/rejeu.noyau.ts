/**
 * REJEU D'UNE ANALYSE SUR LES CONFLITS EXISTANTS, COMPARAISON DE DEUX ANALYSES, EMPREINTE DES JEUX (noyau pur ; contrat, section 5).
 *
 * REGLES (contrat, section 2, regle 4) :
 *   - une nouvelle analyse ne supprime ni ne ferme jamais un conflit ;
 *   - un conflit retrouve (meme cle) met a jour la derniere analyse, la mesure et le drapeau `aReexaminer` ;
 *   - un conflit NON retrouve reste en base, `aReexaminer = true`, motif NON_RETROUVE ;
 *   - un conflit nouveau est cree ;
 *   - AUCUN STATUT n'est modifie par un rejeu : ni un verdict humain, ni la classification initiale. Si la classe de precision du jeu a
 *     change, le dossier est marque a reexaminer (NOUVELLE_VERSION_DONNEES) : c'est a une personne de requalifier.
 *
 * IDEMPOTENCE : rejouer les memes entrees ne change rien d'autre que la derniere analyse ; aucune ligne d'historique n'est ajoutee
 * pour un dossier inchange (RETROUVE n'est ecrit que lorsqu'un dossier non retrouve reapparait).
 */

import type { ClassePrecision, MotifReexamen, StatutConflit } from "./types.noyau";

export interface ConflitExistant {
  id: string;
  cle: string;
  statut: StatutConflit;
  empreinteMesure: string;
  /** Empreinte des jeux de la derniere analyse qui l'a trouve (voir `jeuxToken`) ; nulle si inconnue (jamais un motif de reexamen). */
  jeuxToken: string | null;
  classePrecision: ClassePrecision;
  aReexaminer: boolean;
  motifReexamen: MotifReexamen | null;
}

export interface ConflitTrouve {
  cle: string;
  empreinteMesure: string;
  jeuxToken: string;
  classePrecision: ClassePrecision;
}

export type ActionHistoriqueRejeu = "MESURE_MODIFIEE" | "RETROUVE" | "REEXAMEN";

export type ActionRejeu =
  | { genre: "CREER"; cle: string }
  | {
      genre: "RETROUVER"; cle: string; id: string;
      mesureModifiee: boolean; versionDonneesModifiee: boolean; classeModifiee: boolean; reapparu: boolean;
      aReexaminer: boolean; motifReexamen: MotifReexamen | null;
      /** Ligne d'historique a ajouter, ou nul si le dossier est inchange. */
      historique: ActionHistoriqueRejeu | null;
    }
  | { genre: "NON_RETROUVE"; cle: string; id: string; aReexaminer: true; motifReexamen: "NON_RETROUVE"; historique: "REEXAMEN" | null };

export interface ResumeRejeu {
  nouveaux: number;
  retrouves: number;
  identiques: number;
  modifies: number;
  disparus: number;
  reapparus: number;
  marquesAReexaminer: number;
}

export function calculerRejeu(existants: readonly ConflitExistant[], trouves: readonly ConflitTrouve[]): { actions: ActionRejeu[]; resume: ResumeRejeu } {
  const parCle = new Map(existants.map((x) => [x.cle, x] as const));
  const vus = new Set<string>();
  const actions: ActionRejeu[] = [];
  const resume: ResumeRejeu = { nouveaux: 0, retrouves: 0, identiques: 0, modifies: 0, disparus: 0, reapparus: 0, marquesAReexaminer: 0 };

  for (const n of [...trouves].sort((a, b) => (a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0))) {
    if (vus.has(n.cle)) continue;
    vus.add(n.cle);
    const ex = parCle.get(n.cle);
    if (!ex) { actions.push({ genre: "CREER", cle: n.cle }); resume.nouveaux += 1; continue; }

    const mesureModifiee = ex.empreinteMesure !== n.empreinteMesure;
    const versionDonneesModifiee = ex.jeuxToken !== null && ex.jeuxToken !== n.jeuxToken;
    const classeModifiee = ex.classePrecision !== n.classePrecision;
    const reapparu = ex.aReexaminer && ex.motifReexamen === "NON_RETROUVE";

    // Priorite des motifs : la mesure modifiee l'emporte sur un changement de version ou de classe des donnees.
    const motif: MotifReexamen | null = mesureModifiee ? "MESURE_MODIFIEE" : versionDonneesModifiee || classeModifiee ? "NOUVELLE_VERSION_DONNEES" : null;
    let aReexaminer = ex.aReexaminer;
    let motifReexamen = ex.motifReexamen;
    if (motif) { aReexaminer = true; motifReexamen = motif; }
    else if (reapparu) { aReexaminer = false; motifReexamen = null; }

    const historique: ActionHistoriqueRejeu | null = mesureModifiee ? "MESURE_MODIFIEE" : versionDonneesModifiee || classeModifiee ? "REEXAMEN" : reapparu ? "RETROUVE" : null;
    actions.push({ genre: "RETROUVER", cle: n.cle, id: ex.id, mesureModifiee, versionDonneesModifiee, classeModifiee, reapparu, aReexaminer, motifReexamen, historique });
    resume.retrouves += 1;
    if (mesureModifiee) resume.modifies += 1; else resume.identiques += 1;
    if (reapparu) resume.reapparus += 1;
    if (motif) resume.marquesAReexaminer += 1;
  }

  for (const ex of [...existants].sort((a, b) => (a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0))) {
    if (vus.has(ex.cle)) continue;
    resume.disparus += 1;
    const deja = ex.aReexaminer && ex.motifReexamen === "NON_RETROUVE";
    actions.push({ genre: "NON_RETROUVE", cle: ex.cle, id: ex.id, aReexaminer: true, motifReexamen: "NON_RETROUVE", historique: deja ? null : "REEXAMEN" });
    if (!deja) resume.marquesAReexaminer += 1;
  }
  return { actions, resume };
}

// ------------------------------------------------------------------------------------------------
// Empreinte des jeux (detection d'une nouvelle version des donnees)
// ------------------------------------------------------------------------------------------------

export interface JeuAnalyse { jeuId: string; sha256: string; role: string }

/**
 * Empreinte des donnees dont depend un conflit : le(s) plan(s) d'axes et le jeu de reseau qui l'a produit.
 * `axes|reseau` ; vide pour une partie absente. Deux analyses sur les memes fichiers donnent le meme texte.
 */
export function jeuxToken(jeux: readonly JeuAnalyse[], jeuReseauId: string | null): string {
  const axes = jeux.filter((j) => j.role === "AXES_TRAVAUX").map((j) => j.sha256).sort().join("+");
  const reseau = jeuReseauId ? (jeux.find((j) => j.jeuId === jeuReseauId)?.sha256 ?? "") : "";
  return `${axes}|${reseau}`;
}

// ------------------------------------------------------------------------------------------------
// Comparaison de deux analyses
// ------------------------------------------------------------------------------------------------

export interface ComparaisonInstantanes {
  apparus: string[];
  disparus: string[];
  modifies: string[];
  identiques: string[];
}

/**
 * Compare deux instantanes { cle : empreinte de mesure }.
 *   - apparus   : presents dans `comparee`, absents de `reference` ;
 *   - disparus  : presents dans `reference`, absents de `comparee` ;
 *   - modifies  : presents des deux cotes avec une mesure differente ;
 *   - identiques: presents des deux cotes avec la meme mesure.
 * Listes triees : la comparaison est deterministe.
 */
export function comparerInstantanes(reference: Readonly<Record<string, string>>, comparee: Readonly<Record<string, string>>): ComparaisonInstantanes {
  const tri = (l: string[]) => l.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const apparus: string[] = [], disparus: string[] = [], modifies: string[] = [], identiques: string[] = [];
  for (const [cle, empreinte] of Object.entries(comparee)) {
    if (!Object.prototype.hasOwnProperty.call(reference, cle)) apparus.push(cle);
    else if (reference[cle] === empreinte) identiques.push(cle);
    else modifies.push(cle);
  }
  for (const cle of Object.keys(reference)) if (!Object.prototype.hasOwnProperty.call(comparee, cle)) disparus.push(cle);
  return { apparus: tri(apparus), disparus: tri(disparus), modifies: tri(modifies), identiques: tri(identiques) };
}
