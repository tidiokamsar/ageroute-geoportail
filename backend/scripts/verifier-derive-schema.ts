/**
 * Detecteur de derive entre `prisma/schema.prisma` et la base que PRODUISENT les migrations.
 *
 * POURQUOI. Le Lot 0 a trouve cinq colonnes de `medias_observation` declarees par le schema et
 * jamais creees par une migration : la production, construite par `prisma db push`, les avait ; une
 * base reconstruite par `migrate deploy` ne les avait pas. Aucun test ne le voyait. Ce script compare
 * le schema a une base LOCALE issue des migrations et echoue (code 1) en listant chaque ecart.
 *
 * LECTURE SEULE sur la cible : il appelle `prisma migrate diff` (commande en lecture seule, voir
 * `prisma migrate diff --help`) et quelques SELECT sur le catalogue. Avec `--reconstruire` il cree sa
 * propre base `essai_derive`, y rejoue la chaine (avec le pont de `descentes/ponts/`) puis la detruit.
 *
 * GARDE. `tests-integration/lib/garde.ts` termine le processus (code 3) si DATABASE_URL n'est pas
 * une base locale nommee `replay` ou `essai_<nom>`. Aucune autre cible n'est atteignable.
 *
 * LE MOT DE PASSE N'EST JAMAIS SUR LA LIGNE DE COMMANDE : la CLI Prisma lit la base par
 * `--from-schema-datasource` (donc par la variable d'environnement), pas par `--from-url`.
 *
 * CE QUE PRISMA NE SAIT PAS REPRESENTER ET QUI NE DOIT PAS FAIRE ECHOUER (EXCEPTIONS, voir
 * `EXCEPTIONS` ci-dessous et docs/securite/DERIVE-SCHEMA.md) :
 *   - index partiels (WHERE) : `where:` est refuse par la validation de Prisma 5.22 ;
 *   - index d'expression ;
 *   - index GiST des colonnes geometry (declarables par `type: Gist`, mais non declares ici) ;
 *   - valeur par defaut de base sur `id` et `updatedAt` (Prisma les genere cote client) ;
 *   - extensions PostgreSQL et tables de l'outillage (`_prisma_migrations`, `spatial_ref_sys`).
 * CHECK, declencheurs, fonctions et vues n'apparaissent JAMAIS dans la sortie de `migrate diff` :
 * ils sont un angle mort, dont le script imprime les comptes ; les comparer exige l'instantane
 * `prisma/descentes/instantane-schema.sql`.
 *
 * Usage (depuis backend/) :
 *   DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay \
 *     npx tsx scripts/verifier-derive-schema.ts [--reconstruire] [--garder] [--verbeux]
 *       [--connues fichier.json] [--json fichier.json]
 * Codes de sortie : 0 aucune derive, 1 derive, 2 erreur technique, 3 cible refusee par la garde.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// Noyau pur : decoupage et classement du script produit par `migrate diff`. Sans E/S.
// ---------------------------------------------------------------------------------------------

/** Un ecart elementaire : une instruction, ou une clause d'un ALTER TABLE. */
export interface ElementDiff {
  /** Titre de section ecrit par Prisma (`AlterTable`, `DropIndex`, ...). */
  type: string;
  sql: string;
}

export type Classe = "derive" | "exception" | "connue";
export type Sens = "manque_en_base" | "excedent_en_base" | "ecart";
export type Gravite = "elevee" | "moyenne" | "faible";

export interface Difference extends ElementDiff {
  classe: Classe;
  sens: Sens;
  gravite: Gravite;
  /** Identifiant dans `EXCEPTIONS` quand `classe` vaut `exception`. */
  exception?: string;
  raison: string;
  signature: string;
}

export interface InfoIndex {
  methode: string;
  partiel: boolean;
  expression: boolean;
}

export interface Contexte {
  /** Index de la base, par nom. */
  index: Map<string, InfoIndex>;
  /** Cles etrangeres de la base : `table.contrainte` vers `pg_get_constraintdef`. */
  cles: Map<string, string>;
}

