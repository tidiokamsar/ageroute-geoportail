/**
 * Lecteur LandXML (lot D1 ; contrat : docs/projets-voirie/CONTRAT-DOCUMENTS.md, section 7.1). Sans E/S, sans base.
 *
 * L'XML est lu par `xml.noyau.ts`, le lecteur du module : DTD et entites refusees (`DTD_REFUSEE`, `ENTITE_REFUSEE`), aucune ressource externe, plafonds
 * d'elements, d'attributs et de profondeur. Aucun schema LandXML n'est charge, aucune bibliotheque n'est ajoutee.
 *
 * CE QUI EST LU
 *   - `Alignments/Alignment/CoordGeom` : un objet LIGNE par axe en plan (couche `alignements`), elements mis bout a bout :
 *       `Line` (segment), `Curve` (arc de cercle DISCRETISE : la fleche entre l'arc et chaque corde est au plus egale a la tolerance), `IrregularLine`
 *       (polyligne `PntList2D`) ; une discontinuite de plus de `ECART_RACCORD_M` ouvre une nouvelle partie (comptee) ;
 *   - `CgPoints/CgPoint` : un objet POINT par point (couche `cgpoints`) ; `pntRef` resolu dans les CgPoints du fichier.
 * CE QUI EST REFUSE : `Spiral` et `Chain` (`LANDXML_SPIRALE_NON_PRISE_EN_CHARGE` : une clothoide n'est pas approchee en silence), un arc degenere
 *   (`LANDXML_ARC_DEGENERE`), un `pntRef` introuvable, des unites absentes (`UNITES_REQUISES`) ou non metriques (`LANDXML_UNITES_NON_SUPPORTEES`).
 * CE QUI EST IGNORE ET COMPTE : `Profile` (profil en long), `Surfaces/Surface`, tout autre element (`Parcels`, `PipeNetworks`, `Roadways`...).
 *
 * COORDONNEES : la norme ecrit « Nord Est [altitude] » ; X = Est, Y = Nord. Le CRS n'est JAMAIS deduit (choisi par l'utilisateur, voir crs.noyau.ts) ;
 * `CoordinateSystem/@epsgCode` n'est qu'une declaration montree et comparee. Les unites ne sont jamais converties (aucune mise a l'echelle).
 *
 * PLAFONDS : le nombre de sommets produits par la discretisation est compte AVANT d'etre alloue (par axe et par fichier, plafonds du socle), et un arc
 * ne depasse jamais `SEGMENTS_ARC_MAX` segments : un fichier hostile (arcs immenses, tolerance minimale) est refuse sans allocation proportionnelle.
 */

import type { Brut, FormesBrutes } from "../collecteur.noyau";
import { ErreurLecture, SOMMETS_PAR_FICHIER_MAX, SOMMETS_PAR_OBJET_MAX } from "../lecture.types";
import type { Avertissement } from "../lecture.types";
import type { NoeudXml } from "../xml.noyau";
import type { Puits } from "./puits.noyau";

/** Segments au plus par arc discretise. */
export const SEGMENTS_ARC_MAX = 10_000;
/** Ecart (m) au-dela duquel deux elements consecutifs d'un axe ne se raccordent pas (nouvelle partie, comptee). */
export const ECART_RACCORD_M = 0.001;
/** Rayon (m) en dessous duquel un arc est degenere. */
export const RAYON_MIN_M = 0.001;
/** Tolerance de discretisation par defaut (m) : `PROJETS_VOIRIE_LANDXML_TOLERANCE_ARC_MM`, 10 mm (borne de protection, a valider par le DSI). */
export const TOLERANCE_ARC_DEFAUT_M = 0.01;

export const COUCHE_ALIGNEMENTS = "alignements";
export const COUCHE_POINTS = "cgpoints";

export interface OptionsLandXml {
  toleranceArcM?: number;
  sommetsParObjet?: number;
  sommetsParFichier?: number;
  /** Inventaire : rien n'est discretise ni refuse (spirales et arcs comptes) ; aucune coordonnee n'est controlee. */
  inventaire?: boolean;
}

