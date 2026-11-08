/**
 * Base commune des adaptateurs STAC (CDSE, Earth Search). Ce qui est identique ne s'ecrit qu'une fois :
 * recherche, metadonnees, sonde de connectivite, apercu, quotas, et le refus explicite des operations
 * de traitement. Chaque adaptateur ne fournit que ce qui le distingue : sa configuration, son
 * descriptif et ses limites.
 */
import { ClientHttp, type OptionsClientHttp } from "../http";
import {
  classerErreur, erreurNonSupporte,
  type CategorieErreur, type CodeSource, type DescriptifSource, type DescriptionAcces, type InstantaneQuotas,
  type LimiteConnue, type OptionsConnectivite, type OptionsMetadonnees, type ParamsRecherche, type ProduitNormalise,
  type ResultatConnectivite, type ResultatRecherche, type SourceAdaptateur,
} from "../contrat";
import { chargerProduit, rechercherStac, sonderStac, type ConfigStac } from "../stac";

/** Options d'un adaptateur : celles du client HTTP, plus l'adresse du service (pour un miroir ou un essai). */
export type OptionsAdaptateurStac = Omit<OptionsClientHttp, "source"> & { urlBase?: string };

export function urlBaseValide(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`adresse de service illisible : ${url}`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) {
    throw new Error("l'adresse du service doit etre en https (http n'est admis que sur la machine locale, pour les essais)");
  }
  return url.replace(/\/+$/, "");
}

export abstract class AdaptateurStac implements SourceAdaptateur {
  protected readonly client: ClientHttp;
  protected readonly maintenant: () => number;

  constructor(
    readonly code: CodeSource,
    readonly descriptif: DescriptifSource,
    protected readonly cfg: ConfigStac,
    private readonly limites: LimiteConnue[],
    options: Omit<OptionsClientHttp, "source">,
  ) {
    this.maintenant = options.maintenant ?? (() => Date.now());
    this.client = new ClientHttp({ ...options, source: code, maintenant: this.maintenant });
  }

  rechercher(params: ParamsRecherche): Promise<ResultatRecherche> {
    return rechercherStac(this.cfg, this.client, params);
  }

  metadonnees(identifiant: string, options?: OptionsMetadonnees): Promise<ProduitNormalise | null> {
    return chargerProduit(this.cfg, this.client, identifiant, options?.collection);
  }

  verifierConnectivite(options: OptionsConnectivite = {}): Promise<ResultatConnectivite> {
    return sonderStac(this.cfg, this.client, options, this.maintenant);
  }

  urlApercu(produit: ProduitNormalise): DescriptionAcces {
    const v = produit.liens.vignette;
    const note = "A lire et servir COTE SERVEUR : ne jamais renvoyer cette adresse au navigateur avec un jeton ou une cle.";
    const base = { executionCote: "SERVEUR", typeContenu: v?.type ?? null, note } as const;
    if (!v) {
      return { ...base, disponible: false, verifie: false, raison: "VIGNETTE_ABSENTE : le fournisseur n'annonce aucune vignette pour ce produit", methode: null, url: null, authentification: "INCONNU" };
    }
    if (v.acces === "ANONYME") {
      return { ...base, disponible: true, verifie: true, raison: null, methode: "GET", url: v.href, authentification: "ANONYME" };
    }
    if (v.acces === "INCONNU") {
      return { ...base, disponible: true, verifie: false, raison: "ACCES_NON_VERIFIE : a tenter cote serveur ; en cas d'echec, repondre APERCU_INDISPONIBLE", methode: "GET", url: v.href, authentification: "INCONNU" };
    }
    return {
      ...base, disponible: false, verifie: true, methode: null, url: null, authentification: v.acces,
      raison: v.acces === "JETON_OIDC" ? "IDENTIFIANTS_REQUIS : la vignette exige un jeton que ce lot ne detient pas"
        : "ACCES_NON_HTTP : la vignette est un objet s3:// qui exige des identifiants du cloud concerne",
    };
  }

  declencherTraitement(_demande?: unknown): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "declencherTraitement")); }
  statutTraitement(_identifiant?: string): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "statutTraitement")); }
  recupererResultat(_identifiant?: string): Promise<never> { return Promise.reject(erreurNonSupporte(this.code, "recupererResultat")); }

  classerErreur(e: unknown): CategorieErreur { return classerErreur(e); }

  quotas(): InstantaneQuotas {
    return { source: this.code, compteurs: this.client.compteur.instantane(), limites: this.limites };
  }
}
