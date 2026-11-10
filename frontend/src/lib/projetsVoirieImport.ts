import type { Geometry } from "geojson";
import {
  ReponseInattendue, lireAvertissements, lireBlocCrs, lireDelta, lireSuppressions, lireValidationGeometrique,
  type Avertissement, type BlocCrs, type BlocSuppressions, type BlocValidationGeometrique, type Delta, type DonneesDepot,
} from "./projetsVoirieApi";
import {
  JUSTIFICATION_MIN, TAILLE_MAX_FICHIER, controlerFichier, formaterNombre, lireBbox, lireSaisieNombre, natureParDefaut, confidentialiteParDefaut, versNombre,
  type Bbox, type ClassePrecision, type Confidentialite, type NatureObjet, type RoleJeu, type TypeGeom, type TypeReseau,
} from "./projetsVoirie";

/**
 * Assistant d'import : types, lecteurs de reponse et logique pure. SOURCE DES FORMES : docs/projets-voirie/CONTRAT-IMPORT.md (lot A1) et le code
 * reel du backend (backend/src/api-v2/projets-voirie.import.routes.ts). Un ecart entre les deux est signale dans le rapport du lot A2 ; les
 * lecteurs acceptent les deux formes quand elles different (`sourcesAutorises` du code, `sourcesAutorisees` du contrat).
 *
 * Aucune E/S, aucun stockage, aucun DOM. Les valeurs de fichier (noms d'objets, attributs, colonnes) sont des textes : jamais du HTML.
 */

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const entier = (v: unknown): number => { const n = versNombre(v); return n === null ? 0 : n; };
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const chaines = (v: unknown): string[] => tableau(v).filter((x): x is string => typeof x === "string");
const ROUTE_OPTIONS = "GET /v2/projets-voirie/:id/import/options";

// ---------------------------------------------------------------------------------------------------
// Etapes
// ---------------------------------------------------------------------------------------------------

export type IdEtape = "depot" | "format" | "crs" | "mapping" | "controles" | "delta" | "approbation";

export const ETAPES: readonly { id: IdEtape; libelle: string }[] = [
  { id: "depot", libelle: "Dépôt du fichier" },
  { id: "format", libelle: "Format et couches" },
  { id: "crs", libelle: "Système de coordonnées" },
  { id: "mapping", libelle: "Correspondance des champs" },
  { id: "controles", libelle: "Contrôles et échantillon" },
  { id: "delta", libelle: "Comparaison avec la version autorisée" },
  { id: "approbation", libelle: "Approbation" },
];
/** Reprise d'un jeu deja depose (quarantaine ou version autorisee) : seules les deux dernieres etapes ont un sens. */
export const ETAPES_REPRISE: readonly IdEtape[] = ["delta", "approbation"];
export const libelleEtape = (id: IdEtape) => ETAPES.find((e) => e.id === id)?.libelle ?? id;

// ---------------------------------------------------------------------------------------------------
// Options de l'API (etape 0)
// ---------------------------------------------------------------------------------------------------

export interface FormatApi { format: string; extensions: string[]; crsParDefinition: string | null; choixCrs: "interdit" | "facultatif" | "obligatoire" }
export interface CrsSource { epsg: number; nom: string | null; unite: string | null; disponible: boolean }
export interface ChampCible { champ: string; portee: "objet" | "jeu"; description: string }
/** Lot B2 : formats lus par la chaine GDAL isolee (GeoPackage, Shapefile ZIP, DXF), DESACTIVEE par defaut sur un serveur. */
export interface FormatGdalApi { format: string; extensions: string[]; etat: "SUPPORTE" | "INDISPONIBLE"; raison: string | null }
export interface FormatsGdalApi { actif: boolean; disponible: boolean; raison: string | null; formats: FormatGdalApi[] }
export interface OptionsImportApi {
  formats: FormatApi[];
  /** `null` pour un serveur qui ne l'annonce pas (anterieur au lot B2). */
  formatsGdal: FormatsGdalApi | null;
  nonSupportes: { format: string; raison: string }[];
  limites: {
    tailleMaxOctets: number; objetsMax: number | null; echantillonMax: number | null; delaiApercuMs: number | null;
    archiveEntreesMax: number | null; archiveTailleMaxOctets: number | null; csvLignesMax: number | null;
  };
  crs: { cible: { epsg: number; nom: string; unite: string } | null; sources: CrsSource[]; zoneAttendue: { nom: string; bbox: Bbox } | null };
  champsCibles: ChampCible[];
  csv: { delimiteurs: string[]; encodages: string[]; separateursDecimaux: string[]; modes: string[] };
  conservationOriginal: string;
}

