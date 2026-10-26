import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
// Feuille de style de Leaflet servie par l'application elle-meme (precachee par le service worker) : plus de CDN tiers, la carte garde sa mise en forme hors ligne.
import "leaflet/dist/leaflet.css";
import { Icon } from "leaflet";
import marqueur from "leaflet/dist/images/marker-icon.png";
import marqueur2x from "leaflet/dist/images/marker-icon-2x.png";
import ombre from "leaflet/dist/images/marker-shadow.png";

/**
 * Icone du marqueur, donnee EXPLICITEMENT. Le marqueur par defaut de Leaflet devine son dossier d'images en lisant l'URL de
 * `.leaflet-default-icon-path` dans la feuille de style ; une fois la feuille empaquetee par Vite, cette URL est une donnee
 * integree (`data:`) et la devinette echoue (marqueur invisible). Les valeurs sont celles de `L.Icon.Default`.
 */
const ICONE_POINT = new Icon({
  iconUrl: marqueur, iconRetinaUrl: marqueur2x, shadowUrl: ombre,
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], tooltipAnchor: [16, -28], shadowSize: [41, 41],
});

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
        {lat != null && lon != null && <Marker position={[lat, lon]} icon={ICONE_POINT} />}
      </MapContainer>
    </div>
  );
}
