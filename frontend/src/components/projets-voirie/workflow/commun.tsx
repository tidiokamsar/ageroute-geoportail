import type { ReactNode } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { ArrowRight, Ban, Check, Hourglass, Inbox, Lock, Pencil, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { Button } from "../../ui/Button";
import { EtatErreur, EtatVide } from "../EtatsPv";
import { CLASSES_BASCULE_ACTIF, CLASSES_BASCULE_INACTIF } from "../ListeConflits";
import type { Personne } from "../../../lib/projetsVoirieConflitsApi";
import { classerErreurWorkflow, type FormeWorkflow, type StyleWorkflow } from "../../../lib/projetsVoirieWorkflow";
import { formaterNombre } from "../../../lib/projetsVoirie";

/** Elements communs des sections du workflow : badges (mot ET forme), puces de statut avec compteurs, liste paginee par curseur, noms de personnes. */

const ICONES: Record<FormeWorkflow, LucideIcon> = { crayon: Pencil, sablier: Hourglass, coche: Check, croix: X, barre: Ban, boite: Inbox, alerte: TriangleAlert, cadenas: Lock, fleche: ArrowRight };
const BASE = "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-tight";

/** Le MOT et une FORME propre portent l'information, jamais la seule couleur (WCAG 1.4.1). */
export function BadgeWorkflow({ style, donnee, valeur }: { style: StyleWorkflow; donnee: string; valeur: string }) {
  const Icone = ICONES[style.forme];
  return (
    <span data-badge-workflow={donnee} data-valeur={valeur} data-forme={style.forme} className={`${BASE} ${style.classes}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{style.libelle}
    </span>
  );
}

export function BadgeSimple({ classes, children, donnee }: { classes: string; children: ReactNode; donnee?: string }) {
  return <span data-badge-simple={donnee} className={`${BASE} ${classes}`}>{children}</span>;
}

export function BadgeEcheanceDepassee() {
  return <span data-echeance-depassee="oui" className={`${BASE} border-2 border-red-400 bg-red-50 text-red-900`}>Échéance dépassée</span>;
}

/** Nom d'une personne : « non communiqué pour votre profil » quand le serveur la masque (jamais « inconnu » ni vide). */
export const nomPersonne = (p: Personne | null, absent = "non communiqué pour votre profil"): string => (p ? p.nom ?? "compte sans nom" : absent);

export function Ligne({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (<><dt className="text-gray-700">{libelle}</dt><dd className="break-words text-gray-900">{children}</dd></>);
}
export const Liste = ({ children }: { children: ReactNode }) => <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">{children}</dl>;

export function SectionFiche({ id, titre, children }: { id: string; titre: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-1.5 border-t border-gray-200 pt-2">
      <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-800">{titre}</h4>
      {children}
    </section>
  );
}

/** Puces de statut : un seul statut a la fois, avec le compteur du serveur quand il le donne (jamais zero invente). */
export function PucesStatut<S extends string>({ valeur, onChange, statuts, libelles, compteurs, libelleTous, aria }: {
  valeur: S | ""; onChange: (s: S | "") => void; statuts: readonly S[]; libelles: Readonly<Record<S, string>>; compteurs: Partial<Record<S, number>> | null; libelleTous: string; aria: string;
}) {
  const total = compteurs ? statuts.reduce((s, k) => s + (compteurs[k] ?? 0), 0) : null;
  const cls = (on: boolean) => `min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${on ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`;
  return (
    <div role="group" aria-label={aria} className="flex flex-wrap gap-1">
      <button type="button" aria-pressed={valeur === ""} onClick={() => onChange("")} className={cls(valeur === "")}>{libelleTous}{total !== null ? ` (${formaterNombre(total, 0)})` : ""}</button>
      {statuts.map((s) => {
        const n = compteurs?.[s];
        const on = valeur === s;
        return (
          <button key={s} type="button" aria-pressed={on} data-statut-filtre={s} onClick={() => onChange(on ? "" : s)} className={cls(on)}>
            {libelles[s]}{typeof n === "number" ? ` (${formaterNombre(n, 0)})` : ""}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Liste paginee par curseur d'une section : chargement, erreur typee (avec Reessayer), liste vide (aucun element / aucun resultat pour ces filtres),
 * elements non lus comptes (jamais masques), bouton « suivants ». `rendre` rend les `<li>`.
 */
export function ListePaginee<P extends { suivant: string | null; ignores: number }, T>({ requete, sujet, elements, etiquette, filtresActifs, videAucun, libelleChargement, libelleSuite, rendre }: {
  requete: UseInfiniteQueryResult<InfiniteData<P>, unknown>; sujet: string; elements: T[]; etiquette: string; filtresActifs: boolean; videAucun: ReactNode;
  libelleChargement: string; libelleSuite: string; rendre: (e: T) => ReactNode;
}) {
  const erreur = requete.isError ? classerErreurWorkflow(requete.error) : null;
  const ignores = requete.data?.pages.reduce((s, p) => s + p.ignores, 0) ?? 0;
  const aSuite = requete.hasNextPage === true;
  return (
    <>
      {requete.isPending && requete.fetchStatus !== "idle" && <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700">{libelleChargement}</p>}
      {erreur && <EtatErreur erreur={erreur} sujet={sujet} onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
      {requete.isSuccess && (
        <>
          <p role="status" className="text-xs text-gray-700" data-testid={`etat-liste-${etiquette}`}>
            {elements.length === 0 ? "Aucun élément à afficher." : `${formaterNombre(elements.length, 0)} élément(s) chargé(s)${aSuite ? ", d'autres restent à charger" : ""}.`}
          </p>
          {ignores > 0 && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{ignores} élément(s) de la réponse du serveur n&apos;ont pas pu être lus (statut inconnu de cette version de l&apos;interface) et ne sont pas affichés.</p>}
          {elements.length === 0
            ? (filtresActifs ? <EtatVide titre="Aucun élément ne correspond à ces filtres"><p>Modifiez ou réinitialisez les filtres.</p></EtatVide> : <EtatVide titre="Aucun élément">{videAucun}</EtatVide>)
            : <ul aria-label={`Liste : ${etiquette}`} className="space-y-1.5">{elements.map((e) => rendre(e))}</ul>}
          {aSuite && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full xl:min-h-9" disabled={requete.isFetchingNextPage} onClick={() => void requete.fetchNextPage()}>
              {requete.isFetchingNextPage ? "Chargement…" : libelleSuite}
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** Bouton d'une ligne de liste : toute la ligne s'ouvre, cible tactile de 44 px. */
export function LigneBouton({ donnee, id, actif, onOuvrir, children }: { donnee: string; id: string; actif: boolean; onOuvrir: () => void; children: ReactNode }) {
  return (
    <li>
      <button
        type="button" onClick={onOuvrir} aria-current={actif ? "true" : undefined} {...{ [`data-${donnee}-id`]: id }}
        className={`flex min-h-[44px] w-full flex-col gap-1 rounded border p-2 text-left text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy ${actif ? "border-2 border-navy bg-blue-50" : "border-gray-300 bg-white"}`}
      >
        {children}
      </button>
    </li>
  );
}
