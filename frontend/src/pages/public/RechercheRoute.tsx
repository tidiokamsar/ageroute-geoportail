import { useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Ecusson } from "./Ecusson";
import { CLASSE_LABELS } from "./types";

export interface RouteIndexee {
  nom: string;
  classe: string;
  longueurKm: number;
  regions: string[];
  positions: [number, number][];
}

// Signes diacritiques combinants, construits en ASCII pur : ecrire la plage en
// caracteres litteraux rend le fichier illisible et fragile aux reencodages.
const SIGNES_DIACRITIQUES = new RegExp("[\\u0300-\\u036f]", "g");

/** Sans accents ni casse : on cherche "nzerekore" et on trouve "Nzérékoré". */
function normaliser(s: string): string {
  return s.normalize("NFD").replace(SIGNES_DIACRITIQUES, "").toLowerCase();
}

const MAX_RESULTATS = 8;

/**
 * Recherche d'une route par son numero ou par region. C'est la porte d'entree
 * attendue par un citoyen : il arrive avec une route en tete ("la RN1", "la route
 * de Kankan"), pas avec l'envie d'explorer une carte nationale.
 */
export function RechercheRoute({
  routes,
  onChoisir,
}: {
  routes: RouteIndexee[];
  onChoisir: (route: RouteIndexee) => void;
}) {
  const [terme, setTerme] = useState("");
  const [ouvert, setOuvert] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const resultats = useMemo(() => {
    const q = normaliser(terme.trim());
    if (q.length < 1) return [];
    return routes
      .filter((r) => normaliser(r.nom).includes(q) || r.regions.some((reg) => normaliser(reg).includes(q)))
      // Les correspondances en debut de nom d'abord ("RN1" avant "RES-171"), puis
      // les axes les plus longs : ce sont ceux qu'on cherche le plus souvent.
      .sort((a, b) => {
        const aDebut = normaliser(a.nom).startsWith(q) ? 0 : 1;
        const bDebut = normaliser(b.nom).startsWith(q) ? 0 : 1;
        if (aDebut !== bDebut) return aDebut - bDebut;
        return b.longueurKm - a.longueurKm;
      })
      .slice(0, MAX_RESULTATS);
  }, [terme, routes]);

  function choisir(route: RouteIndexee) {
    onChoisir(route);
    setTerme("");
    setOuvert(false);
    inputRef.current?.blur();
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-2.5 shadow-lg ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-navy">
        <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={terme}
          onChange={(e) => {
            setTerme(e.target.value);
            setOuvert(true);
          }}
          onFocus={() => setOuvert(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOuvert(false);
            if (e.key === "Enter" && resultats.length > 0) choisir(resultats[0]);
          }}
          placeholder="Chercher une route ou une région"
          aria-label="Chercher une route ou une région"
          // La croix native de type="search" ferait doublon avec la notre ; on garde
          // le type pour la touche "rechercher" des claviers mobiles.
          className="min-w-0 flex-1 bg-transparent text-sm text-navy outline-none placeholder:text-slate-400 [&::-webkit-search-cancel-button]:hidden"
        />
        {terme && (
          <button
            type="button"
            onClick={() => {
              setTerme("");
              inputRef.current?.focus();
            }}
            aria-label="Effacer la recherche"
            className="rounded p-0.5 text-slate-400 transition hover:text-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {ouvert && terme.trim().length > 0 && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-black/5">
          {resultats.length === 0 && (
            <li className="px-3 py-3 text-sm text-slate-500">
              Aucune route ne correspond à « {terme.trim()} ».
            </li>
          )}
          {resultats.map((r) => (
            <li key={r.nom}>
              <button
                type="button"
                onClick={() => choisir(r)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <Ecusson nom={r.nom} taille="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-navy">
                    {CLASSE_LABELS[r.classe] ?? r.classe}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.regions.length > 0 ? r.regions.join(", ") : "Région non renseignée"}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400">
                  {Math.round(r.longueurKm)} km
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
