/**
 * Évaluation d'un modèle de vision sur des images de routes (SMART FIELD, phase 4) : le BANC DE MESURE, sans aucun modèle.
 *
 * Ce module ne contient ni modèle ni poids : il dit seulement, à partir de détections et d'annotations FOURNIES, si un modèle
 * atteint les critères d'acceptation. Il sert le jour où le corpus guinéen existe ; d'ici là il est éprouvé sur des cas fabriqués
 * dont le résultat est calculable à la main.
 *
 * RÈGLES DE LA MESURE
 *   - une détection est JUSTE si elle a la même classe qu'une annotation encore libre et un recouvrement (IoU) d'au moins
 *     `seuilIou` ; chaque annotation ne sert qu'une fois (la détection de plus grande confiance d'abord) ;
 *   - la précision, le rappel et les fausses alertes par km ne sont calculés que sur des images ANNOTÉES PAR UN AGENT et que le
 *     modèle n'a JAMAIS vues : l'appelant l'atteste (`imagesInedites`), sinon le verdict est « non mesuré » ;
 *   - une mesure qu'on n'a pas faite est « non mesuré », jamais zéro ni « conforme » ;
 *   - un modèle qui ne dit rien (aucune détection) a un rappel nul, pas une précision parfaite : la précision d'un ensemble vide
 *     de détections est « non définie », pas 100 %.
 */

export interface Boite { x: number; y: number; l: number; h: number }
export interface Annotation { image: string; classe: string; boite: Boite }
export interface Detection { image: string; classe: string; boite: Boite; confiance: number }

/** Recouvrement de deux boîtes (intersection sur union), de 0 à 1. */
export function iou(a: Boite, b: Boite): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.l, b.x + b.l), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.l * a.h + b.l * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export interface ResultatClasse {
  classe: string;
  annotations: number;
  detections: number;
  vraisPositifs: number;
  fausseAlertes: number;
  manques: number;
  /** `null` : non défini (aucune détection, ou aucune annotation). */
  precision: number | null;
  rappel: number | null;
}

export function evaluerDetections(
  annotations: readonly Annotation[],
  detections: readonly Detection[],
  options: { seuilIou?: number; seuilConfiance?: number } = {},
): ResultatClasse[] {
  const seuilIou = options.seuilIou ?? 0.5;
  const seuilConfiance = options.seuilConfiance ?? 0;
  const classes = [...new Set([...annotations.map((a) => a.classe), ...detections.map((d) => d.classe)])].sort();
  const retenues = detections.filter((d) => d.confiance >= seuilConfiance);
  const sortie: ResultatClasse[] = [];
  for (const classe of classes) {
    const annotsClasse = annotations.filter((a) => a.classe === classe);
    const detsClasse = retenues.filter((d) => d.classe === classe).sort((a, b) => b.confiance - a.confiance);
    const utilisees = new Set<Annotation>();
    let vrais = 0;
    for (const d of detsClasse) {
      let meilleure: Annotation | null = null, meilleurIou = 0;
      for (const a of annotsClasse) {
        if (a.image !== d.image || utilisees.has(a)) continue;
        const v = iou(a.boite, d.boite);
        if (v >= seuilIou && v > meilleurIou) { meilleure = a; meilleurIou = v; }
      }
      if (meilleure) { utilisees.add(meilleure); vrais += 1; }
    }
    sortie.push({
      classe, annotations: annotsClasse.length, detections: detsClasse.length,
      vraisPositifs: vrais, fausseAlertes: detsClasse.length - vrais, manques: annotsClasse.length - vrais,
      precision: detsClasse.length > 0 ? vrais / detsClasse.length : null,
      rappel: annotsClasse.length > 0 ? vrais / annotsClasse.length : null,
    });
  }
  return sortie;
}

/** Centile d'une série (méthode du rang le plus proche) ; `null` si la série est vide. */
export function centile(valeurs: readonly number[], p: number): number | null {
  if (valeurs.length === 0) return null;
  const tri = [...valeurs].sort((a, b) => a - b);
  return tri[Math.min(tri.length - 1, Math.max(0, Math.ceil((p / 100) * tri.length) - 1))];
}

// ------------------------------------------------------------------ critères d'acceptation

/**
 * CRITÈRES D'ACCEPTATION PROVISOIRES (fixés le 25/10/2026 sur délégation du DSI, voir `docs/pilotage/CRITERES-VISION.md`).
 *
 * Ce sont des POINTS DE DÉPART choisis, pas des normes : aucune mesure guinéenne ne les fonde. Ils sont à réviser après la
 * première mesure du pilote, par une décision datée. Un modèle qui les atteint n'est pas « validé » : il est autorisé à
 * SUGGÉRER, un agent confirme toujours.
 */
