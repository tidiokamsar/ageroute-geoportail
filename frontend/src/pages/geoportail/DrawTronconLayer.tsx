import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CircleMarker, Marker, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { TronconGeoFeature } from "./types";

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function totalKm(pts: [number, number][]): number {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += haversineKm(pts[i], pts[i + 1]);
  return d;
}

function extractSnapPoints(troncons: TronconGeoFeature[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of troncons) {
    try {
      const g = JSON.parse(t.geometry) as { type: string; coordinates: number[][] };
      if (g.type === "LineString" && g.coordinates.length >= 2) {
        const f = g.coordinates[0];
        const l = g.coordinates[g.coordinates.length - 1];
        out.push([f[1], f[0]], [l[1], l[0]]);
      }
    } catch { /* ignore bad geom */ }
  }
  return out;
}

// ── Draggable vertex ──────────────────────────────────────────────────────────

const VERTEX_ICON = L.divIcon({
  className: "",
  html: `<div style="
    width:12px;height:12px;
    background:#ef4444;border:2px solid white;
    border-radius:50%;cursor:grab;
    transform:translate(-6px,-6px);
    box-shadow:0 0 0 2px rgba(239,68,68,.35)
  "></div>`,
  iconSize: [0, 0],
  iconAnchor: [0, 0],
});

function DraggableVertex({
  position,
  onDragEnd,
  onDelete,
}: {
  position: [number, number];
  onDragEnd: (p: [number, number]) => void;
  onDelete: () => void;
}) {
  const ref = useRef<L.Marker>(null);
  return (
    <Marker
      position={position}
      icon={VERTEX_ICON}
      draggable
      ref={ref}
      eventHandlers={{
        dragend() {
          const m = ref.current;
          if (m) {
            const ll = m.getLatLng();
            onDragEnd([ll.lat, ll.lng]);
          }
        },
        contextmenu(e) {
          e.originalEvent.preventDefault();
          onDelete();
        },
      }}
    />
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DrawHandle {
  finish: () => void;
  cancel: () => void;
  getLengthKm: () => number;
  getVertexCount: () => number;
}

export type DrawPhase = "drawing" | "editing";

interface DrawTronconLayerProps {
  troncons: TronconGeoFeature[];
  onComplete: (points: [number, number][], lengthKm: number) => void;
  onCancel: () => void;
  onPhaseChange: (phase: DrawPhase) => void;
  onLengthChange: (km: number) => void;
}

export const DrawTronconLayer = forwardRef<DrawHandle, DrawTronconLayerProps>(
  function DrawTronconLayer({ troncons, onComplete, onCancel, onPhaseChange, onLengthChange }, ref) {
    const map = useMap();
    const [phase, setPhase] = useState<DrawPhase>("drawing");
    const [vertices, setVertices] = useState<[number, number][]>([]);
    const [cursor, setCursor] = useState<[number, number] | null>(null);
    const [snapPt, setSnapPt] = useState<[number, number] | null>(null);
    const snapPtsRef = useRef<[number, number][]>([]);
    // Ref to latest vertices for use inside event handlers without stale closure
    const verticesRef = useRef<[number, number][]>([]);
    verticesRef.current = vertices;

    useEffect(() => { snapPtsRef.current = extractSnapPoints(troncons); }, [troncons]);

    // Crosshair cursor in draw mode
    useEffect(() => {
      const c = map.getContainer();
      c.style.cursor = phase === "drawing" ? "crosshair" : "default";
      return () => { c.style.cursor = ""; };
    }, [map, phase]);

    // Notify parent of phase & length changes
    useEffect(() => { onPhaseChange(phase); }, [phase, onPhaseChange]);
    useEffect(() => { onLengthChange(totalKm(vertices)); }, [vertices, onLengthChange]);

    const findSnap = useCallback((latlng: L.LatLng): [number, number] | null => {
      const screenPt = map.latLngToLayerPoint(latlng);
      let best: [number, number] | null = null;
      let minD = 20; // pixels
      for (const sp of snapPtsRef.current) {
        const d = screenPt.distanceTo(map.latLngToLayerPoint(L.latLng(sp[0], sp[1])));
        if (d < minD) { minD = d; best = sp; }
      }
      return best;
    }, [map]);

    useImperativeHandle(ref, () => ({
      finish() {
        const v = verticesRef.current;
        if (v.length >= 2) onComplete(v, totalKm(v));
      },
      cancel() {
        setVertices([]);
        setCursor(null);
        setPhase("drawing");
        onCancel();
      },
      getLengthKm() { return totalKm(verticesRef.current); },
      getVertexCount() { return verticesRef.current.length; },
    }), [onComplete, onCancel]);

    useMapEvents({
      mousemove(e) {
        if (phase !== "drawing") return;
        const snap = findSnap(e.latlng);
        setSnapPt(snap);
        setCursor(snap ?? [e.latlng.lat, e.latlng.lng]);
      },
      click(e) {
        if (phase !== "drawing") return;
        const snap = findSnap(e.latlng);
        const pt: [number, number] = snap ?? [e.latlng.lat, e.latlng.lng];
        setVertices((v) => [...v, pt]);
      },
      dblclick(e) {
        if (phase !== "drawing") return;
        e.originalEvent.preventDefault();
        // dblclick fires click once before it: remove that last duplicate vertex
        setVertices((v) => {
          const trimmed = v.length >= 1 ? v.slice(0, -1) : v;
          if (trimmed.length >= 2) {
            setPhase("editing");
          }
          return trimmed;
        });
      },
    });

    const previewLine = useMemo<[number, number][]>(
      () => (cursor && vertices.length > 0 ? [...vertices, cursor] : vertices),
      [vertices, cursor]
    );

    return (
      <>
        {/* Live preview line */}
        {previewLine.length >= 2 && (
          <Polyline
            positions={previewLine}
            pathOptions={{ color: "#ef4444", weight: 3, dashArray: phase === "drawing" ? "6 4" : undefined }}
          />
        )}

        {/* Snap target indicator */}
        {snapPt && phase === "drawing" && (
          <CircleMarker
            center={snapPt}
            radius={9}
            pathOptions={{ color: "#f5a623", weight: 2.5, fillOpacity: 0, opacity: 0.9 }}
          />
        )}

        {/* Drawing phase: fixed vertex dots */}
        {phase === "drawing" &&
          vertices.map((v, i) => (
            <CircleMarker
              key={i}
              center={v}
              radius={5}
              pathOptions={{ color: "#fff", weight: 2, fillColor: "#ef4444", fillOpacity: 1 }}
            />
          ))}

        {/* Editing phase: draggable vertices */}
        {phase === "editing" &&
          vertices.map((v, i) => (
            <DraggableVertex
              key={`ev-${i}`}
              position={v}
              onDragEnd={(newPos) =>
                setVertices((vs) => vs.map((pt, idx) => (idx === i ? newPos : pt)))
              }
              onDelete={() => setVertices((vs) => vs.filter((_, idx) => idx !== i))}
            />
          ))}
      </>
    );
  }
);
