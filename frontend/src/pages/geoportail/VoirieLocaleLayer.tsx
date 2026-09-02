import { useEffect, useMemo, useState } from "react";
import { Polyline, Tooltip, useMapEvents } from "react-leaflet";
import { api } from "../../lib/api";

/**
 * Voirie locale — les tracés eux-mêmes, chargés selon la vue.
 *
 * POURQUOI PAS TOUT D'UN COUP
 *
 * La couche compte 262 656 objets et 5,8 millions de sommets. Mesure sur la carte
 * publique : 22,8 octets par sommet en GeoJSON. La servir entière représenterait
 * 41 Mo gzippés — quarante-sept fois ce que l'application transporte aujourd'hui.
 *
 * Mais cadrée, elle est légère : Conakry entière pèse 263 Ko, moins que la carte
 * publique actuelle. Une commune, 35 Ko. Un quartier, 2 Ko.
 *
 * D'où ce fonctionnement : rien en dessous du seuil de zoom, puis une requête par
 * emprise à chaque déplacement. Le serveur simplifie la géométrie selon l'échelle
 * et refuse les emprises trop larges — le client n'est pas la seule protection.
 *
 * LE REGISTRE VISUEL
 *
 * Traits gris fins, hiérarchisés par épaisseur, jamais la palette d'état du réseau
 * AGEROUTE. Une voie locale n'a pas d'état de chaussée relevé : lui donner la même
 * échelle de couleur ferait lire un sentier comme une route en mauvais état.
 */

/** En dessous, la couche ne se charge pas : l'emprise serait trop large. */
export const ZOOM_MINIMUM = 12;

export type CategorieVoirie =
  | "VOIE_RAPIDE" | "PRINCIPALE" | "SECONDAIRE" | "TERTIAIRE"
  | "VOIE_LOCALE" | "RESIDENTIELLE" | "ACCES"
  | "CHEMIN" | "SENTIER" | "PIETON" | "INCONNU";

export interface VoieLocale {
  id: string;
  nature: string;
  nom: string | null;
  reference: string | null;
  categorie: CategorieVoirie;
  statut: string;
  source: string;
  sourceId: string;
  sourceDate: string | null;
  longueurKm: number;
  region: string | null;
  regionMethode: string | null;
  geometry: string;
}

export interface ReponseVoirie {
  tronque: boolean;
  plafond: number;
  simplifieeDe: number;
  voies: VoieLocale[];
}

/**
 * Épaisseur et teinte par catégorie.
 *
 * Registre délibérément gris : le réseau AGEROUTE occupe seul la couleur, qui y
 * porte l'état de la chaussée. La hiérarchie se lit ici à l'épaisseur.
 */
const STYLE: Record<CategorieVoirie, { poids: number; couleur: string; opacite: number }> = {
  VOIE_RAPIDE:   { poids: 3.0, couleur: "#6b7280", opacite: 0.85 },
  PRINCIPALE:    { poids: 2.6, couleur: "#6b7280", opacite: 0.8 },
  SECONDAIRE:    { poids: 2.2, couleur: "#7c8493", opacite: 0.75 },
  TERTIAIRE:     { poids: 1.8, couleur: "#8b929e", opacite: 0.7 },
  VOIE_LOCALE:   { poids: 1.4, couleur: "#9aa0aa", opacite: 0.65 },
  RESIDENTIELLE: { poids: 1.2, couleur: "#a5abb4", opacite: 0.6 },
  ACCES:         { poids: 1.0, couleur: "#b0b5bd", opacite: 0.55 },
  CHEMIN:        { poids: 1.0, couleur: "#b8a48f", opacite: 0.6 },
  SENTIER:       { poids: 0.8, couleur: "#c2b09c", opacite: 0.5 },
  PIETON:        { poids: 0.8, couleur: "#c9bfb2", opacite: 0.45 },
  INCONNU:       { poids: 0.8, couleur: "#c4c7cc", opacite: 0.4 },
};

