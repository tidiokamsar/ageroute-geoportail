import type { EtatKpi, FiltresDecision, IdOnglet, Kpi } from "../components/decision/types";
import type { EtatMontant, FraicheurSynthese, KpiLu, LigneBailleur, RegionDegradation, RepartitionEtat } from "./aideDecisionApi";
import { libelleEtat, ORDRE_ETATS, symbole, SYMBOLES } from "../features/geoportail/map/symbology";

/**
 * Noyau pur de la page « Aide a la decision » (lot 1) : filtres partages et leur URL, formats de nombre,
 * lecture d'un indicateur, fraicheur, modeles de la zone de synthese. Aucune horloge, aucun DOM, aucun appel
 * reseau : l'instant courant est un parametre, ce qui rend chaque regle testable.
 *
 * REGLE DU MODULE (docs/aide-decision/CONTRAT-AD.md paragraphe 1) : une donnee inconnue n'est pas zero. Rien ici
 * ne convertit une absence en 0, en « 0 % » ou en « 0 GNF » : une valeur absente se formule en mots.
 */

// ---------------------------------------------------------------------------------------------- onglets

/** Les six onglets de la maquette, dans l'ordre de lecture (contrat paragraphe 8). */
export const ONGLETS: readonly { id: IdOnglet; libelle: string }[] = [
  { id: "carte", libelle: "Carte et priorisation" },
  { id: "liste", libelle: "Liste des interventions" },
  { id: "simulation", libelle: "Simulation budgétaire" },
  { id: "contractuel", libelle: "Suivi contractuel" },
  { id: "scenarios", libelle: "Scénarios" },
  { id: "rapports", libelle: "Rapports" },
];

export const ONGLET_PAR_DEFAUT: IdOnglet = "carte";

export function estIdOnglet(v: unknown): v is IdOnglet {
  return typeof v === "string" && ONGLETS.some((o) => o.id === v);
}

export function libelleOnglet(id: IdOnglet): string {
  return ONGLETS.find((o) => o.id === id)?.libelle ?? id;
}

// ---------------------------------------------------------------------------------------------- filtres

/** Valeurs de filtre proposees par la page. Les codes viennent du referentiel (types/index.ts), pas de la maquette. */
export const ETATS_FILTRE: readonly string[] = ORDRE_ETATS;
/** Statuts de chantier de l'enumeration du serveur (schema.prisma, StatutChantier) : le serveur repond 400 hors de cette liste. */
export const STATUTS_CHANTIER_FILTRE: readonly string[] = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE"];
export const CLASSES_FILTRE: readonly { code: string; libelle: string }[] = [
  { code: "RN", libelle: "RN" },
  { code: "RR", libelle: "RR" },
  { code: "RU", libelle: "RU" },
  { code: "PISTE", libelle: "Piste" },
  { code: "NON_CLASSEE", libelle: "Non classée" },
];

/**
 * Filtres que le contrat declare INDISPONIBLES faute de donnee structuree (paragraphe 3). Ils sont affiches
 * desactives, avec leur raison : un filtre retire en silence laisse croire qu'il n'a jamais existe.
 */
export const FILTRES_INDISPONIBLES: readonly { cle: string; libelle: string; raison: string }[] = [
  { cle: "prefecture", libelle: "Préfecture", raison: "texte libre sur le tronçon, aucune entité structurée" },
  { cle: "axe", libelle: "Axe", raison: "aucune entité « axe » dans le référentiel" },
  { cle: "bailleur", libelle: "Bailleur / financement", raison: "texte libre sur les chantiers, clé étrangère sur les marchés : trois formes non rapprochées" },
  { cle: "gravite", libelle: "Gravité", raison: "aucune gravité structurée" },
  { cle: "intervention", libelle: "Type d'intervention", raison: "le moteur de priorisation ne l'expose pas encore" },
];

const DATE_ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** Plafond du serveur (synthese.filtres.ts, MAX_ELEMENTS). */
const MAX_ELEMENTS = 10;

/**
 * Liste de valeurs relue d'une URL ou d'une reponse : seules les valeurs de l'ENUMERATION passent. Le serveur refuse
 * (400) toute valeur hors nomenclature ; une URL bricolee ne doit donc jamais lui en envoyer.
 */
