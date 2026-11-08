import { reponseApi, erreurHttp, type Params, type SurchargesApi } from "../conflitsPage.testutil";

/**
 * Fixtures 100 % SYNTHETIQUES du workflow concessionnaire (lot B3) : noms, identifiants et references inventes. Les constructeurs rendent le JSON tel que le BACKEND
 * le rend (formes relevees dans `projets-voirie/workflow/*.service.ts` : `vueDemande`, `vueTache`, `vueRecolement`, `lirePreuves`, `lireHistorique`, `monProfil`,
 * `listerReferents`, `listerJeuxVue`, `listerConflitsVue`, et docs/projets-voirie/API.md). Les tests simulent l'API avec ces fonctions.
 */

export { erreurHttp };

export const W = "/v2/projets-voirie/p1/workflow";
export const CONC_A = "c0000001-0000-4000-8000-00000000000a";
export const CONC_B = "c0000002-0000-4000-8000-00000000000b";
export const U_GEST = "a0000001-0000-4000-8000-0000000000a1";
export const U_ADMIN = "a0000002-0000-4000-8000-0000000000a2";
export const U_REF = "a0000003-0000-4000-8000-0000000000a3";
export const D1 = "d0000001-0000-4000-8000-000000000001";
export const D2 = "d0000002-0000-4000-8000-000000000002";
export const T1 = "b0000001-0000-4000-8000-000000000001";
export const T2 = "b0000002-0000-4000-8000-000000000002";
export const R1 = "e0000001-0000-4000-8000-000000000001";
export const R2 = "e0000002-0000-4000-8000-000000000002";
export const J1 = "11111111-1111-4111-8111-111111111111";
export const CF1 = "cf000001-0000-4000-8000-000000000001";

const pers = (id: string, nomComplet: string) => ({ id, nomComplet });
export const GESTIONNAIRE = pers(U_GEST, "Moussa Gestionnaire");
export const ADMIN = pers(U_ADMIN, "Fatou Admin");
export const REFERENT = pers(U_REF, "Ibrahima Referent");

const DROITS: Record<string, string[]> = {
  ADMIN: ["referent.gerer", "referent.lire", "workflow.lire", "demande.ecrire", "tache.gerer", "tache.executer", "preuve.ajouter", "recolement.ecrire", "recolement.valider"],
  GESTIONNAIRE: ["referent.lire", "workflow.lire", "demande.ecrire", "tache.gerer", "tache.executer", "preuve.ajouter", "recolement.ecrire"],
  INSPECTEUR: ["tache.executer", "preuve.ajouter"],
  LECTEUR: [],
  REFERENT: ["workflow.lire", "tache.executer", "preuve.ajouter"],
};

