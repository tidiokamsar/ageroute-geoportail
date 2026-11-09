/**
 * COMPARAISON PERSISTEE ENTRE DEUX SOURCES D UN MEME RESEAU (lot S1 ; contrat CONTRAT-SOURCES.md, sections 3.3, 3.4, 4 et 5).
 *
 * Une comparaison lit deux jeux AUTORISES de meme concessionnaire et de meme type, apparie leurs objets lineaires par corridor (max des precisions
 * declarees + marge) dans le CRS metrique de l analyse 2D, et ecrit UNE ligne immuable (jeux, regle, algorithme, resume, instantane) et un
 * resultat par objet. Elle ne modifie, ne fusionne et ne rend AUCUNE geometrie ; elle ne decide rien : seule une personne, avec justification,
 * ouvre depuis une divergence un dossier de conflit RC-3 (`ouvrirDossierDivergence`).
 *
 * GARDES : une comparaison a la fois par projet (verrou consultatif, 503 PROJET_OCCUPE), trois calculs par processus (503 SERVICE_OCCUPE), delai
 * cote BASE (statement_timeout, 504 COMPARAISON_TROP_LONGUE), plafonds (422 COMPARAISON_TROP_VOLUMINEUSE), cadence entre deux comparaisons terminees
 * (429 COMPARAISON_TROP_FREQUENTE). LISIBILITE : celle de RC-3 (visibilite.noyau.ts) appliquee aux DEUX jeux.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { Budget, avecErreurDelai, estDelaiDepasse, poserDelais } from "../bd";
import { comparaisonIntervalleMinS, comparaisonObjetsMax, delaiAnalyseMs, delaiDepotMs, delaiVerrouMs } from "../config";
import * as socle from "../analyse.depot";
import { SOMMETS_RESEAU_ANALYSE_MAX } from "../analyse.service";
import { verifierCadence } from "../conflits/cadence.noyau";
import { cellule, cleConflit, cleReseau } from "../conflits/classification.noyau";
import { decoderCurseurAnalyse, encoderCurseurAnalyse } from "../conflits/curseurs.noyau";
import { exigerProjetActif } from "../conflits/dossiers.service";
import { JUSTIFICATION_MIN, estDecideur } from "../conflits/types.noyau";
import { donneesReseauLisibles, dossierVisible, jeuLisible } from "../conflits/visibilite.noyau";
import { tracerConsultation } from "../consultation";
import { ErreurMetier, introuvable } from "../erreurs";
import { limiteurAnalyses } from "../limiteurs";
import { contexteSpatialDuProjet, type ContexteSpatial } from "../territoires/contexte-spatial";
import { verrouillerProjet, type Acteur } from "../projets.service";
import { descripteursDesObjets } from "../reseaux/reseaux.depot";
import { classeEffective } from "../reseaux/types.noyau";
import {
  assemblerResultats, identiteObjet, instantaneDe, totauxDe, type AppariementBrut, type ObjetCompare,
} from "./classification-sources.noyau";
import * as depot from "./comparaison.depot";
import { baremeApprouve, precisionRetenue, resoudreRegleRapprochement, type RegleRapprochementLue } from "./regle-rapprochement.noyau";
import { regleLue } from "./regles-rapprochement.service";
import { evaluerEligibilite, type ModeComparaison, type MotifNonComparable } from "./eligibilite.noyau";
import { AXE_DIVERGENCE_SOURCES, LIMITES_COMPARAISON, STATUTS_RESULTAT_COMPARAISON, VERSION_ALGORITHME_COMPARAISON, type StatutResultatComparaison } from "./types.noyau";

const TAILLE_LOT = 1000;
const lots = <T>(l: readonly T[], n = TAILLE_LOT): T[][] => { const s: T[][] = []; for (let i = 0; i < l.length; i += n) s.push(l.slice(i, i + n)); return s; };
const cleVerrou = (projetId: string) => `pv-sources-comparaison|${projetId}`;
const COMPARAISON_INTROUVABLE = () => introuvable("Comparaison", "COMPARAISON_INTROUVABLE");

type LigneJeu = Prisma.JeuDonneesProjetGetPayload<{ include: { concessionnaire: { select: { id: true; nom: true } } } }>;

/** Colonnes rendues par la liste et le detail : TOUTES SAUF `instantane` (revue RC-3, M2 : il ne sert qu au rejeu et a la comparaison de deux comparaisons). */
export const SELECT_COMPARAISON = {
  id: true, projetId: true, numero: true, statut: true, mode: true, role: true, jeuAId: true, jeuBId: true, concessionnaireId: true, typeReseau: true, regle: true, jeux: true,
  versionAlgorithme: true, epsg: true, resume: true, declencheParId: true, duree: true, createdAt: true,
} as const;
type LigneComparaisonVue = Prisma.ComparaisonSourcesGetPayload<{ select: typeof SELECT_COMPARAISON }>;

