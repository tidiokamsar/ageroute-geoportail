import { Fragment, useEffect, useMemo, useState } from "react";
import { Polyline, Popup, Tooltip, useMapEvents } from "react-leaflet";
import axios from "axios";
import { api } from "../../lib/api";
import { ETAT_COLORS, ETAT_LABELS } from "./types";
import type { EtatPatrimoine } from "../../types";

/**
 * Voirie locale — les tracés eux-mêmes, chargés selon la vue.
 *
 * POURQUOI PAS TOUT D'UN COUP
 *
 * La couche compte 262 656 objets et 5,8 millions de sommets. Mesure sur la carte
 * publique : 22,8 octets par sommet en GeoJSON. La servir entière représenterait
 * 41 Mo gzippés — quarante-sept fois ce que l'application transporte aujourd'hui.
 *
 * Mais cadrée, elle est légère : Conakry entière pèse 263 Ko, moins que la carte
 * publique actuelle. Une commune, 35 Ko. Un quartier, 2 Ko.
 *
 * D'où ce fonctionnement : rien en dessous du seuil de zoom, puis une requête par
 * emprise à chaque déplacement. Le serveur simplifie la géométrie selon l'échelle
 * et refuse les emprises trop larges — le client n'est pas la seule protection.
 *
 * LE REGISTRE VISUEL
 *
 * Traits gris fins, hiérarchisés par épaisseur, jamais la palette d'état du réseau
 * AGEROUTE. Une voie locale n'a pas d'état de chaussée relevé : lui donner la même
 * échelle de couleur ferait lire un sentier comme une route en mauvais état.
 */

/** En dessous, la couche ne se charge pas : l'emprise serait trop large. */
export const ZOOM_MINIMUM = 12;

/**
 * A partir de ce zoom, chaque voie recoit une zone de prehension.
 *
 * POURQUOI PAS TOUJOURS
 *
 * Ces traits font 1 a 1,4 px : le stroke SVG est la seule surface cliquable, donc
 * viser une voie relevait de l'adresse. La solution est un second trace transparent
 * et epais qui porte l'interaction.
 *
 * Mais elle double le nombre de chemins SVG, et le plafond de la couche est de
 * 12 000 objets — 24 000 chemins sur une vue large. Au-dela du zoom 14, une emprise
 * ne contient plus que quelques centaines de voies : le cout devient negligeable, et
 * c'est aussi la seule echelle ou l'on cherche vraiment a interroger une rue.
 */
const ZOOM_PREHENSION = 14;

/** Epaisseur de la zone de prehension, invisible. */
const PREHENSION_PX = 12;

export type CategorieVoirie =
  | "VOIE_RAPIDE" | "PRINCIPALE" | "SECONDAIRE" | "TERTIAIRE"
  | "VOIE_LOCALE" | "RESIDENTIELLE" | "ACCES"
  | "CHEMIN" | "SENTIER" | "PIETON" | "INCONNU";

export interface VoieLocale {
  id: string;
  nature: string;
  nom: string | null;
  reference: string | null;
  categorie: CategorieVoirie;
  statut: string;
  source: string;
  sourceId: string;
  sourceDate: string | null;
  longueurKm: number;
  region: string | null;
  regionMethode: string | null;
  /** Non nul quand la voie a ete promue : elle est alors aussi un actif AGEROUTE. */
  tronconId: string | null;
  tronconCode: string | null;
  /** Etat du troncon porteur : c'est lui qui colore une voie promue. */
  tronconEtat: EtatPatrimoine | null;
  tronconEtatDeclare: boolean | null;
  geometry: string;
}

export interface ReponseVoirie {
  tronque: boolean;
  plafond: number;
  simplifieeDe: number;
  voies: VoieLocale[];
}

/**
 * Épaisseur et teinte par catégorie.
 *
 * Registre délibérément gris : le réseau AGEROUTE occupe seul la couleur, qui y
 * porte l'état de la chaussée. La hiérarchie se lit ici à l'épaisseur.
 */
