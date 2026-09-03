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
export const REVETEMENTS_VALIDES = ["BITUME", "TERRE", "LATERITE", "PAVE", "NON_RENSEIGNE"] as const;
export const CLASSES_VALIDES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;

/**
 * Surface maximale d'une emprise DECOUPEE en tuiles.
 *
 * L'etendue de la Guinee fait environ 42 deg². Le plafond de 0,25 deg² protege une
 * promotion ponctuelle d'un derapage ; il n'a pas de sens pour une execution
 * nationale assumee, qui traite le pays tuile par tuile. Ce second plafond borne
 * quand meme la commande : au-dela, c'est une faute de frappe, pas une intention.
 */
export const SURFACE_MAX_TUILEE_DEG2 = 100;

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

/**
 * Emprise etendue, destinee au decoupage en tuiles.
 *
 * Meme validation de forme que `analyserEmprise`, plafond different : ici on accepte
 * l'echelle d'un pays parce que le traitement, lui, restera cadre tuile par tuile.
 */
export function analyserEmpriseEtendue(brut: string | undefined): Emprise {
  const e = analyserForme(brut);
  const surface = (e[2] - e[0]) * (e[3] - e[1]);
  if (surface > SURFACE_MAX_TUILEE_DEG2) {
    throw new Error(
      `Emprise de ${surface.toFixed(1)} deg² : au-dela de ${SURFACE_MAX_TUILEE_DEG2}, ` +
      "c'est une erreur de saisie plutot qu'une intention.",
    );
  }
  return e;
}

/**
 * Decoupe une emprise en tuiles dont chacune respecte le plafond ordinaire.
 *
 * POURQUOI TUILE PAR TUILE ET NON D'UN SEUL BLOC
 *
 * Une transaction unique sur 262 306 lignes tiendrait un verrou long sur `troncons`
 * pendant que l'application sert la carte, et un echec a la 250 000e ligne annulerait
 * tout. Une tuile est une transaction : ce qui est pose reste pose, et la reprise est
 * gratuite puisque le script est idempotent.
 *
 * Une voie a cheval sur deux tuiles est vue par les deux — `&&` teste l'intersection.
 * La seconde ne la reprend pas : elle n'a plus `tronconId IS NULL`, et son code est
 * deja pris.
 */
export function decouperEnTuiles(e: Emprise, cote = 0.5): Emprise[] {
  if (cote <= 0 || cote * cote > SURFACE_MAX_DEG2) {
    throw new Error(`Cote de tuile invalide : ${cote}² doit tenir sous ${SURFACE_MAX_DEG2} deg².`);
  }
  const [ouest, sud, est, nord] = e;
  const tuiles: Emprise[] = [];
  for (let x = ouest; x < est; x += cote) {
    for (let y = sud; y < nord; y += cote) {
      tuiles.push([x, y, Math.min(x + cote, est), Math.min(y + cote, nord)]);
    }
  }
  return tuiles;
}

export function analyserEmprise(brut: string | undefined): Emprise {
  const [o, s, e, n] = analyserForme(brut);
  const surface = (e - o) * (n - s);
  if (surface > SURFACE_MAX_DEG2) {
    throw new Error(`Emprise trop large (${surface.toFixed(3)} deg² pour ${SURFACE_MAX_DEG2} max).`);
  }
  return [o, s, e, n];
}

function analyserForme(brut: string | undefined): Emprise {
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
 * Meme raisonnement pour le revetement.
 *
 * NON_RENSEIGNE est la verite par defaut : la source decrit la praticabilite, pas la
 * couche de roulement. Toute autre valeur vient d'un gestionnaire qui connait le
 * terrain — « les grands axes du Grand Conakry sont en bitume » est une affirmation
 * plausible et utile, mais ce n'est pas un releve. Elle est donc acceptee et tracee
 * comme declaration, jamais presentee comme constatee.
 */
export function analyserRevetement(brut: string | undefined): string {
  const r = (brut ?? "NON_RENSEIGNE").toUpperCase();
  if (!(REVETEMENTS_VALIDES as readonly string[]).includes(r)) {
    throw new Error(`--revetement invalide : ${r}`);
  }
  return r;
}

export function revetementDeclare(revetement: string): boolean {
  return revetement !== "NON_RENSEIGNE";
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
