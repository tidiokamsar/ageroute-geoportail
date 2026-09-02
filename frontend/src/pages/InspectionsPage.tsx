import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { Smartphone, ClipboardList } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { EtatBadge } from "../components/ui/Badge";
import { PhotoGallery } from "../components/PhotoGallery";
import { canWrite, useAuth } from "../lib/auth";
import { inspectionFields } from "../lib/fieldConfigs";
import type { Inspection, EtatPatrimoine } from "../types";

// ── Page : enveloppe EntityListPage (consolidation) ──────────────────────────
// Spécifique conservé : colonnes métier (objet inspecté, inspecteur, défauts),
// filtre état observé, galerie photos par inspection (visible aussi en archivé),
// lien Mode terrain, tri par défaut dateInspection.

export function InspectionsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [etatFilter, setEtatFilter] = useState("");
  const [photosInspection, setPhotosInspection] = useState<Inspection | null>(null);

  const columns: ColumnDef<Inspection, unknown>[] = [
    {
      accessorKey: "dateInspection",
      header: "Date",
      cell: ({ row: { original: i } }) => (
        <span className="text-sm font-semibold text-navy">
          {new Date(i.dateInspection).toLocaleDateString("fr-FR")}
        </span>
      ),
    },
    {
      id: "objetInspecte",
      header: "Objet inspecté",
      cell: ({ row: { original: i } }) => {
        if (i.troncon) {
          return (
            <div className="min-w-0">
              <span className="text-sm font-semibold text-navy">{i.troncon.code}</span>
              <span className="ml-1.5 text-xs text-gray-400">{i.troncon.nom}</span>
            </div>
          );
        }
        if (i.ouvrage) {
          return (
            <div className="min-w-0 flex items-center gap-1.5">
              <span className="text-sm font-semibold text-gray-800">{i.ouvrage.nom}</span>
              <span className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                {i.ouvrage.type}
              </span>
            </div>
          );
        }
        return <span className="text-sm text-gray-300">—</span>;
      },
    },
    {
      id: "inspecteur",
      header: "Inspecteur",
      cell: ({ row: { original: i } }) => (
        <span className="text-sm text-gray-600">{i.inspecteur?.nomComplet ?? "—"}</span>
      ),
    },
    {
      accessorKey: "etatObserve",
      header: "État observé",
      cell: ({ row: { original: i } }) => <EtatBadge etat={i.etatObserve as EtatPatrimoine} />,
    },
    {
      id: "defauts",
      header: "Défauts",
      cell: ({ row: { original: i } }) => {
        if (!i.defautsConstates) return <span className="text-sm text-gray-300">—</span>;
        const truncated = i.defautsConstates.length > 60 ? i.defautsConstates.slice(0, 60) + "…" : i.defautsConstates;
        return <span className="text-sm text-gray-600" title={i.defautsConstates}>{truncated}</span>;
      },
    },
  ];

  return (
    <EntityListPage<Inspection>
      endpoint="inspections"
      title="Inspections"
      subtitle="Constats terrain sur les tronçons et ouvrages"
      pageIcon={<ClipboardList className="h-4 w-4 text-blue-600" />}
      searchPlaceholder="Rechercher une inspection…"
      columns={columns}
      fields={inspectionFields}
      auditEntityType="Inspection"
      defaultSortBy="dateInspection"
      extraParams={{ etat: etatFilter || undefined }}
      filters={
        <FilterSelect value={etatFilter} onChange={setEtatFilter}>
          <option value="">Tous les états</option>
          <option value="BON">Bon</option>
          <option value="MOYEN">Moyen</option>
          <option value="MAUVAIS">Mauvais</option>
          <option value="CRITIQUE">Critique</option>
          <option value="NON_EVALUE">Non évalué</option>
        </FilterSelect>
      }
      rowExtraActions={[
        { label: "Photos", onClick: (i) => setPhotosInspection(i) },
      ]}
      headerExtra={
        <Button variant="secondary" size="sm" onClick={() => navigate("/inspections/terrain")}>
          <Smartphone className="h-3.5 w-3.5 mr-1" /> Mode terrain
        </Button>
      }
    >
      {photosInspection && (
        <Modal
          open
          onClose={() => setPhotosInspection(null)}
          title={`Photos — ${photosInspection.troncon?.code ?? photosInspection.ouvrage?.nom ?? "inspection"}`}
        >
          <PhotoGallery endpoint="inspections" entityId={photosInspection.id} canWrite={canWrite(user?.role)} />
        </Modal>
      )}
    </EntityListPage>
  );
}
