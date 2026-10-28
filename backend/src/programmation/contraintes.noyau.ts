/**
 * CONTRAINTES DU SIMULATEUR : options d'une simulation, leur validation, et la SELECTION sous contraintes.
 * Aucun acces base, aucune horloge.
 *
 * CE QUE LE SIMULATEUR RETIENT, DANS CET ORDRE (chaque etape est nommee dans la ligne qui en resulte)
 *
 *   1. OBLIGATOIRES. Les interventions obligatoires sont examinees en premier, dans l'ordre d'arbitrage. Une
 *      obligatoire qui ne tient pas dans l'enveloppe ou dans un plafond regional N'EST PAS RETENUE : elle est
 *      ecartee avec son vrai motif ET rendue dans `insatisfaisables`. Le simulateur ne depasse jamais l'enveloppe
 *      pour la financer, ne raccourcit jamais son cout (« pas d'ajustement silencieux »).
 *   2. PLANCHER REGIONAL (logique `equilibre_territorial` seulement). Voir la regle ci-dessous.
 *   3. ORDRE D'ARBITRAGE. Les autres interventions, dans l'ordre de la logique choisie (`logiques.noyau.ts`), chacune
 *      retenue si elle tient dans le reste de l'enveloppe et dans le plafond de sa region.
 *
 * COUTS NON DIVISIBLES. Le moteur n'a pas de portion : une intervention couvre le troncon entier et son cout n'est
 * jamais fractionne. En PLUS de cela, un GROUPE NON DIVISIBLE est un ensemble de troncons qui se finance ensemble
 * ou pas du tout (un lot de travaux d'un seul tenant, par exemple). Son cout est la SOMME de ses membres. Le groupe
 * est retenu entier ou ecarte entier ; si l'un de ses membres n'est pas chiffrable ou absent des candidats, tout le
 * groupe est ecarte (`EXCLUE_CONTRAINTE`). Un groupe qui contient une obligatoire est obligatoire en entier.
 * PROVISOIRE : « non divisible » est lu ainsi faute de definition metier (cahier 7.2, non detaille).
 *
 * REGLES DE FINANCEMENT : aucune n'existe dans le modele de donnees (la source de financement d'un chantier est un
 * texte libre, celle d'un marche une cle etrangere). Elles ne sont donc PAS modelisees ; le resultat le dit dans ses
 * limites. Les plafonds regionaux de `EntreesScenario` restent le seul levier territorial de plafonnement.
 *
 * REGLE D'EQUILIBRE TERRITORIAL (explicite, testee) : soit p la part minimale (entier de 1 a 100) et E l'enveloppe.
 * Le plancher d'une region est floor(E x p / 100) GNF (entiers). Pour chaque region presente parmi les candidats, par
 * numero croissant, tant que sa depense (obligatoires comprises) est INFERIEURE a son plancher, on retient la prochaine
 * intervention de cette region dans l'ordre ratio cout/impact qui tient dans le reste et dans les plafonds. Le plancher
 * peut donc etre DEPASSE par la derniere intervention retenue (un cout ne se divise pas) : c'est un minimum, pas un
 * plafond. Une intervention qui ne tient pas n'est pas ecartee a ce stade : elle est re-examinee a l'etape 3. Le plancher
 * est un classement prioritaire, pas un budget bloque : l'argent non depense reste disponible pour la suite. Une region
 * qui n'atteint pas son plancher (pas assez de candidats chiffrables, ou enveloppe epuisee par les regions precedentes)
 * est rendue dans `insatisfaisables`. Il faut p x (nombre de regions candidates) <= 100, sinon les entrees sont refusees.
 * Les troncons sans region ne participent pas aux planchers (ils restent selectionnables a l'etape 3).
 */

import type { LigneBareme } from "../engines/cout.noyau";
import { jourValide, verifierVersionBaremes, type PeriodeSimulation, type VersionBaremes } from "./comparaison.baremes.noyau";
import { CODES_LOGIQUE, estCodeLogique, logiqueDe, type CodeLogique, type ElementClassable } from "./logiques.noyau";

