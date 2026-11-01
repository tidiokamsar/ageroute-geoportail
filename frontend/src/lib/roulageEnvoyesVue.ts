import { libelleDuree, libelleKm } from "./releve";
import type {
  AgentReleve, DetailReleveEnvoye, EvenementReleve, GeometrieReleve, MarqueurReleve, PortionEvenement, ResumeReleveEnvoye,
} from "./roulageEnvoyes";

/**
 * Ce que l'ecran « Releves envoyes » AFFICHE, calcule hors du composant pour etre teste sans DOM ni reseau ni horloge.
 *
 * REGLE QUI TRAVERSE TOUT LE MODULE : une valeur absente reste ABSENTE. Un taux de rattachement `null` se lit « non
 * evalue », jamais « 0 % » ; une distance `null` se lit « non calculee » ; une geometrie absente se lit « trace non
 * disponible ». Aucun libelle ici ne remplace une donnee manquante par un chiffre, et aucun code de statut inconnu n'est
 * traduit au hasard : il est rendu tel que le serveur l'a envoye.
 */

export type PointCarte = [number, number];

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fini = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ------------------------------------------------------------------ dates

interface OptionsDate {
  /** Ajoute les secondes : sert a distinguer deux releves partis la meme minute dans le nom des liens. */
  secondes?: boolean;
  /** Fuseau (IANA). Par defaut celui de l'appareil ; les tests le fixent pour ne pas dependre de la machine. */
  fuseau?: string;
}

const INCONNUE = "date inconnue";

