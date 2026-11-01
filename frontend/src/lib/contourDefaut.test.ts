import { describe, expect, it } from "vitest";
import {
  AGE_MAX_POSITION_MS, PRECISION_MAX_SOMMET_M, SOMMETS_MAX,
  evaluerSommet, lireMesureServeur, lireRefusServeur, mesuresRequisesAvecContour, usageDuContour, validerContour,
  type PositionCourante, type SommetContour,
} from "./contourDefaut";

/**
 * Ce que ces tests defendent : un sommet n'est pose que si la position est presente, recente, assez precise, nouvelle,
 * et qu'elle ne fait pas croiser le contour ; un contour n'est ferme qu'avec trois sommets distincts, une surface non
 * nulle et sans auto-intersection ; l'emprise produite est un Polygon GeoJSON ferme en sens anti-horaire ;
 * et le module ne produit AUCUNE surface (celle du serveur est la seule officielle).
 * Les coordonnees sont celles d'un carrefour de Conakry choisi pour l'essai ; les « metres » sont des decalages locaux.
 */

const LAT0 = 9.64;
const LON0 = -13.6;
const M_LAT = 1 / 111_320;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const MAINTENANT = 1_790_000_000_000;

/** Un sommet a (dx, dy) metres du point d'essai, precision annoncee `p` metres. */
const s = (dx: number, dy: number, p = 4): SommetContour => ({ lat: LAT0 + dy * M_LAT, lon: LON0 + dx * M_LON, precisionM: p, poseLe: MAINTENANT });
const pos = (dx: number, dy: number, p = 4, ageMs = 1000): PositionCourante => ({ lat: LAT0 + dy * M_LAT, lon: LON0 + dx * M_LON, precisionM: p, releveeLe: MAINTENANT - ageMs });

const CARRE = [s(0, 0), s(10, 0), s(10, 10), s(0, 10)];

/** Aire signee en degres carres, pour le SEUL sens de l'anneau : le signe, rien d'autre. */
const sensAnneau = (anneau: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < anneau.length - 1; i += 1) a += anneau[i][0] * anneau[i + 1][1] - anneau[i + 1][0] * anneau[i][1];
  return Math.sign(a);
};

