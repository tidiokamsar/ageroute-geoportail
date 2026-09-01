import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from "react-leaflet";
import { canvas } from "leaflet";
import { LogIn, Eye, AlertTriangle, X, Route, HardHat } from "lucide-react";
import axios from "axios";
import { ETAT_COLORS, ETAT_LABELS, CHANTIER_COLORS } from "./geoportail/types";
import type { EtatPatrimoine, StatutChantier } from "../types";

const GUINEE_CENTER: [number, number] = [10.5, -10.8];

const STATUT_LABELS: Record<StatutChantier, string> = {
  PLANIFIE: "Planifié",
  EN_COURS: "En cours",
  SUSPENDU: "Suspendu",
  TERMINE: "Terminé",
};

// Formes reduites renvoyees par /api/public/carte/geo : volontairement plus pauvres
// que les types authentifies de ./geoportail/types (ni entreprise, ni bailleur, ni
// montant, ni PK, ni trafic). Les redeclarer ici evite de laisser croire que la vue
// publique dispose des memes champs que le geoportail complet.
interface PublicTroncon {
  id: string; code: string; nom: string; classe: string; etat: EtatPatrimoine;
  longueurKm: number; region: string | null; geometry: string | null;
}
interface PublicPointNoir { id: string; gravite: string; region: string | null; lat: number; lon: number }
interface PublicChantier {
  id: string; statut: StatutChantier; avancementPct: number; region: string | null;
  geometry: string | null; approximate: boolean; lat: number | null; lon: number | null;
}
interface PublicCarteData {
  troncons: PublicTroncon[];
  pointsNoirs: PublicPointNoir[];
  chantiers: PublicChantier[];
}

function geoJsonToLatLngs(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

type SelectedFeature =
  | { kind: "troncon"; data: PublicTroncon }
  | { kind: "chantier"; data: PublicChantier }
  | { kind: "pointNoir"; data: PublicPointNoir };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-gray-100 py-2 last:border-b-0">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-navy">{children}</dd>
    </div>
  );
}

/**
 * Fiche de consultation ouverte au clic sur un element de la carte. Strictement en
 * lecture : elle n'affiche que les champs renvoyes par /api/public/carte/geo, qui
 * sont volontairement reduits. Tout le reste (entreprise, bailleur, montant,
 * contrat, PK, trafic, inspections) reste derriere l'authentification.
 */
function DetailModal({ feature, onClose }: { feature: SelectedFeature; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const titres = {
    troncon: { icone: <Route className="h-4 w-4" />, titre: "Tronçon routier" },
    chantier: { icone: <HardHat className="h-4 w-4" />, titre: "Chantier" },
    pointNoir: { icone: <AlertTriangle className="h-4 w-4" />, titre: "Point noir" },
  }[feature.kind];

  return (
    <div
      className="absolute inset-0 z-[1200] flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titres.titre}
        className="w-full max-w-sm overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 bg-navy px-4 py-3 text-white">
          {titres.icone}
          <h2 className="flex-1 text-sm font-bold">{titres.titre}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            autoFocus
            className="rounded p-1 transition hover:bg-white/15"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="px-4 py-2">
          {feature.kind === "troncon" && (
            <>
              <Field label="Code">{feature.data.code}</Field>
              <Field label="Nom">{feature.data.nom}</Field>
              <Field label="Classe">{feature.data.classe}</Field>
              <Field label="État">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: ETAT_COLORS[feature.data.etat] ?? "#9ca3af" }}
                  />
                  {ETAT_LABELS[feature.data.etat] ?? feature.data.etat}
                </span>
              </Field>
              <Field label="Longueur">{feature.data.longueurKm} km</Field>
              <Field label="Région">{feature.data.region ?? "Non renseignée"}</Field>
            </>
          )}

          {feature.kind === "chantier" && (
            <>
              <Field label="Statut">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: CHANTIER_COLORS[feature.data.statut] }}
                  />
                  {STATUT_LABELS[feature.data.statut] ?? feature.data.statut}
                </span>
              </Field>
              <Field label="Avancement">
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-200">
                    <span
                      className="block h-full rounded-full bg-navy"
                      style={{ width: `${Math.min(100, Math.max(0, feature.data.avancementPct))}%` }}
                    />
                  </span>
                  {feature.data.avancementPct} %
                </span>
              </Field>
              <Field label="Région">{feature.data.region ?? "Non renseignée"}</Field>
              {feature.data.approximate && (
                <Field label="Localisation">
                  <span className="text-xs italic text-gray-500">Approximative (centre de région)</span>
                </Field>
              )}
            </>
          )}

          {feature.kind === "pointNoir" && (
            <>
              <Field label="Gravité">{feature.data.gravite}</Field>
              <Field label="Région">{feature.data.region ?? "Non renseignée"}</Field>
              <Field label="Coordonnées">
                {feature.data.lat.toFixed(5)}, {feature.data.lon.toFixed(5)}
              </Field>
            </>
          )}
        </dl>

        <p className="border-t border-gray-100 bg-gray-50 px-4 py-2.5 text-xs leading-snug text-gray-500">
          Consultation publique. Connectez-vous pour la fiche complète et l'historique.
        </p>
      </div>
    </div>
  );
}

function LegendSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span
      className="inline-block h-0 w-5 shrink-0 rounded"
      style={{
        borderTopWidth: 3,
        borderTopStyle: dashed ? "dashed" : "solid",
        borderTopColor: color,
      }}
    />
  );
}

/**
 * Vue PUBLIQUE du geoportail : consultation seule, sans authentification, servie a
 * la racine du domaine pour tout visiteur non connecte. Ne montre que la carte —
 * aucun autre module de la Console BDRI n'est accessible ni meme visible ici.
 *
 * Lit /api/public/carte/geo (3 couches, champs reduits, 60 req/min). Toute action
 * — edition, fiches detaillees, mesures, exports, autres modules — passe par
 * "Se connecter" et le compte existant de l'utilisateur.
 */
export function PublicCartePage() {
  const [showTroncons, setShowTroncons] = useState(true);
  const [showChantiers, setShowChantiers] = useState(true);
  const [showPointsNoirs, setShowPointsNoirs] = useState(true);
  const [selected, setSelected] = useState<SelectedFeature | null>(null);

  // Rendu canvas plutot que SVG, pour deux raisons : les tronces font 3 px de large,
  // donc quasi impossibles a viser au doigt ou a la souris — seul le renderer canvas
  // offre une tolerance de clic ; et la carte compte plus de 2000 geometries, que le
  // canvas dessine bien plus vite que 2000 noeuds SVG.
  const renderer = useMemo(() => canvas({ tolerance: 10 }), []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["public", "carte", "geo"],
    queryFn: async () => (await axios.get<PublicCarteData>("/api/public/carte/geo")).data,
    staleTime: 5 * 60 * 1000,
  });

  const tronconLines = useMemo(
    () =>
      (data?.troncons ?? [])
        .map((t) => ({ t, positions: geoJsonToLatLngs(t.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data]
  );
  const chantierLines = useMemo(
    () =>
      (data?.chantiers ?? [])
        .filter((c) => !c.approximate)
        .map((c) => ({ c, positions: geoJsonToLatLngs(c.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data]
  );
  const chantierPoints = useMemo(
    () => (data?.chantiers ?? []).filter((c) => c.approximate && c.lat != null && c.lon != null),
    [data]
  );

  // Etats effectivement presents : evite une legende qui annonce des couleurs
  // absentes de la carte.
  const etatsPresents = useMemo(() => {
    const set = new Set<EtatPatrimoine>();
    for (const { t } of tronconLines) set.add(t.etat);
    return (Object.keys(ETAT_COLORS) as EtatPatrimoine[]).filter((e) => set.has(e));
  }, [tronconLines]);

  return (
    <div className="fixed inset-0 flex flex-col">
      <header className="z-[1000] flex items-center gap-3 border-b border-navy/20 bg-navy px-4 py-2.5 text-white shadow-sm">
        <img src="/ageroute-logo.svg" alt="AGEROUTE Guinée" className="h-8 w-auto shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold leading-tight">Géoportail routier — AGEROUTE Guinée</h1>
          <p className="flex items-center gap-1.5 truncate text-xs leading-tight text-white/60">
            <Eye className="h-3 w-3 shrink-0" />
            Consultation publique du réseau routier national
          </p>
        </div>
        <Link
          to="/login"
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-gold px-3 py-2 text-sm font-medium text-navy transition hover:brightness-95"
        >
          <LogIn className="h-4 w-4" />
          Se connecter
        </Link>
      </header>

      <div className="relative flex-1">
        <MapContainer center={GUINEE_CENTER} zoom={7} renderer={renderer} style={{ height: "100%", width: "100%" }}>
          {/* Tuiles OpenStreetMap et non le fond CARTO "clair" du geoportail interne :
              basemaps.cartocdn.com renvoie desormais une tuile "API KEY REQUIRED"
              sans cle. Cette page etant ouverte a tous, elle ne peut pas dependre
              d'un service a cle. */}
          <TileLayer
            attribution='&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            crossOrigin="anonymous"
          />

          {showTroncons &&
            tronconLines.map(({ t, positions }) => (
              <Polyline
                key={t.id}
                positions={positions}
                pathOptions={{ color: ETAT_COLORS[t.etat] ?? "#9ca3af", weight: 3 }}
                eventHandlers={{ click: () => setSelected({ kind: "troncon", data: t }) }}
              >
                <Tooltip sticky>
                  <span className="font-semibold">{t.code}</span> — {t.nom}
                  <br />
                  {t.classe} · {t.longueurKm} km{t.region ? ` · ${t.region}` : ""}
                  <br />
                  État : {ETAT_LABELS[t.etat] ?? t.etat}
                </Tooltip>
              </Polyline>
            ))}

          {showChantiers &&
            chantierLines.map(({ c, positions }) => (
              <Polyline
                key={c.id}
                positions={positions}
                pathOptions={{ color: CHANTIER_COLORS[c.statut], weight: 5, dashArray: "5 5" }}
                eventHandlers={{ click: () => setSelected({ kind: "chantier", data: c }) }}
              >
                <Tooltip sticky>
                  Chantier — {STATUT_LABELS[c.statut] ?? c.statut} ({c.avancementPct} %)
                  {c.region ? <><br />{c.region}</> : null}
                </Tooltip>
              </Polyline>
            ))}

          {showChantiers &&
            chantierPoints.map((c) => (
              <CircleMarker
                key={c.id}
                center={[c.lat as number, c.lon as number]}
                radius={6}
                pathOptions={{ color: "#fff", weight: 1, fillColor: CHANTIER_COLORS[c.statut], fillOpacity: 0.9 }}
                eventHandlers={{ click: () => setSelected({ kind: "chantier", data: c }) }}
              >
                <Tooltip>
                  Chantier — {STATUT_LABELS[c.statut] ?? c.statut} ({c.avancementPct} %)
                  <br />
                  <span className="italic">Localisation approximative</span>
                </Tooltip>
              </CircleMarker>
            ))}

          {showPointsNoirs &&
            (data?.pointsNoirs ?? []).map((p) => (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lon]}
                radius={5}
                pathOptions={{ color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: 0.9 }}
                eventHandlers={{ click: () => setSelected({ kind: "pointNoir", data: p }) }}
              >
                <Tooltip>
                  Point noir — gravité {p.gravite}
                  {p.region ? <><br />{p.region}</> : null}
                </Tooltip>
              </CircleMarker>
            ))}
        </MapContainer>

        {isLoading && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center">
            <div className="rounded-full bg-white/95 px-4 py-1.5 text-xs text-navy shadow">
              Chargement du réseau…
            </div>
          </div>
        )}

        {isError && (
          <div className="absolute inset-x-0 top-3 z-[1000] flex justify-center px-4">
            <div className="flex items-center gap-2 rounded-md bg-red-50 px-4 py-2 text-xs text-red-700 shadow ring-1 ring-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Les données cartographiques sont momentanément indisponibles.
            </div>
          </div>
        )}

        <div className="absolute bottom-6 left-3 z-[1000] max-h-[70%] w-56 overflow-y-auto rounded-lg bg-white/95 p-3 text-xs shadow-lg ring-1 ring-black/5">
          <p className="mb-2 font-bold text-navy">Légende</p>

          <label className="flex cursor-pointer items-center gap-2 font-medium text-navy">
            <input type="checkbox" checked={showTroncons} onChange={(e) => setShowTroncons(e.target.checked)} />
            Tronçons routiers
          </label>
          {showTroncons && (
            <ul className="mb-2 mt-1 space-y-1 pl-6 text-gray-600">
              {etatsPresents.map((etat) => (
                <li key={etat} className="flex items-center gap-2">
                  <LegendSwatch color={ETAT_COLORS[etat]} />
                  <span className="truncate">{ETAT_LABELS[etat]}</span>
                </li>
              ))}
            </ul>
          )}

          <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium text-navy">
            <input type="checkbox" checked={showChantiers} onChange={(e) => setShowChantiers(e.target.checked)} />
            Chantiers
          </label>
          {showChantiers && (
            <ul className="mb-2 mt-1 space-y-1 pl-6 text-gray-600">
              {(Object.keys(CHANTIER_COLORS) as StatutChantier[]).map((statut) => (
                <li key={statut} className="flex items-center gap-2">
                  <LegendSwatch color={CHANTIER_COLORS[statut]} dashed />
                  <span>{STATUT_LABELS[statut]}</span>
                </li>
              ))}
            </ul>
          )}

          <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium text-navy">
            <input type="checkbox" checked={showPointsNoirs} onChange={(e) => setShowPointsNoirs(e.target.checked)} />
            Points noirs
          </label>

          <p className="mt-3 border-t border-gray-200 pt-2 leading-snug text-gray-500">
            Cliquez un élément de la carte pour l'afficher. Vue publique en lecture
            seule : connectez-vous pour les fiches complètes et les autres modules.
          </p>
        </div>

        {selected && <DetailModal feature={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
