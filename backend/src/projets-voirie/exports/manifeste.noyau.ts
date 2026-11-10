/**
 * MANIFESTE DU DOSSIER TECHNIQUE (lot X1 ; contrat CONTRAT-EXPORTS.md, section 4.2). Noyau pur : empreinte SHA-256 de chaque fichier, manifeste JSON,
 * fichier `manifeste.sha256` au format de `sha256sum -c`, nom de la racine et des fichiers GeoJSON.
 *
 * Le manifeste liste tous les fichiers SAUF lui-meme et `manifeste.sha256` ; `manifeste.sha256` liste tous les fichiers, `manifeste.json` compris. Une
 * archive se verifie donc entierement depuis son contenu, et son empreinte globale est dans le journal des exports et dans l'audit.
 */

import { createHash } from "node:crypto";
import type { FichierZip } from "./zip-ecriture.noyau";

export const FORMAT_MANIFESTE = "BDRI-DOSSIER-1";
export const NOM_MANIFESTE = "manifeste.json";
export const NOM_EMPREINTES = "manifeste.sha256";

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Racine de l'archive : `dossier-<code en minuscules>` (le code d'un projet suit deja `^[A-Z0-9][A-Z0-9_-]{1,63}$` ; tout autre caractere devient `-`). */
export function racineDossier(code: string): string {
  return `dossier-${code.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

/** Nom du GeoJSON d'un jeu : role en minuscules, version, identifiant (aucun nom de fichier ni de concessionnaire). */
export function nomGeojson(j: { role: string; version: number; id: string }): string {
  return `geojson/${j.role.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-v${j.version}-${j.id.toLowerCase().replace(/[^a-z0-9-]/g, "")}.geojson`;
}

export interface EntreeManifeste { chemin: string; octets: number; sha256: string }

/** Empreintes des fichiers (chemins RELATIFS a la racine), dans l'ordre donne. */
export function empreintes(fichiers: readonly { chemin: string; contenu: Buffer }[]): EntreeManifeste[] {
  return fichiers.map((f) => ({ chemin: f.chemin, octets: f.contenu.length, sha256: sha256(f.contenu) }));
}

/** Texte `sha256sum` : `<empreinte>  <chemin>` par ligne, fin de ligne LF. */
export function texteEmpreintes(entrees: readonly EntreeManifeste[]): string {
  return entrees.map((e) => `${e.sha256}  ${e.chemin}\n`).join("");
}

/** JSON stable (cles dans l'ordre d'insertion, indentation de deux espaces, fin de ligne finale). */
export const jsonStable = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, "utf8");

/**
 * Assemble les fichiers de l'archive : contenus fournis (chemins relatifs), puis `manifeste.json` (qui recoit `fichiers`), puis `manifeste.sha256`.
 * Rend les fichiers prets pour le producteur ZIP (chemins prefixes par la racine) et les entrees du manifeste.
 */
export function assembler(racine: string, contenus: readonly { chemin: string; contenu: Buffer }[], manifeste: Record<string, unknown>): { fichiers: FichierZip[]; entrees: EntreeManifeste[]; manifeste: Record<string, unknown> } {
  const entrees = empreintes(contenus);
  const complet = { ...manifeste, fichiers: entrees };
  const json = jsonStable(complet);
  const toutes = [...entrees, { chemin: NOM_MANIFESTE, octets: json.length, sha256: sha256(json) }];
  const sums = Buffer.from(texteEmpreintes(toutes), "utf8");
  const fichiers: FichierZip[] = [
    ...contenus.map((c) => ({ nom: `${racine}/${c.chemin}`, contenu: c.contenu })),
    { nom: `${racine}/${NOM_MANIFESTE}`, contenu: json },
    { nom: `${racine}/${NOM_EMPREINTES}`, contenu: sums },
  ];
  return { fichiers, entrees: toutes, manifeste: complet };
}

/** Verification (tests, et outil pour un destinataire) : chaque ligne de `manifeste.sha256` correspond au contenu du fichier designe. */
export function verifierEmpreintes(texte: string, lire: (chemin: string) => Buffer | undefined): { ok: boolean; erreurs: string[] } {
  const erreurs: string[] = [];
  const lignes = texte.split("\n").filter(Boolean);
  for (const l of lignes) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l);
    if (!m) { erreurs.push(`ligne illisible : ${l}`); continue; }
    const c = lire(m[2]);
    if (!c) erreurs.push(`fichier absent : ${m[2]}`);
    else if (sha256(c) !== m[1]) erreurs.push(`empreinte differente : ${m[2]}`);
  }
  if (lignes.length === 0) erreurs.push("aucune ligne");
  return { ok: erreurs.length === 0, erreurs };
}