describe("evaluerSommet : ce qui est refuse, et pourquoi", () => {
  it("accepte une position recente, assez precise, nouvelle, et rend le sommet arrondi a 7 decimales", () => {
    const d = evaluerSommet(pos(0, 0), [], MAINTENANT);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.sommet.precisionM).toBe(4);
      expect(d.sommet.poseLe).toBe(MAINTENANT);
      expect(Math.abs(d.sommet.lat * 1e7 - Math.round(d.sommet.lat * 1e7))).toBeLessThan(1e-3);
    }
  });

  it("refuse sans position, avec des coordonnees invalides, ou une position PERIMEE (signal perdu)", () => {
    expect(evaluerSommet(null, [], MAINTENANT)).toMatchObject({ ok: false, motif: "AUCUNE_POSITION" });
    expect(evaluerSommet({ ...pos(0, 0), lat: 91 }, [], MAINTENANT)).toMatchObject({ ok: false, motif: "COORDONNEES_INVALIDES" });
    expect(evaluerSommet({ ...pos(0, 0), lon: Number.NaN }, [], MAINTENANT)).toMatchObject({ ok: false, motif: "COORDONNEES_INVALIDES" });
    expect(evaluerSommet(pos(0, 0, 4, AGE_MAX_POSITION_MS + 1), [], MAINTENANT)).toMatchObject({ ok: false, motif: "POSITION_PERIMEE" });
    expect(evaluerSommet(pos(0, 0, 4, AGE_MAX_POSITION_MS), [], MAINTENANT).ok).toBe(true);
  });

  it("refuse une precision au-dessus du seuil, ou inconnue, en disant le seuil ; accepte pile au seuil", () => {
    const refus = evaluerSommet(pos(0, 0, PRECISION_MAX_SOMMET_M + 0.5), [], MAINTENANT);
    expect(refus).toMatchObject({ ok: false, motif: "PRECISION_INSUFFISANTE" });
    if (!refus.ok) expect(refus.message).toContain(`${PRECISION_MAX_SOMMET_M} m`);
    expect(evaluerSommet({ ...pos(0, 0), precisionM: Number.NaN }, [], MAINTENANT)).toMatchObject({ ok: false, motif: "PRECISION_INSUFFISANTE" });
    expect(evaluerSommet(pos(0, 0, PRECISION_MAX_SOMMET_M), [], MAINTENANT).ok).toBe(true);
    // le seuil se parametre, et c'est ce seuil qui decide
    expect(evaluerSommet(pos(0, 0, 3), [], MAINTENANT, { precisionMaxM: 2 })).toMatchObject({ ok: false, motif: "PRECISION_INSUFFISANTE" });
  });

  it("refuse la meme position que le sommet precedent, mais pas une position voisine", () => {
    expect(evaluerSommet(pos(0, 0), [s(0, 0)], MAINTENANT)).toMatchObject({ ok: false, motif: "MEME_POSITION" });
    expect(evaluerSommet(pos(0.5, 0), [s(0, 0)], MAINTENANT).ok).toBe(true);
  });

  it("refuse un sommet qui ferait CROISER le contour deja pose (noeud papillon)", () => {
    // (0,0) -> (10,10) -> (10,0) puis (0,10) : la derniere arete coupe la premiere.
    const d = evaluerSommet(pos(0, 10), [s(0, 0), s(10, 10), s(10, 0)], MAINTENANT);
    expect(d).toMatchObject({ ok: false, motif: "CROISE_LE_CONTOUR" });
  });

  it("refuse un sommet qui TOUCHE le contour (retour sur le premier sommet : il faut fermer, pas reposer)", () => {
    expect(evaluerSommet(pos(0, 0), [s(0, 0), s(10, 0), s(10, 10), s(0, 10)], MAINTENANT)).toMatchObject({ ok: false, motif: "CROISE_LE_CONTOUR" });
  });

  it("accepte un tour concave sans croisement, et deux premiers sommets sans rien a croiser", () => {
    expect(evaluerSommet(pos(10, 0), [s(0, 0)], MAINTENANT).ok).toBe(true);
    expect(evaluerSommet(pos(10, 10), [s(0, 0), s(10, 0)], MAINTENANT).ok).toBe(true);
    // forme en L, tous les sommets poses a la suite
    const L = [s(0, 0), s(20, 0), s(20, 10), s(10, 10)];
    expect(evaluerSommet(pos(10, 20), L, MAINTENANT).ok).toBe(true);
  });

  it("plafonne le nombre de sommets", () => {
    const beaucoup = Array.from({ length: SOMMETS_MAX }, (_, i) => s(i * 0.5, 0));
    expect(evaluerSommet(pos(1000, 1000), beaucoup, MAINTENANT)).toMatchObject({ ok: false, motif: "TROP_DE_SOMMETS" });
  });
});

