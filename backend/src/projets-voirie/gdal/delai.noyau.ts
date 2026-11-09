/**
 * GARDE DE DELAI du sondage (lot V2, correction M1 de la revue) : aucun acces au spool ne doit pouvoir bloquer un tour sans fin.
 *
 * Un descripteur qui bloque (tube nomme plante par le conteneur, systeme de fichiers reseau qui ne repond plus) immobilise un thread libuv : la promesse
 * ne se resout jamais. Sans garde, `traiterUnTour` attendrait en sequence, `tourEnCours` ne retomberait jamais et plus aucun job n'avancerait. Avec la
 * garde, l'attente est bornee : l'operation est abandonnee (la promesse d'origine continue en arriere-plan, sans effet sur l'etat en base), comptee en
 * erreur, et le tour suivant repart. Sans E/S, sans base.
 */

export class ErreurDelai extends Error {
  readonly code = "DELAI_SONDAGE_DEPASSE";
  constructor(public readonly contexte: string, public readonly ms: number) {
    // Jamais de chemin ni de contenu : le contexte est un libelle fixe choisi par l'appelant.
    super(`delai de ${ms} ms depasse (${contexte})`);
    this.name = "ErreurDelai";
  }
}

/** Rend le resultat de `p`, ou rejette `ErreurDelai` apres `ms` millisecondes. Le minuteur ne retient pas le processus (`unref`). */
export function avecDelai<T>(p: Promise<T>, ms: number, contexte: string): Promise<T> {
  if (!(ms > 0)) return Promise.reject(new ErreurDelai(contexte, 0));
  return new Promise<T>((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new ErreurDelai(contexte, ms)), ms);
    minuteur.unref?.();
    p.then((v) => { clearTimeout(minuteur); resolve(v); }, (e) => { clearTimeout(minuteur); reject(e); });
  });
}

/** Budget de temps d'un tour : ce qu'il reste avant l'echeance, borne par un plafond par operation. */
export class BudgetTour {
  constructor(private readonly echeanceMs: number, private readonly parOperationMs: number) {}

  static depuis(maintenantMs: number, dureeTourMs: number, parOperationMs: number): BudgetTour {
    return new BudgetTour(maintenantMs + dureeTourMs, parOperationMs);
  }

  /** Millisecondes encore disponibles pour une operation courte (0 si le tour est epuise). */
  court(maintenantMs: number = Date.now()): number {
    return Math.max(0, Math.min(this.parOperationMs, this.echeanceMs - maintenantMs));
  }

  /** Millisecondes encore disponibles pour une operation longue (validation d'un resultat) : tout le reste du tour. */
  long(maintenantMs: number = Date.now()): number {
    return Math.max(0, this.echeanceMs - maintenantMs);
  }

  epuise(maintenantMs: number = Date.now()): boolean { return this.echeanceMs <= maintenantMs; }
}
