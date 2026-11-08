/**
 * Balayage des extensions PostgreSQL : ce que le code emploie, ce que les migrations creent.
 *
 * POURQUOI (constat du 22/10/2026) : le code appelait `unaccent(...)` alors qu'aucune migration ne
 * creait l'extension (la production l'avait recue a la main). Sur une base reconstruite par les
 * seules migrations, `GET /api/public/carte/geo` repondait 500. Rien ne l'avait signale parce que
 * personne ne reconstruit la base a chaque livraison.
 *
 * Ce module est PUR (chaines en entree, structures en sortie) pour pouvoir etre eprouve avec des
 * sources fabriquees, y compris une CONTRE-EPREUVE : un code qui emploie une extension sans
 * migration doit etre refuse. Le test (`extensions-sql.test.ts`) lit ensuite le depot reel.
 *
 * CE QUE LE BALAYAGE NE VOIT PAS (limites assumees) :
 *   - les operateurs sans nom de fonction (`%` et `<->` de pg_trgm, `&&` de PostGIS) ;
 *   - le SQL construit dynamiquement (nom de fonction concatene) ;
 *   - une extension employee par une base de production sans trace dans le depot ;
 *   - le schema ou l'extension est installee (la creation sans `SCHEMA` la pose dans `public`,
 *     ce que le code suppose en appelant les fonctions sans prefixe).
 */

/** Extensions que le depot sait detecter et dont il exige une migration. */
export const EXTENSIONS_CONNUES = ["postgis", "btree_gist", "pg_trgm", "unaccent"] as const;
export type ExtensionConnue = (typeof EXTENSIONS_CONNUES)[number];

/**
 * Signatures d'emploi, par extension. Une signature est un motif qui n'apparait qu'avec
 * l'extension (une fonction, une classe d'operateurs, un type). Les motifs sont volontairement
 * etroits : un faux positif ferait exiger une migration pour rien, un faux negatif est le defaut
 * qu'on cherche a eviter.
 */
