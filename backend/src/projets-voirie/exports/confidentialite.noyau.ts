/**
 * QUI SORT EN GEOJSON, ET LA DEROGATION DE CONFIDENTIALITE (noyau pur, lot X1 ; contrat CONTRAT-EXPORTS.md, sections 2.3, 2.4, 4.3 et 5).
 *
 * REGLE : un jeu RETIRE n'apparait nulle part ; un jeu non AUTORISE n'est jamais exporte en GeoJSON ; un jeu AUTORISE l'est si son niveau est dans la
 * liste des niveaux exportables (defaut PUBLIC, INTERNE, RESTREINT_PROJET ; le reglage ne peut que restreindre), ou si son niveau est
 * CONFIDENTIEL_CONCESSIONNAIRE ou INFRASTRUCTURE_SENSIBLE ET qu'une derogation ADMIN, citee et valide, le couvre. Un niveau inconnu est traite comme
 * sensible (echec ferme). Aucune autre voie : ni role, ni reglage.
 */

import { NIVEAUX_EXPORTABLES_DEFAUT, NIVEAUX_SOUS_DEROGATION } from "./config";

export type RaisonEcart = "NON_AUTORISE" | "CONFIDENTIALITE" | "NIVEAU_NON_EXPORTABLE" | "GEOJSON_NON_DEMANDE";

export interface JeuCandidat { id: string; role: string; version: number; statut: string; confidentialite: string }

export interface SelectionGeojson<J extends JeuCandidat> {
  inclus: { jeu: J; derogation: boolean }[];
  ecartes: { jeu: J; raison: RaisonEcart }[];
}

const sousDerogation = (niveau: string): boolean => (NIVEAUX_SOUS_DEROGATION as readonly string[]).includes(niveau);

export function selectionGeojson<J extends JeuCandidat>(jeux: readonly J[], o: { demande: boolean; niveaux: readonly string[]; jeuxDerogation: ReadonlySet<string> }): SelectionGeojson<J> {
  const sortie: SelectionGeojson<J> = { inclus: [], ecartes: [] };
  for (const jeu of jeux) {
    if (jeu.statut === "RETIRE") continue;
    if (jeu.statut !== "AUTORISE") { sortie.ecartes.push({ jeu, raison: "NON_AUTORISE" }); continue; }
    if (!o.demande) { sortie.ecartes.push({ jeu, raison: "GEOJSON_NON_DEMANDE" }); continue; }
    const niveau = jeu.confidentialite;
    // Niveau sensible : la derogation seule l'ouvre ; la liste des niveaux exportables n'est JAMAIS consultee pour lui (un reglage errone n'y peut rien).
    if (sousDerogation(niveau)) {
      if (o.jeuxDerogation.has(jeu.id)) sortie.inclus.push({ jeu, derogation: true });
      else sortie.ecartes.push({ jeu, raison: "CONFIDENTIALITE" });
    } else if (!(NIVEAUX_EXPORTABLES_DEFAUT as readonly string[]).includes(niveau)) {
      // Niveau inconnu (valeur future de l'enumeration) : echec ferme, sans derogation possible.
      sortie.ecartes.push({ jeu, raison: "CONFIDENTIALITE" });
    } else if (o.niveaux.includes(niveau)) {
      sortie.inclus.push({ jeu, derogation: false });
    } else {
      sortie.ecartes.push({ jeu, raison: "NIVEAU_NON_EXPORTABLE" });
    }
  }
  return sortie;
}

// ------------------------------------------------------------------------------------------------ Derogation

export type EtatDerogation = "DISPONIBLE" | "UTILISEE" | "EXPIREE";

export function etatDerogation(d: { utiliseeLe: Date | null; expireLe: Date }, maintenant: Date): EtatDerogation {
  if (d.utiliseeLe) return "UTILISEE";
  return d.expireLe.getTime() <= maintenant.getTime() ? "EXPIREE" : "DISPONIBLE";
}

export type Verdict = { ok: true } | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };
const refus = (status: number, code: string, message: string, extra?: Record<string, unknown>): Verdict => ({ ok: false, status, code, message, ...(extra ? { extra } : {}) });

