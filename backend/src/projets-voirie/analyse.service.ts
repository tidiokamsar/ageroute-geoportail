/**
 * ANALYSE INDICATIVE 2D d'un projet (contrat v2, section 5) : longueurs par type de reseau et par concessionnaire, conflits
 * potentiels et proximites a verifier entre les reseaux et l'emprise des travaux, hypotheses et limites.
 *
 * C'est une AIDE A LA DECISION, jamais un verdict : chaque element porte `statut: "A_VERIFIER"`, la regle appliquee et la version
 * de l'algorithme. Rien ici ne cree d'ordre, de decision ni de deplacement. Lecture seule (`SET TRANSACTION READ ONLY`).
 *
 * JEUX RETENUS : par defaut les seuls jeux AUTORISE. Avec `inclureNonAutorises`, un jeu en controle REMPLACE, pour ce calcul seulement,
 * le jeu autorise de meme role et de meme concessionnaire (jamais les deux : on ne compterait pas deux fois le meme reseau).
 */

import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { Budget, avecErreurDelai } from "./bd";
import { delaiAnalyseMs, delaiVerrouMs } from "./config";
import { tracerConsultation } from "./consultation";
import { limiteurAnalyses } from "./limiteurs";
import {
  LIBELLES, STATUT_RESULTAT, VERSION_ALGORITHME, VERSION_REGLE, construireHypotheses, construireLimites, qualificationDe,
  type ClasseLue, type Qualification,
} from "./analyse.noyau";
import * as depot from "./analyse.depot";
import { ErreurMetier, introuvable } from "./erreurs";
import type { Acteur } from "./projets.service";
import { descripteursDesObjets } from "./reseaux/reseaux.depot";
import { classeEffective, natureEffective } from "./reseaux/types.noyau";
import { INCLURE_JEU } from "./vues";
import { contexteSpatialDuProjet } from "./territoires/contexte-spatial";

export const OBJETS_PAR_AXE_MAX = 100;
const LIGNES_OBJETS_MAX = 100_000;
const CROISEMENTS_MAX = 5_000;
const TAILLE_ZONES_MAX = 8_000_000;
/** Volumes de sommets au-dela desquels une analyse est refusee (422) plutot que tentee : voir analyse.depot.ts, cout borne. */
export const SOMMETS_AXES_ANALYSE_MAX = 500_000;
export const SOMMETS_RESEAU_ANALYSE_MAX = 3_000_000;

