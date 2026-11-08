/**
 * Delta de versions DETAILLE (lot A1) : objets ajoutes, MODIFIES, retires, identiques. Sans E/S.
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 8. INFORMATION SEULEMENT : le delta n'est jamais applique, et les objets retires
 * ne sont supprimes de nulle part (un objet ne se modifie ni ne se supprime ; l'ancienne version reste en base, REMPLACE).
 *
 *   1. identiques : meme empreinte (geometrie normalisee + nom), comparaison par MULTI-ENSEMBLE ;
 *   2. modifies   : parmi les restes, meme CLE dans l'ancienne et la nouvelle version, une seule fois de chaque cote ;
 *   3. ajoutes / retires : le reste. Une cle presente plusieurs fois d'un cote (ou des deux sans correspondre un pour un) est AMBIGUE : ses
 *      objets restent en ajoutes et en retires, jamais rapproches au hasard.
 * La cle est la colonne `identifiant` du mapping (si les deux versions en ont une), sinon le nom.
 */

import { createHash } from "node:crypto";

export interface ObjetDelta {
  /** Cle de rapprochement (identifiant mappe ou nom) ; `null` : pas de cle. */
  cle: string | null;
  nom: string | null;
  empreinte: string;
  /** Position dans le fichier (nouveaux) ou identifiant en base (anciens), pour les echantillons. */
  ref: string | number;
}

export interface DeltaDetaille {
  ajoutes: number;
  modifies: number;
  retires: number;
  identiques: number;
  clesAmbigues: number;
  echantillons: {
    ajoutes: { ordre: number | string; nom: string | null }[];
    modifies: { cle: string; nomAvant: string | null; nomApres: string | null }[];
    retires: { objetId: number | string; nom: string | null }[];
  };
  /** SHA-256 de l'ensemble des empreintes retirees : lie la revue des suppressions a CE contenu exact. */
  empreinteRetires: string;
}

export const ECHANTILLON_DELTA_MAX = 20;

export function calculerDeltaDetaille(nouveaux: readonly ObjetDelta[], anciens: readonly ObjetDelta[]): DeltaDetaille {
  // 1. Identiques : multi-ensemble sur l'empreinte.
  const parEmpreinte = new Map<string, ObjetDelta[]>();
  for (const a of anciens) {
    const l = parEmpreinte.get(a.empreinte);
    if (l) l.push(a); else parEmpreinte.set(a.empreinte, [a]);
  }
  let identiques = 0;
  const restesNouveaux: ObjetDelta[] = [];
  for (const n of nouveaux) {
    const l = parEmpreinte.get(n.empreinte);
    if (l && l.length > 0) { l.pop(); identiques++; } else restesNouveaux.push(n);
  }
  const restesAnciens: ObjetDelta[] = [];
  for (const l of parEmpreinte.values()) restesAnciens.push(...l);
  // Ordre stable des anciens : leur ordre d'origine.
  const rang = new Map(anciens.map((a, i) => [a, i] as const));
  restesAnciens.sort((x, y) => (rang.get(x) ?? 0) - (rang.get(y) ?? 0));

  // 2. Modifies : meme cle, une fois de chaque cote.
  const cleNouveaux = new Map<string, ObjetDelta[]>();
  for (const n of restesNouveaux) if (n.cle !== null) (cleNouveaux.get(n.cle) ?? cleNouveaux.set(n.cle, []).get(n.cle)!).push(n);
  const cleAnciens = new Map<string, ObjetDelta[]>();
  for (const a of restesAnciens) if (a.cle !== null) (cleAnciens.get(a.cle) ?? cleAnciens.set(a.cle, []).get(a.cle)!).push(a);
  const modifies: { avant: ObjetDelta; apres: ObjetDelta }[] = [];
  const apparies = new Set<ObjetDelta>();
  let clesAmbigues = 0;
  for (const [cle, ln] of cleNouveaux) {
    const la = cleAnciens.get(cle);
    if (!la) continue;
    if (ln.length === 1 && la.length === 1) { modifies.push({ avant: la[0], apres: ln[0] }); apparies.add(ln[0]); apparies.add(la[0]); } else clesAmbigues++;
  }
  const ajoutes = restesNouveaux.filter((n) => !apparies.has(n));
  const retires = restesAnciens.filter((a) => !apparies.has(a));

  const empreinteRetires = createHash("sha256").update(`${retires.length}\n${retires.map((r) => r.empreinte).sort().join("\n")}`).digest("hex");
  return {
    ajoutes: ajoutes.length, modifies: modifies.length, retires: retires.length, identiques, clesAmbigues,
    echantillons: {
      ajoutes: ajoutes.slice(0, ECHANTILLON_DELTA_MAX).map((o) => ({ ordre: o.ref, nom: o.nom })),
      modifies: modifies.slice(0, ECHANTILLON_DELTA_MAX).map((m) => ({ cle: m.apres.cle!, nomAvant: m.avant.nom, nomApres: m.apres.nom })),
      retires: retires.slice(0, ECHANTILLON_DELTA_MAX).map((o) => ({ objetId: o.ref, nom: o.nom })),
    },
    empreinteRetires,
  };
}

/** Cle de rapprochement d'un objet : valeur de la colonne `identifiant` (si les DEUX versions en ont une), sinon le nom. */
export function cleDe(nom: string | null, attributs: Record<string, unknown> | null, colonneIdentifiant: string | null): string | null {
  if (colonneIdentifiant !== null) {
    const v = attributs?.[colonneIdentifiant];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  }
  return nom !== null && nom.trim() !== "" ? nom.trim() : null;
}