export const SIGNATURES: Readonly<Record<ExtensionConnue, readonly RegExp[]>> = {
  postgis: [
    /\bST_[A-Za-z0-9_]+\s*\(/i,
    /::\s*(geography|geometry)\b/i,
    /\b(geography|geometry)\s*\(\s*[A-Za-z]+\s*,\s*\d+\s*\)/i,
    /\bUnsupported\(\s*"geometry/i,
    /\bpostgis_[a-z_]+\s*\(/i,
  ],
  btree_gist: [/\bEXCLUDE\s+USING\s+gist\b/i],
  pg_trgm: [
    /\b(?:strict_|word_)?similarity\s*\(/i,
    /\bshow_trgm\s*\(/i,
    /\bset_limit\s*\(/i,
    /\bgin_trgm_ops\b/i,
    /\bgist_trgm_ops\b/i,
  ],
  unaccent: [/\bunaccent\s*\(/i],
};

/**
 * Signatures d'extensions HORS de la liste connue. Si l'une apparait, le test echoue et demande
 * soit d'ajouter l'extension a EXTENSIONS_CONNUES (avec sa migration), soit de retirer l'emploi :
 * on n'ajoute pas une dependance a une extension sans que le depot sache la creer.
 */
export const SIGNATURES_INCONNUES: Readonly<Record<string, readonly RegExp[]>> = {
  "uuid-ossp": [/\buuid_generate_v[0-9a-z]+\s*\(/i],
  pgcrypto: [/\bgen_salt\s*\(/i, /\bcrypt\s*\(\s*[^)]*,\s*gen_salt/i, /\bpgp_sym_(?:en|de)crypt\s*\(/i],
  fuzzystrmatch: [/\b(?:levenshtein|soundex|dmetaphone|metaphone)\s*\(/i],
  citext: [/::\s*citext\b/i, /\bcitext\b\s*(?:,|\)|NOT NULL|DEFAULT)/i],
  hstore: [/::\s*hstore\b/i, /\bhstore\s*\(/i],
  ltree: [/::\s*ltree\b/i],
  tablefunc: [/\bcrosstab\s*\(/i],
  pg_stat_statements: [/\bpg_stat_statements\b/i],
  vector: [/::\s*vector\b/i, /\bvector\s*\(\s*\d+\s*\)/i],
};

/** Retire les commentaires SQL (`--` et bloc) et TypeScript (`//` et bloc), sans toucher aux chaines. */
export function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((ligne) => {
      const t = ligne.trimStart();
      if (t.startsWith("//") || t.startsWith("--") || t.startsWith("*")) return "";
      // commentaire de fin de ligne, precede d'un espace : `x // note` ou `x -- note`
      return ligne.replace(/\s(?:\/\/|--)\s.*$/, "");
    })
    .join("\n");
}

/** Extensions creees par un fichier SQL de migration (`CREATE EXTENSION [IF NOT EXISTS] nom`). */
export function extensionsCreees(sql: string): Array<{ nom: string; position: number }> {
  const out: Array<{ nom: string; position: number }> = [];
  const re = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_-]+)"?/gi;
  const nu = sansCommentaires(sql);
  for (let m = re.exec(nu); m; m = re.exec(nu)) out.push({ nom: m[1].toLowerCase(), position: m.index });
  return out;
}

/** Extensions declarees par le schema Prisma (`extensions = [postgis, ...]`). */
export function extensionsDuSchemaPrisma(schema: string): string[] {
  const m = /^\s*extensions\s*=\s*\[([^\]]*)\]/m.exec(sansCommentaires(schema));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/\(.*$/, "").replace(/["']/g, "").toLowerCase())
    .filter(Boolean);
}

export interface Emploi {
  extension: string;
  position: number;
  extrait: string;
}

/** Emplois d'extensions dans une source (TypeScript ou SQL), connues et inconnues. */
export function emploisExtensions(source: string): { connus: Emploi[]; inconnus: Emploi[] } {
  const nu = sansCommentaires(source);
  const trouver = (ext: string, motifs: readonly RegExp[], dans: Emploi[]) => {
    for (const re of motifs) {
      const m = re.exec(nu);
      if (m) {
        dans.push({ extension: ext, position: m.index, extrait: nu.slice(m.index, m.index + 60).split("\n")[0] });
        return; // un emploi suffit par extension et par fichier
      }
    }
  };
  const connus: Emploi[] = [];
  const inconnus: Emploi[] = [];
  for (const ext of EXTENSIONS_CONNUES) trouver(ext, SIGNATURES[ext], connus);
  for (const [ext, motifs] of Object.entries(SIGNATURES_INCONNUES)) trouver(ext, motifs, inconnus);
  return { connus, inconnus };
}

export interface Migration {
  nom: string;
  sql: string;
}
export interface Source {
  chemin: string;
  contenu: string;
}

export interface Violation {
  type: "EXTENSION_NON_CREEE" | "EXTENSION_CREEE_APRES_EMPLOI" | "EXTENSION_INCONNUE" | "CREATION_INCONNUE";
  detail: string;
}

/**
 * Verifie la coherence entre les emplois et les migrations.
 * - `migrations` : dans l'ordre d'application (tri lexical du nom, comme Prisma).
 * - `sources` : code applicatif, scripts, bancs, SQL de tests : tout ce qui s'execute sur la base.
 * - `schemaPrisma` : contenu de schema.prisma (extensions declarees).
 */
export function verifierExtensions(
  migrations: readonly Migration[],
  sources: readonly Source[],
  schemaPrisma: string,
): Violation[] {
  const violations: Violation[] = [];
  const ordonnees = [...migrations].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));

  // Premiere creation de chaque extension : (indice de migration, position dans le fichier).
  const creation = new Map<string, { idx: number; position: number; nom: string }>();
  ordonnees.forEach((mig, idx) => {
    for (const c of extensionsCreees(mig.sql)) {
      if (!(EXTENSIONS_CONNUES as readonly string[]).includes(c.nom)) {
        violations.push({
          type: "CREATION_INCONNUE",
          detail: `${mig.nom} cree l'extension « ${c.nom} » absente de EXTENSIONS_CONNUES (src/lib/extensions-sql.ts) : l'ajouter avec ses signatures d'emploi`,
        });
      }
      if (!creation.has(c.nom)) creation.set(c.nom, { idx, position: c.position, nom: mig.nom });
    }
  });

  // Extensions declarees par le schema Prisma.
  for (const ext of extensionsDuSchemaPrisma(schemaPrisma)) {
    if (!creation.has(ext)) {
      violations.push({
        type: "EXTENSION_NON_CREEE",
        detail: `schema.prisma declare l'extension « ${ext} » mais aucune migration ne la cree`,
      });
    }
  }

  // Emplois dans les migrations elles-memes : l'extension doit etre creee avant (ou dans le meme fichier, plus haut).
  ordonnees.forEach((mig, idx) => {
    const { connus, inconnus } = emploisExtensions(mig.sql);
    for (const e of connus) {
      const c = creation.get(e.extension);
      if (!c) {
        violations.push({ type: "EXTENSION_NON_CREEE", detail: `${mig.nom} emploie « ${e.extension} » (${e.extrait.trim()}) et aucune migration ne la cree` });
      } else if (c.idx > idx || (c.idx === idx && c.position > e.position)) {
        violations.push({
          type: "EXTENSION_CREEE_APRES_EMPLOI",
          detail: `${mig.nom} emploie « ${e.extension} » (${e.extrait.trim()}) avant sa creation par ${c.nom} : le rejeu depuis une base vide echouerait`,
        });
      }
    }
    for (const e of inconnus) {
      violations.push({ type: "EXTENSION_INCONNUE", detail: `${mig.nom} emploie une signature de « ${e.extension} » (${e.extrait.trim()}), extension hors liste connue` });
    }
  });

  // Emplois dans le code et les bancs : il suffit qu'une migration la cree.
  for (const src of sources) {
    const { connus, inconnus } = emploisExtensions(src.contenu);
    for (const e of connus) {
      if (!creation.has(e.extension)) {
        violations.push({ type: "EXTENSION_NON_CREEE", detail: `${src.chemin} emploie « ${e.extension} » (${e.extrait.trim()}) et aucune migration ne la cree` });
      }
    }
    for (const e of inconnus) {
      violations.push({ type: "EXTENSION_INCONNUE", detail: `${src.chemin} emploie une signature de « ${e.extension} » (${e.extrait.trim()}), extension hors liste connue` });
    }
  }
  return violations;
}
