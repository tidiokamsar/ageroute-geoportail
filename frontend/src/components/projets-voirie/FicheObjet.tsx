/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { forwardRef } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import type { JeuProjet, ObjetCarte } from "../../lib/projetsVoirieApi";
import { STYLE_RESEAU, formaterDate, formaterMetres } from "../../lib/projetsVoirie";
import { nomDuJeu } from "./PanneauCouches";

/**
 * Fiche d'un objet : les attributs d'ORIGINE du fichier, tels quels.
 *
 * SECURITE : ces valeurs viennent d'un fichier tiers (KML, GeoJSON). Elles sont rendues comme du TEXTE par React ; il n'y a ni `innerHTML`, ni
 * `dangerouslySetInnerHTML`, ni popup Leaflet a contenu HTML dans ce module. Un attribut qui contient `<img onerror=...>` s'affiche
 * litteralement. Une valeur non textuelle est serialisee en JSON, tronquee.
 */

const MAX_VALEUR = 600;
const MAX_ATTRIBUTS = 100;

export function texteValeur(v: unknown): string {
  if (v === null || v === undefined) return "n/d";
  if (typeof v === "string") return v.length > MAX_VALEUR ? `${v.slice(0, MAX_VALEUR)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > MAX_VALEUR ? `${s.slice(0, MAX_VALEUR)}…` : s;
}

export const FicheObjet = forwardRef<HTMLHeadingElement, { objet: ObjetCarte; jeu: JeuProjet | null; onFermer: () => void }>(function FicheObjet({ objet, jeu, onFermer }, refTitre) {
  const entrees = Object.entries(objet.attributs);
  const typeReseau = jeu?.typeReseau ?? jeu?.concessionnaire?.typeReseau ?? null;
  return (
    <section aria-labelledby="pv-titre-fiche" data-testid="fiche-objet" className="rounded-md border border-navy/30 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 id="pv-titre-fiche" ref={refTitre} tabIndex={-1} className="min-w-0 break-words text-sm font-semibold text-navy focus:outline-none">
          {objet.nom ?? "Objet sans nom"}
        </h3>
        <Button type="button" size="sm" variant="ghost" className="min-h-[44px] shrink-0 xl:min-h-8" onClick={onFermer} aria-label="Fermer la fiche de l'objet">
          <X aria-hidden="true" /> Fermer
        </Button>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {objet.nonAutorise && (<><dt className="text-gray-600">Statut</dt><dd className="font-semibold text-amber-900">Non autorisé : donnée en quarantaine, hors de l&apos;analyse</dd></>)}
        {jeu && (
          <>
            <dt className="text-gray-600">Jeu</dt>
            <dd className="break-words">{nomDuJeu(jeu)}, version {jeu.version}</dd>
            {typeReseau && (<><dt className="text-gray-600">Réseau</dt><dd>{STYLE_RESEAU[typeReseau].libelle}</dd></>)}
            <dt className="text-gray-600">Données du</dt>
            <dd>{formaterDate(jeu.dateDonnees)}</dd>
          </>
        )}
        {objet.typeGeom && (<><dt className="text-gray-600">Géométrie</dt><dd>{objet.typeGeom}</dd></>)}
        {objet.longueurM !== null && (<><dt className="text-gray-600">Longueur</dt><dd>{formaterMetres(objet.longueurM)}</dd></>)}
      </dl>
      <h4 className="mt-2 text-xs font-semibold text-gray-800">Attributs d&apos;origine du fichier</h4>
      {entrees.length === 0 ? (
        <p className="text-xs text-gray-600">Le fichier ne portait aucun attribut pour cet objet.</p>
      ) : (
        <div role="region" aria-label="Attributs d'origine, liste défilante" tabIndex={0} className="mt-1 max-h-64 overflow-auto">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          {entrees.slice(0, MAX_ATTRIBUTS).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="break-all text-gray-600">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{texteValeur(v)}</dd>
            </div>
          ))}
        </dl>
        </div>
      )}
      {entrees.length > MAX_ATTRIBUTS && <p className="text-[11px] text-gray-600">{entrees.length - MAX_ATTRIBUTS} autre(s) attribut(s) non affiché(s).</p>}
    </section>
  );
});
