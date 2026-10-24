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
  /** Précision maximale pour qu'un échantillon compte comme "fiable" (paramètre de campagne). */
  precisionFiableM: number;
}

export interface ProfilCompletude {
  /** Échantillons retenus, dont fiables (précision <= seuil de campagne). */
  echantillons: number;
  fiables: number;
  /** Longueur géodésique de la trace valide, en km — ce qui a été ENREGISTRÉ, pas parcouru. */
  traceKm: number;
  /** Durée utile hors pauses, et couverture par la trace (0..1) sur cette durée. */
  dureeUtileMin: number;
  couvertureTrace: number;
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

export function evaluerCompletude(e: EntreeCompletude): ProfilCompletude {
  const echantillons = e.echantillons.length;
  const fiables = e.echantillons.filter((s) => s.precisionM !== null && s.precisionM <= e.precisionFiableM).length;

  let traceM = 0;
  for (let i = 1; i < e.echantillons.length; i++) {
    const a = e.echantillons[i - 1], b = e.echantillons[i];
    // Un trou coupe la trace : deux points de part et d'autre ne sont jamais reliés.
    if (a.segment === b.segment) traceM += haversineM(a, b);
  }

  const finReelle = e.finMs ?? Date.now();
  const pausesMs = e.pauses.reduce((n, p) => n + Math.max(0, (p.finMs ?? finReelle) - p.debutMs), 0);
  const dureeUtileMs = Math.max(0, finReelle - e.debutMs - pausesMs);
  const dureeUtileMin = dureeUtileMs / 60_000;

  const interruptionsMs = e.interruptions.reduce(
    (n, i) => n + Math.max(0, (i.finMs ?? finReelle) - i.debutMs), 0,
  );

  const segments = new Set(e.echantillons.map((s) => s.segment));
  const segmentOuvert = e.interruptions.some((i) => i.finMs === null);

  // Couverture : vitesse moyenne sur la trace comparee a une reference de campagne
  // (60 km/h). Ce n'est pas une verite : c'est le ratio trace/duree, dit comme tel.
  const vitesseKmh = dureeUtileMin > 0 ? (traceM) / (dureeUtileMin / 60) : 0;
  const couvertureTrace = Math.max(0, Math.min(1, dureeUtileMin > 0 ? vitesseKmh / 60 : 0));

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
    couvertureTrace: Math.round(couvertureTrace * 100) / 100,
    trous: e.trous.length,
    trousMs: e.trous.reduce((n, t) => n + t.dureeMs, 0),
    interruptions: e.interruptions.length,
    interruptionsMs,
    segments: segments.size,
    segmentOuvert,
    avertissements,
  };
}