export const LIBELLE_VOIRIE: Record<CategorieVoirie, string> = {
  VOIE_RAPIDE: "Voies rapides",
  PRINCIPALE: "Routes principales",
  SECONDAIRE: "Routes secondaires",
  TERTIAIRE: "Routes tertiaires",
  VOIE_LOCALE: "Voies locales",
  RESIDENTIELLE: "Voies résidentielles",
  ACCES: "Dessertes et accès",
  CHEMIN: "Chemins",
  SENTIER: "Sentiers",
  PIETON: "Voies piétonnes",
  INCONNU: "Non qualifiées",
};

/** GeoJSON rend [lon, lat] ; Leaflet attend [lat, lon]. */
function versLatLng(geometry: string): [number, number][] {
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

export function VoirieLocaleLayer({
  categories,
  onChargement,
}: {
  categories: Set<CategorieVoirie>;
  /** Remonte l'état au panneau : zoom insuffisant, comptes, troncature. */
  onChargement?: (etat: {
    zoomSuffisant: boolean;
    chargement: boolean;
    voies: number;
    tronque: boolean;
    erreur: string | null;
  }) => void;
}) {
  const [voies, setVoies] = useState<VoieLocale[]>([]);
  const [tronque, setTronque] = useState(false);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [vue, setVue] = useState<{ zoom: number; bbox: string } | null>(null);

  const carte = useMapEvents({
    moveend: () => majVue(),
    zoomend: () => majVue(),
  });

  function majVue() {
    const b = carte.getBounds();
    setVue({
      zoom: carte.getZoom(),
      // Quatre décimales ≈ 11 m : assez fin pour cadrer, assez grossier pour que
      // de menus déplacements ne relancent pas la requête.
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        .map((v) => v.toFixed(4))
        .join(","),
    });
  }

  // Première vue : useMapEvents ne se déclenche qu'au mouvement.
  useEffect(() => { majVue(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const listeCategories = useMemo(() => [...categories].sort().join(","), [categories]);
  const zoomSuffisant = (vue?.zoom ?? 0) >= ZOOM_MINIMUM;

  useEffect(() => {
    if (!vue || !zoomSuffisant || categories.size === 0) {
      setVoies([]);
      setTronque(false);
      setErreur(null);
      return;
    }
    let annule = false;
    setChargement(true);
    setErreur(null);
    api
      .get<ReponseVoirie>("/voirie-locale/geo", {
        params: { bbox: vue.bbox, categories: listeCategories },
      })
      .then(({ data }) => {
        if (annule) return;
        setVoies(data.voies);
        setTronque(data.tronque);
      })
      .catch((e) => {
        if (annule) return;
        setVoies([]);
        // Le serveur refuse les emprises trop larges avec un message explicite :
        // on le montre plutôt qu'un échec muet.
        setErreur(e?.response?.data?.message ?? "Chargement de la voirie impossible");
      })
      .finally(() => { if (!annule) setChargement(false); });
    return () => { annule = true; };
  }, [vue?.bbox, zoomSuffisant, listeCategories, categories.size]);

  useEffect(() => {
    onChargement?.({ zoomSuffisant, chargement, voies: voies.length, tronque, erreur });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [zoomSuffisant, chargement, voies.length, tronque, erreur]);

  if (!zoomSuffisant) return null;

  return (
    <>
      {voies.map((v) => {
        const pts = versLatLng(v.geometry);
        if (pts.length < 2) return null;
        const s = STYLE[v.categorie] ?? STYLE.INCONNU;
        return (
          <Polyline
            key={v.id}
            positions={pts}
            pathOptions={{ color: s.couleur, weight: s.poids, opacity: s.opacite }}
          >
            <Tooltip sticky>
              <span className="text-[11px]">
                <strong>{v.nom ?? v.reference ?? "Voie sans nom"}</strong>
                <br />
                {v.nature} · {v.longueurKm < 1
                  ? `${Math.round(v.longueurKm * 1000)} m`
                  : `${v.longueurKm.toFixed(1)} km`}
                <br />
                <span style={{ color: "#6b7280" }}>Source {v.source} — donnée externe</span>
              </span>
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}