export function lireOptionsImport(data: unknown): OptionsImportApi {
  if (!estObjet(data) || !Array.isArray(data.formats) || !estObjet(data.crs)) throw new ReponseInattendue(ROUTE_OPTIONS);
  const formats = data.formats.flatMap((f): FormatApi[] => {
    if (!estObjet(f) || !texte(f.format)) return [];
    const c = f.choixCrs === "interdit" || f.choixCrs === "obligatoire" ? f.choixCrs : "facultatif";
    return [{ format: String(f.format), extensions: chaines(f.extensions), crsParDefinition: texte(f.crsParDefinition), choixCrs: c }];
  });
  if (formats.length === 0) throw new ReponseInattendue(ROUTE_OPTIONS);
  const brutSources = data.crs.sourcesAutorises ?? data.crs.sourcesAutorisees;
  const sources = tableau(brutSources).flatMap((s): CrsSource[] => {
    if (!estObjet(s)) return [];
    const epsg = versNombre(s.epsg);
    return epsg === null ? [] : [{ epsg, nom: texte(s.nom), unite: texte(s.unite), disponible: s.disponible !== false }];
  });
  if (sources.length === 0) throw new ReponseInattendue(ROUTE_OPTIONS);
  const lim = estObjet(data.limites) ? data.limites : {};
  const arch = estObjet(lim.archive) ? lim.archive : {};
  const csvLim = estObjet(lim.csv) ? lim.csv : {};
  const cible = estObjet(data.crs.cible) && versNombre(data.crs.cible.epsg) !== null
    ? { epsg: entier(data.crs.cible.epsg), nom: texte(data.crs.cible.nom) ?? "WGS 84", unite: texte(data.crs.cible.unite) ?? "degre" } : null;
  const z = estObjet(data.crs.zoneAttendue) ? data.crs.zoneAttendue : null;
  const zbbox = z ? lireBbox(z.bbox) : null;
  const csv = estObjet(data.csv) ? data.csv : {};
  const g = estObjet(data.formatsGdal) ? data.formatsGdal : null;
  return {
    formats,
    formatsGdal: g ? {
      actif: g.actif === true, disponible: g.disponible === true, raison: texte(g.raison),
      formats: tableau(g.formats).flatMap((f): FormatGdalApi[] => (estObjet(f) && texte(f.format)
        ? [{ format: String(f.format), extensions: chaines(f.extensions), etat: f.etat === "SUPPORTE" ? "SUPPORTE" : "INDISPONIBLE", raison: texte(f.raison) }] : [])),
    } : null,
    nonSupportes: tableau(data.nonSupportes).flatMap((n) => (estObjet(n) && texte(n.format) ? [{ format: String(n.format), raison: texte(n.raison) ?? "" }] : [])),
    limites: {
      tailleMaxOctets: versNombre(lim.tailleMaxOctets) ?? TAILLE_MAX_FICHIER, objetsMax: versNombre(lim.objetsMax), echantillonMax: versNombre(lim.echantillonMax),
      delaiApercuMs: versNombre(lim.delaiApercuMs), archiveEntreesMax: versNombre(arch.entreesMax),
      archiveTailleMaxOctets: versNombre(arch.tailleDecompresseeMaxOctets), csvLignesMax: versNombre(csvLim.lignesMax),
    },
    crs: { cible, sources, zoneAttendue: z && zbbox ? { nom: texte(z.nom) ?? "Zone attendue", bbox: zbbox } : null },
    champsCibles: tableau(data.champsCibles).flatMap((c): ChampCible[] =>
      estObjet(c) && texte(c.champ) ? [{ champ: String(c.champ), portee: c.portee === "objet" ? "objet" : "jeu", description: texte(c.description) ?? "" }] : []),
    csv: { delimiteurs: chaines(csv.delimiteurs), encodages: chaines(csv.encodages), separateursDecimaux: chaines(csv.separateursDecimaux), modes: chaines(csv.modes) },
    conservationOriginal: texte(data.conservationOriginal) ?? "EMPREINTE_SEULE",
  };
}

// ---------------------------------------------------------------------------------------------------
// Inventaire (etape 1 du serveur)
// ---------------------------------------------------------------------------------------------------

export interface FichierVu { nom: string; tailleOctets: number; sha256: string }
export interface CoucheInventoriee { id: string; nom: string; nbObjets: number; parTypeGeom: Partial<Record<TypeGeom, number>> }
export interface EntreeArchive { nom: string; tailleOctets: number; type: string }
export interface InfoCsv {
  delimiteur: string; delimiteurDetecte: boolean; encodage: string; encodageDetecte: boolean; bom: boolean;
  separateurDecimal: "." | "," | null; separateurDecimalDetecte: boolean; nbLignes: number;
  colonnes: { nom: string; exemples: string[] }[]; echantillon: string[][];
}
export interface Inventaire {
  fichier: FichierVu;
  format: string;
  detection: { extensionDeclaree: string | null; extensionCoherente: boolean };
  archive: { nbEntrees: number; tailleDecompresseeOctets: number; kmlPrincipal: string | null; entreesKml: string[]; choixRequis: boolean; entrees: EntreeArchive[] } | null;
  couches: CoucheInventoriee[];
  csv: InfoCsv | null;
  crs: { normeDuFormat: string | null; declareDansLeFichier: string | null; choixObligatoire: boolean };
  champsDisponibles: string[];
  suggestionsMapping: Record<string, string>;
  avertissements: Avertissement[];
}

function lireFichierVu(v: unknown, route: string): FichierVu {
  if (!estObjet(v) || !texte(v.sha256)) throw new ReponseInattendue(route);
  return { nom: texte(v.nom) ?? "fichier", tailleOctets: entier(v.tailleOctets), sha256: String(v.sha256) };
}

function parType(v: unknown): Partial<Record<TypeGeom, number>> {
  const sortie: Partial<Record<TypeGeom, number>> = {};
  if (estObjet(v)) for (const k of ["LIGNE", "POINT", "POLYGONE"] as const) { const n = versNombre(v[k]); if (n !== null) sortie[k] = n; }
  return sortie;
}

