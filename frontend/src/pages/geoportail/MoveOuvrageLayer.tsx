import { useRef, useState } from "react";
import { Marker, Tooltip } from "react-leaflet";
import L from "leaflet";
import { toast } from "../../lib/toast";
import { parseApiError } from "../../lib/errors";
import { useEntityMutations } from "../../hooks/useEntity";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui/Button";

/**
 * D9 — repositionnement terrain d'un ouvrage.
 *
 * Décision validée : l'inventaire des ouvrages sera reconstitué par une mission
 * de terrain. En attendant, ce composant permet DEJA, depuis le géoportail, de
 * corriger une position héritée (2016, interpolée ou repère régional arrondi) :
 * glisser le marqueur à l'endroit exact vu sur l'imagerie, enregistrer.
 * L'écriture passe par PUT /ouvrages/:id (lat/lon) — mise à jour auditée,
 * même mécanisme que le reste du module.
 */
export function MoveOuvrageLayer({
  ouvrage, onTerminer,
}: {
  ouvrage: { id: string; nom: string; lat: number; lon: number };
  onTerminer: () => void;
}) {
  const qc = useQueryClient();
  const { update } = useEntityMutations("ouvrages");
  const positionRef = useRef<L.LatLng>(L.latLng(ouvrage.lat, ouvrage.lon));
  const [, forceRendu] = useState(0);
  const [enregistre, setEnregistre] = useState(false);

  function sauvegarder() {
    const pos = positionRef.current;
    update.mutateAsync(
      { id: ouvrage.id, payload: { lat: pos.lat, lon: pos.lng } },
      {
        onSuccess: async () => {
          await qc.invalidateQueries({ queryKey: ["ouvrages", "geo"] });
          toast.success(`Position de « ${ouvrage.nom} » mise à jour.`);
          setEnregistre(true);
          onTerminer();
        },
        onError: (err) => toast.error(parseApiError(err).message),
      }
    );
  }

  return (
    <>
      <Marker
        position={positionRef.current}
        draggable
        autoPan
        zIndexOffset={1000}
        eventHandlers={{
          dragend: (e) => {
            positionRef.current = (e.target as L.Marker).getLatLng();
            forceRendu((n) => n + 1);
          },
        }}
      >
        <Tooltip permanent direction="top" offset={[0, -8]}>
          Glissez-moi sur la position réelle — {ouvrage.nom}
        </Tooltip>
      </Marker>

      {/* Barre d'action flottante, au-dessus de la carte */}
      <div className="leaflet-top leaflet-right" style={{ zIndex: 1100, pointerEvents: "none" }}>
        <div className="leaflet-control leaflet-bar" style={{ pointerEvents: "auto", background: "#fff", padding: "10px 12px", borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,.25)", marginTop: 10, marginRight: 10, maxWidth: 300 }}>
          <p className="text-xs font-semibold text-navy">Déplacement — {ouvrage.nom}</p>
          <p className="text-[11px] text-gray-500 mt-1">
            Position actuelle : {positionRef.current.lat.toFixed(5)}, {positionRef.current.lng.toFixed(5)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">
            {enregistre
              ? "Enregistré ✓ — l'écriture est journalisée (audit)."
              : "Glissez le marqueur à l'endroit exact vu sur l'imagerie, puis enregistrez."}
          </p>
          <div className="flex gap-2 mt-2">
            <Button size="sm" onClick={sauvegarder} disabled={update.isPending}>
              {update.isPending ? "Enregistrement…" : "Enregistrer ici"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onTerminer}>Annuler</Button>
          </div>
        </div>
      </div>
    </>
  );
}
