/**
 * Effacement des donnees locales du COMPTE COURANT (conception : docs/securite/SESSION-HORS-LIGNE.md, section 6).
 *
 * Geste DISTINCT de la deconnexion (qui ne supprime jamais rien) : l'agent efface volontairement ce que son compte a laisse
 * sur ce telephone (bases IndexedDB chiffrees, cles localStorage du compte, coffre, indice de dernier compte).
 *
 * REGLES
 *   1. AUCUN parametre de compte : la fonction vise `compteCourant()` et rien d'autre. Un autre compte du telephone n'est
 *      atteignable par aucune API (ses bases portent un autre nom, ses cles un autre prefixe, son coffre une autre cle).
 *      Les noms supprimes sont TOUS derives de l'empreinte du compte courant (`nomBaseOffline`, `nomBaseRoulage`,
 *      `prefixeLocalStorage`) ; rien n'est supprime « par motif ».
 *   2. REFUS (retour type, aucune exception) tant que `decisionSuppressionLocale(decompte)` dit non : saisie en attente,
 *      en erreur, abandonnee, en conflit, photo en file, releve non confirme, decompte illisible. Dans le doute, on garde.
 *   3. Ordre : decompte -> controle que le compte n'a pas change -> fermeture du compte (plus aucune ecriture) -> bases ->
 *      cles -> coffre -> indice -> journal. En cas d'echec en cours de route, le compte est rouvert et le resultat le dit.
 *   4. LE JOURNAL DES EVENEMENTS LOCAUX SURVIT (`evenementsLocaux`) : il ne contient aucun contenu de saisie, et c'est lui
 *      qui porte EFFACEMENT_LOCAL vers le serveur a la prochaine connexion du meme compte. Sans cela, l'effacement serait
 *      le seul evenement que la conception veut tracer et que cette fonction detruirait. Les evenements en attente
 *      d'un AUTRE compte ne sont pas touches.
 *
 * L'indice de dernier compte (`bdri.indiceComptes`, hors prefixe : il doit etre lisible avant de savoir quel compte ouvrir)
 * vit aussi ici, car son seul autre usage est d'etre efface a la deconnexion, a la fermeture et a l'effacement.
 */
import { cleAppartientAuCompte, nomBaseOffline, nomBaseRoulage, prefixeLocalStorage } from "../session/compteLocal";
import { creerJournal, NOM_CLE_JOURNAL, type StockageTexte } from "../session/journalEvenementsLocaux";
import type { ComptesFile, DecisionSuppression } from "../session/politiqueDeconnexion";
import { decisionSuppressionLocale } from "../session/politiqueDeconnexion";
import { compteCourant, fermerCompte, ouvrirCompte, type ContexteCompte } from "./compteCourant";

// ---------------------------------------------------------------------------------------------------
// Indice du dernier compte
// ---------------------------------------------------------------------------------------------------

export const CLE_INDICE_COMPTES = "bdri.indiceComptes";

export interface EntreeIndice {
  /** Nom d'affichage : sert a l'ecran de deverrouillage avant que le coffre soit ouvert. */
  readonly nom: string;
  /** Deconnexion faite hors ligne, a rejouer au retour du reseau (le noyau ne persiste rien). */
  readonly deconnexionEnAttente?: boolean;
  /** La deconnexion en attente etait « tous les appareils ». */
  readonly tous?: boolean;
}

export interface IndiceComptes {
  readonly dernier: string | null;
  readonly comptes: Readonly<Record<string, EntreeIndice>>;
}

type StockageIndice = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function stockageNavigateur(): StockageIndice | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function lireIndice(stockage: StockageIndice | null = stockageNavigateur()): IndiceComptes {
  const vide: IndiceComptes = { dernier: null, comptes: {} };
  if (stockage === null) return vide;
  try {
    const brut = stockage.getItem(CLE_INDICE_COMPTES);
    if (!brut) return vide;
    const o = JSON.parse(brut) as { dernier?: unknown; comptes?: unknown };
    const comptes: Record<string, EntreeIndice> = {};
    if (typeof o.comptes === "object" && o.comptes !== null) {
      for (const [id, v] of Object.entries(o.comptes as Record<string, unknown>)) {
        if (typeof v !== "object" || v === null || typeof (v as { nom?: unknown }).nom !== "string") continue;
        const e = v as { nom: string; deconnexionEnAttente?: unknown; tous?: unknown };
        comptes[id] = {
          nom: e.nom,
          ...(e.deconnexionEnAttente === true ? { deconnexionEnAttente: true as const } : {}),
          ...(e.tous === true ? { tous: true as const } : {}),
        };
      }
    }
    const dernier = typeof o.dernier === "string" && o.dernier in comptes ? o.dernier : null;
    return { dernier, comptes };
  } catch {
    return vide;
  }
}

