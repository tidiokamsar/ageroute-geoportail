/**
 * Service des detecteurs de qualite : orchestre le depot SQL (mesures, lecture seule) et le noyau
 * pur (classification), et rend un rapport par CODE STABLE.
 *
 * AUCUNE ECRITURE, ET LA BASE LE GARANTIT
 *
 * `lancerDetecteurs` ne fait que lire, et ne contient aucune instruction d'ecriture. Pour que cette
 * propriete ne repose pas sur la seule relecture du code, `lancerEnLectureSeule` execute tout dans une
 * transaction PostgreSQL `READ ONLY` : une ecriture, meme introduite par erreur plus tard, serait
 * refusee par la base (erreur 25006). C'est la forme a utiliser derriere une route HTTP ou en
 * production. `lancerDetecteurs` accepte aussi un client de transaction fourni par l'appelant, ce que
 * fait le banc PostGIS pour comparer les compteurs d'ecriture avant et apres.
 *
 * Ce module n'ecrit pas dans `audit_logs` : une lecture n'est pas une ecriture du patrimoine
 * (regle 3 d'AGENTS.md). La route qui l'expose consigne qui l'a lancee dans le journal applicatif.
 */
import type { PrismaClient } from "@prisma/client";
import {
  AccumulateurAnomalies,
  CATALOGUE_CODES,
  CODES_ANOMALIE,
  DOCUMENTATION_SEUILS,
  classerDoublons,
  classerRegion,
  classerTroncon,
  construireSeuils,
  detecterChainesPk,
  type Agregat,
  type AnomalieDetectee,
  type CodeAnomalie,
  type FamilleDetecteur,
  type NomSeuil,
  type Seuils,
} from "./detecteurs.noyau";
import {
  chargerChainesPk,
  chargerPairesVoisines,
  compterTronconsActifs,
  etatDesLimites,
  mesurerRegions,
  mesurerTroncons,
  nomsDesRegions,
  PLAFOND_PAIRES,
  type ClientLecture,
  type PorteeDetecteurs,
} from "./detecteurs.depot";

export const TOUTES_FAMILLES: readonly FamilleDetecteur[] = ["PK", "LONGUEUR", "GEOMETRIE", "REGION", "DOUBLON", "ETAT"];

/** Entites listees par code au plus (le COMPTE reste exact). */
export const PLAFOND_ENTITES_PAR_CODE = 500;
export const TAILLE_LOT = 5000;

export interface OptionsDetecteurs {
  portee: PorteeDetecteurs;
  /** Surcharges de seuils provisoires. */
  seuils?: Partial<Record<NomSeuil, number>>;
  /** Familles a executer (defaut : toutes). Permet de borner le cout. */
  familles?: readonly FamilleDetecteur[];
  plafondParCode?: number;
  tailleLot?: number;
  /** Injectee pour que la date courante ne soit pas lue dans le noyau. */
  maintenant?: Date;
}

export interface SeuilRapporte {
  nom: NomSeuil;
  valeur: number;
  unite: string;
  statut: "PROVISOIRE";
  origine: string;
}

export interface RapportDetecteurs {
  genereLe: string;
  portee: { regionId: number | null; reseau: string };
  familles: readonly FamilleDetecteur[];
  seuils: SeuilRapporte[];
  populationTronconsActifs: number;
  total: number;
  parCode: Agregat["parCode"];
  parRegion: (Agregat["parRegion"][number] & { regionNom: string | null })[];
  /** Codes des familles executees pour lesquels AUCUNE anomalie n'a ete trouvee. */
  codesSansAnomalie: CodeAnomalie[];
  avertissements: string[];
  nonCouvert: string[];
}

