import { useMemo } from "react";
import { ArrowRight, Info, ListChecks } from "lucide-react";
import { calculerConstats, type VueListe } from "../../../lib/aideDecisionCarte";
import type { ErreurAD, Intervention, ResumeClassement } from "../../../lib/aideDecisionInterventions";
import { EtatChargement, EtatErreur, EtatVide } from "./EtatsCarte";

/**
 * Panneau « Insights et recommandations » : UNIQUEMENT des constats CALCULES a partir des interventions chargees (comptes et regles
 * explicables : « N interventions au score incomplet », « N sans localisation », « dont N critiques »). AUCUN texte de recommandation
 * statique : la maquette en montrait (« 3 regions prioritaires », « 486 marches »), ce sont des chiffres illustratifs, pas des donnees.
 *
 * Chaque constat dit sur QUOI il est calcule (couverture : « les 50 premieres chargees, 412 au total ») et renvoie a la liste filtree qui
 * l'illustre. Le panneau porte le bandeau « consultatif » : un constat compte des donnees, il ne decide de rien et n'engage aucun credit.
 */

interface Props {
  /** `null` : rien recu encore (chargement ou erreur). */
  items: Intervention[] | null;
  total: number | null;
  /** Decompte EXACT du perimetre calcule par le serveur (score incomplet, non classees) ; `null` s'il manque. */
  resume: ResumeClassement | null;
  suivantExiste: boolean;
  chargement: boolean;
  erreur: ErreurAD | null;
  onReessayer: () => void;
  onVoirListe: (vue: VueListe) => void;
  /** Charge la page suivante de la liste (etend le calcul). */
  onChargerPlus?: () => void;
  chargementSuite?: boolean;
}

export function PanneauInsights({ items, total, resume, suivantExiste, chargement, erreur, onReessayer, onVoirListe, onChargerPlus, chargementSuite }: Props) {
  const calcul = useMemo(() => (items ? calculerConstats(items, total, suivantExiste, resume) : null), [items, total, suivantExiste, resume]);
  const versions = useMemo(() => {
    const m = new Set<string>(); const p = new Set<string>();
    for (const i of items ?? []) { if (i.versionModele) m.add(i.versionModele); if (i.versionParametres) p.add(i.versionParametres); }
    const provisoire = (items ?? []).some((i) => i.provisoire);
    return { modeles: [...m], parametres: [...p], provisoire };
  }, [items]);

  return (
    <section aria-labelledby="decision-insights-titre" className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <h2 id="decision-insights-titre" className="flex items-center gap-2 text-sm font-semibold text-navy">
        <ListChecks className="h-4 w-4" aria-hidden="true" />
        Insights et recommandations
      </h2>
      <p className="flex items-start gap-2 rounded-md bg-gray-50 p-2 text-xs text-gray-800">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span><strong>Consultatif, non engageant.</strong> Ces constats sont des comptes calculés sur les interventions chargées ; ils ne recommandent aucune action et n&apos;engagent aucun crédit.</span>
      </p>

      {erreur ? (
        <EtatErreur panneau="Constats" erreur={erreur} onReessayer={onReessayer} />
      ) : chargement || !calcul ? (
        <EtatChargement libelle="Calcul des constats…" />
      ) : calcul.couverture.chargees === 0 ? (
        <EtatVide titre="Aucun constat à calculer" detail="Aucune intervention dans ce périmètre filtré. Ce n'est pas un zéro de constats : il n'y a rien à compter." />
      ) : (
        <>
          <ul className="space-y-2">
            {calcul.constats.map((c) => (
              <li key={c.code} data-constat={c.code} className="rounded-md border border-gray-100 p-2">
                <p className="text-sm font-semibold text-gray-900">{c.libelle}</p>
                {c.detail && <p className="text-xs text-gray-700">{c.detail}</p>}
                {c.nombre > 0 && !calcul.couverture.complet && <p data-portee={c.portee} className="text-xs text-gray-700">{c.portee === "perimetre" ? "Sur tout le périmètre (décompte du serveur)." : `Parmi les ${calcul.couverture.chargees.toLocaleString("fr-FR")} chargées seulement.`}</p>}
                {c.nombre > 0 && (
                  <button
                    type="button"
                    onClick={() => onVoirListe(c.vue)}
                    aria-label={`Voir dans la liste : ${c.libelle}`}
                    className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-navy underline underline-offset-2 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:min-h-8"
                  >
                    Voir dans la liste
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p data-couverture={calcul.couverture.complet ? "complete" : "partielle"} className="text-xs text-gray-800">{calcul.couverture.phrase}</p>
          {!calcul.couverture.complet && onChargerPlus && (
            <button
              type="button"
              onClick={onChargerPlus}
              disabled={chargementSuite}
              aria-label="Charger plus d'interventions pour étendre les constats"
              className="min-h-11 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-60 xl:min-h-9"
            >
              {chargementSuite ? "Chargement…" : "Charger plus"}
            </button>
          )}
          {(versions.modeles.length > 0 || versions.parametres.length > 0) && (
            <p className="text-xs text-gray-700">
              Modèle {versions.modeles.join(", ") || "non renseigné"} · paramètres {versions.parametres.join(", ") || "non renseignés"}
              {versions.provisoire ? " · PROVISOIRES" : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
