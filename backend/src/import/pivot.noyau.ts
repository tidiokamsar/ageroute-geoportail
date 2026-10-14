/**
 * FORMAT PIVOT OUVERT et noyau de l'importateur. AUCUN IMPORT.
 *
 * Paragraphe 7.15 du mandat V10 : « format pivot ouvert documente (CSV + GeoPackage + GeoJSON,
 * dictionnaire de donnees, SRID 4326) ; les formats proprietaires sont traites par des
 * adaptateurs isoles derriere des interfaces ». Paragraphe B.1 : le pivot « ne depend d'aucune
 * reponse de l'ONR », et c'est pourquoi il est construit en premier -- il sert aux trois options
 * d'echange de BDR_INTEROPERABILITY_OPTIONS.md.
 *
 * CE QUE CE FICHIER FAIT : lire et ecrire le pivot en CSV et en GeoJSON, verifier qu'une ligne
 * respecte le contrat, et COMPTABILISER un lot de sorte que 100 % des lignes aient exactement
 * un statut (critere A28). Il ne touche ni base, ni fichier, ni reseau : il transforme des
 * valeurs en valeurs, et c'est ce qui le rend testable sans rien.
 *
 * CE QU'IL NE FAIT PAS, ET LE DIT : le GEOPACKAGE. Un GeoPackage est une base SQLite, et ce
 * paquet n'a aucune dependance SQLite (verifie dans package.json le 14/10). Plutot que
 * d'ajouter une bibliotheque sans l'avoir choisie, le pivot est livre en CSV et GeoJSON --
 * les deux sont textuels, lisibles sans outil, et suffisent a l'option A d'echange de fichiers.
 * Le GeoPackage est un ECART CONSIGNE, pas un oubli.
 *
 * LES DEUX REGLES QUI NE SE DISCUTENT PAS
 *
 * 1. SRID 4326, et rien d'autre, en entree comme en sortie. Un fichier en UTM 28N est un
 *    fichier a convertir par un adaptateur AVANT le pivot, et la conversion est une
 *    transformation declaree sur la ligne. Le pivot refuse une geometrie dont le SRID n'est
 *    pas 4326 ou n'est pas declare : accepter « probablement 4326 » placerait des routes de
 *    Guinee dans l'Atlantique sans qu'aucun test ne le voie.
 *
 * 2. UNE LIGNE REJETEE PORTE SON MOTIF. « Rejetee » sans raison n'apprend rien a la source et
 *    ne se corrige pas. Chaque verification de ce fichier rend une raison en clair.
 */

/** Types d'objet que le pivot transporte. Fermes ici, administrables en base (lecon D-06). */
export type TypeObjetPivot = "troncon" | "portion" | "degradation" | "ouvrage" | "comptage";

export const TYPES_OBJET_PIVOT: readonly TypeObjetPivot[] = [
  "troncon", "portion", "degradation", "ouvrage", "comptage",
];

/** Le seul SRID admis. */
export const SRID_PIVOT = 4326;

/**
 * Une ligne du pivot, independante du format qui la portait.
 *
 * Les champs sont ceux de BDR_FIELD_MAPPING_TEMPLATE.csv cote cible. Tout ce que la source
 * fournit en plus reste dans `attributs`, intact : on ne jette rien de ce qu'on a recu.
 */
export interface LignePivot {
  systemeSource: string;
  typeObjet: TypeObjetPivot;
  identifiantSource: string;
  /** Code de route ou de troncon tel que la source le nomme, s'il existe. */
  codeRoute?: string | null;
  /** Abscisses en metres, pour une portion ou une degradation lineaire. */
  debutM?: number | null;
  finM?: number | null;
  /** Geometrie GeoJSON en 4326, ou nulle pour un objet non localise (comptage par exemple). */
  geometrie?: GeometriePivot | null;
  /** Date du releve chez la source, ISO 8601, si connue. */
  dateSource?: string | null;
  attributs: Record<string, string | number | boolean | null>;
}

