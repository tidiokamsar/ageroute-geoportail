/**
 * Charge CPU de la MACHINE pendant un scenario (le poste est partage avec d'autres processus : les
 * latences ne se lisent pas sans elle). Echantillonne `os.cpus()` toutes les secondes ; la charge est
 * la part du temps non oisif de tous les coeurs logiques, y compris celle du banc et de PostgreSQL.
 */
import os from "node:os";

function instantane() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export interface ChargeMesuree { moyennePct: number; maxPct: number; echantillons: number }

export class EchantillonneurCharge {
  private minuteur: NodeJS.Timeout | null = null;
  private precedent = instantane();
  private valeurs: number[] = [];

  demarrer(): void {
    this.precedent = instantane();
    this.valeurs = [];
    this.minuteur = setInterval(() => {
      const maintenant = instantane();
      const dTotal = maintenant.total - this.precedent.total;
      const dIdle = maintenant.idle - this.precedent.idle;
      if (dTotal > 0) this.valeurs.push(Math.round((1 - dIdle / dTotal) * 100));
      this.precedent = maintenant;
    }, 1000);
    this.minuteur.unref();
  }

  arreter(): ChargeMesuree {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
    const n = this.valeurs.length;
    return {
      moyennePct: n ? Math.round(this.valeurs.reduce((s, v) => s + v, 0) / n) : -1,
      maxPct: n ? Math.max(...this.valeurs) : -1,
      echantillons: n,
    };
  }
}
