/**
 * LIMITEUR DE CONCURRENCE des receptions de lots.
 *
 * Chaque reception garde UNE connexion de la base pendant toute sa transaction (jusqu'a 60 s).
 * L'audit du 25/10/2026 a montre ce que douze envois simultanes de 8 000 lignes font d'un pool de
 * connexions : huit succes, un 409, trois 500 (P2024), et un AUTRE utilisateur en 503 parce que
 * `requireAuth` ne trouvait plus de connexion pour lire son compte. Au plus `max` receptions
 * travaillent a la fois dans le processus ; les suivantes attendent un delai BORNE, puis
 * recoivent `ServiceOccupe` (503 + Retry-After) plutot que d'empiler des transactions.
 *
 * Portee : le PROCESSUS. Plusieurs instances multiplient la limite ; c'est dit dans la doc.
 */

export class ServiceOccupe extends Error {
  readonly code = "SERVICE_OCCUPE";
  constructor(message: string, public readonly retryAfterS: number = 10) { super(message); }
}

/** Au plus deux receptions simultanees par processus. PROVISOIRE : a ajuster avec la taille du pool. */
export const IMPORTS_SIMULTANES_MAX = 2;
/** Attente maximale d'une place, en ms, avant de repondre 503. */
export const ATTENTE_PLACE_MAX_MS = 15_000;

export class Limiteur {
  private actifs = 0;
  private readonly file: Array<{ lancer: () => void; delai: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly max: number = IMPORTS_SIMULTANES_MAX, private readonly attenteMaxMs: number = ATTENTE_PLACE_MAX_MS) {}

  get etat(): { actifs: number; enAttente: number } { return { actifs: this.actifs, enAttente: this.file.length }; }

  private obtenir(): Promise<void> {
    if (this.actifs < this.max) { this.actifs += 1; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const entree = {
        lancer: () => { clearTimeout(entree.delai); resolve(); },
        delai: setTimeout(() => {
          const i = this.file.indexOf(entree);
          if (i >= 0) this.file.splice(i, 1);
          reject(new ServiceOccupe("Le service traite deja d'autres lots d'import : reessayez dans quelques instants."));
        }, this.attenteMaxMs),
      };
      this.file.push(entree);
    });
  }

  private liberer(): void {
    const suivant = this.file.shift();
    // La place passe directement au suivant : `actifs` ne change pas.
    if (suivant) suivant.lancer(); else this.actifs -= 1;
  }

  async executer<T>(travail: () => Promise<T>): Promise<T> {
    await this.obtenir();
    try { return await travail(); } finally { this.liberer(); }
  }
}

/** Le limiteur du processus, partage par toutes les receptions. */
export const limiteurReceptions = new Limiteur();
