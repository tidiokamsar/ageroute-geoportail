import type { UseQueryResult } from "@tanstack/react-query";
import { classerErreur, type LigneQualiteMethode, type QualiteMethodes as Qualite } from "../../lib/teledetectionApi";
import { affichageTaux, libelleType, MENTION_NON_PRECISION } from "../../lib/teledetectionAffichage";
import { BandeauPerime, EtatChargement, EtatErreur, EtatPermission, EtatVide } from "./EtatsPanneau";

/**
 * « Qualite par methode » : les verdicts du terrain par type de changement ET par methode de detection, avec leur effectif
 * (contrat, paragraphe 7 et principe 3).
 *
 * - JAMAIS un pourcentage sans son effectif : chaque taux est rendu « 60,7 % (n = 61) » ; un taux calcule sur trop peu de
 *   verdicts porte « echantillon insuffisant » ; zero verdict : « Aucun verdict », jamais 0 %.
 * - Ce taux n'est pas la precision statistique de la methode (voir `MENTION_NON_PRECISION`).
 * - C'est un agregat NATIONAL (toutes regions) : le serveur le refuse a un compte regional (403 HORS_PERIMETRE). L'ecran traite ce
 *   refus comme une ABSENCE DE PERMISSION (message dedie), ni une panne ni un vide ; le taux regional reste dans les indicateurs.
 */

const MESSAGE_REGIONAL =
  "Le détail par méthode agrège toutes les régions : il est réservé aux comptes nationaux. Le taux de confirmation de votre région reste affiché dans les indicateurs et dans le widget « Taux de confirmation terrain ».";

function Taux({ l }: { l: LigneQualiteMethode }) {
  const t = affichageTaux({ confirmees: l.confirmees, infirmees: l.infirmees, seuil: l.seuilEchantillon, echantillonSuffisant: l.echantillonSuffisant });
  if (t.genre === "aucun") return <span className="text-gray-700">Aucun verdict</span>;
  return (
    <span>
      <span className="font-semibold">{t.valeur}</span> <span className="text-gray-700">(n = {t.jugees.toLocaleString("fr-FR")})</span>
      {t.mention && <span data-testid="echantillon-insuffisant" className="mt-0.5 block rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">{t.mention.charAt(0).toUpperCase() + t.mention.slice(1)}</span>}
    </span>
  );
}

export function QualiteMethodes({ qualite }: { qualite: UseQueryResult<Qualite, unknown> }) {
  const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } = qualite;
  const erreur = isError ? classerErreur(error) : null;
  const lignes = data?.lignes ?? [];

  return (
    <section aria-labelledby="titre-qualite-methodes" className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h2 id="titre-qualite-methodes" className="text-sm font-semibold text-navy">Qualité par méthode</h2>
      <p className="mt-0.5 text-xs text-gray-600">Verdicts du terrain par type de changement et par méthode de détection, avec leur effectif.</p>

      {isPending && <EtatChargement libelle="Chargement de la qualité par méthode…" />}
      {erreur && !data && (
        <div className="mt-2">
          {erreur.genre === "permission"
            ? <EtatPermission panneau="Qualité par méthode" message={MESSAGE_REGIONAL} />
            : <EtatErreur panneau="Qualité par méthode" erreur={erreur} onReessayer={() => void refetch()} reessaiEnCours={isFetching} />}
        </div>
      )}
      {erreur && data && <div className="mt-2"><BandeauPerime panneau="Qualité par méthode" misAJourLe={dataUpdatedAt} onReessayer={() => void refetch()} /></div>}

      {data && lignes.length === 0 && (
        <div className="mt-2"><EtatVide titre="Aucune méthode n'a encore produit de proposition" detail="Le détail apparaît dès qu'une méthode a déposé des propositions." /></div>
      )}

      {data && lignes.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Verdicts du terrain par type de changement et par méthode, avec effectif et taux de confirmation</caption>
            <thead>
              <tr className="border-b text-xs text-gray-600">
                <th scope="col" className="py-2 pr-2 font-medium">Type et méthode</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Confirmées</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Infirmées</th>
                <th scope="col" className="py-2 font-medium">Taux de confirmation</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={`${l.type}|${l.methode}`} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pr-2 font-medium text-gray-900">
                    {libelleType(l.type)}
                    <span className="block text-xs font-normal text-gray-600">{l.methode}</span>
                  </th>
                  <td className="py-2 pr-2 text-right">{l.confirmees.toLocaleString("fr-FR")}</td>
                  <td className="py-2 pr-2 text-right">{l.infirmees.toLocaleString("fr-FR")}</td>
                  <td className="py-2"><Taux l={l} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 border-t pt-2 text-xs text-gray-600">{MENTION_NON_PRECISION}</p>
    </section>
  );
}
