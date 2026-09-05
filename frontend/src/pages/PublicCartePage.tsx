import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, GeoJSON, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { canvas, divIcon, latLngBounds, type LatLngBounds, type Map as CarteLeaflet } from "leaflet";
import { LogIn, AlertTriangle, LocateFixed, Loader2, Plus, Minus, MapPin, X } from "lucide-react";
import axios from "axios";
import { ETAT_COLORS, ETAT_LABELS, CHANTIER_COLORS, CREDIT_DONNEES } from "./geoportail/types";
import { ouvrageIcon, TYPE_OUVRAGE_LABEL } from "./geoportail/symbols";
import { RechercheVille } from "../components/RechercheVille";
import { tronconDansFiltre, filtrerParRoute, filtrerParVille, type FiltreVille } from "../lib/villes";
import { Ecusson, ecussonHtml } from "./public/Ecusson";
import { FicheElement } from "./public/FicheElement";
import { PanneauInfos, type CoucheKey } from "./public/PanneauInfos";
import { calculerStats, type StatsReseau } from "./public/stats";
import { RechercheRoute, type RouteIndexee } from "./public/RechercheRoute";
import { VoirieLocaleLayer, type CategorieVoirie } from "./geoportail/VoirieLocaleLayer";
import { geoJsonToLatLngs, STATUT_LABELS, type PublicCarteData, type SelectedFeature } from "./public/types";
import type { EtatPatrimoine } from "../types";
import type { FeatureCollection } from "geojson";

/**
 * Emprise de la Guinee, et non un centre avec un zoom fixe.
 *
 * LE DEFAUT
 *
 * La carte s'ouvrait sur `center=[10.5, -10.8] zoom=7`, identique quelle que soit la
 * largeur d'ecran. Or au zoom 7, la longitude visible depend de cette largeur :
 *
 *     telephone  375 px   4,12 deg   de -12,86 a  -8,74   Conakry HORS ECRAN
 *     telephone  414 px   4,55 deg   de -13,07 a  -8,53   Conakry HORS ECRAN
 *     tablette   768 px   8,44 deg   de -15,02 a  -6,58   visible
 *     ecran     1280 px  14,06 deg   de -17,83 a  -3,77   visible, avec marge
 *
 * La Guinee fait 7,44 deg de large ; un telephone n'en montre que 4,12. Conakry est a
 * -13,58. Autrement dit, tout visiteur ouvrant la carte routiere nationale depuis un
 * telephone tombait sur le centre et l'est du pays, la capitale hors cadre, et devait
 * faire glisser la carte pour la trouver — alors que 246 des 479 chantiers y sont.
 *
 * LA CORRECTION
 *
 * Cadrer sur l'emprise plutot que sur un zoom : Leaflet calcule alors le zoom qui fait
 * tenir le pays dans le viewport dont il dispose. Le cadrage s'adapte de lui-meme au
 * telephone comme au poste de bureau, et restera juste sur les formats a venir.
 *
 * Le centre fixe disparait : plus personne ne s'en sert une fois l'emprise posee.
 */

/** Sud-ouest et nord-est du territoire national. */
const GUINEE_BOUNDS: [[number, number], [number, number]] = [
  [7.19, -15.08],
  [12.68, -7.64],
];

/**
 * Marge autour de l'emprise.
 *
 * Elle n'est pas decorative : les surcouches mangent 18 % de la hauteur en haut
 * (bandeau et recherches) et 12 % en bas (panneau de statistiques) sur un telephone.
 * Sans marge, les frontieres nord et sud passeraient sous ces panneaux.
 */
const GUINEE_BOUNDS_OPTIONS = { padding: [24, 24] as [number, number], maxZoom: 9 };

/**
 * Paliers de zoom au quart, et non a l'unite.
 *
 * Leaflet n'accepte par defaut que des zooms entiers. Pour faire tenir la Guinee sur un
 * telephone il choisit donc 5, alors que 5,95 suffirait : le pays n'occupe plus qu'un
 * tiers du cadre, entoure de Mauritanie, du Mali et de la Cote d'Ivoire. Un cadrage
 * juste mais lache reste un mauvais cadrage sur une carte routiere NATIONALE.
 *
 * Au quart de palier, l'ajustement retient 5,75 : le pays remplit le cadre sans qu'un
 * bord soit coupe. Le cout est que les tuiles sont mises a l'echelle entre deux niveaux,
 * donc tres legerement adoucies — compromis largement favorable ici.
 */
