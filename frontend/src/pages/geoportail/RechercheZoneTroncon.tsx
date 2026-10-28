import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, MapPin, Route, Search } from "lucide-react";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { chercherVilles, type Ville } from "../../lib/villes";
import { libelleTroncon } from "../../lib/libelleTroncon";
import { bboxAutour, bboxDeGeometrieTexte, DELAI_EMPRISE_MS, type Bbox } from "../../lib/teledetectionCarte";
import type { TronconGeoFeature } from "./types";

/**
 * Recherche d'une zone ou d'un tronçon pour RECENTRER une carte (carte Observation de la Terre).
 *
 * AUCUN SECOND MOTEUR DE RECHERCHE : ce composant n'est qu'un branchement des mécanismes que le géoportail et ses
 * sélecteurs emploient déjà.
 *   - ZONES : la liste locale des chefs-lieux (`lib/villes.ts`, helper de recherche, décision D4 : jamais un
 *     référentiel administratif). Le cadrage est donc un cadre autour d'un point approximatif, et le résultat le dit.
 *   - TRONÇONS : `GET /v2/troncons-recherche?q=` (code ou nom), le même appel que `TronconPicker` et `TronconPickerGeo`.
 *   - TRACÉ pour cadrer un tronçon : `GET /troncons/geo`, la couche que charge le géoportail (réseau de référence).
 *     Un tronçon hors de cette couche (voirie promue) n'a pas de tracé ici : on le dit, on ne cadre pas à côté.
 *
 * Le résultat appelle `onCentrer(bbox, libelle)` ; c'est la carte qui se recadre. Rien n'est écrit nulle part.
 */

interface TronconTrouve { id: string; code: string; nom: string; region: string }

/** Réseau de référence, chargé UNE fois et seulement au premier tronçon choisi (la réponse pèse plusieurs centaines de ko). */
let cacheTroncons: Promise<TronconGeoFeature[]> | null = null;
function chargerTronconsGeo(): Promise<TronconGeoFeature[]> {
  if (!cacheTroncons) {
    cacheTroncons = api.get<TronconGeoFeature[]>("/troncons/geo").then((r) => r.data).catch((e) => { cacheTroncons = null; throw e; });
  }
  return cacheTroncons;
}
/** Test uniquement : oublie le réseau mémorisé. */
export function _viderCacheTroncons() { cacheTroncons = null; }

type ResultatZone = { genre: "zone"; cle: string; ville: Ville };
type ResultatTroncon = { genre: "troncon"; cle: string; troncon: TronconTrouve };
type Resultat = ResultatZone | ResultatTroncon;

