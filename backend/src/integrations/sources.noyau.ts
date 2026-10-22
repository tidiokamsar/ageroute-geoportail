/**
 * CONSTRUCTION DES CHARGES A PARTIR DES SOURCES. AUCUN ACCES BASE, AUCUN RESEAU.
 *
 * CHAQUE CHAMP EST NOMME, AUCUN N'EST COPIE EN BLOC
 *
 * Une charge est construite en listant les champs emis un par un. On ne fait jamais
 * `{ ...ligne }` ni `Object.assign` : le jour ou une colonne interne (note d'agent, cout interne,
 * auteur, adresse IP) est ajoutee a la table, elle n'a aucune chance de partir par inadvertance.
 * Une deuxieme barriere, `trouverChampInterne`, refuse toute charge qui porterait une cle de la
 * liste noire, meme si un constructeur futur la laissait passer.
 *
 * CE QUI N'EST JAMAIS EMIS, par source (liste non exhaustive, c'est l'inverse qui est ecrit) :
 *   Troncon    observations, coutRehabEstime, prefecture, commune, trafic, criticite, provenance
 *   Ouvrage    remarques, travauxAPrevoir, photos, materiaux, fiche
 *   Portion    creeParId, clientOperationId, observationId, praticabiliteCause
 *   Bulletin   genereParId, publicationsIds, gabarit
 */
import { ecrireGeoJson, type GeometriePivot, type LignePivot } from "../import/pivot.noyau";
import { sha256Hex } from "./canonique";
import type { ChargeDepotBulletin, ChargeFicheIntervention, ChargePivot } from "./contrats";
import type { TypeSource } from "./types";

/** Valeur proposee pour `systeme_source` : a confirmer (CHAMPS_A_CONFIRMER, BDR_L2R). */
export const SYSTEME_SOURCE_EXPORT = "AGEROUTE_GEOPORTAIL";

export type Construction<T> = { ok: true; charge: T } | { ok: false; motif: string };

/* ------------------------------ Snapshots (formes lues) ------------------------------ */

export interface SnapshotTroncon {
  id: string; code: string; nom: string; classe: string; longueurKm: number;
  revetement: string; etat: string; regionNom: string | null;
  dateDerniereEvaluation: string | null;
  /** GeoJSON de `ST_AsGeoJSON(geom)`, deja parse. */
  geometrie: unknown;
}

export interface SnapshotOuvrage {
  id: string; code: string | null; nom: string; type: string; etat: string; pk: number | null;
  tronconCode: string | null; geometrie: unknown;
}

export interface SnapshotPortion {
  id: string; tronconId: string; tronconCode: string | null; debutM: number; finM: number;
  etat: string | null; revetement: string | null; praticabilite: string | null;
  valideDu: string | null; valideAu: string | null; observeeLe: string | null;
  geometrie: unknown;
}

export interface SnapshotBulletin {
  id: string; numero: string; jour: string; texte: string; empreinteSha256: string;
}

/**
 * Forme ATTENDUE d'une fiche d'intervention approuvee. Aucune table ne la porte aujourd'hui
 * (moteur de programmation absent, D-07) : cette interface est le contrat que la future table
 * devra satisfaire, pas la lecture d'une table existante.
 */
export interface SnapshotFiche {
  id: string;
  versionFigee: string;
  statut: string;
  identifiantsPatrimoniaux: { typeObjet: "troncon" | "portion" | "ouvrage"; identifiant: string; codeEchange: string | null }[];
  plageLineaire: { debutM: number; finM: number } | null;
  traitement: { code: string; libelle: string | null };
  quantites: { valeur: number; unite: string }[];
  coutEstime: { montantGnf: string; classePrecision: string };
  score: number | null;
  justification: string;
  annee: number;
  sourceFinancement: string;
}

/* --------------------------------- Constructeurs --------------------------------- */

function geometriePivot(g: unknown): GeometriePivot | null {
  if (g === null || typeof g !== "object") return null;
  const o = g as { type?: unknown; coordinates?: unknown };
  if ((o.type === "Point" || o.type === "LineString") && Array.isArray(o.coordinates)) {
    return { type: o.type, coordinates: o.coordinates } as GeometriePivot;
  }
  return null;
}

function enPivot(ligne: LignePivot): ChargePivot {
  return ecrireGeoJson([ligne]) as unknown as ChargePivot;
}

export function chargePivotTroncon(s: SnapshotTroncon): Construction<ChargePivot> {
  const geometrie = geometriePivot(s.geometrie);
  if (!geometrie || geometrie.type !== "LineString") {
    return { ok: false, motif: "le troncon n'a pas de trace LineString : le pivot exige une geometrie, rien n'est invente" };
  }
  return {
    ok: true,
    charge: enPivot({
      systemeSource: SYSTEME_SOURCE_EXPORT, typeObjet: "troncon", identifiantSource: s.id,
      codeRoute: s.code, debutM: null, finM: null, geometrie, dateSource: s.dateDerniereEvaluation,
      attributs: { nom: s.nom, classe: s.classe, longueur_km: s.longueurKm, revetement: s.revetement, etat: s.etat, region: s.regionNom },
    }),
  };
}