describe("validerContour : ce qui ferme un contour", () => {
  it("un carre valide donne un Polygon GeoJSON ferme, longitude puis latitude, en sens anti-horaire", () => {
    const r = validerContour(CARRE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.emprise.type).toBe("Polygon");
    const anneau = r.emprise.coordinates[0];
    expect(anneau).toHaveLength(5);
    expect(anneau[0]).toEqual(anneau[4]);
    expect(anneau[0][0]).toBeCloseTo(LON0, 6);
    expect(anneau[0][1]).toBeCloseTo(LAT0, 6);
    expect(sensAnneau(anneau)).toBe(1);
    expect(r.sommets).toBe(4);
  });

  it("un contour pose dans le sens horaire est retourne : le sens de l'anneau ne depend pas de l'agent", () => {
    const horaire = [...CARRE].reverse();
    const r = validerContour(horaire);
    expect(r.ok && sensAnneau(r.emprise.coordinates[0])).toBe(1);
  });

  it("refuse moins de trois sommets DISTINCTS : trois poses dont deux confondus n'en font que deux", () => {
    expect(validerContour([s(0, 0), s(10, 0)])).toMatchObject({ ok: false, motif: "TROP_PEU_DE_SOMMETS" });
    expect(validerContour([s(0, 0), s(10, 0), s(0, 0)])).toMatchObject({ ok: false, motif: "TROP_PEU_DE_SOMMETS" });
    expect(validerContour([])).toMatchObject({ ok: false, motif: "TROP_PEU_DE_SOMMETS" });
  });

  it("refuse des sommets alignes : aucune surface, et ne la fabrique pas", () => {
    expect(validerContour([s(0, 0), s(10, 0), s(20, 0)])).toMatchObject({ ok: false, motif: "SURFACE_NULLE" });
    expect(validerContour([s(0, 0), s(5, 5), s(10, 10), s(20, 20)])).toMatchObject({ ok: false, motif: "SURFACE_NULLE" });
  });

  it("refuse un contour qui se croise (noeud papillon) en nommant les cotes", () => {
    const r = validerContour([s(0, 0), s(10, 10), s(10, 0), s(0, 10)]);
    expect(r).toMatchObject({ ok: false, motif: "AUTO_INTERSECTION" });
    if (!r.ok) expect(r.message).toMatch(/côtés 1 et 3/);
  });

  it("refuse un demi-tour sur place (un cote qui recouvre le precedent)", () => {
    expect(validerContour([s(0, 0), s(10, 0), s(10, 10), s(10, 5)])).toMatchObject({ ok: false, motif: "AUTO_INTERSECTION" });
  });

  it("refuse la fermeture qui croiserait un cote (la fermeture compte comme un cote)", () => {
    // 5 sommets dont la fermeture (dernier -> premier) coupe le troisieme cote
    expect(validerContour([s(0, 0), s(10, 0), s(10, 10), s(-5, 5), s(5, -5)])).toMatchObject({ ok: false, motif: "AUTO_INTERSECTION" });
    // aucune arete posee n'en croise une autre (chaque sommet est accepte a la pose) ; seul le retour sur le premier sommet croise
    const sommets = [s(0, 0), s(10, 0), s(10, 10), s(20, 10)];
    sommets.forEach((_, i) => expect(evaluerSommet(pos(...([[0, 0], [10, 0], [10, 10], [20, 10]][i] as [number, number])), sommets.slice(0, i), MAINTENANT).ok).toBe(true));
    expect(validerContour(sommets)).toMatchObject({ ok: false, motif: "AUTO_INTERSECTION" });
  });

  it("accepte une forme concave (L) et un triangle", () => {
    expect(validerContour([s(0, 0), s(20, 0), s(20, 10), s(10, 10), s(10, 20), s(0, 20)]).ok).toBe(true);
    expect(validerContour([s(0, 0), s(10, 0), s(5, 8)]).ok).toBe(true);
  });

  it("refuse des coordonnees hors de l'etendue WGS 84", () => {
    expect(validerContour([s(0, 0), s(10, 0), { ...s(5, 8), lat: 95 }])).toMatchObject({ ok: false, motif: "COORDONNEES_INVALIDES" });
  });

  it("avertit quand le contour est plus petit que l'incertitude du GPS, sans le refuser", () => {
    const petit = validerContour([s(0, 0, 8), s(1, 0, 8), s(1, 1, 8), s(0, 1, 8)]);
    expect(petit.ok).toBe(true);
    if (petit.ok) {
      expect(petit.precisionPireM).toBe(8);
      expect(petit.avertissements[0]).toMatch(/n'est pas significative/);
    }
    const grand = validerContour(CARRE);
    expect(grand.ok && grand.avertissements).toEqual([]);
  });

  it("NE PRODUIT AUCUNE SURFACE : le resultat ne porte que l'emprise, le nombre de sommets, la precision et les avertissements", () => {
    const r = validerContour(CARRE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r).sort()).toEqual(["avertissements", "emprise", "ok", "precisionPireM", "sommets"]);
    expect(Object.keys(r.emprise).sort()).toEqual(["coordinates", "type"]);
    expect(JSON.stringify(r)).not.toMatch(/surface|aire|m2/i);
  });
});

