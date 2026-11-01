import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass, Loader2, MapPin, Search } from "lucide-react";
import { api } from "../lib/api";
import { chercherVilles, type Ville } from "../lib/villes";

/**
 * TronconPickerGeo — trouver un tronçon SANS connaître son code.
 *
 * TROIS PORTES D'ENTRÉE, DANS L'ORDRE DU TERRAIN :
 *   1. « Près de moi » : la position de l'appareil (GPS), les plus proches d'abord,
 *      distance affichée — l'agent reconnaît son tronçon au lieu de le deviner ;
 *   2. « Ville » : le chef-lieu choisi dans la liste locale (décision D4 : helper de
 *      recherche, jamais écrit en base) — résolu en lat/lon, même mécanisme que le GPS ;
 *   3. Le texte libre : fragment de code ou de nom, comme l'outil existant.
 *
 * LA DISTANCE ORDONNE, ELLE NE RATTACHE PAS : le composant rend le tronçon CHOISI par
 * l'agent ; le rattachement fiable reste l'appariement serveur avec son score. Le
 * résultat porte la distance pour que le choix soit éclairé, jamais automatique.
 *
 * PENSÉ POUCE : cibles tactiles larges (py-3), libellés lisibles, résultat immédiat
 * sans bouton « rechercher », message d'échec GPS qui propose les deux autres portes.
 */

export interface TronconTrouve {
  id: string;
  code: string;
  nom: string;
  region: string;
  longueurKm: number;
  distanceM: number | null;
}

type Mode = "gps" | "ville";

export function TronconPickerGeo({
  onChoisir,
}: {
  onChoisir: (t: TronconTrouve) => void;
}) {
  const [texte, setTexte] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);
  const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsErreur, setGpsErreur] = useState<string | null>(null);
  const [gpsEnCours, setGpsEnCours] = useState(false);
  const [ville, setVille] = useState<Ville | null>(null);
  const [saisieVille, setSaisieVille] = useState("");
  const [villesOuvert, setVillesOuvert] = useState(false);

  const villes = useMemo(
    () => (saisieVille.trim() ? chercherVilles(saisieVille) : []),
    [saisieVille],
  );

  function demanderGps() {
    setGpsErreur(null);
    if (!("geolocation" in navigator)) {
      setGpsErreur("La position n'est pas disponible sur cet appareil : cherchez par ville ou par texte.");
      return;
    }
    setGpsEnCours(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setMode("gps");
        setGpsEnCours(false);
      },
      (err) => {
        setGpsEnCours(false);
        setGpsErreur(
          err.code === err.PERMISSION_DENIED
            ? "Position refusée : autorisez-la, ou cherchez par ville ou par texte."
            : "Position indisponible : cherchez par ville ou par texte.",
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  }

  function choisirVille(v: Ville) {
    setVille(v);
    setSaisieVille(v.nom);
    setVillesOuvert(false);
    setGps(null);
    setMode("ville");
  }

  // Requête : un seul mécanisme serveur (lat/lon), la ville n'est qu'un cas du GPS.
  const point = gps ?? (ville ? { lat: ville.lat, lon: ville.lon } : null);
  const params: Record<string, string> = {};
  if (point) { params.lat = String(point.lat); params.lon = String(point.lon); }
  else if (texte.trim().length >= 2) params.q = texte.trim();

  const { data, isFetching } = useQuery({
    queryKey: ["v2", "troncons-recherche", params],
    enabled: Object.keys(params).length > 0,
    staleTime: 60_000,
    queryFn: async () => (await api.get<{ data: TronconTrouve[] }>("/v2/troncons-recherche", { params })).data,
  });
  const resultats = data?.data ?? [];

  // Un changement de source GPS/ville relance l'ordre par proximité : le texte ne
  // s'accumule pas avec un point obsolète.
  useEffect(() => { if (point) setTexte(""); }, [point]);

  function formaterDistance(m: number | null): string {
    if (m === null) return "";
    return m >= 1000 ? `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km` : `${m} m`;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={demanderGps}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm font-semibold transition-colors ${
            mode === "gps" ? "border-navy bg-navy/10 text-navy" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          {gpsEnCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <Compass className="h-4 w-4" />}
          Près de moi
        </button>
        <div className="relative flex-1">
          <MapPin className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={saisieVille}
            onChange={(e) => { setSaisieVille(e.target.value); setVillesOuvert(true); }}
            onFocus={() => setVillesOuvert(true)}
            onBlur={() => { window.setTimeout(() => setVillesOuvert(false), 150); }}
            placeholder="Ville ou chef-lieu…"
            aria-label="Chercher par ville ou chef-lieu"
            className={`w-full rounded-lg border px-8 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-navy/20 ${
              mode === "ville" ? "border-navy bg-navy/10 font-medium text-navy" : "border-gray-300 bg-white"
            }`}
          />
          {villesOuvert && villes.length > 0 && (
            <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg" role="listbox" aria-label="Villes suggérées">
              {villes.map((v) => (
                <li key={v.nom}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={ville?.nom === v.nom}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choisirVille(v)}
                    className="flex w-full items-center justify-between px-3 py-2.5 text-sm hover:bg-navy/5"
                  >
                    <span className="font-medium text-navy">{v.nom}</span>
                    <span className="text-xs text-gray-400">{v.region}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={texte}
          onChange={(e) => { setTexte(e.target.value); setMode(null); setGps(null); setVille(null); setSaisieVille(""); }}
          placeholder="Ou par code / nom (RN1, N0142, Kindia…)"
          aria-label="Chercher par code ou nom de tronçon"
          className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-8 pr-3 text-sm focus:border-navy/40 focus:outline-none focus:ring-2 focus:ring-navy/20"
        />
      </div>

      {gpsErreur && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{gpsErreur}</p>
      )}

      {(isFetching || resultats.length > 0) && (
        <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 bg-white" role="listbox" aria-label="Tronçons trouvés">
          {isFetching && <li className="px-3 py-3 text-sm text-gray-400">Recherche…</li>}
          {!isFetching && resultats.length === 0 && (
            <li className="px-3 py-3 text-sm text-gray-400">Aucun tronçon trouvé : élargissez la recherche.</li>
          )}
          {resultats.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChoisir(t)}
                className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left hover:bg-navy/5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-navy">{t.nom}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {t.code} · {t.region} · {t.longueurKm.toLocaleString("fr-FR")} km
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-navy/5 px-2 py-0.5 text-xs font-semibold text-navy tabular-nums">
                  {formaterDistance(t.distanceM)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
