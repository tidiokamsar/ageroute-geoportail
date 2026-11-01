/**
 * PARAMETRES DU MOTEUR DE RISQUE ET DE PROGRAMMATION (paragraphe 7.7). AUCUN IMPORT.
 *
 * « Aucun calcul normatif n'est active comme officiel avant approbation des parametres. »
 * (MAINTENANCE_PROGRAMMING_DESIGN.md, paragraphe 7.7 du mandat V10.)
 *
 * CE FICHIER NE CONTIENT AUCUN COEFFICIENT OFFICIEL
 *
 * Les ponderations du risque, la correspondance etat vers risque, les plafonds de normalisation
 * et les seuils de classe de trafic ci-dessous sont des VALEURS D'AMORCAGE DE SIMULATION. Aucune
 * n'a de source, aucune n'a ete arretee par AGEROUTE, l'ONR ou un bailleur. Elles existent pour
 * que le mecanisme soit eprouvable de bout en bout, exactement comme les neuf baremes de cout
 * (D-07) et les quatre niveaux de praticabilite (D-02) sont semes « provisoires ». Une ligne de
 * `parametres_programmation` tant que `approuveeLe` est nul porte l'etiquette
 * « PROVISOIRE, non approuve », et CETTE ETIQUETTE EST REPRISE DANS CHAQUE RESULTAT.
 *
 * Seule exception d'origine : la correspondance etat vers risque est le COMPLEMENT A 100 de la
 * correspondance etat vers score du RCI arretee par le commanditaire (BON 90, MOYEN 65, MAUVAIS
 * 35, CRITIQUE 10, voir D-01). Cette correspondance appartient a une regle RCI desapprouvee : le
 * complement herite donc de ce statut. Il est provisoire aussi.
 *
 * UNE VERSION EST IMMUABLE. Modifier une valeur cree une NOUVELLE version : un scenario calcule
 * l'an dernier doit rester explicable, ce qui suppose que ses parametres n'aient pas change sous
 * lui. Chaque fiche d'intervention embarque d'ailleurs une COPIE INTEGRALE des parametres.
 */

export const ETIQUETTE_PROVISOIRE = "PROVISOIRE, non approuvé";
export const ETIQUETTE_APPROUVE = "paramètres approuvés";

export const FACTEURS_RISQUE = ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE", "CLIMAT", "POPULATION"] as const;
export type FacteurRisque = (typeof FACTEURS_RISQUE)[number];

export const ETATS_PATRIMONIAUX = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE"] as const;
export type EtatEvaluable = (typeof ETATS_PATRIMONIAUX)[number];

export interface ValeursParametres {
  /** Poids de chaque facteur du risque. Leur somme n'a pas a valoir 100 : le moteur renormalise. Un poids nul EXCLUT le facteur. */
  poidsRisque: Record<FacteurRisque, number>;
  /** Etat patrimonial vers niveau de risque 0 a 100. NON_EVALUE n'y figure pas : une absence d'information n'est pas un etat. */
  etatVersRisque: Record<EtatEvaluable, number>;
  /** Trafic (vehicules par jour) a partir duquel le facteur trafic vaut 100. */
  traficPlafondJma: number;
  /** Nombre de points noirs a partir duquel le facteur securite vaut 100. */
  pointsNoirsPlafond: number;
  /** Population desservie a partir de laquelle le facteur vaut 100. */
  populationPlafond: number;
  /** Bornes des classes de trafic des matrices de degradation : sous t1 = T1_faible, sous t2 = T2_moyen, sinon T3_fort. */
  seuilsClasseTrafic: { t1MaxJma: number; t2MaxJma: number };
  /** Nombre minimal de facteurs PONDERES et DISPONIBLES pour rendre un risque (la conception en demande trois). */
  facteursMinimum: number;
  /** Part minimale du poids total qui doit etre couverte (0 a 1). */
  couvertureMinimale: number;
  /** Horizon, en annees, de la projection de degradation (la prevision du PAE est annuelle). */
  horizonAnnees: number;
  /** Risque courant en dessous duquel un troncon n'est pas candidat ; `null` = aucun seuil. */
  seuilRisqueMinimal: number | null;
}

