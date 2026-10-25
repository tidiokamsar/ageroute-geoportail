/**
 * Historique d'une section et classement « à contrôler » : types de la réponse serveur, libellés, et export CSV du classement.
 * Les règles de calcul sont côté serveur (`backend/src/tableau-de-bord/historique.noyau.ts`) ; ici on ne fait que dire et exporter.
 */

export type NatureConstat = "DEFAUT" | "OBSERVATION";

export interface ConstatListe {
  nature: NatureConstat;
  id: string;
  type: string;
  libelle: string;
  gravite: number | "FAIBLE" | "MOYENNE" | "FORTE" | null;
  statut: string;
  etatDefaut: string | null;
  constateA: string;
  confirme: boolean;
  grave: boolean;
}

export interface JourDeConstats { date: string; defauts: number; observations: number; graves: number; confirmes: number; proposes: number }
export interface Recurrence { cle: string; libelle: string; nature: NatureConstat; nbDates: number; premiereFois: string; derniereFois: string; nbConstats: number }

export interface VoletConstats {
  tronconId: string;
  tronconCode: string;
  tronconNom: string;
  historique: {
    total: number; defauts: number; observations: number; confirmes: number; proposes: number; rejetesEcartes: number;
    premierConstat: string | null; dernierConstat: string | null; parJour: JourDeConstats[]; recurrents: Recurrence[];
  };
  liste: ConstatListe[];
  listeTronquee: boolean;
  plafondListe: number;
  lectureIncomplete: boolean;
  avertissements: string[];
}

export interface FacteurClassement { facteur: string; libelle: string; nombre: number; pointsParUnite: number; points: number }
export interface LigneAControler {
  tronconId: string; tronconCode: string; tronconNom: string; regionId: number; regionNom: string;
  score: number; facteurs: FacteurClassement[]; dernierConstat: string | null; explication: string;
}
export interface ResultatAControler {
  genereLe: string;
  lignes: LigneAControler[];
  totalClasses: number;
  sansConstatSurLeReseau: number;
  constatsLus: number;
  lectureIncomplete: boolean;
  poids: { provenance: string; parConstatGrave: number; parConstatEnAttente: number; parRecurrence: number; siInformationAncienne: number; joursFenetreRecente: number; joursSansConstat: number };
  avertissements: string[];
}

export const LIBELLE_STATUT_CONSTAT: Record<string, string> = {
  A_VALIDER: "à valider", VALIDE: "validé", REJETE: "rejeté", A_CORRIGER: "à corriger",
  BROUILLON: "brouillon", PROPOSEE: "proposée", VALIDEE: "validée", REJETEE: "rejetée", CONVERTIE: "convertie",
};

export function libelleGravite(g: ConstatListe["gravite"], nature: NatureConstat): string {
  if (g === null) return "non précisée";
  return nature === "DEFAUT" ? `${g} sur 4` : { FAIBLE: "faible", MOYENNE: "moyenne", FORTE: "forte" }[g as "FAIBLE" | "MOYENNE" | "FORTE"];
}

/** Protège une cellule CSV : guillemets doublés, et une cellule qui commencerait par = + - @ n'est jamais lue comme une formule. */
export function celluleCsv(v: string | number | null): string {
  let t = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** CSV du classement (séparateur « ; », ouvrable dans un tableur français). Reprend les poids provisoires : un export ne perd pas son étiquette. */
export function csvAControler(r: ResultatAControler): string {
  const entete = ["Rang", "Code", "Nom", "Région", "Score", "Dernier constat", "Pourquoi"];
  const lignes = r.lignes.map((l, i) => [i + 1, l.tronconCode, l.tronconNom, l.regionNom, l.score, l.dernierConstat, l.explication]);
  const note = `Classement d'aide au controle, pas une decision. Poids ${r.poids.provenance} (grave ${r.poids.parConstatGrave}, en attente ${r.poids.parConstatEnAttente}, recurrence ${r.poids.parRecurrence}, information ancienne ${r.poids.siInformationAncienne}). Genere le ${r.genereLe}.`;
  return [entete, ...lignes].map((l) => l.map((c) => celluleCsv(c as string | number | null)).join(";")).concat(celluleCsv(note)).join("\r\n");
}