function ecrireIndice(indice: IndiceComptes, stockage: StockageIndice | null): void {
  if (stockage === null) return;
  try {
    if (Object.keys(indice.comptes).length === 0) stockage.removeItem(CLE_INDICE_COMPTES);
    else stockage.setItem(CLE_INDICE_COMPTES, JSON.stringify(indice));
  } catch { /* information seulement */ }
}

/** Note un compte connu de l'appareil et le designe comme le dernier utilise. */
export function noterCompteDansIndice(
  compteId: string,
  nom: string,
  options: { deconnexionEnAttente?: boolean; tous?: boolean } = {},
  stockage: StockageIndice | null = stockageNavigateur(),
): void {
  const indice = lireIndice(stockage);
  const entree: EntreeIndice = {
    nom,
    ...(options.deconnexionEnAttente === true ? { deconnexionEnAttente: true as const } : {}),
    ...(options.deconnexionEnAttente === true && options.tous === true ? { tous: true as const } : {}),
  };
  ecrireIndice({ dernier: compteId, comptes: { ...indice.comptes, [compteId]: entree } }, stockage);
}

/** Retire UN compte de l'indice (deconnexion, fermeture, effacement). Les autres comptes restent. */
export function retirerCompteDeIndice(compteId: string, stockage: StockageIndice | null = stockageNavigateur()): void {
  const indice = lireIndice(stockage);
  if (!(compteId in indice.comptes)) return;
  const { [compteId]: _retire, ...reste } = indice.comptes;
  ecrireIndice({ dernier: indice.dernier === compteId ? null : indice.dernier, comptes: reste }, stockage);
}

// ---------------------------------------------------------------------------------------------------
// Suppression du stockage d'un compte
// ---------------------------------------------------------------------------------------------------

export interface PortSuppression {
  readonly indexedDb?: Pick<IDBFactory, "deleteDatabase">;
  readonly stockage?: (StockageTexte & Pick<Storage, "length" | "key">) | null;
  /** Attente maximale d'une base qu'une connexion ouverte empeche de supprimer. */
  readonly delaiBloqueMs?: number;
}

export interface BilanSuppression {
  readonly bases: readonly string[];
  readonly cles: number;
}

function supprimerBase(idb: Pick<IDBFactory, "deleteDatabase">, nom: string, delaiBloqueMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let minuteur: ReturnType<typeof setTimeout> | null = null;
    let req: IDBOpenDBRequest;
    try { req = idb.deleteDatabase(nom); } catch (e) { reject(e instanceof Error ? e : new Error("deleteDatabase")); return; }
    req.onsuccess = () => { if (minuteur) clearTimeout(minuteur); resolve(); };
    req.onerror = () => { if (minuteur) clearTimeout(minuteur); reject(req.error ?? new Error("deleteDatabase")); };
    // Une connexion ouverte (autre onglet) bloque la suppression : on attend qu'elle se ferme, puis on abandonne.
    req.onblocked = () => {
      minuteur ??= setTimeout(() => reject(new Error("BASE_BLOQUEE")), delaiBloqueMs);
    };
  });
}

/**
 * Supprime les bases IndexedDB et les cles localStorage du compte d'EMPREINTE donnee, SAUF son journal d'evenements.
 * Reservee aux gestes confirmes de l'agent sur son propre compte (effacement, reinitialisation du PIN) : l'appelant
 * garantit que `empreinte` est celle du compte courant. Exportee pour la reinitialisation du PIN, qui laisse sinon des
 * saisies indechiffrables que plus rien ne peut lire.
 */
