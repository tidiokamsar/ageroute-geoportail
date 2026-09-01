import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";

const GUINEE_CENTER: [number, number] = [10.5, -10.8];

function ClickHandler({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export function MapPointPicker({
  lat,
  lon,
  onChange,
}: {
  lat: number | null | undefined;
  lon: number | null | undefined;
  onChange: (lat: number, lon: number) => void;
}) {
  const center: [number, number] = lat != null && lon != null ? [lat, lon] : GUINEE_CENTER;

  return (
    <div className="rounded-lg overflow-hidden border border-gray-300" style={{ height: 220 }}>
      <MapContainer center={center} zoom={lat != null ? 13 : 7} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution="&copy; OpenStreetMap, &copy; CARTO"
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <ClickHandler onPick={onChange} />
        {lat != null && lon != null && <Marker position={[lat, lon]} />}
      </MapContainer>
    </div>
  );
}