export type GeometriePivot =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] };

/** Verdict sur une ligne : acceptee telle quelle, ou refusee avec sa raison. */
export type VerdictLigne =
  | { ok: true; ligne: LignePivot }
  | { ok: false; motif: string };

export type StatutLigne = "IMPORTEE" | "REJETEE" | "EN_CONFLIT" | "IGNOREE";

export interface Compteurs {
  lues: number;
  importees: number;
  rejetees: number;
  enConflit: number;
  ignorees: number;
}

/* ============================== Verification d'une ligne ============================== */

function estNombreFini(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Verifie une geometrie : type connu, coordonnees finies, et DANS L'ETENDUE de WGS 84.
 *
 * L'etendue est le seul controle de SRID possible sans metadonnee : une coordonnee de
 * 7 500 000 ne peut pas etre une longitude, donc le fichier n'etait pas en 4326 quoi qu'il
 * pretende. Le motif le dit en ces termes, pour que la source corrige la bonne chose.
 */
export function verifierGeometrie(g: unknown): { ok: true; geometrie: GeometriePivot } | { ok: false; motif: string } {
  if (g === null || typeof g !== "object") return { ok: false, motif: "geometrie absente ou non structuree" };
  const o = g as { type?: unknown; coordinates?: unknown };

  const point = (c: unknown): c is [number, number] =>
    Array.isArray(c) && c.length === 2 && estNombreFini(c[0]) && estNombreFini(c[1]);
  const dansEtendue = ([lon, lat]: [number, number]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;

  if (o.type === "Point") {
    if (!point(o.coordinates)) return { ok: false, motif: "Point : coordonnees attendues [lon, lat] finies" };
    if (!dansEtendue(o.coordinates)) {
      return { ok: false, motif: `Point hors de l'etendue WGS 84 (${o.coordinates.join(", ")}) : le fichier n'est pas en SRID ${SRID_PIVOT}` };
    }
    return { ok: true, geometrie: { type: "Point", coordinates: o.coordinates } };
  }

  if (o.type === "LineString") {
    const cs = o.coordinates;
    if (!Array.isArray(cs) || cs.length < 2 || !cs.every(point)) {
      return { ok: false, motif: "LineString : au moins deux positions [lon, lat] finies attendues" };
    }
    const hors = (cs as [number, number][]).find((c) => !dansEtendue(c));
    if (hors) {
      return { ok: false, motif: `LineString hors de l'etendue WGS 84 (${hors.join(", ")}) : le fichier n'est pas en SRID ${SRID_PIVOT}` };
    }
    return { ok: true, geometrie: { type: "LineString", coordinates: cs as [number, number][] } };
  }

  return { ok: false, motif: `type de geometrie non admis par le pivot : ${String(o.type)}` };
}

/**
 * Verifie une ligne brute et la normalise en `LignePivot`, ou la refuse avec un motif.
 *
 * L'ORDRE DES CONTROLES EST VOLONTAIRE : identite d'abord, geometrie ensuite. Une ligne sans
 * identifiant source ne pourra jamais etre rapprochee (BDR_ID_CROSSWALK_SPEC.md, etape 1) : le
 * dire avant de parler de sa geometrie envoie la source corriger ce qui compte.
 */
export function verifierLigne(brute: Record<string, unknown>): VerdictLigne {
  const texte = (k: string): string | null => {
    const v = brute[k];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };

  const systemeSource = texte("systeme_source");
  if (!systemeSource) return { ok: false, motif: "systeme_source manquant" };

  const typeObjet = texte("type_objet");
  if (!typeObjet || !(TYPES_OBJET_PIVOT as readonly string[]).includes(typeObjet)) {
    return { ok: false, motif: `type_objet absent ou inconnu : ${typeObjet ?? "(vide)"} ; admis : ${TYPES_OBJET_PIVOT.join(", ")}` };
  }

  const identifiantSource = texte("identifiant_source");
  if (!identifiantSource) {
    return { ok: false, motif: "identifiant_source manquant : sans lui, aucun rapprochement n'est possible" };
  }

  const nombreOuNul = (k: string): number | null | "invalide" => {
    const v = brute[k];
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : "invalide";
  };
  const debutM = nombreOuNul("debut_m");
  const finM = nombreOuNul("fin_m");
  if (debutM === "invalide" || finM === "invalide") return { ok: false, motif: "debut_m / fin_m non numeriques" };
  if ((debutM === null) !== (finM === null)) return { ok: false, motif: "debut_m et fin_m doivent etre fournis ensemble" };
  if (debutM !== null && finM !== null && (debutM < 0 || finM <= debutM)) {
    return { ok: false, motif: `emprise incoherente : [${debutM}, ${finM}) -- fin_m doit depasser debut_m, debut_m >= 0` };
  }

  let geometrie: GeometriePivot | null = null;
  if (brute.geometrie !== undefined && brute.geometrie !== null && brute.geometrie !== "") {
    let g: unknown = brute.geometrie;
    if (typeof g === "string") {
      try { g = JSON.parse(g); } catch { return { ok: false, motif: "geometrie : JSON invalide" }; }
    }
    const v = verifierGeometrie(g);
    if (!v.ok) return { ok: false, motif: v.motif };
    geometrie = v.geometrie;
  }

  // Un troncon ou un ouvrage sans geometrie ni emprise n'est localise par rien.
  if ((typeObjet === "troncon" || typeObjet === "ouvrage") && geometrie === null) {
    return { ok: false, motif: `un(e) ${typeObjet} sans geometrie n'est localise(e) par rien` };
  }
  if (typeObjet === "portion" && geometrie === null && debutM === null) {
    return { ok: false, motif: "une portion sans emprise ni geometrie n'est localisee par rien" };
  }

  const dateSource = texte("date_source");
  if (dateSource !== null && Number.isNaN(Date.parse(dateSource))) {
    return { ok: false, motif: `date_source non interpretable : ${dateSource}` };
  }

  // Tout le reste est conserve tel quel : on ne jette rien de ce qu'on a recu.
  const reserves = new Set(["systeme_source", "type_objet", "identifiant_source", "code_route", "debut_m", "fin_m", "geometrie", "date_source"]);
  const attributs: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(brute)) {
    if (reserves.has(k)) continue;
    attributs[k] = v === undefined ? null : (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) ? v : String(v);
  }

  return {
    ok: true,
    ligne: {
      systemeSource,
      typeObjet: typeObjet as TypeObjetPivot,
      identifiantSource,
      codeRoute: texte("code_route"),
      debutM,
      finM,
      geometrie,
      dateSource,
      attributs,
    },
  };
}

/* ================================= Comptabilisation ================================= */

/**
 * Compte un lot de verdicts de sorte que CHAQUE ligne ait exactement un statut.
 *
 * C'est le critere A28 rendu arithmetique : lues = importees + rejetees + enConflit + ignorees,
 * et la contrainte `lot_compteurs_complets` le re-verifie en base. Les deux ensemble font
 * qu'une ligne perdue en route ne peut pas passer inapercue.
 */
export function comptabiliser(statuts: readonly StatutLigne[]): Compteurs {
  const c: Compteurs = { lues: statuts.length, importees: 0, rejetees: 0, enConflit: 0, ignorees: 0 };
  for (const s of statuts) {
    if (s === "IMPORTEE") c.importees += 1;
    else if (s === "REJETEE") c.rejetees += 1;
    else if (s === "EN_CONFLIT") c.enConflit += 1;
    else c.ignorees += 1;
  }
  return c;
}

/** Vrai si les compteurs se somment : la propriete que la base impose, verifiable avant elle. */
export function compteursComplets(c: Compteurs): boolean {
  return c.lues === c.importees + c.rejetees + c.enConflit + c.ignorees;
}

/* ===================================== CSV ===================================== */

/** Separateur du pivot : le point-virgule, parce que les libelles contiennent des virgules. */
export const SEPARATEUR_CSV = ";";

/** Colonnes du pivot CSV, dans cet ordre. Le dictionnaire de donnees est dans l'en-tete du fichier. */
export const COLONNES_PIVOT = [
  "systeme_source", "type_objet", "identifiant_source", "code_route",
  "debut_m", "fin_m", "geometrie", "date_source",
] as const;

/**
 * Decoupe une ligne CSV en respectant les guillemets doubles (RFC 4180, separateur `;`).
 * Un guillemet dans un champ cite s'ecrit `""`.
 */
export function decouperLigneCsv(ligne: string, sep: string = SEPARATEUR_CSV): string[] {
  const champs: string[] = [];
  let courant = "";
  let cite = false;
  for (let i = 0; i < ligne.length; i += 1) {
    const ch = ligne[i];
    if (cite) {
      if (ch === '"') {
        if (ligne[i + 1] === '"') { courant += '"'; i += 1; }
        else cite = false;
      } else courant += ch;
    } else if (ch === '"') cite = true;
    else if (ch === sep) { champs.push(courant); courant = ""; }
    else courant += ch;
  }
  champs.push(courant);
  return champs;
}

function citerCsv(v: unknown, sep: string = SEPARATEUR_CSV): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Lit un pivot CSV : premiere ligne = en-tete, puis une ligne par objet. Rend des lignes BRUTES
 * (chaines), a passer a `verifierLigne`. Les lignes vides sont ignorees et comptees comme telles
 * par l'appelant si elles portaient un numero.
 *
 * Les colonnes inconnues ne sont PAS rejetees : elles finissent dans `attributs`. Rejeter une
 * colonne de plus perdrait de l'information que la source a jugee utile.
 */
export function lireCsv(texte: string, sep: string = SEPARATEUR_CSV): { entete: string[]; lignes: Record<string, string>[] } {
  const lignesBrutes = texte.replace(/^﻿/, "").split(/\r?\n/);
  const premiere = lignesBrutes.findIndex((l) => l.trim().length > 0 && !l.startsWith("#"));
  if (premiere < 0) return { entete: [], lignes: [] };
  const entete = decouperLigneCsv(lignesBrutes[premiere], sep).map((h) => h.trim());
  const lignes: Record<string, string>[] = [];
  for (let i = premiere + 1; i < lignesBrutes.length; i += 1) {
    const l = lignesBrutes[i];
    if (l.trim().length === 0 || l.startsWith("#")) continue;
    const champs = decouperLigneCsv(l, sep);
    const obj: Record<string, string> = {};
    entete.forEach((h, k) => { obj[h] = champs[k] ?? ""; });
    lignes.push(obj);
  }
  return { entete, lignes };
}

/** Ecrit un pivot CSV : en-tete fixe, attributs supplementaires en colonnes additionnelles. */
export function ecrireCsv(lignes: readonly LignePivot[], sep: string = SEPARATEUR_CSV): string {
  const supplementaires = Array.from(new Set(lignes.flatMap((l) => Object.keys(l.attributs)))).sort();
  const entete = [...COLONNES_PIVOT, ...supplementaires];
  const corps = lignes.map((l) => {
    const base = [
      l.systemeSource, l.typeObjet, l.identifiantSource, l.codeRoute ?? "",
      l.debutM ?? "", l.finM ?? "", l.geometrie ? JSON.stringify(l.geometrie) : "", l.dateSource ?? "",
    ];
    const extra = supplementaires.map((k) => l.attributs[k] ?? "");
    return [...base, ...extra].map((v) => citerCsv(v, sep)).join(sep);
  });
  return [entete.join(sep), ...corps].join("\n") + "\n";
}

/* ==================================== GeoJSON ==================================== */

export interface FeatureCollectionPivot {
  type: "FeatureCollection";
  /** Le SRID est declare explicitement dans la collection, en plus d'etre impose. */
  crs: { type: "name"; properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } };
  features: {
    type: "Feature";
    geometry: GeometriePivot | null;
    properties: Record<string, unknown>;
  }[];
}

