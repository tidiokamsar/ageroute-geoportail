/**
 * Facades PlanetScope et SPOT : l'INTERFACE est prevue, rien n'est branche. Ces adaptateurs ne
 * contactent aucun service, ne creent aucun abonnement, ne passent aucune commande : une image
 * commerciale se paie, et toute commande exige une autorisation humaine (palier payant : le noyau
 * teledetection.noyau.ts refuse un produit payant sans reference d'autorisation de depense).
 *
 * Aucune resolution, aucune licence ni aucun tarif n'est affirme ici : ce chantier n'a consulte aucune
 * documentation de ces fournisseurs, donc il n'en ecrit rien (descriptif vide plutot qu'approximatif).
 */
import {
  classerErreur, ErreurSource, erreurNonSupporte,
  type CategorieErreur, type CodeSource, type DescriptifSource, type DescriptionAcces, type InstantaneQuotas,
  type OptionsConnectivite, type ParamsRecherche, type ProduitNormalise, type ResultatConnectivite, type ResultatRecherche, type SourceAdaptateur,
} from "../contrat";

export const MESSAGE_FACADE = "interface prevue, aucune commande sans autorisation humaine";

class AdaptateurFacade implements SourceAdaptateur {
  constructor(
    readonly code: CodeSource,
    readonly descriptif: DescriptifSource,
    private readonly maintenant: () => number = () => Date.now(),
  ) {}

  private refus(operation: string): Promise<never> {
    return Promise.reject(new ErreurSource({
      code: "NON_SUPPORTE", categorie: "NON_SUPPORTE", source: this.code,
      message: `${operation} : ${MESSAGE_FACADE}`,
    }));
  }

  rechercher(_params: ParamsRecherche): Promise<ResultatRecherche> { return this.refus("rechercher"); }
  metadonnees(_identifiant: string): Promise<ProduitNormalise | null> { return this.refus("metadonnees"); }

  urlApercu(_produit: ProduitNormalise): DescriptionAcces {
    return {
      executionCote: "SERVEUR", disponible: false, verifie: false, methode: null, url: null, authentification: "INCONNU",
      typeContenu: null, raison: `INTERFACE_NON_CONFIGUREE : ${MESSAGE_FACADE}`,
      note: "Aucun apercu : cette source n'est pas branchee.",
    };
  }

  /** Ne contacte rien : l'etat est EN_ATTENTE_CONFIGURATION, quoi qu'il arrive. */
  verifierConnectivite(_options?: OptionsConnectivite): Promise<ResultatConnectivite> {
    return Promise.resolve({
      etatAtteint: "EN_ATTENTE_CONFIGURATION", message: MESSAGE_FACADE, latenceMs: 0, requete: null,
      produitsTrouves: null, categorieErreur: null, verifieLe: new Date(this.maintenant()).toISOString(),
    });
  }

  declencherTraitement(_demande?: unknown): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "declencherTraitement")); }
  statutTraitement(_identifiant?: string): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "statutTraitement")); }
  recupererResultat(_identifiant?: string): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "recupererResultat")); }

  classerErreur(e: unknown): CategorieErreur { return classerErreur(e); }

  quotas(): InstantaneQuotas {
    return {
      source: this.code, limites: [],
      compteurs: {
        requetesEnvoyees: 0, appelsLogiques: 0, nouvellesTentatives: 0, reponses2xx: 0, reponses429: 0, reponses5xx: 0,
        autresStatuts: 0, echecsReseau: 0, delaisDepasses: 0, octetsRecus: 0, derniereMinute: 0,
        premiereRequeteLe: null, derniereRequeteLe: null,
      },
    };
  }
}

const SANS_ACCES = {
  recherche: "NON_DISPONIBLE", telechargement: "NON_DISPONIBLE", traitement: "NON_DISPONIBLE", variablesEnvironnement: [],
} as const;

export const DESCRIPTIF_PLANETSCOPE: DescriptifSource = {
  code: "planetscope", nom: "PlanetScope (facade)", fournisseur: "Planet Labs", interface: "FACADE", urlService: null,
  capteurs: ["PlanetScope"], collections: [], resolutionsNatives: {},
  licence: { libelle: "Commerciale : a obtenir et a lire aupres du fournisseur avant tout usage (non documentee ici)", url: null, attribution: "A relever aupres du fournisseur" },
  exigencesAcces: { ...SANS_ACCES, variablesEnvironnement: [] },
};

export const DESCRIPTIF_SPOT: DescriptifSource = {
  code: "spot", nom: "SPOT (facade)", fournisseur: "Airbus Defence and Space", interface: "FACADE", urlService: null,
  capteurs: ["SPOT"], collections: [], resolutionsNatives: {},
  licence: { libelle: "Commerciale : a obtenir et a lire aupres du fournisseur avant tout usage (non documentee ici)", url: null, attribution: "A relever aupres du fournisseur" },
  exigencesAcces: { ...SANS_ACCES, variablesEnvironnement: [] },
};

export function creerFacadePlanetScope(maintenant?: () => number): SourceAdaptateur {
  return new AdaptateurFacade("planetscope", DESCRIPTIF_PLANETSCOPE, maintenant);
}

export function creerFacadeSpot(maintenant?: () => number): SourceAdaptateur {
  return new AdaptateurFacade("spot", DESCRIPTIF_SPOT, maintenant);
}
