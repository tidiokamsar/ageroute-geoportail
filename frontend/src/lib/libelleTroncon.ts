/**
 * Libelle d'un troncon : « CODE — Nom ».
 *
 * Quand le nom n'est qu'une recopie du code (les troncons repris de la voirie locale portent leur
 * code comme nom : « RES-142 — RES-142 »), ou qu'il est vide, le libelle ne repete pas : il
 * donne le code seul. La comparaison ignore la casse, les accents, les espaces et la ponctuation, pour
 * que « RES-142 » et « res 142 » comptent pour le meme texte.
 */
const normaliser = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export function libelleTroncon(code: string, nom: string | null | undefined): string {
  const c = code.trim();
  const n = (nom ?? "").trim();
  if (n === "" || normaliser(n) === normaliser(c)) return c;
  return `${c} — ${n}`;
}