export const CRITERES_PROVISOIRES = {
  provenance: "PROVISOIRE_NON_CALIBRE",
  precisionMin: 0.7,
  rappelMin: 0.6,
  fausseAlertesParKmMax: 2,
  latenceP95MsMax: 1500,
  memoirePicMoMax: 300,
  surconsommationBatteriePctParHeureMax: 10,
  tailleModeleMoMax: 30,
  /** Instances annotées minimales, par classe, pour que la précision et le rappel comptent. */
  instancesMinParClasse: 100,
  /** Images guinéennes inédites minimales, au total. */
  imagesIneditesMin: 300,
} as const;

export type Critere = "precision" | "rappel" | "fausses_alertes_par_km" | "latence_p95" | "memoire_pic" | "batterie" | "taille_modele" | "effectif";
export type VerdictCritere = { critere: Critere; statut: "atteint" | "non_atteint" | "non_mesure"; mesure: number | null; seuil: number; detail: string };

export interface MesuresModele {
  /** Atteste que les images d'essai sont annotées par un agent ET jamais vues à l'entraînement. Sans cela, rien n'est mesuré. */
  imagesInedites: boolean;
  nbImages: number;
  resultats: ResultatClasse[];
  kmParcourus: number | null;
  latencesMs: number[];
  memoirePicMo: number | null;
  surconsommationBatteriePctParHeure: number | null;
  tailleModeleMo: number | null;
}

export function verdict(m: MesuresModele, c: typeof CRITERES_PROVISOIRES = CRITERES_PROVISOIRES): { acceptable: boolean; criteres: VerdictCritere[] } {
  const nonMesure = (critere: Critere, seuil: number, detail: string): VerdictCritere => ({ critere, statut: "non_mesure", mesure: null, seuil, detail });
  const borne = (critere: Critere, mesure: number | null, seuil: number, ok: (v: number) => boolean, detail: string): VerdictCritere =>
    mesure === null ? nonMesure(critere, seuil, detail) : { critere, statut: ok(mesure) ? "atteint" : "non_atteint", mesure, seuil, detail };

  const exploitable = m.imagesInedites;
  const total = (cle: "vraisPositifs" | "detections" | "annotations" | "fausseAlertes") => m.resultats.reduce((n, r) => n + r[cle], 0);
  const precision = exploitable && total("detections") > 0 ? total("vraisPositifs") / total("detections") : null;
  const rappel = exploitable && total("annotations") > 0 ? total("vraisPositifs") / total("annotations") : null;
  const parKm = exploitable && m.kmParcourus !== null && m.kmParcourus > 0 ? total("fausseAlertes") / m.kmParcourus : null;
  const rareteClasses = m.resultats.filter((r) => r.annotations < c.instancesMinParClasse);
  const effectifOk = exploitable && m.nbImages >= c.imagesIneditesMin && rareteClasses.length === 0 && m.resultats.length > 0;

  const criteres: VerdictCritere[] = [
    exploitable
      ? { critere: "effectif", statut: effectifOk ? "atteint" : "non_atteint", mesure: m.nbImages, seuil: c.imagesIneditesMin,
          detail: effectifOk ? "Effectif suffisant." : `Effectif insuffisant : ${m.nbImages} image(s) (minimum ${c.imagesIneditesMin}) ; classes sous ${c.instancesMinParClasse} instances : ${rareteClasses.map((r) => `${r.classe} (${r.annotations})`).join(", ") || "aucune"}.` }
      : nonMesure("effectif", c.imagesIneditesMin, "Les images d'essai ne sont pas attestées inédites et annotées par un agent."),
    borne("precision", precision, c.precisionMin, (v) => v >= c.precisionMin, exploitable ? "Vrais positifs sur détections, toutes classes." : "Images non attestées inédites."),
    borne("rappel", rappel, c.rappelMin, (v) => v >= c.rappelMin, exploitable ? "Vrais positifs sur annotations, toutes classes." : "Images non attestées inédites."),
    borne("fausses_alertes_par_km", parKm, c.fausseAlertesParKmMax, (v) => v <= c.fausseAlertesParKmMax, m.kmParcourus === null ? "Kilomètres parcourus non renseignés." : "Fausses alertes sur kilomètres parcourus."),
    borne("latence_p95", centile(m.latencesMs, 95), c.latenceP95MsMax, (v) => v <= c.latenceP95MsMax, "95e centile du temps de traitement d'une image, sur l'appareil le plus modeste."),
    borne("memoire_pic", m.memoirePicMo, c.memoirePicMoMax, (v) => v <= c.memoirePicMoMax, "Mémoire de pointe pendant l'inférence."),
    borne("batterie", m.surconsommationBatteriePctParHeure, c.surconsommationBatteriePctParHeureMax, (v) => v <= c.surconsommationBatteriePctParHeureMax, "Batterie consommée en plus par heure, par rapport à la collecte sans modèle."),
    borne("taille_modele", m.tailleModeleMo, c.tailleModeleMoMax, (v) => v <= c.tailleModeleMoMax, "Poids du modèle à télécharger sur le téléphone."),
  ];
  // « Acceptable » exige que TOUT soit mesuré et atteint : une case non mesurée n'est jamais conforme.
  return { acceptable: criteres.every((x) => x.statut === "atteint"), criteres };
}
