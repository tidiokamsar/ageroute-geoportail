import { Check } from "lucide-react";
import { ETAPES, type IdEtape } from "../../../lib/projetsVoirieImport";
import { CLASSE_ETAPE_A_VENIR, CLASSE_ETAPE_COURANTE, CLASSE_ETAPE_FAITE } from "./commun";

/**
 * Indicateur d'etapes : liste ordonnee, l'etape courante porte `aria-current="step"`, les etapes terminees sont dites « terminee » aux lecteurs d'ecran.
 * Ce n'est PAS un jeu de boutons : on navigue avec « Precedent » et « Continuer » (un clic direct sauterait des controles). Sous 640 px, seul le texte
 * « Etape N sur M » reste visible ; la liste complete revient au-dela.
 */
export function Stepper({ etapes, courante }: { etapes: readonly IdEtape[]; courante: IdEtape }) {
  const i = etapes.indexOf(courante);
  const libelle = (id: IdEtape) => ETAPES.find((e) => e.id === id)?.libelle ?? id;
  return (
    <nav aria-label="Progression de l'assistant" className="space-y-1">
      <p className="text-xs font-medium text-gray-700" data-testid="etape-texte">Étape {i + 1} sur {etapes.length} : {libelle(courante)}</p>
      <ol className="hidden flex-wrap gap-1 sm:flex">
        {etapes.map((id, k) => {
          const etat = k < i ? "faite" : k === i ? "courante" : "a-venir";
          const classe = etat === "courante" ? CLASSE_ETAPE_COURANTE : etat === "faite" ? CLASSE_ETAPE_FAITE : CLASSE_ETAPE_A_VENIR;
          return (
            <li key={id} aria-current={etat === "courante" ? "step" : undefined} data-etat={etat} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${classe}`}>
              {etat === "faite" ? <Check aria-hidden="true" className="h-3 w-3" /> : <span aria-hidden="true">{k + 1}</span>}
              <span>{libelle(id)}</span>
              {etat === "faite" && <span className="sr-only"> (terminée)</span>}
              {etat === "a-venir" && <span className="sr-only"> (à venir)</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
