import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { avantApres, libelleSection, type DatesChantier } from "../lib/travaux";

/**
 * Chantiers d'un tronçon et historique avant / après intervention (BDRI, lot G), dans sa fiche.
 *
 * Source : `GET /api/v2/chantiers/par-troncon/:id` — le chantier dont c'est le tronçon principal ET ceux qui le
 * touchent par une section. Le BDRI affiche ; quantités, montants et statuts contractuels restent au module des
 * travaux. Les inspections avant et après sont celles déjà chargées par la fiche, classées par les dates du chantier.
 */

interface Chantier extends DatesChantier { id: string; intitule: string; entreprise: string; statut: string; avancementPct: number }
interface Ligne { chantier: Chantier; principal: boolean; sections: { id: string; debutM: number | null; finM: number | null; portionId: string | null; retireLe: string | null }[] }
interface Inspection { id: string; dateInspection: string; etatObserve: string }

const date = (v?: string | null) => (v ? new Date(v).toLocaleDateString("fr-FR") : "non renseignée");
const liste = (xs: Inspection[]) => (xs.length === 0 ? "aucune" : xs.map((i) => `${date(i.dateInspection)} (${i.etatObserve.toLowerCase().replace("_", " ")})`).join(", "));

export function ChantiersDuTroncon({ tronconId, inspections }: { tronconId: string; inspections: Inspection[] }) {
  const q = useQuery({
    queryKey: ["chantiers", "par-troncon", tronconId],
    queryFn: async () => (await api.get<{ chantiers: Ligne[] }>(`/v2/chantiers/par-troncon/${tronconId}`)).data.chantiers,
    retry: false,
  });
  if (q.isLoading) return <p className="text-xs text-gray-500">Chargement des chantiers liés…</p>;
  if (q.isError) return <p className="text-xs text-amber-800">Chantiers liés indisponibles pour votre compte.</p>;
  const lignes = q.data ?? [];
  if (lignes.length === 0) return <p className="text-xs text-gray-600">Aucun chantier ne touche ce tronçon, ni comme tronçon principal ni par une section.</p>;
  return (
    <ul className="space-y-2" aria-label="Chantiers liés au tronçon">
      {lignes.map(({ chantier: c, principal, sections }) => {
        const h = avantApres(inspections, c);
        return (
          <li key={c.id} className="rounded border border-gray-200 p-2 text-xs">
            <p className="font-medium text-navy">{c.intitule} <span className="font-normal text-gray-600">· {c.entreprise} · {c.statut.toLowerCase().replace("_", " ")} · {c.avancementPct} %</span></p>
            <p className="text-gray-700">
              {principal ? "Tronçon principal du chantier" : "Lié par section"}
              {sections.length > 0 && ` · sections : ${sections.map((s) => `${libelleSection(s)}${s.retireLe ? " (retirée)" : ""}`).join(" ; ")}`}
            </p>
            <p className="text-gray-700">Réalisé : {date(c.dateDebutReelle)} → {date(c.dateFinReelle)} · prévu : {date(c.dateDebutPrevue)} → {date(c.dateFinPrevue)}</p>
            {h.base === "aucune" ? (
              <p className="text-gray-600">Sans date de début, les inspections ne sont pas classées avant / après.</p>
            ) : (
              <div className="mt-1 text-gray-700">
                <p>Inspections avant : {liste(h.avant)}</p>
                <p>Pendant : {liste(h.pendant)}</p>
                <p>Après : {h.apres.length === 0 && !(h.base === "reelles" ? c.dateFinReelle : c.dateFinPrevue) ? "travaux non terminés" : liste(h.apres)}</p>
                {h.base === "prevues" && <p className="text-amber-800">Classement sur les dates PRÉVUES : les dates réelles ne sont pas renseignées.</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
