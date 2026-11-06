// Fixtures SYNTHETIQUES des bancs de conflits (lot RC-3) : un plan d'axes et des reseaux inventes, construits en metres dans le repere UTM 29N puis
// transformes en WGS 84 par PostGIS. Aucune donnee reelle (ni operateur, ni plan de l'entreprise).
//
//   axe A  : (0,0)-(200,0)       axe B : (200,0)-(200,150)   (carrefour en (200,0))      chaussee 7 m (demi 3,5), emprise 15 m (demi 7,5)
//   reseau 1 (classe B, precision declaree 3,5 m) :
//        L2   a 2 m de l'axe A sur 60 m (en chaussee)        L6 a 6 m sur 60 m (en emprise hors chaussee)       L9 a 9 m sur 60 m (hors emprise)
//        L2 bis / L2 ter : meme trace que L2 (sens inverse compris)
//        P    perpendiculaire a l'axe A en x=150 (40 m, croise l'axe une fois)
//        K    a 5 m du carrefour, parallele a l'axe A, de x=195 a 205 (croise l'axe B une fois)
//   reseau 2 (classe inconnue) : W a 2 m de l'axe A, de l'autre cote (60 m)
//   reseau 3 (classe A) : Z loin de tout axe (a 100 m au sud de l'axe A, y = -100) : aucun conflit
export const O = { x: 380000, y: 1015000 };

export type Ligne = { nom: string; coords: [number, number][]; props?: Record<string, unknown> };

export const AXES: Ligne[] = [
  { nom: "Axe A", coords: [[0, 0], [200, 0]] },
  { nom: "Axe B", coords: [[200, 0], [200, 150]] },
];
export const R1_BASE: Ligne[] = [
  { nom: "Fibre-Marqueur L2", coords: [[20, 2], [80, 2]], props: { circuit: "C1", brins: 12 } },
  { nom: "Fibre-Marqueur L6", coords: [[20, 6], [80, 6]], props: { circuit: "C2" } },
  { nom: "Fibre-Marqueur L9", coords: [[20, 9], [80, 9]], props: { circuit: "C3" } },
  { nom: "Fibre-Marqueur L2 bis", coords: [[20, 2], [80, 2]], props: { circuit: "C4" } },
  { nom: "Fibre-Marqueur L2 ter", coords: [[80, 2], [20, 2]], props: { circuit: "C5" } },
  { nom: "Fibre-Marqueur P", coords: [[150, -20], [150, 20]], props: { circuit: "C6" } },
  { nom: "Fibre-Marqueur K", coords: [[195, 5], [205, 5]], props: { circuit: "C7" } },
];
export const R2: Ligne[] = [{ nom: "Eau-Marqueur W", coords: [[20, -2], [80, -2]] }];
export const R3: Ligne[] = [{ nom: "Gaz-Marqueur Z", coords: [[20, -100], [80, -100]] }];

/** Constructeurs de fichiers a partir de coordonnees locales (metres) : `wgs` est fourni par le banc (PostGIS). */
export function constructeurs(wgs: (pts: [number, number][]) => Promise<[number, number][]>) {
  return {
    async geojson(lignes: Ligne[]): Promise<Buffer> {
      const features = [];
      for (const l of lignes) features.push({ type: "Feature", properties: { name: l.nom, ...(l.props ?? {}) }, geometry: { type: "LineString", coordinates: await wgs(l.coords) } });
      return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
    },
    async kml(lignes: Ligne[]): Promise<Buffer> {
      let corps = "";
      for (const l of lignes) {
        const c = (await wgs(l.coords)).map(([lo, la]) => `${lo},${la},0`).join(" ");
        corps += `<Placemark><name>${l.nom}</name><LineString><coordinates>${c}</coordinates></LineString></Placemark>`;
      }
      return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`);
    },
  };
}