export async function supprimerStockageDuCompte(empreinte: string, port: PortSuppression = {}): Promise<BilanSuppression> {
  const idb = port.indexedDb ?? (typeof indexedDB === "undefined" ? null : indexedDB);
  const delai = port.delaiBloqueMs ?? 5000;
  const bases: string[] = [];
  if (idb !== null) {
    for (const nom of [nomBaseOffline(empreinte), nomBaseRoulage(empreinte)]) {
      await supprimerBase(idb, nom, delai);
      bases.push(nom);
    }
  }
  const s = port.stockage === undefined ? (stockageNavigateur() as (StockageTexte & Pick<Storage, "length" | "key">) | null) : port.stockage;
  let cles = 0;
  if (s !== null) {
    const aRetirer: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      // Le prefixe est celui du compte courant et de lui seul (`prefixeLocalStorage` valide l'empreinte).
      if (k !== null && cleAppartientAuCompte(k, empreinte) && k !== `${prefixeLocalStorage(empreinte)}${NOM_CLE_JOURNAL}`) aRetirer.push(k);
    }
    for (const k of aRetirer) { s.removeItem(k); cles += 1; }
  }
  return { bases, cles };
}

// ---------------------------------------------------------------------------------------------------
// Effacement
// ---------------------------------------------------------------------------------------------------

export type ResultatEffacement =
  | { readonly ok: true; readonly bases: readonly string[]; readonly cles: number }
  | {
    readonly ok: false;
    readonly raison: "AUCUN_COMPTE" | "FILE_NON_VIDE" | "DECOMPTE_INDISPONIBLE" | "COMPTE_CHANGE" | "ECHEC_SUPPRESSION";
    /** Presente pour FILE_NON_VIDE : le texte et les actions a montrer a l'agent. */
    readonly decision?: DecisionSuppression;
  };

export interface OptionsEffacement extends PortSuppression {
  /** Decompte de la file du compte courant (par defaut `decompteFileLocale` de offlineSync, importe a la demande). */
  readonly decompte?: () => Promise<ComptesFile>;
  /** Supprime le coffre du compte (par defaut `chiffreur.reinitialiser()` du compte courant). */
  readonly supprimerCoffre?: () => Promise<void>;
  readonly stockageIndice?: StockageIndice | null;
  readonly stockageJournal?: StockageTexte | null;
  readonly maintenant?: () => number;
}

async function decompteParDefaut(): Promise<ComptesFile> {
  const { decompteFileLocale } = await import("./offlineSync");
  return decompteFileLocale();
}

/**
 * Efface les donnees locales du compte COURANT, ou refuse. Ne leve jamais. Voir l'en-tete pour les regles.
 */
export async function effacerDonneesLocales(options: OptionsEffacement = {}): Promise<ResultatEffacement> {
  const ctx: ContexteCompte | null = compteCourant();
  if (ctx === null) return { ok: false, raison: "AUCUN_COMPTE" };

  let decision: DecisionSuppression;
  try {
    decision = decisionSuppressionLocale(await (options.decompte ?? decompteParDefaut)());
  } catch {
    return { ok: false, raison: "DECOMPTE_INDISPONIBLE" };
  }
  if (decision.refusee) return { ok: false, raison: "FILE_NON_VIDE", decision };

  // Le decompte a pu durer : si l'agent a change de compte entre-temps, on ne supprime rien (jamais l'autre compte).
  const apres = compteCourant();
  if (apres === null || apres.generation !== ctx.generation || apres.empreinte !== ctx.empreinte) {
    return { ok: false, raison: "COMPTE_CHANGE" };
  }

  // Plus aucune ecriture ne doit recreer ce que l'on supprime.
  fermerCompte();
  try {
    const bilan = await supprimerStockageDuCompte(ctx.empreinte, options);
    const supprimerCoffre = options.supprimerCoffre
      ?? (typeof (ctx.chiffreur as { reinitialiser?: unknown }).reinitialiser === "function"
        ? () => (ctx.chiffreur as unknown as { reinitialiser(): Promise<void> }).reinitialiser()
        : null);
    if (supprimerCoffre !== null) await supprimerCoffre();
    retirerCompteDeIndice(ctx.compteId, options.stockageIndice === undefined ? stockageNavigateur() : options.stockageIndice);
    creerJournal({ empreinte: ctx.empreinte, stockage: options.stockageJournal, maintenant: options.maintenant }).ajouter("EFFACEMENT_LOCAL");
    return { ok: true, bases: bilan.bases, cles: bilan.cles };
  } catch {
    // Echec en cours de route : on rend le compte a l'agent tel qu'il est (rien n'est a moitie annonce).
    try { ouvrirCompte({ compteId: ctx.compteId, empreinte: ctx.empreinte, chiffreur: ctx.chiffreur }); } catch { /* deja ouvert ailleurs */ }
    return { ok: false, raison: "ECHEC_SUPPRESSION" };
  }
}
