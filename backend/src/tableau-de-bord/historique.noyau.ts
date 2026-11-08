/**
 * Historique d'une section et classement « à contrôler » (SMART FIELD, phase 6) : le NOYAU, sans base ni réseau.
 *
 * CE QUE C'EST
 *   - l'historique d'un tronçon : les constats de terrain (défauts et observations), regroupés par jour de constat, avec les
 *     récurrences (même type constaté à au moins deux dates distinctes) ;
 *   - un classement des tronçons « à contrôler », EXPLICABLE : chaque ligne porte les facteurs qui la composent et leurs points.
 *
 * CE QUE CE N'EST PAS
 *   - une décision : le classement dit où un humain doit regarder en premier, jamais quoi réparer. La programmation des
 *     interventions reste au moteur de programmation (paramètres provisoires, à approuver) ;
 *   - une évaluation de l'état de la route : un constat de terrain est un constat, pas un indice d'état (le RCI reste désapprouvé) ;
 *   - un mélange : une observation proposée n'est pas un défaut validé. Les deux comptes restent séparés partout.
 *   - un double compte : un défaut vit dans une observation « conteneur » créée par le serveur ; le service ne lit pas ces
 *     conteneurs (une observation qui porte un défaut est lue par son défaut), sinon chaque défaut compterait deux fois.
 *
 * RÈGLES
 *   - un constat REJETÉ n'est pas un fait : il est écarté de tout (historique, récurrence, classement) ;
 *   - « confirmé » = validé par un tiers (défaut VALIDE, observation VALIDEE ou CONVERTIE) ; le reste est « proposé » ;
 *   - une gravité est « grave » selon une règle ÉCRITE ici (défaut de gravité 3 ou 4 sur 4, observation FORTE), pas deviné ;
 *   - un tronçon sans aucun constat n'est PAS classé : « jamais relevé » n'est pas un risque mesuré, c'est une absence de donnée,
 *     comptée à part.
 *
 * Les poids du classement sont des POINTS DE DÉPART PROVISOIRES, non calibrés ; ils sont rendus avec chaque résultat.
 */

export type NatureConstat = "DEFAUT" | "OBSERVATION";

export interface Constat {
  nature: NatureConstat;
  id: string;
  /** Code du catalogue pour un défaut, type pour une observation. */
  type: string;
  libelle: string;
  /** Gravité telle que saisie : défaut 1 à 4, observation FAIBLE / MOYENNE / FORTE, ou null. */
  gravite: number | "FAIBLE" | "MOYENNE" | "FORTE" | null;
  /** Statut tel que le serveur le porte (A_VALIDER, VALIDE, REJETE, A_CORRIGER, PROPOSEE, VALIDEE, REJETEE, CONVERTIE, BROUILLON). */
  statut: string;
  /** Défaut seulement : ACTIF, TRAITE ou DISPARU. Un défaut traité ou disparu n'est plus un problème présent. */
  etatDefaut?: string | null;
  constateA: Date;
}

export const STATUTS_REJETES = new Set(["REJETE", "REJETEE"]);
export const STATUTS_CONFIRMES = new Set(["VALIDE", "VALIDEE", "CONVERTIE"]);

/** Un constat écarté de toute analyse : rejeté. */
export const estRetenu = (c: Constat): boolean => !STATUTS_REJETES.has(c.statut);
export const estConfirme = (c: Constat): boolean => STATUTS_CONFIRMES.has(c.statut);

/** Défaut de gravité 3 ou 4 (sur 4) ou observation FORTE. Règle écrite, provisoire. */
export function estGrave(c: Constat): boolean {
  if (c.nature === "DEFAUT") return typeof c.gravite === "number" && c.gravite >= 3;
  return c.gravite === "FORTE";
}

/** Un défaut TRAITE ou DISPARU n'est plus présent : il reste dans l'histoire, pas dans « ce qui est à contrôler maintenant ». */
export const estPresent = (c: Constat): boolean => !(c.nature === "DEFAUT" && c.etatDefaut && c.etatDefaut !== "ACTIF");

