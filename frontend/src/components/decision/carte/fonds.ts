/**
 * Fonds de plan de la carte de decision : LES MEMES fournisseurs que le geoportail (GeoportailPage.tsx, BASEMAPS), aucun fournisseur
 * ajoute (voir nginx.conf). `maxNativeZoom` n'est pas un detail : au-dela, Esri renvoie une tuile grise en HTTP 200 sans aucune erreur ;
 * Leaflet cesse de DEMANDER des tuiles et agrandit les dernieres, le fond devient flou plutot qu'absent.
 */
export const FONDS = {
  clair: {
    label: "Plan clair",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap",
    maxNativeZoom: 16,
  },
  osm: {
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap",
    maxNativeZoom: 19,
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri",
    maxNativeZoom: 18,
  },
} as const;

export type CleFond = keyof typeof FONDS;
export const FOND_PAR_DEFAUT: CleFond = "clair";
export const ZOOM_MAX = 20;
export const ZOOM_CADRAGE_MAX = 15;
