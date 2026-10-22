/**
 * Generateur pseudo-aleatoire a graine fixe (mulberry32) : la suite de tirages ne depend que de la
 * graine, jamais de PostgreSQL (`random()`/`setseed` dependent de la version et du plan) ni de
 * l'horloge. C'est ce qui rend le reseau synthetique rejouable a l'identique par un tiers.
 */
export class Alea {
  private etat: number;
  private gaussEnAttente: number | null = null;

  constructor(graine: number) {
    this.etat = graine >>> 0;
  }

  /** Reel dans [0, 1). */
  suivant(): number {
    this.etat = (this.etat + 0x6d2b79f5) >>> 0;
    let t = this.etat;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Reel dans [a, b). */
  entre(a: number, b: number): number {
    return a + (b - a) * this.suivant();
  }

  /** Entier dans [a, b] (bornes comprises). */
  entier(a: number, b: number): number {
    return a + Math.floor(this.suivant() * (b - a + 1));
  }

  /** Loi normale centree reduite (Box-Muller, deux tirages par paire). */
  gauss(): number {
    if (this.gaussEnAttente !== null) {
      const g = this.gaussEnAttente;
      this.gaussEnAttente = null;
      return g;
    }
    let u = 0;
    while (u === 0) u = this.suivant();
    const v = this.suivant();
    const r = Math.sqrt(-2 * Math.log(u));
    this.gaussEnAttente = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  choisir<T>(liste: readonly T[]): T {
    return liste[Math.floor(this.suivant() * liste.length)];
  }

  /** Tirage pondere : renvoie l'indice. */
  indicePondere(poids: readonly number[]): number {
    const total = poids.reduce((s, p) => s + p, 0);
    let x = this.suivant() * total;
    for (let i = 0; i < poids.length; i += 1) {
      x -= poids[i];
      if (x < 0) return i;
    }
    return poids.length - 1;
  }
}
