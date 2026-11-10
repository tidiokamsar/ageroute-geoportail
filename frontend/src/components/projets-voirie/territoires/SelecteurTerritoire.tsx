/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { useArbreTerritoires, useRechercheTerritoires } from "../../../lib/projetsVoirieTerritoiresHooks";
import { useValeurDifferee } from "../../../lib/projetsVoirieHooks";
import {
  LIBELLE_NIVEAU, NIVEAUX_TERRITOIRE, cheminDesAncetres, classerErreurTerritoires, filtrerTerritoires,
  type NiveauTerritoire, type Territoire, type TerritoireResume,
} from "../../../lib/projetsVoirieTerritoires";

/**
 * Selecteur hierarchique de territoire : recherche (nom ou code, sans accents), filtre par niveau, chemin des ancetres de chaque territoire.
 * La liste est celle du PERIMETRE DU COMPTE : le serveur la filtre (un territoire hors perimetre n'existe pas pour lui). Rien n'est code en dur :
 * aucun nom de lieu, aucun niveau impose.
 *
 * Accessibilite : un groupe de boutons radio dans une zone defilante focusable ; le choix courant est rappele en texte au-dessus de la liste.
 * `actifsSeulement` : un territoire desactive n'est pas propose (creation d'un projet) ; sinon il l'est, marque « inactif » (filtre de liste).
 */

const AFFICHES_MAX = 60;

export interface PropsSelecteurTerritoire {
  libelle: string;
  aide?: string;
  valeur: string | null;
  /** Territoire courant, s'il est connu par ailleurs (fiche du projet) : affiche meme avant le chargement de l'arbre. */
  courant?: TerritoireResume | null;
  onChange: (t: Territoire | null) => void;
  actifsSeulement?: boolean;
  /** Libelle d'une option « aucun territoire » (filtre) ; absente = un territoire est obligatoire. */
  optionAucun?: string;
  erreur?: string;
  desactive?: boolean;
  /** Restriction de confort (le serveur reste la garde), par exemple la region d'un projet deplace. */
  filtre?: (t: Territoire) => boolean;
}