const STYLE: Record<CategorieVoirie, { poids: number; couleur: string; opacite: number }> = {
  VOIE_RAPIDE:   { poids: 3.0, couleur: "#6b7280", opacite: 0.85 },
  PRINCIPALE:    { poids: 2.6, couleur: "#6b7280", opacite: 0.8 },
  SECONDAIRE:    { poids: 2.2, couleur: "#7c8493", opacite: 0.75 },
  TERTIAIRE:     { poids: 1.8, couleur: "#8b929e", opacite: 0.7 },
  VOIE_LOCALE:   { poids: 1.4, couleur: "#9aa0aa", opacite: 0.65 },
  RESIDENTIELLE: { poids: 1.2, couleur: "#a5abb4", opacite: 0.6 },
  ACCES:         { poids: 1.0, couleur: "#b0b5bd", opacite: 0.55 },
  CHEMIN:        { poids: 1.0, couleur: "#b8a48f", opacite: 0.6 },
  SENTIER:       { poids: 0.8, couleur: "#c2b09c", opacite: 0.5 },
  PIETON:        { poids: 0.8, couleur: "#c9bfb2", opacite: 0.45 },
  INCONNU:       { poids: 0.8, couleur: "#c4c7cc", opacite: 0.4 },
};

export const LIBELLE_VOIRIE: Record<CategorieVoirie, string> = {
  VOIE_RAPIDE: "Voies rapides",
  PRINCIPALE: "Routes principales",
  SECONDAIRE: "Routes secondaires",
  TERTIAIRE: "Routes tertiaires",
  VOIE_LOCALE: "Voies locales",
  RESIDENTIELLE: "Voies résidentielles",
  ACCES: "Dessertes et accès",
  CHEMIN: "Chemins",
  SENTIER: "Sentiers",
  PIETON: "Voies piétonnes",
  INCONNU: "Non qualifiées",
};

/**
 * Legende de la couche voirie.
 *
 * Elle disait « donnee OpenStreetMap non validee par AGEROUTE ». C'etait vrai tant
 * qu'aucune voie n'etait promue. Depuis la promotion, une voie rattachee a un
 * troncon EST au registre, et le lui refuser serait faux — dans l'autre sens cette
 * fois, mais faux quand meme.
 *
 * La legende compte donc, plutot que d'affirmer.
 */
export function legendeVoirie(voies: number, promues: number): string {
  const n = voies.toLocaleString("fr-FR");
  if (voies === 0) return "Aucune voie dans la vue.";
  if (promues === 0) {
    return `${n} voie(s) dans la vue — donnée externe non validée par AGEROUTE`;
  }
  if (promues >= voies) {
    return `${n} voie(s) dans la vue — rattachées au registre AGEROUTE`;
  }
  return `${n} voie(s) dans la vue, dont ${promues.toLocaleString("fr-FR")} rattachées au registre AGEROUTE — les autres restent de la donnée externe non validée`;
}

/**
 * Trait d'une voie.
 *
 * LE GRIS N'ETAIT PAS UN CHOIX ESTHETIQUE
 *
 * Il disait quelque chose : une voie OpenStreetMap n'a pas d'etat de chausse releve,
 * et lui donner la palette du reseau ferait lire un sentier comme une route degradee.
 *
 * Une voie PROMUE a change de nature. Elle porte un troncon, donc un etat, et la
 * carte publique la peignait en vert avant que la vue d'ensemble ne cesse de la
 * transporter. Elle doit continuer a se lire ainsi — sinon la promotion se traduirait
 * a l'ecran par une perte.
 *
 * L'epaisseur reste celle de la categorie : une desserte promue reste une desserte.
 */
function trait(v: VoieLocale): { poids: number; couleur: string; opacite: number } {
  const s = STYLE[v.categorie] ?? STYLE.INCONNU;
  if (!v.tronconId || !v.tronconEtat) return s;
  return {
    poids: Math.max(s.poids, 2),
    couleur: ETAT_COLORS[v.tronconEtat] ?? s.couleur,
    opacite: 0.9,
  };
}

/** GeoJSON rend [lon, lat] ; Leaflet attend [lat, lon]. */
function versLatLng(geometry: string): [number, number][] {
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}


function distance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

function Ligne({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-gray-500">{label}</span>
      <span className="text-right text-[12px] font-medium text-navy">{valeur}</span>
    </div>
  );
}

/**
 * Fiche d'une voie locale.
 *
 * L'infobulle qui precedait donnait trois lignes au survol et rien de plus : on
 * voyait la voie sans pouvoir l'interroger. C'etait la vraie lacune — l'affichage
 * etait la, l'exploitabilite non.
 *
 * CE QUE LA FICHE DOIT ETABLIR AVANT TOUT
 *
 * Le statut de l'objet. Une voie OpenStreetMap n'est pas un actif AGEROUTE, sauf si
 * elle a ete promue — et cela se voit au `tronconId`, pas au statut cartographique.
 * VALIDEE ne veut dire que « le trace est juge correct ». La fiche l'annonce donc en
 * tete, avant les mesures, parce que c'est ce qui commande la lecture de tout le
 * reste.
 *
 * La longueur est un CALCUL, jamais une donnee source : le libelle le dit.
 */