function parties(iso: string, o: OptionsDate): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    ...(o.secondes ? { second: "2-digit" as const } : {}),
    hourCycle: "h23", timeZone: o.fuseau,
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/** « 26/10/2026 à 12:30 » (ou « 12:30:15 » avec les secondes). Une date illisible est dite, pas devinee. */
export function libelleDateHeure(iso: string, o: OptionsDate = {}): string {
  const p = parties(iso, o);
  if (!p) return INCONNUE;
  return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}${o.secondes ? `:${p.second}` : ""}`;
}

/** « 12:30:15 » : l'heure seule, pour les reperes pose pendant le trajet. */
export function libelleHeure(iso: string, o: OptionsDate = {}): string {
  const p = parties(iso, { ...o, secondes: true });
  return p ? `${p.hour}:${p.minute}:${p.second}` : INCONNUE;
}

// ------------------------------------------------------------------ chiffres du releve

export function libelleDureeReleve(dureeS: number | null): string {
  if (!fini(dureeS) || dureeS < 0) return "non communiquée";
  return libelleDuree(Math.round(dureeS));
}

/**
 * La DISTANCE PARCOURUE enregistree par l'analyse du serveur (`longueurM` de l'API), pas la longueur de la ligne dessinee :
 * la ligne affichee peut etre simplifiee. `null` : l'indicateur manque dans l'analyse, la distance n'est pas calculee.
 */
export function libelleDistance(longueurM: number | null): string {
  if (!fini(longueurM) || longueurM < 0) return "non calculée";
  return libelleKm(longueurM);
}

/**
 * Part des positions retenues rattachees au reseau, entre 0 et 1 (echelle confirmee sur le serveur reel). `null` : le serveur
 * n'a PAS evalue le rattachement (aucun point retenu) ; ce n'est pas « 0 % rattache », qui est une VALEUR (0 sur N points
 * retenus). Une valeur hors de [0, 1] est dite invalide plutot que convertie : on ne sait pas dans quelle echelle elle a ete ecrite.
 */
export function libelleTaux(taux: number | null): string {
  if (taux === null || taux === undefined) return "non évalué";
  if (!fini(taux) || taux < 0 || taux > 1) return "valeur invalide";
  return `${Math.round(taux * 100)} %`;
}

export function libelleNombre(n: number): string {
  return fini(n) ? n.toLocaleString("fr-FR") : "non communiqué";
}

/** Suite du nom d'un lien vers un releve (« du 26/10/2026 à 12:30:15 ») : la date va a la seconde pour que deux liens ne portent jamais le meme nom. */
export function suiteNomLienReleve(r: Pick<ResumeReleveEnvoye, "id" | "debutA">, o: Pick<OptionsDate, "fuseau"> = {}): string {
  const date = libelleDateHeure(r.debutA, { secondes: true, fuseau: o.fuseau });
  return date === INCONNUE ? ` ${r.id.slice(0, 8)}` : ` du ${date}`;
}

export const nomLienReleve = (r: Pick<ResumeReleveEnvoye, "id" | "debutA">, o: Pick<OptionsDate, "fuseau"> = {}): string => `Voir le relevé${suiteNomLienReleve(r, o)}`;

/** Les roles que le serveur laisse voir PLUSIEURS agents : ils ont la colonne et le filtre « agent ». */
export function voitPlusieursAgents(role: string | undefined): boolean {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}

/** Agents deja rencontres + ceux de la page recue, sans doublon, par nom. Le serveur ne rend pas de liste d'agents. */
export function fusionnerAgents(connus: readonly AgentReleve[], items: readonly Pick<ResumeReleveEnvoye, "agent">[]): AgentReleve[] {
  const par = new Map<string, AgentReleve>();
  for (const a of connus) par.set(a.id, a);
  for (const i of items) if (!par.has(i.agent.id)) par.set(i.agent.id, i.agent);
  return [...par.values()].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

export function libelleTotal(charges: number, total: number): string {
  if (total === 0) return "Aucun relevé";
  const s = total > 1 ? "s" : "";
  return charges >= total ? `${libelleNombre(total)} relevé${s} envoyé${s}` : `${libelleNombre(charges)} relevé${charges > 1 ? "s" : ""} affiché${charges > 1 ? "s" : ""} sur ${libelleNombre(total)}`;
}

// ------------------------------------------------------------------ periode

const JOUR = /^(\d{4})-(\d{2})-(\d{2})$/;

function jourLocal(s: string): [number, number, number] | null {
  const m = JOUR.exec(s);
  if (!m) return null;
  const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(a, mo - 1, j);
  return d.getFullYear() === a && d.getMonth() === mo - 1 && d.getDate() === j ? [a, mo, j] : null;
}

export interface PeriodeResolue { depuis: string | null; jusqua: string | null; erreur: string | null }

/** Le serveur refuse tout instant dont l'annee (UTC) n'est pas entre 2000 et 2099 (400 `PARAMETRE_INVALIDE`, verifie sur le serveur reel). */
const ANNEE_MIN = 2000;
const ANNEE_MAX = 2099;
const anneeAcceptee = (iso: string) => { const a = Number(iso.slice(0, 4)); return a >= ANNEE_MIN && a <= ANNEE_MAX; };
const HORS_PLAGE = `Les dates acceptées vont de ${ANNEE_MIN} à ${ANNEE_MAX}.`;

/**
 * Les deux jours saisis (jours LOCAUX de l'agent) en INSTANTS ISO avec fuseau (`...Z`, le format que l'API accepte) : debut du
 * premier jour, fin du dernier (inclus a la milliseconde). Une saisie incoherente (debut apres la fin, jour inexistant, annee
 * que le serveur refuserait) ne part pas au serveur : l'ecran dit pourquoi et garde la derniere periode valide.
 */
export function periodeVersParametres(depuis: string, jusqua: string): PeriodeResolue {
  let d: string | null = null;
  let f: string | null = null;
  if (depuis) {
    const j = jourLocal(depuis);
    if (!j) return { depuis: null, jusqua: null, erreur: "La date de début n'est pas une date valide." };
    d = new Date(j[0], j[1] - 1, j[2], 0, 0, 0, 0).toISOString();
    if (!anneeAcceptee(d)) return { depuis: null, jusqua: null, erreur: `La date de début est refusée. ${HORS_PLAGE}` };
  }
  if (jusqua) {
    const j = jourLocal(jusqua);
    if (!j) return { depuis: null, jusqua: null, erreur: "La date de fin n'est pas une date valide." };
    f = new Date(j[0], j[1] - 1, j[2], 23, 59, 59, 999).toISOString();
    if (!anneeAcceptee(f)) return { depuis: null, jusqua: null, erreur: `La date de fin est refusée. ${HORS_PLAGE}` };
  }
  if (d && f && d > f) return { depuis: null, jusqua: null, erreur: "La date de début est postérieure à la date de fin." };
  return { depuis: d, jusqua: f, erreur: null };
}

// ------------------------------------------------------------------ erreurs

export type GenreErreur = "refuse" | "introuvable" | "reseau" | "illisible" | "serveur";

/** Le genre d'une erreur de requete, lu dans le STATUT HTTP (jamais dans le texte du message). */
export function classerErreur(e: unknown): GenreErreur {
  if ((e as { name?: unknown } | null)?.name === "ReponseIllisible") return "illisible";
  const reponse = (e as { response?: { status?: unknown } } | null)?.response;
  if (!reponse) return "reseau";
  const statut = reponse.status;
  if (statut === 401 || statut === 403) return "refuse";
  if (statut === 404) return "introuvable";
  return "serveur";
}

export function messageErreur(genre: GenreErreur, cible: "liste" | "detail"): string {
  const objet = cible === "liste" ? "la liste des relevés envoyés" : "ce relevé";
  const e = cible === "liste" ? "e" : ""; // accord du participe avec « la liste »
  switch (genre) {
    case "refuse": return cible === "liste"
      ? "Accès refusé : votre compte n'a pas le droit de consulter les relevés envoyés."
      : "Accès refusé : votre compte n'a pas le droit de consulter ce relevé.";
    case "introuvable": return "Relevé introuvable. Il n'existe pas, ou il n'est pas accessible avec ce compte.";
    case "reseau": return `Le serveur n'a pas répondu : ${objet} n'a pas pu être chargé${e}. Vérifier la connexion puis réessayer.`;
    case "illisible": return `Le serveur a répondu, mais ${objet} n'a pas pu être lu${e}. Ce n'est pas une absence de relevé : réessayer, puis prévenir la DSI si cela persiste.`;
    default: return `Le serveur a signalé une erreur : ${objet} n'a pas pu être chargé${e}. Réessayer.`;
  }
}