export interface JeuDansComparaison {
  role: "A" | "B"; jeuId: string; sha256: string; version: number; methodeAcquisition: string | null; typeReseauCode?: string | null; dateDonnees: string | null; classePrecision: string | null;
  precisionHorizontaleM: number | null; nbObjets: number; nomFichier: string; confidentialite: string;
}

const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Vue d une comparaison. `statutsJeux` : statuts COURANTS des deux jeux ; les donnees tirees des jeux (empreinte, nom de fichier, precision, methode)
 * ne sont rendues que si elles sont lisibles pour le role (jamais pour un jeu RETIRE) ; le resume (agregats figes) est toujours rendu (choix de RC-3).
 */
export function vueComparaison(c: LigneComparaisonVue, role: string, statutsJeux: readonly string[], declenchePar: { id: string; nomComplet: string } | null) {
  const lisible = donneesReseauLisibles(role, statutsJeux);
  const jeux = Array.isArray(c.jeux) ? (c.jeux as unknown as JeuDansComparaison[]) : [];
  return {
    id: c.id, projetId: c.projetId, numero: c.numero, statut: c.statut, mode: c.mode, role: c.role, jeuAId: c.jeuAId, jeuBId: c.jeuBId, concessionnaireId: c.concessionnaireId, typeReseau: c.typeReseau,
    regle: c.regle, versionAlgorithme: c.versionAlgorithme, epsg: c.epsg, resume: c.resume,
    jeux: lisible ? jeux : jeux.map((j) => ({ role: j.role, jeuId: j.jeuId })),
    donneesMasquees: !lisible, declenchePar, duree: c.duree, createdAt: c.createdAt, limites: [...LIMITES_COMPARAISON],
  };
}

// ------------------------------------------------------------------------------------------------
// Eligibilite des deux jeux
// ------------------------------------------------------------------------------------------------

const nonComparables = (motif: MotifNonComparable, message: string) => new ErreurMetier(409, "JEUX_NON_COMPARABLES", message, { motif });

/**
 * Les deux jeux du projet, ordonnes (A = la reference autorisee), et le mode, ou une erreur typee (eligibilite.noyau.ts). Un jeu inconnu, d un autre
 * projet ou illisible pour le compte : 404 (aucun sondage de l existence d un jeu).
 */
async function jeuxOrdonnes(lecteur: Pick<typeof prisma, "jeuDonneesProjet">, acteur: Acteur, projetId: string, jeuAId: string, jeuBId: string): Promise<{ a: LigneJeu; b: LigneJeu; mode: ModeComparaison }> {
  if (jeuAId === jeuBId) throw nonComparables("MEME_JEU", "Une source ne se compare pas à elle-même : désignez deux jeux distincts.");
  const l = await lecteur.jeuDonneesProjet.findMany({ where: { id: { in: [jeuAId, jeuBId] }, projetId }, include: { concessionnaire: { select: { id: true, nom: true } } } });
  const j1 = l.find((j) => j.id === jeuAId), j2 = l.find((j) => j.id === jeuBId);
  if (!j1 || !j2 || !jeuLisible(acteur.role, j1.statut) || !jeuLisible(acteur.role, j2.statut)) throw introuvable("Jeu de données", "JEU_INTROUVABLE");
  const v = evaluerEligibilite(j1, j2);
  if (!v.ok) throw nonComparables(v.motif, v.message);
  return { a: v.a as LigneJeu, b: v.b as LigneJeu, mode: v.mode };
}

async function exigerCadence(lecteur: Pick<typeof prisma, "comparaisonSources">, projetId: string): Promise<void> {
  const derniere = await lecteur.comparaisonSources.aggregate({ where: { projetId, statut: "TERMINEE" }, _max: { createdAt: true } });
  const v = verifierCadence({ derniereTermineeLe: derniere._max.createdAt, maintenant: new Date(), intervalleS: comparaisonIntervalleMinS() });
  if (!v.ok) {
    throw new ErreurMetier(429, "COMPARAISON_TROP_FREQUENTE",
      `Une comparaison de ce projet date de moins de ${comparaisonIntervalleMinS()} s : réessayez dans ${v.retryAfterS} s (le résultat serait identique tant que les données ne changent pas).`,
      { retryAfterS: v.retryAfterS });
  }
}

// ------------------------------------------------------------------------------------------------
// Lancement
// ------------------------------------------------------------------------------------------------

export interface ResumeComparaison {
  statut: "TERMINEE";
  versionAlgorithme: string;
  totaux: Record<StatutResultatComparaison, number> & { resultats: number; objetsA: number; objetsB: number; nonEvaluesA: number; nonEvaluesB: number };
  corridor: { minM: number | null; maxM: number | null; couplesSansCorridor: number; margeM: number; rayonAppariementM: number };
  /** Correctifs T1+S1 (M6) : corridors fondes sur une classe convertie par un bareme approuve (regle, version, approbateur). */
  bareme: { applique: boolean; couples: number; regle: { regleId: string | null; code: string; version: number; approuveParId: string | null } | null };
  /** Correctifs T1+S1 (M1) : CRS metrique de calcul et son origine. */
  crs: { epsg: number; source: "TERRITOIRE" | "BANDES"; crsImpose: number | null; territoireId: string | null };
  limites: string[];
}

