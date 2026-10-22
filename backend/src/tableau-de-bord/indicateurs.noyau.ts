/**
 * Registre d'indicateurs du tableau de bord et de la Control Tower : regles pures, sans import
 * applicatif (A12, « chaque indicateur egal a sa requete de controle »).
 *
 * CE QU'EST UN INDICATEUR ICI
 *
 * Un indicateur n'est pas un nombre : c'est un nombre, le PERIMETRE sur lequel il est calcule, la
 * requete qui le calcule ET une seconde requete, ecrite autrement, qui doit rendre la meme valeur.
 * Un indicateur sans perimetre dit un chiffre sans denominateur ; un indicateur sans controle est un
 * chiffre que personne ne peut contredire. Le registre refuse l'un comme l'autre
 * (`defautsRegistre`, garde par un test).
 *
 * LE PERIMETRE EST AFFICHE, JAMAIS DEDUIT. Un indicateur dont le perimetre est le reseau classe saisi
 * ne s'appelle pas « reseau national » : la base porte une fraction du reseau annonce par les TDR de
 * la BDR (decision D-06), et un libelle qui l'oublierait ferait passer une couverture partielle pour un
 * etat du pays.
 *
 * LE CONTROLE EST INDEPENDANT. Il ne rappelle pas la fonction de calcul : il emprunte un autre chemin
 * (autre requete, autre agregation, ou une fonction de domaine deja eprouvee) pour la meme question.
 * Deux chemins qui s'accordent sur des fixtures connues, et sur une valeur attendue calculee a la main,
 * disent que l'indicateur mesure ce qu'il annonce.
 */

/** Valeur d'un indicateur. Une chaine de chiffres pour un montant en GNF (au-dela de 2^53), `null` quand rien n'est calculable. */
export type Valeur = number | string | null;

export type Unite = "nombre" | "km" | "GNF" | "part";

export type Groupe = "reseau" | "portions" | "qualite" | "veille" | "patrouilles" | "teledetection" | "programmation";

export const GROUPES: readonly Groupe[] = ["reseau", "portions", "qualite", "veille", "patrouilles", "teledetection", "programmation"];

/** Sur quoi porte un indicateur. Les trois champs sont obligatoires et affiches. */
export interface PerimetreIndicateur {
  code: string;
  libelle: string;
  definition: string;
}

/** Ce que la requete de calcul ou de controle recoit : les regions en portee (`null` = national) et l'instant. */
export interface Portee {
  regions: readonly number[] | null;
  maintenant: Date;
}

/** La table qui alimente l'indicateur : si elle est vide dans la portee, le module dit « aucune donnee ». */
export interface SourceIndicateur<D> {
  cle: string;
  libelle: string;
  vide: (depot: D, portee: Portee) => Promise<boolean>;
}

export interface DefinitionIndicateur<D> {
  code: string;
  libelle: string;
  groupe: Groupe;
  unite: Unite;
  perimetre: PerimetreIndicateur;
  /**
   * Peut-on le calculer pour une ou plusieurs regions ? Faux : l'indicateur n'a pas de ventilation
   * regionale (valeurs de qualite, documents sans region, regles d'escalade). Un compte regional ne
   * recoit alors AUCUNE valeur nationale a sa place (A10) : il lit « indisponible hors perimetre national ».
   */
  regionalisable: boolean;
  calcul: (depot: D, portee: Portee) => Promise<Valeur>;
  controle: (depot: D, portee: Portee) => Promise<Valeur>;
  source?: SourceIndicateur<D>;
}

/** Tolerance d'egalite par unite : exacte pour les entiers et les montants, a l'arrondi pres pour les mesures. */
const TOLERANCE: Record<Unite, number> = { nombre: 0, GNF: 0, km: 0.011, part: 0.0011 };

/**
 * Deux valeurs sont-elles « egales » au sens du controle ? `null` n'est egal qu'a `null` : un calcul
 * qui rend 0 quand le controle rend « rien a mesurer » est un desaccord, pas un accord.
 */
export function valeursEgales(a: Valeur, b: Valeur, unite: Unite): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a === b;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= TOLERANCE[unite];
}

/** Regions du perimetre d'un compte, ou `null` s'il est national. Lit la forme de `territoire.noyau.ts` sans l'importer. */
export function regionsDuPerimetre(p: { national: true } | { national: false; regions: ReadonlySet<number> }): number[] | null {
  return p.national ? null : [...p.regions].sort((x, y) => x - y);
}

export type Disponibilite = { disponible: true } | { disponible: false; motif: string };

/** Un compte regional ne lit que ce qui se ventile par region : le reste est refuse, pas remplace par du national. */
export function disponibilite(def: Pick<DefinitionIndicateur<unknown>, "regionalisable">, portee: Pick<Portee, "regions">): Disponibilite {
  if (portee.regions === null || def.regionalisable) return { disponible: true };
  return {
    disponible: false,
    motif: "Cet indicateur n'existe qu'au niveau national : il n'est pas ventile par region, donc non communique a un compte regional.",
  };
}

const CODE_VALIDE = /^[a-z][a-z0-9_]*$/;
/** Un perimetre « reseau classe saisi » ne peut pas se dire « reseau national » (D-06). */
const FAUX_NATIONAL = /r[eé]seau\s+national/i;

/**
 * Anomalies du registre ; vide si le registre est conforme. Le test unitaire exige un registre vide de
 * defauts : aucun indicateur sans perimetre, sans controle, ou dont le controle est le calcul.
 */
export function defautsRegistre<D>(registre: readonly DefinitionIndicateur<D>[]): string[] {
  const defauts: string[] = [];
  const codes = new Set<string>();
  if (registre.length === 0) defauts.push("registre vide");
  for (const d of registre) {
    const nom = d.code || "(sans code)";
    if (!d.code || !CODE_VALIDE.test(d.code)) defauts.push(`${nom} : code absent ou invalide (minuscules, chiffres, souligne)`);
    if (codes.has(d.code)) defauts.push(`${nom} : code en double`);
    codes.add(d.code);
    if (!d.libelle?.trim()) defauts.push(`${nom} : libelle absent`);
    if (!GROUPES.includes(d.groupe)) defauts.push(`${nom} : groupe inconnu`);
    if (!d.perimetre || !d.perimetre.code?.trim() || !d.perimetre.libelle?.trim() || !d.perimetre.definition?.trim()) {
      defauts.push(`${nom} : perimetre absent ou incomplet (code, libelle et definition sont obligatoires)`);
    } else if (FAUX_NATIONAL.test(d.libelle) || FAUX_NATIONAL.test(d.perimetre.libelle)) {
      defauts.push(`${nom} : le libelle ne doit pas dire « reseau national » (le perimetre est celui de la base saisie)`);
    }
    if (typeof d.calcul !== "function") defauts.push(`${nom} : requete de calcul absente`);
    if (typeof d.controle !== "function") defauts.push(`${nom} : requete de controle absente`);
    else if (d.controle === d.calcul) defauts.push(`${nom} : le controle est la fonction de calcul elle-meme (il doit etre independant)`);
    if (typeof d.regionalisable !== "boolean") defauts.push(`${nom} : regionalisable doit etre declare`);
  }
  return defauts;
}

/** Une evaluation qui cede la place a la suivante : `fn` n'est jamais lance plus de `limite` fois a la fois. */
export async function enParallele<T, R>(items: readonly T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const resultats: R[] = new Array(items.length);
  let prochain = 0;
  async function travailleur(): Promise<void> {
    while (prochain < items.length) {
      const i = prochain++;
      resultats[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, travailleur));
  return resultats;
}