/** Faute de droit ou relevé introuvable : relancer la meme requete ne changerait rien, le bouton « Reessayer » n'a pas de sens. */
export function peutReessayer(genre: GenreErreur): boolean {
  return genre !== "refuse" && genre !== "introuvable";
}

// ------------------------------------------------------------------ trace

/** Les lignes de la trace en [lat, lon] (ordre de Leaflet). Un point hors plage est ecarte, une ligne de moins de 2 points aussi. */
export function lignesTrace(g: GeometrieReleve | null): PointCarte[][] {
  if (!g || g.type !== "MultiLineString" || !Array.isArray(g.coordinates)) return [];
  const sortie: PointCarte[][] = [];
  for (const ligne of g.coordinates) {
    if (!Array.isArray(ligne)) continue;
    const pts: PointCarte[] = [];
    for (const p of ligne) {
      if (!Array.isArray(p) || !fini(p[0]) || !fini(p[1])) continue;
      if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) continue;
      pts.push([p[1], p[0]]);
    }
    if (pts.length >= 2) sortie.push(pts);
  }
  return sortie;
}

export interface EtatTrace {
  genre: "absente" | "simplifiee" | "complete";
  lignes: PointCarte[][];
  /** Phrase a montrer a cote de la carte, ou `null` quand rien n'est a signaler. */
  message: string | null;
}

export function etatTrace(d: Pick<DetailReleveEnvoye, "geometrie" | "simplifiee" | "trace">): EtatTrace {
  const lignes = lignesTrace(d.geometrie);
  if (lignes.length === 0) {
    return { genre: "absente", lignes, message: "Trace non disponible : le serveur n'a pas de géométrie utilisable pour ce relevé." };
  }
  if (d.simplifiee) {
    return {
      genre: "simplifiee", lignes,
      message: `Trace simplifiée pour l'affichage : le serveur a enregistré ${libelleNombre(d.trace.nbPoints)} positions et en dessine moins ici. Les détails fins du parcours ne sont pas tous visibles. La distance parcourue vient de l'analyse des positions enregistrées, pas de ce tracé.`,
    };
  }
  return { genre: "complete", lignes, message: null };
}

/** Le serveur garde-t-il les positions detaillees (`trace.pointsDisponibles`, booleen) ? `null` quand oui. */
export function noteSurPositions(t: DetailReleveEnvoye["trace"]): string | null {
  if (t.pointsDisponibles === false) return "Les positions détaillées de ce relevé ne sont pas disponibles sur le serveur.";
  return null;
}

// ------------------------------------------------------------------ analyse

