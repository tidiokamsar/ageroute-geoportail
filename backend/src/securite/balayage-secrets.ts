/**
 * BALAYAGE DES SECRETS du depot suivi par git (scenario A25, regle 1 d'AGENTS.md).
 *
 * « Aucun secret dans le depot [...] ne jamais commiter de `.env`, de mot de passe, de jeton ni
 * d'adresse IP de serveur de production. » Cette regle a deja ete enfreinte une fois (audit du
 * 13/10/2026 : une adresse IP de production dans huit endroits), et elle l'a ete dans le depot meme qui
 * l'enonce. Une regle qu'on ne peut pas confier a la relecture est confiee a un test.
 *
 * CE QUE LE BALAYAGE FAIT
 *
 * Il lit les fichiers SUIVIS par git (`git ls-files`), pas le disque : un `.env` local ignore par
 * `.gitignore` n'est pas dans le depot, et un `.env` suivi y est. Six regles :
 *
 *   CLE_PRIVEE          un bloc de cle privee (RSA, EC, OpenSSH, PGP...)
 *   FICHIER_SECRET      un fichier dont le NOM trahit un secret (.env, .pem, .key, id_rsa, sauvegarde...)
 *   JETON_CONNU         un jeton au format reconnaissable (AWS, GitHub, Slack, Google, Stripe, npm, JWT)
 *   IDENTIFIANTS_URL    un mot de passe dans une URL (postgresql://utilisateur:motdepasse@hote)
 *   AFFECTATION_SECRETE une affectation `mot_de_passe = "valeur"` d'une valeur qui n'est pas un marqueur
 *   IP_SERVEUR          une adresse IPv4 publique (ni privee, ni de bouclage, ni de documentation)
 *
 * CE QU'IL NE FAIT PAS, ET LE DIT
 *
 *   - Il ne lit pas l'HISTORIQUE par defaut (`balayerHistorique` existe, lent, a lancer a la main) :
 *     un secret retire de l'arbre mais present dans un ancien commit n'est vu que par lui.
 *   - Il ne comprend pas le sens : une valeur aleatoire sans mot-cle devant elle, ou un mot de passe
 *     decrit en prose, lui echappe. Il attrape la faute courante, il ne remplace pas une revue.
 *   - Il ne connait pas l'adresse IP de production : la regle 1 interdit precisement de l'ecrire. Il
 *     refuse donc TOUTE adresse publique non justifiee, et c'est a la liste d'exceptions de dire
 *     pourquoi une adresse est factice.
 *   - Les FICHIERS DE TEST ne sont pas soumis a AFFECTATION_SECRETE (leurs mots de passe sont factices
 *     par construction) ; ils le sont a toutes les autres regles.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Regle =
  | "CLE_PRIVEE" | "FICHIER_SECRET" | "JETON_CONNU" | "IDENTIFIANTS_URL" | "AFFECTATION_SECRETE" | "IP_SERVEUR";

export interface Trouvaille {
  regle: Regle;
  chemin: string;
  ligne: number;
  /** L'extrait, TRONQUE et sans la valeur secrete entiere : le rapport ne doit pas devenir une fuite. */
  extrait: string;
}

/** Fichiers au-dela desquels on ne lit pas (donnees, pas du code) ; la liste des ignores est rendue. */
export const TAILLE_MAX_OCTETS = 2 * 1024 * 1024;

const EST_FICHIER_DE_TEST = /(^|\/)(tests?-integration|__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.test\.sql$/i;
const EST_FICHIER_VERROU = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/i;

/* ------------------------------ Marqueurs de valeur factice ------------------------------ */

/**
 * Une valeur qui se dit factice : « changeme », « xxxx », « <mot de passe> », une variable de shell...
 * Un depot qui documente sa configuration en a besoin ; un secret reel n'en porte pas.
 */
const MARQUEUR_FACTICE = /^(?:.*(?:changeme|change-me|change_me|placeholder|exemple|example|motdepasse|mot-de-passe|mot_de_passe|votre|your|todo|xxx+|redacted|dummy|fake|factice|secret-de-test|test-secret|test_secret).*|[*•x.]{3,}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\([^)]*\)|<[^>]*>|%[sd]|\{\{[^}]*\}\}|\.\.\.|process\.env\..*|env\(.*\)|null|undefined|true|false|password|passwd|secret|token|pass|user|utilisateur|admin|test|dev)$/i;

export const estValeurFactice = (v: string) => v.trim().length <= 3 || MARQUEUR_FACTICE.test(v.trim());   // « x » n'est pas un mot de passe

