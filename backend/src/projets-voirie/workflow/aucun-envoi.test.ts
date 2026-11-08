import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * L'APPLICATION N'ENVOIE AUCUN MESSAGE (contrat docs/projets-voirie/CONTRAT-WORKFLOW.md, principe 1). Test statique : le code du workflow (noyau, services,
 * routes) n'importe aucun client de messagerie ni de reseau, ne fait aucune requete sortante, et n'ecrit aucun fichier ni ne lit aucun fichier
 * (une preuve est une reference et une empreinte, jamais un fichier stocke).
 */
const SRC = join(__dirname, "..", "..");
const ROUTES = join(SRC, "api-v2", "projets-voirie.workflow.routes.ts");

function sources(dossier: string): string[] {
  const sortie: string[] = [];
  for (const nom of readdirSync(dossier)) {
    const p = join(dossier, nom);
    if (statSync(p).isDirectory()) sortie.push(...sources(p));
    else if (/\.ts$/.test(nom) && !/\.test\.ts$/.test(nom)) sortie.push(p);
  }
  return sortie;
}

const fichiers = [...sources(__dirname), ROUTES];
/** Code sans commentaires (un commentaire peut dire « aucun courriel »). */
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

describe("le workflow n'envoie rien et ne stocke aucun fichier", () => {
  it("il y a du code a verifier", () => {
    expect(fichiers.length).toBeGreaterThan(12);
  });

  it("aucun import de messagerie, de client HTTP ou de reseau", () => {
    const interdit = /from\s+["'](?:nodemailer|axios|node-fetch|got|undici|superagent|request|ws|node:http|node:https|node:net|node:dgram|node:tls|http|https|net|dgram|tls)["']|require\(["'](?:nodemailer|axios|node-fetch|http|https|net)["']\)|lib\/mailer/;
    const fautifs = fichiers.filter((f) => interdit.test(code(f))).map((f) => relative(SRC, f));
    expect(fautifs).toEqual([]);
  });

  it("aucun appel reseau : fetch, XMLHttpRequest, WebSocket, sendMail, transporter", () => {
    const interdit = /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bsendMail\b|\bcreateTransport\b|\bsendMessage\b|\bsmtp\b/i;
    const fautifs = fichiers.filter((f) => interdit.test(code(f))).map((f) => relative(SRC, f));
    expect(fautifs).toEqual([]);
  });

  it("aucune ecriture ni lecture de fichier (references et empreintes seulement)", () => {
    const interdit = /from\s+["'](?:node:)?(?:fs|fs\/promises|path|child_process|stream)["']|\bwriteFile(?:Sync)?\b|\bcreateWriteStream\b|\bmulter\b|\bchild_process\b|\bexecSync\b|\bspawnSync\b/;
    const fautifs = fichiers.filter((f) => interdit.test(code(f))).map((f) => relative(SRC, f));
    expect(fautifs).toEqual([]);
  });

  it("le module d'envoi de courriels de la Console existe mais n'est reference nulle part dans le workflow", () => {
    expect(readFileSync(join(SRC, "lib", "mailer.ts"), "utf8").length).toBeGreaterThan(0);
    for (const f of fichiers) expect(/mailer/i.test(code(f)), relative(SRC, f)).toBe(false);
  });
});
