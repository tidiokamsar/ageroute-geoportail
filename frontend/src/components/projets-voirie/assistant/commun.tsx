import type { ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Button } from "../../ui/Button";
import type { Avertissement } from "../../../lib/projetsVoirieApi";
import { formaterNombre, type ErreurPv } from "../../../lib/projetsVoirie";
import { libelleAvertissement, libelleEtape, type IdEtape } from "../../../lib/projetsVoirieImport";
import { etapeDeCorrection } from "../../../lib/projetsVoirieImportErreurs";

/**
 * Briques communes des etapes de l'assistant. Tout contenu venu d'un fichier (noms, attributs, colonnes) est rendu comme TEXTE par React :
 * jamais de HTML brut, jamais de popup Leaflet a contenu HTML.
 */

/** Classes d'etat SEPAREES (une chaine par etat) : le controle de contraste statique juge chaque chaine seule, pas la paire actif/inactif. */
export const CLASSE_ETAPE_COURANTE = "bg-navy text-white";
export const CLASSE_ETAPE_FAITE = "bg-green-100 text-green-900";
export const CLASSE_ETAPE_A_VENIR = "bg-gray-100 text-gray-800";

export function Champ({ id, libelle, aide, erreur, children }: { id: string; libelle: string; aide?: string; erreur?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">{libelle}</label>
      {children}
      {aide && !erreur && <p id={`${id}-aide`} className="mt-0.5 text-xs text-gray-600">{aide}</p>}
      {erreur && <p id={`${id}-erreur`} role="alert" className="mt-0.5 text-xs text-red-700">{erreur}</p>}
    </div>
  );
}

export function Encart({ titre, children, ton = "info", testid }: { titre?: string; children: ReactNode; ton?: "info" | "attention"; testid?: string }) {
  const classe = ton === "attention" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-gray-50 text-gray-900";
  return (
    <div role="note" data-testid={testid} className={`flex items-start gap-2 rounded border p-2 text-sm ${classe}`}>
      {ton === "attention" ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0">{titre && <p className="font-semibold">{titre}</p>}{children}</div>
    </div>
  );
}

export function ListeAvertissements({ liste, titre = "Avertissements du serveur" }: { liste: readonly Avertissement[]; titre?: string }) {
  if (liste.length === 0) return <p className="text-sm text-gray-700">Aucun avertissement du serveur.</p>;
  return (
    <div>
      <h4 className="text-sm font-semibold text-amber-900">{titre} ({liste.length})</h4>
      <ul className="mt-1 space-y-1">
        {liste.map((a, i) => (
          <li key={`${a.code}-${i}`} className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{libelleAvertissement(a)}{a.nb !== null && <> ({formaterNombre(a.nb, 0)} concerné(s))</>}<span className="block text-xs text-amber-900">Code : {a.code}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CODES_AVEC_LIEN = ["JEU_DEJA_CHARGE", "DEPOT_EN_ATTENTE"];

/**
 * Erreur typee de l'API, dite en clair, avec le code (pour le support), un lien vers le jeu existant (409 JEU_DEJA_CHARGE, DEPOT_EN_ATTENTE),
 * le delai d'attente (429, 503) et, quand le code designe une etape en amont, le bouton qui y ramene.
 */
export function ZoneErreurImport({ erreur, etapeCourante, onVoirJeu, onAller }: {
  erreur: ErreurPv; etapeCourante?: IdEtape; onVoirJeu?: (jeuId: string) => void; onAller?: (e: IdEtape) => void;
}) {
  const dejaCharge = erreur.code === "JEU_DEJA_CHARGE";
  const lien = erreur.code !== null && CODES_AVEC_LIEN.includes(erreur.code) && erreur.jeuId && onVoirJeu;
  const correction = erreur.code ? etapeDeCorrection(erreur.code) : null;
  const proposerCorrection = correction !== null && correction !== etapeCourante && onAller !== undefined;
  return (
    <div role="alert" data-code={erreur.code ?? undefined} data-genre={erreur.genre} className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p>
          {dejaCharge ? <strong>Ce fichier est déjà chargé. </strong> : null}
          {erreur.message}
          {dejaCharge && <> Le contrôle porte sur l&apos;empreinte du fichier : le même fichier avec un autre système de coordonnées est refusé de la même façon.</>}
          {erreur.retryAfterS !== null && erreur.retryAfterS !== undefined && <> Nouvel essai possible dans {formaterNombre(erreur.retryAfterS, 0)} s.</>}
          {erreur.code && <span className="block text-xs text-red-800">Code : {erreur.code}</span>}
        </p>
        {lien && <button type="button" onClick={() => onVoirJeu(erreur.jeuId as string)} className="mt-1 min-h-[44px] text-left font-medium underline sm:min-h-0">Voir le jeu existant</button>}
        {proposerCorrection && correction && (
          <Button type="button" size="sm" variant="outline" className="mt-1 min-h-[44px] sm:min-h-8" onClick={() => onAller?.(correction)}>
            Corriger à l&apos;étape « {libelleEtape(correction)} »
          </Button>
        )}
      </div>
    </div>
  );
}

export function Tableau({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable)
    <div role="region" aria-label={libelle} tabIndex={0} className="max-h-72 overflow-auto rounded border border-gray-200 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy">
      <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
        <caption className="sr-only">{libelle}</caption>
        {children}
      </table>
    </div>
  );
}

/** Justification obligatoire (10 caracteres au moins), consignee dans le journal d'audit par le serveur. */
export function ChampJustification({ id, libelle, valeur, onChange, disabled, minimum }: {
  id: string; libelle: string; valeur: string; onChange: (v: string) => void; disabled?: boolean; minimum: number;
}) {
  const ok = valeur.trim().length >= minimum;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">{libelle} ({minimum} caractères minimum)</label>
      <textarea id={id} value={valeur} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={1000} disabled={disabled} aria-describedby={`${id}-aide`} className="mt-1 w-full rounded-md border border-gray-400 p-2 text-sm" />
      <p id={`${id}-aide`} className={ok ? "text-xs text-green-800" : "text-xs text-gray-600"}>{valeur.trim().length} / {minimum} caractères minimum. Consignée dans le journal d&apos;audit.</p>
    </div>
  );
}