export async function lancerComparaison(acteur: Acteur, projetId: string, d: { jeuAId: string; jeuBId: string }) {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true, code: true } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  const { a, b, mode } = await jeuxOrdonnes(prisma, acteur, projetId, d.jeuAId, d.jeuBId);
  await exigerCadence(prisma, projetId);
  // Correctifs T1+S1 (M1) : meme CRS metrique que l'analyse 2D, les conflits et les associations (CRS impose par le territoire du projet ou son ancetre,
  // sinon regle par bandes de la configuration). Lu AVANT le delai : la lecture rafraichit aussi le cache de la configuration.
  const spatial = await contexteSpatialDuProjet(projetId);
  const debut = performance.now();
  const delai = delaiAnalyseMs();
  const trop = () => new ErreurMetier(504, "COMPARAISON_TROP_LONGUE", `La comparaison a dépassé ${Math.round(delai / 1000)} s et a été interrompue : les deux sources sont trop volumineuses pour un calcul immédiat.`);
  try {
    return await limiteurAnalyses.executer(() => avecErreurDelai("COMPARAISON_TROP_LONGUE", trop().message, () => prisma.$transaction(
      (tx) => executer(tx, acteur, projet, a, b, mode, debut, delai, trop, spatial),
      { timeout: delai + delaiDepotMs() + 15_000, maxWait: 10_000 },
    )));
  } catch (e) {
    if (e instanceof ErreurMetier && (e.status === 504 || e.code === "COMPARAISON_TROP_VOLUMINEUSE")) {
      await enregistrerEchec(acteur, projet, a, b, mode, e, Math.round(performance.now() - debut)).catch(() => undefined);
    }
    throw e;
  }
}

const jeuDansComparaison = (role: "A" | "B", j: LigneJeu): JeuDansComparaison => ({
  role, jeuId: j.id, sha256: j.sha256, version: j.version, methodeAcquisition: j.methodeAcquisition, typeReseauCode: j.typeReseauCode, dateDonnees: jour(j.dateDonnees), classePrecision: j.classePrecision,
  precisionHorizontaleM: j.precisionHorizontaleM === null ? null : Number(j.precisionHorizontaleM), nbObjets: j.nbObjets, nomFichier: j.nomFichier, confidentialite: j.confidentialite,
});