export const EXCEPTIONS: ReadonlyArray<{ id: string; titre: string; pourquoi: string }> = [
  {
    id: "EX-GIST",
    titre: "Index non btree (GiST) present en base, absent du schema",
    pourquoi:
      "Les index GiST des colonnes geometry sont crees par des migrations SQL. Prisma 5.22 sait les declarer (`type: Gist` est accepte sur une colonne Unsupported, verifie par `prisma validate`), mais ce depot ne le fait pas. Un `db push` les supprimerait : c'est dit dans DERIVE-SCHEMA.md.",
  },
  {
    id: "EX-PARTIEL",
    titre: "Index partiel (WHERE)",
    pourquoi:
      "Prisma 5.22 refuse `where:` sur un index (erreur de validation `No such argument`) et ne voit pas l'index partiel de la base : il propose de recreer l'index sous le meme nom, ou de supprimer celui qu'il ne reconnait pas.",
  },
  {
    id: "EX-EXPRESSION",
    titre: "Index d'expression",
    pourquoi: "Aucune syntaxe de schema.prisma ne decrit une expression dans un index.",
  },
  {
    id: "EX-DEFAUT-CLIENT",
    titre: "Valeur par defaut de base sur id ou updatedAt",
    pourquoi:
      "`@default(uuid())` et `@updatedAt` sont produits par le client Prisma, sans valeur par defaut en base. La base en garde une (migrations SQL, insertions manuelles). Sans effet sur l'application.",
  },
  {
    id: "EX-EXTENSION",
    titre: "Extension PostgreSQL",
    pourquoi: "Les extensions utilisees par les migrations (postgis, btree_gist, pg_trgm, unaccent) ne sont pas toutes declarees dans le datasource.",
  },
  {
    id: "EX-TABLE-OUTIL",
    titre: "Table de l'outillage",
    pourquoi: "`_prisma_migrations` (historique de Prisma) et `spatial_ref_sys` (PostGIS) n'ont pas de modele.",
  },
];

const EXTENSIONS_CONNUES = new Set(["postgis", "btree_gist", "pg_trgm", "unaccent", "plpgsql"]);
const TABLES_OUTIL = new Set(["_prisma_migrations", "spatial_ref_sys"]);
const COLONNES_GENEREES_CLIENT = new Set(["id", "updatedAt"]);

const normaliser = (s: string) => s.replace(/\s+/g, " ").trim();

/** Decoupe le script de `prisma migrate diff --script` en ecarts elementaires. */
export function decouperDiff(script: string): ElementDiff[] {
  const sorties: ElementDiff[] = [];
  let type = "";
  let tampon: string[] = [];

  const ajouter = (brut: string) => {
    const sql = brut.trim();
    const alter = /^ALTER TABLE "([^"]+)"\s+([\s\S]*);$/.exec(sql);
    if (alter) {
      // Une instruction ALTER TABLE de Prisma regroupe plusieurs clauses : chacune est un ecart.
      for (const clause of alter[2].split(/,\s*\n(?=(?:ADD|DROP|ALTER|RENAME)\b)/)) {
        sorties.push({ type, sql: normaliser(`ALTER TABLE "${alter[1]}" ${clause};`) });
      }
    } else {
      sorties.push({ type, sql: normaliser(sql) });
    }
  };

  for (const brut of script.split(/\r?\n/)) {
    const ligne = brut.trimEnd();
    if (tampon.length === 0) {
      const titre = /^-- ([A-Z][A-Za-z]+)$/.exec(ligne);
      if (titre) { type = titre[1]; continue; }
      if (ligne.trim() === "" || ligne.startsWith("--")) continue;
    }
    tampon.push(ligne);
    if (ligne.endsWith(";")) { ajouter(tampon.join("\n")); tampon = []; }
  }
  if (tampon.length > 0) ajouter(tampon.join("\n")); // instruction non terminee : on ne la perd pas
  return sorties;
}

