import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Suivi GPS continu pour le mode terrain.
 *
 * POURQUOI `watchPosition` ET NON `getCurrentPosition`
 *
 * Trois pages du dépôt appellent `getCurrentPosition` : elles prennent un point et
 * s'arrêtent. Le §5 du cahier demande d'afficher « la précision GPS et son évolution », ce
 * qui suppose de la voir changer. Un agent qui sort d'un bâtiment voit sa précision passer
 * de 60 m à 6 m en quinze secondes ; avec un relevé unique il ne le sait pas et qualifie
 * sur la mauvaise valeur.
 *
 * TROIS ÉCHECS DISTINCTS, TROIS GESTES DIFFÉRENTS
 *
 * `INDISPONIBLE`  l'appareil n'a pas d'API de géolocalisation : rien à tenter.
 * `REFUSEE`       l'agent a refusé l'autorisation : il faut la redonner dans le navigateur.
 * `INDETERMINEE`  le signal ne vient pas : sortir, attendre, se déplacer.
 *
 * Les confondre en un seul « position indisponible » envoie l'agent chercher dans les
 * réglages alors qu'il lui suffit de sortir, ou l'inverse.
 *
 * CE HOOK NE DÉCIDE PAS SI LA POSITION EST FIABLE
 *
 * Il rend la précision annoncée par l'appareil et son historique, rien de plus. Savoir si
 * un rattachement est sûr appartient au serveur, qui pèse l'écart au tracé ET la séparation
 * entre candidats : un seuil inventé ici contredirait cette mesure.
 */

export type ErreurGps = "INDISPONIBLE" | "REFUSEE" | "INDETERMINEE";

export interface PositionGps {
  lat: number;
  lon: number;
  /** Incertitude annoncée par l'appareil, en mètres, jamais sous 1. */
  precisionM: number;
  /** Horodatage du relevé, pour qu'un écran puisse dire « il y a 40 s ». */
  releveeLe: number;
}

/** Comment la précision évolue, sur les derniers relevés. */
export type TendancePrecision = "AMELIORE" | "DEGRADE" | "STABLE" | "INCONNUE";

export interface EtatGps {
  position: PositionGps | null;
  erreur: ErreurGps | null;
  /** `true` entre la demande et le premier point. */
  enAttente: boolean;
  /** `true` quand le suivi est actif. */
  actif: boolean;
  tendance: TendancePrecision;
  /** Précisions des derniers relevés, du plus ancien au plus récent. */
  historiquePrecisionM: number[];
  demarrer: () => void;
  arreter: () => void;
}

/**
 * Nombre de relevés conservés pour juger la tendance.
 *
 * Cinq couvre une dizaine de secondes de suivi, assez pour distinguer une amélioration
 * réelle d'une oscillation. Au-delà, la tendance devient si lissée qu'elle ne réagit plus
 * à ce que l'agent vient de faire.
 */
const HISTORIQUE_MAX = 5;

/**
 * Écart en mètres sous lequel on ne parle pas de tendance.
 *
 * Deux mètres de variation entre deux relevés sont le bruit normal d'un GPS grand public.
 * Les annoncer comme une amélioration ou une dégradation ferait clignoter l'écran sans rien
 * apprendre à personne.
 */
const BRUIT_M = 2;

function tendanceDe(historique: readonly number[]): TendancePrecision {
  if (historique.length < 2) return "INCONNUE";
  const premier = historique[0];
  const dernier = historique[historique.length - 1];
  const ecart = premier - dernier;
  if (Math.abs(ecart) <= BRUIT_M) return "STABLE";
  // La précision est une INCERTITUDE : elle s'améliore en DIMINUANT.
  return ecart > 0 ? "AMELIORE" : "DEGRADE";
}

export function usePositionGps(): EtatGps {
  const [position, setPosition] = useState<PositionGps | null>(null);
  const [erreur, setErreur] = useState<ErreurGps | null>(null);
  const [enAttente, setEnAttente] = useState(false);
  const [actif, setActif] = useState(false);
  const [historiquePrecisionM, setHistorique] = useState<number[]>([]);
  const veille = useRef<number | null>(null);

  const arreter = useCallback(() => {
    if (veille.current !== null) {
      navigator.geolocation?.clearWatch(veille.current);
      veille.current = null;
    }
    setActif(false);
    setEnAttente(false);
  }, []);

  const demarrer = useCallback(() => {
    if (!navigator.geolocation) {
      setErreur("INDISPONIBLE");
      return;
    }
    // Relancer alors qu'une veille tourne laisserait la premiere active sans personne pour
    // l'arreter : la batterie d'un telephone de terrain ne le pardonne pas.
    if (veille.current !== null) return;

    setErreur(null);
    setEnAttente(true);
    setActif(true);

    veille.current = navigator.geolocation.watchPosition(
      (r) => {
        const precisionM = Math.max(1, Math.round(r.coords.accuracy));
        setPosition({
          lat: r.coords.latitude,
          lon: r.coords.longitude,
          precisionM,
          releveeLe: r.timestamp,
        });
        setHistorique((h) => [...h, precisionM].slice(-HISTORIQUE_MAX));
        setEnAttente(false);
        setErreur(null);
      },
      (e) => {
        setEnAttente(false);
        // `PERMISSION_DENIED` vaut 1 dans la specification. Le distinguer est le seul
        // moyen de dire a l'agent d'aller dans les reglages plutot que de sortir.
        const refusee = e.code === 1;
        setErreur(refusee ? "REFUSEE" : "INDETERMINEE");
        // UN REFUS TERMINE LA VEILLE. Le navigateur n'enverra plus de point : laisser le suivi « actif »
        // gardait le bouton « Arreter le suivi » a l'ecran, sans « Me localiser », et `demarrer` refusait de
        // relancer tant qu'une veille etait ouverte. L'agent, une fois l'autorisation rendue, n'avait aucun
        // geste evident pour reessayer. Un signal INDETERMINE, lui, peut revenir : la veille reste ouverte.
        // `arreter` ne touche pas a l'erreur : le message reste lisible.
        if (refusee) arreter();
      },
      // `enableHighAccuracy` est indispensable en terrain : sans lui, Android rend une
      // position reseau a plusieurs centaines de metres, qu'aucun appariement ne peut
      // exploiter.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }, [arreter]);

  // Arret au demontage : une veille oubliee continue de consommer le GPS apres que l'agent
  // a quitte l'ecran.
  useEffect(() => arreter, [arreter]);

  return {
    position,
    erreur,
    enAttente,
    actif,
    tendance: tendanceDe(historiquePrecisionM),
    historiquePrecisionM,
    demarrer,
    arreter,
  };
}