export interface DemandeAnalyse {
  projetId: string;
  largeurEmpriseM?: number;
  largeurChausseeM?: number;
  inclureNonAutorises: boolean;
  /** Lot X1 (revue, M3) : l'export n'utilise ni les points de croisement ni les zones : ces requetes, les plus couteuses, ne sont pas executees. */
  sansGeometries?: boolean;
  /** Lot X1 (revue, M4) : budget restant de l'appelant ; le delai cote base est le plus petit des deux. */
  delaiMaxMs?: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const etiquette = { statut: STATUT_RESULTAT } as const;

type JeuLu = Awaited<ReturnType<typeof lireJeux>>[number];

function lireJeux(projetId: string, inclure: boolean) {
  return prisma.jeuDonneesProjet.findMany({
    where: { projetId, statut: { in: inclure ? ["AUTORISE", "CONTROLE", "RECU"] : ["AUTORISE"] } },
    include: INCLURE_JEU,
    orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/** Retient un seul jeu par (role, concessionnaire) : le jeu en controle, s'il y en a un, sinon le jeu autorise. */
function jeuxRetenus(jeux: JeuLu[]): JeuLu[] {
  const parCle = new Map<string, JeuLu>();
  const autres: JeuLu[] = [];
  for (const j of jeux) {
    if (j.role === "AUTRE") { autres.push(j); continue; }
    const cle = `${j.role}|${j.concessionnaireId ?? ""}`;
    const courant = parCle.get(cle);
    const enAttente = j.statut !== "AUTORISE";
    if (!courant || (enAttente && courant.statut === "AUTORISE") || (enAttente === (courant.statut !== "AUTORISE") && j.createdAt > courant.createdAt)) parCle.set(cle, j);
  }
  return [...parCle.values(), ...autres];
}

export interface ResultatAnalyse {
  reponse: Record<string, unknown>;
  lignesObjets: (depot.MesureAxeObjet & { nomJeu: string })[];
  projet: { id: string; code: string; nom: string };
  projection: string;
  largeurs: { empriseM: number; chausseeM: number; statut: string };
  jeuxParId: Map<string, JeuLu>;
}

export async function calculer(d: DemandeAnalyse): Promise<ResultatAnalyse> {
  const projet = await prisma.projetVoirie.findFirst({ where: { id: d.projetId, deletedAt: null } });
  if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
  const empr = d.largeurEmpriseM ?? Number(projet.largeurEmpriseM);
  const chau = d.largeurChausseeM ?? Number(projet.largeurChausseeM);
  if (!(chau > 0 && chau <= empr && empr <= 200)) {
    throw new ErreurMetier(400, "LARGEURS_INCOHERENTES", "La largeur de chaussée doit être positive et au plus égale à la largeur d'emprise (200 m au plus).");
  }
  const surcharge = d.largeurEmpriseM !== undefined || d.largeurChausseeM !== undefined;
  const statutParametres = surcharge && (empr !== Number(projet.largeurEmpriseM) || chau !== Number(projet.largeurChausseeM)) ? "THEORIQUE" : projet.statutParametres;

  // Lot T1 : CRS metrique impose par le territoire du projet, sinon regle par bandes de la configuration nationale (plus de constante).
  const spatial = await contexteSpatialDuProjet(d.projetId);
  const retenus = jeuxRetenus(await lireJeux(d.projetId, d.inclureNonAutorises));
  const axes = retenus.filter((j) => j.role === "AXES_TRAVAUX");
  const reseaux = retenus.filter((j) => j.role === "RESEAU_TIERS");
  const limites = retenus.filter((j) => j.role === "LIMITES_ROUTE");
  const axesIds = axes.map((j) => j.id);
  const reseauIds = reseaux.map((j) => j.id);

  const delai = Math.max(1_000, Math.min(delaiAnalyseMs(), d.delaiMaxMs ?? Number.POSITIVE_INFINITY));
  const trop = () => new ErreurMetier(504, "ANALYSE_TROP_LONGUE", `L'analyse a depasse ${Math.round(delai / 1000)} s et a ete interrompue : le projet est trop volumineux pour un calcul immediat.`);
  // Au plus 3 analyses simultanees (503 SERVICE_OCCUPE au-dela) ; le budget de temps est partage par toutes les requetes de l'analyse.
  const mesures = await limiteurAnalyses.executer(() => avecErreurDelai("ANALYSE_TROP_LONGUE", trop().message, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const budget = new Budget(tx, delai, delaiVerrouMs(), trop);
    const calcule = axesIds.length > 0 && reseauIds.length > 0;
    if (calcule) {
      const v = await budget.etape(() => depot.volumes(tx, axesIds, reseauIds), "volumes");
      if (v.sommetsAxes > SOMMETS_AXES_ANALYSE_MAX || v.sommetsReseau > SOMMETS_RESEAU_ANALYSE_MAX) {
        throw new ErreurMetier(422, "ANALYSE_TROP_VOLUMINEUSE",
          `Les jeux autorises portent trop de sommets pour une analyse (${Math.round(v.sommetsAxes)} pour les axes, maximum ${SOMMETS_AXES_ANALYSE_MAX} ; ${Math.round(v.sommetsReseau)} pour les reseaux, maximum ${SOMMETS_RESEAU_ANALYSE_MAX}) : simplifiez ou decoupez les fichiers.`,
          { sommetsAxes: Math.round(v.sommetsAxes), sommetsReseau: Math.round(v.sommetsReseau) });
      }
    }
    const etendue = await budget.etape(() => depot.etendueLongitude(tx, axesIds.length ? axesIds : reseauIds), "etendue");
    const epsg = etendue ? spatial.epsgPour((etendue.ouest + etendue.est) / 2) : spatial.epsgDefaut;
    const b: depot.Bandes = { epsg, dc: chau / 2, de: empr / 2, axesIds, reseauIds };
    const liste = axesIds.length ? await budget.etape(() => depot.listerAxes(tx, b), "axes") : { axes: [], longueurFusionneeM: 0 };
    return {
      epsg,
      liste,
      parJeu: calcule ? await budget.etape(() => depot.mesurerParJeu(tx, b), "par jeu") : [],
      parAxe: calcule ? await budget.etape(() => depot.mesurerParAxe(tx, b), "par axe") : [],
      parObjet: calcule ? await budget.etape(() => depot.mesurerParObjet(tx, b, LIGNES_OBJETS_MAX + 1), "par objet") : [],
      points: calcule && !d.sansGeometries ? await budget.etape(() => depot.pointsDeCroisement(tx, b, CROISEMENTS_MAX), "croisements") : [],
      zones: calcule && !d.sansGeometries ? await budget.etape(() => depot.zones(tx, b), "zones") : { chaussee: null, emprise: null, hors: null },
    };
  }, { timeout: delai + 15_000, maxWait: 10_000 })));

  const projection = `EPSG:${mesures.epsg}`;
  const jeuxParId = new Map(retenus.map((j) => [j.id, j] as const));
  const classeDe = (j: JeuLu): ClasseLue => (j.classePrecision as ClasseLue) ?? null;
  const nomConc = (j: JeuLu) => j.concessionnaire?.nom ?? "";

  // --- Par jeu (union des bandes de tous les axes) ---
  const parJeu = new Map(mesures.parJeu.map((m) => [m.jeu, m]));
  const jeuxReponse = retenus.filter((j) => j.role !== "AUTRE").map((j) => ({
    jeuId: j.id, role: j.role,
    concessionnaire: j.concessionnaire ? { id: j.concessionnaire.id, nom: j.concessionnaire.nom } : null,
    typeReseau: j.typeReseau, statut: j.statut, nonAutorise: j.statut !== "AUTORISE", version: j.version,
    classePrecision: j.classePrecision, qualification: j.role === "RESEAU_TIERS" ? qualificationDe(classeDe(j)) : null,
    confidentialite: j.confidentialite, natureObjets: j.natureObjets, nbObjets: j.nbObjets,
    longueurTotaleM: r2(j.longueurTotaleM), longueurTraceFusionneM: r2(j.longueurTraceFusionneM), dateDonnees: jour(j.dateDonnees),
  }));

  const sommes = (liste: JeuLu[]) => {
    let c = 0, e = 0, x = 0, h = 0;
    for (const j of liste) {
      const m = parJeu.get(j.id);
      if (!m) continue;
      c += m.chausseeM; e += m.empriseM; x += m.croisements; h += Math.max(0, m.fusionneM - m.empriseM);
    }
    return { chausseeM: r2(c), empriseM: r2(e), empriseHorsChausseeM: r2(Math.max(0, e - c)), horsEmpriseM: r2(h), croisements: x };
  };

  // --- Reseaux : par type et par concessionnaire (valeurs enregistrees au depot) ---
  const parType = new Map<string, { typeReseau: string; longueurTraceFusionneM: number; nbObjets: number }>();
  for (const j of reseaux) {
    const t = parType.get(j.typeReseau!) ?? { typeReseau: j.typeReseau!, longueurTraceFusionneM: 0, nbObjets: 0 };
    t.longueurTraceFusionneM += j.longueurTraceFusionneM;
    t.nbObjets += j.nbObjets;
    parType.set(j.typeReseau!, t);
  }
  const parConc = new Map<string, JeuLu[]>();
  for (const j of reseaux) parConc.set(j.concessionnaireId!, [...(parConc.get(j.concessionnaireId!) ?? []), j]);

  const reseauxConc = [...parConc.entries()].map(([id, js]) => ({
    concessionnaireId: id, nom: nomConc(js[0]), typeReseau: js[0].typeReseau,
    longueurTraceFusionneM: r2(js.reduce((s, j) => s + j.longueurTraceFusionneM, 0)),
    longueurSommeM: r2(js.reduce((s, j) => s + j.longueurTotaleM, 0)),
    nbObjets: js.reduce((s, j) => s + j.nbObjets, 0), libelleNbObjets: LIBELLES.nbObjets,
    jeuxIds: js.map((j) => j.id), statut: js.some((j) => j.statut !== "AUTORISE") ? "CONTROLE" : "AUTORISE",
  })).sort((a, b) => b.longueurTraceFusionneM - a.longueurTraceFusionneM || a.nom.localeCompare(b.nom));

  // Lot B1 : jamais un total qui melange les natures. Granularite du JEU : la nature declaree pour le jeu (natureObjets) ; INCONNUE reste a part.
  const parNatureJeux = new Map<string, JeuLu[]>();
  for (const j of reseaux) parNatureJeux.set(j.natureObjets, [...(parNatureJeux.get(j.natureObjets) ?? []), j]);
  const reseauxParNature = [...parNatureJeux.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nature, js]) => ({
    nature, nbJeux: js.length, nbObjets: js.reduce((x, j) => x + j.nbObjets, 0), libelleNbObjets: LIBELLES.nbObjets,
    longueurSommeM: r2(js.reduce((x, j) => x + j.longueurTotaleM, 0)), longueurTraceFusionneM: r2(js.reduce((x, j) => x + j.longueurTraceFusionneM, 0)),
  }));

