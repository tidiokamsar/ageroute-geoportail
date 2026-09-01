import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useEntityMutations } from "../hooks/useEntity";
import { EntityForm, type FieldConfig } from "./EntityForm";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { PhotoGallery } from "./PhotoGallery";
import { parseApiError } from "../lib/errors";

interface Props<T extends { id: string }> {
  tronconId: string;
  endpoint: string;
  title: string;
  fields: FieldConfig[];
  items: T[];
  renderItem: (item: T) => string;
  emptyLabel: string;
  canWrite: boolean;
  /** Permet de recalculer la position GPS depuis le PK + le trace du troncon (fiches sans coordonnees). */
  geolocatable?: boolean;
  /** Ouvrages/inspections seulement (champ photos en base) : ajoute un bouton "Photos" par ligne. */
  withPhotos?: boolean;
}

// Gere l'ajout/lecture/modification des entites enfants d'un troncon (ouvrages, points
// noirs, postes, chantiers, inspections) directement depuis sa fiche. Le champ "troncon"
// (TronconPicker) est retire du formulaire puisque le parent est deja fixe par le contexte ;
// le tronconId est tout de meme injecte explicitement a la soumission.
export function FicheChildManager<T extends { id: string }>({
  tronconId,
  endpoint,
  title,
  fields,
  items,
  renderItem,
  emptyLabel,
  canWrite,
  geolocatable,
  withPhotos,
}: Props<T>) {
  const qc = useQueryClient();
  const { create, update } = useEntityMutations(endpoint);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [geoError, setGeoError] = useState<string | null>(null);
  const [photosItem, setPhotosItem] = useState<T | null>(null);

  const geolocate = useMutation({
    mutationFn: (id: string) => api.post(`/${endpoint}/${id}/geolocate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["troncon", "fiche", tronconId] }),
    onError: (err) => setGeoError(parseApiError(err).message),
  });

  const formFields = fields.filter((f) => f.type !== "troncon");

  function openCreate() {
    setEditing(null);
    setError(null);
    setFieldErrors({});
    setModalOpen(true);
  }

  function openEdit(item: T) {
    setEditing(item);
    setError(null);
    setFieldErrors({});
    setModalOpen(true);
  }

  async function handleSubmit(values: Record<string, unknown>) {
    setError(null);
    setFieldErrors({});
    const payload = { ...values, tronconId };
    try {
      if (editing) await update.mutateAsync({ id: editing.id, payload });
      else await create.mutateAsync(payload);
      await qc.invalidateQueries({ queryKey: ["troncon", "fiche", tronconId] });
      setModalOpen(false);
      setEditing(null);
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
      setFieldErrors(parsed.fieldErrors);
    }
  }

  return (
    <div>
      {canWrite && (
        <div className="flex justify-end mb-2">
          <Button className="px-2 py-1 text-xs" onClick={openCreate}>
            + Ajouter
          </Button>
        </div>
      )}

      {geoError && <p className="text-xs text-red-600 mb-2">{geoError}</p>}

      {items.length === 0 ? (
        <p className="text-gray-400">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-2 border-b border-gray-50 py-1 text-gray-700">
              <span>{renderItem(it)}</span>
              {canWrite && (
                <div className="flex gap-1 shrink-0">
                  {geolocatable && (
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      disabled={geolocate.isPending}
                      onClick={() => {
                        setGeoError(null);
                        geolocate.mutate(it.id);
                      }}
                    >
                      Géolocaliser depuis le PK
                    </Button>
                  )}
                  {withPhotos && (
                    <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setPhotosItem(it)}>
                      Photos
                    </Button>
                  )}
                  <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => openEdit(it)}>
                    Modifier
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Modifier — ${title}` : `Ajouter — ${title}`}
      >
        <EntityForm
          fields={formFields}
          defaultValues={editing ?? {}}
          onSubmit={handleSubmit}
          submitting={create.isPending || update.isPending}
          serverError={error}
          serverFieldErrors={fieldErrors}
        />
      </Modal>

      {withPhotos && (
        <Modal open={!!photosItem} onClose={() => setPhotosItem(null)} title={`Photos — ${photosItem ? renderItem(photosItem) : ""}`}>
          {photosItem && (
            <PhotoGallery endpoint={endpoint as "ouvrages" | "inspections"} entityId={photosItem.id} canWrite={canWrite} />
          )}
        </Modal>
      )}
    </div>
  );
}
