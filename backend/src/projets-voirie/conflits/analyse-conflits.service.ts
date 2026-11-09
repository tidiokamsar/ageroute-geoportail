/**
 * ANALYSE DE CONFLITS PERSISTEE d'un projet (contrat RC-3, section 5).
 *
 * Le socle calcule une analyse 2D indicative a la demande ; ce service PERSISTE le resultat : chaque analyse est reproductible
 * (empreintes et versions des jeux, versions des regles, largeurs, version de l'algorithme) et chaque resultat devient un DOSSIER DE CONFLIT
 * suivi dans le temps. Un conflit est un signal de verification, jamais un ordre : rien ici ne cree d'ordre, de decision ni de deplacement.
 *
 * ENTREES : les jeux AUTORISE du projet (jamais la quarantaine), les largeurs du projet, les regles approuvees applicables par famille.
 * GARDES : une seule analyse a la fois par projet (verrou consultatif, 503 PROJET_OCCUPE, sans bloquer les autres operations du projet),
 * trois analyses simultanees par processus (503 SERVICE_OCCUPE), delais cote BASE (statement_timeout, 504 ANALYSE_TROP_LONGUE),
 * plafonds de sommets du socle (422 ANALYSE_TROP_VOLUMINEUSE) et plafond de conflits par analyse.
 *
 * ECRITURE : une seule transaction ; la ligne d'analyse (immuable) est ecrite AVANT les conflits qui la referencent, avec un resume calcule
 * en memoire par le noyau pur. La transaction pose `bdri.conflit_recalcul = 'oui'` : la base refuse alors toute modification du statut, du
 * risque, du responsable, de l'echeance ou de l'action proposee d'un conflit. Un verdict humain ne peut donc pas etre ecrase par un calcul.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { Budget, avecErreurDelai, estDelaiDepasse, poserDelais } from "../bd";
import { analyseIntervalleMinS, delaiAnalyseMs, delaiDepotMs, delaiVerrouMs, conflitsParAnalyseMax } from "../config";
import { epsgPourLongitude, LIMITES_OBLIGATOIRES } from "../analyse.noyau";
import * as socle from "../analyse.depot";
import { limiteurAnalyses } from "../limiteurs";
import { ErreurMetier, introuvable } from "../erreurs";
import { SOMMETS_AXES_ANALYSE_MAX, SOMMETS_RESEAU_ANALYSE_MAX } from "../analyse.service";
import type { Acteur } from "../projets.service";
import { descripteursDesObjets } from "../reseaux/reseaux.depot";
import { classeEffective } from "../reseaux/types.noyau";
import { verifierCadence } from "./cadence.noyau";
import { cellule, empreinteMesure, finaliserCandidats, type CandidatBrut, type ConflitCalcule } from "./classification.noyau";
import * as depot from "./conflits.depot";
import { distanceProximiteM, resoudreRegle, type RegleLue } from "./regle.noyau";
import { calculerRejeu, jeuxToken, type ActionRejeu, type ConflitExistant, type ConflitTrouve } from "./rejeu.noyau";
import { VERSION_ALGORITHME_CONFLITS, type ClassePrecision, type Mesure, type StatutConflit } from "./types.noyau";

const TAILLE_LOT = 1000;
const lots = <T>(l: readonly T[], n = TAILLE_LOT): T[][] => { const s: T[][] = []; for (let i = 0; i < l.length; i += n) s.push(l.slice(i, i + n)); return s; };
const json = (v: unknown) => JSON.stringify(v);
const cleVerrou = (projetId: string) => `pv-conflits-analyse|${projetId}`;

export interface VueAnalyseConflits {
  id: string; projetId: string; numero: number; statut: string;
  largeurEmpriseM: number; largeurChausseeM: number;
  regles: unknown; jeux: unknown; versionAlgorithme: string; resume: unknown;
  nbConflitsTrouves: number;
  declenchePar: { id: string; nomComplet: string } | null;
  duree: number; createdAt: Date;
}

/**
 * Colonnes d une analyse rendues par l API : TOUTES SAUF `instantane` (le JSON { cle : empreinte } peut peser plusieurs centaines de Ko
 * pour 20 000 conflits ; il ne sert qu a la comparaison, qui le lit elle-meme). Le nombre de conflits est dans `resume.totaux` (revue RC-3, M2).
 */
