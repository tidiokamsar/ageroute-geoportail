/** Utilitaires de l'ecran « Releve en vehicule » (paragraphe 7.13) : types de la reponse et mise en forme. */

export interface PassageAnalyse {
  tronconId: string;
  code: string;
  nom: string | null;
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
  deM: number | null;
  aM: number | null;
  longueurM: number | null;
  sens: "CROISSANT" | "DECROISSANT" | "INDETERMINE";
  court: boolean;
  geojson: { type: string; coordinates: unknown } | null;
}

export interface SuiteHorsReferentiel {
  indexDebut: number;
  indexFin: number;
  nombrePoints: number;
  longueurM: number;
  coordonnees: [number, number][];
}

export interface AnalyseTrace {
  parametres: { reseau: "reference" | "tout"; distanceMaxM: number; pasMinM: number; incertitudeParDefautM: number; pointsMax: number };
  indicateurs: {
    pointsLus: number;
    pointsIgnores: number;
    pointsRetenus: number;
    retiresParPas: number;
    pointsRattaches: number;
    tauxRattachement: number;
    pointsPrecisionInsuffisante: number;
    transitionsNonVerifiees: number;
    chaines: number;
    distanceParcourueM: number;
    dureeS: number | null;
    vitesseMoyenneKmH: number | null;
    longueurSurReseauM: number;
  };
  passages: PassageAnalyse[];
  horsReferentiel: SuiteHorsReferentiel[];
  trace: [number, number][];
  rattache: boolean[];
  avertissements: string[];
}

export type FormatTrace = "gpx" | "csv";

/** Format deduit de l'extension du fichier, ou null s'il faut le demander. */
export function detecterFormat(nomFichier: string): FormatTrace | null {
  const n = nomFichier.trim().toLowerCase();
  if (n.endsWith(".gpx")) return "gpx";
  if (n.endsWith(".csv") || n.endsWith(".txt")) return "csv";
  return null;
}

/** Taille maximale acceptee cote client : un peu sous la limite du serveur, pour refuser tot et clairement. */
export const TAILLE_MAX_OCTETS = 4_400_000;

/**
 * Lit un fichier en texte. FileReader plutot que `File.text()` : il est pris en charge par tous les
 * navigateurs de terrain, y compris les anciens Android, et par l'environnement de test.
 */
export function lireTexte(fichier: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result ?? ""));
    lecteur.onerror = () => reject(lecteur.error ?? new Error("lecture impossible"));
    lecteur.readAsText(fichier);
  });
}

export function libelleDuree(s: number | null): string {
  if (s === null) return "non calculable";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

export function libelleKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 100_000 ? 0 : 1).replace(".", ",")} km` : `${Math.round(m)} m`;
}

export function libellePourcent(taux: number): string {
  return `${Math.round(taux * 100)} %`;
}

export interface Fragment {
  /** Points en [lat, lon], l'ordre attendu par Leaflet. */
  points: [number, number][];
  rattache: boolean;
}

/**
 * Decoupe la trace en fragments de meme statut (rattache au reseau ou non), pour la dessiner en deux
 * couleurs. Deux fragments consecutifs partagent leur point de jonction : sans cela, un trou d'un
 * segment apparaitrait a chaque changement de statut.
 */
export function decouperEnFragments(trace: readonly [number, number][], rattache: readonly boolean[]): Fragment[] {
  const n = Math.min(trace.length, rattache.length);
  const fragments: Fragment[] = [];
  let courant: Fragment | null = null;
  for (let i = 0; i < n; i += 1) {
    const [lon, lat] = trace[i];
    if (courant && courant.rattache === rattache[i]) {
      courant.points.push([lat, lon]);
      continue;
    }
    const precedent: [number, number] | null = courant ? courant.points[courant.points.length - 1] : null;
    courant = { points: precedent ? [precedent, [lat, lon]] : [[lat, lon]], rattache: rattache[i] };
    fragments.push(courant);
  }
  return fragments.filter((f) => f.points.length >= 2);
}

/** Nom de fichier du resultat telecharge : jamais de donnee personnelle, seulement la date. */
export function nomFichierResultat(date: Date = new Date()): string {
  return `analyse-trace-${date.toISOString().slice(0, 10)}.json`;
}
