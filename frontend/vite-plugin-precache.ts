import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Plugin de construction : le MANIFESTE DE PRECACHE du service worker.
 *
 * CE QU'IL FAIT, A LA FIN DE LA CONSTRUCTION (`closeBundle`, quand `dist/` est complet)
 *
 * 1. Liste TOUT ce que `dist/` contient (index, JS, CSS, morceaux `lazy()`, icones, manifeste web,
 *    fonds de carte locaux) avec l'empreinte SHA-256 de chaque fichier, au format SRI
 *    (`sha256-<base64>`). On lit `dist/` plutot que le paquet Rollup : les fichiers du dossier
 *    `public/` n'y figurent pas, et ce sont eux (icones, `osm-routes.geojson`) que l'application
 *    doit trouver hors ligne.
 * 2. Calcule la REVISION du build : empreinte de la liste ci-dessus, de `sw-policy.js` et de `sw.js`
 *    avant gravure. Tout ce qui change le comportement hors ligne change la revision.
 * 3. GRAVE la revision dans `dist/sw.js` (remplacement de `REVISION_BUILD`). C'est indispensable :
 *    le navigateur ne reinstalle un worker que si les OCTETS de `sw.js` changent. Sans cette
 *    gravure, un deploiement qui ne change que l'application laisserait l'ancien precache en place
 *    pour toujours.
 * 4. Ecrit `dist/precache-manifest.json` : `{ version, revision, entrees: [{url, integrite, taille}] }`.
 *
 * ECHEC BRUYANT, PAS SILENCIEUX
 *
 * Un `sw.js` sans emplacement de revision, un `index.html` absent, ou un fichier au nom hors de
 * l'alphabet sur de `sw-policy.js` fait ECHOUER la construction. Un precache faux ne se voit pas :
 * il se manifeste sur un telephone hors couverture, des semaines plus tard.
 *
 * Les URL d'API n'existent pas dans `dist/`, mais l'alphabet ferme (voir `cheminPrecachable` dans
 * `public/sw-policy.js`, source unique) est reapplique ici : le plugin charge la politique elle-meme
 * plutot que d'en recopier les regles.
 */

/** Ce que l'on ne precache jamais : le worker, sa politique, le manifeste lui-meme, les cartes de sources. */
const NON_PRECACHES = new Set(["sw.js", "sw-policy.js", "precache-manifest.json"]);

/** Emplacement de la revision dans `sw.js` : le remplacement doit trouver cette ligne EXACTE, une fois. */
const LIGNE_REVISION = 'const REVISION_BUILD = "__REVISION_BUILD__";';

interface PolitiqueSw {
  cheminPrecachable(chemin: string): boolean;
  VERSION_MANIFESTE: number;
}

interface EntreeManifeste {
  url: string;
  integrite: string;
  taille: number;
}

function sri(contenu: Buffer): string {
  return "sha256-" + createHash("sha256").update(contenu).digest("base64");
}

/** Tous les fichiers sous `racine`, en chemins relatifs a barres obliques, tries (determinisme). */
function lister(racine: string, relatif = ""): string[] {
  const resultat: string[] = [];
  for (const dirent of fs.readdirSync(path.join(racine, relatif), { withFileTypes: true })) {
    const rel = relatif ? `${relatif}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) resultat.push(...lister(racine, rel));
    else if (dirent.isFile()) resultat.push(rel);
  }
  return resultat.sort();
}

/** Charge `sw-policy.js` (script classique qui pose `globalThis.politiqueSw`) pour en reutiliser les regles. */
function chargerPolitique(chemin: string): PolitiqueSw {
  // Script classique sans export : on l'evalue, localement et au moment de la construction seulement.
  new Function(fs.readFileSync(chemin, "utf8"))();
  const politique = (globalThis as unknown as { politiqueSw?: PolitiqueSw }).politiqueSw;
  if (!politique) throw new Error("precache : sw-policy.js ne pose pas globalThis.politiqueSw");
  return politique;
}

export function precachePlugin(): Plugin {
  let dossierSortie = "";
  let dossierPublic = "";

  return {
    name: "bdri-precache",
    apply: "build",
    // Apres les autres plugins : `index.html` et les assets doivent etre ecrits.
    enforce: "post",
    configResolved(config) {
      dossierSortie = path.resolve(config.root, config.build.outDir);
      dossierPublic = config.publicDir ? path.resolve(config.publicDir) : "";
    },
    closeBundle() {
      if (!fs.existsSync(path.join(dossierSortie, "index.html"))) {
        throw new Error("precache : dist/index.html est absent, rien a precacher");
      }
      const cheminSw = path.join(dossierSortie, "sw.js");
      const cheminPolitique = path.join(dossierSortie, "sw-policy.js");
      if (!fs.existsSync(cheminSw) || !fs.existsSync(cheminPolitique)) {
        throw new Error(
          `precache : sw.js ou sw-policy.js absent de ${dossierSortie}`
          + (dossierPublic ? ` (copies depuis ${dossierPublic})` : "")
          + " ; le dossier public doit les fournir",
        );
      }

      const politique = chargerPolitique(cheminPolitique);

      const entrees: EntreeManifeste[] = [];
      for (const rel of lister(dossierSortie)) {
        if (NON_PRECACHES.has(rel) || rel.endsWith(".map")) continue;
        const url = `/${rel}`;
        if (!politique.cheminPrecachable(url)) {
          throw new Error(
            `precache : le fichier ${url} sort de l'alphabet autorise (lettres, chiffres, . _ ~ - /) ;`
            + " renommez-le ou retirez-le de dist/",
          );
        }
        const contenu = fs.readFileSync(path.join(dossierSortie, rel));
        entrees.push({ url, integrite: sri(contenu), taille: contenu.length });
      }
      if (!entrees.some((e) => e.url === "/index.html")) {
        throw new Error("precache : /index.html absent de la liste");
      }
      if (!entrees.some((e) => /^\/assets\/.+\.js$/.test(e.url))) {
        throw new Error("precache : aucun script sous /assets/, construction suspecte");
      }

      // La revision couvre le contenu de tout ce qui est precache, ET le code du worker.
      const sourceSw = fs.readFileSync(cheminSw, "utf8");
      const empreinte = createHash("sha256");
      for (const e of entrees) empreinte.update(`${e.url}\0${e.integrite}\n`);
      empreinte.update(`politique:${sri(fs.readFileSync(cheminPolitique))}\n`);
      empreinte.update(`worker:${sri(Buffer.from(sourceSw, "utf8"))}\n`);
      const revision = empreinte.digest("hex").slice(0, 16);

      const occurrences = sourceSw.split(LIGNE_REVISION).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `precache : sw.js doit contenir exactement une fois la ligne ${LIGNE_REVISION} (trouve ${occurrences})`,
        );
      }
      fs.writeFileSync(
        cheminSw,
        sourceSw.replace(LIGNE_REVISION, `const REVISION_BUILD = ${JSON.stringify(revision)};`),
      );

      const tailleTotale = entrees.reduce((somme, e) => somme + e.taille, 0);
      fs.writeFileSync(
        path.join(dossierSortie, "precache-manifest.json"),
        JSON.stringify({ version: politique.VERSION_MANIFESTE, revision, tailleTotale, entrees }, null, 1),
      );

      console.log(
        `[precache] ${entrees.length} fichiers, ${(tailleTotale / 1024).toFixed(0)} Ko, revision ${revision}`,
      );
    },
  };
}
