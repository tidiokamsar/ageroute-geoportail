import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import type { LongueurReseau } from "../types";

/**
 * Longueur du reseau : deux chiffres, jamais un seul.
 *
 * CE QUE CE COMPOSANT REMPLACE
 *
 * Le tableau de bord affichait « 7 933 km — Reseau total ». Ce chiffre est la somme
 * de `longueurKm`, et ce champ n'est renseigne que sur 662 troncons sur 1 690 : toutes
 * les nationales, toutes les urbaines, et une seule regionale sur 1 029. Les 13 296 km
 * de geometrie des regionales n'y figuraient pas.
 *
 * L'indicateur le plus visible de l'application sous-estimait donc le reseau de 63 %,
 * et rien dans l'interface ne le laissait deviner.
 *
 * POURQUOI DEUX CHIFFRES ET NON UN CHIFFRE CORRIGE
 *
 * Remplacer 7 933 par 21 156 remplacerait un chiffre trompeur par un autre. La
 * longueur saisie est une donnee metier — c'est elle qui figure aux marches. La
 * longueur calculee est derivee de la geometrie. Elles ne repondent pas a la meme
 * question, et l'ecart entre les deux est lui-meme une information : il dit exactement
 * ce qui reste a renseigner.
 *
 * Toute valeur calculee porte donc sa mention et sa methode. Un lecteur doit pouvoir
 * savoir, sans lire la documentation, laquelle des deux valeurs engage AGEROUTE.
 */

const LIBELLE_CLASSE: Record<string, string> = {
  RN: "Nationales",
  RR: "Régionales",
  RU: "Urbaines",
  PISTE: "Pistes",
};

const km = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 0 });

export function LongueurReseauCard({
  reseau,
  voirieRattachee,
  ouvragesRepris,
}: {
  reseau: LongueurReseau;
  /**
   * Troncons issus de la promotion de voirie. Affiches A COTE du reseau classe, et
   * jamais additionnes : les fondre ferait annoncer 185 264 km de reseau routier la
   * ou la Guinee en a 21 000.
   */
  voirieRattachee?: number;
  /** Franchissements repris d'une source externe, hors inventaire AGEROUTE. */
  ouvragesRepris?: number;
}) {
  const [ouvert, setOuvert] = useState(false);

  // Sans geometrie exploitable, la ventilation n'apprend rien : on s'en tient au
  // chiffre saisi plutot que d'afficher une colonne vide.
  const aGeometrie = reseau.geometrique.totalKm > 0;

  return (
    <div className="text-right">
      <div className="flex items-baseline justify-end gap-5">
        <div>
          <p className="text-2xl font-black leading-none">
            {km(reseau.metier.totalKm)} <span className="text-base font-semibold text-white/70">km</span>
          </p>
          <p className="mt-1 text-[11px] uppercase tracking-wider text-white/50">Longueur renseignée</p>
        </div>

        {aGeometrie && (
          <div className="border-l border-white/20 pl-5">
            <p className="text-2xl font-black leading-none text-white/90">
              {km(reseau.geometrique.totalKm)} <span className="text-base font-semibold text-white/60">km</span>
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-white/50">
              Calculé depuis la géométrie
            </p>
          </div>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-white/45">
        Longueur saisie sur {reseau.metier.tronconsRenseignes} tronçons sur{" "}
        {reseau.metier.tronconsTotal} ({reseau.metier.couverturePct.toFixed(0)} %)
      </p>
      {/* Sans cette ligne, une longueur calculee lors d'une promotion se lirait
          comme une saisie, et l'indicateur de couverture monterait en important de
          la donnee externe au lieu de mesurer le travail de renseignement. */}
      {voirieRattachee != null && voirieRattachee > 0 && (
        <p className="mt-0.5 text-[11px] text-white/45">
          + {voirieRattachee.toLocaleString("fr-FR")} tronçons de voirie rattachée au
          registre{ouvragesRepris ? ` et ${ouvragesRepris.toLocaleString("fr-FR")} franchissements repris` : ""},
          hors réseau classé — comptés à part.
        </p>
      )}
      {(reseau.metier.tronconsDerives ?? 0) > 0 && (
        <p className="mt-0.5 text-[11px] text-amber-300/80">
          + {reseau.metier.tronconsDerives} tronçons dont la longueur est calculée sur
          la géométrie, non saisie — exclus du taux ci-dessus.
        </p>
      )}

      {aGeometrie && (
        <>
          <button
            type="button"
            onClick={() => setOuvert((o) => !o)}
            aria-expanded={ouvert}
            className="mt-1 inline-flex items-center gap-1 rounded text-[11px] text-white/70 underline-offset-2 hover:text-white hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {ouvert ? "Masquer" : "Voir"} la ventilation par classe
            <ChevronDown className={`h-3 w-3 transition-transform ${ouvert ? "rotate-180" : ""}`} />
          </button>

          {ouvert && (
            <div className="mt-3 rounded-lg bg-black/25 p-3 text-left">
              <table className="w-full text-[11.5px] tabular-nums">
                <thead>
                  <tr className="text-white/50">
                    <th className="pb-1.5 text-left font-medium">Classe</th>
                    <th className="pb-1.5 text-right font-medium">Tronçons</th>
                    <th className="pb-1.5 text-right font-medium">Saisie</th>
                    <th className="pb-1.5 text-right font-medium">Calculée</th>
                  </tr>
                </thead>
                <tbody>
                  {reseau.parClasse.map((c) => {
                    // Une classe dont presque aucune longueur n'est saisie est le coeur
                    // du probleme : on la signale plutot que de la noyer.
                    const lacunaire =
                      c.troncons > 0 && c.tronconsAvecLongueurMetier / c.troncons < 0.5;
                    return (
                      <tr key={c.classe} className="border-t border-white/10">
                        <td className="py-1.5 text-white/85">
                          {LIBELLE_CLASSE[c.classe] ?? c.classe}
                        </td>
                        <td className="py-1.5 text-right text-white/60">
                          {c.tronconsAvecLongueurMetier}/{c.troncons}
                        </td>
                        <td
                          className={`py-1.5 text-right ${lacunaire ? "text-amber-300" : "text-white/85"}`}
                        >
                          {km(c.kmMetier)}
                        </td>
                        <td className="py-1.5 text-right text-white/85">{km(c.kmGeometrique)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p className="mt-2.5 flex items-start gap-1.5 text-[10.5px] leading-snug text-white/50">
                <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                <span>
                  La longueur saisie est la donnée métier, celle qui figure aux marchés. La
                  longueur calculée est dérivée de la géométrie ({reseau.geometrique.methode})
                  et n'est écrite nulle part en base.
                </span>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