/** Noms des contraintes visees par les ecarts d'un type donne (`AddForeignKey`, `DropForeignKey`). */
function nomsContraintes(els: ElementDiff[], type: string): Set<string> {
  const noms = new Set<string>();
  for (const e of els) {
    const m = e.type === type ? /CONSTRAINT "([^"]+)"/.exec(e.sql) : null;
    if (m) noms.add(m[1]);
  }
  return noms;
}

type Verdict = Pick<Difference, "classe" | "sens" | "gravite" | "raison" | "exception">;

const ecart = (sens: Sens, gravite: Gravite, raison: string): Verdict => ({ classe: "derive", sens, gravite, raison });
const exception = (id: string, sens: Sens, raison: string): Verdict => ({ classe: "exception", sens, gravite: "faible", raison, exception: id });

const ACTIONS_FK = "CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION";

/** Action referentielle d'une definition de cle etrangere (NO ACTION quand elle n'est pas ecrite). */
function actionFk(def: string, evenement: "DELETE" | "UPDATE"): string {
  return new RegExp(`ON ${evenement} (${ACTIONS_FK})`).exec(def)?.[1] ?? "NO ACTION";
}

/** `FOREIGN KEY (colonnes) REFERENCES table(colonnes)`, sans guillemets ni espaces : pour comparer. */
function ossatureFk(def: string): string {
  return (/FOREIGN KEY\s*\(.*?\)\s*REFERENCES\s*[^\s(]+\s*\(.*?\)/.exec(def)?.[0] ?? def).replace(/["\s]/g, "");
}

/** Une cle etrangere presente des deux cotes avec une definition differente : de quelle facon ? */
function ecartCle(nom: string, table: string, sqlSchema: string, defBase: string | undefined): Verdict {
  if (!defBase) return ecart("ecart", "moyenne", `cle etrangere ${nom} : definition differente de celle du schema (definition de la base illisible)`);
  const morceaux: string[] = [];
  let gravite: Gravite = "faible";
  if (ossatureFk(defBase) !== ossatureFk(sqlSchema)) { morceaux.push("colonnes ou table cible differentes"); gravite = "moyenne"; }
  for (const ev of ["DELETE", "UPDATE"] as const) {
    const base = actionFk(defBase, ev);
    const schema = actionFk(sqlSchema, ev);
    if (base !== schema) {
      morceaux.push(`ON ${ev} : base ${base}, schema ${schema}`);
      if (ev === "DELETE") gravite = "moyenne"; // le comportement a la suppression change
    }
  }
  return ecart("ecart", gravite, `cle etrangere ${table}.${nom} : ${morceaux.join(" ; ") || "definition differente"}`);
}

function classerUn(e: ElementDiff, ctx: Contexte, fkSupprimees: Set<string>): Verdict {
  const sql = e.sql;
  let m: RegExpExecArray | null;

  // --- types enumeres
  if ((m = /^ALTER TYPE "([^"]+)" ADD VALUE '([^']*)'/.exec(sql))) {
    return ecart("manque_en_base", "elevee", `valeur ${m[2]} du type ${m[1]} declaree par le schema, absente de la base : une ecriture de cette valeur echouerait`);
  }
  if ((m = /^CREATE TYPE "([^"]+)"/.exec(sql))) return ecart("manque_en_base", "elevee", `type ${m[1]} absent de la base`);
  if ((m = /^DROP TYPE "([^"]+)"/.exec(sql))) return ecart("excedent_en_base", "moyenne", `type ${m[1]} en base, absent du schema`);

  // --- extensions
  if ((m = /^(?:CREATE|DROP|ALTER) EXTENSION (?:IF (?:NOT )?EXISTS )?"?([a-z_0-9-]+)"?/i.exec(sql))) {
    return EXTENSIONS_CONNUES.has(m[1].toLowerCase())
      ? exception("EX-EXTENSION", "ecart", `extension ${m[1]} utilisee par les migrations`)
      : ecart("ecart", "moyenne", `extension ${m[1]} inconnue`);
  }

  // --- tables
  if ((m = /^DROP TABLE "([^"]+)"/.exec(sql))) {
    if (TABLES_OUTIL.has(m[1])) return exception("EX-TABLE-OUTIL", "excedent_en_base", `table ${m[1]} de l'outillage`);
    return ecart("excedent_en_base", "elevee", `table ${m[1]} presente en base, sans modele dans le schema : un db push la supprimerait avec ses donnees`);
  }
  if ((m = /^CREATE TABLE "([^"]+)"/.exec(sql))) return ecart("manque_en_base", "elevee", `table ${m[1]} declaree par le schema, absente de la base`);

  // --- index
  if ((m = /^DROP INDEX "([^"]+)"/.exec(sql))) {
    const info = ctx.index.get(m[1]);
    if (!info) return ecart("excedent_en_base", "moyenne", `index ${m[1]} introuvable dans le catalogue (la lecture du catalogue a echoue ?)`);
    if (info.methode !== "btree") return exception("EX-GIST", "excedent_en_base", `index ${m[1]} (${info.methode}) cree par migration SQL, non declare dans le schema`);
    if (info.partiel) return exception("EX-PARTIEL", "excedent_en_base", `index partiel ${m[1]}`);
    if (info.expression) return exception("EX-EXPRESSION", "excedent_en_base", `index d'expression ${m[1]}`);
    return ecart("excedent_en_base", "moyenne", `index btree ${m[1]} cree par migration, non declare dans le schema (ajouter @@index(..., map: "${m[1]}")) : un db push le supprimerait`);
  }
  if ((m = /^CREATE (UNIQUE )?INDEX "([^"]+)"/.exec(sql))) {
    const unique = Boolean(m[1]);
    const info = ctx.index.get(m[2]);
    if (info?.partiel) return exception("EX-PARTIEL", "ecart", `le schema declare ${m[2]} sans clause WHERE ; la base porte la version partielle`);
    if (info?.expression) return exception("EX-EXPRESSION", "ecart", `le schema declare ${m[2]} sur colonnes ; la base porte une expression`);
    if (info) return ecart("ecart", "moyenne", `index ${m[2]} present en base avec une definition differente de celle du schema`);
    return ecart("manque_en_base", unique ? "elevee" : "moyenne", `${unique ? "index UNIQUE" : "index"} ${m[2]} declare par le schema, absent de la base${unique ? " : l'unicite n'est pas garantie" : ""}`);
  }
  if ((m = /^ALTER INDEX "([^"]+)" RENAME TO "([^"]+)"/.exec(sql))) {
    return ecart("ecart", "faible", `nom d'index : la base porte ${m[1]}, le schema attend ${m[2]} (declarer map: "${m[1]}" dans le schema ; sans effet fonctionnel)`);
  }

  // --- clauses d'ALTER TABLE
  if ((m = /^ALTER TABLE "([^"]+)" (.*)$/.exec(sql))) {
    const [, table, clause] = m;
    let c: RegExpExecArray | null;
    if ((c = /^DROP CONSTRAINT "([^"]+)";$/.exec(clause))) {
      if (e.type === "DropForeignKey") {
        // Une suppression suivie d'un ajout du meme nom est traitee a l'ajout (voir classerDiff).
        return ecart("excedent_en_base", "moyenne", `cle etrangere ${table}.${c[1]} en base, non declaree dans le schema (champ sans @relation) : un db push la supprimerait`);
      }
      return ecart("excedent_en_base", "elevee", `contrainte ${c[1]} de ${table} en base, non declaree dans le schema`);
    }
    if ((c = /^ADD CONSTRAINT "([^"]+)" FOREIGN KEY/.exec(clause))) {
      return fkSupprimees.has(c[1])
        ? ecartCle(c[1], table, clause, ctx.cles.get(`${table}.${c[1]}`))
        : ecart("manque_en_base", "moyenne", `cle etrangere ${table}.${c[1]} declaree par le schema, absente de la base`);
    }
    if ((c = /^ADD COLUMN\s+"([^"]+)"/.exec(clause))) return ecart("manque_en_base", "elevee", `colonne ${table}.${c[1]} declaree par le schema, absente de la base : toute requete du client sur ${table} echoue`);
    if ((c = /^DROP COLUMN\s+"([^"]+)"/.exec(clause))) return ecart("excedent_en_base", "elevee", `colonne ${table}.${c[1]} en base, absente du schema : un db push la supprimerait avec ses donnees`);
    if ((c = /^ALTER COLUMN\s+"([^"]+)"\s+DROP DEFAULT/.exec(clause))) {
      if (COLONNES_GENEREES_CLIENT.has(c[1])) return exception("EX-DEFAUT-CLIENT", "excedent_en_base", `${table}.${c[1]} : defaut de base, valeur produite cote client`);
      return ecart("excedent_en_base", "moyenne", `${table}.${c[1]} : defaut de base non declare dans le schema`);
    }
    if ((c = /^ALTER COLUMN\s+"([^"]+)"\s+SET DEFAULT/.exec(clause))) return ecart("manque_en_base", "moyenne", `${table}.${c[1]} : defaut declare par le schema, absent de la base`);
    if ((c = /^ALTER COLUMN\s+"([^"]+)"\s+SET DATA TYPE/.exec(clause))) return ecart("ecart", "elevee", `${table}.${c[1]} : type different de celui du schema`);
    if ((c = /^ALTER COLUMN\s+"([^"]+)"\s+SET NOT NULL/.exec(clause))) return ecart("manque_en_base", "elevee", `${table}.${c[1]} : NOT NULL declare par le schema, absent de la base`);
    if ((c = /^ALTER COLUMN\s+"([^"]+)"\s+DROP NOT NULL/.exec(clause))) return ecart("ecart", "moyenne", `${table}.${c[1]} : NOT NULL en base, colonne optionnelle dans le schema`);
    return ecart("ecart", "moyenne", `${table} : ecart non classe (${clause.slice(0, 80)})`);
  }

  return ecart("ecart", "moyenne", "instruction non reconnue par le classeur : a lire a la main");
}

