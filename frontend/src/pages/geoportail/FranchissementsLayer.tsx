import { useMemo } from "react";
import { Marker, Tooltip, Popup } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { franchissementIcon } from "./symbols";

/**
 * Franchissements OSM validés (D9) — représentation en symboles.
 *
 * Chaque franchissement devient un marqueur glyphe posé au milieu de son way :
 * ⌒ pont, ≈ gué, ∩ tunnel.
 *
 * CE QUE PORTE LA COULEUR
 *
 *   vert   correspondance : un ouvrage AGEROUTE existe à moins de 250 m
 *   rouge  à instruire : aucun ouvrage AGEROUTE à proximité
 *   navy   ajouté à l'inventaire pendant cette session
 *
 * POURQUOI UN FILTRE PAR CATEGORIE DE VOIE
 *
 * Le jeu compte 3 178 franchissements, et leur nature OSM n'est pas homogène :
 * 990 portent sur le réseau classé (voie rapide, primaire, secondaire, tertiaire),
 * 1 086 sur d'autres voies carrossables, et 1 102 sur des chemins, sentiers ou
 * voies piétonnes.
 *
 * Un pont sur un sentier n'est pas nécessairement un ouvrage du patrimoine
 * AGEROUTE. Les afficher tous sans distinction laisse croire à 3 178 ouvrages
 * manquants, alors que la question ne se pose vraiment que sur une partie d'entre
 * eux. Le filtre rend cette distinction visible au lieu de la laisser deviner.
 *
 * `onCreerOuvrage` (géoportail interne uniquement) : bouton « Ajouter à
 * l'inventaire » — création d'ouvrage auditée, UNE PAR UNE, jamais d'import de
 * masse (discipline D9, la leçon du lot RES-*).
 */

export type CategorieVoie = "CLASSE" | "AUTRE_ROUTE" | "CHEMIN";

export const LIBELLE_CATEGORIE: Record<CategorieVoie, string> = {
  CLASSE: "Réseau classé",
  AUTRE_ROUTE: "Autres voies carrossables",
  CHEMIN: "Chemins et sentiers",
};

/**
 * Classe une nature OSM dans l'une des trois catégories.
 *
 * Les libellés viennent du champ NATURE de l'extraction 2023 et sont en français.
 * Un libellé inconnu retombe sur CHEMIN, la catégorie la moins engageante : mieux
 * vaut qu'un franchissement non reconnu reste masqué par défaut que de le compter
 * dans le réseau classé.
 */
export function categorieVoie(nature: string): CategorieVoie {
  const n = nature.toLowerCase();
  if (/voie rapide|bretelle|primaire|secondaire|tertiaire/.test(n)) return "CLASSE";
  if (/non classifi|r[ée]sidentielle|acc[èe]s|construction/.test(n)) return "AUTRE_ROUTE";
  return "CHEMIN";
}

/** Mot juste selon la nature du franchissement — un gué n'est pas un pont. */
export function nomPropose(f: FranchissementPoint): string {
  const lieu = f.nom || f.numero || f.region || "";
  const base = f.franchissement || "Franchissement";
  return lieu ? `${base} ${lieu}` : `${base} ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`;
}

export interface FranchissementPoint {
  id: string;
  franchissement: string;
  nature: string;
  categorie: CategorieVoie;
  numero: string;
  nom: string;
  region: string;
  classement: string;
  longueurM: number;
  distanceM: number;
  lat: number;
  lon: number;
}

/** Milieu approximatif d'une géométrie (sommet médian) — position du symbole. */
export function milieuGeometrie(geom: Geometry): [number, number] | null {
  const lignes: number[][][] =
    geom.type === "LineString" ? [geom.coordinates as number[][]]
    : geom.type === "MultiLineString" ? (geom.coordinates as number[][][])
    : [];
  const tous = lignes.flat();
  if (tous.length === 0) return null;
  const c = tous[Math.floor(tous.length / 2)];
  return [c[1], c[0]];
}