export function lireInventaire(data: unknown): Inventaire {
  const route = "POST /v2/projets-voirie/:id/import/inventaire";
  if (!estObjet(data) || !texte(data.format)) throw new ReponseInattendue(route);
  const det = estObjet(data.detection) ? data.detection : {};
  const a = estObjet(data.archive) ? data.archive : null;
  const c = estObjet(data.csv) ? data.csv : null;
  const crs = estObjet(data.crs) ? data.crs : {};
  const sep = c?.separateurDecimal === "." || c?.separateurDecimal === "," ? c.separateurDecimal : null;
  const suggestions: Record<string, string> = {};
  if (estObjet(data.suggestionsMapping)) for (const [k, v] of Object.entries(data.suggestionsMapping)) if (typeof v === "string") suggestions[k] = v;
  return {
    fichier: lireFichierVu(data.fichier, route),
    format: String(data.format),
    detection: { extensionDeclaree: texte(det.extensionDeclaree), extensionCoherente: det.extensionCoherente !== false },
    archive: a ? {
      nbEntrees: entier(a.nbEntrees), tailleDecompresseeOctets: entier(a.tailleDecompresseeOctets), kmlPrincipal: texte(a.kmlPrincipal),
      entreesKml: chaines(a.entreesKml), choixRequis: a.choixRequis === true,
      entrees: tableau(a.entrees).flatMap((e): EntreeArchive[] => (estObjet(e) && texte(e.nom) ? [{ nom: String(e.nom), tailleOctets: entier(e.tailleOctets), type: texte(e.type) ?? "autre" }] : [])),
    } : null,
    couches: tableau(data.couches).flatMap((l): CoucheInventoriee[] => (estObjet(l) && texte(l.id) ? [{ id: String(l.id), nom: texte(l.nom) ?? String(l.id), nbObjets: entier(l.nbObjets), parTypeGeom: parType(l.parTypeGeom) }] : [])),
    csv: c ? {
      delimiteur: texte(c.delimiteur) ?? ",", delimiteurDetecte: c.delimiteurDetecte === true, encodage: texte(c.encodage) ?? "utf-8", encodageDetecte: c.encodageDetecte === true, bom: c.bom === true,
      separateurDecimal: sep, separateurDecimalDetecte: c.separateurDecimalDetecte === true, nbLignes: entier(c.nbLignes),
      colonnes: tableau(c.colonnes).flatMap((k) => (estObjet(k) && texte(k.nom) ? [{ nom: String(k.nom), exemples: chaines(k.exemples).slice(0, 3) }] : [])),
      echantillon: tableau(c.echantillon).map((r) => chaines(r)).slice(0, 5),
    } : null,
    crs: { normeDuFormat: texte(crs.normeDuFormat), declareDansLeFichier: texte(crs.declareDansLeFichier), choixObligatoire: crs.choixObligatoire === true },
    champsDisponibles: chaines(data.champsDisponibles),
    suggestionsMapping: suggestions,
    avertissements: lireAvertissements(data.avertissements),
  };
}

// ---------------------------------------------------------------------------------------------------
// Apercu (etapes 2 a 5 de l'assistant)
// ---------------------------------------------------------------------------------------------------

export interface ObjetEchantillon { ordre: number; nom: string | null; typeGeom: string; geometrie: Geometry; simplifiee: boolean; attributs: Record<string, unknown> }
export interface InfoImportApercu {
  couche: { id: string; nom: string } | null; entreeKml: string | null;
  csv: { delimiteur: string; encodage: string; separateurDecimal: string; mode: string; nbLignes: number; nbLignesRejetees: number } | null;
  rejets: { ligne: number; code: string; message: string }[]; rejetsTronques: boolean;
}
export interface Statistiques { nbObjets: number; parTypeGeom: Partial<Record<TypeGeom, number>>; longueurTotaleM: number | null; doublonsInternes: number; sommets: number; geometriesAReparer: number; geometriesVides: number }
export interface Apercu {
  fichier: FichierVu;
  format: string;
  couche: { id: string; nom: string } | null;
  resume: { nbObjets: number; parTypeGeom: Partial<Record<TypeGeom, number>>; longueurTotaleM: number | null; bbox: Bbox | null; crs: BlocCrs | null; import: InfoImportApercu };
  statistiques: Statistiques;
  validationGeometrique: BlocValidationGeometrique;
  echantillon: { taille: number; total: number; objets: ObjetEchantillon[] };
  mapping: { applique: Record<string, string>; propositionsJeu: Record<string, { valeur: string | number; colonne: string }>; avertissements: Avertissement[] };
  avertissements: Avertissement[];
}

function lireCouche(v: unknown): { id: string; nom: string } | null {
  return estObjet(v) && texte(v.id) ? { id: String(v.id), nom: texte(v.nom) ?? String(v.id) } : null;
}

function lireGeometrie(v: unknown): Geometry | null {
  return estObjet(v) && typeof v.type === "string" && "coordinates" in v ? (v as unknown as Geometry) : null;
}

