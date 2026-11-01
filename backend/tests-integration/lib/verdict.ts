/**
 * Verdicts des bancs d'integration : chaque verification est nommee, comptee, et un banc qui n'en
 * a fait AUCUNE est un echec (un banc qui n'affirme rien ne prouve rien, et ne doit pas passer).
 */
const resultats: { nom: string; ok: boolean }[] = [];

export function verifier(nom: string, ok: boolean, detail?: unknown): void {
  resultats.push({ nom, ok });
  const suite = !ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : "";
  console.log(`${ok ? "  ok    " : "  ECHEC "} ${nom}${suite}`);
}

/** Resume et code de sortie : 1 s'il y a un echec ou si rien n'a ete verifie. */
export function conclure(): void {
  const echecs = resultats.filter((r) => !r.ok);
  console.log(`\n${resultats.length - echecs.length}/${resultats.length} verifications reussies`);
  if (resultats.length === 0) console.log("ECHEC : aucune verification n'a ete faite");
  if (echecs.length) console.log("ECHECS :", echecs.map((e) => e.nom));
  if (echecs.length || resultats.length === 0) process.exitCode = 1;
}

export const proche = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