export interface DerogationLue { id: string; projetId: string; beneficiaireId: string; jeuxIds: string[]; utiliseeLe: Date | null; expireLe: Date }

/**
 * Derogation citee par un export. Inconnue, d'un autre projet ou d'un autre beneficiaire : la MEME reponse 404 (rien n'est revele de son existence) ;
 * utilisee ou expiree : 409 avec l'etat.
 */
export function verifierDerogationCitee(d: DerogationLue | null, c: { projetId: string; acteurId: string; maintenant: Date }): Verdict {
  if (!d || d.projetId !== c.projetId || d.beneficiaireId !== c.acteurId) return refus(404, "DEROGATION_INTROUVABLE", "Dérogation introuvable pour ce projet et ce compte.");
  const etat = etatDerogation(d, c.maintenant);
  if (etat !== "DISPONIBLE") {
    return refus(409, "DEROGATION_INDISPONIBLE", etat === "UTILISEE" ? "Cette dérogation a déjà servi à un export : elle est à usage unique." : "Cette dérogation a expiré : demandez-en une nouvelle à un administrateur.", { etat });
  }
  return { ok: true };
}

export const JUSTIFICATION_DEROGATION_MIN = 20;

export interface JeuDerogation { id: string; statut: string; confidentialite: string }

/** Creation d'une derogation : jeux du projet (non retires), tous AUTORISE, tous d'un niveau sous derogation ; justification ; duree. */
export function verifierCreationDerogation(e: { demandes: readonly string[]; trouves: ReadonlyMap<string, JeuDerogation>; justification: string; dureeH: number; dureeMaxH: number }): Verdict {
  if (e.justification.trim().length < JUSTIFICATION_DEROGATION_MIN) {
    return refus(400, "JUSTIFICATION_INVALIDE", `Une dérogation exige une justification de ${JUSTIFICATION_DEROGATION_MIN} caractères au moins.`);
  }
  if (!Number.isInteger(e.dureeH) || e.dureeH < 1 || e.dureeH > e.dureeMaxH) return refus(400, "CHAMPS_INVALIDES", `Durée de 1 à ${e.dureeMaxH} heures.`);
  if (e.demandes.length === 0 || e.demandes.length > 20 || new Set(e.demandes).size !== e.demandes.length) return refus(400, "CHAMPS_INVALIDES", "1 à 20 jeux distincts.");
  for (const id of e.demandes) {
    const j = e.trouves.get(id);
    if (!j || j.statut === "RETIRE") return refus(404, "JEU_INTROUVABLE", "Jeu de données introuvable dans ce projet (ou retiré).", { jeuId: id });
    if (j.statut !== "AUTORISE") return refus(409, "JEU_NON_AUTORISE", "Seul un jeu AUTORISE peut être exporté, même par dérogation.", { jeuId: id, statut: j.statut });
    if (!sousDerogation(j.confidentialite)) {
      return refus(409, "DEROGATION_INUTILE", "Ce jeu n'est pas d'un niveau soumis à dérogation : il s'exporte sans elle (ou son niveau a été retiré de la liste par le réglage).", { jeuId: id, confidentialite: j.confidentialite });
    }
  }
  return { ok: true };
}

export interface Beneficiaire { actif: boolean; role: string; modules: readonly string[]; perimetreCouvre: boolean }

export function verifierBeneficiaire(b: Beneficiaire | null): Verdict {
  if (!b || !b.actif || !(b.role === "ADMIN" || b.role === "GESTIONNAIRE") || (b.role !== "ADMIN" && !b.modules.includes("projets-voirie"))) {
    return refus(422, "BENEFICIAIRE_NON_HABILITE", "Le bénéficiaire doit être un compte actif ADMIN ou GESTIONNAIRE portant la clé du module.");
  }
  if (!b.perimetreCouvre) return refus(422, "BENEFICIAIRE_HORS_PERIMETRE", "Le périmètre du bénéficiaire ne couvre pas la région de ce projet.");
  return { ok: true };
}