export function pointsFranchissements(fc: FeatureCollection): FranchissementPoint[] {
  const out: FranchissementPoint[] = [];
  for (const f of fc.features as Feature<Geometry, NonNullable<unknown>>[]) {
    const p = f.properties as Record<string, unknown>;
    const pos = milieuGeometrie(f.geometry);
    if (!pos) continue;
    const nature = String(p.nature ?? "");
    out.push({
      // Le jeu ne porte pas d'identifiant : la position sert de clé. Elle est
      // stable pour un fichier donné, ce qui suffit pour l'affichage et pour
      // retenir ce qui a été ajouté pendant la session.
      id: String(p.id ?? `${pos[0]},${pos[1]}`),
      franchissement: String(p.franchissement ?? ""),
      nature,
      categorie: categorieVoie(nature),
      numero: String(p.numero ?? ""),
      nom: String(p.nom ?? ""),
      region: String(p.region ?? ""),
      classement: String(p.classement ?? ""),
      longueurM: Number(p.longueurM ?? 0),
      distanceM: Number(p.distanceM ?? 0),
      lat: pos[0],
      lon: pos[1],
    });
  }
  return out;
}

/** Compte par catégorie, pour afficher au panneau ce que chaque filtre recouvre. */
export function compterParCategorie(points: FranchissementPoint[]): Record<CategorieVoie, number> {
  const c: Record<CategorieVoie, number> = { CLASSE: 0, AUTRE_ROUTE: 0, CHEMIN: 0 };
  for (const p of points) c[p.categorie]++;
  return c;
}

export function FranchissementsLayer({
  data,
  categories,
  ajoutes,
  onCreerOuvrage,
}: {
  data: FeatureCollection;
  /** Catégories affichées. Absent = tout afficher (compatibilité). */
  categories?: Set<CategorieVoie>;
  /** Identifiants ajoutés à l'inventaire pendant cette session. */
  ajoutes?: Set<string>;
  onCreerOuvrage?: (f: FranchissementPoint) => void;
}) {
  const points = useMemo(() => pointsFranchissements(data), [data]);
  const visibles = useMemo(
    () => (categories ? points.filter((p) => categories.has(p.categorie)) : points),
    [points, categories]
  );

  const majeur = (f: FranchissementPoint) => f.categorie === "CLASSE";
  const sansOuvrage = (f: FranchissementPoint) => f.classement === "PONT_SANS_OUVRAGE";

  return (
    <MarkerClusterGroup chunkedLoading maxClusterRadius={60}>
      {visibles.map((f) => {
        const dejaAjoute = ajoutes?.has(f.id) ?? false;
        const aInstruire = sansOuvrage(f) && !dejaAjoute;
        return (
          <Marker
            key={f.id}
            position={[f.lat, f.lon]}
            icon={franchissementIcon(f.franchissement, aInstruire, majeur(f), dejaAjoute)}
          >
            <Tooltip>
              {nomPropose(f)} ({f.nature})
            </Tooltip>
            <Popup>
              <div className="text-xs" style={{ minWidth: 210 }}>
                <b>{nomPropose(f)}</b>
                <br />
                {f.nature} — {LIBELLE_CATEGORIE[f.categorie]}
                <br />
                Région {f.region || "?"}
                <br />
                Verdict :{" "}
                <b>
                  {dejaAjoute
                    ? "ajouté à l'inventaire"
                    : aInstruire
                      ? "à instruire (aucun ouvrage AGEROUTE à 250 m)"
                      : "correspondance AGEROUTE"}
                </b>
                <br />
                way {Math.round(f.longueurM)} m · ouvrage le plus proche :{" "}
                {Math.round(f.distanceM)} m
                <br />
                <span style={{ color: "#6b7280" }}>
                  Source OpenStreetMap 2023 — validé par AGEROUTE
                </span>
                {f.categorie === "CHEMIN" && aInstruire && (
                  <>
                    <br />
                    <span style={{ color: "#b45309" }}>
                      Franchissement sur un chemin : son appartenance au patrimoine
                      AGEROUTE n'est pas établie.
                    </span>
                  </>
                )}
                {onCreerOuvrage && aInstruire && (
                  <>
                    <br />
                    <button
                      onClick={() => onCreerOuvrage(f)}
                      style={{
                        marginTop: 6,
                        padding: "4px 10px",
                        borderRadius: 6,
                        border: "1px solid #1a2942",
                        background: "#1a2942",
                        color: "#fff",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      ＋ Ajouter à l'inventaire
                    </button>
                  </>
                )}
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MarkerClusterGroup>
  );
}