function listeEnumeree(v: unknown, autorisees: readonly string[]): string[] | undefined {
  const brut = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  for (const e of brut) {
    if (typeof e !== "string") continue;
    const t = e.trim();
    if (autorisees.includes(t) && !out.includes(t)) out.push(t);
  }
  return out.length > 0 ? out.slice(0, MAX_ELEMENTS) : undefined;
}

function entierPositif(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : undefined;
  if (typeof v === "string" && /^\d{1,9}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : undefined;
  }
  return undefined;
}

/** Annees acceptees par le serveur (synthese.filtres.ts : 2000 a 2100) ; hors de cette plage il repond 400. */
export const ANNEE_MIN = 2000;
export const ANNEE_MAX = 2100;

function dateIso(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!DATE_ISO.test(t)) return undefined;
  const [a, m, j] = t.split("-").map(Number);
  if (a < ANNEE_MIN || a > ANNEE_MAX) return undefined;
  const d = new Date(Date.UTC(a, m - 1, j));
  // Un 31 fevrier se normalise en mars : la date relue ne serait plus celle qui a ete ecrite.
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j ? t : undefined;
}

/** Une date AAAA-MM-JJ que le serveur accepte : calendrier reel, annee 2000 a 2100. */
export function dateValide(v: string): boolean {
  return dateIso(v) === v;
}

/**
 * Releve d'un objet quelconque (reponse du serveur, parametres d'URL) les seuls filtres valides. Tout le reste est
 * ignore : une URL bricolee ne doit ni planter la page ni injecter un filtre que le serveur ne connait pas.
 */
export function normaliserFiltres(brut: unknown): FiltresDecision {
  const o = brut !== null && typeof brut === "object" ? (brut as Record<string, unknown>) : {};
  const f: FiltresDecision = {};
  const regionId = entierPositif(o.regionId);
  if (regionId !== undefined) f.regionId = regionId;
  const classe = listeEnumeree(o.classe, CLASSES_FILTRE.map((c) => c.code));
  if (classe) f.classe = classe;
  const etat = listeEnumeree(o.etat, ETATS_FILTRE);
  if (etat) f.etat = etat;
  const statutChantier = listeEnumeree(o.statutChantier, STATUTS_CHANTIER_FILTRE);
  if (statutChantier) f.statutChantier = statutChantier;
  const depuis = dateIso(o.depuis);
  if (depuis) f.depuis = depuis;
  const jusqua = dateIso(o.jusqua);
  if (jusqua) f.jusqua = jusqua;
  return f;
}

/**
 * UNE seule fonction de serialisation pour tous les endpoints du module (contrat paragraphe 3) : meme perimetre
 * pour les indicateurs, la carte, la liste et les exports. Les listes sont separees par des virgules
 * (`classe=RN,RR`), l'ordre des cles est stable.
 */
export function serialiserFiltres(f: FiltresDecision): URLSearchParams {
  const n = normaliserFiltres(f);
  const p = new URLSearchParams();
  if (n.regionId !== undefined) p.set("regionId", String(n.regionId));
  if (n.classe) p.set("classe", n.classe.join(","));
  if (n.etat) p.set("etat", n.etat.join(","));
  if (n.statutChantier) p.set("statutChantier", n.statutChantier.join(","));
  if (n.depuis) p.set("depuis", n.depuis);
  if (n.jusqua) p.set("jusqua", n.jusqua);
  return p;
}

/** Lecture inverse : parametres d'URL (objet, chaine avec ou sans « ? ») vers filtres valides. */
export function lireFiltres(source: URLSearchParams | string): FiltresDecision {
  const p = typeof source === "string" ? new URLSearchParams(source) : source;
  return normaliserFiltres({
    regionId: p.get("regionId") ?? undefined,
    classe: p.get("classe") ?? undefined,
    etat: p.get("etat") ?? undefined,
    statutChantier: p.get("statutChantier") ?? undefined,
    depuis: p.get("depuis") ?? undefined,
    jusqua: p.get("jusqua") ?? undefined,
  });
}

/** Parametres de requete d'un appel d'API (axios `params`). */
export function paramsApi(f: FiltresDecision): Record<string, string> {
  return Object.fromEntries(serialiserFiltres(f).entries());
}

const CLES_URL = ["regionId", "classe", "etat", "statutChantier", "depuis", "jusqua"] as const;

export function lireOnglet(p: URLSearchParams): IdOnglet {
  const v = p.get("onglet");
  return estIdOnglet(v) ? v : ONGLET_PAR_DEFAUT;
}

