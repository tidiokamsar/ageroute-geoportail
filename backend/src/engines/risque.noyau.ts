/**
 * INDICE DE RISQUE -- noyau du Risk Engine (paragraphe 7.7). Aucun acces base.
 *
 * Le mandat nomme cinq facteurs : etat, trafic ou importance, enjeux de securite, vulnerabilite
 * climatique, population desservie. MAINTENANCE_PROGRAMMING_DESIGN.md (paragraphe 3.2) avertit :
 * sur ces cinq facteurs, UN SEUL existe en base (l'etat, par import) ; ecrire le moteur tel quel
 * produirait « un indice a un facteur portant un nom a cinq ». La regle retenue est donc celle du
 * RCI (engines/condition.ts) : le moteur RENORMALISE sur les facteurs disponibles, DIT lesquels
 * manquent, et REFUSE sous un plancher.
 *
 *   risque = somme(poids_i x valeur_i) / somme(poids_i), sur les facteurs ponderes ET disponibles
 *
 * CE QUI EST UN CHOIX DE MODELISATION, ET NON UNE REGLE DU MANDAT. Le mandat ecrit un produit
 * (« etat x trafic x ... »). Un produit n'a pas de sens quand un facteur manque : renormaliser un
 * produit revient a inventer l'exposant des facteurs absents. Une somme ponderee renormalisee
 * est la forme qui supporte l'absence sans valeur de repli. Ce choix est PROVISOIRE comme les
 * poids ; il est a confirmer avec les parametres (D-01 pour l'etat, aucune decision pour les
 * quatre autres facteurs, qui n'ont aujourd'hui aucune source).
 *
 * UNE ABSENCE N'EST JAMAIS UN ZERO. Un troncon sans comptage de trafic ne devient pas « peu
 * expose » : le facteur sort du calcul, avec son motif. Un etat NON_EVALUE ne devient pas BON :
 * l'ETAT est le seul facteur OBLIGATOIRE, parce qu'il pilote aussi le choix du traitement ; sans
 * lui, le moteur refuse.
 *
 * DETERMINISME. Que des additions, multiplications et divisions IEEE 754 (identiques sur tout
 * moteur), dans l'ordre fixe de FACTEURS_RISQUE, puis un arrondi a 4 decimales. Aucun exp/log/pow.
 */

import {
  FACTEURS_RISQUE, etiquetteParametres,
  type FacteurRisque, type ParametresProgrammation, type ValeursParametres,
} from "../programmation/parametres.noyau";

export interface EntreesRisque {
  /** Etat patrimonial du troncon : BON, MOYEN, MAUVAIS, CRITIQUE ou NON_EVALUE. */
  etat: string | null;
  traficMoyenJma: number | null;
  /** Colonne `troncons.criticiteStrategique` : provenance inconnue, lue comme une importance 0 a 100. */
  criticiteStrategique: number | null;
  /** Nombre de points noirs rattaches au troncon ; `null` si la source n'est pas exploitable. */
  nbPointsNoirs: number | null;
  /** Vulnerabilite climatique 0 a 100 ; aucune source dans le depot (partie E non commencee). */
  vulnerabiliteClimatique: number | null;
  /** Population desservie ; aucune source dans le depot. */
  populationDesservie: number | null;
}

export interface FacteurEvalue {
  facteur: FacteurRisque;
  poids: number;
  /** Vrai si le poids est > 0 : un facteur a poids nul est exclu EXPLICITEMENT. */
  pondere: boolean;
  disponible: boolean;
  /** Valeur normalisee 0 a 100 (4 decimales), `null` si indisponible. */
  valeur: number | null;
  /** Donnee brute telle que lue. */
  brut: number | string | null;
  /** D'ou vient la valeur (colonne, regle de normalisation). */
  origine: string | null;
  /** Pourquoi le facteur est indisponible, ou comment il a ete normalise. */
  note: string;
}

