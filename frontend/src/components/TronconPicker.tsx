import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass, Loader2, MapPin } from "lucide-react";
import { api } from "../lib/api";
import { chercherVilles, type Ville } from "../lib/villes";
import { Input } from "./ui/Input";
import type { PaginatedResult, Troncon } from "../types";

// Selecteur de troncon recherchable (le reseau compte ~1580 troncons : pas de <select> brut).
//
// TROIS PORTES, DANS L'ORDRE DU TERRAIN (besoin du 23/10 : « en Guinee les routes ne sont
// pas encore numerotees — je releve ma position GPS et l'appli retrouve le troncon, partout
// ou besoin est ») :
//   1. « Pres de moi » : la position de l'appareil, les troncons du plus proche au plus
//      loin, distance affichee — l'agent reconnait, il ne devine pas ;
//   2. Ville / chef-lieu : liste locale (decision D4 : helper de recherche, jamais ecrit
//      en base) — resolue en lat/lon, un seul mecanisme serveur avec le GPS ;
//   3. Le texte : fragment de code ou de nom, comme avant.
//
// LA POSITION ORDONNE, ELLE NE RATTACHE PAS : le composant rend le troncon CHOISI
// (onChange(id), ou onChoisirObjet(t) quand l'appelant veut la ligne complete) ; le
// rattachement fiable reste l'appariement serveur avec son score.

interface ResultatCommun {
  id: string;
  code: string;
  nom: string;
  region?: string;
  distanceM?: number | null;
}

