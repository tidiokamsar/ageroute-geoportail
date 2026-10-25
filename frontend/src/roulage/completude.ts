/**
 * COMPLÉTUDE D'UN RELEVÉ (SMART FIELD, phase 5).
 *
 * CE QUE CE MODULE DIT ET CE QU'IL REFUSE DE DIRE
 *
 * Il sépare ce que le mandat distingue : la distance PARCOURUE (odométrie du véhicule,
 * inconnue de nous), la TRACE GPS VALIDE (ce qui a été réellement enregistré), les TROUS
 * et les INTERRUPTIONS (ce qui n'a pas été couvert). Il n'existe pas de "route inspectée"
 * parce qu'un GPS y est passé : le résultat est un PROFIL DE COUVERTURE daté, jamais un
 * verdict d'inspection.
 *
 * Noyau pur : aucune import du DOM, aucune unité inventée — les distances sont géodésiques
 * (haversine sur les échantillons retenus), les durées viennent de l'état.
 */

export interface EntreeCompletude {
  echantillons: ReadonlyArray<{ tMs: number; lat: number; lon: number; precisionM: number | null; segment: number }>;
  trous: ReadonlyArray<{ debutMs: number; finMs: number; dureeMs: number; coupeSegment: boolean }>;
  interruptions: ReadonlyArray<{ debutMs: number; finMs: number | null; cause: string }>;
  pauses: ReadonlyArray<{ debutMs: number; finMs: number | null }>;
  debutMs: number;
  finMs: number | null;
  /** « Maintenant », fourni par l'hôte : utilisé seulement si la session n'a pas de fin. Le noyau ne lit pas l'horloge globale. */
  maintenantMs: number;
  /** Précision maximale pour qu'un échantillon compte comme "fiable" (paramètre de campagne). */
  precisionFiableM: number;
}

export interface ProfilCompletude {
  /** Échantillons retenus, dont fiables (précision <= seuil de campagne). */
  echantillons: number;
  fiables: number;
  /** Longueur géodésique de la trace valide, en km — ce qui a été ENREGISTRÉ, pas parcouru. */
  traceKm: number;
  /** Durée utile hors pauses. */
  dureeUtileMin: number;
  /**
   * Part (0..1) de la durée utile pendant laquelle un signal exploitable était reçu : ni trou de signal, ni
   * interruption (veille, GNSS perdu, permission retirée, redémarrage). C'est un temps mesuré, pas un taux de
   * route couverte : la vitesse du véhicule n'y entre pas.
   */
  partTempsAvecSignal: number;
  trous: number;
  trousMs: number;
  interruptions: number;
  interruptionsMs: number;
  segments: number;
  segmentOuvert: boolean;
  /** Avertissements explicites — jamais un verdict d'inspection. */
  avertissements: string[];
}

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Intervalle = readonly [number, number];

/** Fusionne des intervalles qui se chevauchent : un trou et l'interruption qui l'a causé ne se comptent qu'une fois. */
function fusionner(intervalles: Intervalle[]): Intervalle[] {
  const tries = intervalles.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const sortie: [number, number][] = [];
  for (const [a, b] of tries) {
    const dernier = sortie[sortie.length - 1];
    if (dernier && a <= dernier[1]) dernier[1] = Math.max(dernier[1], b);
    else sortie.push([a, b]);
  }
  return sortie;
}

const longueur = (iv: Intervalle[]) => iv.reduce((n, [a, b]) => n + (b - a), 0);

function intersection(a: Intervalle[], b: Intervalle[]): Intervalle[] {
  const sortie: Intervalle[] = [];
  for (const [a0, a1] of a) for (const [b0, b1] of b) {
    const debut = Math.max(a0, b0), fin = Math.min(a1, b1);
    if (fin > debut) sortie.push([debut, fin]);
  }
  return sortie;
}

export function evaluerCompletude(e: EntreeCompletude): ProfilCompletude {
  const echantillons = e.echantillons.length;
  const fiables = e.echantillons.filter((s) => s.precisionM !== null && s.precisionM <= e.precisionFiableM).length;

  let traceM = 0;
  for (let i = 1; i < e.echantillons.length; i++) {
    const a = e.echantillons[i - 1], b = e.echantillons[i];
    // Un trou coupe la trace : deux points de part et d'autre ne sont jamais reliés.
    if (a.segment === b.segment) traceM += haversineM(a, b);
  }

  const finReelle = e.finMs ?? e.maintenantMs;
  const pausesMs = e.pauses.reduce((n, p) => n + Math.max(0, (p.finMs ?? finReelle) - p.debutMs), 0);
  const dureeUtileMs = Math.max(0, finReelle - e.debutMs - pausesMs);
  const dureeUtileMin = dureeUtileMs / 60_000;

  const interruptionsMs = e.interruptions.reduce(
    (n, i) => n + Math.max(0, (i.finMs ?? finReelle) - i.debutMs), 0,
  );

  const segments = new Set(e.echantillons.map((s) => s.segment));
  const segmentOuvert = e.interruptions.some((i) => i.finMs === null);

  // Temps sans signal : trous et interruptions, chevauchements comptes une fois, pauses exclues (une pause n'est pas une perte).
  const fenetre: Intervalle = [e.debutMs, finReelle];
  const sansSignal = intersection(fusionner([
    ...e.trous.map((t): Intervalle => [t.debutMs, t.finMs]),
    ...e.interruptions.map((i): Intervalle => [i.debutMs, i.finMs ?? finReelle]),
  ]), [fenetre]);
  const pauses = fusionner(e.pauses.map((p): Intervalle => [p.debutMs, p.finMs ?? finReelle]));
  const perduMs = longueur(sansSignal) - longueur(intersection(sansSignal, pauses));
  const partTempsAvecSignal = dureeUtileMs > 0 ? Math.max(0, Math.min(1, 1 - perduMs / dureeUtileMs)) : 0;

  const avertissements: string[] = [];
  if (echantillons < 2) avertissements.push("Moins de deux positions : pas de trace exploitable.");
  if (segmentOuvert) avertissements.push("L'enregistrement s'est arrêté pendant un trou de signal : l'intervalle est inconnu.");
  if (fiables < echantillons) avertissements.push(`${echantillons - fiables} position(s) hors précision de campagne (>${e.precisionFiableM} m).`);
  if (interruptionsMs > 0) avertissements.push(`${e.interruptions.length} interruption(s), ${(interruptionsMs / 60_000).toFixed(0)} min sans enregistrement.`);
  avertissements.push("Ceci est un profil de couverture : ce n'est pas un verdict d'inspection.");

  return {
    echantillons, fiables,
    traceKm: Math.round((traceM / 1000) * 100) / 100,
    dureeUtileMin: Math.round(dureeUtileMin * 10) / 10,
    partTempsAvecSignal: Math.round(partTempsAvecSignal * 100) / 100,
    trous: e.trous.length,
    trousMs: e.trous.reduce((n, t) => n + t.dureeMs, 0),
    interruptions: e.interruptions.length,
    interruptionsMs,
    segments: segments.size,
    segmentOuvert,
    avertissements,
  };
}
