import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, Landmark } from "lucide-react";
import { EntityListPage, FilterSelect } from "./EntityListPage";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { EtatBadge } from "../components/ui/Badge";
import { PhotoGallery } from "../components/PhotoGallery";
import { canWrite, useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { ouvrageFields } from "../lib/fieldConfigs";
import type { Ouvrage, Region, TypeOuvrage, EtatPatrimoine } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_META: Record<TypeOuvrage, { label: string; pill: string }> = {
  PONT:            { label: "Pont",             pill: "bg-blue-100 text-blue-700" },
  DALOT:           { label: "Dalot",            pill: "bg-teal-100 text-teal-700" },
  BUSE:            { label: "Buse",             pill: "bg-teal-100 text-teal-700" },
  RADIER:          { label: "Radier",           pill: "bg-teal-100 text-teal-700" },
  PONCEAU:         { label: "Ponceau",          pill: "bg-teal-100 text-teal-700" },
  MUR_SOUTENEMENT: { label: "Mur soutènement",  pill: "bg-purple-100 text-purple-700" },
  TUNNEL:          { label: "Tunnel",           pill: "bg-purple-100 text-purple-700" },
  PASSERELLE:      { label: "Passerelle",       pill: "bg-purple-100 text-purple-700" },
  VIADUC:          { label: "Viaduc",           pill: "bg-purple-100 text-purple-700" },
};

const TYPE_DOTS: Record<TypeOuvrage, string> = {
  PONT:            "bg-blue-500",
  DALOT:           "bg-teal-500",
  BUSE:            "bg-teal-500",
  RADIER:          "bg-teal-500",
  PONCEAU:         "bg-teal-500",
  MUR_SOUTENEMENT: "bg-purple-500",
  TUNNEL:          "bg-purple-500",
  PASSERELLE:      "bg-purple-500",
  VIADUC:          "bg-purple-500",
};

// ── Sub-components ────────────────────────────────────────────────────────────

// Vignette de la première photo (authentifiée via Bearer, même mécanisme que PhotoGallery)
function ThumbCell({ photos }: { photos?: string[] | null }) {
  const filename = photos?.[0];
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!filename) return;
    let url: string | null = null;
    api.get(`/photos/${filename}`, { responseType: "blob" }).then((res) => {
      url = URL.createObjectURL(res.data as Blob);
      setSrc(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [filename]);

  if (!filename) {
    return (
      <div className="h-9 w-9 rounded-md bg-gray-100 flex items-center justify-center text-gray-300">
        <ImageOff className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="h-9 w-9 rounded-md overflow-hidden bg-gray-100 border border-gray-200">
      {src && <img src={src} alt="" className="w-full h-full object-cover" />}
    </div>
  );
}

function TypeBadge({ type }: { type: TypeOuvrage }) {
  const m = TYPE_META[type];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOTS[type]}`} />
      {m.label}
    </span>
  );
}

// ── Page : enveloppe EntityListPage (consolidation) ──────────────────────────
// Spécifique conservé : vignette photo, colonnes code/type/PK/longueur/état,
// filtres région/type/état, galerie photos par ouvrage, action Carte.

export function OuvragesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [regionFilter, setRegion] = useState("");
  const [typeFilter, setType] = useState("");
  const [etatFilter, setEtat] = useState("");
  const [photosOuvrage, setPhotosOuvrage] = useState<Ouvrage | null>(null);

  const { data: regions } = useQuery<Region[]>({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 300_000,
  });

  const columns: ColumnDef<Ouvrage, unknown>[] = [
    {
      id: "photo",
      header: "",
      cell: ({ row: { original: o } }) => <ThumbCell photos={o.photos} />,
    },
    {
      id: "code_nom",
      header: "Code / Nom",
      cell: ({ row: { original: o } }) => (
        <div className="min-w-0">
          {o.code ? (
            <>
              <span className="text-sm font-bold text-navy leading-tight block">{o.code}</span>
              <span className="text-xs text-gray-500 leading-tight block">{o.nom}</span>
            </>
          ) : (
            <span className="text-sm font-semibold text-gray-800">{o.nom}</span>
          )}
        </div>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row: { original: o } }) => <TypeBadge type={o.type} />,
    },
    {
      id: "region",
      header: "Région",
      cell: ({ row: { original: o } }) => (
        <span className="text-sm text-gray-600">{o.region?.nom ?? "—"}</span>
      ),
    },
    {
      id: "troncon",
      header: "Tronçon",
      cell: ({ row: { original: o } }) =>
        o.troncon ? (
          <span className="text-sm font-medium text-navy">{o.troncon.code}</span>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      id: "pk",
      header: "PK",
      cell: ({ row: { original: o } }) =>
        o.pk != null ? (
          <span className="text-xs font-mono text-gray-600 whitespace-nowrap tabular-nums">PK {o.pk}</span>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      accessorKey: "longueurM",
      header: () => <span className="block text-right w-full">Longueur</span>,
      cell: ({ row: { original: o } }) => (
        <span className="block text-right text-sm text-gray-600 tabular-nums pr-2">
          {o.longueurM != null ? `${o.longueurM} m` : <span className="text-gray-300">—</span>}
        </span>
      ),
    },
    {
      accessorKey: "etat",
      header: "État",
      cell: ({ row: { original: o } }) => <EtatBadge etat={o.etat as EtatPatrimoine} />,
    },
  ];

  return (
    <EntityListPage<Ouvrage>
      endpoint="ouvrages"
      title="Ouvrages d'art"
      subtitle="Ponts, dalots, buses et ouvrages hydrauliques"
      pageIcon={<Landmark className="h-4 w-4 text-teal-600" />}
      searchPlaceholder="Rechercher un ouvrage…"
      columns={columns}
      fields={ouvrageFields}
      importExport
      auditEntityType="Ouvrage"
      extraParams={{ region: regionFilter || undefined, etat: etatFilter || undefined, type: typeFilter || undefined }}
      filters={
        <>
          <FilterSelect value={regionFilter} onChange={setRegion}>
            <option value="">Toutes les régions</option>
            {(regions ?? []).map((r) => <option key={r.id} value={r.nom}>{r.nom}</option>)}
          </FilterSelect>
          <FilterSelect value={typeFilter} onChange={setType}>
            <option value="">Tous les types</option>
            <option value="PONT">Pont</option>
            <option value="DALOT">Dalot</option>
            <option value="BUSE">Buse</option>
            <option value="RADIER">Radier</option>
            <option value="PONCEAU">Ponceau</option>
            <option value="MUR_SOUTENEMENT">Mur soutènement</option>
            <option value="TUNNEL">Tunnel</option>
            <option value="PASSERELLE">Passerelle</option>
            <option value="VIADUC">Viaduc</option>
          </FilterSelect>
          <FilterSelect value={etatFilter} onChange={setEtat}>
            <option value="">Tous les états</option>
            <option value="BON">Bon</option>
            <option value="MOYEN">Moyen</option>
            <option value="MAUVAIS">Mauvais</option>
            <option value="CRITIQUE">Critique</option>
            <option value="NON_EVALUE">Non évalué</option>
          </FilterSelect>
        </>
      }
      rowExtraActions={[
        { label: "Photos", onClick: (o) => setPhotosOuvrage(o) },
        { label: "Carte", onClick: (o) => navigate(`/geoportail?select=ouvrage&id=${o.id}`) },
      ]}
    >
      <Modal
        open={!!photosOuvrage}
        onClose={() => setPhotosOuvrage(null)}
        title={`Photos — ${photosOuvrage?.code ? `${photosOuvrage.code} · ` : ""}${photosOuvrage?.nom ?? ""}`}
      >
        {photosOuvrage && (
          <>
            <PhotoGallery endpoint="ouvrages" entityId={photosOuvrage.id} canWrite={canWrite(user?.role)} />
            <div className="flex justify-end mt-4 pt-3 border-t border-gray-100">
              <Button onClick={() => setPhotosOuvrage(null)}>Fermer</Button>
            </div>
          </>
        )}
      </Modal>
    </EntityListPage>
  );
}