export type CodeRefusRisque =
  | "AUCUN_FACTEUR_PONDERE"
  | "ETAT_NON_EVALUE"
  | "FACTEURS_INSUFFISANTS"
  | "COUVERTURE_INSUFFISANTE";

export interface RisqueCalcule {
  ok: true;
  /** Risque 0 a 100, 4 decimales. */
  score: number;
  /** Le meme risque en entier (score x 10 000) : sert aux comparaisons exactes. */
  scoreMicro: number;
  facteurs: FacteurEvalue[];
  facteursDisponibles: number;
  facteursPonderes: number;
  /** Part du poids total effectivement couverte, 0 a 1 (4 decimales). */
  couverture: number;
  formule: string;
  etiquette: string;
}

export interface RisqueRefuse {
  ok: false;
  code: CodeRefusRisque;
  motif: string;
  facteurs: FacteurEvalue[];
  etiquette: string;
}

export type ResultatRisque = RisqueCalcule | RisqueRefuse;

export const arrondi4 = (x: number): number => Math.round(x * 10000) / 10000;
const borne100 = (x: number): number => (x < 0 ? 0 : x > 100 ? 100 : x);

const ABSENT = (poids: number, note: string): FacteurEvalue => ({ facteur: "ETAT", poids, pondere: poids > 0, disponible: false, valeur: null, brut: null, origine: null, note });

function evaluerFacteurs(e: EntreesRisque, v: ValeursParametres): FacteurEvalue[] {
  const sortie: FacteurEvalue[] = [];
  for (const f of FACTEURS_RISQUE) {
    const poids = v.poidsRisque[f];
    const base = (note: string): FacteurEvalue => ({ ...ABSENT(poids, note), facteur: f });
    switch (f) {
      case "ETAT": {
        const n = e.etat !== null ? (v.etatVersRisque as Record<string, number | undefined>)[e.etat] : undefined;
        if (n === undefined) {
          sortie.push({ ...base(e.etat === null || e.etat === "NON_EVALUE" ? "etat non evalue : une absence d'information n'est pas un etat bon" : `etat ${e.etat} absent de la correspondance etat vers risque`), brut: e.etat });
        } else {
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: arrondi4(n), brut: e.etat, origine: "troncons.etat via etatVersRisque", note: `etat ${e.etat} vaut ${n} dans la correspondance etat vers risque` });
        }
        break;
      }
      case "TRAFIC_IMPORTANCE": {
        if (e.traficMoyenJma !== null && Number.isFinite(e.traficMoyenJma) && e.traficMoyenJma >= 0) {
          const val = arrondi4(borne100((e.traficMoyenJma / v.traficPlafondJma) * 100));
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: val, brut: e.traficMoyenJma, origine: "troncons.traficMoyenJma", note: `${e.traficMoyenJma} veh/j sur un plafond de ${v.traficPlafondJma}, borne a 100` });
        } else if (e.criticiteStrategique !== null && Number.isFinite(e.criticiteStrategique) && e.criticiteStrategique >= 0 && e.criticiteStrategique <= 100) {
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: arrondi4(e.criticiteStrategique), brut: e.criticiteStrategique, origine: "troncons.criticiteStrategique", note: "aucun trafic : importance lue dans la criticite strategique (provenance non documentee), prise telle quelle sur 0 a 100" });
        } else if (e.criticiteStrategique !== null) {
          sortie.push({ ...base(`criticite strategique ${e.criticiteStrategique} hors de l'echelle 0 a 100 : non lue`), brut: e.criticiteStrategique });
        } else {
          sortie.push(base("ni comptage de trafic ni criticite strategique"));
        }
        break;
      }
      case "SECURITE": {
        if (e.nbPointsNoirs !== null && Number.isFinite(e.nbPointsNoirs) && e.nbPointsNoirs >= 0) {
          const val = arrondi4(borne100((e.nbPointsNoirs / v.pointsNoirsPlafond) * 100));
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: val, brut: e.nbPointsNoirs, origine: "points_noirs.tronconId", note: `${e.nbPointsNoirs} point(s) noir(s) sur un plafond de ${v.pointsNoirsPlafond}, borne a 100` });
        } else sortie.push(base("source des points noirs non exploitable"));
        break;
      }
      case "CLIMAT": {
        if (e.vulnerabiliteClimatique !== null && Number.isFinite(e.vulnerabiliteClimatique) && e.vulnerabiliteClimatique >= 0 && e.vulnerabiliteClimatique <= 100) {
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: arrondi4(e.vulnerabiliteClimatique), brut: e.vulnerabiliteClimatique, origine: "vulnerabilite climatique fournie", note: "valeur 0 a 100 prise telle quelle" });
        } else sortie.push(base("aucune source de vulnerabilite climatique"));
        break;
      }
      case "POPULATION": {
        if (e.populationDesservie !== null && Number.isFinite(e.populationDesservie) && e.populationDesservie >= 0) {
          const val = arrondi4(borne100((e.populationDesservie / v.populationPlafond) * 100));
          sortie.push({ facteur: f, poids, pondere: poids > 0, disponible: true, valeur: val, brut: e.populationDesservie, origine: "population desservie fournie", note: `${e.populationDesservie} habitants sur un plafond de ${v.populationPlafond}, borne a 100` });
        } else sortie.push(base("aucune source de population desservie"));
        break;
      }
    }
  }
  return sortie;
}