const PAS_DE_ZOOM = 0.25;

// En dessous de ce zoom, la Guinee entiere tient a l'ecran : etiqueter 1690 troncons
// y donnerait une bouillie illisible. Au dela, on n'etiquette que ce qui est dans la
// vue, et la grille ci-dessous repartit les etiquettes restantes.
const ZOOM_MIN_ETIQUETTES = 9;
const ETIQUETTES_COLS = 6;
const ETIQUETTES_ROWS = 5;

/** Remonte zoom et emprise a chaque deplacement, pour n'etiqueter que le visible. */
function SuiviVue({ onChange }: { onChange: (v: { zoom: number; bounds: LatLngBounds }) => void }) {
  const map = useMapEvents({
    zoomend: () => onChange({ zoom: map.getZoom(), bounds: map.getBounds() }),
    moveend: () => onChange({ zoom: map.getZoom(), bounds: map.getBounds() }),
  });
  // Sans cette amorce, la vue reste inconnue tant que l'utilisateur n'a rien bouge,
  // et rien ne peut dependre du zoom au premier rendu.
  useEffect(() => {
    onChange({ zoom: map.getZoom(), bounds: map.getBounds() });
  }, [map, onChange]);
  return null;
}

/** Expose l'instance Leaflet au parent, pour recentrer depuis la recherche. */
function CaptureCarte({ onReady }: { onReady: (m: CarteLeaflet) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

/**
 * Vue PUBLIQUE du geoportail : consultation seule, sans authentification, servie a
 * la racine du domaine pour tout visiteur non connecte. Ne montre que la carte —
 * aucun autre module de la Console BDRI n'est accessible ni meme visible ici.
 *
 * Lit /api/public/carte/geo (3 couches, champs reduits, 60 req/min). Toute action
 * — edition, fiches detaillees, mesures, exports, autres modules — passe par
 * "Se connecter" et le compte existant de l'utilisateur.
 *
 * Concue pour un telephone d'abord : c'est de la que le public consulte un service
 * comme celui-ci, souvent en itinerance et sur un reseau lent.
 */
export function PublicCartePage() {
  const [couches, setCouches] = useState<Record<CoucheKey, boolean>>({
    troncons: true,
    // Decochee au demarrage. Un visiteur vient d'abord voir l'etat des routes ; les
    // chantiers se superposent au reseau et le masquent avant qu'on ait rien demande.
    chantiers: false,
    pointsNoirs: true,
    ouvrages: false,
    pontsOsm: false,
    // Cochee par defaut depuis la promotion : la vue d'ensemble ne transporte plus
    // les troncons issus de la voirie (132 Mo), et cette couche est le seul endroit
    // ou ils s'affichent. La laisser decochee rendrait le registre invisible.
    // Elle ne coute rien tant qu'on n'a pas zoome : rien ne part sous le zoom 12.
    voirie: true,
    noms: true,
  });
  // Voirie locale : traces charges par emprise au-dela du zoom 12. Seules les voies
  // carrossables par defaut — les chemins et sentiers font les deux tiers du volume.
  const [etatVoirie, setEtatVoirie] = useState({ zoomSuffisant: false, voies: 0, promues: 0, chargement: false });
  const categoriesVoirie = useMemo(
    () => new Set<CategorieVoirie>(["VOIE_LOCALE", "RESIDENTIELLE", "ACCES"]),
    []
  );
  const [etatsMasques, setEtatsMasques] = useState<Set<EtatPatrimoine>>(new Set());
  // Filtre par type de route. Il devient decisif depuis que le registre melange des
  // routes nationales et des rues de quartier promues : sans lui, un lecteur qui
  // cherche le reseau structurant le lit au milieu de centaines de dessertes.
  const [classesMasquees, setClassesMasquees] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  const [vue, setVue] = useState<{ zoom: number; bounds: LatLngBounds } | null>(null);
  const [maPosition, setMaPosition] = useState<[number, number] | null>(null);
  const [localisationEnCours, setLocalisationEnCours] = useState(false);
  const [erreurLocalisation, setErreurLocalisation] = useState<string | null>(null);
  const [deplie, setDeplie] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches
  );
  const [carte, setCarte] = useState<CarteLeaflet | null>(null);
  // Route mise en avant seule sur la carte, choisie depuis la recherche : quand on
  // cherche une route precise, tout le reste du reseau devient du bruit.
  const [routeIsolee, setRouteIsolee] = useState<string | null>(null);
  // Recherche par ville (P4) : une ville = alentours 20 km, deux villes = corridor.
  const [villeFiltre, setVilleFiltre] = useState<FiltreVille | null>(null);

  const onVueChange = useCallback((v: { zoom: number; bounds: LatLngBounds }) => setVue(v), []);
  const onCarteReady = useCallback((m: CarteLeaflet) => setCarte((prev) => prev ?? m), []);

  // Rendu canvas plutot que SVG, pour deux raisons : les traces font 3 px de large,
  // donc quasi impossibles a viser au doigt — seul le renderer canvas offre une
  // tolerance de clic ; et la carte compte plus de 2000 geometries, que le canvas
  // dessine bien plus vite que 2000 noeuds SVG.
  const renderer = useMemo(() => canvas({ tolerance: 12 }), []);
  const animer = useMemo(
    () => typeof window === "undefined" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  /**
   * Palier de zoom, et non le zoom exact.
   *
   * Le serveur simplifie la geometrie par paliers ; interroger avec le zoom brut
   * relancerait la requete a chaque cran alors que la reponse serait identique. Le
   * palier est donc la cle du cache : trois requetes au maximum sur toute une
   * session, au lieu d'une par mouvement de molette.
   */
  const palierZoom = !vue ? 7 : vue.zoom < 10 ? 7 : vue.zoom < 13 ? 11 : vue.zoom < 16 ? 14 : 16;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["public", "carte", "geo", palierZoom],
    queryFn: async () =>
      (await axios.get<PublicCarteData>("/api/public/carte/geo", { params: { zoom: palierZoom } })).data,
    staleTime: 5 * 60 * 1000,
    // Garde le trace precedent a l'ecran pendant que le palier suivant arrive : sans
    // cela, la carte se vide a chaque franchissement de palier.
    placeholderData: (prec) => prec,
  });

  // D9 : franchissements OSM (propositions) — fichier statique servi par le
  // frontend, charge uniquement si la couche est ouverte.
  const { data: pontsOsm } = useQuery({
    queryKey: ["public", "ponts-osm"],
    queryFn: async () => (await axios.get<FeatureCollection>("/data/ponts-osm.geojson")).data,
    staleTime: Infinity,
    enabled: couches.pontsOsm,
  });

  const tronconLines = useMemo(
    () =>
      (data?.troncons ?? [])
        .map((t) => ({ t, positions: geoJsonToLatLngs(t.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data]
  );
  const tronconsVisibles = useMemo(
    () =>
      tronconLines.filter(
        ({ t }) =>
          !etatsMasques.has(t.etat) &&
          !classesMasquees.has(t.classe) &&
          (routeIsolee === null || t.nom === routeIsolee) &&
          (!villeFiltre || tronconDansFiltre(t.geometry ?? "", villeFiltre))
      ),
    [tronconLines, etatsMasques, classesMasquees, routeIsolee, villeFiltre]
  );
  /**
   * Seuls les chantiers EN COURS sont cartographies.
   *
   * Sur 487 chantiers, 312 sont termines et 66 seulement planifies. Les afficher tous
   * ferait lire comme des travaux en cours des marches acheves depuis 2019 — c'est
   * l'inverse de ce qu'un citoyen vient chercher sur cette carte.
   *
   * Les termines et les planifies restent en base et dans les indicateurs ; ils ne
   * sont simplement pas dessines.
   */
  const chantiersEnCours = useMemo(
    () => (data?.chantiers ?? []).filter((c) => c.statut === "EN_COURS"),
    [data]
  );
  const chantierLines = useMemo(
    () =>
      chantiersEnCours
        .filter((c) => !c.approximate)
        .map((c) => ({ c, positions: geoJsonToLatLngs(c.geometry) }))
        .filter((x) => x.positions.length > 0),
    [chantiersEnCours]
  );
  const chantierPoints = useMemo(
    () => chantiersEnCours.filter((c) => c.approximate && c.lat != null && c.lon != null),
    [chantiersEnCours]
  );

  const stats = useMemo<StatsReseau>(
    () =>
      calculerStats(
        data?.troncons ?? [],
        (data?.chantiers ?? []).filter((c) => c.statut === "EN_COURS").length,
        (data?.pointsNoirs ?? []).length,
        data?.reseau?.km,
      ),
    [data],
  );

  // Index de recherche : un axe (RN1) est decoupe en plusieurs troncons ; on le
  // presente comme une seule route, dont on additionne longueur et geometries.
  const routesIndexees = useMemo<RouteIndexee[]>(() => {
    const parNom = new Map<string, RouteIndexee>();
    for (const { t, positions } of tronconLines) {
      const existante = parNom.get(t.nom);
      if (existante) {
        existante.longueurKm += t.longueurKm || 0;
        existante.positions.push(...positions);
        if (t.region && !existante.regions.includes(t.region)) existante.regions.push(t.region);
      } else {
        parNom.set(t.nom, {
          nom: t.nom,
          classe: t.classe,
          longueurKm: t.longueurKm || 0,
          regions: t.region ? [t.region] : [],
          positions: [...positions],
        });
      }
    }
    return [...parNom.values()];
  }, [tronconLines]);

  const etiquettes = useMemo(() => {
    if (!couches.noms || !couches.troncons || !vue || vue.zoom < ZOOM_MIN_ETIQUETTES) return [];
    type Candidat = { id: string; nom: string; position: [number, number]; longueur: number };

    // 1. Une seule etiquette par nom de route : le reseau est decoupe en troncons, si
    // bien qu'un meme axe apparait en plusieurs segments et serait etiquete autant de
    // fois. On garde le plus long segment visible, le plus representatif.
    const parNom = new Map<string, Candidat>();
    for (const { t, positions } of tronconsVisibles) {
      if (!positions.some((p) => vue.bounds.contains(p))) continue;
      const dejaVu = parNom.get(t.nom);
      if (dejaVu && dejaVu.longueur >= t.longueurKm) continue;
      parNom.set(t.nom, {
        id: t.id,
        nom: t.nom,
        // Sommet median : toujours sur le trace, contrairement au centre de l'emprise
        // qui tombe a cote des que la route est courbe.
        position: positions[Math.floor(positions.length / 2)],
        longueur: t.longueurKm,
      });
    }

    // 2. Une seule etiquette par case de la grille, la route la plus longue d'abord :
    // les axes structurants l'emportent sur la desserte locale quand les deux se
    // disputent la meme zone.
    const sw = vue.bounds.getSouthWest();
    const ne = vue.bounds.getNorthEast();
    const spanLat = ne.lat - sw.lat;
    const spanLon = ne.lng - sw.lng;
    if (spanLat <= 0 || spanLon <= 0) return [];

    const occupees = new Set<string>();
    const retenues: Candidat[] = [];
    for (const c of [...parNom.values()].sort((a, b) => b.longueur - a.longueur)) {
      const col = Math.min(ETIQUETTES_COLS - 1, Math.floor(((c.position[1] - sw.lng) / spanLon) * ETIQUETTES_COLS));
      const row = Math.min(ETIQUETTES_ROWS - 1, Math.floor(((c.position[0] - sw.lat) / spanLat) * ETIQUETTES_ROWS));
      const case_ = `${col}:${row}`;
      if (occupees.has(case_)) continue;
      occupees.add(case_);
      retenues.push(c);
    }
    return retenues;
  }, [couches.noms, couches.troncons, vue, tronconsVisibles]);

  function toggleCouche(k: CoucheKey) {
    setCouches((c) => ({ ...c, [k]: !c[k] }));
  }

  function toggleEtat(etat: EtatPatrimoine) {
    setEtatsMasques((prev) => {
      const suivant = new Set(prev);
      if (suivant.has(etat)) suivant.delete(etat);
      else suivant.add(etat);
      return suivant;
    });
  }

  function allerVersRoute(route: RouteIndexee) {
    // Les deux filtres s'excluent : sans cela, chercher une ville apres une route
    // ne rendait que l'intersection des deux, souvent vide, sans rien expliquer.
    const f = filtrerParRoute(route.nom);
    setRouteIsolee(f.route);
    setVilleFiltre(f.ville);
    setSelected(null);
    if (!carte || route.positions.length === 0) return;
    carte.flyToBounds(latLngBounds(route.positions).pad(0.15), { animate: animer, duration: 0.8 });
  }

  function meLocaliser() {
    if (!navigator.geolocation) {
      setErreurLocalisation("Votre navigateur ne sait pas donner votre position.");
      return;
    }
    setErreurLocalisation(null);
    setLocalisationEnCours(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setMaPosition(p);
        setLocalisationEnCours(false);
        carte?.flyTo(p, Math.max(carte.getZoom(), 12), { animate: animer, duration: 0.8 });
      },
      () => {
        setLocalisationEnCours(false);
        setErreurLocalisation("Position indisponible. Autorisez la localisation puis réessayez.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  return (
    // h-[100dvh] et non inset-0 : sur un navigateur mobile, la barre d'adresse qui
    // apparait et disparait fait mentir la hauteur du viewport, et le bas de la page
    // se retrouve masque sous la barre d'outils.
    <div className="fixed inset-x-0 top-0 flex h-[100dvh] flex-col bg-slate-100">
      <header className="z-[1100] flex items-center gap-3 bg-navy px-3 py-2 text-white shadow-sm sm:px-4 sm:py-2.5">
        <img src="/ageroute-logo.svg" alt="AGEROUTE Guinée" className="h-7 w-auto shrink-0 sm:h-8" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold leading-tight">Géoportail routier</h1>
          <p className="truncate text-[11px] leading-tight text-white/60">
            L'état des routes de Guinée, ouvert à tous
          </p>
        </div>
        <Link
          to="/login"
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-gold px-3 py-2 text-sm font-medium text-navy transition hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <LogIn className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Se connecter</span>
          <span className="sr-only sm:hidden">Se connecter</span>
        </Link>
      </header>

      <div className="relative flex-1">
        <MapContainer
          bounds={GUINEE_BOUNDS}
          boundsOptions={GUINEE_BOUNDS_OPTIONS}
          zoomSnap={PAS_DE_ZOOM}
          maxZoom={20}
          renderer={renderer}
          zoomControl={false}
          style={{ height: "100%", width: "100%" }}
        >
          {/* Tuiles OpenStreetMap et non le fond CARTO du geoportail interne :
              basemaps.cartocdn.com renvoie desormais une tuile "API KEY REQUIRED"
              sans cle. Cette page etant ouverte a tous, elle ne peut pas dependre
              d'un service a cle. */}
          {/* maxNativeZoom : au-dela de 19, OSM n'a pas de tuile. Sans cela, la carte
              demande des tuiles inexistantes et le fond disparait exactement a
              l'echelle ou l'on regarde une rue. Leaflet agrandit alors la derniere
              tuile disponible — flou plutot qu'absent, et les traces restent nets. */}
          <TileLayer
            attribution={`&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ${CREDIT_DONNEES}`}
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            crossOrigin="anonymous"
            maxZoom={20}
            maxNativeZoom={19}
          />
          <SuiviVue onChange={onVueChange} />
          {/* Voirie locale avant les troncons : le reseau AGEROUTE reste au-dessus. */}
          {couches.voirie && (
            <VoirieLocaleLayer
              publique
              categories={categoriesVoirie}
              onChargement={(e) =>
                setEtatVoirie({
                  zoomSuffisant: e.zoomSuffisant, voies: e.voies,
                  promues: e.promues, chargement: e.chargement,
                })
              }
            />
          )}
          <CaptureCarte onReady={onCarteReady} />

          {couches.troncons &&
            tronconsVisibles.map(({ t, positions }) => (
              <Polyline
                key={t.id}
                positions={positions}
                pathOptions={{ color: ETAT_COLORS[t.etat] ?? "#9ca3af", weight: 3 }}
                eventHandlers={{ click: () => setSelected({ kind: "troncon", data: t }) }}
              >
                <Tooltip sticky>
                  <span className="font-semibold">{t.nom}</span> — {ETAT_LABELS[t.etat] ?? t.etat}
                </Tooltip>
              </Polyline>
            ))}

          {couches.chantiers &&
            chantierLines.map(({ c, positions }) => (
              <Polyline
                key={c.id}
                positions={positions}
                pathOptions={{ color: CHANTIER_COLORS[c.statut], weight: 5, dashArray: "5 5" }}
                eventHandlers={{ click: () => setSelected({ kind: "chantier", data: c }) }}
              >
                <Tooltip sticky>Chantier — {STATUT_LABELS[c.statut]} ({c.avancementPct} %)</Tooltip>
              </Polyline>
            ))}

          {couches.chantiers &&
            chantierPoints.map((c) => (
              <CircleMarker
                key={c.id}
                center={[c.lat as number, c.lon as number]}
                radius={6}
                pathOptions={{ color: "#fff", weight: 1, fillColor: CHANTIER_COLORS[c.statut], fillOpacity: 0.9 }}
                eventHandlers={{ click: () => setSelected({ kind: "chantier", data: c }) }}
              >
                <Tooltip>Chantier — {STATUT_LABELS[c.statut]}</Tooltip>
              </CircleMarker>
            ))}

          {/* interactive={false} : les etiquettes ne doivent jamais intercepter un clic
              destine a la route qu'elles nomment. */}
          {etiquettes.map((e) => (
            <Marker
              key={`nom-${e.id}`}
              position={e.position}
              icon={divIcon({ className: "", html: ecussonHtml(e.nom) })}
              interactive={false}
            />
          ))}

          {couches.pointsNoirs &&
            (data?.pointsNoirs ?? []).map((p) => (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lon]}
                radius={5}
                pathOptions={{ color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: 0.9 }}
                eventHandlers={{ click: () => setSelected({ kind: "pointNoir", data: p }) }}
              >
                <Tooltip>Point noir — gravité {p.gravite}</Tooltip>
              </CircleMarker>
            ))}

          {/* D9 : ouvrages d'art — symbole par nature, couleur = état, position
              héritée non vérifiée (mention honnête dans l'infobulle). */}
          {couches.ouvrages &&
            (data?.ouvrages ?? []).map((o) => (
              <Marker
                key={o.id}
                position={[o.lat, o.lon]}
                icon={ouvrageIcon(o.type, o.etat)}
                eventHandlers={{ click: () => setSelected({ kind: "ouvrage", data: o }) }}
              >
                <Tooltip>
                  {TYPE_OUVRAGE_LABEL[o.type] ?? o.type} — {o.nom}
                  <br />
                  <span style={{ color: "#6b7280" }}>position héritée, non vérifiée</span>
                </Tooltip>
              </Marker>
            ))}

          {/* D9 : franchissements OSM (propositions) — une couche GeoJSON, meme
              code couleur que le geoportail interne. */}
          {couches.pontsOsm && pontsOsm && (
            <GeoJSON
              key="public-ponts-osm"
              data={pontsOsm}
              style={(f) => {
                const p = f?.properties ?? {};
                const majeur = /rapide|primaire|secondaire/.test(String(p.nature));
                if (p.classement !== "PONT_SANS_OUVRAGE") return { color: "#16a34a", weight: 3, opacity: 0.9 };
                return majeur
                  ? { color: "#b91c1c", weight: 4, opacity: 0.9 }
                  : { color: "#ef4444", weight: 1.5, opacity: 0.7 };
              }}
              onEachFeature={(f, layer) => {
                const p = f.properties as { franchissement?: string; numero?: string; nom?: string; nature?: string; classement?: string; longueurM?: number; distanceM?: number };
                layer.bindTooltip(`${p.franchissement ?? ""}${p.numero ? " " + p.numero : ""}${p.nom ? " — " + p.nom : ""}`, { sticky: true });
                layer.bindPopup(
                  `<b>${p.franchissement ?? ""}${p.numero ? " " + p.numero : ""}${p.nom ? " — " + p.nom : ""}</b><br>` +
                  `${p.nature ?? ""}<br>` +
                  `Proposition : <b>${p.classement === "PONT_SANS_OUVRAGE" ? "à instruire (aucun ouvrage AGEROUTE à 250 m)" : "correspondance AGEROUTE"}</b><br>` +
                  `<span style="color:#6b7280">Repère non inventorié — à valider sur le terrain par AGEROUTE</span>`
                );
              }}
            />
          )}

          {maPosition && (
            <CircleMarker
              center={maPosition}
              radius={7}
              pathOptions={{ color: "#fff", weight: 2, fillColor: "#2563eb", fillOpacity: 1 }}
            >
              <Tooltip>Vous êtes ici</Tooltip>
            </CircleMarker>
          )}
        </MapContainer>

        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] p-3">
          <div className="pointer-events-auto mx-auto max-w-md sm:mx-0 sm:ml-3 sm:max-w-sm">
            <RechercheRoute routes={routesIndexees} onChoisir={allerVersRoute} />
            <div className="mt-2 rounded-lg bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
              <RechercheVille
                compact
                onAppliquer={(v) => {
                  const f = filtrerParVille(v);
                  setRouteIsolee(f.route);
                  setVilleFiltre(f.ville);
                }}
              />
            </div>
            {routeIsolee && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-navy px-3 py-2 text-white shadow-lg">
                <Ecusson nom={routeIsolee} taille="sm" />
                <span className="min-w-0 flex-1 truncate text-xs">Cette route seule est affichée</span>
                <button
                  type="button"
                  onClick={() => setRouteIsolee(null)}
                  className="shrink-0 rounded px-2 py-1 text-xs font-medium underline underline-offset-2 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                >
                  Tout le réseau
                </button>
              </div>
            )}
            {villeFiltre && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-navy px-3 py-2 text-white shadow-lg">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {villeFiltre.a.nom}{villeFiltre.b ? ` ↔ ${villeFiltre.b.nom}` : " et ses alentours"} — {tronconsVisibles.length} route(s)
                </span>
                <button
                  type="button"
                  onClick={() => setVilleFiltre(null)}
                  aria-label="Retirer le filtre ville"
                  className="shrink-0 rounded p-1 transition hover:bg-white/15"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Sur telephone, commandes et feuille d'infos partagent un meme flux vertical
            ancre en bas : la feuille change de hauteur selon qu'elle est depliee, et
            des positions absolues independantes finissaient par se recouvrir — les
            boutons passaient derriere la feuille, donc hors d'atteinte. Au dela de
            sm, "contents" efface ce conteneur et chaque bloc reprend sa place. */}
        <div className="absolute inset-x-0 bottom-0 z-[1000] flex flex-col items-end sm:contents">
          <div className="mb-3 mr-3 flex flex-col gap-2 sm:absolute sm:bottom-6 sm:right-3 sm:z-[1000] sm:mb-0 sm:mr-0">
          <div className="overflow-hidden rounded-full bg-white shadow-lg ring-1 ring-black/5">
            <button
              type="button"
              onClick={() => carte?.zoomIn()}
              aria-label="Zoomer"
              className="flex h-11 w-11 items-center justify-center text-navy transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy"
            >
              <Plus className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => carte?.zoomOut()}
              aria-label="Dézoomer"
              className="flex h-11 w-11 items-center justify-center border-t border-slate-200 text-navy transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy"
            >
              <Minus className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={meLocaliser}
            disabled={localisationEnCours}
            aria-label="Afficher ma position"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-navy shadow-lg ring-1 ring-black/5 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:opacity-60"
          >
            {localisationEnCours ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <LocateFixed className="h-5 w-5" aria-hidden />
            )}
          </button>
          </div>

          <PanneauInfos
            stats={stats}
            couches={couches}
            onToggleCouche={toggleCouche}
            etatsMasques={etatsMasques}
            classesMasquees={classesMasquees}
            onToggleClasse={(c) =>
              setClassesMasquees((prev) => {
                const n = new Set(prev);
                n.has(c) ? n.delete(c) : n.add(c);
                return n;
              })
            }
            onToggleEtat={toggleEtat}
            deplie={deplie}
            onToggleDeplie={() => setDeplie((d) => !d)}
            voirie={etatVoirie}
            zoomInsuffisantPourNoms={!!vue && vue.zoom < ZOOM_MIN_ETIQUETTES}
          />
        </div>

        {(isLoading || isError || erreurLocalisation) && (
          <div className="pointer-events-none absolute inset-x-0 top-20 z-[1000] flex justify-center px-4">
            {isLoading && (
              <p className="rounded-full bg-white/95 px-4 py-1.5 text-xs text-navy shadow">
                Chargement du réseau routier…
              </p>
            )}
            {isError && (
              <p className="flex items-center gap-2 rounded-md bg-red-50 px-4 py-2 text-xs text-red-700 shadow ring-1 ring-red-200">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                Les données ne sont pas disponibles pour le moment. Réessayez dans un instant.
              </p>
            )}
            {!isLoading && !isError && erreurLocalisation && (
              <p className="rounded-md bg-amber-50 px-4 py-2 text-xs text-amber-800 shadow ring-1 ring-amber-200">
                {erreurLocalisation}
              </p>
            )}
          </div>
        )}

        {selected && <FicheElement feature={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
