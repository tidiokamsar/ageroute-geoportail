/**
 * Curseur temporel du géoportail (paragraphe 7.14 ; § 7.16 ligne 3, « carte du réseau par année »).
 *
 * LA LOGIQUE, SANS LA CARTE : dates, lien partageable, bornes, et les phrases que l'écran doit
 * dire. Elles comptent plus que le reste : un curseur sans explication se lit « le réseau était vide
 * à cette date », alors que la vérité est « personne n'a encore saisi quand cet état est devenu vrai ».
 *
 * LE CURSEUR NE MONTRE QUE LE PASSÉ ET LE PRÉSENT. Une carte des années futures suppose des scénarios
 * de programmation que le mandat n'a pas arrêtés : aucune date postérieure à aujourd'hui n'est
 * proposée ni acceptée, y compris par un lien forgé.
 */

export interface EtatCurseur {
  actif: boolean;
  /** Jour de terrain, AAAA-MM-JJ. */
  date: string;
  /** Axe système, facultatif : « tel que connu le… », AAAA-MM-JJ. */
  connu: string | null;
  inclureAValider: boolean;
}

export interface Comptes {
  retenues: number;
  aValiderEcartees: number;
  sansDateEffet: number;
  datesIncoherentes: number;
  remplaceesSansFin: number;
  ambigues: number;
}

export interface PortionALaDate {
  id: string;
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  debutM: number;
  finM: number;
  longueurM: number;
  revetement: string | null;
  etat: string | null;
  etatLibelle: string | null;
  praticabilite: string | null;
  largeurM: number | null;
  source: string | null;
  confiance: string | null;
  observeeLe: string | null;
  valideDu: string | null;
  valideAu: string | null;
  enregistreLe: string;
  statut: "A_VALIDER" | "VALIDE" | "REJETE" | "A_CORRIGER";
  ambigue: boolean;
  geometry: string | null;
}

export interface ReponseCurseur {
  dateTerrain: string;
  connuLe: string | null;
  inclureAValider: boolean;
  tronque: boolean;
  plafond: number;
  comptes: Comptes;
  longueurCouverteM: number;
  portions: PortionALaDate[];
}

export interface Chronologie {
  total: number;
  avecDateEffet: number;
  sansDateEffet: number;
  premiere: string | null;
  derniere: string | null;
  parMois: { mois: string; n: number }[];
}

const MS_JOUR = 86_400_000;
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Aujourd'hui, en jour UTC : le même que celui du serveur. */
export function aujourdhui(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Une vraie date AAAA-MM-JJ : « 2026-02-30 » n'en est pas une. */
export function jourValide(s: string | null | undefined): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
}

const enMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const enJour = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const SANS_CURSEUR: EtatCurseur = { actif: false, date: "", connu: null, inclureAValider: false };

/**
 * Le curseur porté par l'adresse, ou `null`.
 *
 * Un lien est une ENTRÉE EXTÉRIEURE : une date mal formée, inexistante ou FUTURE invalide tout le
 * curseur, qui reste alors éteint. Jamais appliqué à moitié, comme `lireVue` pour la vue.
 */
export function lireCurseur(search: string, auj: string = aujourdhui()): EtatCurseur | null {
  const p = new URLSearchParams(search);
  const date = p.get("date");
  if (date === null) return null;
  if (!jourValide(date) || date > auj) return null;
  const connu = p.get("connu");
  if (connu !== null && (!jourValide(connu) || connu > auj)) return null;
  return { actif: true, date, connu, inclureAValider: p.get("propositions") === "1" };
}

/** L'adresse avec le curseur écrit (ou retiré s'il est éteint), les autres paramètres conservés. */
export function ecrireCurseur(search: string, c: EtatCurseur): string {
  const p = new URLSearchParams(search);
  if (!c.actif) {
    p.delete("date"); p.delete("connu"); p.delete("propositions");
    return p.toString();
  }
  p.set("date", c.date);
  if (c.connu) p.set("connu", c.connu); else p.delete("connu");
  if (c.inclureAValider) p.set("propositions", "1"); else p.delete("propositions");
  return p.toString();
}

export interface Bornes { min: string; max: string; nbJours: number }

/**
 * Les bornes du curseur : de la première date d'effet connue à aujourd'hui.
 *
 * Sans aucune date d'effet, un an en arrière, pour que le curseur existe et que l'écran puisse
 * expliquer pourquoi il est vide. Une première date postérieure à aujourd'hui est ramenée à
 * aujourd'hui : le curseur ne va jamais plus loin.
 */
export function bornes(chrono: Pick<Chronologie, "premiere"> | null | undefined, auj: string = aujourdhui()): Bornes {
  const premiere = chrono?.premiere ?? null;
  let min = premiere && jourValide(premiere) ? premiere : enJour(enMs(auj) - 365 * MS_JOUR);
  if (min > auj) min = auj;
  return { min, max: auj, nbJours: Math.round((enMs(auj) - enMs(min)) / MS_JOUR) };
}

/** Le jour décalé de `jours`, ramené dans les bornes. */
export function decaler(iso: string, jours: number, b: Bornes): string {
  const cible = enJour(enMs(iso) + jours * MS_JOUR);
  if (cible < b.min) return b.min;
  if (cible > b.max) return b.max;
  return cible;
}