/** La formule, sous forme lisible, pour que « pourquoi ce risque » ait une reponse. */
export const FORMULE_RISQUE = "risque = somme(poids x valeur) / somme(poids) sur les facteurs ponderes et disponibles ; valeurs normalisees sur 0 a 100 et arrondies a 4 decimales AVANT agregation (le score se refait a la main depuis les valeurs affichees) ; score arrondi a 4 decimales";

export function calculerRisque(e: EntreesRisque, p: ParametresProgrammation): ResultatRisque {
  const v = p.valeurs;
  const etiquette = etiquetteParametres(p);
  const facteurs = evaluerFacteurs(e, v);
  const ponderes = facteurs.filter((f) => f.pondere);

  if (ponderes.length === 0) {
    return { ok: false, code: "AUCUN_FACTEUR_PONDERE", motif: "tous les poids sont nuls : il n'y a rien a calculer", facteurs, etiquette };
  }
  const etat = facteurs.find((f) => f.facteur === "ETAT")!;
  if (!etat.disponible) {
    return { ok: false, code: "ETAT_NON_EVALUE", motif: `l'etat est le facteur obligatoire (il pilote aussi le choix du traitement) : ${etat.note}`, facteurs, etiquette };
  }
  const dispo = ponderes.filter((f) => f.disponible);
  if (dispo.length < v.facteursMinimum) {
    const manquants = ponderes.filter((f) => !f.disponible).map((f) => `${f.facteur} (${f.note})`);
    return { ok: false, code: "FACTEURS_INSUFFISANTS", motif: `${dispo.length} facteur(s) disponible(s) sur ${ponderes.length} ponderes, minimum ${v.facteursMinimum} : manque ${manquants.join(" ; ")}`, facteurs, etiquette };
  }
  const poidsTotal = ponderes.reduce((s, f) => s + f.poids, 0);
  const poidsDispo = dispo.reduce((s, f) => s + f.poids, 0);
  const couverture = arrondi4(poidsDispo / poidsTotal);
  if (couverture < v.couvertureMinimale) {
    return { ok: false, code: "COUVERTURE_INSUFFISANTE", motif: `les facteurs disponibles couvrent ${couverture} du poids total, minimum ${v.couvertureMinimale}`, facteurs, etiquette };
  }
  let somme = 0;
  for (const f of dispo) somme += f.poids * (f.valeur as number);
  const score = arrondi4(somme / poidsDispo);
  return {
    ok: true, score, scoreMicro: Math.round(score * 10000), facteurs,
    facteursDisponibles: dispo.length, facteursPonderes: ponderes.length, couverture,
    formule: FORMULE_RISQUE, etiquette,
  };
}