/** Entropie de Shannon en bits par caractere : un texte lisible est bas, un secret aleatoire haut. */
export function entropie(s: string): number {
  if (!s) return 0;
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

/* ----------------------------------------- Regles ---------------------------------------- */

const CLE_PRIVEE = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/;

const JETONS: { nom: string; re: RegExp }[] = [
  { nom: "AWS", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { nom: "GitHub", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { nom: "GitHub", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { nom: "Slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { nom: "Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { nom: "Stripe", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/ },
  { nom: "npm", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { nom: "JWT", re: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Nom de fichier (hors dossiers) qui trahit un secret. Les modeles (.example, .sample) sont permis. */
export function nomDeFichierSecret(chemin: string): string | null {
  const base = chemin.split("/").pop() ?? chemin;
  if (/^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template|dist)$/i.test(base)) return "fichier d'environnement";
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i.test(base)) return "cle ou certificat";
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return "cle SSH privee";
  if (/^(credentials|service[-_]?account.*)\.json$/i.test(base)) return "identifiants de service";
  if (/^\.(htpasswd|netrc|pgpass)$/i.test(base)) return "fichier d'identifiants";
  if (/\.(dump|bak|sqlite3?|rdb)$/i.test(base)) return "copie de base de donnees";
  return null;
}

const URL_IDENTIFIANTS = /\b[a-z][a-z0-9+.-]{1,15}:\/\/([^\s/:@'"`<>]+):([^\s/@'"`<>]+)@[^\s/'"`<>]+/gi;

const MOT_SECRET = "(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|credential)";
/** Affectation d'une valeur ENTRE GUILLEMETS a un nom qui contient un mot de secret. */
const AFFECTATION_GUILLEMETS = new RegExp(`([A-Za-z0-9_.-]*${MOT_SECRET}[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*["']([^"'\\s]{10,})["']`, "gi");
/** Affectation SANS guillemets, dans un fichier de configuration (KEY=valeur, key: valeur). */
const AFFECTATION_NUE = new RegExp(`^\\s*(?:export\\s+)?([A-Za-z0-9_.-]*${MOT_SECRET}[A-Za-z0-9_.-]*)\\s*[:=]\\s*([^\\s"'#]{10,})\\s*(?:#.*)?$`, "gi");
const EXTENSIONS_CONFIG = /\.(env|sh|bash|ya?ml|properties|conf|cfg|ini|toml|service|dockerfile)$|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|\.env[^/]*)$/i;
const EXTENSIONS_CODE = /\.(?:[cm]?[jt]sx?|py|sql)$/i;

const IPV4 = /(?<![\d.])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?![\d]|\.\d)/g;

/** Vrai pour une adresse qui ne designe aucun serveur public : bouclage, privee, partagee, documentation, speciale. */
export function adresseNonPublique(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;                       // reseau nul, prive, bouclage, multicast et reserve
  if (a === 169 && b === 254) return true;                                              // lien local
  if (a === 172 && b >= 16 && b <= 31) return true;                                     // prive
  if (a === 192 && b === 168) return true;                                              // prive
  if (a === 100 && b >= 64 && b <= 127) return true;                                    // partage operateur (CGNAT)
  if (a === 192 && b === 0 && c === 2) return true;                                     // documentation (RFC 5737)
  if (a === 198 && b === 51 && c === 100) return true;                                  // documentation
  if (a === 203 && b === 0 && c === 113) return true;                                   // documentation
  if (a === 198 && (b === 18 || b === 19)) return true;                                 // essais de performance
  return false;
}

const tronquer = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}...` : s);
/** Masque la valeur : le rapport montre OU, pas QUOI. */
const masquer = (v: string) => (v.length <= 6 ? "***" : `${v.slice(0, 2)}***${v.slice(-1)}(${v.length})`);

/**
 * Balaye le CONTENU d'un fichier. Pure : ne touche ni disque ni git, donc testable avec des extraits
 * (c'est ce qui permet de prouver que le balayage voit ce qu'il doit voir).
 */
export function balayerTexte(chemin: string, contenu: string): Trouvaille[] {
  const trouvailles: Trouvaille[] = [];
  const ajouter = (regle: Regle, ligne: number, extrait: string) => trouvailles.push({ regle, chemin, ligne, extrait: tronquer(extrait) });

  const nom = nomDeFichierSecret(chemin);
  if (nom) ajouter("FICHIER_SECRET", 0, `${nom} : ${chemin.split("/").pop()}`);

  const test = EST_FICHIER_DE_TEST.test(chemin);
  const config = EXTENSIONS_CONFIG.test(chemin);
  const code = EXTENSIONS_CODE.test(chemin);
  const verrou = EST_FICHIER_VERROU.test(chemin);

  contenu.split(/\r?\n/).forEach((texte, i) => {
    const ligne = i + 1;
    if (CLE_PRIVEE.test(texte)) ajouter("CLE_PRIVEE", ligne, texte.trim().slice(0, 40));
    for (const { nom: service, re } of JETONS) {
      const m = re.exec(texte);
      if (m) ajouter("JETON_CONNU", ligne, `${service} : ${masquer(m[0])}`);
    }
    for (const m of texte.matchAll(URL_IDENTIFIANTS)) {
      if (!estValeurFactice(m[2])) ajouter("IDENTIFIANTS_URL", ligne, texte.replace(m[2], masquer(m[2])).trim());
    }
    if (!test && !verrou) {
      for (const m of texte.matchAll(AFFECTATION_GUILLEMETS)) {
        const valeur = m[2];
        if (estValeurFactice(valeur)) continue;
        // Dans le CODE, une chaine entre guillemets est souvent un nom, un message ou un chemin : on exige
        // qu'elle ressemble a un secret (variee, mele lettres et chiffres).
        if (code && (entropie(valeur) < 3.3 || !/\d/.test(valeur) || !/[A-Za-z]/.test(valeur))) continue;
        ajouter("AFFECTATION_SECRETE", ligne, texte.replace(valeur, masquer(valeur)).trim());
      }
      if (config) {
        const m = new RegExp(AFFECTATION_NUE.source, "i").exec(texte);
        if (m && !estValeurFactice(m[2]) && !/^[A-Za-z_.-]+$/.test(m[2])) ajouter("AFFECTATION_SECRETE", ligne, texte.replace(m[2], masquer(m[2])).trim());
      }
    }
    if (!verrou) {
      for (const m of texte.matchAll(IPV4)) {
        if (!adresseNonPublique(m[1])) ajouter("IP_SERVEUR", ligne, texte.trim());
      }
    }
  });
  return trouvailles;
}

/* ------------------------------------- Parcours de l'arbre ------------------------------------- */

export interface ResultatArbre {
  trouvailles: Trouvaille[];
  fichiersLus: number;
  /** Ce qui n'a PAS ete lu : binaires et fichiers trop gros. Rendu pour que le trou se voie. */
  ignores: { chemin: string; raison: "BINAIRE" | "TROP_GROS" | "ILLISIBLE" }[];
}

/** Racine du depot git qui contient `depart`. */
export function racineDepot(depart: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: depart, encoding: "utf8" }).trim();
}

export function fichiersSuivis(racine: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: racine, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter(Boolean);
}

export function balayerArbre(racine: string): ResultatArbre {
  const res: ResultatArbre = { trouvailles: [], fichiersLus: 0, ignores: [] };
  for (const chemin of fichiersSuivis(racine)) {
    const complet = path.join(racine, chemin);
    // Le nom d'un fichier secret est juge MEME si le fichier est binaire ou gros.
    const nom = nomDeFichierSecret(chemin);
    try {
      const taille = statSync(complet).size;
      if (taille > TAILLE_MAX_OCTETS) { res.ignores.push({ chemin, raison: "TROP_GROS" }); if (nom) res.trouvailles.push({ regle: "FICHIER_SECRET", chemin, ligne: 0, extrait: nom }); continue; }
      const octets = readFileSync(complet);
      if (octets.subarray(0, 8000).includes(0)) { res.ignores.push({ chemin, raison: "BINAIRE" }); if (nom) res.trouvailles.push({ regle: "FICHIER_SECRET", chemin, ligne: 0, extrait: nom }); continue; }
      res.fichiersLus += 1;
      res.trouvailles.push(...balayerTexte(chemin, octets.toString("utf8")));
    } catch {
      res.ignores.push({ chemin, raison: "ILLISIBLE" });
    }
  }
  return res;
}

/**
 * Balaye l'HISTORIQUE : chaque ligne AJOUTEE de chaque commit de chaque branche. Lent (lit tous les
 * diffs) ; a lancer a la main, jamais dans la suite par defaut. Un secret retire de l'arbre mais
 * present dans un commit ancien n'est vu que par lui.
 */
export async function balayerHistorique(racine: string): Promise<{ trouvailles: Trouvaille[]; commits: number }> {
  const trouvailles: Trouvaille[] = [];
  let commits = 0;
  await new Promise<void>((resolve, reject) => {
    const enfant = spawn("git", ["log", "--all", "--no-color", "--unified=0", "-p", "--format=COMMIT %H", "--no-ext-diff"], { cwd: racine });
    let reste = "";
    let fichier = "";
    let commit = "";
    const traiter = (ligne: string) => {
      if (ligne.startsWith("COMMIT ")) { commits += 1; commit = ligne.slice(7, 15); return; }
      if (ligne.startsWith("+++ b/")) { fichier = ligne.slice(6); const nom = nomDeFichierSecret(fichier); if (nom) trouvailles.push({ regle: "FICHIER_SECRET", chemin: `${fichier}@${commit}`, ligne: 0, extrait: nom }); return; }
      if (ligne.startsWith("+") && !ligne.startsWith("+++")) {
        for (const t of balayerTexte(fichier || "?", ligne.slice(1))) trouvailles.push({ ...t, chemin: `${fichier}@${commit}`, ligne: 0 });
      }
    };
    enfant.stdout.on("data", (d: Buffer) => {
      const morceaux = (reste + d.toString("utf8")).split("\n");
      reste = morceaux.pop() ?? "";
      for (const l of morceaux) traiter(l);
    });
    enfant.on("error", reject);
    enfant.on("close", (code) => { if (reste) traiter(reste); code === 0 ? resolve() : reject(new Error(`git log a rendu ${code}`)); });
  });
  return { trouvailles, commits };
}