  const conflitsConc = [...parConc.entries()].map(([id, js]) => {
    const s = sommes(js);
    const classes = [...new Set(js.map((j) => j.classePrecision ?? "inconnue"))];
    return {
      concessionnaireId: id, nom: nomConc(js[0]),
      classePrecision: classes.length === 1 ? (classes[0] === "inconnue" ? null : classes[0]) : null, classesPrecision: classes,
      // Un concessionnaire a au plus un jeu retenu par cle : la qualification est celle de son jeu (la plus prudente si plusieurs).
      qualification: js.every((j) => qualificationDe(classeDe(j)) === "CONFLIT_POTENTIEL") ? "CONFLIT_POTENTIEL" as const : "PROXIMITE_A_VERIFIER" as const,
      ...s, ...etiquette, nonAutorise: js.some((j) => j.statut !== "AUTORISE"),
    };
  }).sort((a, b) => b.empriseM - a.empriseM || a.nom.localeCompare(b.nom));

  const parQualif = (q: Qualification) => {
    const s = sommes(reseaux.filter((j) => qualificationDe(classeDe(j)) === q));
    return { chausseeM: s.chausseeM, empriseM: s.empriseM, empriseHorsChausseeM: s.empriseHorsChausseeM, horsEmpriseM: s.horsEmpriseM, croisements: s.croisements, ...etiquette };
  };