export type SourceParametres = "amorcage_provisoire" | "saisie";

export interface ParametresProgrammation {
  version: string;
  source: SourceParametres;
  /** Horodatage ISO de l'approbation ; `null` = PROVISOIRE, non approuve. */
  approuveeLe: string | null;
  approuveeParId: string | null;
  valeurs: ValeursParametres;
}

export const VERSION_AMORCAGE = "prog-provisoire-1";

/**
 * Valeurs d'amorcage. Chacune est PROVISOIRE et SANS SOURCE (voir l'en-tete). Le semis de la
 * migration `20261023100000_moteur_programmation` doit les reproduire exactement : un test lit le
 * fichier SQL et compare.
 */
export const VALEURS_AMORCAGE_PROVISOIRES: ValeursParametres = {
  poidsRisque: { ETAT: 40, TRAFIC_IMPORTANCE: 25, SECURITE: 15, CLIMAT: 10, POPULATION: 10 },
  etatVersRisque: { BON: 10, MOYEN: 35, MAUVAIS: 65, CRITIQUE: 90 },
  traficPlafondJma: 5000,
  pointsNoirsPlafond: 3,
  populationPlafond: 100000,
  seuilsClasseTrafic: { t1MaxJma: 500, t2MaxJma: 2000 },
  facteursMinimum: 3,
  couvertureMinimale: 0.5,
  horizonAnnees: 1,
  seuilRisqueMinimal: null,
};

export function parametresAmorcage(): ParametresProgrammation {
  return {
    version: VERSION_AMORCAGE,
    source: "amorcage_provisoire",
    approuveeLe: null,
    approuveeParId: null,
    valeurs: structuredClone(VALEURS_AMORCAGE_PROVISOIRES),
  };
}

export function sontProvisoires(p: Pick<ParametresProgrammation, "approuveeLe">): boolean {
  return p.approuveeLe === null || p.approuveeLe === undefined;
}

export function etiquetteParametres(p: Pick<ParametresProgrammation, "approuveeLe">): string {
  return sontProvisoires(p) ? ETIQUETTE_PROVISOIRE : ETIQUETTE_APPROUVE;
}

const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Valide un jeu de valeurs et rend TOUTES les erreurs (pas seulement la premiere), pour qu'un
 * administrateur corrige en une fois. Aucune correction silencieuse.
 */
