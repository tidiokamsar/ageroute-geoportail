/**
 * Préparation, côté écran, de ce que l'API de télédétection reçoit (partie E). Le serveur et la base
 * restent juges ; ces fonctions disent AVANT l'envoi ce qui sera refusé, pour que l'erreur se lise
 * dans le formulaire plutôt que dans un message de serveur.
 */

export const NATURES = ["OPTIQUE", "RADAR", "ALTIMETRIE", "PRECIPITATIONS", "POPULATION", "INONDATION", "ROUTES_EXTRAITES"] as const;
export const TYPES = ["NOUVELLE_ROUTE", "COUPURE_PROBABLE", "VEGETATION", "INONDATION"] as const;
export type TypeProposition = (typeof TYPES)[number];

export interface Emprise { type: "Polygon"; coordinates: number[][][] }

/** Rectangle ouest / sud / est / nord en degrés → Polygon fermé, ou la raison du refus. */
export function empriseRectangle(ouest: number, sud: number, est: number, nord: number): Emprise | string {
  if (![ouest, sud, est, nord].every(Number.isFinite)) return "Les quatre bornes sont des nombres.";
  if (Math.abs(ouest) > 180 || Math.abs(est) > 180 || Math.abs(sud) > 90 || Math.abs(nord) > 90) return "Bornes hors du globe (longitude −180 à 180, latitude −90 à 90).";
  if (!(est > ouest) || !(nord > sud)) return "L'est doit être à droite de l'ouest, le nord au-dessus du sud.";
  return { type: "Polygon", coordinates: [[[ouest, sud], [est, sud], [est, nord], [ouest, nord], [ouest, sud]]] };
}

export interface PropositionLue { type: TypeProposition; geometrie: { type: string; coordinates: unknown }; score: number | null }
export interface LectureLot { propositions: PropositionLue[]; erreurs: string[] }

const estType = (t: unknown): t is TypeProposition => typeof t === "string" && (TYPES as readonly string[]).includes(t);

/**
 * Lit un GeoJSON (FeatureCollection, Feature ou géométrie seule). Le type de chaque proposition vient
 * de `properties.type`, à défaut du type par défaut choisi dans le formulaire ; le score de
 * `properties.score` (0 à 1), sinon aucun. Rien n'est deviné : une entité sans type exploitable est
 * une erreur nommée par son rang. Plafond de 5 000, celui de la route.
 */
export function lireLot(texte: string, typeParDefaut: TypeProposition | ""): LectureLot {
  let objet: unknown;
  try { objet = JSON.parse(texte); } catch { return { propositions: [], erreurs: ["Le texte n'est pas un JSON lisible."] }; }
  const o = objet as { type?: string; features?: unknown[]; geometry?: unknown; properties?: Record<string, unknown> };
  const entites: { geometry?: unknown; properties?: Record<string, unknown> }[] =
    o?.type === "FeatureCollection" ? (Array.isArray(o.features) ? (o.features as never[]) : [])
      : o?.type === "Feature" ? [o]
        : o && typeof o.type === "string" ? [{ geometry: o }] : [];
  if (entites.length === 0) return { propositions: [], erreurs: ["Aucune entité : attendu une FeatureCollection, une Feature ou une géométrie GeoJSON."] };
  if (entites.length > 5000) return { propositions: [], erreurs: [`${entites.length} entités : 5 000 au plus par lot.`] };
  const propositions: PropositionLue[] = [];
  const erreurs: string[] = [];
  entites.forEach((e, i) => {
    const g = e.geometry as { type?: unknown; coordinates?: unknown } | undefined;
    const type = e.properties?.type ?? typeParDefaut;
    const scoreBrut = e.properties?.score;
    if (!g || typeof g.type !== "string" || g.coordinates === undefined) { erreurs.push(`Entité ${i + 1} : géométrie absente.`); return; }
    if (!estType(type)) { erreurs.push(`Entité ${i + 1} : type absent ou inconnu (attendu ${TYPES.join(", ")}).`); return; }
    let score: number | null = null;
    if (scoreBrut !== undefined && scoreBrut !== null) {
      if (typeof scoreBrut !== "number" || scoreBrut < 0 || scoreBrut > 1) { erreurs.push(`Entité ${i + 1} : score hors de 0 à 1.`); return; }
      score = scoreBrut;
    }
    propositions.push({ type, geometrie: { type: g.type, coordinates: g.coordinates }, score });
  });
  return { propositions, erreurs };
}