  // --- Par axe ---
  const objetsParAxe = new Map<string, depot.MesureAxeObjet[]>();
  for (const o of mesures.parObjet.slice(0, LIGNES_OBJETS_MAX)) objetsParAxe.set(o.axeId, [...(objetsParAxe.get(o.axeId) ?? []), o]);
  const parObjetTronque = mesures.parObjet.length > LIGNES_OBJETS_MAX;
  const metriquesAxe = new Map<string, { c: number; e: number; x: number; jeux: Set<string> }>();
  for (const m of mesures.parAxe) {
    const a = metriquesAxe.get(m.axeId) ?? { c: 0, e: 0, x: 0, jeux: new Set<string>() };
    a.c += m.chausseeM; a.e += m.empriseM; a.x += m.croisements; a.jeux.add(m.jeu);
    metriquesAxe.set(m.axeId, a);
  }
  // Lot B1 : nature et classe de precision EFFECTIVES (objet, sinon jeu, sinon inconnue) des objets listes ; les totaux restent a la granularite du jeu.
  const objetsTries = new Map(mesures.liste.axes.map((a) => [
    a.id, [...(objetsParAxe.get(a.id) ?? [])].sort((p, q) => q.empriseM - p.empriseM || q.chausseeM - p.chausseeM || p.objetId.localeCompare(q.objetId)),
  ] as const));
  const descripteurs = await descripteursDesObjets(prisma, [...objetsTries.values()].flatMap((l) => l.slice(0, OBJETS_PAR_AXE_MAX).map((o) => o.objetId)));
  const parAxe = mesures.liste.axes.map((a) => {
    const m = metriquesAxe.get(a.id);
    const objets = objetsTries.get(a.id) ?? [];
    return {
      axe: a.axe, axeId: a.id, longueurM: r2(a.longueurM),
      chausseeM: r2(m?.c ?? 0), empriseM: r2(m?.e ?? 0), empriseHorsChausseeM: r2(Math.max(0, (m?.e ?? 0) - (m?.c ?? 0))), croisements: m?.x ?? 0,
      concessionnaires: [...new Set([...(m?.jeux ?? [])].map((id) => nomConc(jeuxParId.get(id)!)))].sort(),
      objets: objets.slice(0, OBJETS_PAR_AXE_MAX).map((o) => {
        const d = descripteurs.get(o.objetId);
        const jeuObjet = jeuxParId.get(o.jeu)!;
        const nature = natureEffective(d?.nature, d?.natureJeu ?? jeuObjet.natureObjets);
        const classe = classeEffective(d?.classe, d ? d.classeJeu : jeuObjet.classePrecision);
        return {
          jeuId: o.jeu, objetId: o.objetId, nom: o.nom,
          nature: nature.nature, origineNature: nature.origine, classePrecision: classe.classe, qualification: qualificationDe(classe.classe),
          chausseeM: r2(o.chausseeM), empriseM: r2(o.empriseM), croisements: o.croisements,
        };
      }),
      objetsTronques: objets.length > OBJETS_PAR_AXE_MAX || parObjetTronque,
      ...etiquette,
    };
  }).sort((p, q) => q.empriseM - p.empriseM || q.croisements - p.croisements || p.axe.localeCompare(q.axe));

