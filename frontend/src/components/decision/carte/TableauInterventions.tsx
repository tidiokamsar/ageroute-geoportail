import { AlertTriangle, MapPin, MapPinOff } from "lucide-react";
import { ecartLongueur, formaterDate, formaterNombre, presenterCout, presenterScore } from "../../../lib/aideDecisionCarte";
import type { Intervention } from "../../../lib/aideDecisionInterventions";
import { libelleTroncon } from "../../../lib/libelleTroncon";
import { symbole } from "../../../features/geoportail/map/symbology";

/**
 * Tableau des interventions (onglet « Liste »). Accessible : `caption`, `scope="col"` sur chaque entete, noms de boutons UNIQUES (le rang et le
 * troncon figurent dans chaque nom), cibles >= 44 px sous 1280 px, defilement horizontal ANNONCE (region focalisable) plutot qu'une page qui deborde.
 *
 * CE QUE CHAQUE COLONNE REFUSE D'INVENTER
 *  - Score : un score INCOMPLET s'ecrit « Score incomplet », avec sa valeur partielle nommee comme telle et ses criteres manquants EN CLAIR ;
 *    jamais le nombre seul. Une ligne NON CLASSEE n'a ni rang ni score : elle dit son motif. Un score absent n'est pas 0.
 *  - Cout : montant + devise + source + validite, ou « Coût non estimable » avec son motif, ou « Coût non renseigné » ; jamais 0. Un cout perime le dit.
 *  - Longueurs : metier et geometrique cote a cote ; la divergence est celle du SERVEUR (seuils provisoires du detecteur), signalee, jamais corrigee.
 *  - Statut : le statut du SCORE (calcule, incomplet, non classe). Le backend ne porte ni statut de revue ni « action suivante » pour une
 *    intervention candidate (aucun workflow n'existe : voir la fiche, « Actions possibles ») : aucune colonne n'est inventee pour eux.
 *  - Localisation : une intervention sans localisation valide RESTE dans la liste, avec un AVERTISSEMENT explicite, et SANS bouton « voir sur la carte ».
 */

interface Props {
  items: readonly Intervention[];
  selectionId: string | null;
  /** Date du jour AAAA-MM-JJ (parametre : le noyau n'a pas d'horloge) pour juger la validite des couts. */
  aujourdhui: string;
  legende: string;
  onOuvrirFiche: (id: string) => void;
  onVoirSurCarte: (id: string) => void;
}

const TH = "whitespace-nowrap border-b border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-700";
const TD = "border-b border-gray-100 px-3 py-2 align-top text-sm text-gray-900";

