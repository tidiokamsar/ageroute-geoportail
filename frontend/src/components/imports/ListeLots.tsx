import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { formaterDate, formatTaille, rendreVisible, resumeControle } from "./CompteursLot";
import type { LotListe } from "./types";

/**
 * Liste des lots reçus : un vrai tableau au-dessus de 768 px, une liste de cartes en dessous.
 *
 * CE QUE LA LISTE NE FAIT PAS
 *
 * - Elle ne présente jamais un lot comme réussi. Le STATUT vient de `renderStatut` (le badge est écrit
 *   ailleurs) ; le CONTRÔLE DU SCHÉMA est un résumé de compteurs réels (« 8 conformes, 2 rejetées »).
 *   `lignesImportees` n'est pas affiché : aucun code ne produit un lot importé, et le montrer à côté des
 *   conformes ferait lire une application qui n'a pas eu lieu. Aucune classe verte dans ce fichier.
 * - Elle ne charge rien et ne connaît pas l'URL : la pagination (`suivant`) et la sélection sont
 *   pilotées par l'intégrateur.
 *
 * POURQUOI UN SEUL DES DEUX RENDUS DANS LE DOM
 *
 * Tableau et cartes en parallèle, masqués par CSS, doubleraient chaque référence dans le DOM : un
 * lecteur d'écran sans CSS les lirait deux fois et les tests de page (`getByText`) trouveraient deux
 * éléments. `matchMedia` choisit donc le rendu ; sans lui (tests, vieux navigateurs), c'est le tableau.
 *
 * LA SÉLECTION AU CLAVIER : un vrai <button> par ligne (Entrée et Espace natifs). La ligne choisie
 * porte `aria-current="true"` et un fond plus un liseré (pas la couleur seule).
 */

const REQUETE_ETROIT = "(max-width: 767px)";

function lireEtroit(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REQUETE_ETROIT).matches;
}

function useEstEtroit(): boolean {
  const [etroit, setEtroit] = useState(lireEtroit);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REQUETE_ETROIT);
    const maj = () => setEtroit(mq.matches);
    maj();
    mq.addEventListener?.("change", maj);
    return () => mq.removeEventListener?.("change", maj);
  }, []);
  return etroit;
}

export interface ListeLotsProps {
  lots: LotListe[];
  /** Nombre de lots correspondant aux filtres, pagination exclue (rendu par le serveur). */
  total: number;
  selectionId: string | null | undefined;
  onSelect: (id: string) => void;
  onChargerPlus: () => void;
  peutChargerPlus: boolean;
  chargementPlus: boolean;
  /** Le badge de statut est fourni par l'intégrateur : cette liste ne décide d'aucune couleur de statut. */
  renderStatut: (lot: LotListe) => ReactNode;
  /** État « aucun lot » riche, si l'intégrateur en a un ; sinon une phrase simple. */
  renderVide?: () => ReactNode;
}

const CIBLE = "min-h-[44px]";

function nomImportateur(lot: LotListe): string {
  return lot.importePar?.nomComplet ? rendreVisible(lot.importePar.nomComplet) : "Non renseigné";
}

/** Contrôle du schéma d'une ligne de la liste. Le motif de rejet du lot n'y est pas recopié : il est dans le détail. */
function ControleSchema({ lot }: { lot: LotListe }) {
  return (
    <>
      <span>{resumeControle(lot)}</span>
      {lot.motifRejetLot && (
        <span className="mt-0.5 block text-xs text-red-900" title={rendreVisible(lot.motifRejetLot)}>
          Motif du rejet dans le détail du lot
        </span>
      )}
    </>
  );
}

function BoutonVoir({ lot, selectionne, onSelect }: { lot: LotListe; selectionne: boolean; onSelect: (id: string) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-voir-detail=""
      className={`${CIBLE} whitespace-nowrap`}
      onClick={() => onSelect(lot.id)}
    >
      Voir le détail
      <span className="sr-only"> du lot {rendreVisible(lot.reference)}{selectionne ? ", affiché" : ""}</span>
    </Button>
  );
}

function LigneTableau({ lot, selectionne, onSelect, renderStatut }: {
  lot: LotListe; selectionne: boolean; onSelect: (id: string) => void; renderStatut: (lot: LotListe) => ReactNode;
}) {
  const nom = rendreVisible(lot.nomFichier);
  const taille = formatTaille(lot.tailleOctets);
  const marque = selectionne ? "bg-blue-50 shadow-[inset_4px_0_0_0_#1d4ed8]" : "";
  return (
    <tr aria-current={selectionne ? "true" : undefined} className={`border-b border-slate-200 align-top ${selectionne ? "bg-blue-50" : "hover:bg-slate-50"}`}>
      <th scope="row" className={`whitespace-nowrap px-3 py-2 text-left font-mono text-xs font-semibold text-slate-900 ${marque}`}>
        {rendreVisible(lot.reference)}
      </th>
      <td className="px-3 py-2 text-sm">{rendreVisible(lot.systemeSource)}</td>
      <td className="px-3 py-2 text-sm">
        <span className="block max-w-[16rem] truncate" title={taille ? `${nom} (${taille.lisible})` : nom}>{nom}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-sm"><time dateTime={lot.importeLe}>{formaterDate(lot.importeLe)}</time></td>
      <td className="px-3 py-2 text-sm">{nomImportateur(lot)}</td>
      {/* Largeurs minimales : le badge coupe ses mots n'importe où (`overflow-wrap:anywhere`), donc sa largeur minimale
          dans un tableau est celle d'une lettre. Mesuré au navigateur : sans ce plancher, « Schéma validé : non
          appliqué » s'écrivait une lettre par ligne. */}
      <td className="min-w-[11rem] px-3 py-2 text-sm">{renderStatut(lot)}</td>
      <td className="min-w-[9rem] px-3 py-2 text-sm"><ControleSchema lot={lot} /></td>
      <td className="px-3 py-2 text-right"><BoutonVoir lot={lot} selectionne={selectionne} onSelect={onSelect} /></td>
    </tr>
  );
}