  const objetsTouches = new Set(mesures.parObjet.map((o) => o.objetId)).size;
  const totalCroisements = mesures.parJeu.reduce((s, m) => s + m.croisements, 0);

  const zonesTaille = (g: string | null) => (g ? g.length : 0);
  const zonesTronquees = [mesures.zones.chaussee, mesures.zones.emprise, mesures.zones.hors].some((g) => zonesTaille(g) > TAILLE_ZONES_MAX);
  const geo = (g: string | null) => (g && g.length <= TAILLE_ZONES_MAX ? (JSON.parse(g) as unknown) : null);

  const ctx = {
    largeurEmpriseM: empr, largeurChausseeM: chau, statutParametres: statutParametres as "THEORIQUE" | "VALIDE", projection,
    nbAxes: mesures.liste.axes.length,
    nbJeuxReseau: reseaux.length, nbJeuxLimites: limites.length,
    datesDonnees: [...axes, ...reseaux].map((j) => jour(j.dateDonnees)),
    precisionsDeclareesM: reseaux.map((j) => (j.precisionHorizontaleM === null ? null : Number(j.precisionHorizontaleM))),
    classes: reseaux.map(classeDe),
    inclureNonAutorises: d.inclureNonAutorises,
    nbJeuxNonAutorises: retenus.filter((j) => j.statut !== "AUTORISE").length,
  };

  const reponse = {
    projet: { id: projet.id, code: projet.code, nom: projet.nom },
    ...etiquette,
    versionAlgorithme: VERSION_ALGORITHME,
    regle: { version: VERSION_REGLE, chausseeM: chau, empriseM: empr, projection },
    inclureNonAutorises: d.inclureNonAutorises,
    parametres: { largeurEmpriseM: empr, largeurChausseeM: chau, statut: statutParametres, projection, surcharge },
    libelles: { ...LIBELLES },
    natures: {
      granularite: "JEU",
      libelle: "Les totaux par nature (infrastructure physique, circuit logique, équipement, inconnue) sont ceux de la nature DÉCLARÉE pour chaque jeu ; la nature et la classe de précision d'un objet précisées par un descripteur ne figurent que dans la liste des objets de chaque axe. Un conflit avec un simple circuit logique n'est pas un conflit avec une infrastructure physique.",
    },
    axes: { nb: mesures.liste.axes.length, longueurM: r2(mesures.liste.longueurFusionneeM), jeuxIds: axesIds },
    jeux: jeuxReponse,
    reseaux: {
      parType: [...parType.values()].map((t) => ({ ...t, longueurTraceFusionneM: r2(t.longueurTraceFusionneM), libelleNbObjets: LIBELLES.nbObjets })).sort((a, b) => b.longueurTraceFusionneM - a.longueurTraceFusionneM),
      parConcessionnaire: reseauxConc,
      parNature: reseauxParNature,
    },
    conflits: {
      total: {
        ...sommes(reseaux), croisements: totalCroisements,
        axesTouches: new Set(mesures.parAxe.map((m) => m.axeId)).size, objetsTouches,
        parQualification: { CONFLIT_POTENTIEL: parQualif("CONFLIT_POTENTIEL"), PROXIMITE_A_VERIFIER: parQualif("PROXIMITE_A_VERIFIER") },
        parNature: Object.fromEntries([...parNatureJeux.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nature, js]) => [nature, { ...sommes(js), ...etiquette }])),
        ...etiquette,
      },
      parAxe,
      parConcessionnaire: conflitsConc,
      croisements: {
        type: "FeatureCollection" as const,
        features: mesures.points.map((p) => {
          const j = jeuxParId.get(p.jeu)!;
          return {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
            properties: { jeuId: p.jeu, concessionnaire: nomConc(j), axe: p.axe, qualification: qualificationDe(classeDe(j)), ...etiquette },
          };
        }),
        nbTotal: totalCroisements,
        tronque: totalCroisements > mesures.points.length,
      },
      zones: { chaussee: geo(mesures.zones.chaussee), emprise: geo(mesures.zones.emprise), hors: geo(mesures.zones.hors), tronque: zonesTronquees },
    },
    hypotheses: construireHypotheses(ctx),
    limites: construireLimites(ctx),
  };

  return {
    reponse,
    lignesObjets: mesures.parObjet.slice(0, LIGNES_OBJETS_MAX).map((o) => ({ ...o, nomJeu: jeuxParId.get(o.jeu)!.nomFichier })),
    projet: { id: projet.id, code: projet.code, nom: projet.nom },
    projection,
    largeurs: { empriseM: empr, chausseeM: chau, statut: statutParametres },
    jeuxParId,
  };
}