/** Un nombre, ou la taille d'une liste ; tout le reste est « inconnu » (`null`), jamais zero. */
export function compter(v: unknown): number | null {
  if (fini(v) && v >= 0) return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

/** Trous, interruptions ou pauses : lus dans le bloc du meme nom, sinon dans `compteurs`. Absent des deux : `null`. */
export function lireCompte(analyse: DetailReleveEnvoye["analyse"], nom: "trous" | "interruptions" | "pauses"): number | null {
  const direct = compter(analyse?.[nom]);
  if (direct !== null) return direct;
  const c = analyse?.compteurs;
  return estObjet(c) ? compter(c[nom]) : null;
}

/** Positions ecartees par le filtre de l'appareil, si `compteurs.rejets` les compte ; sinon `null`. */
export function positionsEcartees(compteurs: unknown): number | null {
  if (!estObjet(compteurs) || !estObjet(compteurs.rejets)) return null;
  const valeurs = Object.values(compteurs.rejets);
  return valeurs.every(fini) ? valeurs.reduce((s, n) => s + n, 0) : null;
}

/** Ce que l'analyse du serveur (`analyse.serveur`) dit, lu sans rien supposer : un bloc absent ou d'une autre forme donne `null` / liste vide. */
export interface AnalyseServeurLue {
  /** Avertissements du serveur, dans leur ordre et TELS QUE LE SERVEUR LES A ECRITS (sans doublon exact). */
  avertissements: string[];
  pointsRecus: number | null;
  pointsRetenus: number | null;
  pointsRattaches: number | null;
}

export function lireAnalyseServeur(serveur: unknown): AnalyseServeurLue {
  const s = estObjet(serveur) ? serveur : {};
  const ind = estObjet(s.indicateurs) ? s.indicateurs : {};
  const nb = (v: unknown) => (fini(v) && v >= 0 ? v : null);
  const brut = Array.isArray(s.avertissements) ? s.avertissements : [];
  const avertissements = [...new Set(brut.filter((a): a is string => typeof a === "string" && a.trim().length > 0))];
  return { avertissements, pointsRecus: nb(ind.pointsRecus), pointsRetenus: nb(ind.pointsRetenus), pointsRattaches: nb(ind.pointsRattaches) };
}

export interface LigneResume { libelle: string; valeur: string }

/** Le resume chiffre du releve, dans l'ordre d'affichage. Une valeur inconnue est dite, pas calculee. */
export function lignesResume(d: DetailReleveEnvoye, o: Pick<OptionsDate, "fuseau"> = {}): LigneResume[] {
  const nombre = (n: number | null) => (n === null ? "non communiqué" : libelleNombre(n));
  const serveur = lireAnalyseServeur(d.analyse?.serveur);
  const lignes: LigneResume[] = [
    { libelle: "Début", valeur: libelleDateHeure(d.debutA, o) },
    { libelle: "Fin", valeur: libelleDateHeure(d.finA, o) },
    { libelle: "Durée", valeur: libelleDureeReleve(d.dureeS) },
    { libelle: "Distance parcourue", valeur: libelleDistance(d.longueurM) },
    { libelle: "Positions enregistrées", valeur: libelleNombre(d.nbPoints) },
    { libelle: "Repères", valeur: libelleNombre(d.nbMarqueurs) },
    { libelle: "Segments", valeur: libelleNombre(d.nbEvenements) },
    { libelle: "Rattachement au réseau", valeur: libelleTaux(d.tauxRattachement) },
  ];
  // Le denominateur du taux : sans lui, « 0 % » ou « 100 % » ne dit pas sur combien de positions.
  if (serveur.pointsRetenus !== null) lignes.push({ libelle: "Positions retenues par l'analyse", valeur: libelleNombre(serveur.pointsRetenus) });
  if (serveur.pointsRattaches !== null) lignes.push({ libelle: "dont rattachées au réseau", valeur: libelleNombre(serveur.pointsRattaches) });
  lignes.push(
    { libelle: "Trous de signal", valeur: nombre(lireCompte(d.analyse, "trous")) },
    { libelle: "Interruptions", valeur: nombre(lireCompte(d.analyse, "interruptions")) },
    { libelle: "Pauses", valeur: nombre(lireCompte(d.analyse, "pauses")) },
  );
  const ecartees = positionsEcartees(d.analyse?.compteurs);
  if (ecartees !== null) lignes.push({ libelle: "Positions écartées par l'appareil", valeur: libelleNombre(ecartees) });
  lignes.push({ libelle: "Tronçons rattachés", valeur: libelleNombre(d.nbTronconsTraverses) });
  return lignes;
}

const PROVENANCE: Record<string, string> = { PROVISOIRE_NON_CALIBRE: "seuils provisoires, non calibrés" };

/** La provenance des seuils de l'appareil. Une provenance inconnue est rendue telle quelle. */
export const libelleProvenance = (code: string): string => PROVENANCE[code] ?? code;

/** Les seuils appliques par l'appareil, tels qu'ecrits : nom technique et valeur, rien n'est traduit ni interprete. */
export function lignesSeuils(seuils: DetailReleveEnvoye["parametres"]["seuils"]): LigneResume[] {
  if (!seuils) return [];
  return Object.entries(seuils).map(([nom, v]) => ({ libelle: nom, valeur: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v) }));
}