export interface CrsDeclareLandXml { epsg: number | null; nom: string | null }

export interface ResultatLandXml {
  avertissements: Avertissement[];
  toleranceArcM: number;
  nbAlignements: number;
  nbLignes: number;
  nbArcs: number;
  nbIrreguliers: number;
  nbSpirales: number;
  sommetsArcs: number;
  nbPoints: number;
  nbSurfacesIgnorees: number;
  nbProfilsIgnores: number;
  nbAutresIgnores: number;
  nbDiscontinuites: number;
  crsDeclare: CrsDeclareLandXml | null;
  unites: string | null;
}

type Pos2 = [number, number];

const enfant = (n: NoeudXml, nom: string) => n.enfants.find((e) => e.nom === nom);
const enfants = (n: NoeudXml, nom: string) => n.enfants.filter((e) => e.nom === nom);
const estBlanc = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
const RE_NOMBRE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/;
const CHAMP_MAX = 40;

/** Nombres d'un texte separes par des blancs, balayage lineaire (aucune expression reguliere sur le texte entier) ; champ illisible : NaN. */
export function lireNombres(texte: string, max = Number.POSITIVE_INFINITY): number[] {
  const sortie: number[] = [];
  const n = texte.length;
  let i = 0;
  while (i < n && sortie.length < max) {
    while (i < n && estBlanc(texte.charCodeAt(i))) i++;
    if (i >= n) break;
    const debut = i;
    while (i < n && !estBlanc(texte.charCodeAt(i))) i++;
    const champ = i - debut > CHAMP_MAX ? "" : texte.slice(debut, i);
    sortie.push(RE_NOMBRE.test(champ) ? Number(champ) : NaN);
  }
  return sortie;
}

/** « Nord Est [altitude] » vers [Est, Nord(, altitude)] ; moins de deux nombres : [NaN, NaN]. */
function versBrut(nombres: readonly number[], avecAltitude: boolean): Brut {
  if (nombres.length < 2) return [NaN, NaN];
  return avecAltitude && nombres.length >= 3 && Number.isFinite(nombres[2]) ? [nombres[1], nombres[0], nombres[2]] : [nombres[1], nombres[0]];
}

/** CRS declare par le fichier (`CoordinateSystem`) : montre et compare, jamais applique. */
export function crsDeclareLandXml(racine: NoeudXml): CrsDeclareLandXml | null {
  const cs = enfant(racine, "CoordinateSystem");
  if (!cs) return null;
  const brut = (cs.attrs.epsgCode ?? "").trim();
  const epsg = /^\d{4,6}$/.test(brut) ? Number(brut) : null;
  const nom = (cs.attrs.name ?? cs.attrs.desc ?? "").trim().slice(0, 120) || null;
  return { epsg, nom };
}

/** Unite lineaire declaree (`Units/Metric/@linearUnit` ou `Units/Imperial/@linearUnit`), nulle si absente. */
export function unitesLandXml(racine: NoeudXml): { systeme: "Metric" | "Imperial" | null; lineaire: string | null } {
  const u = enfant(racine, "Units");
  if (!u) return { systeme: null, lineaire: null };
  const m = enfant(u, "Metric");
  if (m) return { systeme: "Metric", lineaire: (m.attrs.linearUnit ?? "").trim().slice(0, 40) || null };
  const imp = enfant(u, "Imperial");
  if (imp) return { systeme: "Imperial", lineaire: (imp.attrs.linearUnit ?? "").trim().slice(0, 40) || null };
  return { systeme: null, lineaire: null };
}

/** Motif d'un arc degenere (jamais de coordonnee). */
export class ArcDegenere extends Error {
  constructor(public readonly motif: string) { super(motif); this.name = "ArcDegenere"; }
}

