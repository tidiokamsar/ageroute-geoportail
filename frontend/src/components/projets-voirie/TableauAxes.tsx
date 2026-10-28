/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { LigneParAxe } from "../../lib/projetsVoirieApi";
import { formaterMetres, formaterNombre, libelleVerification } from "../../lib/projetsVoirie";

/**
 * Tableau des conflits PAR AXE : triable (boutons dans les en-tetes, `aria-sort`), avec le detail des objets de reseau qui touchent l'axe.
 * Les noms d'axes et d'objets viennent de fichiers : ils sont rendus comme TEXTE, jamais comme HTML.
 */

type Cle = "axe" | "longueurM" | "chausseeM" | "empriseM" | "croisements";
type Sens = "asc" | "desc";

const COLONNES: { cle: Cle; libelle: string; numerique: boolean }[] = [
  { cle: "axe", libelle: "Axe", numerique: false },
  { cle: "longueurM", libelle: "Longueur de l'axe", numerique: true },
  { cle: "chausseeM", libelle: "Réseau en chaussée", numerique: true },
  { cle: "empriseM", libelle: "Réseau en emprise (chaussée comprise)", numerique: true },
  { cle: "croisements", libelle: "Croisements", numerique: true },
];
const NB_COLONNES = 6;

export function trierAxes(lignes: LigneParAxe[], cle: Cle, sens: Sens): LigneParAxe[] {
  const f = sens === "asc" ? 1 : -1;
  return [...lignes].sort((a, b) => {
    const c = cle === "axe" ? a.axe.localeCompare(b.axe, "fr", { numeric: true, sensitivity: "base" }) : (a[cle] as number) - (b[cle] as number);
    return c !== 0 ? c * f : a.axe.localeCompare(b.axe, "fr", { numeric: true });
  });
}

export function TableauAxes({ lignes, nomJeu, versionAlgorithme }: { lignes: LigneParAxe[]; nomJeu: (jeuId: string | null) => string; versionAlgorithme: string | null }) {
  const [tri, setTri] = useState<{ cle: Cle; sens: Sens }>({ cle: "chausseeM", sens: "desc" });
  const [ouverts, setOuverts] = useState<Set<string>>(new Set());
  const triees = useMemo(() => trierAxes(lignes, tri.cle, tri.sens), [lignes, tri]);

  function basculerTri(cle: Cle) {
    setTri((t) => (t.cle === cle ? { cle, sens: t.sens === "asc" ? "desc" : "asc" } : { cle, sens: cle === "axe" ? "asc" : "desc" }));
  }
  function basculer(axe: string) {
    setOuverts((o) => { const n = new Set(o); if (n.has(axe)) n.delete(axe); else n.add(axe); return n; });
  }

  if (lignes.length === 0) {
    return <p className="rounded border border-dashed border-gray-300 p-3 text-sm text-gray-600">Aucun axe de travaux n&apos;est chargé, ou aucun conflit n&apos;est calculé pour l&apos;instant.</p>;
  }

  return (
    <div role="region" aria-label="Conflits par axe, tableau défilant" tabIndex={0} className="max-h-96 overflow-auto rounded border border-gray-200">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <caption className="sr-only">Longueurs de réseau dans la chaussée et dans l&apos;emprise, et croisements, pour chaque axe de travaux</caption>
        <thead className="sticky top-0 bg-gray-100">
          <tr>
            {COLONNES.map((c) => {
              const actif = tri.cle === c.cle;
              return (
                <th key={c.cle} scope="col" aria-sort={actif ? (tri.sens === "asc" ? "ascending" : "descending") : "none"} className={`p-0 font-semibold text-gray-800 ${c.numerique ? "text-right" : ""}`}>
                  <button type="button" onClick={() => basculerTri(c.cle)} className={`flex min-h-[44px] w-full items-center gap-1 px-2 py-1 hover:bg-gray-200 xl:min-h-9 ${c.numerique ? "justify-end" : ""}`}>
                    {c.libelle}
                    {actif ? (tri.sens === "asc" ? <ArrowUp aria-hidden="true" className="h-3 w-3" /> : <ArrowDown aria-hidden="true" className="h-3 w-3" />) : <ArrowUpDown aria-hidden="true" className="h-3 w-3 opacity-60" />}
                    <span className="sr-only">{actif ? (tri.sens === "asc" ? ", tri croissant" : ", tri décroissant") : ", trier"}</span>
                  </button>
                </th>
              );
            })}
            <th scope="col" className="px-2 py-1 font-semibold text-gray-800">Statut</th>
          </tr>
        </thead>
        <tbody>
          {triees.map((l, i) => {
            const ouvert = ouverts.has(l.axe);
            const idDetail = `detail-axe-${i}`;
            return (
              <Fragment key={`${l.axe}-${i}`}>
                <tr className="border-t border-gray-200 align-top">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium text-gray-900">
                    {l.objets.length > 0 ? (
                      <button type="button" aria-expanded={ouvert} aria-controls={idDetail} onClick={() => basculer(l.axe)} className="flex min-h-[44px] items-start gap-1 text-left hover:underline xl:min-h-0">
                        {ouvert ? <ChevronDown aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        <span className="break-words">{l.axe}<span className="sr-only"> : {l.objets.length} objet(s) de réseau, afficher le détail</span></span>
                      </button>
                    ) : (
                      <span className="break-words">{l.axe}</span>
                    )}
                    {l.concessionnaires.length > 0 && <p className="ml-5 text-[11px] font-normal text-gray-600">{l.concessionnaires.join(", ")}</p>}
                  </th>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formaterMetres(l.longueurM)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formaterMetres(l.chausseeM)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formaterMetres(l.empriseM)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formaterNombre(l.croisements, 0)}</td>
                  <td className="px-2 py-1.5 text-[11px]" title={libelleVerification(l.verification)}>{libelleVerification(l.verification)}</td>
                </tr>
                {ouvert && (
                  <tr id={idDetail} className="bg-gray-50">
                    <td colSpan={NB_COLONNES} className="px-2 py-2">
                      <table className="w-full border-collapse text-left text-[11px]">
                        <caption className="sr-only">Objets de réseau touchant l&apos;axe {l.axe}</caption>
                        <thead>
                          <tr className="text-gray-700">
                            <th scope="col" className="py-1 pr-2 font-semibold">Objet</th>
                            <th scope="col" className="py-1 pr-2 font-semibold">Jeu de données</th>
                            <th scope="col" className="py-1 pr-2 text-right font-semibold">En chaussée</th>
                            <th scope="col" className="py-1 text-right font-semibold">En emprise</th>
                          </tr>
                        </thead>
                        <tbody>
                          {l.objets.map((o, k) => (
                            <tr key={k} className="border-t border-gray-200">
                              <td className="py-1 pr-2 break-words">{o.nom ?? "Objet sans nom"}</td>
                              <td className="py-1 pr-2 break-words">{nomJeu(o.jeuId)}</td>
                              <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formaterMetres(o.chausseeM)}</td>
                              <td className="whitespace-nowrap py-1 text-right tabular-nums">{formaterMetres(o.empriseM)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={NB_COLONNES} className="border-t border-gray-300 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-700">
              Chaque ligne est « à vérifier » : aide à la décision, jamais un verdict.{versionAlgorithme ? ` Version de l'algorithme : ${versionAlgorithme}.` : ""}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