export function RechercheZoneTroncon({ onCentrer, className }: { onCentrer: (bbox: Bbox, libelle: string) => void; className?: string }) {
  const id = useId();
  const racine = useRef<HTMLDivElement>(null);
  const [texte, setTexte] = useState("");
  const [ouvert, setOuvert] = useState(false);
  const [troncons, setTroncons] = useState<{ pour: string; liste: TronconTrouve[] } | null>(null);
  const [attente, setAttente] = useState(false);
  const [erreurRecherche, setErreurRecherche] = useState<string | null>(null);
  const [resolution, setResolution] = useState(false);
  const [message, setMessage] = useState<{ type: "info" | "erreur"; texte: string } | null>(null);

  const saisie = texte.trim();
  const zones = useMemo(() => chercherVilles(saisie), [saisie]);

  // Tronçons : interrogés après 300 ms de pause, à partir de trois caractères (comme la recherche du géoportail).
  useEffect(() => {
    if (saisie.length < 3) { setTroncons(null); setAttente(false); setErreurRecherche(null); return; }
    let annule = false;
    setAttente(true);
    const t = setTimeout(() => {
      api.get<{ data: TronconTrouve[] }>("/v2/troncons-recherche", { params: { q: saisie, limite: 8 } })
        .then(({ data }) => { if (!annule) { setTroncons({ pour: saisie, liste: data.data ?? [] }); setErreurRecherche(null); } })
        .catch((e) => {
          if (annule) return;
          setTroncons(null);
          setErreurRecherche(messageErreur(e, "Recherche de tronçons indisponible."));
        })
        .finally(() => { if (!annule) setAttente(false); });
    }, DELAI_EMPRISE_MS);
    return () => { annule = true; clearTimeout(t); };
  }, [saisie]);

  const resultats: Resultat[] = [
    ...zones.map((v): ResultatZone => ({ genre: "zone", cle: `zone-${v.nom}`, ville: v })),
    ...(troncons && troncons.pour === saisie ? troncons.liste : []).map((t): ResultatTroncon => ({ genre: "troncon", cle: `troncon-${t.id}`, troncon: t })),
  ];

  async function choisir(r: Resultat) {
    setOuvert(false);
    setMessage(null);
    if (r.genre === "zone") {
      const b = bboxAutour(r.ville.lat, r.ville.lon);
      if (!b) { setMessage({ type: "erreur", texte: `Position de ${r.ville.nom} illisible : la carte n'est pas recadrée.` }); return; }
      setTexte(r.ville.nom);
      onCentrer(b, r.ville.nom);
      setMessage({ type: "info", texte: `Carte cadrée sur ${r.ville.nom} (centre approximatif du chef-lieu, pas une limite administrative).` });
      return;
    }
    const nom = libelleTroncon(r.troncon.code, r.troncon.nom);
    setTexte(nom);
    setResolution(true);
    try {
      const reseau = await chargerTronconsGeo();
      const b = bboxDeGeometrieTexte(reseau.find((t) => t.id === r.troncon.id)?.geometry);
      if (!b) {
        setMessage({ type: "erreur", texte: `Tracé indisponible pour ${nom} : il n'est pas dans le réseau de référence chargé, la carte n'est pas recadrée.` });
        return;
      }
      onCentrer(b, nom);
      setMessage({ type: "info", texte: `Carte cadrée sur ${nom}.` });
    } catch (e) {
      setMessage({ type: "erreur", texte: messageErreur(e, `Tracé de ${nom} impossible à charger : la carte n'est pas recadrée.`) });
    } finally {
      setResolution(false);
    }
  }

  const afficherListe = ouvert && saisie.length >= 2;
  const aucun = afficherListe && !attente && resultats.length === 0 && !erreurRecherche;

  return (
    <div
      ref={racine}
      role="search"
      className={className}
      onBlur={(e) => { if (!racine.current?.contains(e.relatedTarget as Node | null)) setOuvert(false); }}
    >
      <div className="relative">
        <label htmlFor={`${id}-q`} className="sr-only">Rechercher une zone ou un tronçon</label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" aria-hidden="true" />
        <input
          id={`${id}-q`}
          type="search"
          value={texte}
          onChange={(e) => { setTexte(e.target.value); setOuvert(true); setMessage(null); }}
          onFocus={() => setOuvert(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && ouvert) { e.stopPropagation(); setOuvert(false); }
            else if (e.key === "Enter" && resultats[0]) { e.preventDefault(); void choisir(resultats[0]); }
          }}
          placeholder="Rechercher une zone, un tronçon..."
          autoComplete="off"
          className="h-11 w-full rounded-full border border-gray-300 bg-white pl-9 pr-9 text-sm text-gray-900 shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        />
        {(attente || resolution) && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-600" aria-hidden="true" />}
      </div>

      {afficherListe && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {resultats.length > 0 && (
            <ul aria-label="Résultats de la recherche">
              {resultats.map((r) => (
                <li key={r.cle}>
                  <button
                    type="button"
                    onClick={() => { void choisir(r); }}
                    className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60"
                  >
                    {r.genre === "zone" ? <MapPin className="h-4 w-4 shrink-0 text-gray-600" aria-hidden="true" /> : <Route className="h-4 w-4 shrink-0 text-gray-600" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-900">
                      {r.genre === "zone" ? r.ville.nom : libelleTroncon(r.troncon.code, r.troncon.nom)}
                    </span>
                    <span className="shrink-0 text-xs text-gray-700">
                      {r.genre === "zone" ? `Zone, région de ${r.ville.region}` : `Tronçon, ${r.troncon.region}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attente && <p role="status" className="px-3 py-2 text-xs text-gray-700">Recherche de tronçons en cours…</p>}
          {erreurRecherche && <p role="alert" className="px-3 py-2 text-xs text-red-700">{erreurRecherche} Les zones restent consultables.</p>}
          {aucun && <p role="status" className="px-3 py-2 text-xs text-gray-700">Aucun résultat pour « {saisie} ».</p>}
        </div>
      )}

      {message && (
        <p
          role={message.type === "erreur" ? "alert" : "status"}
          className={`mt-1 rounded-md px-2 py-1 text-xs shadow ${message.type === "erreur" ? "bg-red-50 text-red-700" : "bg-white/95 text-gray-800"}`}
        >
          {message.texte}
        </p>
      )}
    </div>
  );
}