/** Classe tous les ecarts. `connues` : signatures acceptees (reference de derive deja connue). */
export function classerDiff(elements: ElementDiff[], ctx: Contexte, connues: ReadonlySet<string> = new Set()): Difference[] {
  const fkAjoutees = nomsContraintes(elements, "AddForeignKey");
  const fkSupprimees = nomsContraintes(elements, "DropForeignKey");
  return elements
    // Une cle etrangere supprimee puis recreee sous le meme nom est UN ecart, porte par l'ajout.
    .filter((e) => !(e.type === "DropForeignKey" && fkAjoutees.has(/CONSTRAINT "([^"]+)"/.exec(e.sql)?.[1] ?? "")))
    .map((e) => {
      const v = classerUn(e, ctx, fkSupprimees);
      const signature = e.sql;
      const classe: Classe = v.classe === "derive" && connues.has(signature) ? "connue" : v.classe;
      return { ...e, ...v, classe, signature };
    });
}

export interface Bilan {
  derive: Difference[];
  exceptions: Difference[];
  connues: Difference[];
  /** Signatures de la reference qui n'apparaissent plus : a retirer de la reference. */
  obsoletes: string[];
}

export function bilan(diffs: Difference[], connues: ReadonlySet<string> = new Set()): Bilan {
  const vues = new Set(diffs.map((d) => d.signature));
  return {
    derive: diffs.filter((d) => d.classe === "derive"),
    exceptions: diffs.filter((d) => d.classe === "exception"),
    connues: diffs.filter((d) => d.classe === "connue"),
    obsoletes: [...connues].filter((s) => !vues.has(s)),
  };
}

const ORDRE_GRAVITE: Record<Gravite, number> = { elevee: 0, moyenne: 1, faible: 2 };
const ORDRE_SENS: Record<Sens, number> = { manque_en_base: 0, ecart: 1, excedent_en_base: 2 };

export function formaterRapport(b: Bilan, verbeux: boolean): string {
  const L: string[] = [];
  const tri = (a: Difference, c: Difference) =>
    ORDRE_SENS[a.sens] - ORDRE_SENS[c.sens] || ORDRE_GRAVITE[a.gravite] - ORDRE_GRAVITE[c.gravite] || a.sql.localeCompare(c.sql);
  const titres: Record<Sens, string> = {
    manque_en_base: "MANQUE EN BASE (le schema attend, les migrations ne le creent pas)",
    ecart: "ECART DE DEFINITION",
    excedent_en_base: "EXCEDENT EN BASE (les migrations creent, le schema ne le declare pas ; db push le supprimerait)",
  };
  L.push(`Derive : ${b.derive.length}   exceptions documentees : ${b.exceptions.length}   connues : ${b.connues.length}`);
  for (const sens of ["manque_en_base", "ecart", "excedent_en_base"] as const) {
    const lot = b.derive.filter((d) => d.sens === sens).sort(tri);
    if (lot.length === 0) continue;
    L.push("", `${titres[sens]} : ${lot.length}`);
    for (const d of lot) L.push(`  [${d.gravite}] ${d.raison}`, `      ${d.sql}`);
  }
  if (b.exceptions.length > 0) {
    L.push("", "EXCEPTIONS DOCUMENTEES (non comptees comme derive)");
    const parId = new Map<string, Difference[]>();
    for (const d of b.exceptions) parId.set(d.exception!, [...(parId.get(d.exception!) ?? []), d]);
    for (const [id, lot] of [...parId].sort()) {
      const def = EXCEPTIONS.find((x) => x.id === id);
      L.push(`  ${id} (${lot.length}) : ${def?.titre ?? ""}`);
      if (verbeux) for (const d of lot) L.push(`      ${d.raison}`);
    }
  }
  if (b.connues.length > 0) {
    L.push("", `DERIVES CONNUES (acceptees par la reference) : ${b.connues.length}`);
    if (verbeux) for (const d of b.connues) L.push(`      ${d.sql}`);
  }
  if (b.obsoletes.length > 0) L.push("", `REFERENCE OBSOLETE : ${b.obsoletes.length} entree(s) ne correspondent plus a aucun ecart, a retirer de la reference`);
  return L.join("\n");
}

/** Remplace la base d'une URL PostgreSQL (la garde a deja valide l'hote). */
export function urlVersBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// Coquille : E/S, base locale, CLI Prisma.
// ---------------------------------------------------------------------------------------------

const RACINE = path.resolve(__dirname, "..");
const BASE_DERIVE = "essai_derive";

interface Options { reconstruire: boolean; garder: boolean; verbeux: boolean; connues?: string; json?: string; aide: boolean }

function lireOptions(argv: string[]): Options {
  const o: Options = { reconstruire: false, garder: false, verbeux: false, aide: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reconstruire") o.reconstruire = true;
    else if (a === "--garder") o.garder = true;
    else if (a === "--verbeux") o.verbeux = true;
    else if (a === "--aide" || a === "-h") o.aide = true;
    else if (a === "--connues") o.connues = argv[++i];
    else if (a === "--json") o.json = argv[++i];
    else throw new Error(`option inconnue : ${a}`);
  }
  return o;
}

const AIDE = `Detecteur de derive schema.prisma / migrations (lecture seule sur la cible).
  DATABASE_URL=postgresql://utilisateur:motdepasse@127.0.0.1:5434/replay npx tsx scripts/verifier-derive-schema.ts [options]
  --reconstruire   cree essai_derive, y rejoue les migrations (+ pont D-10), compare, puis la detruit
  --garder         avec --reconstruire : conserve essai_derive
  --connues f.json reference d'ecarts connus (tableau de signatures) : ils ne font pas echouer
  --json f.json    ecrit le detail (ecarts, exceptions, angle mort) dans un fichier
  --verbeux        detaille les exceptions et les ecarts connus
Sorties : 0 aucune derive, 1 derive, 2 erreur technique, 3 cible refusee par la garde.`;

type Client = import("pg").Client;

async function ouvrir(url: string): Promise<Client> {
  const { Client: C } = (await import("pg")).default;
  const c = new C({ connectionString: url });
  await c.connect();
  return c;
}

/** Cree `essai_derive` vide, rejoue les migrations dans l'ordre, avec le pont apres sa migration. */
async function reconstruire(urlOrigine: string): Promise<string> {
  const admin = await ouvrir(urlVersBase(urlOrigine, "postgres"));
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${BASE_DERIVE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${BASE_DERIVE} TEMPLATE template0`);
  } finally { await admin.end(); }

  const url = urlVersBase(urlOrigine, BASE_DERIVE);
  const c = await ouvrir(url);
  const dossier = path.join(RACINE, "prisma", "migrations");
  const ponts = path.join(RACINE, "prisma", "descentes", "ponts");
  const noms = readdirSync(dossier).filter((n) => /^\d{14}_/.test(n)).sort();
  try {
    for (const nom of noms) {
      try {
        await c.query(readFileSync(path.join(dossier, nom, "migration.sql"), "utf8"));
        const pont = path.join(ponts, `${nom}.sql`);
        if (existsSync(pont)) { await c.query(readFileSync(pont, "utf8")); console.log(`  pont D-10 applique apres ${nom}`); }
      } catch (e) {
        throw new Error(`la migration ${nom} ne s'applique pas sur la base reconstruite : ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally { await c.end(); }
  console.log(`Base ${BASE_DERIVE} reconstruite : ${noms.length} migrations rejouees.`);
  return url;
}

async function supprimerBaseDerive(urlOrigine: string): Promise<void> {
  const admin = await ouvrir(urlVersBase(urlOrigine, "postgres"));
  try { await admin.query(`DROP DATABASE IF EXISTS ${BASE_DERIVE} WITH (FORCE)`); } finally { await admin.end(); }
}

/** Execute `prisma migrate diff` : base (via DATABASE_URL de l'environnement) vers schema.prisma. */
function diffPrisma(url: string): { script: string; vide: boolean } {
  const cli = path.join(RACINE, "node_modules", "prisma", "build", "index.js");
  if (!existsSync(cli)) throw new Error("CLI Prisma introuvable (npm ci non lance ?)");
  const r = spawnSync(
    process.execPath,
    [cli, "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--script", "--exit-code"],
    { cwd: RACINE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" } },
  );
  if (r.error) throw r.error;
  // --exit-code : 0 vide, 1 erreur, 2 non vide.
  if (r.status === 0) return { script: "", vide: true };
  if (r.status === 2) return { script: r.stdout, vide: false };
  throw new Error(`prisma migrate diff a echoue (code ${r.status}) : ${(r.stderr || r.stdout).slice(0, 600)}`);
}

async function lireContexte(url: string): Promise<{ ctx: Contexte; angleMort: Record<string, number | string> }> {
  const c = await ouvrir(url);
  try {
    const idx = await c.query<{ nom: string; methode: string; partiel: boolean; expression: boolean }>(
      `SELECT i.relname AS nom, am.amname AS methode, ix.indpred IS NOT NULL AS partiel, ix.indexprs IS NOT NULL AS expression
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
        WHERE n.nspname = 'public'`,
    );
    const index = new Map(idx.rows.map((r) => [r.nom, { methode: r.methode, partiel: r.partiel, expression: r.expression }]));
    const fk = await c.query<{ nom: string; def: string }>(
      `SELECT t.relname || '.' || k.conname AS nom, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k
         JOIN pg_class t ON t.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND k.contype = 'f'`,
    );
    const cles = new Map(fk.rows.map((r) => [r.nom, r.def]));
    const un = async (sql: string) => Number((await c.query<{ n: string }>(sql)).rows[0].n);
    const horsExtension = (alias: string, classe: string) =>
      `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ${alias}.oid AND d.classid = '${classe}'::regclass AND d.deptype = 'e')`;
    const angleMort: Record<string, number | string> = {
      contraintes_check: await un(`SELECT count(*) AS n FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public' AND k.contype = 'c'`),
      declencheurs: await un(`SELECT count(*) AS n FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal`),
      fonctions: await un(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND ${horsExtension("p", "pg_proc")}`),
      vues: await un(`SELECT count(*) AS n FROM pg_class v JOIN pg_namespace n ON n.oid = v.relnamespace WHERE n.nspname = 'public' AND v.relkind IN ('v','m') AND ${horsExtension("v", "pg_class")}`),
      index_partiels: idx.rows.filter((r) => r.partiel).length,
      index_non_btree: idx.rows.filter((r) => r.methode !== "btree").length,
      index_expression: idx.rows.filter((r) => r.expression).length,
      extensions: (await c.query<{ e: string }>(`SELECT string_agg(extname, ', ' ORDER BY extname) AS e FROM pg_extension`)).rows[0].e,
    };
    return { ctx: { index, cles }, angleMort };
  } finally { await c.end(); }
}

function lireConnues(fichier: string): Set<string> {
  const brut: unknown = JSON.parse(readFileSync(fichier, "utf8"));
  if (!Array.isArray(brut) || brut.some((x) => typeof x !== "string")) throw new Error(`${fichier} : un tableau de chaines (signatures) est attendu`);
  return new Set(brut as string[]);
}

async function main(): Promise<number> {
  const o = lireOptions(process.argv.slice(2));
  if (o.aide) { console.log(AIDE); return 0; }

  // Importer la garde la pose (effet de bord voulu) : le processus s'arrete ici avec le code 3 si la
  // cible n'est pas une base locale replay ou essai_<nom>.
  const { evaluerCible } = await import("../tests-integration/lib/garde");
  const origine = process.env.DATABASE_URL;
  const cible = evaluerCible(origine);
  if (!cible.ok) { console.error(`Cible refusee : ${cible.raison}.`); return 3; }
  console.log(`Cible : ${cible.hote} / ${cible.base}`);

  let url = origine!;
  let creee = false;
  try {
    if (o.reconstruire) {
      console.log(`Reconstruction de ${BASE_DERIVE} depuis les migrations...`);
      creee = true;
      url = await reconstruire(origine!);
    }
    const connues = o.connues ? lireConnues(o.connues) : new Set<string>();
    const { script, vide } = diffPrisma(url);
    const { ctx, angleMort } = await lireContexte(url);
    const elements = vide ? [] : decouperDiff(script);
    const b = bilan(classerDiff(elements, ctx, connues), connues);

    console.log(formaterRapport(b, o.verbeux));
    console.log("\nANGLE MORT (invisible pour `migrate diff`, compare par l'instantane de descentes/instantane-schema.sql) :");
    for (const [k, v] of Object.entries(angleMort)) console.log(`  ${k} : ${v}`);

    if (o.json) {
      writeFileSync(o.json, JSON.stringify({ cible: `${cible.hote}/${o.reconstruire ? BASE_DERIVE : cible.base}`, ...b, angleMort }, null, 2));
      console.log(`\nDetail ecrit dans ${o.json}`);
    }
    if (b.derive.length > 0) { console.log(`\nECHEC : ${b.derive.length} ecart(s) de derive.`); return 1; }
    console.log("\nOK : aucune derive hors exceptions documentees.");
    return 0;
  } finally {
    if (creee && !o.garder) await supprimerBaseDerive(origine!).catch(() => undefined);
  }
}

if (process.argv[1]?.includes("verifier-derive-schema")) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error("ERREUR TECHNIQUE :", e instanceof Error ? e.message : e); process.exitCode = 2; },
  );
}