export const SELECT_ANALYSE = {
  id: true, projetId: true, numero: true, statut: true, largeurEmpriseM: true, largeurChausseeM: true, regles: true, jeux: true,
  versionAlgorithme: true, resume: true, declencheParId: true, duree: true, createdAt: true,
  declenchePar: { select: { id: true, nomComplet: true } },
} as const;

type LigneAnalyse = Prisma.AnalyseConflitProjetGetPayload<{ select: typeof SELECT_ANALYSE }>;

/** Nombre de conflits trouves, tel que le resume l a fige a l analyse (zero pour une analyse en echec, qui n a pas de resultat). */
const nbConflitsDuResume = (resume: unknown): number => {
  const n = (resume as { totaux?: { conflitsTrouves?: unknown } } | null)?.totaux?.conflitsTrouves;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/**
 * Vue d une analyse. `jeuLisible` : filtre des jeux utilises selon leur statut COURANT et le compte (voir visibilite.noyau.ts) ; absent,
 * aucun filtre (l analyse que l on vient de lancer ne porte que des jeux autorises).
 */
export function vueAnalyse(a: LigneAnalyse, jeuLisible?: (jeuId: string) => boolean): VueAnalyseConflits {
  const jeux = Array.isArray(a.jeux) && jeuLisible ? (a.jeux as { jeuId?: unknown }[]).filter((j) => typeof j.jeuId === "string" && jeuLisible(j.jeuId)) : a.jeux;
  return {
    id: a.id, projetId: a.projetId, numero: a.numero, statut: a.statut,
    largeurEmpriseM: Number(a.largeurEmpriseM), largeurChausseeM: Number(a.largeurChausseeM),
    regles: a.regles, jeux, versionAlgorithme: a.versionAlgorithme, resume: a.resume,
    nbConflitsTrouves: nbConflitsDuResume(a.resume),
    declenchePar: a.declenchePar ? { id: a.declenchePar.id, nomComplet: a.declenchePar.nomComplet } : null,
    duree: a.duree, createdAt: a.createdAt,
  };
}

interface JeuLu {
  id: string; role: string; version: number; sha256: string; statut: string; typeReseau: string | null; concessionnaireId: string | null;
  classePrecision: ClassePrecision; precisionHorizontaleM: number | null; confidentialite: string; nbObjets: number; nomFichier: string;
}

const lireMesure = (j: unknown): Mesure => {
  const m = (j ?? {}) as Partial<Mesure>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { longueurChausseeM: n(m.longueurChausseeM), longueurEmpriseM: n(m.longueurEmpriseM), distanceMinM: typeof m.distanceMinM === "number" ? m.distanceMinM : null, nbCroisements: n(m.nbCroisements), longueurPieceM: n(m.longueurPieceM) };
};

/** Mesure d'une partie de reseau selon son type (voir conflits.depot.ts). Les lengths sont celles de la partie, mesurees sur la geographie. */
function mesureDe(l: depot.LigneCandidat): Mesure {
  const dansChaussee = l.type === "INTERSECTION_CHAUSSEE";
  const dansEmprise = dansChaussee || l.type === "INTERSECTION_EMPRISE";
  return { longueurChausseeM: dansChaussee ? l.len : 0, longueurEmpriseM: dansEmprise ? l.len : 0, distanceMinM: l.dmin, nbCroisements: l.nx, longueurPieceM: l.len };
}

export interface ResumeAnalyse {
  statut: "TERMINEE";
  versionAlgorithme: string;
  totaux: { conflitsTrouves: number; axes: number; jeuxReseau: number; axesNonCouverts: number };
  parType: Record<string, number>;
  parStatut: Record<string, number>;
  nouveaux: number; retrouves: number; identiques: number; modifies: number; disparus: number; reapparus: number; marquesAReexaminer: number;
  plafond: { conflitsMax: number };
  limites: string[];
}

/**
 * Delai minimal entre deux analyses TERMINEES d un projet (revue RC-3, m8) : 429 ANALYSE_TROP_FREQUENTE avec `retryAfterS` (et l en-tete
 * Retry-After). Verifie une premiere fois AVANT d attendre une place du limiteur, puis sous le verrou de l analyse (deux demandes qui se
 * croisent ne passent pas toutes les deux). Une analyse en ECHEC ne compte pas.
 */
async function exigerCadence(lecteur: Pick<typeof prisma, "analyseConflitProjet">, projetId: string): Promise<void> {
  const derniere = await lecteur.analyseConflitProjet.aggregate({ where: { projetId, statut: "TERMINEE" }, _max: { createdAt: true } });
  const v = verifierCadence({ derniereTermineeLe: derniere._max.createdAt, maintenant: new Date(), intervalleS: analyseIntervalleMinS() });
  if (!v.ok) {
    throw new ErreurMetier(429, "ANALYSE_TROP_FREQUENTE",
      `Une analyse de ce projet date de moins de ${analyseIntervalleMinS()} s : réessayez dans ${v.retryAfterS} s (le résultat serait identique tant que les données ne changent pas).`,
      { retryAfterS: v.retryAfterS });
  }
}

export async function lancerAnalyse(acteur: Acteur, projetId: string): Promise<{ analyse: VueAnalyseConflits; resume: ResumeAnalyse }> {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  await exigerCadence(prisma, projetId);
  const debut = performance.now();
  const delai = delaiAnalyseMs();
  const trop = () => new ErreurMetier(504, "ANALYSE_TROP_LONGUE", `L'analyse a dépassé ${Math.round(delai / 1000)} s et a été interrompue : le projet est trop volumineux pour un calcul immédiat.`);
  try {
    return await limiteurAnalyses.executer(() => avecErreurDelai("ANALYSE_TROP_LONGUE", trop().message, () => prisma.$transaction(
      (tx) => executer(tx, acteur, projet, debut, delai, trop),
      { timeout: delai + delaiDepotMs() + 15_000, maxWait: 10_000 },
    )));
  } catch (e) {
    // Une analyse qui echoue par depassement de delai ou de volume laisse une trace (statut ECHEC) ; les autres refus n'en laissent pas.
    if (e instanceof ErreurMetier && (e.status === 504 || e.code === "ANALYSE_TROP_VOLUMINEUSE")) {
      await enregistrerEchec(acteur, projet, e, Math.round(performance.now() - debut)).catch(() => undefined);
    }
    throw e;
  }
}

type ProjetLu = { id: string; code: string; regionId: number | null; largeurEmpriseM: Prisma.Decimal; largeurChausseeM: Prisma.Decimal };

async function executer(tx: Prisma.TransactionClient, acteur: Acteur, projet: ProjetLu, debut: number, delai: number, trop: () => Error) {
  const verrou = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${cleVerrou(projet.id)}, 0)) AS "ok"`;
  if (!verrou[0]?.ok) throw new ErreurMetier(503, "PROJET_OCCUPE", "Une analyse de conflits est déjà en cours sur ce projet : réessayez dans quelques instants.");
  await exigerCadence(tx, projet.id);
  await tx.$executeRaw`SELECT set_config('bdri.conflit_recalcul', 'oui', true)`;

  const empr = Number(projet.largeurEmpriseM);
  const chau = Number(projet.largeurChausseeM);
  const lus = await tx.jeuDonneesProjet.findMany({
    where: { projetId: projet.id, statut: "AUTORISE", role: { in: ["AXES_TRAVAUX", "RESEAU_TIERS"] } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const jeux: JeuLu[] = lus.map((j) => ({
    id: j.id, role: j.role, version: j.version, sha256: j.sha256, statut: j.statut, typeReseau: j.typeReseau, concessionnaireId: j.concessionnaireId,
    classePrecision: j.classePrecision as ClassePrecision, precisionHorizontaleM: j.precisionHorizontaleM === null ? null : Number(j.precisionHorizontaleM),
    confidentialite: j.confidentialite, nbObjets: j.nbObjets, nomFichier: j.nomFichier,
  }));
  const axes = jeux.filter((j) => j.role === "AXES_TRAVAUX");
  const reseaux = jeux.filter((j) => j.role === "RESEAU_TIERS");
  const axesIds = axes.map((j) => j.id);
  const reseauIds = reseaux.map((j) => j.id);

  // Regles applicables : la plus recente approuvee par famille (projet, puis generale, puis defaut).
  const reglesLues = await tx.regleConflit.findMany({ where: { statut: "APPROUVEE", OR: [{ projetId: projet.id }, { projetId: null }] } });
  const regles: RegleLue[] = reglesLues.map((r) => ({
    regleId: r.id, projetId: r.projetId, famille: r.famille, code: r.code, version: r.version,
    toleranceProximiteM: Number(r.toleranceProximiteM), margeIncertitude: Number(r.margeIncertitude), statut: r.statut, approuveLe: r.approuveLe,
  }));
  const familles = [...new Set(reseaux.map((j) => j.typeReseau))];
  const resolues = new Map(familles.map((f) => [f, resoudreRegle(regles, projet.id, f)] as const));
  const reglesAppliquees = (familles.length > 0 ? [...resolues.entries()] : [[null, resoudreRegle(regles, projet.id, null)] as const]).map(([famille, r]) => ({
    regleId: r.regle.regleId, code: r.regle.code, version: r.regle.version, famille, portee: r.portee,
    toleranceProximiteM: r.regle.toleranceProximiteM, margeIncertitude: r.regle.margeIncertitude,
  }));
  const jeuxTol = reseaux.map((j) => ({ jeu: j.id, tol: distanceProximiteM(resolues.get(j.typeReseau)!.regle, j.precisionHorizontaleM) }));

  // ---------------------------------------------------------------- Calcul (delai cote base, budget partage)
  const budget = new Budget(tx, delai, delaiVerrouMs(), trop);
  if (axesIds.length > 0 && reseauIds.length > 0) {
    const v = await budget.etape(() => socle.volumes(tx, axesIds, reseauIds), "volumes");
    if (v.sommetsAxes > SOMMETS_AXES_ANALYSE_MAX || v.sommetsReseau > SOMMETS_RESEAU_ANALYSE_MAX) {
      throw new ErreurMetier(422, "ANALYSE_TROP_VOLUMINEUSE",
        `Les jeux autorisés portent trop de sommets pour une analyse (${Math.round(v.sommetsAxes)} pour les axes, maximum ${SOMMETS_AXES_ANALYSE_MAX} ; ${Math.round(v.sommetsReseau)} pour les réseaux, maximum ${SOMMETS_RESEAU_ANALYSE_MAX}) : simplifiez ou découpez les fichiers.`,
        { sommetsAxes: Math.round(v.sommetsAxes), sommetsReseau: Math.round(v.sommetsReseau) });
    }
  }
  const etendue = await budget.etape(() => socle.etendueLongitude(tx, axesIds.length ? axesIds : reseauIds), "etendue");
  const epsg = etendue ? epsgPourLongitude((etendue.ouest + etendue.est) / 2) : 32629;
  const b: socle.Bandes = { epsg, dc: chau / 2, de: empr / 2, axesIds, reseauIds };
  const plafond = conflitsParAnalyseMax();

  const lignes = await budget.etape(() => depot.candidatsLineaires(tx, b, jeuxTol, plafond + 1), "candidats");
  const couverture = await budget.etape(() => depot.couvertureDesAxes(tx, axesIds, reseauIds), "couverture");
  const sansCouverture = couverture.filter((c) => c.nbCouvrants === 0);
  if (lignes.length + sansCouverture.length > plafond) {
    throw new ErreurMetier(422, "ANALYSE_TROP_VOLUMINEUSE",
      `Le projet produirait plus de ${plafond} conflits : réduisez l'emprise des travaux ou découpez les jeux.`, { conflitsMax: plafond });
  }

  const jeuParId = new Map(jeux.map((j) => [j.id, j] as const));
  // Lot B1 (extension minimale, CONTRAT-CONFLITS.md section 9, point 36) : la classe de precision d'un objet est celle que son descripteur DECLARE, sinon
  // celle de son jeu, sinon inconnue (jamais deduite). Sans descripteur, rien ne change. Une classe qui change fait marquer le dossier a reexaminer
  // (NOUVELLE_VERSION_DONNEES) par le rejeu existant, sans jamais toucher un verdict humain.
  const descripteurs = await budget.etape(() => descripteursDesObjets(tx, lignes.map((l) => l.oid)), "descripteurs");
  const bruts: CandidatBrut[] = [
    ...lignes.map((l): CandidatBrut => {
      const j = jeuParId.get(l.jeu)!;
      return {
        type: l.type, axe: l.axe, jeuReseauId: l.jeu, objetId: l.oid, concessionnaireId: j.concessionnaireId, nomObjet: l.nom, empreinteObjet: l.emp,
        classePrecision: classeEffective(descripteurs.get(l.oid)?.classe, j.classePrecision).classe, mesure: mesureDe(l), cellule: [l.cx, l.cy], geomHex: l.g,
      };
    }),
    ...sansCouverture.map((c): CandidatBrut => ({
      type: "COUVERTURE_INSUFFISANTE", axe: c.axe, jeuReseauId: null, jeuAxesId: c.jeu, objetId: null, concessionnaireId: null, nomObjet: null, empreinteObjet: null,
      classePrecision: null, mesure: { longueurChausseeM: 0, longueurEmpriseM: 0, distanceMinM: null, nbCroisements: 0, longueurPieceM: c.len }, cellule: cellule(c.lon, c.lat), geomHex: c.g,
    })),
  ];
  const calcules = finaliserCandidats(projet.id, bruts);

  // ---------------------------------------------------------------- Rejeu sur les conflits existants (noyau pur)
  await poserDelais(tx, delaiDepotMs(), delaiVerrouMs());
  // Lot S1 : un dossier DIVERGENCE_SOURCES vient d'une comparaison de sources ouverte par une personne, pas de cette analyse : le recalcul l'ignore
  // (jamais NON_RETROUVE, jamais modifie). Il n'a d'ailleurs pas d'analyse (contrainte cp_origine_coherente).
  const existantsLus = await tx.conflitProjet.findMany({
    where: { projetId: projet.id, type: { not: "DIVERGENCE_SOURCES" } },
    select: { id: true, cle: true, statut: true, mesure: true, classePrecision: true, jeuReseauId: true, derniereAnalyseId: true, aReexaminer: true, motifReexamen: true },
  });
  const analysesPrec = existantsLus.length > 0
    ? await tx.analyseConflitProjet.findMany({ where: { id: { in: [...new Set(existantsLus.flatMap((x) => (x.derniereAnalyseId ? [x.derniereAnalyseId] : [])))] } }, select: { id: true, jeux: true } })
    : [];
  const jeuxPrec = new Map(analysesPrec.map((a) => [a.id, (a.jeux as { jeuId: string; sha256: string; role: string }[]) ?? []] as const));
  const jeuxAnalyse = jeux.map((j) => ({ jeuId: j.id, sha256: j.sha256, role: j.role }));
  const existants: ConflitExistant[] = existantsLus.map((x) => ({
    id: x.id, cle: x.cle, statut: x.statut as StatutConflit, empreinteMesure: empreinteMesure(lireMesure(x.mesure)),
    jeuxToken: x.derniereAnalyseId && jeuxPrec.has(x.derniereAnalyseId) ? jeuxToken(jeuxPrec.get(x.derniereAnalyseId)!, x.jeuReseauId) : null,
    classePrecision: x.classePrecision as ClassePrecision, aReexaminer: x.aReexaminer, motifReexamen: x.motifReexamen,
  }));
  const trouves: ConflitTrouve[] = calcules.map((c) => ({ cle: c.cle, empreinteMesure: c.empreinteMesure, jeuxToken: jeuxToken(jeuxAnalyse, c.jeuReseauId), classePrecision: c.classePrecision }));
  const { actions, resume: rejeu } = calculerRejeu(existants, trouves);

  // Etat du projet APRES l'analyse, pour le resume : statuts existants (inchanges) et statuts initiaux des nouveaux.
  const parStatut: Record<string, number> = {};
  for (const x of existantsLus) parStatut[x.statut] = (parStatut[x.statut] ?? 0) + 1;
  const parCle = new Map(calcules.map((c) => [c.cle, c] as const));
  for (const a of actions) if (a.genre === "CREER") { const s = parCle.get(a.cle)!.classification.statut; parStatut[s] = (parStatut[s] ?? 0) + 1; }
  const parType: Record<string, number> = {};
  for (const c of calcules) parType[c.type] = (parType[c.type] ?? 0) + 1;
  const instantane: Record<string, string> = {};
  for (const c of calcules) instantane[c.cle] = c.empreinteMesure;

  const limites = [
    ...LIMITES_OBLIGATOIRES,
    "Seuls les réseaux linéaires sont évalués : les objets ponctuels et surfaciques des fichiers ne produisent aucun dossier.",
    ...(sansCouverture.length > 0 ? [`${sansCouverture.length} axe(s) ne sont recouverts par aucun jeu de réseau autorisé : zone à investiguer, jamais une absence de réseau.`] : []),
    ...(axes.length === 0 ? ["Aucun plan d'axes autorisé : aucun conflit ne peut être calculé."] : []),
    ...(reseaux.length === 0 && axes.length > 0 ? ["Aucun réseau de concessionnaire autorisé : tous les axes sont à investiguer, ce qui ne prouve pas l'absence de réseau."] : []),
  ];
  const resume: ResumeAnalyse = {
    statut: "TERMINEE", versionAlgorithme: VERSION_ALGORITHME_CONFLITS,
    totaux: { conflitsTrouves: calcules.length, axes: couverture.length, jeuxReseau: reseaux.length, axesNonCouverts: sansCouverture.length },
    parType, parStatut,
    nouveaux: rejeu.nouveaux, retrouves: rejeu.retrouves, identiques: rejeu.identiques, modifies: rejeu.modifies, disparus: rejeu.disparus,
    reapparus: rejeu.reapparus, marquesAReexaminer: rejeu.marquesAReexaminer,
    plafond: { conflitsMax: plafond }, limites,
  };

  // ---------------------------------------------------------------- Ecriture : analyse immuable d'abord, puis conflits et historique
  const numero = ((await tx.analyseConflitProjet.aggregate({ where: { projetId: projet.id }, _max: { numero: true } }))._max.numero ?? 0) + 1;
  const analyse = await tx.analyseConflitProjet.create({
    data: {
      projetId: projet.id, numero, statut: "TERMINEE", largeurEmpriseM: empr, largeurChausseeM: chau,
      regles: reglesAppliquees as unknown as Prisma.InputJsonValue,
      jeux: jeux.map((j) => ({
        jeuId: j.id, sha256: j.sha256, version: j.version, role: j.role, statut: j.statut, typeReseau: j.typeReseau, concessionnaireId: j.concessionnaireId,
        classePrecision: j.classePrecision, precisionHorizontaleM: j.precisionHorizontaleM, nomFichier: j.nomFichier,
      })) as unknown as Prisma.InputJsonValue,
      versionAlgorithme: VERSION_ALGORITHME_CONFLITS, resume: resume as unknown as Prisma.InputJsonValue,
      instantane: instantane as unknown as Prisma.InputJsonValue, declencheParId: acteur.id, duree: Math.round(performance.now() - debut),
    },
    select: SELECT_ANALYSE,
  });

  try {
    await ecrireConflits(tx, projet, analyse.id, existantsLus, actions, parCle, empr / 2);
  } catch (e) {
    if (estDelaiDepasse(e)) throw new ErreurMetier(503, "PROJET_OCCUPE", "Un dossier de conflit de ce projet est occupé par une autre opération : réessayez dans quelques instants.");
    throw e;
  }

  await logAuditTransactionnelle(tx, {
    userId: acteur.id, action: "CREATE", entityType: "AnalyseConflitProjet", entityId: analyse.id,
    after: { projet: projet.code, numero, versionAlgorithme: VERSION_ALGORITHME_CONFLITS, largeurChausseeM: chau, largeurEmpriseM: empr, regles: reglesAppliquees, resume: { ...resume, limites: undefined }, geometries: false },
    ipAddress: acteur.ip,
  });
  return { analyse: vueAnalyse(analyse), resume };
}

