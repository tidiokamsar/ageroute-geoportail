/**
 * Types minimaux de `pg` : le backend ne depend pas de `@types/pg` et ce harnais n'ajoute aucune dependance. Seuls les appels
 * que `lib/base.ts` et `lib/donnees.ts` font sont decrits.
 */
declare module "pg" {
  interface Resultat<R> { rows: R[]; rowCount: number | null }
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(sql: string, valeurs?: unknown[]): Promise<Resultat<R>>;
    end(): Promise<void>;
  }
  export class Pool {
    constructor(config: { connectionString: string; max?: number });
    query<R = Record<string, unknown>>(sql: string, valeurs?: unknown[]): Promise<Resultat<R>>;
    end(): Promise<void>;
  }
}