/**
 * Ecrit l'onglet et les filtres dans les parametres courants. Les parametres etrangers a la page sont conserves ;
 * l'onglet par defaut n'est pas ecrit (URL la plus courte, lien partageable stable).
 */
export function ecrireUrl(courant: URLSearchParams, onglet: IdOnglet, filtres: FiltresDecision): URLSearchParams {
  const p = new URLSearchParams(courant);
  p.delete("onglet");
  for (const k of CLES_URL) p.delete(k);
  if (onglet !== ONGLET_PAR_DEFAUT) p.set("onglet", onglet);
  for (const [k, v] of serialiserFiltres(filtres)) p.set(k, v);
  return p;
}

export function filtresEgaux(a: FiltresDecision, b: FiltresDecision): boolean {
  return serialiserFiltres(a).toString() === serialiserFiltres(b).toString();
}

/** Nombre de filtres actifs ; la periode (depuis et jusqua) compte pour un. */
export function nombreFiltresActifs(f: FiltresDecision): number {
  const n = normaliserFiltres(f);
  return [n.regionId !== undefined, !!n.classe, !!n.etat, !!n.statutChantier, !!(n.depuis || n.jusqua)].filter(Boolean).length;
}

/** Message d'incoherence de la periode, ou null. Un filtre incoherent n'est pas envoye au serveur. */
export function erreurPeriode(f: FiltresDecision): string | null {
  return f.depuis && f.jusqua && f.depuis > f.jusqua ? "La date de début est postérieure à la date de fin." : null;
}

// ---------------------------------------------------------------------------------------------- formats

const ESPACE_INSECABLE = "\u00a0";
export const ABSENT = "Non disponible";

function nombre(n: number, decimales: number): string {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: decimales }).format(n);
}

export function formaterEntier(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? nombre(n, 0) : ABSENT;
}
export function formaterKm(km: number | null | undefined): string {
  return typeof km === "number" && Number.isFinite(km) ? `${nombre(km, 1)}${ESPACE_INSECABLE}km` : ABSENT;
}
export function formaterPct(p: number | null | undefined): string {
  return typeof p === "number" && Number.isFinite(p) ? `${nombre(p, 1)}${ESPACE_INSECABLE}%` : ABSENT;
}

const GNF_LISIBLE = /^(-?)(\d+)(?:\.(\d+))?$/;

function grouper(entier: string): string {
  return entier.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE_INSECABLE);
}

/**
 * Montant en GNF a partir de la CHAINE du serveur, sans passer par un flottant : un nombre depasse 2^53 des
 * ~9 000 Md GNF et perdrait des unites en silence. Par defaut le montant est rendu en entier (chiffres groupes) ;
 * `abrege` donne l'ordre de grandeur (« 20,2 T GNF », arrondi au dixieme par calcul entier) pour une vignette etroite,
 * le montant exact restant lisible ailleurs (titre, bloc de budget).
 */
export function formaterGnf(valeur: string | null | undefined, abrege = false): string {
  if (typeof valeur !== "string") return ABSENT;
  const m = GNF_LISIBLE.exec(valeur.trim());
  if (!m) return "Montant illisible";
  const [, signe, entier, decimales] = m;
  const entierNormalise = entier.replace(/^0+(?=\d)/, "");
  if (abrege) {
    const v = BigInt(entierNormalise);
    const paliers: [bigint, string][] = [[BigInt("1000000000000"), "T"], [BigInt("1000000000"), "Md"], [BigInt("1000000"), "M"]];
    for (const [seuil, unite] of paliers) {
      if (v >= seuil) {
        const dixiemes = (v * BigInt(10) + seuil / BigInt(2)) / seuil;
        const ent = dixiemes / BigInt(10);
        const dec = dixiemes % BigInt(10);
        const txt = dec === BigInt(0) ? grouper(String(ent)) : `${grouper(String(ent))},${dec}`;
        return `${signe}${txt}${ESPACE_INSECABLE}${unite}${ESPACE_INSECABLE}GNF`;
      }
    }
  }
  const dec = decimales && /[1-9]/.test(decimales) ? `,${decimales.replace(/0+$/, "")}` : "";
  return `${signe}${grouper(entierNormalise)}${dec}${ESPACE_INSECABLE}GNF`;
}

function enBigInt(valeur: string): bigint | null {
  const m = GNF_LISIBLE.exec(valeur.trim());
  return m ? BigInt(`${m[1]}${m[2]}`) : null; // la partie decimale (< 1 GNF) n'entre pas dans une part
}

