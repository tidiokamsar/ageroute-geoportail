/**
 * CLASSIFICATION DES RESULTATS D UNE COMPARAISON, CLE STABLE, EMPREINTE DE MESURE, INSTANTANE, ETAT DE CONNEXION (noyau pur, lot S1).
 *
 * Un resultat n est jamais une decision. Quatre issues pour un objet de la source A apparie a un objet de la source B :
 *   - corridor connu et part de A hors du corridor de B au plus egale a la part toleree : CONCORDANCE ;
 *   - corridor connu et part superieure : DIVERGENCE (avec distance de Hausdorff et longueur hors corridor) ;
 *   - corridor inconnu (une precision manque) : RAPPROCHEMENT_INCERTAIN, AUCUNE mesure de divergence ;
 *   - aucun candidat a moins du rayon d appariement : SANS_CORRESPONDANCE_A. Un objet de B qui n est retenu par aucun objet de A : SANS_CORRESPONDANCE_B.
 */

import { createHash } from "node:crypto";
import { normaliserNom } from "../conflits/classification.noyau";
import { TOLERANCE_LONGUEUR_M, type EtatConnexion, type OriginePrecision, type PreuveConnexion, type StatutResultatComparaison } from "./types.noyau";

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Mesure d un couple apparie dont le corridor est connu (metres, au centimetre ; part a 10^-4). */
export interface MesureComparaison {
  hausdorffM: number;
  longueurAM: number;
  longueurBM: number;
  longueurRecouvrementM: number;
  longueurHorsCorridorM: number;
  partHorsCorridor: number;
  distanceMinM: number;
}

export interface CoupleBrut {
  corridorM: number | null;
  hausdorffM: number;
  longueurAM: number;
  longueurBM: number;
  /** Longueur de A comprise dans le tampon de B (rayon : le corridor). Ignoree si le corridor est inconnu. */
  longueurRecouvrementM: number;
  distanceMinM: number;
}

export type ClassementCouple =
  | { statut: "CONCORDANCE" | "DIVERGENCE"; mesure: MesureComparaison }
  | { statut: "RAPPROCHEMENT_INCERTAIN"; mesure: null };

/**
 * Classe un couple apparie. `partHorsCorridorMax` : part toleree (0 = concordance stricte). La tolerance d un centimetre sur la longueur hors
 * corridor est NUMERIQUE (eclats de decoupe du tampon), pas un seuil metier.
 */
export function classerCouple(c: CoupleBrut, partHorsCorridorMax: number): ClassementCouple {
  if (c.corridorM === null) return { statut: "RAPPROCHEMENT_INCERTAIN", mesure: null };
  const longueurA = Math.max(0, c.longueurAM);
  const recouvrement = Math.min(longueurA, Math.max(0, c.longueurRecouvrementM));
  let hors = longueurA - recouvrement;
  if (hors < TOLERANCE_LONGUEUR_M) hors = 0;
  const part = longueurA > 0 ? hors / longueurA : 0;
  const mesure: MesureComparaison = {
    hausdorffM: r2(c.hausdorffM), longueurAM: r2(longueurA), longueurBM: r2(Math.max(0, c.longueurBM)), longueurRecouvrementM: r2(recouvrement),
    longueurHorsCorridorM: r2(hors), partHorsCorridor: r4(part), distanceMinM: r2(Math.max(0, c.distanceMinM)),
  };
  const tolere = Number.isFinite(partHorsCorridorMax) ? Math.min(1, Math.max(0, partHorsCorridorMax)) : 0;
  return { statut: part <= tolere ? "CONCORDANCE" : "DIVERGENCE", mesure };
}

// ------------------------------------------------------------------------------------------------
// Identite et cle stable
// ------------------------------------------------------------------------------------------------

/** Identite d un objet stable d une version a l autre : son nom normalise, sinon l empreinte de sa geometrie (jamais son identifiant). */
export function identiteObjet(nom: string | null, empreinte: string | null): string {
  return nom !== null && nom.trim() !== "" ? `n:${normaliserNom(nom)}` : `e:${empreinte ?? ""}`;
}