export const jourDe = (d: Date): string => d.toISOString().slice(0, 10);

export interface JourDeConstats {
  date: string;
  defauts: number;
  observations: number;
  graves: number;
  confirmes: number;
  proposes: number;
}

export interface Recurrence {
  /** `DEFAUT:CODE` ou `OBSERVATION:TYPE`. */
  cle: string;
  libelle: string;
  nature: NatureConstat;
  /** Nombre de JOURS distincts où ce type a été constaté. */
  nbDates: number;
  premiereFois: string;
  derniereFois: string;
  nbConstats: number;
}

export interface HistoriqueSection {
  total: number;
  defauts: number;
  observations: number;
  confirmes: number;
  proposes: number;
  rejetesEcartes: number;
  premierConstat: string | null;
  dernierConstat: string | null;
  parJour: JourDeConstats[];
  recurrents: Recurrence[];
}

export function historiqueDeConstats(constats: readonly Constat[]): HistoriqueSection {
  const retenus = constats.filter(estRetenu);
  const parJour = new Map<string, JourDeConstats>();
  for (const c of retenus) {
    const date = jourDe(c.constateA);
    const j = parJour.get(date) ?? { date, defauts: 0, observations: 0, graves: 0, confirmes: 0, proposes: 0 };
    if (c.nature === "DEFAUT") j.defauts += 1; else j.observations += 1;
    if (estGrave(c)) j.graves += 1;
    if (estConfirme(c)) j.confirmes += 1; else j.proposes += 1;
    parJour.set(date, j);
  }
  const jours = [...parJour.values()].sort((a, b) => a.date.localeCompare(b.date));

  const parType = new Map<string, { libelle: string; nature: NatureConstat; dates: Set<string>; n: number }>();
  for (const c of retenus) {
    const cle = `${c.nature}:${c.type}`;
    const r = parType.get(cle) ?? { libelle: c.libelle, nature: c.nature, dates: new Set<string>(), n: 0 };
    r.dates.add(jourDe(c.constateA));
    r.n += 1;
    parType.set(cle, r);
  }
  const recurrents: Recurrence[] = [...parType.entries()]
    .filter(([, r]) => r.dates.size >= 2)
    .map(([cle, r]) => {
      const d = [...r.dates].sort();
      return { cle, libelle: r.libelle, nature: r.nature, nbDates: r.dates.size, premiereFois: d[0], derniereFois: d[d.length - 1], nbConstats: r.n };
    })
    .sort((a, b) => b.nbDates - a.nbDates || a.cle.localeCompare(b.cle));

  const confirmes = retenus.filter(estConfirme).length;
  return {
    total: retenus.length,
    defauts: retenus.filter((c) => c.nature === "DEFAUT").length,
    observations: retenus.filter((c) => c.nature === "OBSERVATION").length,
    confirmes,
    proposes: retenus.length - confirmes,
    rejetesEcartes: constats.length - retenus.length,
    premierConstat: jours[0]?.date ?? null,
    dernierConstat: jours[jours.length - 1]?.date ?? null,
    parJour: jours,
    recurrents,
  };
}

// ------------------------------------------------------------------ classement « à contrôler »

/**
 * POIDS PROVISOIRES du classement : points de départ choisis le 25/10/2026, jamais mesurés ni approuvés. Rendus avec chaque
 * résultat. Les changer est une décision datée, pas une correction silencieuse.
 */
export interface PoidsClassement {
  provenance: string;
  parConstatGrave: number;
  parConstatEnAttente: number;
  parRecurrence: number;
  siInformationAncienne: number;
  joursFenetreRecente: number;
  joursSansConstat: number;
}

export const POIDS_PROVISOIRES: PoidsClassement = {
  provenance: "PROVISOIRE_NON_CALIBRE",
  /** Par constat grave et présent, dans la fenêtre récente. */
  parConstatGrave: 3,
  /** Par constat proposé (non tranché) et présent : il attend un humain, donc un contrôle. */
  parConstatEnAttente: 1,
  /** Par type de constat présent à au moins deux dates : un problème qui revient. */
  parRecurrence: 2,
  /** Si le dernier constat est plus ancien que `joursSansConstat` : l'information a vieilli. */
  siInformationAncienne: 2,
  joursFenetreRecente: 180,
  joursSansConstat: 365,
};