/** Ce que les detecteurs ne voient PAS. Repris dans la reponse pour que le rapport ne se lise pas comme exhaustif. */
export const NON_COUVERT: readonly string[] = [
  "Seuls les troncons actifs (deletedAt nul) sont examines ; ouvrages, chantiers, portions, points noirs et voirie locale hors registre des troncons ne le sont pas.",
  "Les PK ne sont chainees que pour les troncons portant une section (sectionPk) ; la voirie promue et les troncons sans section ne sont pas controles en chevauchement ni en trou. Un trou au debut ou a la fin d'une section n'est pas vu.",
  "Les PK sont jugees en valeur seule ; l'ecart entre (PK fin - PK debut) et la longueur declaree n'est pas controle. Une section parcourue a PK decroissants est signalee PK_FIN_INFERIEUR_DEBUT meme si c'est voulu.",
  "La longueur declaree est comparee a la longueur geodesique du trace ; un trace tronque ou decoupe avec une longueur coherente a lui-meme n'est pas vu.",
  "La region est jugee par le NOM : la region du troncon est appariee a la limite de niveau 1 de meme nom (sans accent ni casse). Une region sans limite de meme nom est REGION_NON_VERIFIABLE, non jugee. La precision de la couche de limites n'est pas verifiee (un trace longeant une frontiere compte comme dedans ou dehors selon la couche).",
  "Un troncon dont aucune limite de niveau 1 valide n'est touchee est HORS_TERRITOIRE ; un troncon majoritairement hors du pays mais touchant une limite n'est pas signale. Un troncon sans majorite nette (par exemple 45/45/10 entre trois regions) n'est pas signale discordant.",
  "Les doublons sont cherches parmi les voisins dont l'emprise est identique a la tolerance pres ; deux traces superposes sur un SEGMENT seulement (l'un plus long que l'autre) ne sont pas des doublons ici. Les geometries invalides ou vides sont ecartees des doublons (elles sont signalees par GEOM_*).",
  "L'etat declare est la colonne troncons.etat ; elle n'est comparee ni aux portions validees ni aux inspections (le referentiel de l'etat des portions est un vocabulaire administrable sans ordre defini). NON_EVALUE etant la valeur par defaut, ETAT_NON_EVALUE est tres frequent par construction.",
  "Les seuils sont PROVISOIRES : un compte change si un seuil change. Aucun detecteur ne dit ce qui est juste, seulement ce qui s'ecarte d'un seuil nomme.",
];

/**
 * Execute les detecteurs avec le client fourni (lecture seule dans l'intention ; voir
 * `lancerEnLectureSeule` pour la garantie par la base).
 */
