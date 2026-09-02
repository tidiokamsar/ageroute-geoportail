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

/**
 * Libelles des filtres du panneau.
 *
 * Ils commencent par « Sur » a dessein. « Chemins et sentiers · 1102 » se lisait
 * comme « 1 102 chemins », et l'utilisateur cochait la case en attendant de voir
 * apparaitre des chemins. Cette couche ne dessine QUE des ouvrages de
 * franchissement ; la categorie qualifie la voie franchie, pas ce qui est affiche.
 */
export const LIBELLE_CATEGORIE: Record<CategorieVoie, string> = {
  CLASSE: "Sur réseau classé",
  AUTRE_ROUTE: "Sur autres voies carrossables",
  CHEMIN: "Sur chemins et sentiers",
};

/** Nom de la categorie seule, pour la fiche ou « Sur » n'a pas de sens. */
export const NOM_CATEGORIE: Record<CategorieVoie, string> = {
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


/** Une ligne de fait : libelle a gauche, valeur a droite. Meme forme que InfoRow
 *  du panneau de detail, pour que les deux fiches se lisent pareil. */
function Ligne({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-gray-500 shrink-0">{label}</span>
      <span className="text-[12px] font-medium text-navy text-right">{valeur}</span>
    </div>
  );
}

/**
 * Fiche d'un franchissement.
 *
 * La version precedente empilait les informations au fil, separees par des <br> :
 * l'intitule, la nature, le verdict et les mesures se lisaient d'un bloc, sans
 * qu'aucune hierarchie ne dise quoi regarder en premier. Le verdict — la seule
 * information qui appelle une decision — s'y noyait.
 *
 * Ici : l'objet en tete, le verdict en pastille coloree juste apres, les mesures
 * en lignes alignees, l'origine et l'action en pied.
 */
function FicheFranchissement({
  f, dejaAjoute, aInstruire, onCreerOuvrage,
}: {
  f: FranchissementPoint;
  dejaAjoute: boolean;
  aInstruire: boolean;
  onCreerOuvrage?: (f: FranchissementPoint) => void;
}) {
  const glyphe = f.franchissement === "Pont" ? "⌒" : f.franchissement === "Gué" ? "≈" : "∩";
  const couleur = dejaAjoute ? "#1a2942" : aInstruire ? "#b91c1c" : "#16a34a";
  const verdict = dejaAjoute
    ? "Ajouté à l'inventaire"
    : aInstruire
      ? "À instruire"
      : "Correspondance AGEROUTE";

  return (
    <div style={{ minWidth: 236 }}>
      <div className="flex items-start gap-2.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 bg-white text-[15px] font-bold leading-none"
          style={{ borderColor: couleur, color: couleur }}
          aria-hidden="true"
        >
          {glyphe}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-bold leading-tight text-navy">{nomPropose(f)}</p>
          <p className="text-[11px] leading-tight text-gray-500">
            {f.nature} · {f.region || "région inconnue"}
          </p>
        </div>
      </div>

      <div
        className="mt-2.5 rounded-md px-2 py-1.5"
        style={{ backgroundColor: `${couleur}14` }}
      >
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: couleur }}>
          {verdict}
        </p>
        {aInstruire && (
          <p className="text-[10.5px] leading-snug text-gray-600">
            Aucun ouvrage AGEROUTE à moins de 250 m.
          </p>
        )}
      </div>

      <div className="mt-2 border-t border-gray-100 pt-1">
        <Ligne label="Voie franchie" valeur={NOM_CATEGORIE[f.categorie]} />
        <Ligne label="Longueur du tracé" valeur={`${Math.round(f.longueurM)} m`} />
        <Ligne
          label="Ouvrage le plus proche"
          valeur={
            f.distanceM >= 1000
              ? `${(f.distanceM / 1000).toFixed(1)} km`
              : `${Math.round(f.distanceM)} m`
          }
        />
      </div>

      {f.categorie === "CHEMIN" && aInstruire && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[10.5px] leading-snug text-amber-800">
          Franchissement sur un chemin : son appartenance au patrimoine AGEROUTE
          n'est pas établie.
        </p>
      )}

      <p className="mt-2 border-t border-gray-100 pt-1.5 text-[10px] leading-snug text-gray-400">
        Source OpenStreetMap 2023, validée par AGEROUTE. Proposition — l'ajout crée un
        ouvrage tracé au journal d'audit.
      </p>

      {onCreerOuvrage && aInstruire && (
        <button
          onClick={() => onCreerOuvrage(f)}
          className="mt-2 w-full rounded-md bg-navy px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-navy2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy/50"
        >
          ＋ Ajouter à l'inventaire
        </button>
      )}
    </div>
  );
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
              <FicheFranchissement
                f={f}
                dejaAjoute={dejaAjoute}
                aInstruire={aInstruire}
                onCreerOuvrage={onCreerOuvrage}
              />
            </Popup>
          </Marker>
        );
      })}
    </MarkerClusterGroup>
  );
}