export const VERSION_OPTIONS = 1 as const;

export interface OptionsSimulation {
  /** Version du FORMAT de ce bloc : un champ optionnel versionne des entrees canoniques (absent = scenario hérité). */
  version: typeof VERSION_OPTIONS;
  periode: PeriodeSimulation;
  devise: "GNF";
  logique: CodeLogique;
  /** Ordre voulu (logique `personnalise` seulement) : identifiants de troncons, le premier est le plus prioritaire. */
  ordrePersonnalise: string[];
  /** Part minimale par region en pourcent (logique `equilibre_territorial` seulement). */
  equilibre: { partMinimaleParRegionPct: number } | null;
  obligatoires: string[];
  groupesNonDivisibles: string[][];
  baremes: VersionBaremes;
  /**
   * INTERFACE ATTENDUE DU LOT 3 : rang de PRIORITE TECHNIQUE par identifiant de troncon (1 = le plus prioritaire),
   * fourni par `priorite*.ts`. Absent tant que le lot 3 n'est pas integre : la ligne affiche alors le rang du moteur
   * v2 (risque courant decroissant). Ces rangs sont AFFICHES a cote de l'ordre d'arbitrage, ils ne le remplacent jamais.
   */
  rangsTechniques: Record<string, number> | null;
  /** Perimetre demande (information : les entrees faisant foi sont les candidats stockes). */
  perimetre: { regionId: number | null; classe: string | null; selection: string[] | null };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const tri = (l: readonly string[]): string[] => [...l].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Forme normalisee : tableaux sans ordre propre tries, ordre personnalise conserve (il porte le sens). */
export function normaliserOptions(o: OptionsSimulation): OptionsSimulation {
  return {
    ...o,
    obligatoires: tri(o.obligatoires),
    groupesNonDivisibles: o.groupesNonDivisibles.map(tri).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    perimetre: { ...o.perimetre, selection: o.perimetre.selection === null ? null : tri(o.perimetre.selection) },
  };
}

export function optionsVersJson(o: OptionsSimulation): Json {
  const n = normaliserOptions(o);
  return {
    version: n.version,
    periode: { debut: n.periode.debut, fin: n.periode.fin },
    devise: n.devise,
    logique: n.logique,
    ordrePersonnalise: n.ordrePersonnalise,
    equilibre: n.equilibre === null ? null : { partMinimaleParRegionPct: n.equilibre.partMinimaleParRegionPct },
    obligatoires: n.obligatoires,
    groupesNonDivisibles: n.groupesNonDivisibles,
    baremes: n.baremes as unknown as Json,
    rangsTechniques: n.rangsTechniques === null ? null : { ...n.rangsTechniques },
    perimetre: { regionId: n.perimetre.regionId, classe: n.perimetre.classe, selection: n.perimetre.selection },
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const chaines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Relit le bloc stocke. Forme seulement : le fond est juge par `validerOptions`. Les entrees mal formees sont refusees, pas corrigees. */
export function optionsDepuisJson(j: unknown): { ok: true; options: OptionsSimulation } | { ok: false; erreurs: string[] } {
  const o = obj(j);
  const erreurs: string[] = [];
  if (o.version !== VERSION_OPTIONS) erreurs.push(`simulation.version : ${VERSION_OPTIONS} attendu`);
  const per = obj(o.periode);
  const eq = o.equilibre === null || o.equilibre === undefined ? null : obj(o.equilibre);
  const groupes = Array.isArray(o.groupesNonDivisibles) ? o.groupesNonDivisibles : [];
  if (!Array.isArray(o.groupesNonDivisibles)) erreurs.push("simulation.groupesNonDivisibles : tableau attendu");
  if (!Array.isArray(o.obligatoires)) erreurs.push("simulation.obligatoires : tableau attendu");
  if (!Array.isArray(o.ordrePersonnalise)) erreurs.push("simulation.ordrePersonnalise : tableau attendu");
  const bar = obj(o.baremes);
  const rt = o.rangsTechniques === null || o.rangsTechniques === undefined ? null : obj(o.rangsTechniques);
  const pp = obj(o.perimetre);
  if (erreurs.length > 0) return { ok: false, erreurs };
  const options: OptionsSimulation = {
    version: VERSION_OPTIONS,
    periode: { debut: per.debut as string, fin: per.fin as string },
    devise: o.devise as "GNF",
    logique: o.logique as CodeLogique,
    ordrePersonnalise: chaines(o.ordrePersonnalise),
    equilibre: eq === null ? null : { partMinimaleParRegionPct: eq.partMinimaleParRegionPct as number },
    obligatoires: chaines(o.obligatoires),
    groupesNonDivisibles: groupes.map(chaines),
    baremes: { empreinte: bar.empreinte as string, liste: (Array.isArray(bar.liste) ? bar.liste : []) as VersionBaremes["liste"] },
    rangsTechniques: rt === null ? null : (rt as Record<string, number>),
    perimetre: {
      regionId: typeof pp.regionId === "number" ? pp.regionId : null,
      classe: typeof pp.classe === "string" ? pp.classe : null,
      selection: Array.isArray(pp.selection) ? chaines(pp.selection) : null,
    },
  };
  return { ok: true, options };
}

export interface ContexteValidation {
  annee: number;
  candidatIds: ReadonlySet<string>;
  /** Regions des candidats (non nulles), sans doublon. */
  regionsCandidates: readonly number[];
  baremes: readonly LigneBareme[];
}

const doublons = (l: readonly string[]): string[] => l.filter((x, i) => l.indexOf(x) !== i);

/** Jugement de fond des options. Vide = valides. Rien n'est corrige : une option incoherente est un refus. */
export function validerOptions(o: OptionsSimulation, c: ContexteValidation): string[] {
  const err: string[] = [];
  if (o.version !== VERSION_OPTIONS) err.push(`simulation.version : ${VERSION_OPTIONS} attendu`);
  if (!jourValide(o.periode?.debut)) err.push("simulation.periode.debut : date AAAA-MM-JJ valide attendue");
  if (!jourValide(o.periode?.fin)) err.push("simulation.periode.fin : date AAAA-MM-JJ valide attendue");
  if (jourValide(o.periode?.debut) && jourValide(o.periode?.fin)) {
    if (o.periode.debut > o.periode.fin) err.push("simulation.periode : la fin précède le début");
    if (Number(o.periode.debut.slice(0, 4)) !== c.annee) err.push(`simulation.periode.debut : l'année ${c.annee} du programme est attendue`);
    if (Number(o.periode.fin.slice(0, 4)) > c.annee + 10) err.push("simulation.periode.fin : au plus 10 ans après l'année du programme");
  }
  if (o.devise !== "GNF") err.push("simulation.devise : seule la devise GNF est gérée");
  if (!estCodeLogique(o.logique)) err.push(`simulation.logique : une valeur parmi ${CODES_LOGIQUE.join(", ")} est attendue`);
  else {
    const def = logiqueDe(o.logique);
    if (def.exige.includes("ordrePersonnalise")) {
      if (o.ordrePersonnalise.length === 0) err.push("simulation.ordrePersonnalise : la logique personnalisée exige une liste de tronçons");
    } else if (o.ordrePersonnalise.length > 0) err.push("simulation.ordrePersonnalise : fourni alors que la logique choisie ne l'utilise pas");
    if (def.exige.includes("equilibre")) {
      const p = o.equilibre?.partMinimaleParRegionPct;
      if (o.equilibre === null || typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 100) {
        err.push("simulation.equilibre.partMinimaleParRegionPct : entier de 1 à 100 exigé par la logique d'équilibre territorial");
      } else if (p * c.regionsCandidates.length > 100) {
        err.push(`simulation.equilibre : ${c.regionsCandidates.length} région(s) x ${p} % dépassent 100 % de l'enveloppe`);
      }
    } else if (o.equilibre !== null) err.push("simulation.equilibre : fourni alors que la logique choisie ne l'utilise pas");
  }
  for (const [nom, l] of [["obligatoires", o.obligatoires], ["ordrePersonnalise", o.ordrePersonnalise]] as const) {
    if (l.some((x) => typeof x !== "string" || x.length === 0)) err.push(`simulation.${nom} : identifiants de tronçon (texte non vide) attendus`);
    const d = doublons(l);
    if (d.length > 0) err.push(`simulation.${nom} : identifiant en double (${[...new Set(d)].join(", ")})`);
  }
  const inconnus = o.ordrePersonnalise.filter((id) => !c.candidatIds.has(id));
  if (inconnus.length > 0) err.push(`simulation.ordrePersonnalise : ${inconnus.length} identifiant(s) ne sont pas des candidats (${inconnus.slice(0, 5).join(", ")})`);
  const vus = new Map<string, number>();
  o.groupesNonDivisibles.forEach((g, i) => {
    if (!Array.isArray(g) || g.length < 2) { err.push(`simulation.groupesNonDivisibles[${i}] : au moins deux tronçons`); return; }
    if (doublons(g).length > 0) err.push(`simulation.groupesNonDivisibles[${i}] : identifiant en double dans le groupe`);
    for (const id of g) {
      if (vus.has(id) && vus.get(id) !== i) err.push(`simulation.groupesNonDivisibles : le tronçon ${id} figure dans deux groupes`);
      vus.set(id, i);
    }
  });
  if (o.rangsTechniques !== null) {
    for (const [k, v] of Object.entries(o.rangsTechniques)) {
      if (!Number.isInteger(v) || v < 1) err.push(`simulation.rangsTechniques.${k} : entier >= 1 attendu`);
    }
  }
  if (o.perimetre.selection !== null && o.perimetre.selection.length === 0) err.push("simulation.perimetre.selection : vide (omettre le champ pour tous les candidats du périmètre)");
  err.push(...verifierVersionBaremes(c.baremes, o.baremes));
  return err;
}

// ---------------------------------------------------------------------------------------------
// Selection sous contraintes
// ---------------------------------------------------------------------------------------------

export type CodeContrainteInsatisfaite =
  | "OBLIGATOIRE_HORS_CANDIDATS"
  | "OBLIGATOIRE_NON_CHIFFRABLE"
  | "OBLIGATOIRE_NON_FINANCEE"
  | "GROUPE_OBLIGATOIRE_IMPOSSIBLE"
  | "EQUILIBRE_NON_ATTEINT"
  | "EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE";

export interface ContrainteInsatisfaite {
  code: CodeContrainteInsatisfaite;
  portee: "TRONCON" | "GROUPE" | "REGION";
  /** Identifiant de troncon, numero de groupe ou numero de region, selon la portee. */
  reference: string;
  detail: string;
}

export type PhaseSelection = "OBLIGATOIRE" | "PLANCHER_REGIONAL" | "ORDRE";
export type CodeEcartSelection = "BUDGET_INSUFFISANT" | "PLAFOND_REGIONAL" | "EXCLUE_CONTRAINTE";

export interface DecisionSelection {
  id: string;
  retenue: boolean;
  /** Etape de la retenue ; `null` pour une ecartee. */
  phase: PhaseSelection | null;
  motif: { code: CodeEcartSelection; detail: string } | null;
  /** Rang d'examen (1, 2, ...) dans l'ordre reel ou le simulateur a regarde les interventions. */
  examen: number;
  resteAvantGnf: bigint;
  resteApresGnf: bigint;
  /** Numero de groupe non divisible, sinon `null`. */
  groupe: number | null;
}

export interface ResumeGroupe { numero: number; membres: string[]; retenu: boolean; coutGnf: string | null; motif: { code: CodeEcartSelection; detail: string } | null }
export interface ResumeEquilibre { regionId: number; plancherGnf: string; depenseGnf: string; atteint: boolean }

export interface EntreeSelection {
  ordre: readonly ElementClassable[];
  enveloppeGnf: bigint;
  plafondsRegionauxGnf: Readonly<Record<string, bigint>>;
  obligatoires: readonly string[];
  groupes: readonly (readonly string[])[];
  equilibre: { partMinimaleParRegionPct: number } | null;
  /** Regions de TOUS les candidats (meme ecartes), sans doublon. */
  regionsCandidates: readonly number[];
  /** Candidats ecartes AVANT classement (risque, traitement, cout) : identifiant vers leur motif. */
  exclus: ReadonlyMap<string, { code: string; detail: string }>;
  idsCandidats: ReadonlySet<string>;
  codeDe: (id: string) => string;
}

export interface ResultatSelection {
  decisions: Map<string, DecisionSelection>;
  engageGnf: bigint;
  resteGnf: bigint;
  engageParRegion: Map<string, bigint>;
  insatisfaisables: ContrainteInsatisfaite[];
  groupes: ResumeGroupe[];
  equilibre: ResumeEquilibre[] | null;
  obligatoires: { demandees: string[]; effectives: string[]; retenues: string[]; nonRetenues: string[] };
}

interface Unite { membres: ElementClassable[]; groupe: number | null; coutGnf: bigint }

export function selectionner(e: EntreeSelection): ResultatSelection {
  const decisions = new Map<string, DecisionSelection>();
  const insat: ContrainteInsatisfaite[] = [];
  const rang = new Map(e.ordre.map((x, i) => [x.id, i] as const));
  const parId = new Map(e.ordre.map((x) => [x.id, x] as const));
  const groupeDe = new Map<string, number>();
  e.groupes.forEach((g, i) => g.forEach((id) => groupeDe.set(id, i)));

  let reste = e.enveloppeGnf;
  let engage = 0n;
  let examen = 0;
  const engageRegion = new Map<string, bigint>();

  // 1. Obligatoires : ceux qui ne peuvent meme pas etre examines sont rendus tout de suite.
  const explicites = tri(e.obligatoires);
  const effectives = new Set(explicites);
  e.groupes.forEach((g) => { if (g.some((id) => effectives.has(id))) g.forEach((id) => effectives.add(id)); });
  for (const id of explicites) {
    if (!e.idsCandidats.has(id)) {
      insat.push({ code: "OBLIGATOIRE_HORS_CANDIDATS", portee: "TRONCON", reference: id, detail: `le tronçon obligatoire ${id} n'est pas dans les candidats du périmètre (absent, supprimé, hors réseau classé ou hors filtre)` });
    } else if (!parId.has(id)) {
      const m = e.exclus.get(id);
      insat.push({ code: "OBLIGATOIRE_NON_CHIFFRABLE", portee: "TRONCON", reference: id, detail: `le tronçon obligatoire ${e.codeDe(id)} n'est pas financé : ${m ? `${m.code} : ${m.detail}` : "non chiffrable"}. Aucun coût n'est inventé pour le retenir.` });
    }
  }

  // Groupes non divisibles : un groupe incomplet est ecarte en entier.
  const resumeGroupes: ResumeGroupe[] = e.groupes.map((g, i) => ({ numero: i + 1, membres: [...g], retenu: false, coutGnf: null, motif: null }));
  const groupesImpossibles = new Set<number>();
  e.groupes.forEach((g, i) => {
    const absents = g.filter((id) => !e.idsCandidats.has(id));
    const nonChiffrables = g.filter((id) => e.idsCandidats.has(id) && !parId.has(id));
    if (absents.length === 0 && nonChiffrables.length === 0) return;
    groupesImpossibles.add(i);
    const raisons = [
      ...absents.map((id) => `${id} absent des candidats`),
      ...nonChiffrables.map((id) => { const m = e.exclus.get(id); return `${e.codeDe(id)} écarté (${m ? m.code : "non chiffrable"})`; }),
    ];
    const detail = `groupe non divisible n°${i + 1} (${g.map((id) => (e.idsCandidats.has(id) ? e.codeDe(id) : id)).join(", ")}) : ${raisons.join(" ; ")} ; le groupe est écarté en entier`;
    resumeGroupes[i].motif = { code: "EXCLUE_CONTRAINTE", detail };
    for (const id of g) {
      const x = parId.get(id);
      if (x) decisions.set(id, { id, retenue: false, phase: null, motif: { code: "EXCLUE_CONTRAINTE", detail }, examen: ++examen, resteAvantGnf: reste, resteApresGnf: reste, groupe: i + 1 });
    }
    if (g.some((id) => explicites.includes(id))) {
      insat.push({ code: "GROUPE_OBLIGATOIRE_IMPOSSIBLE", portee: "GROUPE", reference: String(i + 1), detail: `${detail} : il contient une intervention obligatoire` });
    }
  });

  // Unites : un troncon seul, ou un groupe complet, ordonnees par leur meilleur membre.
  const unites: Unite[] = [];
  const groupesVus = new Set<number>();
  for (const x of e.ordre) {
    if (decisions.has(x.id)) continue;
    const gi = groupeDe.get(x.id);
    if (gi === undefined) { unites.push({ membres: [x], groupe: null, coutGnf: x.coutGnf }); continue; }
    if (groupesVus.has(gi)) continue;
    groupesVus.add(gi);
    const membres = e.groupes[gi].map((id) => parId.get(id) as ElementClassable).sort((a, b) => (rang.get(a.id) as number) - (rang.get(b.id) as number));
    unites.push({ membres, groupe: gi + 1, coutGnf: membres.reduce((s, m) => s + m.coutGnf, 0n) });
  }

  const etiquette = (u: Unite) => (u.groupe === null ? e.codeDe(u.membres[0].id) : `groupe non divisible n°${u.groupe}`);

  /** Verifie l'unite contre le reste et les plafonds ; ne modifie rien. */
  const verifier = (u: Unite): { code: CodeEcartSelection; detail: string } | null => {
    if (u.coutGnf > reste) {
      return { code: "BUDGET_INSUFFISANT", detail: u.groupe === null ? `coût ${u.coutGnf.toString()} supérieur au reste de l'enveloppe ${reste.toString()}` : `${etiquette(u)} : coût total ${u.coutGnf.toString()} supérieur au reste de l'enveloppe ${reste.toString()}` };
    }
    const parRegion = new Map<string, bigint>();
    for (const m of u.membres) if (m.regionId !== null) parRegion.set(String(m.regionId), (parRegion.get(String(m.regionId)) ?? 0n) + m.coutGnf);
    for (const [cle, cout] of parRegion) {
      const plafond = e.plafondsRegionauxGnf[cle];
      const deja = engageRegion.get(cle) ?? 0n;
      if (plafond !== undefined && deja + cout > plafond) {
        return { code: "PLAFOND_REGIONAL", detail: `région ${cle} : engagé ${deja.toString()} + ${cout.toString()} dépasse le plafond ${plafond.toString()}` };
      }
    }
    return null;
  };

  const retenir = (u: Unite, phase: PhaseSelection) => {
    const avant = reste;
    reste -= u.coutGnf;
    engage += u.coutGnf;
    for (const m of u.membres) {
      if (m.regionId !== null) engageRegion.set(String(m.regionId), (engageRegion.get(String(m.regionId)) ?? 0n) + m.coutGnf);
      decisions.set(m.id, { id: m.id, retenue: true, phase, motif: null, examen: ++examen, resteAvantGnf: avant, resteApresGnf: reste, groupe: u.groupe });
    }
    if (u.groupe !== null) { const g = resumeGroupes[u.groupe - 1]; g.retenu = true; g.coutGnf = u.coutGnf.toString(); }
  };

  const ecarter = (u: Unite, motif: { code: CodeEcartSelection; detail: string }) => {
    for (const m of u.membres) decisions.set(m.id, { id: m.id, retenue: false, phase: null, motif, examen: ++examen, resteAvantGnf: reste, resteApresGnf: reste, groupe: u.groupe });
    if (u.groupe !== null) { const g = resumeGroupes[u.groupe - 1]; g.motif = motif; g.coutGnf = u.coutGnf.toString(); }
  };

  // Etape 1 : obligatoires.
  for (const u of unites) {
    if (!u.membres.some((m) => effectives.has(m.id))) continue;
    const refus = verifier(u);
    if (refus === null) { retenir(u, "OBLIGATOIRE"); continue; }
    ecarter(u, refus);
    for (const m of u.membres) {
      if (explicites.includes(m.id)) {
        insat.push({ code: "OBLIGATOIRE_NON_FINANCEE", portee: "TRONCON", reference: m.id, detail: `l'intervention obligatoire ${e.codeDe(m.id)} n'est pas financée (${refus.code}) : ${refus.detail}. L'enveloppe n'est pas dépassée et le coût n'est pas ajusté.` });
      }
    }
  }

  // Etape 2 : plancher regional.
  const planchers = new Map<number, bigint>();
  if (e.equilibre !== null) {
    const pct = BigInt(e.equilibre.partMinimaleParRegionPct);
    const regions = [...e.regionsCandidates].sort((a, b) => a - b);
    for (const r of regions) planchers.set(r, (e.enveloppeGnf * pct) / 100n);
    for (const r of regions) {
      const plancher = planchers.get(r) as bigint;
      const essayes = new Set<Unite>();
      for (;;) {
        if ((engageRegion.get(String(r)) ?? 0n) >= plancher) break;
        const u = unites.find((x) => !essayes.has(x) && !x.membres.some((m) => decisions.has(m.id)) && x.membres.every((m) => m.regionId === r));
        if (!u) break;
        essayes.add(u);
        if (verifier(u) === null) retenir(u, "PLANCHER_REGIONAL");
      }
    }
  }

  // Etape 3 : ordre d'arbitrage.
  for (const u of unites) {
    if (u.membres.some((m) => decisions.has(m.id))) continue;
    const refus = verifier(u);
    if (refus === null) retenir(u, "ORDRE"); else ecarter(u, refus);
  }

  let equilibre: ResumeEquilibre[] | null = null;
  if (e.equilibre !== null) {
    equilibre = [...planchers.entries()].map(([r, plancher]) => {
      const depense = engageRegion.get(String(r)) ?? 0n;
      return { regionId: r, plancherGnf: plancher.toString(), depenseGnf: depense.toString(), atteint: depense >= plancher };
    });
    for (const q of equilibre) {
      if (q.atteint) continue;
      const aDesChiffrables = e.ordre.some((x) => x.regionId === q.regionId);
      insat.push(aDesChiffrables
        ? { code: "EQUILIBRE_NON_ATTEINT", portee: "REGION", reference: String(q.regionId), detail: `région ${q.regionId} : dépense ${q.depenseGnf} GNF inférieure au plancher ${q.plancherGnf} GNF (aucune intervention supplémentaire ne tient dans l'enveloppe ou les plafonds). Le plancher n'est pas comblé.` }
        : { code: "EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE", portee: "REGION", reference: String(q.regionId), detail: `région ${q.regionId} : aucun candidat chiffrable, le plancher de ${q.plancherGnf} GNF ne peut pas être atteint.` });
    }
  }

  return {
    decisions, engageGnf: engage, resteGnf: reste, engageParRegion: engageRegion, insatisfaisables: insat, groupes: resumeGroupes, equilibre,
    obligatoires: {
      demandees: explicites,
      effectives: tri([...effectives]),
      retenues: tri([...effectives].filter((id) => decisions.get(id)?.retenue === true)),
      nonRetenues: explicites.filter((id) => decisions.get(id)?.retenue !== true),
    },
  };
}