export function TronconPicker({
  id,
  value,
  initialLabel,
  onChange,
  onChoisirObjet,
  multi,
}: {
  /** Relaye au champ de saisie, pour qu'un `<label htmlFor>` s'y associe (accessibilite). */
  id?: string;
  value: string | null | undefined;
  initialLabel?: string;
  onChange: (id: string | undefined) => void;
  /** Quand l'appelant veut la ligne complete (code, nom, region, distance), pas seulement l'id. */
  onChoisirObjet?: (t: ResultatCommun) => void;
  /** Mode ajout multiple (itineraire) : la liste reste ouverte apres un choix, pour enchainer. */
  multi?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(initialLabel ?? "");

  const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsEnCours, setGpsEnCours] = useState(false);
  const [gpsErreur, setGpsErreur] = useState<string | null>(null);
  const [ville, setVille] = useState<Ville | null>(null);
  const [saisieVille, setSaisieVille] = useState("");
  const [villesOuvert, setVillesOuvert] = useState(false);

  useEffect(() => {
    if (!value) setLabel("");
  }, [value]);

  function demanderGps() {
    setGpsErreur(null);
    if (!("geolocation" in navigator)) {
      setGpsErreur("Position indisponible sur cet appareil : cherchez par ville ou par texte.");
      return;
    }
    setGpsEnCours(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setVille(null);
        setSaisieVille("");
        setGpsEnCours(false);
        setOpen(true);
      },
      (err) => {
        setGpsEnCours(false);
        setGpsErreur(
          err.code === err.PERMISSION_DENIED
            ? "Position refusee : autorisez-la, ou cherchez par ville ou par texte."
            : "Position indisponible : cherchez par ville ou par texte.",
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  }

  const villes = useMemo(
    () => (saisieVille.trim() ? chercherVilles(saisieVille) : []),
    [saisieVille],
  );

  function choisirVille(v: Ville) {
    setVille(v);
    setSaisieVille(v.nom);
    setVillesOuvert(false);
    setGps(null);
    setOpen(true);
  }

  // Point actif : GPS le plus frais, sinon ville. La ville n'est qu'un cas du GPS :
  // un seul mecanisme serveur (lat/lon), decision D4.
  const point = gps ?? (ville ? { lat: ville.lat, lon: ville.lon } : null);

  const geo = useQuery({
    queryKey: ["v2", "troncons-recherche", point],
    enabled: open && !!point,
    staleTime: 60_000,
    queryFn: async () =>
      (await api.get<{ data: ResultatCommun[] }>("/v2/troncons-recherche", {
        params: { lat: String(point?.lat ?? 0), lon: String(point?.lon ?? 0), limite: 12 },
      })).data,
  });

  const texte = useQuery({
    queryKey: ["troncons", "picker", query],
    queryFn: async () =>
      (await api.get<PaginatedResult<Troncon>>("/troncons", { params: { search: query, pageSize: 8 } })).data,
    enabled: open && query.length >= 1,
  });

  // Fusion dedupliquee : les resultats par proximity d'abord (avec leur distance),
  // puis le texte. Un id vu une fois ne se repete pas.
  const fusionnes: ResultatCommun[] = useMemo(() => {
    const vus = new Set<string>();
    const liste: ResultatCommun[] = [];
    for (const r of (geo.data?.data ?? []) as ResultatCommun[]) {
      if (!vus.has(r.id)) { vus.add(r.id); liste.push(r); }
    }
    for (const t of texte.data?.data ?? []) {
      if (!vus.has(t.id)) {
        vus.add(t.id);
        liste.push({ id: t.id, code: t.code, nom: t.nom });
      }
    }
    return liste;
  }, [geo.data, texte.data]);

  function formaterDistance(m?: number | null): string {
    if (m === null || m === undefined) return "";
    return m >= 1000 ? `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km` : `${m} m`;
  }

  function choisir(r: ResultatCommun) {
    if (!multi) {
      onChange(r.id);
      setLabel(`${r.code} — ${r.nom}`);
      setOpen(false);
    }
    onChoisirObjet?.(r);
  }

  return (
    <div className="relative">
      {/* Portes geo, compactes : une rangee de deux gestes au-dessus du champ texte. */}
      {open && (
        <div className="mb-1.5 flex flex-col gap-1.5 sm:flex-row">
          <button
            type="button"
            onClick={demanderGps}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              gps ? "border-navy bg-navy/10 text-navy" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {gpsEnCours ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Compass className="h-3.5 w-3.5" />}
            Pres de moi
          </button>
          <div className="relative flex-1">
            <MapPin className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            <input
              value={saisieVille}
              onChange={(e) => { setSaisieVille(e.target.value); setVillesOuvert(true); }}
              onFocus={() => setVillesOuvert(true)}
              onBlur={() => { window.setTimeout(() => setVillesOuvert(false), 150); }}
              placeholder="Ville ou chef-lieu…"
              aria-label="Chercher par ville ou chef-lieu"
              className={`w-full rounded-lg border py-1.5 pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-navy/20 ${
                ville ? "border-navy bg-navy/5 font-medium text-navy" : "border-gray-300 bg-white"
              }`}
            />
            {villesOuvert && villes.length > 0 && (
              <ul className="absolute z-30 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg" role="listbox" aria-label="Villes suggerees">
                {villes.map((v) => (
                  <li key={v.nom}>
                    <button
                      type="button" role="option" aria-selected={ville?.nom === v.nom}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choisirVille(v)}
                      className="flex w-full items-center justify-between px-2.5 py-2 text-xs hover:bg-navy/5"
                    >
                      <span className="font-medium text-navy">{v.nom}</span>
                      <span className="text-gray-500">{v.region}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <Input
        id={id}
        value={open ? query : label}
        placeholder="Rechercher un troncon (code ou nom)..."
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {value && !open && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="absolute right-2 top-2 text-xs text-gray-500 hover:text-red-600"
        >
          ✕
        </button>
      )}
      {open && (gpsErreur || fusionnes.length > 0 || geo.isFetching) && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow max-h-64 overflow-y-auto">
          {gpsErreur && (
            <p role="status" className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">{gpsErreur}</p>
          )}
          {geo.isFetching && <p className="px-3 py-2 text-xs text-gray-500">Recherche par position…</p>}
          {fusionnes.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              onMouseDown={() => choisir(r)}
            >
              <span className="min-w-0">
                <span className="font-medium">{r.code}</span> — {r.nom}
                {r.region && <span className="block text-[11px] text-gray-500">{r.region}</span>}
              </span>
              <span className="shrink-0 rounded-full bg-navy/5 px-2 py-0.5 text-[11px] font-semibold text-navy tabular-nums">
                {formaterDistance(r.distanceM)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
