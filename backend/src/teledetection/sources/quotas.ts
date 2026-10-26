/**
 * Compteurs de requetes de la session et limites CONNUES des fournisseurs.
 *
 * Deux choses distinctes, jamais melangees :
 *   - les COMPTEURS sont mesures ici, a chaque requete HTTP envoyee (nouvelles tentatives comprises) ;
 *   - les LIMITES sont recopiees de la documentation du fournisseur, avec l'adresse de la page et la
 *     date de consultation. Quand la documentation ne chiffre pas une limite, la valeur est null :
 *     on ne la devine pas.
 *
 * Les compteurs sont ceux du PROCESSUS : ils repartent de zero au redemarrage et ne voient pas les
 * autres instances. Ils servent a la prudence (ne pas s'approcher d'une limite), pas a la facturation.
 */
import type { CompteursRequetes, LimiteConnue } from "./contrat";

export class CompteurRequetes {
  private c = {
    requetesEnvoyees: 0, appelsLogiques: 0, nouvellesTentatives: 0, reponses2xx: 0, reponses429: 0,
    reponses5xx: 0, autresStatuts: 0, echecsReseau: 0, delaisDepasses: 0, octetsRecus: 0,
  };
  private premiere: number | null = null;
  private derniere: number | null = null;
  private fenetre: number[] = [];

  constructor(private readonly maintenant: () => number) {}

  appelLogique(): void { this.c.appelsLogiques++; }

  /** A appeler JUSTE AVANT chaque envoi HTTP. `nouvelleTentative` vaut true des le deuxieme envoi d'un meme appel. */
  envoi(nouvelleTentative: boolean): void {
    const t = this.maintenant();
    this.c.requetesEnvoyees++;
    if (nouvelleTentative) this.c.nouvellesTentatives++;
    if (this.premiere === null) this.premiere = t;
    this.derniere = t;
    this.fenetre.push(t);
  }

  reponse(statut: number, octets: number): void {
    this.c.octetsRecus += octets;
    if (statut >= 200 && statut < 300) this.c.reponses2xx++;
    else if (statut === 429) this.c.reponses429++;
    else if (statut >= 500) this.c.reponses5xx++;
    else this.c.autresStatuts++;
  }

  echecReseau(delai: boolean): void {
    if (delai) this.c.delaisDepasses++;
    else this.c.echecsReseau++;
  }

  instantane(): CompteursRequetes {
    const t = this.maintenant();
    this.fenetre = this.fenetre.filter((x) => t - x < 60_000);
    return {
      ...this.c,
      derniereMinute: this.fenetre.length,
      premiereRequeteLe: this.premiere === null ? null : new Date(this.premiere).toISOString(),
      derniereRequeteLe: this.derniere === null ? null : new Date(this.derniere).toISOString(),
    };
  }
}

/** Date a laquelle les pages ci-dessous ont ete lues (copie texte conservee par l'agent « sources reelles »). */
const CONSULTE_LE = "2026-10-25";
const PAGE_QUOTAS_CDSE = "https://documentation.dataspace.copernicus.eu/Quotas.html";

/**
 * Limites du CDSE pour un compte « Copernicus General user » (tableau « Quotas and Limitations »).
 * Rien ici n'est mesure : ce sont les chiffres de la page, citee. Seules les deux premieres lignes
 * concernent la RECHERCHE de catalogue ; les autres sont gardees pour le Lot suivant (telechargement,
 * traitement) afin que personne ne les redecouvre.
 */
export const LIMITES_CDSE: LimiteConnue[] = [
  {
    cle: "stac_requetes_par_minute", libelle: "Requetes par minute, catalogue STAC", valeur: null, unite: "requetes/minute",
    concerneRecherche: true, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Le tableau ne chiffre aucune limite de requetes pour STAC (colonne « S3, OData, STAC », cellule « - »). Absence de chiffre publie, pas absence de limite : un 429 reste possible et est traite (Retry-After, backoff).",
  },
  {
    cle: "s3_requetes_par_minute", libelle: "Requetes par minute, S3", valeur: 2000, unite: "requetes/minute",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Le chiffre de la colonne « S3, OData, STAC » ne vaut que pour S3 (note 14 de la page).",
  },
  {
    cle: "transfert_mensuel_tb", libelle: "Volume telecharge par fenetre glissante de 30 jours (donnees immediatement disponibles)", valeur: 12, unite: "To",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Au-dela : debit ramene a 1 Mo/s et 1 connexion (note 10 de la page).",
  },
  {
    cle: "debit_par_connexion", libelle: "Debit maximal par connexion de telechargement", valeur: 20, unite: "Mo/s",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE }, note: null,
  },
  {
    cle: "connexions_simultanees", libelle: "Connexions de telechargement simultanees", valeur: 4, unite: "connexions",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE }, note: null,
  },
  {
    cle: "jeton_validite_minutes", libelle: "Duree de validite d'un jeton d'acces", valeur: 10, unite: "minutes",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Renouvelable par jeton de rafraichissement dans les 60 minutes suivant sa generation.",
  },
  {
    cle: "sessions_actives", libelle: "Sessions actives par compte", valeur: 100, unite: "sessions",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Un jeton genere ouvre une session (note 3 de la page) : ne pas en generer un par requete.",
  },
  {
    cle: "sentinelhub_requetes_par_mois", libelle: "Sentinel Hub : requetes par mois", valeur: 10_000, unite: "requetes/mois",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE },
    note: "Traitement a la demande (Lot suivant). Remise a zero le premier jour du mois.",
  },
  {
    cle: "sentinelhub_requetes_par_minute", libelle: "Sentinel Hub : requetes par minute", valeur: 300, unite: "requetes/minute",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE }, note: null,
  },
  {
    cle: "sentinelhub_unites_traitement_par_mois", libelle: "Sentinel Hub : unites de traitement (PU) par mois", valeur: 10_000, unite: "PU/mois",
    concerneRecherche: false, source: { url: PAGE_QUOTAS_CDSE, consulteLe: CONSULTE_LE }, note: null,
  },
];

/**
 * Earth Search (Element 84) : aucune limite chiffree n'a ete relevee dans la documentation
 * consultee ni dans les en-tetes des reponses (aucun en-tete de debit). On le dit au lieu de
 * l'inventer ; la politesse (User-Agent identifiable, backoff, plafonds de pages) reste de mise.
 */
export const LIMITES_EARTH_SEARCH: LimiteConnue[] = [
  {
    cle: "recherche_requetes", libelle: "Limite de requetes de l'API de recherche", valeur: null, unite: null,
    concerneRecherche: true, source: { url: "https://earth-search.aws.element84.com/v1", consulteLe: CONSULTE_LE },
    note: "Aucune limite publiee relevee ; aucun en-tete de debit dans les reponses du 25/10/2026.",
  },
];
