import { PrismaClient } from "@prisma/client";
import { evaluerCible } from "./garde";

/**
 * Clone jetable de `replay` pour les bancs qui doivent COMMITTER (plusieurs appels de service qui
 * se voient les uns les autres). Le nom doit etre `essai_<nom>` : la garde le laissera passer, et
 * rien d'autre ne peut etre cree ou detruit ici.
 */
const NOM = /^essai_[a-z0-9_]+$/;

function urlVers(urlOrigine: string, base: string): string {
  const u = new URL(urlOrigine);
  u.pathname = `/${base}`;
  return u.toString();
}

export const urlClone = (urlOrigine: string, nom: string) => urlVers(urlOrigine, nom);

async function admin<T>(urlOrigine: string, f: (c: PrismaClient) => Promise<T>): Promise<T> {
  const cible = evaluerCible(urlOrigine);
  if (!cible.ok) throw new Error(`cible refusee : ${cible.raison}`);
  const c = new PrismaClient({ datasourceUrl: urlVers(urlOrigine, "postgres") });
  try { return await f(c); } finally { await c.$disconnect(); }
}

export async function creerClone(urlReplay: string, nom: string): Promise<void> {
  if (!NOM.test(nom)) throw new Error(`nom de clone refuse : ${nom}`);
  const cible = evaluerCible(urlReplay);
  if (!cible.ok || cible.base !== "replay") throw new Error("le modele d'un clone doit etre la base `replay`");
  await admin(urlReplay, async (c) => {
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${nom} WITH (FORCE)`);
    await c.$executeRawUnsafe(`CREATE DATABASE ${nom} TEMPLATE replay`);
  });
}

export async function supprimerClone(urlReplay: string, nom: string): Promise<void> {
  if (!NOM.test(nom)) throw new Error(`nom de clone refuse : ${nom}`);
  await admin(urlReplay, async (c) => { await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${nom} WITH (FORCE)`); });
}
