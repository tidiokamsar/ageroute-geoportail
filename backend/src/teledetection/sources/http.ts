/**
 * CLIENT HTTP DES CATALOGUES. Un seul endroit ou une requete part, donc un seul endroit ou l'on
 * borne, compte et journalise.
 *
 * GARDE-FOUS, TENUS ICI ET TESTES
 *   - `fetch`, l'horloge, le sommeil et le hasard sont INJECTABLES : les tests tournent hors ligne et
 *     sans attendre ;
 *   - delai maximal par tentative, corps de reponse compris (AbortController) ;
 *   - nouvelles tentatives BORNEES (defaut : 4 envois en tout) sur 408, 429, 5xx et panne reseau,
 *     avec backoff exponentiel et gigue. Une recherche de catalogue est une lecture : la rejouer est
 *     sans effet de bord ;
 *   - `Retry-After` (secondes ou date HTTP) est respecte ; s'il depasse le plafond d'attente, on ne
 *     dort pas : l'erreur QUOTA rend la duree demandee a l'appelant, qui decide ;
 *   - les redirections ne sont jamais suivies hors de l'origine d'origine (un jeton ne doit pas
 *     partir vers un autre hote) ;
 *   - le corps de reponse est lu jusqu'a un plafond d'octets ;
 *   - AUCUN secret n'est ecrit : ni dans le journal, ni dans un message d'erreur, ni dans le
 *     diagnostic. Les URL sont masquees (userinfo, parametres de signature) et chaque valeur de
 *     `secrets` est remplacee par [SECRET] dans tout texte sortant ;
 *   - chaque envoi HTTP, nouvelle tentative comprise, est compte (quotas.ts) ;
 *   - le User-Agent s'identifie : « AGEROUTE-BDRI/<version> ».
 */
import { CompteurRequetes } from "./quotas";
import { ErreurSource, type CodeSource } from "./contrat";

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal;
}) => Promise<Response>;

export interface EvenementJournal {
  type: "ENVOI" | "REPONSE" | "NOUVELLE_TENTATIVE" | "ECHEC" | "REDIRECTION";
  methode: string;
  /** URL masquee : jamais d'identifiant ni de valeur de signature. */
  url: string;
  tentative: number;
  statut?: number;
  latenceMs?: number;
  attenteMs?: number;
  message?: string;
}

export interface OptionsClientHttp {
  source: CodeSource;
  fetch?: FetchLike;
  /** Version annoncee dans le User-Agent. Defaut : variable AGEROUTE_VERSION, sinon npm_package_version, sinon « inconnue ». */
  version?: string;
  userAgent?: string;
  delaiMaxMs?: number;
  /** Nombre total d'envois par appel, premier compris. */
  tentativesMax?: number;
  baseBackoffMs?: number;
  plafondBackoffMs?: number;
  /** Au-dela, un Retry-After n'est pas attendu : l'erreur est rendue avec la duree demandee. */
  plafondAttenteMs?: number;
  octetsMax?: number;
  sleep?: (ms: number) => Promise<void>;
  maintenant?: () => number;
  /** Nombre dans [0, 1[ ; defaut Math.random. */
  alea?: () => number;
  journal?: (e: EvenementJournal) => void;
  /** Valeurs a ne jamais laisser sortir (jetons, cles). Aucune n'est requise pour une recherche anonyme. */
  secrets?: readonly string[];
  /** En-tetes en plus (ex. Authorization). Le Lot suivant les alimentera ; la recherche anonyme n'en a pas. */
  entetes?: Record<string, string>;
  compteur?: CompteurRequetes;
}

export interface SpecRequete {
  methode: "GET" | "POST";
  url: string;
  corps?: unknown;
}

export interface ReponseJson {
  statut: number;
  json: unknown;
  latenceMs: number;
  tentatives: number;
  octets: number;
}

export const DEFAUTS_HTTP = {
  delaiMaxMs: 30_000,
  tentativesMax: 4,
  baseBackoffMs: 500,
  plafondBackoffMs: 20_000,
  plafondAttenteMs: 60_000,
  octetsMax: 32 * 1024 * 1024,
  redirectionsMax: 2,
} as const;

