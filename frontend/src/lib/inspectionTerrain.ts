/**
 * Fiche d'inspection terrain (BDRI, lot F) : vocabulaire et contrôles AVANT envoi.
 *
 * Mêmes règles que le serveur (`backend/src/modules/inspections/inspections.schema.ts`) : l'agent apprend sur place
 * ce qui serait refusé, au lieu de le découvrir à la synchronisation, parfois des heures plus tard et hors du
 * terrain. Le serveur reste juge.
 */

export const CONSTATS = [
  { code: "DEFAUTS_RELEVES", libelle: "Défauts relevés" },
  { code: "AUCUN_DEFAUT_OBSERVE", libelle: "Aucun défaut observé" },
  { code: "NON_INSPECTE", libelle: "Non inspecté" },
  { code: "INCONNU", libelle: "Inconnu" },
  { code: "NON_APPLICABLE", libelle: "Non applicable" },
] as const;

export const METHODES = [
  { code: "VISUELLE_A_PIED", libelle: "Visuelle, à pied" },
  { code: "VISUELLE_EN_VEHICULE", libelle: "Visuelle, en véhicule" },
  { code: "AUTRE", libelle: "Autre" },
] as const;

export interface SaisieFiche {
  constatDefauts: string;
  defautsConstates: string;
  etatObserve: string;
  debutM: string;
  finM: string;
}

/** Les manques et contradictions, un message chacun ; vide si la fiche peut partir. */
export function manquesFiche(s: SaisieFiche): string[] {
  const out: string[] = [];
  const texte = s.defautsConstates.trim();
  if (s.constatDefauts === "DEFAUTS_RELEVES" && !texte) out.push("Des défauts relevés se décrivent (au moins une ligne).");
  if (["AUCUN_DEFAUT_OBSERVE", "NON_APPLICABLE", "NON_INSPECTE"].includes(s.constatDefauts) && texte) {
    out.push("Ce constat contredit la description de défauts saisie : choisir « Défauts relevés » ou vider la description.");
  }
  if (s.constatDefauts === "NON_INSPECTE" && s.etatObserve !== "NON_EVALUE") out.push("Un objet non inspecté n'a pas d'état observé : choisir « Non évalué ».");
  const d = s.debutM.trim(), f = s.finM.trim();
  if ((d === "") !== (f === "")) out.push("Une section en mètres a un début et une fin.");
  else if (d !== "" && !(Number(f.replace(",", ".")) > Number(d.replace(",", ".")) && Number(d.replace(",", ".")) >= 0)) out.push("La fin de la section est après son début.");
  return out;
}

export const nombreOuRien = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v.replace(",", ".")));