async function executer(tx: Prisma.TransactionClient, acteur: Acteur, projet: { id: string; code: string }, a: LigneJeu, b: LigneJeu, mode: ModeComparaison, debut: number, delai: number, trop: () => Error, spatial: ContexteSpatial) {
  const verrou = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${cleVerrou(projet.id)}, 0)) AS "ok"`;
  if (!verrou[0]?.ok) throw new ErreurMetier(503, "PROJET_OCCUPE", "Une comparaison de sources est déjà en cours sur ce projet : réessayez dans quelques instants.");
  await exigerCadence(tx, projet.id);
  // Les deux jeux sont relus sous le verrou : un retrait ou une decision entre la verification et le calcul rendrait la comparaison incoherente.
  const relus = await tx.jeuDonneesProjet.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, statut: true } });
  const statutRelu = (id: string) => relus.find((x) => x.id === id)?.statut;
  if (statutRelu(a.id) !== a.statut || statutRelu(b.id) !== b.statut) throw nonComparables("STATUT", "Le statut de l'un des deux jeux vient de changer : relancez la comparaison.");

  const reglesLues = await tx.regleRapprochementSources.findMany({ where: { statut: "APPROUVEE", OR: [{ projetId: projet.id }, { projetId: null }] } });
  const regles: RegleRapprochementLue[] = reglesLues.map(regleLue);
  const resolue = resoudreRegleRapprochement(regles, projet.id, a.typeReseau);
  const regle = resolue.regle;

  const budget = new Budget(tx, delai, delaiVerrouMs(), trop);
  const sommets = await budget.etape(() => depot.sommetsLineaires(tx, [a.id, b.id]), "sommets");
  if (sommets > SOMMETS_RESEAU_ANALYSE_MAX) {
    throw new ErreurMetier(422, "COMPARAISON_TROP_VOLUMINEUSE", `Les deux sources portent trop de sommets (${Math.round(sommets)}, maximum ${SOMMETS_RESEAU_ANALYSE_MAX}) : simplifiez ou découpez les fichiers.`, { sommets: Math.round(sommets) });
  }
  const [objetsA, objetsB] = await budget.etape(() => Promise.all([depot.objetsDuJeu(tx, a.id), depot.objetsDuJeu(tx, b.id)]), "objets");
  const lignesA = objetsA.filter((o) => o.typeGeom === "LIGNE"), lignesB = objetsB.filter((o) => o.typeGeom === "LIGNE");
  const plafond = comparaisonObjetsMax();
  if (lignesA.length + lignesB.length > plafond) {
    throw new ErreurMetier(422, "COMPARAISON_TROP_VOLUMINEUSE", `Les deux sources portent ${lignesA.length + lignesB.length} objets linéaires (maximum ${plafond}) : découpez les fichiers.`, { objetsMax: plafond });
  }
  const etendue = await budget.etape(() => socle.etendueLongitude(tx, [a.id, b.id]), "etendue");
  const epsg = etendue ? spatial.epsgPour((etendue.ouest + etendue.est) / 2) : spatial.epsgDefaut;
  // CRS de calcul persiste avec la comparaison (colonne `epsg`) et explique dans le resume : impose par un territoire, ou regle par bandes.
  const crs = { epsg, source: spatial.crsImpose !== null ? "TERRITOIRE" as const : "BANDES" as const, crsImpose: spatial.crsImpose, territoireId: spatial.territoireId };

  // Precision retenue par objet : descripteur B1, sinon jeu, sinon classe convertie par le BAREME APPROUVE de la regle (M6 : regle creee par une
  // personne et approuvee par un autre ADMIN ; la regle systeme n'en a aucun), sinon inconnue (jamais inventee).
  const bareme = baremeApprouve(regle);
  const precA = (o: depot.LigneObjetSource) => precisionRetenue({ precisionObjetM: o.precisionObjetM, precisionJeuM: a.precisionHorizontaleM === null ? null : Number(a.precisionHorizontaleM), classeObjet: o.classeObjet, classeJeu: a.classePrecision }, bareme);
  const precB = (o: depot.LigneObjetSource) => precisionRetenue({ precisionObjetM: o.precisionObjetM, precisionJeuM: b.precisionHorizontaleM === null ? null : Number(b.precisionHorizontaleM), classeObjet: o.classeObjet, classeJeu: b.classePrecision }, bareme);
  const compA = new Map(lignesA.map((o) => { const p = precA(o); return [o.id, { id: o.id, nom: o.nom, empreinte: o.empreinte, longueurM: 0, precisionM: p.precisionM, originePrecision: p.origine } as ObjetCompare] as const; }));
  const compB = new Map(lignesB.map((o) => { const p = precB(o); return [o.id, { id: o.id, nom: o.nom, empreinte: o.empreinte, longueurM: 0, precisionM: p.precisionM, originePrecision: p.origine } as ObjetCompare] as const; }));

  const lignes = await budget.etape(() => depot.apparier(tx, {
    epsg, jeuAId: a.id, jeuBId: b.id, margeM: regle.margeM, rayonAppariementM: regle.rayonAppariementM,
    precisionsA: [...compA.values()].map((o) => ({ id: o.id, precisionM: o.precisionM })), precisionsB: [...compB.values()].map((o) => ({ id: o.id, precisionM: o.precisionM })),
  }), "appariement");
  const longueursB = await budget.etape(() => depot.longueursPlanes(tx, b.id, epsg), "longueurs");
  for (const [id, o] of compB) o.longueurM = longueursB.get(id) ?? 0;
  const appariements: AppariementBrut[] = lignes.map((l) => {
    const oa = compA.get(l.aid)!;
    oa.longueurM = l.longueurAM;
    const ob = l.bid === null ? null : compB.get(l.bid) ?? null;
    if (ob && l.longueurBM !== null) ob.longueurM = l.longueurBM;
    return { objetA: oa, objetB: ob, corridorM: l.corridorM, hausdorffM: l.hausdorffM, longueurRecouvrementM: l.longueurRecouvrementM, distanceMinM: l.distanceMinM };
  });
  const resultats = assemblerResultats(projet.id, appariements, [...compB.values()], regle.partHorsCorridorMax);
  const totaux = totauxDe(resultats);
  // M6 : couples dont le corridor repose sur une classe convertie par le bareme approuve (origine CLASSE d'un cote au moins).
  const couplesBareme = resultats.filter((r) => r.corridorM !== null && (r.origineA === "CLASSE" || r.origineB === "CLASSE")).length;
  const origineBareme = bareme === null ? null : { regleId: regle.regleId, code: regle.code, version: regle.version, approuveParId: regle.approuveParId ?? null };
  const resume: ResumeComparaison = {
    statut: "TERMINEE", versionAlgorithme: VERSION_ALGORITHME_COMPARAISON,
    totaux: { ...totaux.parStatut, resultats: resultats.length, objetsA: objetsA.length, objetsB: objetsB.length, nonEvaluesA: objetsA.length - lignesA.length, nonEvaluesB: objetsB.length - lignesB.length },
    corridor: { minM: totaux.corridorMinM, maxM: totaux.corridorMaxM, couplesSansCorridor: totaux.couplesSansCorridor, margeM: regle.margeM, rayonAppariementM: regle.rayonAppariementM },
    crs,
    bareme: { applique: couplesBareme > 0, couples: couplesBareme, regle: couplesBareme > 0 ? origineBareme : null },
    limites: [
      ...LIMITES_COMPARAISON,
      ...(totaux.couplesSansCorridor > 0 ? [`${totaux.couplesSansCorridor} couple(s) sans corridor (une précision déclarée manque) : rapprochement incertain, aucune mesure de divergence.`] : []),
      ...(resolue.portee === "DEFAUT" ? ["Règle de rapprochement par défaut (valeurs provisoires, à valider par le DSI) : aucun barème par classe, une classe de précision seule laisse le rapprochement incertain."] : []),
      ...(couplesBareme > 0 && origineBareme ? [`${couplesBareme} corridor(s) calculé(s) depuis une classe de précision convertie par le barème approuvé de la règle ${origineBareme.code} version ${origineBareme.version} (une classe n'est pas une précision mesurée).`] : []),
    ],
  };
  const regleAppliquee = {
    regleId: regle.regleId, code: regle.code, version: regle.version, famille: a.typeReseau, portee: resolue.portee,
    margeM: regle.margeM, rayonAppariementM: regle.rayonAppariementM, partHorsCorridorMax: regle.partHorsCorridorMax, precisionParClasseM: regle.precisionParClasseM,
    // M6 : le bareme n'est applicable que s'il est approuve par un ADMIN autre que l'auteur ; la comparaison persistee le dit, avec la version de la regle.
    bareme: { applicable: bareme !== null, applique: couplesBareme > 0, source: bareme === null ? null : "REGLE_APPROUVEE", approuveParId: bareme === null ? null : regle.approuveParId ?? null },
  };

  // ---------------------------------------------------------------- Ecriture : comparaison immuable d abord, puis resultats
  await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
  const numero = ((await tx.comparaisonSources.aggregate({ where: { projetId: projet.id }, _max: { numero: true } }))._max.numero ?? 0) + 1;
  const comparaison = await tx.comparaisonSources.create({
    data: {
      projetId: projet.id, numero, statut: "TERMINEE", mode, role: a.role, jeuAId: a.id, jeuBId: b.id, concessionnaireId: a.concessionnaireId, typeReseau: a.typeReseau,
      regle: regleAppliquee as unknown as Prisma.InputJsonValue, jeux: [jeuDansComparaison("A", a), jeuDansComparaison("B", b)] as unknown as Prisma.InputJsonValue,
      versionAlgorithme: VERSION_ALGORITHME_COMPARAISON, epsg, resume: resume as unknown as Prisma.InputJsonValue,
      instantane: instantaneDe(resultats) as unknown as Prisma.InputJsonValue, declencheParId: acteur.id, duree: Math.round(performance.now() - debut),
    },
    select: SELECT_COMPARAISON,
  });
  for (const lot of lots(resultats)) await depot.insererResultats(tx, comparaison.id, projet.id, lot.map((r) => ({ ...r, id: randomUUID() })));
  await logAuditTransactionnelle(tx, {
    userId: acteur.id, action: "CREATE", entityType: "ComparaisonSources", entityId: comparaison.id,
    after: { projet: projet.code, numero, mode, role: a.role, jeuAId: a.id, jeuBId: b.id, versionAlgorithme: VERSION_ALGORITHME_COMPARAISON, epsg, regle: regleAppliquee, resume: { ...resume, limites: undefined }, geometries: false },
    ipAddress: acteur.ip,
  });
  const declenchePar = await tx.user.findUnique({ where: { id: acteur.id }, select: { id: true, nomComplet: true } });
  return { comparaison: vueComparaison(comparaison, acteur.role, [a.statut, b.statut], declenchePar), resume };
}

