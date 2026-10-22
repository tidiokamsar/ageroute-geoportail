/**
 * Prepare le clone de mesure : cree `essai_<nom>` depuis `replay` (modele immuable), y charge le
 * reseau synthetique, rend l'URL du clone. Ne touche jamais `replay` ni une autre base : la garde
 * et `clone.ts` refusent tout nom qui n'est pas `essai_<nom>`.
 */
import { Client } from "pg";
import { creerClone, urlClone } from "../../lib/clone";
import { evaluerCible } from "../../lib/garde";
import { chargerReseau, type ResumeChargement } from "./charger";
import { decrire, empreinte, genererReseau, type ReseauSynthetique } from "./reseau-synthetique";

export interface Preparation {
  url: string;
  reseau: ReseauSynthetique;
  empreinte: string;
  description: ReturnType<typeof decrire>;
  chargement: ResumeChargement;
}

export async function preparerClone(opts: { urlReplay: string; nom: string; nombre: number; graine?: number }): Promise<Preparation> {
  const cible = evaluerCible(opts.urlReplay);
  if (!cible.ok || cible.base !== "replay") throw new Error("preparerClone exige DATABASE_URL sur la base `replay` (modele du clone)");
  const reseau = genererReseau({ nombre: opts.nombre, graine: opts.graine });
  await creerClone(opts.urlReplay, opts.nom);
  const url = urlClone(opts.urlReplay, opts.nom);
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const chargement = await chargerReseau(c, reseau);
    return { url, reseau, empreinte: empreinte(reseau), description: decrire(reseau), chargement };
  } finally {
    await c.end();
  }
}
