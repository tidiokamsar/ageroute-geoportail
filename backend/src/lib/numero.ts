import { prisma } from "./prisma";

// Génère un numéro séquentiel annuel du type "OT-2026-00001" / "SIG-2026-04821".
// Compte les enregistrements de l'année + retry en cas de collision (créations
// concurrentes) : la contrainte unique en base reste l'arbitre final.
export async function nextNumero(prefix: "OT" | "SIG" | "IMP", countFn: (startsWith: string) => Promise<number>): Promise<string> {
  const year = new Date().getFullYear();
  const base = `${prefix}-${year}-`;
  const count = await countFn(base);
  return `${base}${String(count + 1).padStart(5, "0")}`;
}

export async function nextNumeroOT(): Promise<string> {
  return nextNumero("OT", (s) => prisma.ordreTravaux.count({ where: { numero: { startsWith: s } } }));
}

export async function nextNumeroSignalement(): Promise<string> {
  return nextNumero("SIG", (s) => prisma.signalementCitoyen.count({ where: { numeroPublic: { startsWith: s } } }));
}

/** Reference stable d'un lot d'import : IMP-2026-00012. Comptee dans la transaction appelante. */
export async function nextNumeroLotImport(
  countFn: (startsWith: string) => Promise<number>,
): Promise<string> {
  return nextNumero("IMP", countFn);
}