function CarteLot({ lot, selectionne, onSelect, renderStatut }: {
  lot: LotListe; selectionne: boolean; onSelect: (id: string) => void; renderStatut: (lot: LotListe) => ReactNode;
}) {
  const taille = formatTaille(lot.tailleOctets);
  return (
    <li
      aria-current={selectionne ? "true" : undefined}
      className={`rounded-lg border p-3 ${selectionne ? "border-blue-700 border-l-4 bg-blue-50" : "border-slate-200 bg-white"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="break-all font-mono text-sm font-semibold text-slate-900">{rendreVisible(lot.reference)}</p>
        <div>{renderStatut(lot)}</div>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-700">Source</dt><dd className="break-words">{rendreVisible(lot.systemeSource)}</dd>
        <dt className="text-slate-700">Fichier</dt>
        <dd className="break-all" title={taille?.exact}>{rendreVisible(lot.nomFichier)}</dd>
        <dt className="text-slate-700">Reçue le</dt><dd><time dateTime={lot.importeLe}>{formaterDate(lot.importeLe)}</time></dd>
        <dt className="text-slate-700">Par</dt><dd className="break-words">{nomImportateur(lot)}</dd>
        <dt className="text-slate-700">Contrôle du schéma</dt><dd><ControleSchema lot={lot} /></dd>
      </dl>
      <div className="mt-3"><BoutonVoir lot={lot} selectionne={selectionne} onSelect={onSelect} /></div>
    </li>
  );
}

export function ListeLots({
  lots, total, selectionId, onSelect, onChargerPlus, peutChargerPlus, chargementPlus, renderStatut, renderVide,
}: ListeLotsProps) {
  const etroit = useEstEtroit();
  const racine = useRef<HTMLDivElement>(null);
  // Après « Charger plus », le focus passe au premier lot AJOUTÉ : sans cela il reste sur un bouton qui
  // peut disparaître (dernière page), et un utilisateur au clavier retombe en tête de page.
  const focusDepuis = useRef<number | null>(null);

  useEffect(() => {
    if (focusDepuis.current === null || lots.length <= focusDepuis.current) return;
    const boutons = racine.current?.querySelectorAll<HTMLButtonElement>("button[data-voir-detail]");
    boutons?.[focusDepuis.current]?.focus();
    focusDepuis.current = null;
  }, [lots.length]);

  if (lots.length === 0) {
    return <div ref={racine}>{renderVide ? renderVide() : <p className="text-sm text-slate-700">Aucun lot à afficher.</p>}</div>;
  }

  const nombreLots = `${lots.length.toLocaleString("fr-FR")} ${lots.length > 1 ? "lots" : "lot"} sur ${total.toLocaleString("fr-FR")}`;

  return (
    <div ref={racine} className="space-y-3">
      {etroit ? (
        <ul className="space-y-3" aria-label="Lots d'import reçus">
          {lots.map((lot) => (
            <CarteLot key={lot.id} lot={lot} selectionne={lot.id === selectionId} onSelect={onSelect} renderStatut={renderStatut} />
          ))}
        </ul>
      ) : (
        // Région défilable : si le tableau déborde, le clavier doit pouvoir la faire défiler (WCAG 2.1.1).
        // `relative` : sans lui, les textes `sr-only` (position absolue) des cellules ne sont pas rognés par ce conteneur
        // et élargissent la PAGE (mesuré au navigateur : défilement horizontal du document à 768 px).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" aria-label="Tableau des lots reçus" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[52rem] border-collapse text-left">
            <caption className="sr-only">Lots d'import reçus, du plus récent au plus ancien</caption>
            <thead className="bg-slate-100 text-xs text-slate-800">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Référence</th>
                <th scope="col" className="px-3 py-2 font-semibold">Source</th>
                <th scope="col" className="px-3 py-2 font-semibold">Fichier</th>
                <th scope="col" className="px-3 py-2 font-semibold">Reçue le</th>
                <th scope="col" className="px-3 py-2 font-semibold">Par</th>
                <th scope="col" className="px-3 py-2 font-semibold">Statut</th>
                <th scope="col" className="px-3 py-2 font-semibold">Contrôle du schéma</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <LigneTableau key={lot.id} lot={lot} selectionne={lot.id === selectionId} onSelect={onSelect} renderStatut={renderStatut} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-sm text-slate-700">{nombreLots}</p>
        {peutChargerPlus && (
          <Button
            type="button"
            variant="outline"
            className={CIBLE}
            disabled={chargementPlus}
            aria-busy={chargementPlus}
            onClick={() => { focusDepuis.current = lots.length; onChargerPlus(); }}
          >
            {chargementPlus ? "Chargement des lots…" : "Charger plus de lots"}
          </Button>
        )}
      </div>
    </div>
  );
}