/** Nombre de segments d'un arc de rayon `r` et d'angle `balayage` (radians) pour une fleche au plus egale a `tolerance`. */
export function segmentsArc(r: number, balayage: number, tolerance: number): number {
  const thetaMax = tolerance >= r ? Math.PI / 2 : 2 * Math.acos(1 - tolerance / r);
  return Math.max(1, Math.ceil(Math.abs(balayage) / thetaMax - 1e-12));
}

export interface ArcPrepare { r: number; a0: number; balayage: number; segments: number }

/**
 * Controle et prepare un arc `Start` -> `End` de centre `Center`, sens `rot` (`cw` horaire, `ccw` anti-horaire, plan Est/Nord) : leve `ArcDegenere`
 * (coordonnee illisible, rayon nul, rayons de depart et d'arrivee incoherents au-dela de la tolerance, depart egal a l'arrivee, sens absent).
 */
export function preparerArc(s: Pos2, c: Pos2, e: Pos2, rot: string | undefined, tolerance: number): ArcPrepare {
  if (![...s, ...c, ...e].every(Number.isFinite)) throw new ArcDegenere("coordonnee de depart, de centre ou d'arrivee absente ou illisible");
  const r1 = Math.hypot(s[0] - c[0], s[1] - c[1]);
  const r2 = Math.hypot(e[0] - c[0], e[1] - c[1]);
  if (r1 < RAYON_MIN_M || r2 < RAYON_MIN_M) throw new ArcDegenere("rayon nul (le centre est confondu avec une extremite)");
  if (Math.abs(r1 - r2) > Math.max(tolerance, 1e-9 * r1)) throw new ArcDegenere("rayons de depart et d'arrivee incoherents au-dela de la tolerance");
  if (Math.hypot(e[0] - s[0], e[1] - s[1]) < 1e-6) throw new ArcDegenere("depart egal a l'arrivee (cercle complet ou arc nul : ambigu)");
  const sens = (rot ?? "").trim();
  if (sens !== "cw" && sens !== "ccw") throw new ArcDegenere("sens de rotation (rot) absent ou inconnu : cw ou ccw attendu");
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  const a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
  let d = a1 - a0;
  if (sens === "ccw") { while (d <= 0) d += 2 * Math.PI; } else { while (d >= 0) d -= 2 * Math.PI; }
  return { r: r1, a0, balayage: d, segments: segmentsArc(r1, d, tolerance) };
}

/** Points de l'arc prepare, extremites EXACTES (celles du fichier). */
export function pointsArc(s: Pos2, c: Pos2, e: Pos2, a: ArcPrepare): Pos2[] {
  const pts: Pos2[] = [[s[0], s[1]]];
  for (let k = 1; k < a.segments; k++) {
    const t = a.a0 + (a.balayage * k) / a.segments;
    pts.push([c[0] + a.r * Math.cos(t), c[1] + a.r * Math.sin(t)]);
  }
  pts.push([e[0], e[1]]);
  return pts;
}

interface Budget { fichier: number; fichierMax: number; objetMax: number }

const ELEMENTS_RACINE_LUS = new Set(["Units", "CoordinateSystem", "Project", "Application", "Alignments", "CgPoints", "Surfaces"]);
const ELEMENTS_AXE_IGNORES_MUETS = new Set(["CoordGeom", "Profile"]);

