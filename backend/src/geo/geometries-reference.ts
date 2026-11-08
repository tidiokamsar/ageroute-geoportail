/**
 * Geometries de reference du metre en projection UTM (paragraphe 7.1, scenario A5).
 *
 * D'OU ELLES VIENNENT. Chaque geometrie est DEFINIE dans un plan UTM (28N ou 29N) avec des
 * coordonnees rondes : sa surface et sa longueur y sont donc connues exactement, sans calcul
 * (un carre de 100 m fait 10 000 m2). Ses coordonnees EPSG:4326 ont ete obtenues UNE FOIS par
 * PostGIS (`ST_Transform`, PROJ 7.2.1, conteneur `bdri-dev-db`, le 22/10/2026) a 10 decimales,
 * soit une precision de l'ordre du centieme de millimetre, puis figees ici.
 *
 * A QUOI ELLES SERVENT. Le meme jeu eprouve deux implementations independantes :
 *   - `utm.noyau.ts` (TypeScript, sans base) : `utm.noyau.test.ts`, executable partout, CI comprise ;
 *   - `metre_utm` (PostGIS) : `prisma/tests/metre_reference.test.sql`, genere depuis ce fichier.
 * Les deux doivent retrouver la valeur de definition au millionieme pres, et se rejoindre entre
 * elles. Un ecart dirait qu'une des deux projections est fausse.
 *
 * LES DEUX GEOMETRIES A CHEVAL SUR 12 DEG O sont le cas que le paragraphe 7.1 rend delicat : le
 * fuseau est choisi au point interieur. `A_CHEVAL_12W` a son point interieur a l'ouest (28N, la
 * surface de definition est retrouvee) ; `A_CHEVAL_12W_EST` a l'est (29N) : la surface est alors
 * calculee dans un autre plan que celui de definition, et l'ecart (1,3 / 10 000) est attendu.
 *
 * NE PAS MODIFIER A LA MAIN : regenerer, et dire pourquoi dans le commit.
 */

export interface GeometrieReference {
  code: string;
  epsgDefinition: number;
  surfaceDefinitionM2: number;
  longueurDefinitionM: number;
  postgis: { epsg: number; surfaceM2: number; longueurM: number };
  geometrie: { type: "Polygon"; coordinates: number[][][] } | { type: "LineString"; coordinates: number[][] };
}

export const GEOMETRIES_REFERENCE: readonly GeometrieReference[] = [
  {
    code: "CARRE_100M_28N",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 10000, longueurDefinitionM: 400,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32628, surfaceM2: 10000.000000011642, longueurM: 400.00000000023283 },
    geometrie: {"type":"Polygon","coordinates":[[[-13.7242540791,9.5869102373],[-13.7233429879,9.5869068823],[-13.7233396062,9.5878111357],[-13.7242506998,9.587814491],[-13.7242540791,9.5869102373]]]},
  },
  {
    code: "CARRE_1KM_29N",
    epsgDefinition: 32629,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 1e+06, longueurDefinitionM: 4000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32629, surfaceM2: 999999.9999997963, longueurM: 3999.9999999995925 },
    geometrie: {"type":"Polygon","coordinates":[[[-9.3014849384,10.403128307],[-9.2923491148,10.4031367703],[-9.2923575362,10.4121810008],[-9.3014936229,10.41217253],[-9.3014849384,10.403128307]]]},
  },
  {
    code: "TRIANGLE_28N",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 60000, longueurDefinitionM: 1200,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32628, surfaceM2: 60000.00000001164, longueurM: 1200.0000000000466 },
    geometrie: {"type":"Polygon","coordinates":[[[-14.0877300102,9.9498020361],[-14.0849934409,9.9497945604],[-14.0877199693,9.9534194148],[-14.0877300102,9.9498020361]]]},
  },
  {
    code: "TROUE_29N",
    epsgDefinition: 32629,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 37500, longueurDefinitionM: 1000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32629, surfaceM2: 37499.99999997963, longueurM: 999.9999999996508 },
    geometrie: {"type":"Polygon","coordinates":[[[-8.8176377855,9.7701044084],[-8.8158141698,9.7701034265],[-8.8158131749,9.7719123566],[-8.8176368005,9.7719133387],[-8.8176377855,9.7701044084]],[[-8.8169535589,9.7707823902],[-8.8169533117,9.7712346227],[-8.8164974062,9.7712343772],[-8.816497654,9.7707821447],[-8.8169535589,9.7707823902]]]},
  },
  {
    code: "L_CONCAVE_28N",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 50000, longueurDefinitionM: 1200,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32628, surfaceM2: 49999.99999991851, longueurM: 1199.9999999995343 },
    geometrie: {"type":"Polygon","coordinates":[[[-13.1704427673,10.8500436098],[-13.1676994053,10.8500272916],[-13.1676938983,10.8509312357],[-13.1695228113,10.8509421182],[-13.1695118069,10.8527500081],[-13.1704262696,10.8527554462],[-13.1704427673,10.8500436098]]]},
  },
  {
    code: "LIGNE_1KM_29N",
    epsgDefinition: 32629,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 0, longueurDefinitionM: 1000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32629, surfaceM2: 0, longueurM: 1000.0000000000582 },
    geometrie: {"type":"LineString","coordinates":[[-9,10.8554812216],[-8.990850594,10.8554810856]]},
  },
  {
    code: "LIGNE_BRISEE_28N",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 0, longueurDefinitionM: 1000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32628, surfaceM2: 0, longueurM: 1000 },
    geometrie: {"type":"LineString","coordinates":[[-13.6335068914,9.4961406111],[-13.6307600727,9.499746821],[-13.6307421025,9.5042679404]]},
  },
  {
    code: "A_CHEVAL_12W",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 6e+06, longueurDefinitionM: 14000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32628, surfaceM2: 6000000.0000006985, longueurM: 14000.000000000233 },
    geometrie: {"type":"Polygon","coordinates":[[[-12.0363630104,9.9379173741],[-11.9817016784,9.9374287003],[-11.9816187419,9.9464606792],[-12.0362815704,9.9469498058],[-12.0363630104,9.9379173741]]]},
  },
  {
    code: "A_CHEVAL_12W_EST",
    epsgDefinition: 32628,
    // Valeurs exactes dans le plan UTM de definition.
    surfaceDefinitionM2: 8e+06, longueurDefinitionM: 18000,
    // Ce que PostGIS (metre_utm, PROJ 7.2.1) rend sur les coordonnees ci-dessous.
    postgis: { epsg: 32629, surfaceM2: 7998955.170982177, longueurM: 17998.824514822965 },
    geometrie: {"type":"Polygon","coordinates":[[[-11.9999218084,9.9375925803],[-11.9270431954,9.9369311286],[-11.9269587627,9.9459626464],[-11.9998393707,9.946624711],[-11.9999218084,9.9375925803]]]},
  },
];