/**
 * Cle SHA-256 d un resultat (correctifs T1+S1, M5) : projet, IDENTIFIANT de l objet A (ou vide), identifiant de l objet B (ou vide). Unique par
 * construction (un resultat par objet de A, plus un par objet de B jamais retenu) et stable au rejeu (memes jeux, memes objets) ; independante de
 * l ordre de lecture. Le nom n en fait plus partie : deux objets de meme nom (« Fourreau », « Conduite DN100 ») ne se confondent plus.
 */
export function cleResultat(projetId: string, objetAId: string | null, objetBId: string | null): string {
  return createHash("sha256").update(["s1-2", projetId, objetAId ?? "", objetBId ?? ""].join("\u001f"), "utf8").digest("hex");
}

/** Empreinte (16 hexadecimaux) d une mesure arrondie ; `-` pour un resultat sans mesure. Sert a l instantane et au test d idempotence du rejeu. */
export function empreinteMesureComparaison(m: MesureComparaison | null): string {
  if (m === null) return "-";
  const canon = [m.hausdorffM, m.longueurAM, m.longueurBM, m.longueurRecouvrementM, m.longueurHorsCorridorM, m.partHorsCorridor, m.distanceMinM].join("|");
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------------------------------------
// Resultats ordonnes et instantane
// ------------------------------------------------------------------------------------------------

export interface ObjetCompare {
  id: string;
  nom: string | null;
  empreinte: string;
  longueurM: number;
  precisionM: number | null;
  originePrecision: OriginePrecision;
}

export interface AppariementBrut {
  objetA: ObjetCompare;
  /** Candidat retenu (le mieux recouvert, puis Hausdorff minimale, puis identifiant minimal) ; nul sans candidat. */
  objetB: ObjetCompare | null;
  corridorM: number | null;
  hausdorffM: number | null;
  longueurRecouvrementM: number | null;
  distanceMinM: number | null;
}

export interface ResultatCalcule {
  ordre: number;
  cle: string;
  statut: StatutResultatComparaison;
  objetAId: string | null;
  objetBId: string | null;
  nomA: string | null;
  nomB: string | null;
  precisionAM: number | null;
  precisionBM: number | null;
  origineA: OriginePrecision;
  origineB: OriginePrecision;
  corridorM: number | null;
  mesure: MesureComparaison | null;
  empreinteMesure: string;
}

const comparerCles = (a: { cle: string }, b: { cle: string }) => (a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0);

/**
 * Assemble les resultats d une comparaison : un par objet de A (apparie ou non), puis un par objet de B jamais retenu. AUCUN objet n est ecarte
 * (correctifs T1+S1, M5 : la cle est faite des identifiants d objets, deux objets de meme nom donnent deux resultats). L ordre est celui des cles :
 * il ne depend pas de l ordre de lecture (rejeu idempotent). Un objet de A present deux fois dans les appariements est une erreur du calcul.
 */
export function assemblerResultats(projetId: string, appariements: readonly AppariementBrut[], objetsB: readonly ObjetCompare[], partHorsCorridorMax: number): ResultatCalcule[] {
  const retenus = new Set<string>();
  const parCle = new Map<string, ResultatCalcule>();
  const garder = (r: ResultatCalcule) => {
    if (parCle.has(r.cle)) throw new Error(`comparaison : resultat en double pour la cle ${r.cle} (un objet ne donne qu'un resultat)`);
    parCle.set(r.cle, r);
  };
  for (const a of appariements) {
    if (a.objetB === null) {
      garder({
        ordre: 0, cle: cleResultat(projetId, a.objetA.id, null), statut: "SANS_CORRESPONDANCE_A", objetAId: a.objetA.id, objetBId: null, nomA: a.objetA.nom, nomB: null,
        precisionAM: a.objetA.precisionM, precisionBM: null, origineA: a.objetA.originePrecision, origineB: "INCONNUE", corridorM: null,
        mesure: null, empreinteMesure: empreinteMesureComparaison(null),
      });
      continue;
    }
    retenus.add(a.objetB.id);
    const classement = classerCouple({
      corridorM: a.corridorM, hausdorffM: a.hausdorffM ?? 0, longueurAM: a.objetA.longueurM, longueurBM: a.objetB.longueurM,
      longueurRecouvrementM: a.longueurRecouvrementM ?? 0, distanceMinM: a.distanceMinM ?? 0,
    }, partHorsCorridorMax);
    garder({
      ordre: 0, cle: cleResultat(projetId, a.objetA.id, a.objetB.id), statut: classement.statut,
      objetAId: a.objetA.id, objetBId: a.objetB.id, nomA: a.objetA.nom, nomB: a.objetB.nom,
      precisionAM: a.objetA.precisionM, precisionBM: a.objetB.precisionM, origineA: a.objetA.originePrecision, origineB: a.objetB.originePrecision,
      corridorM: classement.statut === "RAPPROCHEMENT_INCERTAIN" ? null : a.corridorM, mesure: classement.mesure, empreinteMesure: empreinteMesureComparaison(classement.mesure),
    });
  }
  for (const b of objetsB) {
    if (retenus.has(b.id)) continue;
    garder({
      ordre: 0, cle: cleResultat(projetId, null, b.id), statut: "SANS_CORRESPONDANCE_B", objetAId: null, objetBId: b.id, nomA: null, nomB: b.nom,
      precisionAM: null, precisionBM: b.precisionM, origineA: "INCONNUE", origineB: b.originePrecision, corridorM: null, mesure: null, empreinteMesure: empreinteMesureComparaison(null),
    });
  }
  return [...parCle.values()].sort(comparerCles).map((r, i) => ({ ...r, ordre: i + 1 }));
}

/** Instantane { cle : statut|empreinte } : deux comparaisons sur les memes entrees donnent le meme instantane. */
export function instantaneDe(resultats: readonly ResultatCalcule[]): Record<string, string> {
  const sortie: Record<string, string> = {};
  for (const r of resultats) sortie[r.cle] = `${r.statut}|${r.empreinteMesure}`;
  return sortie;
}

export interface TotauxComparaison { parStatut: Record<StatutResultatComparaison, number>; couplesSansCorridor: number; corridorMinM: number | null; corridorMaxM: number | null }

export function totauxDe(resultats: readonly ResultatCalcule[]): TotauxComparaison {
  const parStatut: Record<StatutResultatComparaison, number> = { CONCORDANCE: 0, DIVERGENCE: 0, RAPPROCHEMENT_INCERTAIN: 0, SANS_CORRESPONDANCE_A: 0, SANS_CORRESPONDANCE_B: 0 };
  let min: number | null = null, max: number | null = null;
  for (const r of resultats) {
    parStatut[r.statut] += 1;
    if (r.corridorM !== null) { min = min === null ? r.corridorM : Math.min(min, r.corridorM); max = max === null ? r.corridorM : Math.max(max, r.corridorM); }
  }
  return { parStatut, couplesSansCorridor: parStatut.RAPPROCHEMENT_INCERTAIN, corridorMinM: min, corridorMaxM: max };
}

// ------------------------------------------------------------------------------------------------
// Etat de connexion d un objet (ce qui a ete fourni, jamais deduit)
// ------------------------------------------------------------------------------------------------

export interface ConnexionDeclaree { statut: string; preuve: PreuveConnexion | string | null }

export interface EtatConnexionObjet { etat: EtatConnexion; nbConfirmees: number; nbInconnues: number; libelle: string }

/**
 * CONFIRMEE : au moins une connexion VALIDEE de preuve CONFIRMEE_PAR_FOURNISSEUR ; INCONNUE : des connexions validees, toutes de preuve INCONNUE ;
 * NON_FOURNIE : aucune connexion validee. Les relations proposees, refusees ou revoquees ne comptent pas.
 */
export function etatConnexion(connexions: readonly ConnexionDeclaree[]): EtatConnexionObjet {
  const validees = connexions.filter((c) => c.statut === "VALIDEE");
  const nbConfirmees = validees.filter((c) => c.preuve === "CONFIRMEE_PAR_FOURNISSEUR").length;
  const nbInconnues = validees.filter((c) => c.preuve === "INCONNUE").length;
  const etat: EtatConnexion = nbConfirmees > 0 ? "CONFIRMEE" : nbInconnues > 0 ? "INCONNUE" : "NON_FOURNIE";
  return {
    etat, nbConfirmees, nbInconnues,
    libelle: "État de connexion déclaré par la source ou saisi par une personne : aucune connexion n'est déduite d'une proximité géométrique ; « non fournie » ne veut pas dire « isolé ».",
  };
}
