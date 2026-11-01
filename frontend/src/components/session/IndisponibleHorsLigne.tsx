import { Link } from "react-router-dom";
import { CloudOff } from "lucide-react";

/** Hors ligne, une route qui a besoin du serveur dit clairement qu'elle n'est disponible qu'en ligne. */
export function IndisponibleHorsLigne() {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <CloudOff className="h-10 w-10 text-amber-600" aria-hidden="true" />
      <h1 className="text-lg font-bold text-navy">Disponible en ligne seulement</h1>
      <p className="max-w-sm text-sm text-gray-700">
        Cette page a besoin du réseau. Hors ligne, seuls le relevé en roulant et la saisie de terrain fonctionnent : vos saisies sont
        enregistrées sur le téléphone et partiront au retour du réseau.
      </p>
      <div className="flex flex-wrap justify-center gap-3 text-sm">
        <Link to="/inspections/releve/enregistrer" className="text-navy underline">Enregistrer en roulant</Link>
        <Link to="/inspections/terrain" className="text-navy underline">Inspection terrain</Link>
        <Link to="/inspections/terrain/observations" className="text-navy underline">Observations terrain</Link>
      </div>
    </div>
  );
}
