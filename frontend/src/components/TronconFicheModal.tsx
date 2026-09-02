import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { EtatBadge } from "./ui/Badge";
import { QualiteBadge, qualiteDe, type QualiteChamp } from "./QualiteBadge";
import { EntityForm } from "./EntityForm";
import { FicheChildManager } from "./FicheChildManager";
import { TronconDocumentsTab } from "./TronconDocumentsTab";
import { useEntityMutations } from "../hooks/useEntity";
import { useAuth, canWrite as canWriteRole } from "../lib/auth";
import { parseApiError } from "../lib/errors";
import { printFiche } from "../lib/print";
import { tronconFields, ouvrageFields, pointNoirFields, posteFields, chantierFields, inspectionFields } from "../lib/fieldConfigs";
import type { Chantier, Inspection, Ouvrage, PointNoir, Poste, Troncon } from "../types";

interface Fiche {
  troncon: Troncon;
  ouvrages: Ouvrage[];
  pointsNoirs: PointNoir[];
  postes: Poste[];
  chantiers: Chantier[];
  inspections: (Inspection & { inspecteur?: { nomComplet: string } })[];
}

type TabKey = "infos" | "ouvrages" | "pointsNoirs" | "postes" | "chantiers" | "inspections" | "documents";

export function TronconFicheModal({ open, onClose, tronconId }: { open: boolean; onClose: () => void; tronconId: string }) {
  const { user } = useAuth();
  const writable = canWriteRole(user?.role);
  const [tab, setTab] = useState<TabKey>("infos");
  const [editingInfos, setEditingInfos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const qc = useQueryClient();
  const { update } = useEntityMutations("troncons");

  const { data, isLoading } = useQuery({
    queryKey: ["troncon", "fiche", tronconId],
    queryFn: async () => (await api.get<Fiche>(`/troncons/${tronconId}/fiche`)).data,
    enabled: open,
  });

  // Ce que l'on sait des valeurs affichees. Requete separee : la fiche reste lisible
  // si l'appel echoue, et l'absence de qualite se traduit par une absence de badge,
  // jamais par une valeur presentee comme plus sure qu'elle ne l'est.
  const { data: qualite } = useQuery({
    queryKey: ["troncon", "qualite", tronconId],
    queryFn: async () =>
      (await api.get<{ champs: QualiteChamp[] }>(`/qualite/Troncon/${tronconId}`)).data.champs,
    enabled: open,
    retry: false,
  });

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "infos", label: "Infos" },
    { key: "ouvrages", label: "Ouvrages", count: data?.ouvrages.length },
    { key: "pointsNoirs", label: "Points noirs", count: data?.pointsNoirs.length },
    { key: "postes", label: "Péages", count: data?.postes.length },
    { key: "chantiers", label: "Chantiers", count: data?.chantiers.length },
    { key: "inspections", label: "Inspections", count: data?.inspections.length },
    { key: "documents", label: "Documents" },
  ];

  const title = data ? `${data.troncon.code} — ${data.troncon.nom}` : "Fiche tronçon";

  async function handleInfosSubmit(values: Record<string, unknown>) {
    setError(null);
    setFieldErrors({});
    try {
      await update.mutateAsync({ id: tronconId, payload: values });
      await qc.invalidateQueries({ queryKey: ["troncon", "fiche", tronconId] });
      setEditingInfos(false);
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
      setFieldErrors(parsed.fieldErrors);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {isLoading || !data ? (
        <p className="text-sm text-gray-400">Chargement...</p>
      ) : (
        <div>
          <div className="flex justify-end mb-2">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={printFiche}>
              🖨 Imprimer / PDF
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 border-b border-gray-100 mb-3">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
                  tab === t.key ? "border-gold text-navy font-medium" : "border-transparent text-gray-500 hover:text-navy"
                }`}
              >
                {t.label}
                {t.count != null && <span className="ml-1 text-xs text-gray-400">({t.count})</span>}
              </button>
            ))}
          </div>

          <div className="max-h-80 overflow-y-auto text-sm">
            {tab === "infos" &&
              (editingInfos ? (
                <EntityForm
                  fields={tronconFields}
                  defaultValues={{ ...data.troncon }}
                  onSubmit={handleInfosSubmit}
                  submitting={update.isPending}
                  serverError={error}
                  serverFieldErrors={fieldErrors}
                />
              ) : (
                <div className="space-y-1">
                  <Row label="Classe" value={data.troncon.classe} />
                  <Row label="Région" value={data.troncon.region?.nom ?? "—"} />
                  <Row
                    label="Longueur"
                    value={
                      <>
                        {data.troncon.longueurKm > 0 ? `${data.troncon.longueurKm.toFixed(2)} km` : "—"}{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "longueurKm")} />
                      </>
                    }
                  />
                  <Row
                    label="Revêtement"
                    value={
                      <>
                        {data.troncon.revetement} <QualiteBadge qualite={qualiteDe(qualite, "revetement")} />
                      </>
                    }
                  />
                  <Row label="PK" value={`${data.troncon.pkDebut} → ${data.troncon.pkFin}`} />
                  <Row
                    label="Trafic moyen (j)"
                    value={
                      <>
                        {data.troncon.traficMoyenJma ?? "—"}{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "traficMoyenJma")} />
                      </>
                    }
                  />
                  <Row
                    label="État"
                    value={
                      <>
                        <EtatBadge etat={data.troncon.etat} />{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "etat")} />
                      </>
                    }
                  />
                  {writable && (
                    <div className="flex justify-end pt-2">
                      <Button className="px-2 py-1 text-xs" onClick={() => setEditingInfos(true)}>
                        Modifier
                      </Button>
                    </div>
                  )}
                </div>
              ))}

            {tab === "ouvrages" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="ouvrages"
                title="Ouvrage"
                fields={ouvrageFields}
                items={data.ouvrages}
                renderItem={(o) => `${o.nom} (${o.type})`}
                emptyLabel="Aucun ouvrage."
                canWrite={writable}
                geolocatable
                withPhotos
              />
            )}
            {tab === "pointsNoirs" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="points-noirs"
                title="Point noir"
                fields={pointNoirFields}
                items={data.pointsNoirs}
                renderItem={(p) => `${p.description} — gravité ${p.gravite}`}
                emptyLabel="Aucun point noir."
                canWrite={writable}
                geolocatable
              />
            )}
            {tab === "postes" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="postes"
                title="Péage / Pesage"
                fields={posteFields}
                items={data.postes}
                renderItem={(p) => `${p.nom} (${p.type}) — ${p.statut}`}
                emptyLabel="Aucun poste."
                canWrite={writable}
                geolocatable
              />
            )}
            {tab === "chantiers" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="chantiers"
                title="Chantier"
                fields={chantierFields}
                items={data.chantiers}
                renderItem={(c) => `${c.intitule} — ${c.statut} (${c.avancementPct}%)`}
                emptyLabel="Aucun chantier."
                canWrite={writable}
              />
            )}
            {tab === "inspections" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="inspections"
                title="Inspection"
                fields={inspectionFields}
                items={data.inspections}
                renderItem={(i) => `${new Date(i.dateInspection).toLocaleDateString("fr-FR")} — ${i.etatObserve}${i.inspecteur ? ` (${i.inspecteur.nomComplet})` : ""}`}
                emptyLabel="Aucune inspection."
                canWrite={writable}
                withPhotos
              />
            )}
            {tab === "documents" && <TronconDocumentsTab tronconId={tronconId} canWrite={writable} />}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-navy font-medium text-right">{value}</span>
    </div>
  );
}