const PARAMETRES_SENSIBLES = /^(sig|signature|token|access_token|id_token|refresh_token|key|apikey|api_key|api-key|secret|client_secret|password|passwd|x-amz-signature|x-amz-credential|x-amz-security-token|se|sp|sv|sr|st|skoid|sktid)$/i;

/** Masque userinfo et valeurs des parametres de signature ; garde le reste pour que le journal reste lisible. */
export function masquerUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    for (const k of [...u.searchParams.keys()]) if (PARAMETRES_SENSIBLES.test(k)) u.searchParams.set(k, "MASQUE");
    return u.toString();
  } catch {
    return "[URL illisible]";
  }
}

/** Pour un lien conserve en base ou rendu a un client : ni userinfo, ni requete, ni fragment. */
export function nettoyerLien(href: string): string {
  if (/^s3:\/\//i.test(href)) return href.split(/[?#]/)[0];
  try {
    const u = new URL(href);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Remplace les secrets connus et les formes usuelles (Bearer, access_token=...) puis borne la longueur. */
export function assainirTexte(texte: string, secrets: readonly string[] = [], max = 300): string {
  let s = texte;
  for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join("[SECRET]");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [SECRET]");
  s = s.replace(/\b(access_token|id_token|refresh_token|client_secret|password|apikey|api_key|token|sig)=([^&\s"']{4,})/gi, "$1=[SECRET]");
  s = s.replace(/"(access_token|id_token|refresh_token|client_secret|password|token)"\s*:\s*"[^"]*"/gi, '"$1":"[SECRET]"');
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/** Retry-After : secondes entieres ou date HTTP. Null si absent ou illisible. */
export function lireRetryAfter(valeur: string | null, maintenant: number): number | null {
  if (valeur === null) return null;
  const v = valeur.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - maintenant);
}

const defautSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function versionApplication(): string {
  return process.env.AGEROUTE_VERSION || process.env.npm_package_version || "inconnue";
}

function categorieDeStatut(statut: number): { code: ErreurSource["code"]; categorie: ErreurSource["categorie"] } {
  if (statut === 429) return { code: "HTTP_QUOTA", categorie: "QUOTA" };
  if (statut === 401 || statut === 403) return { code: "HTTP_AUTH", categorie: "AUTH" };
  if (statut === 408) return { code: "RESEAU", categorie: "RESEAU" };
  if (statut >= 500) return { code: "HTTP_INDISPONIBLE", categorie: "INDISPONIBLE" };
  if (statut >= 400) return { code: "HTTP_ENTREE", categorie: "ENTREE" };
  return { code: "INCONNUE", categorie: "INCONNUE" };
}

const REESSAYABLES = (s: number) => s === 408 || s === 429 || s >= 500;

export class ClientHttp {
  readonly compteur: CompteurRequetes;
  readonly userAgent: string;
  private readonly o: Required<Pick<OptionsClientHttp, "delaiMaxMs" | "tentativesMax" | "baseBackoffMs" | "plafondBackoffMs" | "plafondAttenteMs" | "octetsMax">>;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maintenant: () => number;
  private readonly alea: () => number;
  private readonly journal: (e: EvenementJournal) => void;
  private readonly secrets: readonly string[];
  private readonly entetes: Record<string, string>;
  private readonly source: CodeSource;

  constructor(opts: OptionsClientHttp) {
    this.source = opts.source;
    this.maintenant = opts.maintenant ?? (() => Date.now());
    this.compteur = opts.compteur ?? new CompteurRequetes(this.maintenant);
    this.userAgent = opts.userAgent ?? `AGEROUTE-BDRI/${opts.version ?? versionApplication()}`;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? defautSleep;
    this.alea = opts.alea ?? Math.random;
    this.journal = opts.journal ?? (() => undefined);
    this.secrets = opts.secrets ?? [];
    this.entetes = opts.entetes ?? {};
    this.o = {
      delaiMaxMs: opts.delaiMaxMs ?? DEFAUTS_HTTP.delaiMaxMs,
      tentativesMax: Math.max(1, opts.tentativesMax ?? DEFAUTS_HTTP.tentativesMax),
      baseBackoffMs: opts.baseBackoffMs ?? DEFAUTS_HTTP.baseBackoffMs,
      plafondBackoffMs: opts.plafondBackoffMs ?? DEFAUTS_HTTP.plafondBackoffMs,
      plafondAttenteMs: opts.plafondAttenteMs ?? DEFAUTS_HTTP.plafondAttenteMs,
      octetsMax: opts.octetsMax ?? DEFAUTS_HTTP.octetsMax,
    };
  }

  /** Description de la requete pour un diagnostic : URL masquee, corps assaini et borne. */
  decrire(spec: SpecRequete): string {
    const corps = spec.corps === undefined ? "" : ` ${assainirTexte(JSON.stringify(spec.corps), this.secrets, 700)}`;
    return `${spec.methode} ${assainirTexte(masquerUrl(spec.url), this.secrets, 400)}${corps}`;
  }

  private ecrire(e: EvenementJournal): void {
    try {
      this.journal({ ...e, url: assainirTexte(e.url, this.secrets, 400), message: e.message === undefined ? undefined : assainirTexte(e.message, this.secrets) });
    } catch {
      // un journal defaillant ne doit pas faire echouer une requete
    }
  }

  private backoff(tentative: number): number {
    const brut = Math.min(this.o.plafondBackoffMs, this.o.baseBackoffMs * 2 ** (tentative - 1));
    // gigue « equilibree » : au moins la moitie du delai, jusqu'au delai plein
    return Math.round(brut * (0.5 + 0.5 * this.alea()));
  }

  private erreur(init: ConstructorParameters<typeof ErreurSource>[0]): ErreurSource {
    return new ErreurSource({ ...init, message: assainirTexte(init.message, this.secrets, 500), source: this.source });
  }

  private async lireCorps(res: Response, signal: AbortSignal): Promise<{ texte: string; octets: number } | "TROP_GROS"> {
    if (!res.body) return { texte: "", octets: 0 };
    const lecteur = res.body.getReader();
    const morceaux: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) { void lecteur.cancel().catch(() => undefined); throw Object.assign(new Error("delai depasse"), { name: "TimeoutError" }); }
      const { done, value } = await lecteur.read();
      if (done) break;
      total += value.byteLength;
      // pas d'attente de l'annulation : on ne bloque pas sur un flux que l'on abandonne
      if (total > this.o.octetsMax) { void lecteur.cancel().catch(() => undefined); return "TROP_GROS"; }
      morceaux.push(value);
    }
    return { texte: Buffer.concat(morceaux).toString("utf8"), octets: total };
  }

  /** Envoie la requete et rend le JSON de la reponse. Leve ErreurSource, jamais autre chose. */
  async json(spec: SpecRequete): Promise<ReponseJson> {
    this.compteur.appelLogique();
    const debut = this.maintenant();
    const origine = (() => { try { return new URL(spec.url).origin; } catch { return null; } })();
    if (origine === null) throw this.erreur({ code: "ENTREE_INVALIDE", categorie: "ENTREE", message: "URL de requete illisible" });

    let url = spec.url;
    let methode: "GET" | "POST" = spec.methode;
    let corps = spec.corps;
    let redirections = 0;
    let derniereErreur: ErreurSource | null = null;

    for (let tentative = 1; tentative <= this.o.tentativesMax; tentative++) {
      const descr = this.decrire({ methode, url, corps });
      const controleur = new AbortController();
      const minuteur = setTimeout(() => controleur.abort(), this.o.delaiMaxMs);
      this.compteur.envoi(tentative > 1);
      this.ecrire({ type: "ENVOI", methode, url: masquerUrl(url), tentative });
      const t0 = this.maintenant();
      let statut: number;
      let texte = "";
      let octets = 0;
      let location: string | null = null;
      let retryAfter: number | null = null;
      try {
        const res = await this.fetchImpl(url, {
          method: methode,
          headers: {
            "User-Agent": this.userAgent,
            Accept: "application/geo+json, application/json",
            ...(methode === "POST" ? { "Content-Type": "application/json" } : {}),
            ...this.entetes,
          },
          body: methode === "POST" && corps !== undefined ? JSON.stringify(corps) : undefined,
          redirect: "manual",
          signal: controleur.signal,
        });
        statut = res.status;
        location = res.headers.get("location");
        retryAfter = lireRetryAfter(res.headers.get("retry-after"), this.maintenant());
        const lu = await this.lireCorps(res, controleur.signal);
        if (lu === "TROP_GROS") {
          this.compteur.reponse(statut, 0);
          throw this.erreur({ code: "REPONSE_TROP_GROSSE", categorie: "INDISPONIBLE", message: `reponse de plus de ${this.o.octetsMax} octets`, statutHttp: statut, tentatives: tentative, requete: descr });
        }
        texte = lu.texte;
        octets = lu.octets;
      } catch (err) {
        clearTimeout(minuteur);
        if (err instanceof ErreurSource) { this.ecrire({ type: "ECHEC", methode, url: masquerUrl(url), tentative, message: err.message }); throw err; }
        const delai = controleur.signal.aborted || (err as { name?: string })?.name === "AbortError" || (err as { name?: string })?.name === "TimeoutError";
        this.compteur.echecReseau(delai);
        derniereErreur = this.erreur({
          code: delai ? "DELAI_DEPASSE" : "RESEAU", categorie: "RESEAU", tentatives: tentative, requete: descr, cause: err,
          message: delai ? `delai de ${this.o.delaiMaxMs} ms depasse` : `echec reseau (${(err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.message ?? "inconnu"})`,
        });
        this.ecrire({ type: "ECHEC", methode, url: masquerUrl(url), tentative, message: derniereErreur.message, latenceMs: this.maintenant() - t0 });
        if (tentative < this.o.tentativesMax) {
          const attente = this.backoff(tentative);
          this.ecrire({ type: "NOUVELLE_TENTATIVE", methode, url: masquerUrl(url), tentative, attenteMs: attente, message: derniereErreur.message });
          await this.sleep(attente);
          continue;
        }
        throw derniereErreur;
      }
      clearTimeout(minuteur);
      this.compteur.reponse(statut, octets);
      const latence = this.maintenant() - t0;
      this.ecrire({ type: "REPONSE", methode, url: masquerUrl(url), tentative, statut, latenceMs: latence });

      if (statut >= 200 && statut < 300) {
        try {
          return { statut, json: JSON.parse(texte), latenceMs: this.maintenant() - debut, tentatives: tentative, octets };
        } catch {
          throw this.erreur({ code: "REPONSE_ILLISIBLE", categorie: "INDISPONIBLE", message: "la reponse n'est pas du JSON", statutHttp: statut, tentatives: tentative, requete: descr });
        }
      }

      if (statut >= 300 && statut < 400) {
        let cible: string | null = null;
        try { cible = location ? new URL(location, url).toString() : null; } catch { cible = null; }
        const memeOrigine = cible !== null && new URL(cible).origin === origine;
        const methodePreservee = methode === "GET" || statut === 307 || statut === 308;
        if (!memeOrigine || !methodePreservee || redirections >= DEFAUTS_HTTP.redirectionsMax) {
          throw this.erreur({ code: "REDIRECTION_REFUSEE", categorie: "INDISPONIBLE", message: `redirection ${statut} refusee (hors origine, methode non preservee ou trop de sauts)`, statutHttp: statut, tentatives: tentative, requete: descr });
        }
        redirections++;
        this.ecrire({ type: "REDIRECTION", methode, url: masquerUrl(url), tentative, statut, message: `vers ${masquerUrl(cible as string)}` });
        url = cible as string;
        tentative--; // un saut n'est pas une nouvelle tentative
        continue;
      }

      const { code, categorie } = categorieDeStatut(statut);
      derniereErreur = this.erreur({
        code, categorie, statutHttp: statut, tentatives: tentative, requete: descr, retryApresMs: retryAfter,
        message: `HTTP ${statut}${texte ? ` : ${assainirTexte(texte, this.secrets, 160)}` : ""}`,
      });
      if (!REESSAYABLES(statut) || tentative >= this.o.tentativesMax) throw derniereErreur;

      const demande = retryAfter ?? 0;
      if (demande > this.o.plafondAttenteMs) {
        // le fournisseur demande une attente plus longue que ce que nous acceptons de bloquer : on rend la main
        throw derniereErreur;
      }
      const attente = Math.max(this.backoff(tentative), demande);
      this.ecrire({ type: "NOUVELLE_TENTATIVE", methode, url: masquerUrl(url), tentative, statut, attenteMs: attente });
      await this.sleep(attente);
    }
    throw derniereErreur ?? this.erreur({ code: "INCONNUE", categorie: "INCONNUE", message: "echec sans cause" });
  }
}
