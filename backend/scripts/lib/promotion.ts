/**
 * Garde-fous de la promotion de voirie locale en troncons.
 *
 * Isoles du script pour etre testables sans base. Ce sont eux qui empechent la
 * commande de deraper : une emprise absente promouvrait 262 656 voies d'un coup,
 * une categorie inventee passerait en SQL, un etat inconnu ferait echouer l'insert
 * apres la creation des troncons.
 */

export const CATEGORIES_VALIDES = [
  "VOIE_RAPIDE", "PRINCIPALE", "SECONDAIRE", "TERTIAIRE",
  "VOIE_LOCALE", "RESIDENTIELLE", "ACCES",
  "CHEMIN", "SENTIER", "PIETON", "INCONNU",
] as const;

export const ETATS_VALIDES = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"] as const;
export const CLASSES_VALIDES = ["RN", "RR", "RU", "PISTE"] as const;

/** Meme plafond que l'API cartographique : au-dela, ce n'est plus une promotion. */
export const SURFACE_MAX_DEG2 = 0.25;

/** Libelle de repli pour les voies qu'OSM ne nomme pas. `Troncon.nom` est non nul. */
export const LIBELLE: Record<string, string> = {
  VOIE_RAPIDE: "Voie rapide", PRINCIPALE: "Route principale",
  SECONDAIRE: "Route secondaire", TERTIAIRE: "Route tertiaire",
  VOIE_LOCALE: "Voie locale", RESIDENTIELLE: "Voie résidentielle",
  ACCES: "Desserte", CHEMIN: "Chemin", SENTIER: "Sentier",
  PIETON: "Voie piétonne", INCONNU: "Voie",
};

export type Emprise = [number, number, number, number];

export function analyserEmprise(brut: string | undefined): Emprise {
  if (!brut) {
    throw new Error("--bbox est obligatoire : ce script ne s'execute pas sur tout le pays.");
  }
  const p = brut.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error("--bbox attend ouest,sud,est,nord");
  }
  const [o, s, e, n] = p as Emprise;
  if (o >= e || s >= n) throw new Error("--bbox : ouest<est et sud<nord");
  if (Math.abs(o) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90) {
    throw new Error("--bbox : coordonnees hors du domaine WGS 84");
  }
  const surface = (e - o) * (n - s);
  if (surface > SURFACE_MAX_DEG2) {
    throw new Error(`Emprise trop large (${surface.toFixed(3)} deg² pour ${SURFACE_MAX_DEG2} max).`);
  }
  return [o, s, e, n];
}

/** Liste blanche : une valeur inventee est ecartee, elle n'atteint jamais le SQL. */
export function analyserCategories(brut: string | undefined): string[] {
  const demandees = (brut ?? "VOIE_LOCALE,RESIDENTIELLE,ACCES,CHEMIN")
    .split(",").map((c) => c.trim().toUpperCase())
    .filter((c) => (CATEGORIES_VALIDES as readonly string[]).includes(c));
  if (demandees.length === 0) throw new Error("--categories : aucune categorie valide.");
  return [...new Set(demandees)];
}

/**
 * Le prefixe entre dans le code du troncon, qui est unique et sert de marqueur de
 * retour arriere. On le reduit a l'alphanumerique plutot que de l'echapper : un
 * prefixe exotique rendrait les codes illisibles pour les agents.
 */
export function analyserPrefixe(brut: string | undefined): string {
  const p = (brut ?? "LOC").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!p) throw new Error("--prefixe : au moins un caractere alphanumerique.");
  return p;
}

export function analyserEtat(brut: string | undefined): string {
  const e = (brut ?? "NON_EVALUE").toUpperCase();
  if (!(ETATS_VALIDES as readonly string[]).includes(e)) {
    throw new Error(`--etat invalide : ${e}`);
  }
  return e;
}

export function analyserClasse(brut: string | undefined): string {
  const c = (brut ?? "RU").toUpperCase();
  if (!(CLASSES_VALIDES as readonly string[]).includes(c)) {
    throw new Error(`--classe invalide : ${c}`);
  }
  return c;
}

/**
 * Un etat autre que NON_EVALUE n'est pas une mesure : personne n'a inspecte ces
 * voies. Il est accepte comme DECLARATION et trace comme tel, pour qu'un indicateur
 * d'etat du reseau puisse l'exclure.
 */
export function estDeclaration(etat: string): boolean {
  return etat !== "NON_EVALUE";
}

/**
 * Libelle par categorie, en SQL. Les cles viennent de la liste blanche et les
 * valeurs sont des litteraux de ce module : aucune entree utilisateur n'y entre.
 */
export function casLibelleSql(colonne = 'v.categorie::text'): string {
  const branches = CATEGORIES_VALIDES
    .map((c) => `when '${c}' then '${(LIBELLE[c] ?? "Voie").replace(/'/g, "''")}'`)
    .join(" ");
  return `case ${colonne} ${branches} else 'Voie' end`;
}