export interface FacteurClassement {
  facteur: "constats_graves" | "constats_en_attente" | "recurrences" | "information_ancienne";
  libelle: string;
  /** Combien d'éléments ont déclenché ce facteur. */
  nombre: number;
  pointsParUnite: number;
  points: number;
}

export interface LigneAControler {
  tronconId: string;
  score: number;
  facteurs: FacteurClassement[];
  dernierConstat: string | null;
  /** Phrase de lecture : pourquoi ce tronçon est là. */
  explication: string;
}

export interface EntreeClassement {
  tronconId: string;
  constats: readonly Constat[];
}

export function classerAControler(
  troncons: readonly EntreeClassement[],
  maintenant: Date,
  poids: PoidsClassement = POIDS_PROVISOIRES,
): { lignes: LigneAControler[]; sansConstat: number; ecartesSansPoints: number; poids: PoidsClassement } {
  const limiteRecente = maintenant.getTime() - poids.joursFenetreRecente * 86_400_000;
  const limiteAncienne = maintenant.getTime() - poids.joursSansConstat * 86_400_000;
  const lignes: LigneAControler[] = [];
  let sansConstat = 0;
  let ecartesSansPoints = 0;

  for (const t of troncons) {
    const retenus = t.constats.filter(estRetenu);
    if (retenus.length === 0) { sansConstat += 1; continue; }
    const presents = retenus.filter(estPresent);
    const h = historiqueDeConstats(presents);
    const graves = presents.filter((c) => estGrave(c) && c.constateA.getTime() >= limiteRecente).length;
    const enAttente = presents.filter((c) => !estConfirme(c)).length;
    const dernier = retenus.reduce((m, c) => (c.constateA > m ? c.constateA : m), retenus[0].constateA);
    const ancienne = dernier.getTime() < limiteAncienne;

    const tous: FacteurClassement[] = [
      { facteur: "constats_graves", libelle: `constat(s) grave(s) présent(s) dans les ${poids.joursFenetreRecente} derniers jours`, nombre: graves, pointsParUnite: poids.parConstatGrave, points: graves * poids.parConstatGrave },
      { facteur: "constats_en_attente", libelle: "constat(s) proposé(s), pas encore tranché(s) par un responsable", nombre: enAttente, pointsParUnite: poids.parConstatEnAttente, points: enAttente * poids.parConstatEnAttente },
      { facteur: "recurrences", libelle: "type(s) de constat revenu(s) à au moins deux dates", nombre: h.recurrents.length, pointsParUnite: poids.parRecurrence, points: h.recurrents.length * poids.parRecurrence },
      { facteur: "information_ancienne", libelle: `dernier constat de plus de ${poids.joursSansConstat} jours`, nombre: ancienne ? 1 : 0, pointsParUnite: poids.siInformationAncienne, points: ancienne ? poids.siInformationAncienne : 0 },
    ];
    const facteurs = tous.filter((f) => f.points > 0);
    const score = facteurs.reduce((n, f) => n + f.points, 0);
    if (score === 0) { ecartesSansPoints += 1; continue; }
    lignes.push({
      tronconId: t.tronconId, score, facteurs, dernierConstat: jourDe(dernier),
      explication: facteurs.map((f) => `${f.nombre} ${f.libelle} (${f.nombre} × ${f.pointsParUnite} = ${f.points})`).join(" ; ") + ` : total ${score}.`,
    });
  }
  // Égalité : le plus récent constat d'abord, puis l'identifiant, pour qu'un classement soit reproductible.
  lignes.sort((a, b) => b.score - a.score || (b.dernierConstat ?? "").localeCompare(a.dernierConstat ?? "") || a.tronconId.localeCompare(b.tronconId));
  return { lignes, sansConstat, ecartesSansPoints, poids };
}