async function enregistrerEchec(acteur: Acteur, projet: { id: string; code: string }, a: LigneJeu, b: LigneJeu, mode: ModeComparaison, e: ErreurMetier, dureeMs: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const v = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${cleVerrou(projet.id)}, 0)) AS "ok"`;
    if (!v[0]?.ok) return;
    const numero = ((await tx.comparaisonSources.aggregate({ where: { projetId: projet.id }, _max: { numero: true } }))._max.numero ?? 0) + 1;
    const c = await tx.comparaisonSources.create({
      data: {
        projetId: projet.id, numero, statut: "ECHEC", mode, role: a.role, jeuAId: a.id, jeuBId: b.id, concessionnaireId: a.concessionnaireId, typeReseau: a.typeReseau,
        jeux: [jeuDansComparaison("A", a), jeuDansComparaison("B", b)] as unknown as Prisma.InputJsonValue, versionAlgorithme: VERSION_ALGORITHME_COMPARAISON,
        resume: { statut: "ECHEC", erreur: { code: e.code, message: e.message, ...e.extra } } as unknown as Prisma.InputJsonValue, declencheParId: acteur.id, duree: dureeMs,
      },
    });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "ComparaisonSources", entityId: c.id, after: { projet: projet.code, numero, statut: "ECHEC", erreur: e.code }, ipAddress: acteur.ip });
  });
}

// ------------------------------------------------------------------------------------------------
// Lectures : historique, detail, resultats
// ------------------------------------------------------------------------------------------------

/** Statuts COURANTS des jeux cites par des comparaisons (une seule lecture pour toute une page). */
async function statutsDesJeux(ids: readonly string[]): Promise<Map<string, { statut: string; confidentialite: string }>> {
  const uniques = [...new Set(ids)];
  if (uniques.length === 0) return new Map();
  const l = await prisma.jeuDonneesProjet.findMany({ where: { id: { in: uniques } }, select: { id: true, statut: true, confidentialite: true } });
  return new Map(l.map((j) => [j.id, { statut: j.statut as string, confidentialite: j.confidentialite as string }]));
}
const statutsDe = (c: { jeuAId: string; jeuBId: string }, m: ReadonlyMap<string, { statut: string }>): string[] =>
  [c.jeuAId, c.jeuBId].map((id) => m.get(id)?.statut ?? "RETIRE");

async function personnesDe(ids: readonly string[]): Promise<Map<string, { id: string; nomComplet: string }>> {
  const uniques = [...new Set(ids)];
  if (uniques.length === 0) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: uniques } }, select: { id: true, nomComplet: true } })).map((u) => [u.id, u]));
}

/** Jeux AUTORISE du projet : la seule chose qu un compte qui ne decide pas peut voir (filtre SQL des comparaisons visibles). */
async function jeuxAutorises(projetId: string): Promise<string[]> {
  return (await prisma.jeuDonneesProjet.findMany({ where: { projetId, statut: "AUTORISE" }, select: { id: true } })).map((j) => j.id);
}

export async function listerComparaisons(acteur: Acteur, projetId: string, f: { limite: number; avantNumero?: number; jeuId?: string }) {
  await exigerProjetActif(projetId);
  const where: Prisma.ComparaisonSourcesWhereInput = { projetId, ...(f.avantNumero ? { numero: { lt: f.avantNumero } } : {}) };
  if (f.jeuId) where.OR = [{ jeuAId: f.jeuId }, { jeuBId: f.jeuId }];
  if (!estDecideur(acteur.role)) {
    const autorises = await jeuxAutorises(projetId);
    where.AND = [{ jeuAId: { in: autorises } }, { jeuBId: { in: autorises } }];
  }
  const l = await prisma.comparaisonSources.findMany({ where, select: SELECT_COMPARAISON, orderBy: { numero: "desc" }, take: f.limite + 1 });
  const page = l.slice(0, f.limite);
  const [statuts, p] = await Promise.all([statutsDesJeux(page.flatMap((c) => [c.jeuAId, c.jeuBId])), personnesDe(page.map((c) => c.declencheParId))]);
  return {
    comparaisons: page.map((c) => vueComparaison(c, acteur.role, statutsDe(c, statuts), p.get(c.declencheParId) ?? null)),
    curseurSuivant: l.length > f.limite ? encoderCurseurAnalyse(page[page.length - 1].numero) : null,
  };
}

async function comparaisonVisible(acteur: Acteur, projetId: string, cmpId: string) {
  const c = await prisma.comparaisonSources.findFirst({ where: { id: cmpId, projetId }, select: SELECT_COMPARAISON });
  if (!c) throw COMPARAISON_INTROUVABLE();
  const statuts = await statutsDesJeux([c.jeuAId, c.jeuBId]);
  const s = statutsDe(c, statuts);
  // Un compte qui ne decide pas ne voit une comparaison que si ses deux jeux sont AUTORISE : sinon, meme 404 qu un identifiant inconnu.
  if (!dossierVisible(acteur.role, s)) throw COMPARAISON_INTROUVABLE();
  return { c, statuts: s, jeux: statuts };
}

export async function detailComparaison(acteur: Acteur, projetId: string, cmpId: string) {
  await exigerProjetActif(projetId);
  const { c, statuts } = await comparaisonVisible(acteur, projetId, cmpId);
  const p = await personnesDe([c.declencheParId]);
  return { comparaison: vueComparaison(c, acteur.role, statuts, p.get(c.declencheParId) ?? null) };
}

export const decoderCurseurResultats = decoderCurseurAnalyse;

export interface FiltresResultats { statuts?: StatutResultatComparaison[]; limite: number; apresOrdre?: number }

export function vueResultat(r: Prisma.ComparaisonSourcesResultatGetPayload<Record<string, never>>) {
  return {
    id: r.id, ordre: r.ordre, cle: r.cle, statut: r.statut,
    objetA: r.objetAId === null ? null : { id: String(r.objetAId), nom: r.nomA, precisionM: r.precisionAM === null ? null : Number(r.precisionAM), originePrecision: r.origineA },
    objetB: r.objetBId === null ? null : { id: String(r.objetBId), nom: r.nomB, precisionM: r.precisionBM === null ? null : Number(r.precisionBM), originePrecision: r.origineB },
    corridorM: r.corridorM === null ? null : Number(r.corridorM), mesure: r.mesure, conflitId: r.conflitId,
  };
}

/** Resultats pagines (curseur borne sur `ordre`). Aucune geometrie. Masques (liste vide) si un jeu est RETIRE ou, pour un lecteur, non AUTORISE. */
export async function listerResultats(acteur: Acteur, projetId: string, cmpId: string, f: FiltresResultats) {
  await exigerProjetActif(projetId);
  const { c, statuts, jeux } = await comparaisonVisible(acteur, projetId, cmpId);
  if (!donneesReseauLisibles(acteur.role, statuts)) return { resultats: [], masque: true, curseurSuivant: null, filtres: { statuts: f.statuts ?? [...STATUTS_RESULTAT_COMPARAISON] } };
  const l = await prisma.comparaisonSourcesResultat.findMany({
    where: { comparaisonId: c.id, ...(f.statuts?.length ? { statut: { in: f.statuts } } : {}), ...(f.apresOrdre ? { ordre: { gt: f.apresOrdre } } : {}) },
    orderBy: { ordre: "asc" }, take: f.limite + 1,
  });
  const page = l.slice(0, f.limite);
  // Les resultats rendent les noms d objets des deux sources : lecture tracee pour les jeux sensibles, AVANT la remise (revue vague 1, m4).
  await tracerConsultation(acteur, [c.jeuAId, c.jeuBId].map((id) => ({ id, confidentialite: jeux.get(id)?.confidentialite ?? "", nbObjets: page.length })), { route: "sources", bbox: null, zoom: null });
  return {
    resultats: page.map(vueResultat), masque: false,
    curseurSuivant: l.length > f.limite ? encoderCurseurAnalyse(page[page.length - 1].ordre) : null,
    filtres: { statuts: f.statuts ?? [...STATUTS_RESULTAT_COMPARAISON] },
  };
}

// ------------------------------------------------------------------------------------------------
// Ouverture d un dossier de conflit DIVERGENCE_SOURCES : action HUMAINE, justifiee ; jamais automatique
// ------------------------------------------------------------------------------------------------

export async function ouvrirDossierDivergence(acteur: Acteur, projetId: string, cmpId: string, d: { resultatId: string; justification: string }) {
  const justification = d.justification.trim();
  if (justification.length < JUSTIFICATION_MIN) throw new ErreurMetier(422, "JUSTIFICATION_REQUISE", `Une justification de ${JUSTIFICATION_MIN} caractères au moins est requise pour ouvrir un dossier.`);
  try {
    return await prisma.$transaction(async (tx) => {
      await verrouillerProjet(tx, projetId);
      const projet = await tx.projetVoirie.findUniqueOrThrow({ where: { id: projetId }, select: { code: true } });
      const c = await tx.comparaisonSources.findFirst({ where: { id: cmpId, projetId } });
      if (!c) throw COMPARAISON_INTROUVABLE();
      if (c.statut !== "TERMINEE") throw new ErreurMetier(409, "COMPARAISON_NON_TERMINEE", "Une comparaison en échec n'a pas de résultat.");
      const jeux = await tx.jeuDonneesProjet.findMany({ where: { id: { in: [c.jeuAId, c.jeuBId] } }, select: { id: true, statut: true, role: true, concessionnaireId: true, classePrecision: true } });
      const statuts = [c.jeuAId, c.jeuBId].map((id) => jeux.find((j) => j.id === id)?.statut ?? "RETIRE");
      if (!donneesReseauLisibles(acteur.role, statuts)) throw nonComparables("STATUT", "Un dossier ne s'ouvre que depuis une comparaison dont les deux jeux sont encore lisibles (aucun n'est retiré).");
      const r = await tx.comparaisonSourcesResultat.findFirst({ where: { id: d.resultatId, comparaisonId: c.id } });
      if (!r) throw introuvable("Résultat", "RESULTAT_INTROUVABLE");
      if (r.statut !== "DIVERGENCE" || r.objetAId === null || r.objetBId === null) throw new ErreurMetier(409, "RESULTAT_NON_DIVERGENT", `Seul un résultat DIVERGENCE ouvre un dossier à investiguer (statut : ${r.statut}).`, { statut: r.statut });
      if (r.conflitId) throw new ErreurMetier(409, "DOSSIER_DEJA_OUVERT", "Un dossier de conflit est déjà ouvert pour ce résultat.", { conflitId: r.conflitId });

      const objetA = String(r.objetAId), objetB = String(r.objetBId);
      const [geo, objets, descripteurs] = await Promise.all([
        depot.geometrieObjet(tx, objetA),
        tx.objetProjet.findMany({ where: { id: { in: [r.objetAId, r.objetBId] } }, select: { id: true, nom: true, empreinte: true } }),
        descripteursDesObjets(tx, [objetA]),
      ]);
      const oa = objets.find((o) => String(o.id) === objetA), ob = objets.find((o) => String(o.id) === objetB);
      if (!geo || !oa || !ob) throw introuvable("Objet", "OBJET_INTROUVABLE");
      const jeuA = jeux.find((j) => j.id === c.jeuAId)!;
      // Le dossier depend du jeu de reference (A) : il doit etre AUTORISE (sinon le dossier serait aussitot masque aux lecteurs).
      if (jeuA.statut !== "AUTORISE") throw nonComparables("STATUT", "Un dossier ne s'ouvre que tant que le jeu de référence (A) est autorisé.");
      const estAxe = jeuA.role === "AXES_TRAVAUX";
      const cle = cleConflit({
        projetId, axe: AXE_DIVERGENCE_SOURCES, type: "DIVERGENCE_SOURCES", cellule: cellule(geo.lon, geo.lat),
        // Correctifs T1+S1 (M5) : les identifiants des deux objets entrent dans la cle : deux couples d'objets de meme nom font deux dossiers distincts.
        reseau: `${cleReseau(jeuA.concessionnaireId, oa.nom, oa.empreinte)}|b:${identiteObjet(ob.nom, ob.empreinte)}|ida:${objetA}|idb:${objetB}`,
      });
      const deja = await tx.conflitProjet.findFirst({ where: { projetId, cle }, select: { id: true } });
      if (deja) throw new ErreurMetier(409, "DOSSIER_DEJA_OUVERT", "Un dossier de conflit existe déjà pour ce couple d'objets (ouvert depuis une autre comparaison).", { conflitId: deja.id });

      const m = (r.mesure ?? {}) as Record<string, number | null>;
      const mesure = {
        longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: m.distanceMinM ?? null, nbCroisements: 0, longueurPieceM: m.longueurAM ?? 0,
        divergence: { hausdorffM: m.hausdorffM ?? null, longueurHorsCorridorM: m.longueurHorsCorridorM ?? null, partHorsCorridor: m.partHorsCorridor ?? null, corridorM: r.corridorM === null ? null : Number(r.corridorM) },
        jeuBId: c.jeuBId, objetBId: objetB, nomB: ob.nom, comparaisonId: c.id, resultatId: r.id,
      };
      const id = randomUUID();
      const classe = classeEffective(descripteurs.get(objetA)?.classe, jeuA.classePrecision).classe;
      await depot.insererDossierDivergence(tx, {
        id, projetId, cle, jeuReseauId: estAxe ? null : c.jeuAId, jeuAxesId: estAxe ? c.jeuAId : null, objetId: objetA, concessionnaireId: jeuA.concessionnaireId, mesure: JSON.stringify(mesure), geomHex: geo.geomHex, classePrecision: classe, comparaisonId: c.id,
        jeuSourceBId: c.jeuBId,
      }, AXE_DIVERGENCE_SOURCES);
      await tx.conflitHistorique.create({
        data: {
          conflitId: id, action: "CREATION", nouveauStatut: "A_INVESTIGUER", acteurId: acteur.id, justification,
          donnees: { type: "DIVERGENCE_SOURCES", origine: "COMPARAISON_SOURCES", comparaisonId: c.id, comparaisonNumero: c.numero, resultatId: r.id, mesure, statutInitial: "A_INVESTIGUER", motifs: ["DIVERGENCE_SOURCES"], classePrecision: classe } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.comparaisonSourcesResultat.update({ where: { id: r.id }, data: { conflitId: id } });
      await logAuditTransactionnelle(tx, {
        userId: acteur.id, action: "CREATE", entityType: "ConflitProjet", entityId: id,
        after: { projet: projet.code, type: "DIVERGENCE_SOURCES", statut: "A_INVESTIGUER", mode: c.mode, role: jeuA.role, comparaisonId: c.id, resultatId: r.id, jeuAId: c.jeuAId, jeuBId: c.jeuBId, justification, mesure: { ...mesure, nomB: undefined }, geometries: false },
        ipAddress: acteur.ip,
      });
      return { conflit: { id, projetId, cle, type: "DIVERGENCE_SOURCES", statut: "A_INVESTIGUER", axe: AXE_DIVERGENCE_SOURCES, comparaisonId: c.id, resultatId: r.id, jeuReseauId: estAxe ? null : c.jeuAId, jeuAxesId: estAxe ? c.jeuAId : null } };
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Le projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }
}