export function identifiantLigne(id: string): string {
  return `ad-ligne-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function nomIntervention(i: Intervention): string {
  return i.troncon ? libelleTroncon(i.troncon.code, i.troncon.nom ?? "") : "Tronçon non rattaché";
}

const LIBELLE_STATUT_SCORE = { CALCULE: "Calculé", INCOMPLET: "Incomplet", EXCLU: "Non classé" } as const;

export function TableauInterventions({ items, selectionId, aujourdhui, legende, onOuvrirFiche, onVoirSurCarte }: Props) {
  return (
    // Region defilable : elle doit etre focalisable pour que le clavier la fasse defiler (WCAG 2.1.1) ; le nom dit qu'elle defile.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label="Tableau des interventions, défilable horizontalement" tabIndex={0} className="overflow-x-auto rounded-lg border border-gray-200 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60">
      <table className="min-w-[1100px] w-full border-collapse">
        <caption className="px-3 py-2 text-left text-xs text-gray-800">{legende}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>Rang</th>
            <th scope="col" className={TH}>Intervention</th>
            <th scope="col" className={TH}>Région</th>
            <th scope="col" className={TH}>État physique</th>
            <th scope="col" className={TH}>Score</th>
            <th scope="col" className={TH}>Coût estimé</th>
            <th scope="col" className={TH}>Longueurs</th>
            <th scope="col" className={TH}>Dernier constat</th>
            <th scope="col" className={TH}>Statut du score</th>
            <th scope="col" className={TH}>Carte</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const nom = nomIntervention(i);
            const selectionnee = i.id === selectionId;
            const score = presenterScore(i.score, i.scoreIncomplet, i.exclusion);
            const cout = presenterCout(i, aujourdhui);
            const ecart = ecartLongueur(i.longueur);
            const rang = i.rang === null ? "non établi" : String(i.rang);
            const localisee = i.localisation === "valide";
            return (
              <tr key={i.id} data-intervention={i.id} data-selectionnee={selectionnee ? "oui" : undefined} className={selectionnee ? "bg-amber-50" : undefined}>
                <th scope="row" className={`${TD} whitespace-nowrap font-semibold tabular-nums`}>
                  {rang}
                  {i.provisoire && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] font-semibold uppercase text-gray-800">provisoire</span>}
                </th>
                <td className={`${TD} min-w-[14rem]`}>
                  <button
                    type="button"
                    id={identifiantLigne(i.id)}
                    aria-pressed={selectionnee}
                    aria-label={`Ouvrir la fiche, rang ${rang} : ${nom}`}
                    onClick={() => onOuvrirFiche(i.id)}
                    className="min-h-11 text-left font-medium text-navy underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:min-h-8"
                  >
                    {nom}
                  </button>
                  {!localisee && (
                    <p className="mt-0.5 flex items-start gap-1 text-xs font-medium text-amber-900">
                      <MapPinOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Sans localisation valide : consultable ici, pas sur la carte
                    </p>
                  )}
                </td>
                <td className={TD}>{i.troncon?.regionNom ?? "non renseignée"}</td>
                <td className={TD}>
                  {i.etatPhysique ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: symbole(i.etatPhysique).trait }} />
                      {symbole(i.etatPhysique).libelle}
                    </span>
                  ) : "inconnu"}
                </td>
                <td className={`${TD} min-w-[12rem]`}>
                  {score.genre === "complet" && <span className="font-semibold tabular-nums">{score.valeur}</span>}
                  {score.genre === "absent" && <span className="text-gray-800">{score.libelle}</span>}
                  {score.genre === "exclu" && (
                    <div data-score="exclu" className="space-y-0.5 text-xs text-gray-900">
                      <p className="font-semibold">{score.libelle}</p>
                      <p>{score.motif}</p>
                    </div>
                  )}
                  {score.genre === "incomplet" && (
                    <div data-score="incomplet" className="space-y-0.5 rounded-md border border-amber-300 bg-amber-50 p-1.5 text-xs text-amber-950">
                      <p className="flex items-center gap-1 font-semibold"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{score.libelle}</p>
                      <p>{score.valeur === null ? "Aucune valeur partielle." : <>Valeur partielle {score.valeur}</>}</p>
                      <p>
                        {i.criteresManquants.length > 0
                          ? <>Critères manquants : {i.criteresManquants.map((c) => `${c.libelle} (${c.raison})`).join(" ; ")}</>
                          : "Critères manquants non détaillés par le serveur."}
                      </p>
                    </div>
                  )}
                </td>
                <td className={`${TD} min-w-[11rem]`}>
                  <span className={cout.genre === "estime" ? "font-medium tabular-nums" : "text-gray-800"}>{cout.libelle}</span>
                  {cout.detail && <span className="block text-xs text-gray-700">{cout.detail}</span>}
                  {cout.validite === "perime" && <span className="block text-xs font-medium text-amber-900">Coût périmé : à ne pas lire comme fiable</span>}
                </td>
                <td className={`${TD} min-w-[11rem]`}>
                  <span className="block">Métier : {i.longueur?.metierKm == null ? "non renseignée" : `${formaterNombre(i.longueur.metierKm, 2)} km`}</span>
                  <span className="block">Géométrique : {i.longueur?.geometriqueKm == null ? "non calculée" : `${formaterNombre(i.longueur.geometriqueKm, 2)} km`}</span>
                  {ecart?.signale && (
                    <span className="block text-xs font-medium text-amber-900">
                      Écart signalé{ecart.ecartKm !== null ? ` : ${formaterNombre(ecart.ecartKm, 2)} km` : ""}{ecart.ecartRelatif !== null ? ` (${formaterNombre(ecart.ecartRelatif * 100, 1)} %)` : ""}
                    </span>
                  )}
                </td>
                <td className={`${TD} whitespace-nowrap`}>{formaterDate(i.dateDernierConstat) ?? "date inconnue"}</td>
                <td className={TD}>{i.statutScore ? LIBELLE_STATUT_SCORE[i.statutScore] : "non renseigné"}</td>
                <td className={TD}>
                  {localisee ? (
                    <button
                      type="button"
                      onClick={() => onVoirSurCarte(i.id)}
                      aria-label={`Voir sur la carte, rang ${rang} : ${nom}`}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md border border-gray-300 bg-white px-2 text-sm font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 xl:min-h-8"
                    >
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      Voir sur la carte
                    </button>
                  ) : (
                    <span className="text-xs text-gray-700">Aucune position</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