function FicheVoirie({
  v, onOuvrirTroncon,
}: {
  v: VoieLocale;
  onOuvrirTroncon?: (tronconId: string) => void;
}) {
  const promue = Boolean(v.tronconId);
  const couleur = promue ? "#16a34a" : "#6b7280";

  return (
    <div style={{ minWidth: 244 }}>
      <div className="min-w-0">
        <p className="text-[13px] font-bold leading-tight text-navy">
          {v.nom ?? v.reference ?? "Voie sans nom"}
        </p>
        <p className="text-[11px] leading-tight text-gray-500">
          {LIBELLE_VOIRIE[v.categorie]} · {v.region ?? "région non rattachée"}
        </p>
      </div>

      <div className="mt-2.5 rounded-md px-2 py-1.5" style={{ backgroundColor: `${couleur}14` }}>
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: couleur }}>
          {promue ? "Tronçon du patrimoine" : "Donnée cartographique"}
        </p>
        <p className="text-[10.5px] leading-snug text-gray-600">
          {promue
            ? `Au registre sous ${v.tronconCode ?? "un tronçon"}.`
            : "Source externe. Cette voie n'est pas un actif AGEROUTE : ni état de chaussée, ni revêtement, ni chantier."}
        </p>
      </div>

      {promue && v.tronconEtat && (
        <div className="mt-2 border-t border-gray-100 pt-1">
          <Ligne
            label="État de la chaussée"
            valeur={
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: ETAT_COLORS[v.tronconEtat] }}
                />
                {ETAT_LABELS[v.tronconEtat]}
                {v.tronconEtatDeclare && (
                  <span className="rounded bg-amber-50 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-700">
                    déclaré
                  </span>
                )}
              </span>
            }
          />
          {v.tronconEtatDeclare && (
            <p className="pb-1 text-[10px] leading-snug text-amber-700">
              Déclaré par le gestionnaire, sans relevé de terrain.
            </p>
          )}
        </div>
      )}

      <div className="mt-2 border-t border-gray-100 pt-1">
        <Ligne label="Nature (source)" valeur={v.nature} />
        <Ligne label="Longueur calculée" valeur={distance(v.longueurKm)} />
        {v.reference && <Ligne label="Référence" valeur={v.reference} />}
        <Ligne label="Provenance" valeur={`${v.source} · ${v.sourceId}`} />
        {v.sourceDate && (
          <Ligne
            label="Mise à jour source"
            valeur={new Date(v.sourceDate).toLocaleDateString("fr-FR")}
          />
        )}
        {v.regionMethode && <Ligne label="Rattachement" valeur={v.regionMethode} />}
      </div>

      {/* Sans ce bouton, un troncon promu etait injoignable : il est exclu de la
          couche des troncons (qui ne transporte que le reseau de reference) et donc
          aussi de la recherche du geoportail, qui filtre ce que la carte a charge.
          Plus de cent mille troncons etaient au registre et hors d'atteinte. */}
      {promue && v.tronconId && onOuvrirTroncon && (
        <button
          type="button"
          onClick={() => onOuvrirTroncon(v.tronconId!)}
          className="mt-2.5 w-full rounded-md bg-navy px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-navy/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          Ouvrir la fiche du tronçon
        </button>
      )}

      <p className="mt-1.5 border-t border-gray-100 pt-1.5 text-[10px] leading-snug text-gray-400">
        La longueur est calculée sur le tracé, ce n'est pas une longueur métier.
      </p>
    </div>
  );
}