export function SelecteurTerritoire({ libelle, aide, valeur, courant, onChange, actifsSeulement = false, optionAucun, erreur, desactive, filtre }: PropsSelecteurTerritoire) {
  const id = useId();
  const arbre = useArbreTerritoires(true);
  const [saisie, setSaisie] = useState("");
  const [niveau, setNiveau] = useState<NiveauTerritoire | "">("");
  const q = useValeurDifferee(saisie.trim(), 250);
  const tronque = arbre.data?.tronque === true;
  const recherche = useRechercheTerritoires(q, tronque);

  const candidats = useMemo(() => {
    const charges = arbre.data?.territoires ?? [];
    // Arbre tronque (perimetre tres vaste) : la recherche passe aussi par le serveur ; les resultats s'ajoutent sans doublon.
    const enPlus = tronque ? (recherche.data?.territoires ?? []).filter((t) => !arbre.parId.has(t.id)) : [];
    const l = filtrerTerritoires([...charges, ...enPlus], { q, niveau, actifsSeulement });
    return filtre ? l.filter(filtre) : l;
  }, [arbre.data, arbre.parId, recherche.data, tronque, q, niveau, actifsSeulement, filtre]);

  const choisi = valeur ? arbre.parId.get(valeur) ?? null : null;
  const resumeChoisi = choisi ?? (courant && courant.id === valeur ? courant : null);
  const chemin = (t: Pick<Territoire, "chemin">) => cheminDesAncetres(t, arbre.parId);
  const affiches = candidats.slice(0, AFFICHES_MAX);
  const erreurArbre = arbre.isError ? classerErreurTerritoires(arbre.error) : null;

  return (
    <fieldset className="min-w-0 space-y-2 rounded-md border border-gray-300 p-3" aria-describedby={erreur ? `${id}-err` : aide ? `${id}-aide` : undefined} aria-invalid={erreur ? true : undefined}>
      <legend className="px-1 text-sm font-semibold text-navy">{libelle}</legend>
      {aide && <p id={`${id}-aide`} className="text-xs text-gray-700">{aide}</p>}
      <p data-testid="territoire-choisi" className="flex items-start gap-1 text-sm text-gray-900" aria-live="polite">
        <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-navy" />
        {resumeChoisi ? (
          <span>
            Choisi : <strong>{resumeChoisi.nom}</strong> ({LIBELLE_NIVEAU[resumeChoisi.niveau]}, {resumeChoisi.code})
            {choisi && chemin(choisi).noms.length > 0 && <span className="block text-xs text-gray-700">Dans : {chemin(choisi).noms.join(" › ")}</span>}
          </span>
        ) : <span>{optionAucun ? `Aucun : ${optionAucun.toLowerCase()}` : "Aucun territoire choisi."}</span>}
      </p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div>
          <label htmlFor={`${id}-q`} className="block text-xs font-medium text-gray-900">Rechercher (nom ou code)</label>
          <Input id={`${id}-q`} type="search" value={saisie} onChange={(e) => setSaisie(e.target.value)} maxLength={100} autoComplete="off" disabled={desactive} className="mt-0.5 border-gray-300" />
        </div>
        <div>
          <label htmlFor={`${id}-n`} className="block text-xs font-medium text-gray-900">Niveau</label>
          <Select id={`${id}-n`} value={niveau} onChange={(e) => setNiveau(e.target.value as NiveauTerritoire | "")} disabled={desactive} className="mt-0.5 border-gray-300">
            <option value="">Tous les niveaux</option>
            {NIVEAUX_TERRITOIRE.map((n) => <option key={n} value={n}>{LIBELLE_NIVEAU[n]}</option>)}
          </Select>
        </div>
      </div>
      {arbre.isPending && <p role="status" className="text-xs text-gray-700">Chargement des territoires de votre périmètre…</p>}
      {erreurArbre && (
        <div role="alert" data-code={erreurArbre.code ?? undefined} className="flex flex-wrap items-center gap-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
          <span className="min-w-0 flex-1">Les territoires n&apos;ont pas pu être chargés. {erreurArbre.message}</span>
          <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" onClick={() => void arbre.refetch()} disabled={arbre.isFetching}>Réessayer</Button>
        </div>
      )}
      {arbre.isSuccess && (arbre.data.territoires.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 p-2 text-xs text-gray-800">Aucun territoire n&apos;est disponible dans votre périmètre. Demandez à un administrateur de créer le territoire (Paramètres du module, onglet Territoires).</p>
      ) : (
        <div role="region" aria-label={`${libelle} : liste défilante`} tabIndex={0} className="max-h-64 space-y-0.5 overflow-auto rounded border border-gray-200 p-1">
          {optionAucun && (
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded p-1 text-sm text-gray-900 hover:bg-gray-50 xl:min-h-0">
              <input type="radio" name={`${id}-t`} className="h-4 w-4" checked={valeur === null} disabled={desactive} onChange={() => onChange(null)} />
              {optionAucun}
            </label>
          )}
          {affiches.length === 0 && <p className="p-1 text-xs text-gray-700">Aucun territoire ne correspond à cette recherche.</p>}
          {affiches.map((t) => {
            const c = chemin(t);
            return (
              <label key={t.id} className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded p-1 text-sm text-gray-900 hover:bg-gray-50 xl:min-h-0">
                <input type="radio" name={`${id}-t`} className="mt-1 h-4 w-4 shrink-0" checked={valeur === t.id} disabled={desactive} onChange={() => onChange(t)} />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{t.nom}</span>{" "}
                  <span className="rounded bg-gray-100 px-1 text-xs text-gray-800">{LIBELLE_NIVEAU[t.niveau]}</span>{" "}
                  <span className="text-xs text-gray-700">{t.code}</span>
                  {!t.actif && <span className="ml-1 text-xs font-semibold text-amber-900">(inactif)</span>}
                  {c.noms.length > 0 && <span className="block text-xs text-gray-700">{c.noms.join(" › ")}{c.complet ? "" : " (chemin partiel)"}</span>}
                </span>
              </label>
            );
          })}
          {candidats.length > AFFICHES_MAX && <p className="p-1 text-xs text-gray-700">{candidats.length - AFFICHES_MAX} autre(s) territoire(s) : affinez la recherche ou choisissez un niveau.</p>}
        </div>
      ))}
      {tronque && <p className="text-xs text-gray-700">Votre périmètre compte beaucoup de territoires : la recherche interroge aussi le serveur (deux caractères au moins).</p>}
      {erreur && <p id={`${id}-err`} role="alert" className="text-xs text-red-700">{erreur}</p>}
    </fieldset>
  );
}