type ExistantLu = { id: string; mesure: unknown };

async function ecrireConflits(
  tx: Prisma.TransactionClient, projet: ProjetLu, analyseId: string, existants: readonly ExistantLu[],
  actions: readonly ActionRejeu[], parCle: ReadonlyMap<string, ConflitCalcule>, demiEmpriseM: number,
): Promise<void> {
  const historique: Prisma.ConflitHistoriqueCreateManyInput[] = [];
  const aTroncons: string[] = [];
  const ligne = (c: ConflitCalcule) => ({
    jeuReseauId: c.jeuReseauId ?? "", jeuAxesId: c.jeuAxesId ?? "", objetId: c.objetId ?? "", concessionnaireId: c.concessionnaireId ?? "", mesure: json(c.mesure), geomHex: c.geomHex, classePrecision: c.classePrecision ?? "",
  });

  const crees = actions.filter((a): a is Extract<ActionRejeu, { genre: "CREER" }> => a.genre === "CREER");
  const nouvelles = crees.map((a) => ({ id: randomUUID(), c: parCle.get(a.cle)! }));
  for (const lot of lots(nouvelles)) {
    await depot.insererConflits(tx, projet.id, analyseId, lot.map(({ id, c }) => ({
      id, cle: c.cle, type: c.type, axe: c.axe, ...ligne(c), statut: c.classification.statut,
    })));
  }
  for (const { id, c } of nouvelles) {
    aTroncons.push(id);
    historique.push({
      conflitId: id, action: "CREATION", nouveauStatut: c.classification.statut, acteurId: null, analyseId,
      donnees: { type: c.type, axe: c.axe, mesure: c.mesure, statutInitial: c.classification.statut, motifs: c.classification.motifs, notes: c.classification.notes, classePrecision: c.classePrecision, jeuReseauId: c.jeuReseauId } as unknown as Prisma.InputJsonValue,
    });
  }

  const retrouves = actions.filter((a): a is Extract<ActionRejeu, { genre: "RETROUVER" }> => a.genre === "RETROUVER");
  for (const lot of lots(retrouves)) {
    await depot.majConflitsRetrouves(tx, analyseId, lot.map((a) => {
      const c = parCle.get(a.cle)!;
      return { id: a.id, ...ligne(c), aReexaminer: a.aReexaminer, motifReexamen: a.motifReexamen ?? "" };
    }));
  }
  for (const a of retrouves) {
    aTroncons.push(a.id);
    if (!a.historique) continue;
    const c = parCle.get(a.cle)!;
    const avant = lireMesure(existants.find((x) => x.id === a.id)?.mesure);
    historique.push({
      conflitId: a.id, action: a.historique, acteurId: null, analyseId,
      donnees: (a.historique === "MESURE_MODIFIEE"
        ? { avant, apres: c.mesure, reapparu: a.reapparu }
        : a.historique === "REEXAMEN"
          ? { motif: "NOUVELLE_VERSION_DONNEES", versionDonneesModifiee: a.versionDonneesModifiee, classeModifiee: a.classeModifiee, classePrecision: c.classePrecision }
          : { reapparu: true }) as unknown as Prisma.InputJsonValue,
    });
  }

  const manquants = actions.filter((a): a is Extract<ActionRejeu, { genre: "NON_RETROUVE" }> => a.genre === "NON_RETROUVE");
  const aMarquer = manquants.filter((a) => a.historique !== null).map((a) => a.id);
  for (const lot of lots(aMarquer)) await depot.marquerNonRetrouves(tx, lot);
  for (const id of aMarquer) historique.push({ conflitId: id, action: "REEXAMEN", acteurId: null, analyseId, donnees: { motif: "NON_RETROUVE" } });

  for (const lot of lots(historique, 2000)) await tx.conflitHistorique.createMany({ data: lot });
  for (const lot of lots(aTroncons, 500)) await depot.majTronconsProches(tx, lot, demiEmpriseM);
}