export function chargePivotOuvrage(s: SnapshotOuvrage): Construction<ChargePivot> {
  const geometrie = geometriePivot(s.geometrie);
  if (!geometrie || geometrie.type !== "Point") {
    return { ok: false, motif: "l'ouvrage n'a pas de position Point : le pivot exige une geometrie, rien n'est invente" };
  }
  return {
    ok: true,
    charge: enPivot({
      systemeSource: SYSTEME_SOURCE_EXPORT, typeObjet: "ouvrage", identifiantSource: s.id,
      codeRoute: s.tronconCode, debutM: null, finM: null, geometrie, dateSource: null,
      // `code_echange` : la cle `code Route-Type-PK`, la seule en service vers un tiers (DigitalRoad).
      attributs: { nom: s.nom, type: s.type, etat: s.etat, pk: s.pk, code_echange: s.code },
    }),
  };
}

export function chargePivotPortion(s: SnapshotPortion): Construction<ChargePivot> {
  return {
    ok: true,
    charge: enPivot({
      systemeSource: SYSTEME_SOURCE_EXPORT, typeObjet: "portion", identifiantSource: s.id,
      codeRoute: s.tronconCode, debutM: s.debutM, finM: s.finM, geometrie: geometriePivot(s.geometrie),
      dateSource: s.observeeLe,
      attributs: {
        troncon_id: s.tronconId, etat: s.etat, revetement: s.revetement, praticabilite: s.praticabilite,
        valide_du: s.valideDu, valide_au: s.valideAu,
      },
    }),
  };
}

export function chargeBulletin(s: SnapshotBulletin): Construction<ChargeDepotBulletin> {
  return {
    ok: true,
    charge: {
      nomFichier: `${s.numero}.txt`,
      typeMime: "text/plain; charset=utf-8",
      contenu: s.texte,
      tailleOctets: Buffer.byteLength(s.texte, "utf8"),
      empreinteSha256: s.empreinteSha256,
      numeroBulletin: s.numero,
      jour: s.jour,
    },
  };
}

export function chargeFiche(s: SnapshotFiche): Construction<ChargeFicheIntervention> {
  if (s.statut !== "APPROUVE") {
    return { ok: false, motif: `fiche au statut ${s.statut} : seul APPROUVE est emis` };
  }
  return {
    ok: true,
    charge: {
      ficheId: s.id,
      versionFigee: s.versionFigee,
      statutGeoportail: "APPROUVE",
      identifiantsPatrimoniaux: s.identifiantsPatrimoniaux.map((i) => ({ typeObjet: i.typeObjet, identifiant: i.identifiant, codeEchange: i.codeEchange })),
      plageLineaire: s.plageLineaire ? { debutM: s.plageLineaire.debutM, finM: s.plageLineaire.finM } : null,
      traitement: { code: s.traitement.code, libelle: s.traitement.libelle },
      quantites: s.quantites.map((q) => ({ valeur: q.valeur, unite: q.unite })),
      coutEstime: { montantGnf: s.coutEstime.montantGnf, classePrecision: s.coutEstime.classePrecision },
      score: s.score,
      justification: s.justification,
      annee: s.annee,
      sourceFinancement: s.sourceFinancement,
    },
  };
}

/** Pour les tests de contrat : l'empreinte que la base verifie sur un bulletin. */
export function empreinteTexte(texte: string): string {
  return sha256Hex(texte);
}

/* ------------------------------ Barriere anti-fuite ------------------------------ */

/**
 * Cles qui ne doivent apparaitre dans AUCUNE charge. On teste les CLES (jamais les valeurs :
 * un nom de route peut legitimement contenir « note »). `empreinte*` et `*Sha256` sont permises,
 * ce sont des condensats de contenu et non des secrets.
 */
const CLES_INTERDITES =
  /(passw|passwd|motdepasse|secret|jeton|token|apikey|api_key|authorization|cookie|email|courriel|ipaddress|adresseip|userid|creepar|createdby|createdbyid|genereparid|constatepar|importeparid|deletedat|supprimele|clientoperationid|observations?|remarques?|commentaires?|notesinternes?|coutrehab|travauxaprevoir)/i;

/** Rend le chemin de la premiere cle interdite, ou null. */
export function trouverChampInterne(valeur: unknown, chemin = "$"): string | null {
  if (valeur === null || typeof valeur !== "object") return null;
  if (Array.isArray(valeur)) {
    for (let i = 0; i < valeur.length; i += 1) {
      const r = trouverChampInterne(valeur[i], `${chemin}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  for (const [k, v] of Object.entries(valeur as Record<string, unknown>)) {
    if (CLES_INTERDITES.test(k.replace(/[_\s-]/g, ""))) return `${chemin}.${k}`;
    const r = trouverChampInterne(v, `${chemin}.${k}`);
    if (r) return r;
  }
  return null;
}

/** Ce qui est emissible, pour chaque type de source : la route des sources vers un constructeur. */
export const SOURCES_AVEC_TABLE: readonly TypeSource[] = ["Troncon", "Ouvrage", "Portion", "BulletinRoutier"];