/** Part (en %, un decimale) d'un montant dans un total, par calcul entier. null si le montant ou le total est illisible. */
export function partMontant(montant: string, total: bigint): number | null {
  const m = enBigInt(montant);
  if (m === null || total <= BigInt(0)) return null;
  return Number((m * BigInt(1000)) / total) / 10;
}

/** Total en GNF (entier) des montants lisibles ; les illisibles sont comptes a part, jamais ajoutes comme 0. */
export function totalGnf(montants: string[]): { total: bigint; illisibles: number } {
  let total = BigInt(0);
  let illisibles = 0;
  for (const s of montants) {
    const v = enBigInt(s);
    if (v === null) illisibles += 1;
    else total += v;
  }
  return { total, illisibles };
}

/** Bailleurs tries du plus gros au plus petit montant contractuel ; les montants illisibles en fin de liste. */
export function trierBailleurs(l: LigneBailleur[]): LigneBailleur[] {
  return [...l].sort((a, b) => {
    // Un montant inconnu (null) ou illisible va en fin de liste : il ne vaut pas zero, il ne se compare pas.
    const x = a.contractuelGnf === null ? null : enBigInt(a.contractuelGnf);
    const y = b.contractuelGnf === null ? null : enBigInt(b.contractuelGnf);
    if (x === null && y === null) return a.bailleur.localeCompare(b.bailleur, "fr");
    if (x === null) return 1;
    if (y === null) return -1;
    return x === y ? a.bailleur.localeCompare(b.bailleur, "fr") : x > y ? -1 : 1;
  });
}

/** Total en GNF (entier) d'une chaine decimale, ou null si elle est illisible. Sert de denominateur aux parts par bailleur. */
export function totalDepuisChaine(valeur: string | null | undefined): bigint | null {
  return typeof valeur === "string" ? enBigInt(valeur) : null;
}

export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date illisible";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