export async function lancerDetecteurs(db: ClientLecture, options: OptionsDetecteurs): Promise<RapportDetecteurs> {
  const seuils = construireSeuils(options.seuils);
  const maintenant = options.maintenant ?? new Date();
  const familles = options.familles ?? TOUTES_FAMILLES;
  const plafond = options.plafondParCode ?? PLAFOND_ENTITES_PAR_CODE;
  const taille = options.tailleLot ?? TAILLE_LOT;
  const portee = options.portee;
  const acc = new AccumulateurAnomalies(plafond);
  const avertissements: string[] = [];
  const veut = (f: FamilleDetecteur) => familles.includes(f);

  const population = await compterTronconsActifs(db, portee);

  // Passe 1 : tout ce qui se juge sur un troncon isole (PK, longueur, geometrie, etat).
  if (veut("PK") || veut("LONGUEUR") || veut("GEOMETRIE") || veut("ETAT")) {
    let curseur: string | null = null;
    for (;;) {
      const lot = await mesurerTroncons(db, portee, curseur, taille);
      for (const m of lot) {
        for (const a of classerTroncon(m, maintenant, seuils)) {
          if (veut(CATALOGUE_CODES[a.code].famille)) acc.ajouter(a);
        }
      }
      if (lot.length < taille) break;
      curseur = lot[lot.length - 1].id;
    }
  }

  // Passe 2 : chainage des PK le long des sections de route.
  if (veut("PK")) {
    const lignes = await chargerChainesPk(db, portee);
    for (const a of detecterChainesPk(lignes, seuils)) {
      if (dansLaPortee(a, portee)) acc.ajouter(a);
    }
  }

  // Passe 3 : region et territoire.
  if (veut("REGION")) {
    const limites = await etatDesLimites(db);
    if (limites.utilisables === 0) {
      avertissements.push("Aucune limite de niveau 1 en base : la famille REGION n'a pas ete executee (tous les troncons auraient ete dits hors territoire). Lancer d'abord importer-limites-admin.ts.");
    } else {
      if (limites.invalides > 0) {
        avertissements.push(`${limites.invalides} limite(s) de niveau 1 invalide(s) ecartee(s) de la mesure : les resultats REGION et HORS_TERRITOIRE sont degrades.`);
      }
      let curseur: string | null = null;
      for (;;) {
        const lot = await mesurerRegions(db, portee, curseur, taille);
        for (const m of lot) acc.ajouterTout(classerRegion(m, seuils));
        if (lot.length < taille) break;
        curseur = lot[lot.length - 1].id;
      }
    }
  }

  // Passe 4 : doublons de geometrie.
  if (veut("DOUBLON")) {
    const paires = await chargerPairesVoisines(db, portee, seuils.DOUBLON_QUASI_TOLERANCE_DEG);
    if (paires.length >= PLAFOND_PAIRES) {
      avertissements.push(`Le plafond de ${PLAFOND_PAIRES} paires de voisins est atteint : la famille DOUBLON est incomplete. Relancer par region.`);
    }
    acc.ajouterTout(classerDoublons(paires, seuils));
  }

  const agregat = acc.resultat();
  const noms = await nomsDesRegions(db);
  const codesExecutes = CODES_ANOMALIE.filter((c) => veut(CATALOGUE_CODES[c].famille));
  const presents = new Set(agregat.parCode.map((c) => c.code));

  return {
    genereLe: maintenant.toISOString(),
    portee: { regionId: portee.regionId, reseau: portee.reseau ?? "tout" },
    familles,
    seuils: (Object.keys(DOCUMENTATION_SEUILS) as NomSeuil[]).map((nom) => rapporterSeuil(nom, seuils)),
    populationTronconsActifs: population,
    total: agregat.total,
    parCode: agregat.parCode,
    parRegion: agregat.parRegion.map((r) => ({ ...r, regionNom: r.regionId === null ? null : (noms.get(r.regionId) ?? null) })),
    codesSansAnomalie: codesExecutes.filter((c) => !presents.has(c)),
    avertissements,
    nonCouvert: [...NON_COUVERT],
  };
}

function rapporterSeuil(nom: NomSeuil, seuils: Seuils): SeuilRapporte {
  const d = DOCUMENTATION_SEUILS[nom];
  return { nom, valeur: seuils[nom], unite: d.unite, statut: d.statut, origine: d.origine };
}

/** Une anomalie de chainage appartient a la portee si le troncon ou son partenaire est dans la region. */
function dansLaPortee(a: AnomalieDetectee, p: PorteeDetecteurs): boolean {
  if (p.regionId === null) return true;
  return a.regionId === p.regionId || a.details.partenaireRegionId === p.regionId;
}

/** Duree maximale d'une transaction de lecture : un balayage national depasse largement les 5 s par defaut de Prisma. */
export const DELAI_TRANSACTION_MS = 10 * 60_000;

/**
 * Execute `lancerDetecteurs` dans une transaction PostgreSQL READ ONLY : la base refuse toute
 * ecriture. `SET TRANSACTION` est la premiere instruction de la transaction.
 */
export async function lancerEnLectureSeule(
  prisma: Pick<PrismaClient, "$transaction">, options: OptionsDetecteurs,
): Promise<RapportDetecteurs> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return lancerDetecteurs(tx, options);
  }, { timeout: DELAI_TRANSACTION_MS, maxWait: 30_000 });
}
