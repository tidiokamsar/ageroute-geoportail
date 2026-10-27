import { execFileSync } from "node:child_process";

/**
 * Libere un port local en arretant le processus qui l'ecoute (et ses enfants). Windows : `netstat` puis `taskkill`.
 * Sert au nettoyage : l'API arretee par la spec 09 et l'arret des serveurs par Playwright laissent parfois un Vite ou une API orphelins, qui
 * tiennent le port (le lancement suivant refuse alors de demarrer) et le dossier de travail de l'API (EPERM a la suppression).
 */
export function pidsEnEcoute(port: number): number[] {
  let sortie = "";
  try { sortie = execFileSync("netstat", ["-ano"], { encoding: "utf8" }); } catch { return []; }
  const pids = new Set<number>();
  for (const l of sortie.split(/\r?\n/)) {
    const m = new RegExp(`:${port}\s+\S+\s+LISTENING\s+(\d+)`).exec(l);
    if (m) pids.add(Number(m[1]));
  }
  return [...pids];
}

export function libererPort(port: number): number {
  const pids = pidsEnEcoute(port);
  for (const pid of pids) {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* deja arrete */ }
  }
  return pids.length;
}