// ------------------------------------------------------------------ reperes et segments

export interface MarqueurCarte {
  marqueur: MarqueurReleve;
  position: PointCarte;
  etiquette: string;
  /** Vrai : l'emplacement dessine est celui d'un dernier point GPS ANCIEN du telephone, pas une position retrouvee sur la trace. */
  approximative: boolean;
}

/** Le repere tel qu'on l'ecrit sur la carte et dans la liste : code et heure de pose. */
export function etiquetteMarqueur(m: Pick<MarqueurReleve, "code" | "poseA">, o: Pick<OptionsDate, "fuseau"> = {}): string {
  return `${m.code} à ${libelleHeure(m.poseA, o)}`;
}

/**
 * La position d'un repere est APPROXIMATIVE quand elle vient du dernier point GPS du telephone et que celui-ci etait ancien.
 * Quand le serveur l'a retrouvee SUR LA TRACE (`sourcePosition` = TRACE, interpolee a l'instant exact de la pose), l'anciennete du
 * dernier point du telephone ne la concerne plus : le contrat le dit, et l'ecran n'avertit pas a tort.
 */
export function positionApproximative(m: Pick<MarqueurReleve, "positionPerimee" | "sourcePosition">): boolean {
  return m.positionPerimee && m.sourcePosition !== "TRACE";
}

