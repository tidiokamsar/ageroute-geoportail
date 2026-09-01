import { useEffect } from "react";
import { CircleMarker, Polygon, Polyline, useMapEvents } from "react-leaflet";
import L from "leaflet";

export type MeasureMode = "off" | "distance" | "area";

interface MeasureLayerProps {
  mode: MeasureMode;
  points: [number, number][];
  onAddPoint: (p: [number, number]) => void;
  onResult: (result: { distanceKm: number; areaKm2: number | null }) => void;
}

// Approximation planaire locale (suffisante a l'echelle d'un troncon/chantier, pas pour
// de tres grandes superficies transfrontalieres).
function planarAreaKm2(points: [number, number][]): number {
  if (points.length < 3) return 0;
  const lat0 = points[0][0];
  const mPerDegLat = 110_540;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map(([lat, lon]) => [lon * mPerDegLon, lat * mPerDegLat]);
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

function distanceKm(points: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += L.latLng(points[i]).distanceTo(L.latLng(points[i + 1]));
  }
  return total / 1000;
}

export function MeasureLayer({ mode, points, onAddPoint, onResult }: MeasureLayerProps) {
  useMapEvents({
    click(e) {
      if (mode === "off") return;
      onAddPoint([e.latlng.lat, e.latlng.lng]);
    },
  });

  useEffect(() => {
    onResult({
      distanceKm: distanceKm(points),
      areaKm2: mode === "area" && points.length >= 3 ? planarAreaKm2(points) : null,
    });
  }, [points, mode, onResult]);

  if (points.length === 0) return null;

  return (
    <>
      {mode === "area" && points.length >= 3 ? (
        <Polygon positions={points} pathOptions={{ color: "#f5a623", weight: 2, fillOpacity: 0.15 }} />
      ) : (
        <Polyline positions={points} pathOptions={{ color: "#f5a623", weight: 3, dashArray: "4 4" }} />
      )}
      {points.map((p, i) => (
        <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: "#fff", weight: 1, fillColor: "#f5a623", fillOpacity: 1 }} />
      ))}
    </>
  );
}