export function lireApercu(data: unknown): Apercu {
  const route = "POST /v2/projets-voirie/:id/import/apercu";
  if (!estObjet(data) || !estObjet(data.resume) || !estObjet(data.echantillon) || !estObjet(data.statistiques)) throw new ReponseInattendue(route);
  const r = data.resume;
  const imp = estObjet(r.import) ? r.import : {};
  const csv = estObjet(imp.csv) ? imp.csv : null;
  const st = data.statistiques;
  const mapping = estObjet(data.mapping) ? data.mapping : {};
  const applique: Record<string, string> = {};
  if (estObjet(mapping.applique)) for (const [k, v] of Object.entries(mapping.applique)) if (typeof v === "string") applique[k] = v;
  const propositions: Record<string, { valeur: string | number; colonne: string }> = {};
  if (estObjet(mapping.propositionsJeu)) {
    for (const [k, v] of Object.entries(mapping.propositionsJeu)) {
      if (estObjet(v) && (typeof v.valeur === "string" || typeof v.valeur === "number") && texte(v.colonne)) propositions[k] = { valeur: v.valeur, colonne: String(v.colonne) };
    }
  }
  return {
    fichier: lireFichierVu(data.fichier, route),
    format: texte(data.format) ?? "",
    couche: lireCouche(data.couche),
    resume: {
      nbObjets: entier(r.nbObjets), parTypeGeom: parType(r.parTypeGeom), longueurTotaleM: versNombre(r.longueurTotaleM), bbox: lireBbox(r.bbox),
      crs: estObjet(r.crs) ? lireBlocCrs(r.crs) : null,
      import: {
        couche: lireCouche(imp.couche), entreeKml: texte(imp.entreeKml),
        csv: csv ? {
          delimiteur: texte(csv.delimiteur) ?? ",", encodage: texte(csv.encodage) ?? "utf-8", separateurDecimal: texte(csv.separateurDecimal) ?? ".", mode: texte(csv.mode) ?? "",
          nbLignes: entier(csv.nbLignes), nbLignesRejetees: entier(csv.nbLignesRejetees),
        } : null,
        rejets: tableau(imp.rejets).flatMap((x) => (estObjet(x) && texte(x.code) ? [{ ligne: entier(x.ligne), code: String(x.code), message: texte(x.message) ?? String(x.code) }] : [])),
        rejetsTronques: imp.rejetsTronques === true,
      },
    },
    statistiques: {
      nbObjets: entier(st.nbObjets), parTypeGeom: parType(st.parTypeGeom), longueurTotaleM: versNombre(st.longueurTotaleM), doublonsInternes: entier(st.doublonsInternes),
      sommets: entier(st.sommets), geometriesAReparer: entier(st.geometriesAReparer), geometriesVides: entier(st.geometriesVides),
    },
    validationGeometrique: lireValidationGeometrique(data.validationGeometrique) ?? { nbProblemes: 0, problemes: [], tronque: false, elementsEcartes: [] },
    echantillon: {
      taille: entier(data.echantillon.taille), total: entier(data.echantillon.total),
      objets: tableau(data.echantillon.objets).flatMap((o): ObjetEchantillon[] => {
        const g = estObjet(o) ? lireGeometrie(o.geometrie) : null;
        if (!estObjet(o) || !g) return [];
        return [{ ordre: entier(o.ordre), nom: texte(o.nom), typeGeom: texte(o.typeGeom) ?? "", geometrie: g, simplifiee: o.simplifiee === true, attributs: estObjet(o.attributs) ? o.attributs : {} }];
      }),
    },
    mapping: { applique, propositionsJeu: propositions, avertissements: lireAvertissements(mapping.avertissements) },
    avertissements: lireAvertissements(data.avertissements),
  };
}

// ---------------------------------------------------------------------------------------------------
// Delta, revue des suppressions, retour arriere
// ---------------------------------------------------------------------------------------------------

export interface Acteur { id: string; nomComplet: string }
export interface RevueSuppressions { par: Acteur | null; le: string | null; decision: "ACCEPTER" | "REFUSER"; justification: string }
export interface RetourArriereInfo { possible: boolean; raison: string | null; restaureraJeuId: string | null; restaureraVersion: number | null }
export interface EvenementImport { id: string; type: string; par: Acteur | null; le: string | null; justification: string | null }
export interface DeltaDetail {
  jeu: { id: string; version: number; statut: string; role: string };
  comparaison: { jeuId: string; version: number; statut: string } | null;
  delta: Delta | null;
  cleComparaison: "identifiant" | "nom" | null;
  clesAmbigues: number;
  echantillons: {
    ajoutes: { objetId: string | null; nom: string | null }[];
    modifies: { cle: string; nomAvant: string | null; nomApres: string | null }[];
    retires: { objetId: string | null; nom: string | null }[];
  };
  suppressions: BlocSuppressions & { revue: RevueSuppressions | null };
  retourArriere: RetourArriereInfo | null;
  evenements: EvenementImport[];
}

function lireActeur(v: unknown): Acteur | null {
  return estObjet(v) && texte(v.id) ? { id: String(v.id), nomComplet: texte(v.nomComplet) ?? "Compte sans nom" } : null;
}
const idTexte = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);

export function lireRevue(v: unknown): RevueSuppressions | null {
  if (!estObjet(v) || (v.decision !== "ACCEPTER" && v.decision !== "REFUSER")) return null;
  return { par: lireActeur(v.par), le: texte(v.le), decision: v.decision, justification: texte(v.justification) ?? "" };
}

export function lireDeltaDetail(data: unknown): DeltaDetail {
  const route = "GET /v2/projets-voirie/:id/jeux/:jeuId/delta";
  if (!estObjet(data) || !estObjet(data.jeu) || !texte(data.jeu.id) || !estObjet(data.suppressions)) throw new ReponseInattendue(route);
  const s = lireSuppressions(data.suppressions);
  if (!s) throw new ReponseInattendue(route);
  const e = estObjet(data.echantillons) ? data.echantillons : {};
  const cmp = estObjet(data.comparaison) && texte(data.comparaison.jeuId) ? data.comparaison : null;
  const ra = estObjet(data.retourArriere) ? data.retourArriere : null;
  return {
    jeu: { id: String(data.jeu.id), version: Math.max(1, entier(data.jeu.version)), statut: texte(data.jeu.statut) ?? "", role: texte(data.jeu.role) ?? "" },
    comparaison: cmp ? { jeuId: String(cmp.jeuId), version: Math.max(1, entier(cmp.version)), statut: texte(cmp.statut) ?? "" } : null,
    delta: estObjet(data.delta) ? lireDelta(data.delta) : null,
    cleComparaison: data.cleComparaison === "identifiant" || data.cleComparaison === "nom" ? data.cleComparaison : null,
    clesAmbigues: entier(data.clesAmbigues),
    echantillons: {
      ajoutes: tableau(e.ajoutes).flatMap((x) => (estObjet(x) ? [{ objetId: idTexte(x.objetId), nom: texte(x.nom) }] : [])),
      modifies: tableau(e.modifies).flatMap((x) => (estObjet(x) && texte(x.cle) ? [{ cle: String(x.cle), nomAvant: texte(x.nomAvant), nomApres: texte(x.nomApres) }] : [])),
      retires: tableau(e.retires).flatMap((x) => (estObjet(x) ? [{ objetId: idTexte(x.objetId), nom: texte(x.nom) }] : [])),
    },
    suppressions: { ...s, revue: lireRevue(data.suppressions.revue) },
    retourArriere: ra ? { possible: ra.possible === true, raison: texte(ra.raison), restaureraJeuId: texte(ra.restaureraJeuId), restaureraVersion: versNombre(ra.restaureraVersion) } : null,
    evenements: tableau(data.evenements).flatMap((x): EvenementImport[] => (estObjet(x) && texte(x.id) ? [{ id: String(x.id), type: texte(x.type) ?? "", par: lireActeur(x.par), le: texte(x.le), justification: texte(x.justification) }] : [])),
  };
}