/** Les reperes qui ont une position a dessiner, et ceux qui n'en ont pas (listes, jamais perdus). */
export function repartirMarqueurs(marqueurs: readonly MarqueurReleve[], o: Pick<OptionsDate, "fuseau"> = {}): { surCarte: MarqueurCarte[]; sansPosition: MarqueurReleve[] } {
  const surCarte: MarqueurCarte[] = [];
  const sansPosition: MarqueurReleve[] = [];
  for (const m of marqueurs) {
    if (fini(m.lat) && fini(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180) {
      surCarte.push({ marqueur: m, position: [m.lat, m.lon], etiquette: etiquetteMarqueur(m, o), approximative: positionApproximative(m) });
    } else {
      sansPosition.push(m);
    }
  }
  return { surCarte, sansPosition };
}

const STATUT_MARQUEUR: Record<string, string> = { RATTACHE: "rattaché à un tronçon", NON_RATTACHE: "non rattaché à un tronçon" };
const STATUT_RATTACHEMENT: Record<string, string> = {
  PORTIONS_CREEES: "portions proposées",
  PORTIONS_PARTIELLES: "portions proposées en partie",
  PORTIONS_REFUSEES: "portions refusées par le serveur",
  NON_RATTACHE: "non rattaché au réseau",
  ABANDONNE: "abandonné par l'agent",
};
const STATUT_APPAREIL: Record<string, string> = { OUVERT: "ouvert", CLOS: "clos", CLOS_PAR_ARRET: "clos à l'arrêt", ABANDONNE: "abandonné" };
const SENS: Record<string, string> = { CROISSANT: "sens croissant", DECROISSANT: "sens décroissant" };
// Motifs ecrits par le serveur (backend/src/roulage/session.service.ts, rattachement.noyau.ts). Un motif absent de ces tables est rendu tel quel.
const MOTIF_MARQUEUR: Record<string, string> = {
  AUCUN_POINT_RATTACHE_A_PROXIMITE: "aucun point de la trace n'était rattaché au réseau près de l'instant de pose",
  POSITION_INCONNUE: "position inconnue à l'instant de pose",
  TRONCON_SANS_GEOMETRIE: "le tronçon n'a pas de géométrie de référence",
  TROP_LOIN_DU_TRONCON: "trop loin du tronçon pour y être rattaché",
};
const MOTIF_EVENEMENT: Record<string, string> = {
  AUCUN_POINT_RATTACHE_AU_DEBUT: "aucun point de la trace rattaché au réseau au début du segment",
  AUCUN_POINT_RATTACHE_A_LA_FIN: "aucun point de la trace rattaché au réseau à la fin du segment",
  FIN_AVANT_DEBUT: "la fin du segment n'est pas postérieure à son début",
  ABSCISSE_INCONNUE: "position du segment sur le tronçon inconnue",
};

/** Traduit un code connu ; un code inconnu est rendu tel quel : le serveur peut en ajouter, l'ecran n'en devine pas le sens. */
const traduire = (table: Record<string, string>, code: string): string => table[code] ?? code;

export const libelleStatutMarqueur = (code: string) => traduire(STATUT_MARQUEUR, code);
export const libelleStatutRattachement = (code: string) => traduire(STATUT_RATTACHEMENT, code);
export const libelleStatutAppareil = (code: string) => traduire(STATUT_APPAREIL, code);
export const libelleSens = (sens: string | null) => (sens === null ? "sens non précisé" : traduire(SENS, sens));
export const libelleMotifMarqueur = (motif: string) => traduire(MOTIF_MARQUEUR, motif);

/** Motif d'un segment : `CODE_REFERENTIEL_INCONNU:<champ>` est lu, les autres codes sont traduits s'ils sont connus, sinon rendus tels quels. */
export function libelleMotifEvenement(motif: string): string {
  const m = /^CODE_REFERENTIEL_INCONNU:(.+)$/.exec(motif);
  return m ? `code de référentiel inconnu (${m[1]})` : traduire(MOTIF_EVENEMENT, motif);
}

/** Le rattachement d'un repere, en une phrase : troncon et distance depuis son debut s'il est rattache, motif sinon. */
export function libelleRattachementMarqueur(m: Pick<MarqueurReleve, "statut" | "motif" | "tronconCode" | "abscisseM">): string {
  const base = libelleStatutMarqueur(m.statut);
  if (m.statut === "RATTACHE") {
    const troncon = m.tronconCode ? ` ${m.tronconCode}` : "";
    const abscisse = fini(m.abscisseM) ? `, à ${libelleKm(m.abscisseM)} du début du tronçon` : "";
    return `${base}${troncon}${abscisse}`;
  }
  const motif = m.motif ? ` (${libelleMotifMarqueur(m.motif)})` : "";
  const pressenti = m.tronconCode ? `, tronçon pressenti ${m.tronconCode}` : "";
  return `${base}${motif}${pressenti}`;
}

/**
 * Le resultat du rattachement d'un segment : son statut, et le motif quand le serveur en donne un. Le motif d'un segment ABANDONNE est le
 * texte ecrit par l'agent : il est cite tel quel, entre guillemets.
 */
export function libelleResultatEvenement(e: Pick<EvenementReleve, "statutRattachement" | "motif">): string {
  const base = libelleStatutRattachement(e.statutRattachement);
  if (!e.motif) return base;
  return e.statutRattachement === "ABANDONNE" ? `${base} (motif écrit par l'agent : « ${e.motif} »)` : `${base} (${libelleMotifEvenement(e.motif)})`;
}

/** Vrai s'il existe des portions que le serveur a refusees : la consultation ne les liste pas, l'ecran le dit. */
export const aDesPortionsNonListees = (evenements: readonly Pick<EvenementReleve, "statutRattachement">[]): boolean =>
  evenements.some((e) => e.statutRattachement === "PORTIONS_PARTIELLES" || e.statutRattachement === "PORTIONS_REFUSEES");

/** D'ou vient la position affichee d'un repere, ou `null` quand le serveur ne le dit pas. */
export function libelleSourcePosition(source: string | null): string | null {
  if (source === "TRACE") return "position retrouvée sur la trace à l'instant de pose";
  if (source === "APPAREIL") return "position du téléphone (pas de trace à cet instant)";
  return null;
}

/** La note a montrer pour un repere dont la position est douteuse ou absente, ou `null`. */
export function noteMarqueur(m: Pick<MarqueurReleve, "positionPerimee" | "sourcePosition" | "lat" | "lon">): string | null {
  const sansPosition = !fini(m.lat) || !fini(m.lon);
  if (sansPosition) return "Aucune position connue pour ce repère : il n'est pas placé sur la carte.";
  if (m.positionPerimee && m.sourcePosition === "TRACE") {
    return "Le dernier point GPS du téléphone était ancien quand le repère a été posé ; la position affichée est celle de la trace à cet instant.";
  }
  if (m.positionPerimee) return "Position périmée : le dernier point GPS connu était trop ancien quand le repère a été posé ; l'emplacement est approximatif.";
  return null;
}

/** Choix de l'agent sur un segment (codes de referentiel, pas des libelles) : rien n'est ajoute, rien n'est devine. */
export function libelleQualification(q: EvenementReleve["qualification"]): string {
  if (!q) return "aucune qualification";
  const morceaux: string[] = [];
  const texte = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const revetement = texte(q.revetement);
  const etat = texte(q.etat);
  const praticabilite = texte(q.praticabilite);
  if (revetement) morceaux.push(`revêtement ${revetement}`);
  if (etat) morceaux.push(`état ${etat}`);
  if (praticabilite) morceaux.push(`praticabilité ${praticabilite}`);
  if (fini(q.largeurM)) morceaux.push(`largeur ${libelleKm(q.largeurM)}`);
  return morceaux.length > 0 ? morceaux.join(", ") : "aucune qualification";
}

export function libellePortion(p: Pick<PortionEvenement, "debutM" | "finM" | "sens">): string {
  const borne = (m: number | null) => (m === null ? "?" : libelleKm(m));
  return `de ${borne(p.debutM)} à ${borne(p.finM)} depuis le début du tronçon, ${libelleSens(p.sens)}`;
}

// ------------------------------------------------------------------ troncons rattaches

export interface PassageTroncon { evenementId: string; evenementCode: string; rang: number; portion: PortionEvenement }
export interface TronconRattache { tronconId: string; code: string | null; nom: string | null; passages: PassageTroncon[]; reperes: MarqueurReleve[] }

/**
 * Les troncons auxquels le releve se rattache : ceux d'une portion creee et ceux d'un repere RATTACHE (une entree par troncon, ses
 * portions et ses reperes regroupes). C'est la definition du compte du serveur (`nbTronconsTraverses`) : les deux peuvent donc
 * etre compares. La trace elle-meme n'enregistre pas la liste des troncons longes : ils ne sont pas inventes ici.
 */
export function tronconsRattaches(evenements: readonly EvenementReleve[], marqueurs: readonly MarqueurReleve[] = []): TronconRattache[] {
  const par = new Map<string, TronconRattache>();
  const entree = (id: string, code: string | null, nom: string | null): TronconRattache => {
    let t = par.get(id);
    if (!t) {
      t = { tronconId: id, code, nom, passages: [], reperes: [] };
      par.set(id, t);
    } else {
      t.code ??= code;
      t.nom ??= nom;
    }
    return t;
  };
  for (const e of evenements) {
    for (const p of [...e.portions].sort((a, b) => a.rang - b.rang)) {
      entree(p.tronconId, p.tronconCode, p.tronconNom).passages.push({ evenementId: e.id, evenementCode: e.code, rang: p.rang, portion: p });
    }
  }
  for (const m of marqueurs) {
    if (m.statut === "RATTACHE" && m.tronconId) entree(m.tronconId, m.tronconCode, null).reperes.push(m);
  }
  return [...par.values()];
}

export function noteTronconsManquants(nbServeur: number, detailles: number): string | null {
  if (!fini(nbServeur) || nbServeur <= detailles) return null;
  return `Le serveur compte ${libelleNombre(nbServeur)} tronçons rattachés ; ${libelleNombre(detailles)} seulement sont détaillés ici (ceux qui portent une portion d'un segment ou un repère rattaché).`;
}

export function libelleTroncon(t: Pick<TronconRattache, "code" | "nom" | "tronconId">): string {
  if (t.code && t.nom) return `${t.code} : ${t.nom}`;
  return t.code ?? t.nom ?? `Tronçon ${t.tronconId.slice(0, 8)}`;
}