/** Ecrit un pivot GeoJSON. Les champs du contrat deviennent des proprietes, la geometrie reste geometrie. */
export function ecrireGeoJson(lignes: readonly LignePivot[]): FeatureCollectionPivot {
  return {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: lignes.map((l) => ({
      type: "Feature",
      geometry: l.geometrie ?? null,
      properties: {
        systeme_source: l.systemeSource,
        type_objet: l.typeObjet,
        identifiant_source: l.identifiantSource,
        code_route: l.codeRoute ?? null,
        debut_m: l.debutM ?? null,
        fin_m: l.finM ?? null,
        date_source: l.dateSource ?? null,
        ...l.attributs,
      },
    })),
  };
}

/**
 * Lit un pivot GeoJSON et rend des lignes BRUTES a passer a `verifierLigne`.
 *
 * Refuse une collection qui declare un autre CRS que CRS84 / 4326 : c'est la regle 1. Une
 * collection sans `crs` est acceptee -- la specification GeoJSON actuelle (RFC 7946) impose
 * WGS 84 et a retire le membre -- mais l'etendue des coordonnees reste controlee ligne a ligne.
 */
export function lireGeoJson(doc: unknown): { ok: true; lignes: Record<string, unknown>[] } | { ok: false; motif: string } {
  if (doc === null || typeof doc !== "object") return { ok: false, motif: "GeoJSON : document non structure" };
  const d = doc as { type?: unknown; crs?: unknown; features?: unknown };
  if (d.type !== "FeatureCollection") return { ok: false, motif: `GeoJSON : FeatureCollection attendue, recu ${String(d.type)}` };

  if (d.crs !== undefined && d.crs !== null) {
    const nom = (d.crs as { properties?: { name?: unknown } }).properties?.name;
    const admis = typeof nom === "string" && /CRS84|EPSG:+4326|4326/.test(nom);
    if (!admis) return { ok: false, motif: `GeoJSON : CRS ${String(nom)} refuse, le pivot impose le SRID ${SRID_PIVOT}` };
  }

  if (!Array.isArray(d.features)) return { ok: false, motif: "GeoJSON : features absent" };
  const lignes = (d.features as unknown[]).map((f) => {
    const feat = (f ?? {}) as { geometry?: unknown; properties?: unknown };
    const props = (feat.properties && typeof feat.properties === "object") ? (feat.properties as Record<string, unknown>) : {};
    return { ...props, geometrie: feat.geometry ?? null };
  });
  return { ok: true, lignes };
}

/* ================================= Idempotence ================================= */

/**
 * Cle d'idempotence d'une ligne : (empreinte du fichier, numero de ligne).
 *
 * L'empreinte vient de l'appelant, calculee sur les OCTETS recus, parce que ce noyau n'a pas
 * de dependance cryptographique et n'en veut pas. La forme attendue est celle que la base
 * impose : 64 caracteres hexadecimaux. Rendre `null` plutot qu'une cle fausse si l'empreinte ne
 * l'est pas -- une cle d'idempotence douteuse est pire qu'absente.
 */
export function cleIdempotence(empreinteFichier: string, numeroLigne: number): string | null {
  if (!/^[0-9a-f]{64}$/.test(empreinteFichier)) return null;
  if (!Number.isInteger(numeroLigne) || numeroLigne < 1) return null;
  return `${empreinteFichier}:${numeroLigne}`;
}