export interface IssueRevue { suppressions: BlocSuppressions & { revue: RevueSuppressions | null }; evenementId: string | null }
export function lireIssueRevue(data: unknown): IssueRevue {
  const route = "POST /v2/projets-voirie/:id/jeux/:jeuId/revue-suppressions";
  const s = estObjet(data) ? lireSuppressions(data.suppressions) : null;
  if (!estObjet(data) || !s || !estObjet(data.suppressions)) throw new ReponseInattendue(route);
  return { suppressions: { ...s, revue: lireRevue(data.suppressions.revue) }, evenementId: estObjet(data.evenement) ? texte(data.evenement.id) : null };
}

export interface IssueRetourArriere { restaureId: string; restaureVersion: number; retireVersion: number; evenementId: string | null }
export function lireIssueRetourArriere(data: unknown): IssueRetourArriere {
  const route = "POST /v2/projets-voirie/:id/jeux/:jeuId/retour-arriere";
  if (!estObjet(data) || !estObjet(data.jeuRestaure) || !texte(data.jeuRestaure.id) || !estObjet(data.jeuRetire)) throw new ReponseInattendue(route);
  return {
    restaureId: String(data.jeuRestaure.id), restaureVersion: Math.max(1, entier(data.jeuRestaure.version)), retireVersion: Math.max(1, entier(data.jeuRetire.version)),
    evenementId: estObjet(data.evenement) ? texte(data.evenement.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Saisie, options de lecture, champs envoyes
// ---------------------------------------------------------------------------------------------------

/** Etape 1 : le fichier et les metadonnees du jeu (role, concessionnaire, qualite, origine, confidentialite). Texte et choix seulement. */
export interface Saisie {
  fichier: File | null;
  role: RoleJeu;
  concessionnaireId: string;
  /** Famille technique (repli pour un concessionnaire sans code) ; envoyee seulement si `typeReseauCode` est vide. */
  typeReseau: TypeReseau | "";
  /** Lot T1 : code du referentiel TYPE_RESEAU (liste chargee depuis l'API). */
  typeReseauCode: string;
  /** Lot S1 : code du referentiel METHODE_ACQUISITION ; vide = non renseignee. */
  methodeAcquisition: string;
  natureObjet: NatureObjet;
  dateDonnees: string;
  origineFichier: string;
  classePrecision: ClassePrecision;
  precisionH: string;
  precisionV: string;
  methode: string;
  dateConstat: string;
  confidentialite: Confidentialite;
}

export const SAISIE_VIDE: Saisie = {
  fichier: null, role: "RESEAU_TIERS", concessionnaireId: "", typeReseau: "", typeReseauCode: "", methodeAcquisition: "", natureObjet: natureParDefaut("RESEAU_TIERS"), dateDonnees: "", origineFichier: "",
  classePrecision: "INCONNUE", precisionH: "", precisionV: "", methode: "", dateConstat: "", confidentialite: confidentialiteParDefaut("RESEAU_TIERS"),
};

export type ModeCsv = "points" | "lignes" | "wkt";
export interface LectureCsv {
  delimiteur: string; encodage: string; separateurDecimal: string; mode: ModeCsv | "";
  colonneX: string; colonneY: string; colonneWkt: string; colonneCle: string; colonneOrdre: string;
}
/** Valeur de `couche` qui dit « toutes les couches » : un choix explicite de l'utilisateur, jamais un defaut silencieux. */
export const TOUTES_LES_COUCHES = "*";

/** Etapes 2 a 4 : options de lecture. `""` = non fourni. Le CRS n'a jamais de valeur par defaut : `epsgSource` vide tant que l'utilisateur n'a pas choisi. */
export interface Lecture {
  couche: string;
  entreeKml: string;
  epsgSource: string;
  confirmerHorsZone: boolean;
  csv: LectureCsv;
  mapping: Record<string, string>;
}

export const LECTURE_CSV_VIDE: LectureCsv = { delimiteur: "", encodage: "", separateurDecimal: "", mode: "", colonneX: "", colonneY: "", colonneWkt: "", colonneCle: "", colonneOrdre: "" };
export const LECTURE_VIDE: Lecture = { couche: "", entreeKml: "", epsgSource: "", confirmerHorsZone: false, csv: LECTURE_CSV_VIDE, mapping: {} };

/**
 * Champs d'options envoyes AVANT le fichier (multipart, texte). Les valeurs vides ne sont pas envoyees. Pour un CSV, seules les colonnes du mode
 * choisi partent (le serveur refuse `colonneWkt` avec `colonneX`). Le delimiteur tabulation part en toutes lettres (« tab »).
 */
export function champsLecture(l: Lecture, sha256Attendu?: string): Record<string, string> {
  const c: Record<string, string> = {};
  if (l.couche && l.couche !== TOUTES_LES_COUCHES) c.couche = l.couche;
  if (l.entreeKml) c.entreeKml = l.entreeKml;
  if (l.epsgSource) c.epsgSource = l.epsgSource;
  if (l.confirmerHorsZone) c.confirmerHorsZone = "true";
  const k = l.csv;
  if (k.delimiteur) c.delimiteur = k.delimiteur === "\t" ? "tab" : k.delimiteur;
  if (k.encodage) c.encodage = k.encodage;
  if (k.separateurDecimal) c.separateurDecimal = k.separateurDecimal;
  if (k.mode === "wkt") { if (k.colonneWkt) c.colonneWkt = k.colonneWkt; }
  else if (k.mode === "points" || k.mode === "lignes") {
    if (k.colonneX) c.colonneX = k.colonneX;
    if (k.colonneY) c.colonneY = k.colonneY;
    if (k.mode === "lignes") {
      if (k.colonneCle) c.colonneCle = k.colonneCle;
      if (k.colonneOrdre) c.colonneOrdre = k.colonneOrdre;
    }
  }
  const m = Object.fromEntries(Object.entries(l.mapping).filter(([, v]) => v !== ""));
  if (Object.keys(m).length > 0) c.mapping = JSON.stringify(m);
  if (sha256Attendu) c.sha256Attendu = sha256Attendu;
  return c;
}

const aujourdhui = () => new Date().toISOString().slice(0, 10);

function lirePrecision(t: string, cle: string, erreurs: Record<string, string>): number | undefined {
  if (t.trim() === "") return undefined;
  const p = lireSaisieNombre(t);
  if (p === null || p <= 0 || p > 10000) { erreurs[cle] = "Une précision est un nombre de mètres supérieur à zéro, jusqu'à 10 000."; return undefined; }
  return p;
}

/** Format GDAL annonce par l'extension d'un fichier, ou `null`. Le serveur decide par le contenu ; ceci n'est qu'un indice. */
export function formatGdalDuFichier(nom: string | null | undefined, gdal: FormatsGdalApi | null | undefined): FormatGdalApi | null {
  if (!nom || !gdal) return null;
  const n = nom.toLowerCase();
  return gdal.formats.find((f) => f.extensions.some((e) => n.endsWith(e.toLowerCase()))) ?? null;
}

export const LIBELLE_FORMAT_GDAL: Record<string, string> = { GPKG: "GeoPackage", SHAPEFILE: "Shapefile (archive ZIP)", DXF: "DXF (dessin d'ingénierie)" };
/** Marche a suivre quand la conversion GDAL est desactivee sur ce serveur. */
export const MARCHE_GDAL_DESACTIVE = "Exportez le fichier depuis votre logiciel SIG ou de dessin en GeoJSON, KML, GPX ou CSV (avec ses coordonnées et son système de coordonnées), puis déposez ce fichier.";
export const MESSAGE_CODE_GDAL_ASYNCHRONE = "Ce format est lu par la chaîne de conversion isolée du serveur, en tâche de fond : cette interface ne pilote pas encore cette conversion. Déposez le fichier en GeoJSON, KML, GPX ou CSV.";

export function messageGdalDesactive(f: FormatGdalApi): string {
  return `Le format ${LIBELLE_FORMAT_GDAL[f.format] ?? f.format} est désactivé sur ce serveur : il n'est pas lu. ${MARCHE_GDAL_DESACTIVE}`;
}

/** Valide l'etape 1 et construit les donnees du depot. `options` : champs de lecture deja serialises (`champsLecture`). */
export function construireDonneesDepot(
  s: Saisie, formats: readonly FormatApi[], tailleMax: number, options: Readonly<Record<string, string>> = {}, formatsGdal: FormatsGdalApi | null = null,
): { donnees: DonneesDepot | null; erreurs: Record<string, string> } {
  const erreurs: Record<string, string> = {};
  const verdict = controlerFichier(s.fichier, formats, tailleMax);
  const gdal = formatGdalDuFichier(s.fichier?.name, formatsGdal);
  if (!s.fichier) erreurs.fichier = "Choisissez un fichier.";
  else if (!verdict.ok) erreurs.fichier = verdict.message ?? "Fichier non utilisable.";
  // Format GDAL desactive : refus LOCAL, sans envoi (le serveur rendrait 415 FORMAT_GDAL_DESACTIVE). Actif : la conversion asynchrone n'est pas
  // encore pilotee par cette interface (ecart documente) ; le serveur repondrait 422 CONVERSION_ASYNCHRONE_REQUISE.
  else if (gdal) erreurs.fichier = gdal.etat === "INDISPONIBLE" ? messageGdalDesactive(gdal) : MESSAGE_CODE_GDAL_ASYNCHRONE;
  if (s.role === "RESEAU_TIERS" && !s.concessionnaireId) erreurs.concessionnaire = "Choisissez le concessionnaire propriétaire du réseau, ou créez-le.";
  if (s.dateDonnees && s.dateDonnees > aujourdhui()) erreurs.dateDonnees = "La date des données ne peut pas être dans le futur.";
  if (s.dateConstat && s.dateConstat > aujourdhui()) erreurs.dateConstat = "La date de constat ne peut pas être dans le futur.";
  const h = lirePrecision(s.precisionH, "precisionH", erreurs);
  const v = lirePrecision(s.precisionV, "precisionV", erreurs);
  if (Object.keys(erreurs).length > 0 || !s.fichier) return { donnees: null, erreurs };
  const tiers = s.role === "RESEAU_TIERS";
  return {
    erreurs,
    donnees: {
      fichier: s.fichier,
      role: s.role,
      ...(tiers ? { concessionnaireId: s.concessionnaireId } : {}),
      ...(tiers && s.typeReseauCode ? { typeReseauCode: s.typeReseauCode } : tiers && s.typeReseau ? { typeReseau: s.typeReseau } : {}),
      ...(s.methodeAcquisition ? { methodeAcquisition: s.methodeAcquisition } : {}),
      natureObjet: s.natureObjet,
      ...(s.dateDonnees ? { dateDonnees: s.dateDonnees } : {}),
      ...(s.origineFichier.trim() ? { origineFichier: s.origineFichier.trim() } : {}),
      classePrecision: s.classePrecision,
      ...(h !== undefined ? { precisionHorizontaleM: h } : {}),
      ...(v !== undefined ? { precisionVerticaleM: v } : {}),
      ...(s.methode.trim() ? { methode: s.methode.trim() } : {}),
      ...(s.dateConstat ? { dateConstat: s.dateConstat } : {}),
      confidentialite: s.confidentialite,
      options,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Regles des etapes
// ---------------------------------------------------------------------------------------------------

export type ModeCrs =
  /** KML, KMZ, GPX : WGS 84 par la norme, aucun choix. */
  | { mode: "impose"; epsg: number }
  /** GeoJSON sans membre `crs` : WGS 84 par la norme, ou un systeme choisi (GeoJSON non conforme). */
  | { mode: "facultatif" }
  /** CSV, ou GeoJSON qui declare un systeme projete : l'utilisateur doit choisir ; `restreintA` : le code declare, seul admis. */
  | { mode: "obligatoire"; restreintA: number | null; declare: string | null };

export function epsgDeCode(code: string | null): number | null {
  const m = code ? /^EPSG:(\d{4,6})$/.exec(code.trim()) : null;
  return m ? Number(m[1]) : null;
}

export function modeCrs(inv: Inventaire, formats: readonly FormatApi[]): ModeCrs {
  const f = formats.find((x) => x.format === inv.format);
  if (inv.crs.choixObligatoire || f?.choixCrs === "obligatoire" || inv.format === "CSV") {
    const declare = inv.crs.declareDansLeFichier;
    return { mode: "obligatoire", restreintA: inv.format === "GEOJSON" ? epsgDeCode(declare) : null, declare };
  }
  if (f?.choixCrs === "interdit" || (f === undefined && inv.format !== "GEOJSON")) return { mode: "impose", epsg: epsgDeCode(inv.crs.normeDuFormat) ?? 4326 };
  return { mode: "facultatif" };
}

/** Message d'erreur de l'etape 2 (format et couches), ou null si on peut continuer. */
export function erreurFormat(inv: Inventaire, l: Lecture): string | null {
  if (inv.archive?.choixRequis && !l.entreeKml) return "Cette archive contient plusieurs fichiers KML : choisissez l'entrée à lire.";
  if (inv.couches.filter((c) => c.nbObjets > 0).length > 1 && !l.couche) return "Ce fichier contient plusieurs couches : choisissez celle à importer, ou « toutes les couches » explicitement.";
  if (inv.format === "CSV") {
    const k = l.csv;
    if (!k.mode) return "Choisissez comment lire le tableau : points, lignes construites depuis des points, ou géométrie WKT.";
    if (k.mode === "wkt" && !k.colonneWkt) return "Désignez la colonne qui contient la géométrie WKT.";
    if ((k.mode === "points" || k.mode === "lignes") && (!k.colonneX || !k.colonneY)) return "Désignez les colonnes X et Y (longitude comme X et latitude comme Y pour des degrés).";
    if (k.mode === "lignes" && !k.colonneCle) return "Désignez la colonne qui identifie chaque ligne (clé).";
  }
  return null;
}

/** Message d'erreur de l'etape 3 (CRS), ou null si le choix est complet. Le CRS n'est jamais deduit. */
export function erreurCrs(m: ModeCrs, l: Lecture, autorises: readonly CrsSource[]): string | null {
  if (m.mode === "obligatoire") {
    if (!l.epsgSource) {
      return m.restreintA !== null
        ? `Le fichier déclare EPSG:${m.restreintA} : confirmez ce système en le choisissant. Il n'est jamais appliqué sans votre confirmation.`
        : "Choisissez le système de coordonnées du fichier : il n'est jamais deviné, ni rempli par défaut.";
    }
    if (m.restreintA !== null && Number(l.epsgSource) !== m.restreintA) return `Le fichier déclare EPSG:${m.restreintA} : un système déclaré ne se remplace pas.`;
  }
  if (l.epsgSource && !autorises.some((s) => s.epsg === Number(l.epsgSource) && s.disponible)) return "Ce système n'est pas dans la liste autorisée.";
  return null;
}

/** Valeur d'un attribut d'echantillon, en texte court (jamais du HTML : le composant l'affiche comme texte). */
export function texteAttribut(v: unknown, max = 60): string {
  const t = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v) ?? "";
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** Exemples de valeurs d'une colonne : au plus 3 valeurs distinctes. Colonnes d'un CSV (exemples de l'inventaire) ou attributs de l'echantillon d'un apercu. */
export function exemplesColonne(colonne: string, inv: Inventaire | null, apercu: Apercu | null): string[] {
  const csv = inv?.csv?.colonnes.find((c) => c.nom === colonne);
  if (csv) return csv.exemples.slice(0, 3);
  const vus: string[] = [];
  for (const o of apercu?.echantillon.objets ?? []) {
    const v = o.attributs[colonne];
    if (v === undefined || v === null || v === "") continue;
    const t = texteAttribut(v, 40);
    if (!vus.includes(t)) vus.push(t);
    if (vus.length === 3) break;
  }
  return vus;
}

export const justificationValide = (t: string) => t.trim().length >= JUSTIFICATION_MIN;

/** Peut-on autoriser ? Une version qui retire des objets exige une revue ACCEPTEE (revue humaine justifiee) ; le serveur applique la meme garde (409). */
export function raisonAutorisationBloquee(s: BlocSuppressions | null): string | null {
  if (!s) return null;
  if (s.statut === "A_REVOIR") return `Cette version retire ${formaterNombre(s.nb, 0)} objet(s) de la version autorisée : acceptez ou refusez ces suppressions, avec une justification, avant de pouvoir l'autoriser.`;
  if (s.statut === "REFUSEES") return "Les suppressions ont été refusées à la revue : cette version ne peut plus être autorisée. Rejetez-la, ou déposez un fichier corrigé.";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Avertissements du serveur : libelles accentues par code (le texte du serveur reste le repli)
// ---------------------------------------------------------------------------------------------------

const LIBELLE_AVERTISSEMENT: Record<string, string> = {
  COUCHES_MULTIPLES: "Le fichier contient plusieurs couches. Sans choix de couche, toutes seraient importées.",
  LIGNES_CSV_REJETEES: "Des lignes du tableau ont été rejetées (coordonnées absentes ou illisibles, géométrie invalide). Le détail est donné plus bas.",
  COLONNES_RENOMMEES: "Des colonnes sans nom, en double ou trop longues ont été renommées.",
  HORODATAGES_IGNORES: "Les horodatages et les précisions GPS du fichier GPX sont ignorés.",
  EXTENSION_INCOHERENTE: "L'extension du fichier ne correspond pas à son contenu : le contenu fait foi.",
  ENTREES_ARCHIVE_IGNOREES: "Seule l'entrée KML principale de l'archive est lue : les autres entrées (images, autres KML, ressources) ne sont pas décompressées.",
  MAPPING_VALEURS_MULTIPLES: "Une colonne associée à une valeur du jeu contient plusieurs valeurs distinctes : rien n'est appliqué. Un jeu a un seul concessionnaire et un seul type de réseau : scindez le fichier.",
  MAPPING_VALEUR_INCONNUE: "Une valeur de la colonne associée à un champ du jeu n'est pas reconnue : rien n'est appliqué.",
  MAPPING_CHAMP_IGNORE: "Un champ de la correspondance est ignoré (il ne s'applique pas à ce rôle de fichier).",
  CRS_CHOISI_PAR_UTILISATEUR: "Le système de coordonnées a été choisi par vous : le fichier ne permet pas de le vérifier.",
  ELEMENTS_GPX_IGNORES: "Des éléments du fichier GPX ne sont pas lus.",
  CONCESSIONNAIRE_INCONNU: "Le concessionnaire désigné par la colonne n'est pas connu : un import ne crée jamais de concessionnaire. Choisissez-le dans la liste.",
  ALTITUDE_IGNOREE: "L'altitude des points est ignorée : aucune conclusion en trois dimensions n'est tirée.",
  ELEMENTS_HORS_GUINEE: "Des éléments hors de la Guinée sont écartés et jamais stockés.",
  GEOMETRIES_INVALIDES_IGNOREES: "Des géométries inexploitables sont écartées.",
  GEOMETRIES_REPAREES: "Des géométries invalides ont été réparées par la base.",
  GEOMETRIES_VIDES_IGNOREES: "Des géométries devenues vides après réparation sont ignorées.",
  TRACES_DOUBLES: "Des tracés identiques sont présents plusieurs fois dans le fichier (doublons).",
  OBJETS_SANS_NOM: "Des objets n'ont pas de nom.",
  OBJETS_SANS_GEOMETRIE: "Des objets du fichier n'ont pas de géométrie.",
};

/** Texte d'un avertissement : libelle connu, sinon le texte du serveur. Le nombre concerne est ajoute par l'appelant. */
export function libelleAvertissement(a: Avertissement): string {
  return LIBELLE_AVERTISSEMENT[a.code] ?? a.message;
}

export const LIBELLE_ELEMENT_ECARTE: Record<string, string> = {
  COORDONNEES_HORS_ZONE: "Hors de la zone attendue (la Guinée), ou hors de la plage des degrés : écarté, jamais stocké.",
  GEOMETRIE_INVALIDE: "Géométrie inexploitable (ligne de moins de deux points, anneau dégénéré, coordonnée illisible) : écarté.",
};
export const LIBELLE_PROBLEME_GEOMETRIE: Record<string, string> = {
  GEOMETRIE_VIDE: "Géométrie vide",
  AUTO_INTERSECTION: "Auto-intersection (sera réparée par la base au dépôt)",
  TROP_PEU_DE_POINTS: "Trop peu de points",
  ANNEAU_INVALIDE: "Anneau invalide",
  GEOMETRIE_INVALIDE: "Géométrie invalide",
};
export const LIBELLE_REJET_CSV: Record<string, string> = {
  COORDONNEES_ABSENTES: "Coordonnées absentes",
  COORDONNEES_ILLISIBLES: "Coordonnées illisibles",
  WKT_ABSENT: "Géométrie WKT absente",
  WKT_INVALIDE: "Géométrie WKT invalide",
  CLE_ABSENTE: "Clé de ligne absente",
  ORDRE_ILLISIBLE: "Ordre illisible",
  LIGNE_TROP_COURTE: "Ligne de moins de deux points",
};

export const LIBELLE_DELIMITEUR: Record<string, string> = { ",": "virgule", ";": "point-virgule", "\t": "tabulation", "|": "barre verticale" };
export const LIBELLE_FORMAT: Record<string, string> = { KML: "KML", KMZ: "KMZ (archive KML)", GEOJSON: "GeoJSON", GPX: "GPX", CSV: "Tableau délimité (CSV, TSV, TXT)", ...LIBELLE_FORMAT_GDAL };
export const LIBELLE_CHAMP_CIBLE: Record<string, string> = {
  nom: "Nom de l'objet", identifiant: "Identifiant stable (suivi entre versions)", typeReseau: "Type de réseau", concessionnaire: "Concessionnaire",
  classePrecision: "Classe de précision", precisionHorizontaleM: "Précision horizontale (m)", precisionVerticaleM: "Précision verticale (m)",
  methode: "Méthode de levé", dateDonnees: "Date des données", dateConstat: "Date de constat", natureObjets: "Nature des objets",
  methodeAcquisition: "Méthode d'acquisition (code du référentiel)", connecteA: "Objet connecté (nom d'un objet du même fichier, déclaration du fournisseur)",
};
export const LIBELLE_UNITE: Record<string, string> = { metre: "mètres", degre: "degrés", "pied US": "pieds US", pied: "pieds" };