/** Parcourt un document LandXML et livre axes et points au `col`. */
export function traverserLandXml(racine: NoeudXml, col: Puits, o: OptionsLandXml = {}): ResultatLandXml {
  if (racine.nom !== "LandXML") throw new ErreurLecture("FORMAT_NON_SUPPORTE", `l'element racine d'un LandXML doit etre « LandXML » (lu : « ${racine.nom.slice(0, 40)} »)`);
  const inventaire = o.inventaire === true;
  const tolerance = o.toleranceArcM ?? TOLERANCE_ARC_DEFAUT_M;
  const budget: Budget = { fichier: 0, fichierMax: o.sommetsParFichier ?? SOMMETS_PAR_FICHIER_MAX, objetMax: o.sommetsParObjet ?? SOMMETS_PAR_OBJET_MAX };
  const unites = unitesLandXml(racine);
  const r: ResultatLandXml = {
    avertissements: [], toleranceArcM: tolerance, nbAlignements: 0, nbLignes: 0, nbArcs: 0, nbIrreguliers: 0, nbSpirales: 0, sommetsArcs: 0, nbPoints: 0,
    nbSurfacesIgnorees: 0, nbProfilsIgnores: 0, nbAutresIgnores: 0, nbDiscontinuites: 0, crsDeclare: crsDeclareLandXml(racine), unites: unites.lineaire,
  };
  if (!inventaire) {
    if (unites.lineaire === null) {
      throw new ErreurLecture("UNITES_REQUISES", "le LandXML ne declare pas ses unites (Units/Metric/@linearUnit) : elles ne sont jamais devinees. Exportez-le en metres avec la balise Units");
    }
    if (unites.systeme !== "Metric" || unites.lineaire !== "meter") {
      throw new ErreurLecture("LANDXML_UNITES_NON_SUPPORTEES", `unite lineaire « ${unites.lineaire.slice(0, 40)} » non prise en charge : seul le metre (Units/Metric/@linearUnit="meter") est lu, sans aucune mise a l'echelle. Exportez le fichier en metres`);
    }
  }
  const ignores = new Map<string, number>();
  const ignorer = (nom: string, n = 1) => { r.nbAutresIgnores += n; ignores.set(nom, (ignores.get(nom) ?? 0) + n); };

  // 1. Points nommes (CgPoints, groupes imbriques compris) : references des `pntRef` et objets POINT.
  const pointsNommes = new Map<string, Brut>();
  const cgPoints: NoeudXml[] = [];
  const collecterPoints = (groupe: NoeudXml, profondeur: number) => {
    for (const e of groupe.enfants) {
      if (e.nom === "CgPoint") cgPoints.push(e);
      else if (e.nom === "CgPoints" && profondeur < 8) collecterPoints(e, profondeur + 1);
    }
  };
  for (const g of enfants(racine, "CgPoints")) collecterPoints(g, 0);
  for (const p of cgPoints) {
    const nom = (p.attrs.name ?? "").trim();
    if (nom && !pointsNommes.has(nom) && p.attrs.pntRef === undefined) pointsNommes.set(nom, versBrut(lireNombres(p.texte, 3), true));
  }

  const pointDe = (n: NoeudXml | undefined, ou: string): Pos2 => {
    if (!n) return [NaN, NaN];
    const ref = n.attrs.pntRef;
    if (ref !== undefined) {
      const b = pointsNommes.get(ref.trim());
      if (!b) {
        if (inventaire) return [NaN, NaN];
        throw new ErreurLecture("LANDXML_POINT_INTROUVABLE", `${ou} : le point reference (pntRef) n'existe pas dans les CgPoints du fichier`);
      }
      return [b[0], b[1]];
    }
    const b = versBrut(lireNombres(n.texte, 3), false);
    return [b[0], b[1]];
  };

  // 2. Axes en plan.
  for (const groupe of enfants(racine, "Alignments")) {
    for (const al of groupe.enfants) {
      if (al.nom !== "Alignment") { ignorer(al.nom); continue; }
      r.nbAlignements++;
      const numero = r.nbAlignements;
      col.elementLu();
      r.nbProfilsIgnores += enfants(al, "Profile").length;
      for (const x of al.enfants) if (!ELEMENTS_AXE_IGNORES_MUETS.has(x.nom)) ignorer(x.nom);
      const cg = enfant(al, "CoordGeom");
      if (!cg || cg.enfants.length === 0) { col.compter("OBJETS_SANS_GEOMETRIE"); continue; }
      const parties: Brut[][] = [];
      let courante: Brut[] = [];
      let sommetsObjet = 0;
      let nbElements = 0, nbArcsAxe = 0, nbLignesAxe = 0;
      const compterSommets = (n: number) => {
        sommetsObjet += n;
        budget.fichier += n;
        if (!inventaire && sommetsObjet > budget.objetMax) throw new ErreurLecture("TROP_DE_SOMMETS", `l'axe n°${numero} depasse ${budget.objetMax} sommets apres discretisation : decoupez-le`);
        if (!inventaire && budget.fichier > budget.fichierMax) throw new ErreurLecture("TROP_DE_SOMMETS", `le fichier depasse ${budget.fichierMax} sommets apres discretisation : decoupez-le`);
      };
      const ajouterPoints = (pts: Pos2[]) => {
        if (pts.length === 0) return;
        if (courante.length === 0) { courante.push(...pts); return; }
        const der = courante[courante.length - 1];
        if (Math.hypot(pts[0][0] - der[0], pts[0][1] - der[1]) <= ECART_RACCORD_M) courante.push(...pts.slice(1));
        else { r.nbDiscontinuites++; parties.push(courante); courante = [...pts]; }
      };
      for (const el of cg.enfants) {
        nbElements++;
        const ou = `axe n°${numero}, element n°${nbElements} (${el.nom.slice(0, 40)})`;
        if (el.nom === "Line") {
          r.nbLignes++; nbLignesAxe++;
          compterSommets(2);
          ajouterPoints([pointDe(enfant(el, "Start"), ou), pointDe(enfant(el, "End"), ou)]);
        } else if (el.nom === "Curve") {
          r.nbArcs++; nbArcsAxe++;
          const s = pointDe(enfant(el, "Start"), ou), c = pointDe(enfant(el, "Center"), ou), e = pointDe(enfant(el, "End"), ou);
          if (inventaire) { compterSommets(2); ajouterPoints([s, e]); continue; }
          let arc: ArcPrepare;
          try {
            arc = preparerArc(s, c, e, el.attrs.rot, tolerance);
          } catch (err) {
            if (err instanceof ArcDegenere) throw new ErreurLecture("LANDXML_ARC_DEGENERE", `${ou} : arc degenere (${err.motif})`);
            throw err;
          }
          if (arc.segments > SEGMENTS_ARC_MAX) throw new ErreurLecture("TROP_DE_SOMMETS", `${ou} : l'arc exigerait ${arc.segments} segments (maximum ${SEGMENTS_ARC_MAX}) pour la tolerance de ${tolerance} m`);
          compterSommets(arc.segments + 1);
          r.sommetsArcs += arc.segments + 1;
          ajouterPoints(pointsArc(s, c, e, arc));
        } else if (el.nom === "IrregularLine") {
          r.nbIrreguliers++;
          const liste = enfant(el, "PntList2D");
          const nombres = liste ? lireNombres(liste.texte, 2 * (budget.objetMax + 1)) : [];
          const pts: Pos2[] = [];
          for (let k = 0; k + 1 < nombres.length; k += 2) pts.push([nombres[k + 1], nombres[k]]);
          if (nombres.length % 2 === 1) pts.push([NaN, NaN]);
          compterSommets(pts.length);
          ajouterPoints(pts);
        } else if (el.nom === "Spiral" || el.nom === "Chain") {
          r.nbSpirales++;
          if (!inventaire) {
            throw new ErreurLecture("LANDXML_SPIRALE_NON_PRISE_EN_CHARGE", `${ou} : les spirales (clothoides) et les chaines de points ne sont pas lues (aucune approximation silencieuse). Exportez l'axe en elements discretises (IrregularLine) ou en DXF, ou decoupez-le en lignes et arcs`);
          }
        } else {
          ignorer(el.nom);
        }
      }
      if (courante.length) parties.push(courante);
      if (parties.length === 0) { col.compter("OBJETS_SANS_GEOMETRIE"); continue; }
      const nom = (al.attrs.name ?? "").trim().slice(0, 200) || null;
      const attributs: Record<string, unknown> = {};
      if (nom) attributs.name = nom;
      for (const k of ["desc", "length", "staStart", "state"]) { const v = (al.attrs[k] ?? "").trim(); if (v) attributs[k] = v.slice(0, 200); }
      attributs.nbElements = String(nbElements);
      attributs.nbArcs = String(nbArcsAxe);
      attributs.nbLignes = String(nbLignesAxe);
      const formes: FormesBrutes = { points: [], lignes: parties, polygones: [] };
      col.ajouter(nom, attributs, formes, COUCHE_ALIGNEMENTS);
    }
  }

  // 3. Points (objets POINT), altitude conservee pour le signalement du socle (elle est ignoree).
  for (const p of cgPoints) {
    if (p.attrs.pntRef !== undefined) { ignorer("CgPoint (pntRef)"); continue; }
    col.elementLu();
    r.nbPoints++;
    const nom = (p.attrs.name ?? "").trim().slice(0, 200) || null;
    const attributs: Record<string, unknown> = {};
    if (nom) attributs.name = nom;
    for (const k of ["code", "desc", "featureRef"]) { const v = (p.attrs[k] ?? "").trim(); if (v) attributs[k] = v.slice(0, 200); }
    compterSommetsPoint(budget, inventaire);
    const formes: FormesBrutes = { points: [versBrut(lireNombres(p.texte, 3), true)], lignes: [], polygones: [] };
    col.ajouter(nom, attributs, formes, COUCHE_POINTS);
  }

  // 4. Le reste est ignore et compte.
  for (const s of enfants(racine, "Surfaces")) r.nbSurfacesIgnorees += enfants(s, "Surface").length;
  for (const e of racine.enfants) if (!ELEMENTS_RACINE_LUS.has(e.nom)) ignorer(e.nom);

  const a = r.avertissements;
  if (r.nbArcs > 0 && !inventaire) a.push({ code: "LANDXML_ARCS_DISCRETISES", message: `Arcs de cercle discretises en cordes : fleche au plus egale a ${tolerance} m (tolerance du serveur), extremites exactes ; ${r.sommetsArcs} sommets produits.`, nb: r.nbArcs });
  if (r.nbSpirales > 0) a.push({ code: "LANDXML_SPIRALES", message: "Le fichier contient des spirales ou des chaines de points : elles ne sont pas lues et l'apercu comme le depot seront refuses (LANDXML_SPIRALE_NON_PRISE_EN_CHARGE).", nb: r.nbSpirales });
  if (r.nbDiscontinuites > 0) a.push({ code: "LANDXML_DISCONTINUITES", message: `Elements consecutifs d'un axe non raccordes (ecart de plus de ${ECART_RACCORD_M} m) : l'axe est conserve en plusieurs parties, sans raccord invente.`, nb: r.nbDiscontinuites });
  if (r.nbProfilsIgnores > 0) a.push({ code: "LANDXML_PROFILS_IGNORES", message: "Profils en long (Profile) ignores : seul le trace en plan est lu (aucune 3D).", nb: r.nbProfilsIgnores });
  if (r.nbSurfacesIgnorees > 0) a.push({ code: "LANDXML_SURFACES_IGNOREES", message: "Surfaces (modeles numeriques de terrain) ignorees : elles ne sont pas des axes.", nb: r.nbSurfacesIgnorees });
  if (r.nbAutresIgnores > 0) {
    const noms = [...ignores.entries()].slice(0, 10).map(([n, k]) => `${n.slice(0, 40)} (${k})`).join(", ");
    a.push({ code: "LANDXML_ELEMENTS_IGNORES", message: `Elements LandXML non pris en charge, ignores : ${noms}${ignores.size > 10 ? ", ..." : ""}.`, nb: r.nbAutresIgnores });
  }
  return r;
}

function compterSommetsPoint(budget: Budget, inventaire: boolean): void {
  budget.fichier += 1;
  if (!inventaire && budget.fichier > budget.fichierMax) throw new ErreurLecture("TROP_DE_SOMMETS", `le fichier depasse ${budget.fichierMax} sommets : decoupez-le`);
}
