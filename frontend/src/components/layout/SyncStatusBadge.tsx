import { CloudOff, RefreshCw, CloudUpload } from "lucide-react";
import { useOfflineSync } from "../../hooks/useOfflineSync";

export function SyncStatusBadge() {
  const { pendingCount, conflitCount = 0, syncing, online, syncNow } = useOfflineSync();
  // Un conflit n'est pas une panne : il attend un responsable. Le dire dans le badge, partout dans l'application.
  const mentionConflit = conflitCount > 0 ? ` · dont ${conflitCount} en conflit` : "";

  if (!online) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-700 px-2.5 py-1 text-xs font-medium">
        <CloudOff className="h-3.5 w-3.5" />
        Hors-ligne{pendingCount > 0 && ` · ${pendingCount} en attente${mentionConflit}`}
      </span>
    );
  }

  if (pendingCount === 0 && !syncing) return null;

  return (
    <button
      onClick={() => syncNow()}
      disabled={syncing}
      className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 text-blue-700 px-2.5 py-1 text-xs font-medium hover:bg-blue-200 transition-colors disabled:opacity-70"
      title="Synchroniser les saisies terrain en attente"
    >
      {syncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CloudUpload className="h-3.5 w-3.5" />}
      {syncing ? "Synchronisation…" : `${pendingCount} à synchroniser${mentionConflit}`}
    </button>
  );
}