export function VoirieLocaleLayer({
  categories,
  onChargement,
  onOuvrirTroncon,
  publique = false,
}: {
  categories: Set<CategorieVoirie>;
  /**
   * Ouvre la fiche editable du troncon porteur. Absent sur la carte publique, qui
   * est en consultation seule.
   */
  onOuvrirTroncon?: (tronconId: string) => void;
  /**
   * Carte publique : meme couche, meme handler cote serveur, mais servi par la
   * route ouverte — la donnee est deja publique, c'est de l'OpenStreetMap. Le
   * client authentifie ne convient pas la : la carte publique n'a pas de session.
   */
  publique?: boolean;
  /** Remonte l'état au panneau : zoom insuffisant, comptes, troncature. */
  onChargement?: (etat: {
    zoomSuffisant: boolean;
    chargement: boolean;
    voies: number;
    /**
     * Parmi elles, celles rattachees a un troncon. La legende en depend : dire
     * « donnee non validee » d'une voie entree au registre serait faux.
     */
    promues: number;
    tronque: boolean;
    erreur: string | null;
  }) => void;
}) {
  const [voies, setVoies] = useState<VoieLocale[]>([]);
  const [tronque, setTronque] = useState(false);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [vue, setVue] = useState<{ zoom: number; bbox: string } | null>(null);

  const carte = useMapEvents({
    moveend: () => majVue(),
    zoomend: () => majVue(),
  });

  function majVue() {
    const b = carte.getBounds();
    setVue({
      zoom: carte.getZoom(),
      // Quatre décimales ≈ 11 m : assez fin pour cadrer, assez grossier pour que
      // de menus déplacements ne relancent pas la requête.
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        .map((v) => v.toFixed(4))
        .join(","),
    });
  }

  // Première vue : useMapEvents ne se déclenche qu'au mouvement.
  useEffect(() => { majVue(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const listeCategories = useMemo(() => [...categories].sort().join(","), [categories]);
  const zoomSuffisant = (vue?.zoom ?? 0) >= ZOOM_MINIMUM;

  useEffect(() => {
    if (!vue || !zoomSuffisant || categories.size === 0) {
      setVoies([]);
      setTronque(false);
      setErreur(null);
      return;
    }
    let annule = false;
    setChargement(true);
    setErreur(null);
    const params = { bbox: vue.bbox, categories: listeCategories };
    const requete = publique
      ? axios.get<ReponseVoirie>("/api/public/voirie-locale/geo", { params })
      : api.get<ReponseVoirie>("/voirie-locale/geo", { params });
    requete
      .then(({ data }) => {
        if (annule) return;
        setVoies(data.voies);
        setTronque(data.tronque);
      })
      .catch((e) => {
        if (annule) return;
        setVoies([]);
        // Le serveur refuse les emprises trop larges avec un message explicite :
        // on le montre plutôt qu'un échec muet.
        setErreur(e?.response?.data?.message ?? "Chargement de la voirie impossible");
      })
      .finally(() => { if (!annule) setChargement(false); });
    return () => { annule = true; };
  }, [vue?.bbox, zoomSuffisant, listeCategories, categories.size, publique]);

  const promues = useMemo(() => voies.filter((v) => v.tronconId).length, [voies]);

  useEffect(() => {
    onChargement?.({ zoomSuffisant, chargement, voies: voies.length, promues, tronque, erreur });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [zoomSuffisant, chargement, voies.length, promues, tronque, erreur]);

  if (!zoomSuffisant) return null;

  const prehensible = (vue?.zoom ?? 0) >= ZOOM_PREHENSION;

  return (
    <>
      {voies.map((v) => {
        const pts = versLatLng(v.geometry);
        if (pts.length < 2) return null;
        const s = trait(v);
        // Survol : de quoi identifier. Clic : la fiche complete.
        const interaction = (
          <>
            <Tooltip sticky>
              <span className="text-[11px]">
                <strong>{v.nom ?? v.reference ?? "Voie sans nom"}</strong>
                <br />
                {v.nature} · {distance(v.longueurKm)}
              </span>
            </Tooltip>
            <Popup>
              <FicheVoirie v={v} onOuvrirTroncon={onOuvrirTroncon} />
            </Popup>
          </>
        );

        if (!prehensible) {
          return (
            <Polyline
              key={v.id}
              positions={pts}
              pathOptions={{ color: s.couleur, weight: s.poids, opacity: s.opacite }}
            >
              {interaction}
            </Polyline>
          );
        }

        return (
          <Fragment key={v.id}>
            {/* Le trace visible ne capte rien : sinon les deux se disputeraient le clic. */}
            <Polyline
              positions={pts}
              interactive={false}
              pathOptions={{ color: s.couleur, weight: s.poids, opacity: s.opacite }}
            />
            <Polyline
              positions={pts}
              pathOptions={{ color: s.couleur, weight: PREHENSION_PX, opacity: 0 }}
            >
              {interaction}
            </Polyline>
          </Fragment>
        );
      })}
    </>
  );
}