/**
 * Analyse ; les consultations de jeux sensibles sont TRACEES avant la remise (voir consultation.ts) : la couche de conflits et les
 * points de croisement donnent des geometries de reseaux de tiers.
 */
export async function analyser(d: DemandeAnalyse, acteur?: Acteur) {
  const a = await calculer(d);
  if (acteur) {
    const reseaux = [...a.jeuxParId.values()].filter((j) => j.role === "RESEAU_TIERS");
    const axes = [...a.jeuxParId.values()].some((j) => j.role === "AXES_TRAVAUX");
    // Pas d'axe autorise : aucune geometrie n'est rendue, rien a tracer.
    if (axes) await tracerConsultation(acteur, reseaux.map((j) => ({ id: j.id, confidentialite: j.confidentialite, nbObjets: j.nbObjets })), { route: "analyse", bbox: null, zoom: null });
  }
  return a.reponse;
}

// ------------------------------------------------------------------------------------------------
// Export CSV (agregats uniquement, aucune geometrie) -- ADMIN et GESTIONNAIRE, audite AVANT la remise
// ------------------------------------------------------------------------------------------------

/** Neutralise l'injection de formule (Excel) et protege les separateurs. */
export function celluleCsv(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v).replace(".", ",") : v;
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const ENTETE_CSV = [
  "axe", "concessionnaire", "typeReseau", "fichier", "versionJeu", "statutJeu", "classePrecision", "qualification", "objetId", "nomObjet",
  "chausseeM", "empriseM", "empriseHorsChausseeM", "croisements", "statut", "regle", "projection", "largeurChausseeM", "largeurEmpriseM", "statutParametres",
] as const;

export async function exporterCsv(acteur: Acteur, d: DemandeAnalyse) {
  const a = await calculer(d);
  const lignes = a.lignesObjets.map((o) => {
    const j = a.jeuxParId.get(o.jeu)!;
    return [
      o.axe, j.concessionnaire?.nom ?? "", j.typeReseau ?? "", o.nomJeu, j.version, j.statut, j.classePrecision ?? "inconnue",
      qualificationDe((j.classePrecision as ClasseLue) ?? null), o.objetId, o.nom ?? "",
      r2(o.chausseeM), r2(o.empriseM), r2(Math.max(0, o.empriseM - o.chausseeM)), o.croisements, STATUT_RESULTAT, VERSION_REGLE, a.projection,
      a.largeurs.chausseeM, a.largeurs.empriseM, a.largeurs.statut,
    ];
  });
  const csv = "﻿" + [ENTETE_CSV.join(";"), ...lignes.map((l) => l.map(celluleCsv).join(";"))].join("\r\n") + "\r\n";
  await prisma.$transaction(async (tx) => {
    await logAuditTransactionnelle(tx, {
      userId: acteur.id, action: "CREATE", entityType: "ExportProjetVoirie", entityId: a.projet.id,
      after: {
        format: "csv", projet: a.projet.code, nbLignes: lignes.length, inclureNonAutorises: d.inclureNonAutorises,
        largeurChausseeM: a.largeurs.chausseeM, largeurEmpriseM: a.largeurs.empriseM, geometries: false,
      },
      ipAddress: acteur.ip,
    });
  });
  const date = new Date().toISOString().slice(0, 10);
  return { csv, nbLignes: lignes.length, nomFichier: `analyse-${a.projet.code.toLowerCase()}-${date}.csv` };
}