export function validerValeurs(v: unknown): { ok: true; valeurs: ValeursParametres } | { ok: false; erreurs: string[] } {
  const e: string[] = [];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, erreurs: ["les valeurs doivent etre un objet"] };
  const o = v as Record<string, unknown>;

  const attendues = ["poidsRisque", "etatVersRisque", "traficPlafondJma", "pointsNoirsPlafond", "populationPlafond", "seuilsClasseTrafic", "facteursMinimum", "couvertureMinimale", "horizonAnnees", "seuilRisqueMinimal"];
  for (const k of Object.keys(o)) if (!attendues.includes(k)) e.push(`cle inconnue : ${k}`);
  for (const k of attendues) if (!(k in o)) e.push(`cle manquante : ${k}`);

  const poids = o.poidsRisque as Record<string, unknown> | undefined;
  if (poids && typeof poids === "object") {
    for (const k of Object.keys(poids)) if (!(FACTEURS_RISQUE as readonly string[]).includes(k)) e.push(`poidsRisque : facteur inconnu ${k}`);
    let somme = 0;
    for (const f of FACTEURS_RISQUE) {
      const w = poids[f];
      if (!estNombre(w) || w < 0) e.push(`poidsRisque.${f} : nombre >= 0 attendu`);
      else somme += w;
    }
    if (somme <= 0 && FACTEURS_RISQUE.every((f) => estNombre(poids[f]))) e.push("poidsRisque : la somme des poids doit etre > 0");
  } else if ("poidsRisque" in o) e.push("poidsRisque : objet attendu");

  const ev = o.etatVersRisque as Record<string, unknown> | undefined;
  if (ev && typeof ev === "object") {
    for (const k of Object.keys(ev)) if (!(ETATS_PATRIMONIAUX as readonly string[]).includes(k)) e.push(`etatVersRisque : etat inconnu ${k} (NON_EVALUE n'a pas de risque : c'est une absence)`);
    for (const s of ETATS_PATRIMONIAUX) {
      const x = ev[s];
      if (!estNombre(x) || x < 0 || x > 100) e.push(`etatVersRisque.${s} : nombre entre 0 et 100 attendu`);
    }
    const [b, m, ma, c] = ETATS_PATRIMONIAUX.map((s) => ev[s]);
    if ([b, m, ma, c].every(estNombre) && !((b as number) <= (m as number) && (m as number) <= (ma as number) && (ma as number) <= (c as number))) {
      e.push("etatVersRisque : un etat plus degrade ne peut pas etre moins risque (BON <= MOYEN <= MAUVAIS <= CRITIQUE)");
    }
  } else if ("etatVersRisque" in o) e.push("etatVersRisque : objet attendu");

  for (const k of ["traficPlafondJma", "pointsNoirsPlafond", "populationPlafond"] as const) {
    if (k in o && (!estNombre(o[k]) || (o[k] as number) <= 0)) e.push(`${k} : nombre > 0 attendu`);
  }

  const s = o.seuilsClasseTrafic as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    if (!estNombre(s.t1MaxJma) || s.t1MaxJma <= 0) e.push("seuilsClasseTrafic.t1MaxJma : nombre > 0 attendu");
    if (!estNombre(s.t2MaxJma) || s.t2MaxJma <= 0) e.push("seuilsClasseTrafic.t2MaxJma : nombre > 0 attendu");
    if (estNombre(s.t1MaxJma) && estNombre(s.t2MaxJma) && s.t1MaxJma >= s.t2MaxJma) e.push("seuilsClasseTrafic : t1MaxJma doit etre strictement inferieur a t2MaxJma");
  } else if ("seuilsClasseTrafic" in o) e.push("seuilsClasseTrafic : objet attendu");

  if ("facteursMinimum" in o && (!Number.isInteger(o.facteursMinimum) || (o.facteursMinimum as number) < 1 || (o.facteursMinimum as number) > FACTEURS_RISQUE.length)) {
    e.push(`facteursMinimum : entier entre 1 et ${FACTEURS_RISQUE.length} attendu`);
  }
  if ("couvertureMinimale" in o && (!estNombre(o.couvertureMinimale) || o.couvertureMinimale <= 0 || o.couvertureMinimale > 1)) {
    e.push("couvertureMinimale : nombre dans ]0 ; 1] attendu");
  }
  if ("horizonAnnees" in o && (!Number.isInteger(o.horizonAnnees) || (o.horizonAnnees as number) < 1 || (o.horizonAnnees as number) > 20)) {
    e.push("horizonAnnees : entier entre 1 et 20 attendu");
  }
  if ("seuilRisqueMinimal" in o && o.seuilRisqueMinimal !== null && (!estNombre(o.seuilRisqueMinimal) || o.seuilRisqueMinimal < 0 || o.seuilRisqueMinimal > 100)) {
    e.push("seuilRisqueMinimal : null ou nombre entre 0 et 100 attendu");
  }

  if (e.length > 0) return { ok: false, erreurs: e };
  return { ok: true, valeurs: structuredClone(o) as unknown as ValeursParametres };
}

const FORMAT_VERSION = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function versionValide(v: string): boolean {
  return FORMAT_VERSION.test(v);
}

/** Valide un enregistrement complet de parametres (version, source, approbation, valeurs). */
export function validerParametres(p: ParametresProgrammation): { ok: true } | { ok: false; erreurs: string[] } {
  const e: string[] = [];
  if (!versionValide(p.version)) e.push("version : 3 a 64 caracteres parmi a-z 0-9 . _ -, commencant par une lettre ou un chiffre");
  if ((p.approuveeLe === null) !== (p.approuveeParId === null)) e.push("une approbation porte sa date ET son approbateur, ou ni l'un ni l'autre");
  const r = validerValeurs(p.valeurs);
  if (!r.ok) e.push(...r.erreurs);
  return e.length > 0 ? { ok: false, erreurs: e } : { ok: true };
}
