/**
 * CADENCE PAR COMPTE SUR UNE FENETRE GLISSANTE (noyau pur, lot X1 ; contrat CONTRAT-EXPORTS.md, sections 4.4 et 6.4).
 *
 * Au plus `plafond` evenements par compte sur `fenetreS` secondes ; au-dela, refus jusqu'a ce que le plus ancien de ceux qui comptent sorte de la fenetre
 * (jamais moins d'une seconde). Une horloge qui recule ne laisse jamais passer : un horodatage dans le futur compte comme « a l'instant ».
 *
 * `CadenceMemoire` : variante en memoire du processus (tableaux de bord : aucune ecriture en base, donc rien a compter en base), bornee en taille.
 */

export type VerdictCadence = { ok: true } | { ok: false; retryAfterS: number };

export function verifierCadence(e: { horodatages: readonly Date[]; maintenant: Date; fenetreS: number; plafond: number }): VerdictCadence {
  const fenetreMs = e.fenetreS * 1000;
  const t0 = e.maintenant.getTime();
  const dans = e.horodatages.map((d) => Math.min(d.getTime(), t0)).filter((t) => t0 - t < fenetreMs).sort((a, b) => b - a);
  if (dans.length < e.plafond) return { ok: true };
  const pivot = dans[e.plafond - 1];
  return { ok: false, retryAfterS: Math.max(1, Math.ceil((pivot + fenetreMs - t0) / 1000)) };
}

export class CadenceMemoire {
  private readonly parCompte = new Map<string, number[]>();
  constructor(private readonly comptesMax = 10_000) {}

  /** Enregistre un evenement si la cadence le permet (sinon rien n'est enregistre). */
  tenter(compte: string, maintenant: Date, fenetreS: number, plafond: number): VerdictCadence {
    const t0 = maintenant.getTime();
    const garde = (this.parCompte.get(compte) ?? []).filter((t) => t0 - t < fenetreS * 1000);
    const v = verifierCadence({ horodatages: garde.map((t) => new Date(t)), maintenant, fenetreS, plafond });
    if (v.ok) garde.push(t0);
    if (garde.length) this.parCompte.set(compte, garde); else this.parCompte.delete(compte);
    // Borne memoire : au-dela de `comptesMax` comptes suivis, les plus anciens (ordre d'insertion) sont oublies.
    while (this.parCompte.size > this.comptesMax) this.parCompte.delete(this.parCompte.keys().next().value as string);
    return v;
  }

  vider(): void { this.parCompte.clear(); }
  get taille(): number { return this.parCompte.size; }
}
