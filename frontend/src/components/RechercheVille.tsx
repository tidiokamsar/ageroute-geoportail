import { useMemo, useState } from "react";
import { MapPin, X, ArrowRight } from "lucide-react";
import { chercherVilles, type Ville } from "../lib/villes";

/**
 * Recherche par ville / localité, partagée géoportail interne + carte publique.
 * Choix d'une ville (autour de laquelle filtrer) puis, optionnellement, d'une
 * seconde ville : seuls les tronçons du corridor entre les deux restent
 * affichés. Les chefs-lieux viennent de lib/villes.ts — helper de recherche,
 * jamais un référentiel administratif (décision D4).
 */
export function RechercheVille({
  onAppliquer, compact,
}: {
  onAppliquer: (filtre: { a: Ville; b?: Ville } | null) => void;
  compact?: boolean;
}) {
  const [saisie, setSaisie] = useState("");
  const [villeA, setVilleA] = useState<Ville | null>(null);
  const [saisieB, setSaisieB] = useState("");
  const [ouvert, setOuvert] = useState<"a" | "b" | null>(null);

  const suggestions = useMemo(
    () => (ouvert === "a" ? chercherVilles(saisie) : chercherVilles(saisieB)),
    [ouvert, saisie, saisieB]
  );

  function choisir(v: Ville) {
    if (ouvert === "b") {
      setVilleB(v);
    } else {
      setVilleA(v);
      setSaisie(v.nom);
    }
    setOuvert(null);
    setSaisieB("");
  }

  const [villeB, setVilleB] = useState<Ville | null>(null);

  function appliquer() {
    if (villeA) onAppliquer({ a: villeA, b: villeB ?? undefined });
  }

  function toutEffacer() {
    setVilleA(null); setVilleB(null); setSaisie(""); setSaisieB(""); setOuvert(null);
    onAppliquer(null);
  }

  return (
    <div className={`w-full ${compact ? "" : "max-w-xs"}`}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <MapPin className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={saisie}
            onChange={(e) => { setSaisie(e.target.value); setOuvert("a"); setVilleA(null); }}
            onFocus={() => setOuvert("a")}
            placeholder="Ville ou localité…"
            className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-sm text-navy placeholder:text-gray-400 focus:border-navy/40 focus:outline-none focus:ring-2 focus:ring-navy/20"
          />
          {saisie && (
            <button onClick={toutEffacer} aria-label="Effacer" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {ouvert === "a" && suggestions.length > 0 && !villeA && (
            <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
              {suggestions.map((v) => (
                <li key={v.nom}>
                  <button
                    onClick={() => choisir(v)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-navy/5"
                  >
                    <MapPin className="h-3 w-3 text-gray-400" />
                    {v.nom}
                    <span className="ml-auto text-[10px] text-gray-400">{v.region}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {villeA && (
          <>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <div className="relative w-32">
              <input
                value={villeB ? villeB.nom : saisieB}
                onChange={(e) => { setSaisieB(e.target.value); setOuvert("b"); setVilleB(null); }}
                onFocus={() => setOuvert("b")}
                placeholder="vers…"
                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-navy placeholder:text-gray-400 focus:border-navy/40 focus:outline-none focus:ring-2 focus:ring-navy/20"
              />
              {ouvert === "b" && suggestions.length > 0 && !villeB && (
                <ul className="absolute z-20 mt-1 w-56 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
                  {suggestions.filter((v) => v.nom !== villeA.nom).map((v) => (
                    <li key={v.nom}>
                      <button
                        onClick={() => choisir(v)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-navy/5"
                      >
                        <MapPin className="h-3 w-3 text-gray-400" />
                        {v.nom}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              onClick={appliquer}
              className="shrink-0 rounded-lg bg-navy px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-navy2"
            >
              Afficher
            </button>
          </>
        )}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-gray-400">
        Une ville → tronçons à moins de 20 km · deux villes → axe entre les deux (les autres couches restent)
      </p>
    </div>
  );
}
