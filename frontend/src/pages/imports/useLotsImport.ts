import { useCallback, useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { downloadViaApi } from "../../lib/download";
import { STATUTS_LOT } from "../../components/imports/imports.noyau";
import type { ParamsApercu } from "../../components/imports/ApercuEchantillon";
import type { OptionsEnvoi } from "../../components/imports/FormulaireReception";
import type { DonneesReception } from "../../components/imports/receptionFormulaire.noyau";
import type {
  FiltresLots, FormatPropose, LotDetail, LotListe, MetaImport, ReceptionReponse, ReponseApercu, ReponseListe, SourceConnue, StatutLot,
} from "../../components/imports/types";

/**
 * Données de la page « Lots d'import » : requêtes (react-query), fonctions d'API et lecture de l'adresse.
 * Contrat : docs/imports/CONTRAT-API-LOTS-IMPORT.md.
 *
 * TROIS PRINCIPES
 *
 * 1. Une réponse inattendue est une ERREUR, jamais un vide. Chaque lecture vérifie la forme minimale dont
 *    l'écran a besoin et lève sinon : l'agent voit « la liste n'a pas pu être chargée », pas « aucun lot ». Les
 *    chiffres affichés (total, compteurs) sont ceux du serveur ; un chiffre absent n'est pas remplacé par un autre.
 * 2. Les filtres (statut, source, q) et le lot sélectionné vivent dans l'ADRESSE (`?statut=&source=&q=&lot=`) :
 *    la sélection d'un lot ne les efface pas, et recharger la page ne perd pas le contexte.
 * 3. Les erreurs axios sont rejetées TELLES QUELLES : le formulaire de réception les classe lui-même (refus
 *    connu, ou résultat incertain). Aucune enveloppe ici ne doit lui cacher le code HTTP.
 *
 * Les paramètres de requête passent par `params` d'axios (et non par une chaîne construite à la main) : la route
 * de liste est STRICTE côté serveur, tout paramètre inconnu y est un 400.
 */

// ---------------------------------------------------------------------------------------------------
// Clés de requête
// ---------------------------------------------------------------------------------------------------

export const CLE_IMPORTS = ["imports"] as const;
export const CLE_META = ["imports", "meta"] as const;
export const CLE_SOURCES = ["imports", "sources"] as const;
export const CLE_LISTE = ["imports", "liste"] as const;
export const CLE_DETAIL = ["imports", "detail"] as const;

/** Taille de page de la liste (le serveur admet 1 à 100, 25 par défaut). */
export const TAILLE_PAGE = 25;
/** Plafonds du serveur (route de liste) : au-delà, c'est un 400, alors qu'une saisie longue n'est pas une faute. */
export const LONGUEUR_MAX_Q = 100;

// ---------------------------------------------------------------------------------------------------
// Adresse : filtres et lot sélectionné
// ---------------------------------------------------------------------------------------------------

export interface ParametresPage {
  filtres: FiltresLots;
  /** Identifiant du lot sélectionné, ou `null`. Texte libre : le serveur dit si le lot existe. */
  lot: string | null;
}

/**
 * Lit l'adresse. Un statut que ce client ne connaît pas est ignoré (le serveur répondrait 400 à un filtre
 * inventé à la main) ; `source`, `q` et `lot` sont des textes libres, repris tels quels.
 */
export function lireParametres(params: URLSearchParams): ParametresPage {
  const statutBrut = params.get("statut") ?? "";
  const statut: FiltresLots["statut"] = (STATUTS_LOT as readonly string[]).includes(statutBrut) ? (statutBrut as StatutLot) : "";
  const lot = params.get("lot");
  return {
    filtres: { statut, source: params.get("source") ?? "", q: params.get("q") ?? "" },
    lot: lot !== null && lot.trim() !== "" ? lot : null,
  };
}

/**
 * Nouvelle adresse : `base` (les autres paramètres sont conservés) avec les filtres et/ou le lot demandés. Une
 * valeur vide retire le paramètre. `q` s'écrit tel que saisi (espaces compris) : l'écran compare l'adresse à ce
 * qu'il a écrit pour savoir si le changement vient d'ailleurs (retour arrière), et une valeur rognée
 * lui ferait effacer une espace que la personne est en train de taper.
 */
export function ecrireParametres(base: URLSearchParams, patch: { filtres?: FiltresLots; lot?: string | null }): URLSearchParams {
  const suivants = new URLSearchParams(base);
  const regler = (cle: string, valeur: string | null | undefined) => {
    if (valeur === null || valeur === undefined || valeur === "") suivants.delete(cle);
    else suivants.set(cle, valeur);
  };
  if (patch.filtres) {
    regler("statut", patch.filtres.statut);
    regler("source", patch.filtres.source);
    regler("q", patch.filtres.q.trim() === "" ? "" : patch.filtres.q);
  }
  if (patch.lot !== undefined) regler("lot", patch.lot);
  return suivants;
}

/** Valeur qui ne suit `valeur` qu'après `delaiMs` sans changement : la frappe n'interroge pas le réseau à chaque touche. */
export function useValeurRetardee<T>(valeur: T, delaiMs: number): T {
  const [retardee, setRetardee] = useState(valeur);
  useEffect(() => {
    const minuteur = setTimeout(() => setRetardee(valeur), delaiMs);
    return () => clearTimeout(minuteur);
  }, [valeur, delaiMs]);
  return retardee;
}

// ---------------------------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------------------------

/** Code HTTP d'une erreur axios (ou de sa forme simulée dans les tests) ; `null` sans réponse (réseau, délai). */
export function statutHttpDe(erreur: unknown): number | null {
  if (typeof erreur !== "object" || erreur === null) return null;
  const reponse = (erreur as { response?: unknown }).response;
  if (typeof reponse !== "object" || reponse === null) return null;
  const statut = (reponse as { status?: unknown }).status;
  return typeof statut === "number" ? statut : null;
}

export const MESSAGE_LOT_INCONNU =
  "Ce lot est introuvable : l'identifiant de l'adresse ne correspond à aucun lot reçu. Aucune donnée n'a été modifiée.";
export const MESSAGE_DETAIL_DROITS = "Votre profil ne permet pas de consulter ce lot.";

/** Message de l'état d'erreur du détail. `true` : laisser le panneau dire son message général. */
export function messageErreurDetail(erreur: unknown): string | true {
  const statut = statutHttpDe(erreur);
  if (statut === 404) return MESSAGE_LOT_INCONNU;
  if (statut === 403) return MESSAGE_DETAIL_DROITS;
  return true;
}

/**
 * Règle de relance : jamais pour un refus du serveur (4xx : 403, 404, 400 ne changent pas en réessayant), et pour le
 * reste la règle par défaut du client de requêtes (la relance d'un lot inconnu retarderait l'erreur pour rien).
 */
function useRegleRelance() {
  const client = useQueryClient();
  return useCallback((echecs: number, erreur: Error): boolean => {
    const statut = statutHttpDe(erreur);
    if (statut !== null && statut >= 400 && statut < 500) return false;
    const regle = client.getDefaultOptions().queries?.retry;
    if (typeof regle === "function") return regle(echecs, erreur);
    if (typeof regle === "number") return echecs < regle;
    if (regle === false) return false;
    return echecs < 3;
  }, [client]);
}

// ---------------------------------------------------------------------------------------------------
// Lecture et vérification des réponses
// ---------------------------------------------------------------------------------------------------

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const estTexte = (v: unknown): v is string => typeof v === "string";

function inattendue(route: string): Error {
  return new Error(`Réponse inattendue du serveur (${route}).`);
}

export function lireMeta(data: unknown): MetaImport {
  if (!estObjet(data) || !Array.isArray(data.formats)) throw inattendue("/v2/imports/meta");
  const formats: FormatPropose[] = data.formats.map((f) => {
    if (!estObjet(f) || !estTexte(f.code) || f.code === "" || !estTexte(f.libelle)) throw inattendue("/v2/imports/meta");
    return { code: f.code as FormatPropose["code"], libelle: f.libelle, aide: estTexte(f.aide) ? f.aide : "" };
  });
  if (typeof data.tailleMaxOctets !== "number" || !Number.isFinite(data.tailleMaxOctets) || data.tailleMaxOctets <= 0) throw inattendue("/v2/imports/meta");
  if (typeof data.limiteLignes !== "number" || !Number.isFinite(data.limiteLignes) || data.limiteLignes < 0) throw inattendue("/v2/imports/meta");
  return {
    formats,
    tailleMaxOctets: data.tailleMaxOctets,
    limiteLignes: data.limiteLignes,
    statuts: Array.isArray(data.statuts) ? data.statuts.filter(estTexte) : [],
  };
}

export function lireSources(data: unknown): SourceConnue[] {
  if (!estObjet(data) || !Array.isArray(data.sources)) throw inattendue("/v2/imports/sources");
  // Le serveur rend l'ordre de la collation de la base et laisse le tri au client : ordre alphabétique stable.
  return data.sources
    .flatMap((s) => (estObjet(s) && estTexte(s.valeur) && s.valeur !== "" && typeof s.nombreLots === "number"
      ? [{ valeur: s.valeur, nombreLots: s.nombreLots }]
      : []))
    .sort((a, b) => a.valeur.localeCompare(b.valeur, "fr"));
}

export function lireListe(data: unknown): ReponseListe {
  if (!estObjet(data) || !Array.isArray(data.lots) || typeof data.total !== "number") throw inattendue("/v2/imports");
  for (const l of data.lots) if (!estObjet(l) || !estTexte(l.id) || !estTexte(l.reference)) throw inattendue("/v2/imports");
  return { lots: data.lots as LotListe[], suivant: estTexte(data.suivant) && data.suivant !== "" ? data.suivant : null, total: data.total };
}

/** Un détail doit porter tout ce que le panneau lit : un champ manquant ferait tomber l'écran, mieux vaut une erreur claire. */
export function lireDetail(data: unknown): LotDetail {
  if (
    !estObjet(data) || !estTexte(data.id) || !estTexte(data.reference) || !Array.isArray(data.etapes)
    || !Array.isArray(data.actionsPermises) || !Array.isArray(data.historique) || !estObjet(data.controle) || !estObjet(data.empreinte)
  ) throw inattendue("/v2/imports/:id");
  return data as unknown as LotDetail;
}

export function lireReception(data: unknown): ReceptionReponse {
  if (!estObjet(data) || !estTexte(data.id) || !estTexte(data.reference) || !estTexte(data.statut) || !estObjet(data.compteurs)) throw inattendue("POST /v2/imports");
  return data as unknown as ReceptionReponse;
}

// ---------------------------------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------------------------------

export function useMetaImport() {
  const retry = useRegleRelance();
  return useQuery({
    queryKey: CLE_META,
    queryFn: async ({ signal }) => lireMeta((await api.get("/v2/imports/meta", { signal })).data),
    // Les formats et plafonds changent avec un déploiement, pas à la minute.
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useSourcesImport() {
  const retry = useRegleRelance();
  return useQuery({
    queryKey: CLE_SOURCES,
    queryFn: async ({ signal }) => lireSources((await api.get("/v2/imports/sources", { signal })).data),
    retry,
  });
}

/** Paramètres de la route de liste : seulement ceux qui ont une valeur (un `q` vide ou fait d'espaces est un 400). */
export function parametresListe(filtres: FiltresLots, curseur: string | null): Record<string, string | number> {
  const params: Record<string, string | number> = { limite: TAILLE_PAGE };
  if (filtres.statut) params.statut = filtres.statut;
  if (filtres.source) params.source = filtres.source;
  const q = filtres.q.trim().slice(0, LONGUEUR_MAX_Q).trim();
  if (q !== "") params.q = q;
  if (curseur) params.curseur = curseur;
  return params;
}

/**
 * Liste paginée par curseur (`suivant`). Les pages déjà chargées restent affichées pendant qu'un autre filtre
 * charge (`keepPreviousData`) : l'écran marque alors la liste comme en cours d'actualisation (`isPlaceholderData`).
 */
export function useListeLots(filtres: FiltresLots) {
  const retry = useRegleRelance();
  const cle = { statut: filtres.statut, source: filtres.source, q: filtres.q.trim() };
  return useInfiniteQuery({
    queryKey: [...CLE_LISTE, cle],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => lireListe((await api.get("/v2/imports", { params: parametresListe(filtres, pageParam), signal })).data),
    getNextPageParam: (derniere) => derniere.suivant ?? undefined,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useDetailLot(id: string | null) {
  const retry = useRegleRelance();
  return useQuery({
    queryKey: [...CLE_DETAIL, id],
    enabled: id !== null,
    queryFn: async ({ signal }) => lireDetail((await api.get(`/v2/imports/${encodeURIComponent(id ?? "")}`, { signal })).data),
    retry,
  });
}

// ---------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------

/** Aperçu d'un lot (`GET /v2/imports/:id/apercu`) : lecture seule, bornée par le serveur. */
export async function chargerApercuLot(lotId: string, params: ParamsApercu): Promise<ReponseApercu> {
  const { data } = await api.get(`/v2/imports/${encodeURIComponent(lotId)}/apercu`, { params });
  if (!estObjet(data) || !Array.isArray(data.lignes)) throw inattendue("/v2/imports/:id/apercu");
  return { lignes: data.lignes, suivant: typeof data.suivant === "number" ? data.suivant : null, tronque: data.tronque === true };
}

/**
 * Réception d'un lot : multipart avec les cinq champs et le fichier. L'erreur axios est rejetée telle quelle (le
 * formulaire distingue « le serveur a refusé » de « la réception n'a pas pu être confirmée » d'après elle). Les
 * champs viennent AVANT le fichier : un serveur qui lit le flux voit les métadonnées avant les octets.
 */
export async function recevoirLot(donnees: DonneesReception, fichier: File, options: OptionsEnvoi): Promise<ReceptionReponse> {
  const corps = new FormData();
  corps.append("systemeSource", donnees.systemeSource);
  corps.append("format", donnees.format);
  corps.append("methodeSource", donnees.methodeSource);
  corps.append("versionMapping", donnees.versionMapping);
  corps.append("autorisationRef", donnees.autorisationRef);
  corps.append("fichier", fichier);
  const { data } = await api.post<ReceptionReponse>("/v2/imports", corps, {
    onUploadProgress: (e) => options.onProgression({ envoye: e.loaded, total: typeof e.total === "number" && e.total > 0 ? e.total : null }),
  });
  return lireReception(data);
}

/** Rapport des lignes rejetées et ignorées (CSV), par l'API authentifiée : un simple lien n'emporterait pas le jeton. */
export function telechargerErreursLot(lot: Pick<LotListe, "id" | "reference">): Promise<void> {
  const nom = `${lot.reference.replace(/[^\w.-]+/g, "_")}-erreurs.csv`;
  return downloadViaApi(`/v2/imports/${encodeURIComponent(lot.id)}/erreurs.csv`, nom);
}
