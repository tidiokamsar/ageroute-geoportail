import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Modal } from "./ui/Modal";

interface AuditEntry {
  id: string;
  action: string;
  auteur: string;
  createdAt: string;
}

const ACTION_LABELS: Record<string, { label: string; cls: string }> = {
  CREATE: { label: "Création", cls: "text-green-700 bg-green-100" },
  UPDATE: { label: "Modification", cls: "text-blue-700 bg-blue-100" },
  DELETE: { label: "Archivage", cls: "text-red-700 bg-red-100" },
  RESTORE: { label: "Restauration", cls: "text-green-700 bg-green-100" },
  LOGIN: { label: "Connexion", cls: "text-gray-600 bg-gray-100" },
  LOGIN_FAILED: { label: "Échec connexion", cls: "text-orange-700 bg-orange-100" },
};

export function AuditHistoryModal({
  open,
  onClose,
  entityType,
  entityId,
  title,
}: {
  open: boolean;
  onClose: () => void;
  entityType: string;
  entityId: string;
  title: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["audit", entityType, entityId],
    queryFn: async () =>
      (await api.get<{ data: AuditEntry[] }>("/audit", { params: { entityType, entityId, pageSize: 50 } })).data,
    enabled: open,
  });

  return (
    <Modal open={open} onClose={onClose} title={`Historique — ${title}`}>
      {isLoading ? (
        <p className="text-sm text-gray-400">Chargement...</p>
      ) : !data?.data.length ? (
        <p className="text-sm text-gray-400">Aucune opération enregistrée.</p>
      ) : (
        <ul className="space-y-2 max-h-96 overflow-y-auto">
          {data.data.map((e) => {
            const a = ACTION_LABELS[e.action] ?? { label: e.action, cls: "text-gray-600 bg-gray-100" };
            return (
              <li key={e.id} className="flex items-center justify-between gap-3 text-sm border-b border-gray-100 pb-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${a.cls}`}>{a.label}</span>
                  <span className="text-gray-700">{e.auteur}</span>
                </div>
                <span className="text-xs text-gray-400">{new Date(e.createdAt).toLocaleString("fr-FR")}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
