/**
 * Evaluation du registre d'indicateurs : calcule, controle, et dit pourquoi une valeur manque.
 *
 * TROIS ETATS, JAMAIS UN CHIFFRE INVENTE
 *   CALCULE       la valeur, et le perimetre qui la porte ;
 *   INDISPONIBLE  l'indicateur n'est pas ventile par region et le compte est regional (A10) : aucune
 *                 valeur nationale n'est rendue a sa place ;
 *   ERREUR        le calcul a echoue : l'erreur est journalisee et dite, l'ecran ne la prend pas pour un zero.
 *
 * Un indicateur dont la table source est vide dans la portee porte `aucuneDonnee: true` : le module
 * affiche « aucune donnee » avec son perimetre, au lieu d'un 0 qu'on lirait comme un constat.
 */

import {
  disponibilite, enParallele, valeursEgales,
  type DefinitionIndicateur, type Groupe, type PerimetreIndicateur, type Portee, type Unite, type Valeur,
} from "./indicateurs.noyau";

/** Trois requetes de front a la fois au plus : le tableau de bord ne doit pas vider le pool de connexions. */
const CONCURRENCE = 4;

export interface IndicateurEvalue {
  code: string;
  libelle: string;
  groupe: Groupe;
  unite: Unite;
  perimetre: PerimetreIndicateur;
  statut: "CALCULE" | "INDISPONIBLE" | "ERREUR";
  valeur: Valeur;
  motif: string | null;
  /** Vrai quand la table source est vide dans la portee, ou que la valeur n'est pas calculable (`null`). */
  aucuneDonnee: boolean;
  sourceLibelle: string | null;
}

export interface FiltreIndicateurs {
  groupes?: readonly Groupe[];
  codes?: readonly string[];
  /** N'interroge pas les tables sources : `aucuneDonnee` ne vaut alors que « valeur non calculable ». Pour qui n'affiche pas ce message. */
  sansSource?: boolean;
}

function retenu<D>(registre: readonly DefinitionIndicateur<D>[], filtre?: FiltreIndicateurs): DefinitionIndicateur<D>[] {
  return registre.filter((d) =>
    (!filtre?.groupes || filtre.groupes.includes(d.groupe)) && (!filtre?.codes || filtre.codes.includes(d.code)));
}

function journaliser(code: string, err: unknown): void {
  console.error(`[tableau-de-bord] indicateur ${code} en erreur :`, err instanceof Error ? err.message : err);
}

export async function evaluer<D>(
  depot: D, registre: readonly DefinitionIndicateur<D>[], portee: Portee, filtre?: FiltreIndicateurs,
): Promise<IndicateurEvalue[]> {
  // Une source n'est interrogee qu'une fois par appel, meme partagee par plusieurs indicateurs.
  const sources = new Map<string, Promise<boolean>>();
  const videDe = (d: DefinitionIndicateur<D>): Promise<boolean> | null => {
    if (!d.source || filtre?.sansSource) return null;
    if (!sources.has(d.source.cle)) sources.set(d.source.cle, d.source.vide(depot, portee));
    return sources.get(d.source.cle)!;
  };

  return enParallele(retenu(registre, filtre), CONCURRENCE, async (d): Promise<IndicateurEvalue> => {
    const base = { code: d.code, libelle: d.libelle, groupe: d.groupe, unite: d.unite, perimetre: d.perimetre, sourceLibelle: d.source?.libelle ?? null };
    const dispo = disponibilite(d, portee);
    if (!dispo.disponible) return { ...base, statut: "INDISPONIBLE", valeur: null, motif: dispo.motif, aucuneDonnee: false };
    try {
      const [valeur, vide] = await Promise.all([d.calcul(depot, portee), videDe(d) ?? Promise.resolve(false)]);
      return { ...base, statut: "CALCULE", valeur, motif: null, aucuneDonnee: vide || valeur === null };
    } catch (err) {
      journaliser(d.code, err);
      return { ...base, statut: "ERREUR", valeur: null, motif: "Le calcul de cet indicateur a échoué ; l'incident est journalisé.", aucuneDonnee: false };
    }
  });
}

export interface ResultatControle {
  code: string;
  libelle: string;
  unite: Unite;
  perimetre: PerimetreIndicateur;
  statut: "EGAL" | "ECART" | "INDISPONIBLE" | "ERREUR";
  calcul: Valeur;
  controle: Valeur;
  motif: string | null;
}

export interface RapportControle {
  genereLe: string;
  total: number;
  egaux: number;
  ecarts: number;
  erreurs: number;
  indisponibles: number;
  resultats: ResultatControle[];
}

/** Rapproche chaque indicateur de sa requete de controle. Un ecart n'est jamais corrige : il est montre. */
export async function controler<D>(
  depot: D, registre: readonly DefinitionIndicateur<D>[], portee: Portee, filtre?: FiltreIndicateurs,
): Promise<RapportControle> {
  const resultats = await enParallele(retenu(registre, filtre), CONCURRENCE, async (d): Promise<ResultatControle> => {
    const base = { code: d.code, libelle: d.libelle, unite: d.unite, perimetre: d.perimetre };
    const dispo = disponibilite(d, portee);
    if (!dispo.disponible) return { ...base, statut: "INDISPONIBLE", calcul: null, controle: null, motif: dispo.motif };
    try {
      const [calcul, controle] = await Promise.all([d.calcul(depot, portee), d.controle(depot, portee)]);
      const egal = valeursEgales(calcul, controle, d.unite);
      return { ...base, statut: egal ? "EGAL" : "ECART", calcul, controle, motif: egal ? null : "Le calcul et la requête de contrôle ne rendent pas la même valeur." };
    } catch (err) {
      journaliser(d.code, err);
      return { ...base, statut: "ERREUR", calcul: null, controle: null, motif: "Le rapprochement a échoué ; l'incident est journalisé." };
    }
  });
  const compter = (s: ResultatControle["statut"]) => resultats.filter((r) => r.statut === s).length;
  return {
    genereLe: portee.maintenant.toISOString(),
    total: resultats.length,
    egaux: compter("EGAL"), ecarts: compter("ECART"), erreurs: compter("ERREUR"), indisponibles: compter("INDISPONIBLE"),
    resultats,
  };
}
