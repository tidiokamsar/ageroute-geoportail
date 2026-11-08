import { useEffect, useState } from "react";
import { Polyline, Popup, Tooltip, useMapEvents } from "react-leaflet";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import { symbole } from "../../features/geoportail/map/symbology";
import { etiquetteJour, type PortionALaDate, type ReponseCurseur } from "../../lib/curseur";

/**
 * Les portions vraies à une date : la couche du curseur temporel.
 *
 * CE QUE CETTE COUCHE MONTRE, ET CE QU'ELLE NE MONTRE PAS
 *
 * Elle dessine l'ÉTAT DES PORTIONS à la date choisie, jamais l'état actuel du tronçon : celui-ci
 * est une valeur d'aujourd'hui, et le peindre sous une date passée dirait faux. Un mètre qu'aucune
 * portion ne couvre à cette date reste au tracé de référence (gris), donc « non renseigné ».
 *
 * La couleur n'est jamais seule : la symbologie d'état porte aussi un motif de trait, lisible en
 * niveaux de gris et par les personnes qui distinguent mal le rouge du vert.
 *
 * Une PROPOSITION non validée se reconnaît à son trait atténué et à son bandeau dans la fiche.
 *
 * CHARGEMENT PAR EMPRISE, comme la voirie locale : rien sous le zoom minimal, puis une requête à
 * chaque déplacement. Le serveur refuse les emprises trop larges et tronque au-delà d'un plafond.
 */

/** En dessous, l'emprise dépasse ce que le serveur accepte (cinq degrés de côté). */
export const ZOOM_MINIMUM_CURSEUR = 9;

export interface EtatCouchePortions {
  zoomSuffisant: boolean;
  chargement: boolean;
  reponse: ReponseCurseur | null;
  erreur: string | null;
}

/** GeoJSON rend [lon, lat] ; Leaflet attend [lat, lon]. Seules les lignes sont dessinées. */
export function versLatLng(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString" || !Array.isArray(g.coordinates)) return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

function Ligne({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[11px] text-gray-500">{label}</span>
      <span className="text-right text-[12px] font-medium text-navy">{valeur}</span>
    </div>
  );
}

function metres(m: number): string {
  return `${Math.round(m).toLocaleString("fr-FR")} m`;
}

/** Fiche d'une portion, telle qu'elle était vraie à la date choisie. */
export function FichePortionDate({ p, dateTerrain }: { p: PortionALaDate; dateTerrain: string }) {
  const s = symbole(p.etat);
  const proposition = p.statut === "A_VALIDER";
  return (
    <div style={{ minWidth: 252 }}>
      <p className="text-[13px] font-bold leading-tight text-navy">{p.tronconCode}</p>
      <p className="text-[11px] leading-tight text-gray-500">{p.tronconNom} · de {metres(p.debutM)} à {metres(p.finM)}</p>

      {proposition && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] font-semibold leading-snug text-amber-800">
          Proposition non validée : pas encore une donnée officielle.
        </p>
      )}
      {p.ambigue && (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] leading-snug text-red-800">
          Une autre portion couvre les mêmes mètres à cette date : le curseur ne tranche pas.
        </p>
      )}

      <div className="mt-2 border-t border-gray-100 pt-1">
        <Ligne
          label="État"
          valeur={
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.trait }} aria-hidden="true" />
              {p.etatLibelle ?? (p.etat ? p.etat : "Non qualifié")}
            </span>
          }
        />
        <Ligne label="Revêtement" valeur={p.revetement ?? "Non relevé"} />
        <Ligne label="Praticabilité" valeur={p.praticabilite ?? "Non relevée"} />
        {p.largeurM !== null && <Ligne label="Largeur" valeur={`${p.largeurM} m`} />}
      </div>

      <div className="mt-2 border-t border-gray-100 pt-1">
        <Ligne label="Vue à la date du" valeur={etiquetteJour(dateTerrain)} />
        <Ligne label="Vrai depuis le" valeur={p.valideDu ? etiquetteJour(p.valideDu) : "date inconnue"} />
        <Ligne label="Jusqu'au (exclu)" valeur={p.valideAu ? etiquetteJour(p.valideAu) : "sans fin connue"} />
        <Ligne label="Enregistrée le" valeur={etiquetteJour(p.enregistreLe.slice(0, 10))} />
        {p.observeeLe && <Ligne label="Constatée le" valeur={etiquetteJour(p.observeeLe)} />}
        {p.source && <Ligne label="Source" valeur={p.source} />}
        {p.confiance && <Ligne label="Confiance" valeur={p.confiance} />}
      </div>

      <p className="mt-1.5 border-t border-gray-100 pt-1.5 text-[10px] leading-snug text-gray-500">
        « Vrai depuis le » est la date d'effet sur le terrain, distincte de la date du relevé et de
        celle de l'enregistrement.
      </p>
    </div>
  );
}

export function PortionsDateLayer({
  date, connu, inclureAValider, onChargement,
}: {
  date: string;
  connu: string | null;
  inclureAValider: boolean;
  onChargement?: (etat: EtatCouchePortions) => void;
}) {
  const [reponse, setReponse] = useState<ReponseCurseur | null>(null);
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
      // Quatre décimales ≈ 11 m : de menus déplacements ne relancent pas la requête.
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(","),
    });
  }

  // Première vue : useMapEvents ne se déclenche qu'au mouvement.
  useEffect(() => { majVue(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomSuffisant = (vue?.zoom ?? 0) >= ZOOM_MINIMUM_CURSEUR;

  useEffect(() => {
    if (!vue || !zoomSuffisant) {
      setReponse(null);
      setErreur(null);
      return;
    }
    let annule = false;
    setChargement(true);
    setErreur(null);
    api
      .get<ReponseCurseur>("/v2/portions/a-la-date", {
        params: {
          date,
          bbox: vue.bbox,
          inclureAValider: inclureAValider ? "true" : "false",
          ...(connu ? { connu } : {}),
        },
      })
      .then(({ data }) => { if (!annule) setReponse(data); })
      .catch((e) => {
        if (annule) return;
        setReponse(null);
        // Le serveur motive ses refus (emprise trop large, date future) : on le montre.
        setErreur(messageErreur(e, "Chargement des portions impossible."));
      })
      .finally(() => { if (!annule) setChargement(false); });
    return () => { annule = true; };
  }, [vue?.bbox, zoomSuffisant, date, connu, inclureAValider]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onChargement?.({ zoomSuffisant, chargement, reponse, erreur });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSuffisant, chargement, reponse, erreur]);

  if (!zoomSuffisant || !reponse) return null;

  return (
    <>
      {reponse.portions.map((p) => {
        const pts = versLatLng(p.geometry);
        if (pts.length < 2) return null;
        const s = symbole(p.etat);
        const proposition = p.statut === "A_VALIDER";
        return (
          <Polyline
            key={p.id}
            positions={pts}
            pathOptions={{
              color: s.trait,
              weight: 7,
              opacity: proposition ? 0.5 : 0.95,
              dashArray: s.tirets,
              lineCap: "butt",
            }}
          >
            <Tooltip sticky>
              <span className="text-[11px]">
                <strong>{p.tronconCode}</strong> · {p.etatLibelle ?? p.etat ?? "non qualifié"}
                {proposition ? " (proposition)" : ""}
                <br />
                {p.valideDu ? `depuis le ${etiquetteJour(p.valideDu)}` : "date d'effet inconnue"}
              </span>
            </Tooltip>
            <Popup>
              <FichePortionDate p={p} dateTerrain={reponse.dateTerrain} />
            </Popup>
          </Polyline>
        );
      })}
    </>
  );
}