export function formaterDateHeure(iso: string | null | undefined): string {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date illisible";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

// ---------------------------------------------------------------------------------------------- indicateurs

export const LIBELLE_ETAT_KPI: Record<EtatKpi, string> = {
  DISPONIBLE: "Disponible",
  PARTIEL: "Partiel",
  NON_DISPONIBLE: "Non disponible",
  PERIME: "Périmé",
  DEFINITION_NON_VALIDEE: "Définition non validée",
};

/** Etats d'un montant : ceux d'un indicateur, plus « non autorise » (droit financier absent : montant non communique, pas inconnu). */
export const LIBELLE_ETAT_MONTANT: Record<EtatMontant, string> = {
  DISPONIBLE: "Disponible",
  PARTIEL: "Partiel",
  NON_DISPONIBLE: "Non disponible",
  NON_AUTORISE: "Non autorisé",
};

export interface AffichageKpi {
  /** Valeur formatee (sans l'unite), ou null : l'etat ou une valeur absente interdit de la montrer. */
  valeur: string | null;
  /** Unite a imprimer apres la valeur ; vide pour un nombre sans unite (« 5 », jamais « 5 nombre »). */
  unite: string;
  /** Pourquoi il n'y a pas de valeur ; null quand elle est montree. */
  raison: string | null;
}

/**
 * Unites du serveur (dictionnaire) : « % », « km », « GNF », « part » (fraction de 0 a 1), « nombre » (un simple
 * decompte), « elements ». « nombre » n'est jamais imprime comme unite ; une fraction « part » est montree en %.
 */
function uniteImprimee(u: string): string {
  const t = u.trim().toLowerCase();
  if (t === "nombre") return "";
  if (t === "part") return "%";
  if (t === "elements" || t === "éléments") return "éléments";
  return u;
}

/**
 * Ce qu'une vignette montre pour un indicateur. L'ETAT decide, pas la valeur : un indicateur NON_DISPONIBLE ne montre
 * jamais de chiffre, meme si le serveur en a joint un par erreur. Une valeur absente ou non finie sur un indicateur
 * censé en avoir une ne devient pas 0 : elle est dite absente.
 *
 * MONTANTS GNF : le serveur met la valeur EXACTE dans `valeurTexte` (chaine) et `valeur` a null quand le nombre n'est
 * pas exactement representable. C'est `valeurTexte` qui est montre, jamais un nombre approximatif.
 */
export function affichageKpi(k: KpiLu | Kpi): AffichageKpi {
  const raisonDefaut: Record<EtatKpi, string> = {
    NON_DISPONIBLE: "source non disponible",
    DEFINITION_NON_VALIDEE: "définition non validée",
    PERIME: "données périmées",
    PARTIEL: "valeur non fournie",
    DISPONIBLE: "valeur non fournie",
  };
  const raison = k.avertissements.length > 0 ? k.avertissements.join(" ; ") : raisonDefaut[k.etat];
  if (k.etat === "NON_DISPONIBLE") return { valeur: null, unite: uniteImprimee(k.unite), raison };
  const u = k.unite.trim().toLowerCase();
  const texte = "valeurTexte" in k ? k.valeurTexte : undefined;
  if (u === "gnf" && typeof texte === "string") {
    const f = formaterGnf(texte);
    if (f === "Montant illisible") return { valeur: null, unite: "GNF", raison: "montant illisible dans la réponse du serveur" };
    return { valeur: f.replace(/\s*GNF$/, ""), unite: "GNF", raison: null };
  }
  if (typeof k.valeur !== "number" || !Number.isFinite(k.valeur)) return { valeur: null, unite: uniteImprimee(k.unite), raison };
  if (u === "gnf") {
    // Un montant en flottant au-dela de 2^53 a deja perdu des unites : on ne l'affiche pas comme exact.
    if (!Number.isSafeInteger(k.valeur)) return { valeur: null, unite: "GNF", raison: "montant trop grand pour être affiché sans perte de précision" };
    return { valeur: formaterGnf(String(k.valeur), true).replace(/\s*GNF$/, ""), unite: "GNF", raison: null };
  }
  // Une fraction (0,5455) se montre en pourcentage (54,55 %), jamais « 0,5455 part ». Deux decimales : le serveur arrondit a 4.
  if (u === "part") return { valeur: nombre(Math.round(k.valeur * 10000) / 100, 2), unite: "%", raison: null };
  if (u === "%" || u === "km") return { valeur: nombre(k.valeur, 1), unite: k.unite, raison: null };
  return { valeur: nombre(k.valeur, Number.isInteger(k.valeur) ? 0 : 1), unite: uniteImprimee(k.unite), raison: null };
}

/** Texte de la periode d'un indicateur. Une periode absente se dit : « non précisée », pas une periode inventee. */
export function textePeriode(p: Kpi["periode"]): string {
  if (!p || (!p.depuis && !p.jusqua)) return "Période non précisée";
  if (p.depuis && p.jusqua) return p.depuis === p.jusqua ? `Instantané du ${formaterDate(p.depuis)}` : `Du ${formaterDate(p.depuis)} au ${formaterDate(p.jusqua)}`;
  return p.depuis ? `Depuis le ${formaterDate(p.depuis)}` : `Jusqu'au ${formaterDate(p.jusqua)}`;
}

/**
 * Couverture, en phrases COHERENTES avec la definition du serveur : `evalueKm` = longueur a etat valide (`eligibleKm`)
 * + longueur a etat renseigne mais non valide (`etatNonValideKm`) ; la longueur connue du perimetre ajoute les non evalues.
 * On ne dit donc jamais « 700 km evalues sur 200 km eligibles » : on decompose la longueur connue.
 */
export interface CouvertureTexte { eligibleKm: number | null; nonEvalueKm: number | null; etatNonValideKm?: number | null }
export function texteCouverture(c: CouvertureTexte | null | undefined): string | null {
  if (!c) return null;
  const connu = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  const parts: string[] = [];
  if (connu(c.eligibleKm)) parts.push(`${formaterKm(c.eligibleKm)} à état valide`);
  if (connu(c.etatNonValideKm) && c.etatNonValideKm > 0) parts.push(`${formaterKm(c.etatNonValideKm)} à état non valide`);
  if (connu(c.nonEvalueKm) && c.nonEvalueKm > 0) parts.push(`${formaterKm(c.nonEvalueKm)} non évalués`);
  if (parts.length === 0) return null;
  const total = (c.eligibleKm ?? 0) + (c.etatNonValideKm ?? 0) + (c.nonEvalueKm ?? 0);
  const tousConnus = connu(c.eligibleKm) && connu(c.nonEvalueKm);
  return parts.length > 1 && tousConnus ? `${parts.join(", ")}, sur ${formaterKm(total)} de longueur connue` : parts.join(", ");
}

/** Vrai quand une part du perimetre n'est pas a etat valide (non evalue, non valide ou sans longueur) : le taux ne couvre pas tout le reseau. */
export function couverturePartielle(c: { nonEvalueKm?: number | null; etatNonValideKm?: number | null; tronconsSansLongueurMetier?: number | null } | null | undefined): boolean {
  return !!c && [c.nonEvalueKm, c.etatNonValideKm, c.tronconsSansLongueurMetier].some((v) => typeof v === "number" && v > 0);
}

// ---------------------------------------------------------------------------------------------- fraicheur

/**
 * Anciennete au-dela de laquelle les donnees sont dites perimees. PROVISOIRE : le seuil de fraicheur est une decision
 * metier non prise (docs/reports/LOT-AD-00-RAPPORT.md paragraphe 7). 30 jours est un choix de conduite reversible,
 * pas une regle officielle ; la page le dit.
 */
export const SEUIL_PERIME_JOURS_PROVISOIRE = 30;

const MS_PAR_JOUR = 86_400_000;

/** Age en jours entiers depuis `iso`, ou null si la date est absente, illisible ou dans le futur. */
export function ageEnJours(iso: string | null | undefined, maintenant: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = Math.floor((maintenant.getTime() - t) / MS_PAR_JOUR);
  return d < 0 ? null : d;
}

export interface EvaluationFraicheur {
  calculeLe: string;
  /** Date de la derniere evaluation d'etat parmi les troncons a etat valide ; null = aucune date connue. */
  derniereEvaluationLe: string | null;
  plusAncienneEvaluationLe: string | null;
  /** Age du calcul, mesure ici. */
  ageCalculJours: number | null;
  /** Age de la derniere evaluation annonce par le serveur ; null = inconnu (jamais 0). */
  ageDonneesJours: number | null;
  perime: boolean;
  seuilJours: number;
}

export function evaluerFraicheur(f: FraicheurSynthese, maintenant: Date, seuilJours = SEUIL_PERIME_JOURS_PROVISOIRE): EvaluationFraicheur {
  const ageCalculJours = ageEnJours(f.calculeLe, maintenant);
  const ageDonneesJours = typeof f.ageJours === "number" && Number.isFinite(f.ageJours) && f.ageJours >= 0 ? f.ageJours : null;
  const perime = [ageCalculJours, ageDonneesJours].some((a) => a !== null && a > seuilJours);
  return { calculeLe: f.calculeLe, derniereEvaluationLe: f.derniereEvaluationLe, plusAncienneEvaluationLe: f.plusAncienneEvaluationLe, ageCalculJours, ageDonneesJours, perime, seuilJours };
}

// ---------------------------------------------------------------------------------------------- synthese

export type TypeSegment = "classe" | "etatNonValide" | "nonEvalue";
export type FormeSegment = "cercle" | "losange" | "triangle" | "carre" | "carre-creux";

export interface SegmentRepartition {
  cle: string;
  type: TypeSegment;
  /** Code d'etat du referentiel (BON, MOYEN, ...) pour une classe ; NON_EVALUE ou ETAT_NON_VALIDE pour les deux tranches a part. */
  etat: string;
  libelle: string;
  km: number | null;
  nbTroncons: number | null;
  /** Part des classes : % de la longueur a etat VALIDE (serveur) ; null pour les tranches hors taux. */
  partPct: number | null;
  /** Part du perimetre (%), pour les tranches hors taux : la fraction du serveur x 100 ; null sinon. */
  partPerimetrePct: number | null;
  /** Tranche exclue du denominateur des taux (non evalue, etat non valide) : jamais fondue dans « bon ». */
  horsTaux: boolean;
  nonEvalue: boolean;
  couleur: string;
  forme: FormeSegment;
}

const enPct = (fraction: number | null): number | null => (fraction === null ? null : Math.round(fraction * 10000) / 100);

/**
 * Segments de la repartition, dans l'ordre : classes d'etat valide (ordre du referentiel), puis « etat non valide »
 * (etat renseigne mais ni constate ni verifie), puis « non evalue ». Les deux dernieres sont des tranches DISTINCTES et
 * nommees : exclues du denominateur des taux, jamais assimilees a « bon ».
 */
export function segmentsRepartition(rep: RepartitionEtat): SegmentRepartition[] {
  const rang = (e: string) => {
    const i = ORDRE_ETATS.indexOf(e as never);
    return i === -1 ? ORDRE_ETATS.length : i;
  };
  const classes = rep.classes
    .map((c): SegmentRepartition => ({
      cle: c.classe, type: "classe", etat: c.classe, libelle: libelleEtat(c.classe), km: c.km, nbTroncons: c.troncons, partPct: c.partPct,
      partPerimetrePct: null, horsTaux: false, nonEvalue: false, couleur: symbole(c.classe).trait, forme: symbole(c.classe).forme,
    }))
    .sort((a, b) => rang(a.etat) - rang(b.etat));
  const nonValide: SegmentRepartition = {
    cle: "__ETAT_NON_VALIDE__", type: "etatNonValide", etat: "ETAT_NON_VALIDE", libelle: "État non valide", km: rep.etatNonValide.km, nbTroncons: rep.etatNonValide.troncons,
    partPct: null, partPerimetrePct: enPct(rep.etatNonValide.partDuPerimetre), horsTaux: true, nonEvalue: false,
    // Gris plus fonce que « non evalue » et carre creux : deux tranches voisines ne se confondent ni par la teinte ni par la forme.
    couleur: SYMBOLES.NON_EVALUE.texte, forme: "carre-creux",
  };
  const ne: SegmentRepartition = {
    cle: "__NON_EVALUE__", type: "nonEvalue", etat: "NON_EVALUE", libelle: libelleEtat("NON_EVALUE"), km: rep.nonEvalue.km, nbTroncons: rep.nonEvalue.troncons,
    partPct: null, partPerimetrePct: enPct(rep.nonEvalue.partDuPerimetre), horsTaux: true, nonEvalue: true,
    couleur: symbole("NON_EVALUE").trait, forme: symbole("NON_EVALUE").forme,
  };
  return [...classes, nonValide, ne];
}

/** Vrai quand le perimetre n'a aucun troncon : etat vide explicite, pas un anneau de zeros. */
export function repartitionVide(rep: RepartitionEtat): boolean {
  return rep.troncons === 0 && rep.longueurMetierAbsente.troncons === 0;
}

export interface ArcAnneau {
  cle: string;
  /** Longueur tracee puis longueur de blanc (attribut stroke-dasharray d'un cercle). */
  trace: number;
  decalage: number;
}

/** Geometrie de l'anneau : un arc par segment dont le km est connu et strictement positif. Les autres n'ont pas d'arc. */
export function arcsAnneau(segments: SegmentRepartition[], rayon: number): { arcs: ArcAnneau[]; circonference: number; totalKm: number } {
  const circonference = 2 * Math.PI * rayon;
  const dessinables = segments.filter((s) => typeof s.km === "number" && s.km > 0);
  const totalKm = dessinables.reduce((t, s) => t + (s.km as number), 0);
  let cumul = 0;
  const arcs = dessinables.map((s) => {
    const trace = ((s.km as number) / totalKm) * circonference;
    const arc = { cle: s.cle, trace, decalage: -cumul };
    cumul += trace;
    return arc;
  });
  return { arcs, circonference, totalKm };
}

/** Nom affichable d'une region : le nom du serveur, « Non renseigné » a localiser, ou son numero quand le nom manque. */
export function nomRegion(r: Pick<RegionDegradation, "regionId" | "regionNom" | "regionNonRenseignee">): string {
  if (r.regionNonRenseignee) return "Non renseigné (tronçons à localiser)";
  return r.regionNom ?? `Région n° ${r.regionId}`;
}

/** Regions triees par part degradee decroissante ; les regions sans taux calculable en fin de liste (jamais en tete a 0). */
export function trierRegions(l: RegionDegradation[]): RegionDegradation[] {
  return [...l].sort((a, b) => {
    const na = nomRegion(a);
    const nb = nomRegion(b);
    if (a.partDegradeePct === null && b.partDegradeePct === null) return na.localeCompare(nb, "fr");
    if (a.partDegradeePct === null) return 1;
    if (b.partDegradeePct === null) return -1;
    return b.partDegradeePct - a.partDegradeePct || na.localeCompare(nb, "fr");
  });
}

/** Part (%) d'un montant dans le total CONTRACTUEL du budget, par calcul entier ; null si l'un des deux est illisible. */
export function partDuTotalContractuel(montant: string | null, totalContractuel: string | null | undefined): number | null {
  if (montant === null) return null; // montant inconnu : aucune part, jamais 0 %
  const total = totalDepuisChaine(totalContractuel);
  return total === null ? null : partMontant(montant, total);
}
