import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { BandeauHorsLigne } from "../components/projets-voirie/EtatsPv";
import { OngletConfiguration } from "../components/projets-voirie/admin/OngletConfiguration";
import { OngletReferentiels } from "../components/projets-voirie/admin/OngletReferentiels";
import { OngletTerritoires } from "../components/projets-voirie/admin/OngletTerritoires";
import { useAuth } from "../lib/auth";
import { useEnLigne } from "../lib/projetsVoirieHooks";

/**
 * Parametres du module « Projets de voirie et reseaux » (lot T1, interface UI-C).
 * - Configuration nationale : LECTURE pour tout compte du module ; ecriture ADMIN.
 * - Territoires et referentiels : ADMIN seulement (onglets absents pour les autres roles) ; le serveur reste la reference (403 sinon).
 * Rien n'est conserve localement.
 */

type IdOnglet = "territoires" | "referentiels" | "configuration";
const LIBELLES: Record<IdOnglet, string> = { territoires: "Territoires", referentiels: "Référentiels", configuration: "Configuration nationale" };

export function ProjetsVoirieParametresPage() {
  const { user } = useAuth();
  const enLigne = useEnLigne();
  const estAdmin = user?.role === "ADMIN";
  const onglets: IdOnglet[] = estAdmin ? ["territoires", "referentiels", "configuration"] : ["configuration"];
  const [onglet, setOnglet] = useState<IdOnglet>(onglets[0]);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const actif = onglets.includes(onglet) ? onglet : onglets[0];

  function surTouche(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let c = i;
    if (e.key === "ArrowRight") c = (i + 1) % onglets.length;
    else if (e.key === "ArrowLeft") c = (i - 1 + onglets.length) % onglets.length;
    else if (e.key === "Home") c = 0;
    else if (e.key === "End") c = onglets.length - 1;
    else return;
    e.preventDefault();
    setOnglet(onglets[c]);
    refs.current[c]?.focus();
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Projets de voirie</Link>
        <h1 className="text-xl font-bold text-navy">Paramètres du module</h1>
        <p className="text-sm text-gray-600">
          {estAdmin
            ? "Territoires, listes de choix et configuration nationale : tout ce qui permet d'ouvrir le module à une nouvelle ville sans modifier le code. Chaque écriture est consignée."
            : "Configuration nationale du module, en lecture. Les territoires et les référentiels sont administrés par un administrateur."}
        </p>
      </header>
      {!enLigne && <BandeauHorsLigne />}
      {onglets.length > 1 && (
        <div role="tablist" aria-label="Paramètres du module" className="flex flex-wrap gap-1">
          {onglets.map((o, i) => (
            <button
              key={o} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`pv-param-onglet-${o}`} aria-selected={actif === o} aria-controls={`pv-param-panneau-${o}`}
              tabIndex={actif === o ? 0 : -1} onClick={() => setOnglet(o)} onKeyDown={(e) => surTouche(e, i)}
              className={`min-h-[44px] rounded-md px-4 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 ${actif === o ? "bg-navy text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
            >
              {LIBELLES[o]}
            </button>
          ))}
        </div>
      )}
      <div role={onglets.length > 1 ? "tabpanel" : undefined} id={`pv-param-panneau-${actif}`} aria-labelledby={onglets.length > 1 ? `pv-param-onglet-${actif}` : undefined} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        {actif === "territoires" && estAdmin && <OngletTerritoires enLigne={enLigne} />}
        {actif === "referentiels" && estAdmin && <OngletReferentiels enLigne={enLigne} />}
        {actif === "configuration" && <OngletConfiguration estAdmin={estAdmin} enLigne={enLigne} />}
      </div>
    </div>
  );
}