/**
 * Trace d'une analyse qui a echoue (delai ou volume) : une ligne `ECHEC` immuable, dans une transaction a part. Si une autre analyse
 * du projet est en cours (verrou non obtenu), rien n'est ecrit.
 */
async function enregistrerEchec(acteur: Acteur, projet: ProjetLu, e: ErreurMetier, dureeMs: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const v = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${cleVerrou(projet.id)}, 0)) AS "ok"`;
    if (!v[0]?.ok) return;
    const numero = ((await tx.analyseConflitProjet.aggregate({ where: { projetId: projet.id }, _max: { numero: true } }))._max.numero ?? 0) + 1;
    const a = await tx.analyseConflitProjet.create({
      data: {
        projetId: projet.id, numero, statut: "ECHEC", largeurEmpriseM: Number(projet.largeurEmpriseM), largeurChausseeM: Number(projet.largeurChausseeM),
        versionAlgorithme: VERSION_ALGORITHME_CONFLITS, resume: { statut: "ECHEC", erreur: { code: e.code, message: e.message, ...e.extra } } as unknown as Prisma.InputJsonValue,
        declencheParId: acteur.id, duree: dureeMs,
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "AnalyseConflitProjet", entityId: a.id,
      after: { projet: projet.code, numero, statut: "ECHEC", erreur: e.code }, ipAddress: acteur.ip,
    });
  });
}