/** Position d'un jour sur le curseur, de 0 (`min`) à `nbJours`. */
export function jourVersIndex(b: Bornes, iso: string): number {
  const i = Math.round((enMs(iso) - enMs(b.min)) / MS_JOUR);
  return Math.max(0, Math.min(b.nbJours, i));
}

export function indexVersJour(b: Bornes, i: number): string {
  return enJour(enMs(b.min) + Math.max(0, Math.min(b.nbJours, Math.round(i))) * MS_JOUR);
}

/** « 15 mars 2026 ». Le 1er prend « 1er ». */
export function etiquetteJour(iso: string): string {
  if (!jourValide(iso)) return iso;
  const [a, m, j] = iso.split("-").map(Number);
  return `${j === 1 ? "1er" : j} ${MOIS[m - 1]} ${a}`;
}

function pluriel(n: number, un: string, plusieurs: string): string {
  return `${n.toLocaleString("fr-FR")} ${n > 1 ? plusieurs : un}`;
}

function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`;
}

/** Une phrase qui dit ce que la vue montre, et SEULEMENT ce qu'elle montre. */
export function resume(r: ReponseCurseur): string {
  const n = r.portions.length;
  const quand = `le ${etiquetteJour(r.dateTerrain)}`;
  const connu = r.connuLe ? `, tel que connu le ${etiquetteJour(r.connuLe)}` : "";
  if (n === 0) return `Aucune portion connue ${quand}${connu} dans cette vue.`;
  const vraie = n > 1 ? "vraies" : "vraie";
  return `${pluriel(n, "portion", "portions")} ${vraie} ${quand}${connu}, soit ${km(r.longueurCouverteM)} qualifiés.`;
}

/**
 * Pourquoi la vue est vide, quand elle l'est.
 *
 * LA DISTINCTION QUI COMPTE : « aucune portion n'a de date d'effet » n'est pas « aucune portion à
 * cette date ». Dans le premier cas le curseur ne pourra rien montrer à aucune date, tant que la
 * date d'effet n'est pas saisie ; dans le second, il fonctionne et cette date est simplement vide.
 */
export function messageVide(chrono: Chronologie | null | undefined, r: ReponseCurseur | null | undefined): string | null {
  if (!chrono) return null;
  if (chrono.avecDateEffet === 0) {
    const sans = chrono.sansDateEffet > 0
      ? ` (${pluriel(chrono.sansDateEffet, "portion existe", "portions existent")}, toutes sans date d'effet)`
      : "";
    return `Aucune portion ne porte de date d'effet${sans} : le curseur n'a rien à montrer, à aucune date. La date d'effet se saisit sur la page « Portions terrain ».`;
  }
  if (r && r.portions.length === 0) {
    return "Aucune portion connue à cette date dans cette vue. Ce n'est pas un état « bon » ni « vide » : cela veut dire que personne n'a qualifié ces tronçons à cette date, ou pas encore enregistré.";
  }
  return null;
}

/** Ce que la vue ne montre PAS, ou montre avec réserve : jamais passé sous silence. */
export function avertissements(chrono: Chronologie | null | undefined, r: ReponseCurseur | null | undefined): string[] {
  const l: string[] = [];
  if (r?.tronque) l.push(`Affichage tronqué à ${r.plafond.toLocaleString("fr-FR")} portions : zoomer pour tout voir.`);
  if (r && !r.inclureAValider && r.comptes.aValiderEcartees > 0) {
    l.push(`${pluriel(r.comptes.aValiderEcartees, "proposition non validée n'est", "propositions non validées ne sont")} pas montrée${r.comptes.aValiderEcartees > 1 ? "s" : ""}.`);
  }
  if (r && r.comptes.ambigues > 0) {
    l.push(`${pluriel(r.comptes.ambigues, "portion en recouvre", "portions se recouvrent")}${r.comptes.ambigues > 1 ? "" : " une autre"} : le curseur ne tranche pas entre elles.`);
  }
  if (r && r.comptes.remplaceesSansFin > 0) {
    l.push(`${pluriel(r.comptes.remplaceesSansFin, "version remplacée", "versions remplacées")} sans date de fin ${r.comptes.remplaceesSansFin > 1 ? "ne sont" : "n'est"} pas montrée${r.comptes.remplaceesSansFin > 1 ? "s" : ""} (historique : on ne sait pas quand l'état a changé).`);
  }
  if (r && r.comptes.datesIncoherentes > 0) {
    l.push(`${pluriel(r.comptes.datesIncoherentes, "portion aux dates incohérentes est écartée", "portions aux dates incohérentes sont écartées")}.`);
  }
  // Le compte global n'est donné que s'il y a de quoi montrer : sinon `messageVide` le dit déjà.
  if (chrono && chrono.avecDateEffet > 0 && chrono.sansDateEffet > 0) {
    l.push(`${pluriel(chrono.sansDateEffet, "portion du réseau n'a", "portions du réseau n'ont")} pas de date d'effet : ${chrono.sansDateEffet > 1 ? "elles ne sont placées" : "elle n'est placée"} à aucune date.`);
  }
  return l;
}