/** `GET workflow/mon-profil` pour un profil : droits par defaut de la matrice du contrat (3.2). */
export function profilServeur(profil: string, over: Record<string, unknown> = {}) {
  const referent = profil === "REFERENT";
  return {
    role: referent ? "LECTEUR" : profil, profil, referent,
    rattachements: referent ? [{ id: "ra000001-0000-4000-8000-000000000001", projet: { id: "p1", code: "VOIRIE-SYNTH-2026", nom: "Voirie synthetique" }, concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" } }] : [],
    droits: DROITS[profil] ?? [],
    matrice: { "workflow.lire": ["ADMIN", "GESTIONNAIRE", "REFERENT"], "recolement.valider": ["ADMIN"] },
    socle: [{ acte: "Autoriser ou rejeter un jeu", roles: ["ADMIN", "GESTIONNAIRE"], separation: "non bloquante (memePersonne note dans l'audit)" }],
    correspondanceCahier: [{ roleCahier: "Referent concessionnaire", compte: "LECTEUR", attribut: "cle de module projets-voirie et rattachement", resume: "Lit et complete uniquement les elements partages de son concessionnaire." }],
    provisoire: true, avertissements: [], ...over,
  };
}

export function demandeServeur(over: Record<string, unknown> = {}) {
  return {
    id: D1, projetId: "p1", concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, objet: "Plan des fourreaux de la rue 12", description: "Demande du plan as-built des fourreaux", echeance: "2099-12-31",
    statut: "BROUILLON", echeanceDepassee: false, envoi: null, reception: null, fin: null, creePar: GESTIONNAIRE, createdAt: "2026-11-02T08:00:00.000Z", updatedAt: "2026-11-02T08:00:00.000Z", ...over,
  };
}
export const demandeEnvoyee = (over: Record<string, unknown> = {}) => demandeServeur({
  id: D2, objet: "Releve des chambres du quartier nord", statut: "ENVOYEE",
  envoi: { dateEnvoi: "2026-11-03", canal: "Courriel", reference: "COUR-2026-41", interlocuteur: "Service reseaux", enregistrePar: GESTIONNAIRE, enregistreLe: "2026-11-03T09:00:00.000Z" }, ...over,
});
export const demandeRecue = (over: Record<string, unknown> = {}) => demandeEnvoyee({
  statut: "RECUE", reception: { dateReception: "2026-11-05", enregistrePar: GESTIONNAIRE, enregistreLe: "2026-11-05T09:00:00.000Z", jeu: { id: J1, version: 1, nomFichier: "reponse-synthetique.geojson", statut: "CONTROLE" }, jeuMasque: false }, ...over,
});

export const transTache = (vers: string, justificationRequise = true, separation = false) => ({ vers, justificationRequise, separation });
export function tacheServeur(over: Record<string, unknown> = {}) {
  return {
    id: T1, projetId: "p1", titre: "Verifier la profondeur de la gaine G-01", description: "Controle sur le terrain avec le concessionnaire", conflitId: null, demandeId: null, concessionnaire: null, partagee: false,
    responsable: GESTIONNAIRE, responsableEstMoi: true, echeance: "2099-12-31", echeanceDepassee: false, statut: "A_FAIRE", priorite: "NORMALE", validationRequise: true, termineLe: null,
    creePar: GESTIONNAIRE, createdAt: "2026-11-02T08:00:00.000Z", updatedAt: "2026-11-02T08:00:00.000Z", transitionsPossibles: [transTache("EN_COURS", false), transTache("ANNULEE")], ...over,
  };
}

export const transRec = (vers: string, droit = "ECRIRE") => ({ vers, droit });
export function recolementServeur(over: Record<string, unknown> = {}) {
  return {
    id: R1, projetId: "p1", conflit: { id: CF1, type: "INTERSECTION_CHAUSSEE", axe: "Axe A", statut: "TRAITEMENT_DECIDE" }, jeu: null, jeuMasque: false,
    concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, objet: "Recolement du deplacement de la fibre FO-01", constat: "Fibre deplacee de 3 m hors chaussee", ecarts: "Ecart de 0,4 m par rapport au plan",
    dateRecolement: "2026-11-06", statut: "BROUILLON", revision: 1, soumission: null, decision: null, creePar: GESTIONNAIRE, createdAt: "2026-11-04T08:00:00.000Z", updatedAt: "2026-11-04T08:00:00.000Z",
    transitionsPossibles: [transRec("SOUMIS")], ...over,
  };
}

export function preuveServeur(over: Record<string, unknown> = {}) {
  return {
    id: "p0000001-0000-4000-8000-000000000001", objetType: "RECOLEMENT", objetId: R1, type: "PLAN_RECOLEMENT", texte: "Plan de recolement signe, archive sous la reference ARCH-12.", reference: "ARCH-12 / javascript-non",
    nomFichier: "recolement-fo01.pdf", sha256: "ab".repeat(32), tailleOctets: 204800, partagee: true, auteur: GESTIONNAIRE, auteurProfil: "GESTIONNAIRE", createdAt: "2026-11-05T10:00:00.000Z", ...over,
  };
}

export const historiqueServeur = (over: Record<string, unknown> = {}) => ({
  id: "h0000001-0000-4000-8000-000000000001", action: "CREATION", ancienStatut: null, nouveauStatut: "BROUILLON", justification: null, acteur: GESTIONNAIRE, acteurProfil: "GESTIONNAIRE",
  donnees: { apres: { objet: "Recolement du deplacement de la fibre FO-01" } }, createdAt: "2026-11-04T08:00:00.000Z", ...over,
});
export const historiqueModification = () => historiqueServeur({
  id: "h0000002-0000-4000-8000-000000000002", action: "MODIFICATION", nouveauStatut: null, justification: "Correction de l'ecart apres le releve du 06/11",
  donnees: { avant: { ecarts: "Ecart de 1,2 m", constat: null }, apres: { ecarts: "Ecart de 0,4 m par rapport au plan", constat: "Fibre deplacee de 3 m hors chaussee" } }, createdAt: "2026-11-05T08:00:00.000Z",
});

export const pageServeur = (cle: string, liste: unknown[], compteurs: Record<string, number> | null, curseurSuivant: string | null = null) => ({ [cle]: liste, ...(compteurs ? { compteurs } : {}), curseurSuivant });
export const ficheDemandeServeur = (demande: unknown, transitionsPossibles: string[], preuves: unknown[] = [], historique?: unknown[]) => ({ demande, preuves, ...(historique ? { historique } : {}), transitionsPossibles });
export const ficheTacheServeur = (tache: Record<string, unknown>, preuves: unknown[] = [], historique?: unknown[]) => ({ tache, preuves, ...(historique ? { historique } : {}), transitionsPossibles: tache.transitionsPossibles });
export const ficheRecolementServeur = (recolement: Record<string, unknown>, preuves: unknown[] = [], historique?: unknown[]) => ({ recolement, preuves, ...(historique ? { historique } : {}), transitionsPossibles: recolement.transitionsPossibles });

export const rattachementServeur = (over: Record<string, unknown> = {}) => ({
  id: "ra000001-0000-4000-8000-000000000001", projetId: "p1", compte: REFERENT, concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, motif: "Referent designe par le concessionnaire", creePar: ADMIN,
  createdAt: "2026-11-03T08:00:00.000Z", actif: true, revocation: null, ...over,
});

export const jeuVueServeur = (over: Record<string, unknown> = {}) => ({
  id: J1, role: "RESEAU_TIERS", concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, version: 1, nomFichier: "reponse-synthetique.geojson", format: "GEOJSON", dateDonnees: "2026-11-04",
  nbObjets: 8, libelleNbObjets: "circuits ou objets du fichier", classePrecision: null, statut: "CONTROLE", ...over,
});
export const conflitVueServeur = (over: Record<string, unknown> = {}) => ({
  id: CF1, type: "INTERSECTION_CHAUSSEE", axe: "Axe A", statut: "TRAITEMENT_DECIDE", concessionnaire: { id: CONC_A, nom: "Operateur synthetique A" }, objet: { nom: "Fibre FO-01" },
  decisionRetenue: { option: "DEPLACER_RESEAU", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" }, risque: "ELEVE", echeance: null, aReexaminer: false, responsable: GESTIONNAIRE,
  createdAt: "2026-11-02T08:00:00.000Z", updatedAt: "2026-11-03T08:00:00.000Z", ...over,
});

export interface SurchargesWorkflow extends SurchargesApi {
  profil?: unknown;
  demandes?: unknown | ((p: Params) => unknown);
  fichesDemandes?: Record<string, unknown>;
  taches?: unknown | ((p: Params) => unknown);
  fichesTaches?: Record<string, unknown>;
  recolements?: unknown | ((p: Params) => unknown);
  fichesRecolements?: Record<string, unknown>;
  referents?: unknown;
  jeux?: unknown;
  conflits?: unknown | ((p: Params) => unknown);
  comptes?: unknown;
  concessionnaires?: unknown;
  projet?: unknown;
}

const estErreur = (v: unknown) => v instanceof Error || (!!v && typeof v === "object" && "response" in (v as object));
const rendu = (v: unknown) => { if (estErreur(v)) throw v; return { data: v }; };
const choisir = (v: unknown, p: Params, defaut: unknown) => (typeof v === "function" ? (v as (p: Params) => unknown)(p) : v !== undefined ? v : defaut);

/** API SIMULEE de l'ecran des echanges : profil, listes, fiches, referents, jeux, dossiers, comptes. Le reste suit la simulation de la page projet. */
export function reponseApiWorkflow(url: string, params: Params, over: SurchargesWorkflow = {}): { data: unknown } {
  if (url === "/v2/projets-voirie/workflow/mon-profil") return rendu(over.profil ?? profilServeur("GESTIONNAIRE"));
  if (url === "/v2/projets-voirie/concessionnaires") return rendu(over.concessionnaires ?? [{ id: CONC_A, nom: "Operateur synthetique A", typeReseau: "TELECOM" }, { id: CONC_B, nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE" }]);
  if (url === "/users") return rendu(over.comptes ?? { data: [{ id: U_REF, nomComplet: "Ibrahima Referent", email: "ibrahima@example.test", role: "LECTEUR", actif: true }], total: 1 });
  if (url === `${W}/demandes`) return rendu(choisir(over.demandes, params, pageServeur("demandes", [demandeServeur(), demandeEnvoyee()], { BROUILLON: 1, ENVOYEE: 1, RECUE: 0, CLOTUREE: 0, ANNULEE: 0 })));
  if (url.startsWith(`${W}/demandes/`)) {
    const id = decodeURIComponent(url.slice(`${W}/demandes/`.length));
    const f = over.fichesDemandes?.[id];
    if (f !== undefined) return rendu(f);
    return rendu(id === D2 ? ficheDemandeServeur(demandeEnvoyee(), ["RECUE", "CLOTUREE", "ANNULEE"], [], [historiqueServeur()]) : ficheDemandeServeur(demandeServeur(), ["ENVOYEE", "ANNULEE"], [], [historiqueServeur()]));
  }
  if (url === `${W}/taches`) return rendu(choisir(over.taches, params, pageServeur("taches", [tacheServeur(), tacheServeur({ id: T2, titre: "Relancer le concessionnaire", statut: "EN_COURS", responsableEstMoi: false, responsable: ADMIN, transitionsPossibles: [] })], { A_FAIRE: 1, EN_COURS: 1, A_VALIDER: 0, TERMINEE: 0, ANNULEE: 0 })));
  if (url.startsWith(`${W}/taches/`)) {
    const id = decodeURIComponent(url.slice(`${W}/taches/`.length));
    const f = over.fichesTaches?.[id];
    if (f !== undefined) return rendu(f);
    return rendu(ficheTacheServeur(tacheServeur(id === T2 ? { id: T2, statut: "EN_COURS" } : {}), [], [historiqueServeur()]));
  }
  if (url === `${W}/recolements`) return rendu(choisir(over.recolements, params, pageServeur("recolements", [recolementServeur()], { BROUILLON: 1, SOUMIS: 0, VALIDE: 0, REJETE: 0 })));
  if (url.startsWith(`${W}/recolements/`)) {
    const id = decodeURIComponent(url.slice(`${W}/recolements/`.length));
    const f = over.fichesRecolements?.[id];
    if (f !== undefined) return rendu(f);
    return rendu(ficheRecolementServeur(recolementServeur(), [], [historiqueServeur(), historiqueModification()]));
  }
  if (url === `${W}/referents`) return rendu(over.referents ?? { rattachements: [rattachementServeur()] });
  if (url === `${W}/jeux`) return rendu(over.jeux ?? { jeux: [jeuVueServeur()] });
  if (url === `${W}/conflits`) return rendu(choisir(over.conflits, params, { conflits: [conflitVueServeur()], curseurSuivant: null }));
  return reponseApi(url, params, over);
}
