import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useConfirm } from "../hooks/useConfirm";
import { parseApiError } from "../lib/errors";

// La route /photos/:filename exige une authentification Bearer : un <img src="/api/...">
// brut ne porte pas ce header et echouerait (401) pour un vrai utilisateur. On recupere
// donc chaque photo via l'instance axios authentifiee puis on l'affiche comme blob local.
function AuthedThumbnail({ filename, onDelete, canWrite }: { filename: string; onDelete?: () => void; canWrite: boolean }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    api.get(`/photos/${filename}`, { responseType: "blob" }).then((res) => {
      url = URL.createObjectURL(res.data as Blob);
      setSrc(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [filename]);

  return (
    <div className="relative group rounded-lg overflow-hidden border border-gray-200 bg-gray-50 aspect-square">
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">…</div>
      )}
      {canWrite && onDelete && (
        <button
          onClick={onDelete}
          className="absolute top-1 right-1 bg-red-600/90 text-white rounded-full w-5 h-5 text-xs leading-none opacity-0 group-hover:opacity-100 transition"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function PhotoGallery({
  endpoint,
  entityId,
  canWrite,
}: {
  endpoint: "ouvrages" | "inspections" | "troncons";
  entityId: string;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Requete dediee (pas le `photos` du snapshot passe par la page liste) : sans ca,
  // apres un upload/suppression, la galerie resterait figee sur l'etat au moment de
  // l'ouverture du modal jusqu'a sa fermeture/reouverture.
  const { data: entity } = useQuery({
    queryKey: [endpoint, "photos", entityId],
    queryFn: async () => (await api.get<{ photos?: string[] }>(`/${endpoint}/${entityId}`)).data,
  });
  const photos = entity?.photos ?? [];

  function refresh() {
    return qc.invalidateQueries({ queryKey: [endpoint, "photos", entityId] });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      await api.post(`/${endpoint}/${entityId}/photos`, formData);
      await refresh();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(filename: string) {
    if (!(await confirm("Supprimer cette photo ?", { danger: true }))) return;
    await api.delete(`/${endpoint}/${entityId}/photos/${filename}`);
    await refresh();
  }

  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {/* capture="environment" : sur mobile, ouvre directement l'appareil photo arriere
              (saisie terrain), tout en restant un simple champ fichier sur desktop. */}
          <label className="inline-flex items-center justify-center rounded-md bg-accent text-accent-foreground shadow hover:brightness-95 px-3 py-1.5 text-sm cursor-pointer">
            <input type="file" accept="image/*" capture="environment" onChange={handleUpload} disabled={uploading} className="hidden" />
            {uploading ? "Envoi..." : "📷 Prendre une photo"}
          </label>
          <label className="inline-flex items-center justify-center rounded-md border border-gray-300 text-navy hover:bg-gray-50 px-3 py-1.5 text-sm cursor-pointer">
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUpload} disabled={uploading} className="hidden" />
            Depuis la galerie
          </label>
          {error && <p className="text-xs text-red-600 mt-1 w-full">{error}</p>}
        </div>
      )}
      {photos.length === 0 ? (
        <p className="text-sm text-gray-400">Aucune photo.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <AuthedThumbnail key={p} filename={p} canWrite={canWrite} onDelete={() => handleDelete(p)} />
          ))}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