describe("ce que le contour change a la saisie (meme regle que le serveur)", () => {
  it("pour m2 et m3, le contour couvre LONGUEUR et LARGEUR ; profondeur et nombre restent exigees", () => {
    expect(mesuresRequisesAvecContour("METRE_CARRE", ["LONGUEUR", "LARGEUR"], true)).toEqual([]);
    expect(mesuresRequisesAvecContour("METRE_CUBE", ["LONGUEUR", "LARGEUR", "PROFONDEUR"], true)).toEqual(["PROFONDEUR"]);
  });

  it("sans contour ferme, ou pour un metre lineaire ou une unite, rien n'est retire", () => {
    expect(mesuresRequisesAvecContour("METRE_CARRE", ["LONGUEUR", "LARGEUR"], false)).toEqual(["LONGUEUR", "LARGEUR"]);
    expect(mesuresRequisesAvecContour("METRE", ["LONGUEUR"], true)).toEqual(["LONGUEUR"]);
    expect(mesuresRequisesAvecContour("UNITE", ["NOMBRE"], true)).toEqual(["NOMBRE"]);
  });

  it("dit a quoi sert le contour selon l'unite, sans promettre une quantite qu'il ne donne pas", () => {
    expect(usageDuContour("METRE_CARRE")).toMatch(/surface du contour, mesurée par le serveur/);
    expect(usageDuContour("METRE_CUBE")).toMatch(/multipliée par la profondeur/);
    expect(usageDuContour("METRE")).toMatch(/n'est pas converti en quantité/);
    expect(usageDuContour("UNITE")).toMatch(/n'est pas converti en quantité/);
  });
});

describe("reponse du serveur", () => {
  it("lit la mesure de POST /v2/geo/metre, y compris des nombres rendus en texte, et refuse une forme inattendue", () => {
    expect(lireMesureServeur({ epsg: 32628, surfaceM2: 100.4, longueurM: 40.1, ecartSurface: 0.0002, longueurGeodesiqueM: 1 })).toEqual({ epsg: 32628, surfaceM2: 100.4, longueurM: 40.1, ecartSurface: 0.0002 });
    expect(lireMesureServeur({ epsg: "32629", surfaceM2: "12.5", longueurM: "14" })).toEqual({ epsg: 32629, surfaceM2: 12.5, longueurM: 14, ecartSurface: null });
    expect(lireMesureServeur(null)).toBeNull();
    expect(lireMesureServeur({ epsg: 32628, longueurM: 4 })).toBeNull();
    expect(lireMesureServeur({ epsg: 32628, surfaceM2: 0, longueurM: 4 })).toBeNull();
    expect(lireMesureServeur({ epsg: 32628, surfaceM2: Number.NaN, longueurM: 4 })).toBeNull();
  });

  it("un 400 est un JUGEMENT sur la geometrie (sa raison est rendue) ; tout autre echec ne juge rien", () => {
    expect(lireRefusServeur({ response: { status: 400, data: { error: "geometrie invalide : Self-intersection[1 2]" } } })).toEqual({ refus: true, raison: "geometrie invalide : Self-intersection[1 2]" });
    expect(lireRefusServeur({ response: { status: 400, data: {} } })).toEqual({ refus: true, raison: "géométrie refusée" });
    expect(lireRefusServeur({ response: { status: 403 } })).toEqual({ refus: false, raison: "réponse 403" });
    expect(lireRefusServeur(new Error("Network Error"))).toEqual({ refus: false, raison: "serveur injoignable" });
  });
});
