import { describe, expect, it } from "vitest";
import {
  bilan,
  classerDiff,
  decouperDiff,
  EXCEPTIONS,
  formaterRapport,
  urlVersBase,
  type Contexte,
  type Difference,
} from "./verifier-derive-schema";

/**
 * Classement de la sortie de `prisma migrate diff --script`.
 *
 * Ce classeur decide ce qui fait echouer le controle de derive et ce qui n'est qu'une limite de
 * Prisma. Se tromper dans un sens cree un faux rouge qu'on apprend a ignorer ; dans l'autre, il
 * laisse passer une colonne manquante, soit exactement le defaut de `medias_observation` du Lot 0.
 * Les textes ci-dessous reprennent la forme reelle de la sortie de Prisma 5.22.
 */

const ctx = (): Contexte => ({
  index: new Map([
    ["troncons_geom_gist", { methode: "gist", partiel: false, expression: false }],
    ["regions_code_key", { methode: "btree", partiel: true, expression: false }],
    ["ouvrages_expr_idx", { methode: "btree", partiel: false, expression: true }],
    ["bailleurs_deletedAt_idx", { methode: "btree", partiel: false, expression: false }],
  ]),
  cles: new Map([
    ["ot_photos.ot_photos_otId_fkey", 'FOREIGN KEY ("otId") REFERENCES ordres_travaux(id) ON DELETE CASCADE'],
    ["main_courante.main_courante_tronconId_fkey", 'FOREIGN KEY ("tronconId") REFERENCES troncons(id) ON DELETE RESTRICT'],
    ["ot_photos.ot_photos_autre_fkey", 'FOREIGN KEY ("autreId") REFERENCES ailleurs(id) ON DELETE CASCADE'],
  ]),
});

const classer = (script: string, c: Contexte = ctx(), connues: ReadonlySet<string> = new Set()) => classerDiff(decouperDiff(script), c, connues);
const unique = (script: string, c: Contexte = ctx()): Difference => {
  const r = classer(script, c);
  expect(r).toHaveLength(1);
  return r[0];
};

describe("decouperDiff", () => {
  it("rend une liste vide pour un script vide", () => {
    expect(decouperDiff("")).toEqual([]);
    expect(decouperDiff("\n\n")).toEqual([]);
  });

  it("separe un ALTER TABLE a plusieurs clauses en autant d'ecarts", () => {
    const r = decouperDiff(`-- AlterTable
ALTER TABLE "conflits_sync" ADD COLUMN     "verificationDemandeeA" TIMESTAMP(3),
ADD COLUMN     "verificationMotif" TEXT;
`);
    expect(r.map((e) => e.sql)).toEqual([
      'ALTER TABLE "conflits_sync" ADD COLUMN "verificationDemandeeA" TIMESTAMP(3);',
      'ALTER TABLE "conflits_sync" ADD COLUMN "verificationMotif" TEXT;',
    ]);
    expect(r.every((e) => e.type === "AlterTable")).toBe(true);
  });

  it("ne coupe pas une virgule a l'interieur d'un type (DECIMAL(12,2))", () => {
    const r = decouperDiff(`-- AlterTable
ALTER TABLE "marches" ADD COLUMN     "montant" DECIMAL(12,2),
ADD COLUMN     "note" TEXT;
`);
    expect(r).toHaveLength(2);
    expect(r[0].sql).toContain("DECIMAL(12,2)");
  });

  it("lit deux valeurs d'enumeration sous un meme titre, preambule de commentaires compris", () => {
    const r = decouperDiff(`-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration.


ALTER TYPE "ComposanteRci" ADD VALUE 'ENVIRONNEMENT';
ALTER TYPE "ComposanteRci" ADD VALUE 'AUTRES';

-- DropIndex
DROP INDEX "bailleurs_deletedAt_idx";
`);
    expect(r.map((e) => [e.type, e.sql])).toEqual([
      ["AlterEnum", `ALTER TYPE "ComposanteRci" ADD VALUE 'ENVIRONNEMENT';`],
      ["AlterEnum", `ALTER TYPE "ComposanteRci" ADD VALUE 'AUTRES';`],
      ["DropIndex", 'DROP INDEX "bailleurs_deletedAt_idx";'],
    ]);
  });

  it("ne perd pas une instruction non terminee", () => {
    expect(decouperDiff(`-- DropTable\nDROP TABLE "x"`)).toHaveLength(1);
  });
});

describe("ce qui DOIT faire echouer (derive reelle)", () => {
  it("une colonne declaree par le schema et absente de la base : le cas medias_observation du Lot 0", () => {
    const d = unique(`-- AlterTable\nALTER TABLE "medias_observation" ADD COLUMN "analyseConfiance" DOUBLE PRECISION;\n`);
    expect(d).toMatchObject({ classe: "derive", sens: "manque_en_base", gravite: "elevee" });
    expect(d.raison).toContain("medias_observation.analyseConfiance");
  });

  it("une valeur d'enumeration absente de la base", () => {
    const d = unique(`-- AlterEnum\nALTER TYPE "ComposanteRci" ADD VALUE 'AUTRES';\n`);
    expect(d).toMatchObject({ classe: "derive", sens: "manque_en_base", gravite: "elevee" });
  });

  it("une table, un type, un NOT NULL ou un index UNIQUE manquants", () => {
    expect(unique(`-- CreateTable\nCREATE TABLE "x" (\n    "id" TEXT NOT NULL,\n    CONSTRAINT "x_pkey" PRIMARY KEY ("id")\n);\n`)).toMatchObject({ classe: "derive", gravite: "elevee" });
    expect(unique(`-- CreateEnum\nCREATE TYPE "E" AS ENUM ('A');\n`)).toMatchObject({ classe: "derive", gravite: "elevee" });
    expect(unique(`-- AlterTable\nALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;\n`)).toMatchObject({ classe: "derive", gravite: "elevee" });
    expect(unique(`-- CreateIndex\nCREATE UNIQUE INDEX "t_c_key" ON "t"("c");\n`)).toMatchObject({ classe: "derive", sens: "manque_en_base", gravite: "elevee" });
    expect(unique(`-- CreateIndex\nCREATE INDEX "t_c_idx" ON "t"("c");\n`)).toMatchObject({ classe: "derive", gravite: "moyenne" });
  });

  it("un changement de type de colonne", () => {
    expect(unique(`-- AlterTable\nALTER TABLE "programmes_budgetaires" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);\n`)).toMatchObject({ classe: "derive", sens: "ecart", gravite: "elevee" });
  });

  it("une table de la base sans modele : un db push la supprimerait avec ses donnees", () => {
    expect(unique(`-- DropTable\nDROP TABLE "limites_admin";\n`)).toMatchObject({ classe: "derive", sens: "excedent_en_base", gravite: "elevee" });
    expect(unique(`-- AlterTable\nALTER TABLE "t" DROP COLUMN "c";\n`)).toMatchObject({ classe: "derive", sens: "excedent_en_base", gravite: "elevee" });
  });

  it("un index btree ordinaire non declare n'est PAS une exception", () => {
    expect(unique(`-- DropIndex\nDROP INDEX "bailleurs_deletedAt_idx";\n`)).toMatchObject({ classe: "derive", sens: "excedent_en_base" });
  });

  it("un index introuvable dans le catalogue n'est pas excuse (lecture du catalogue en defaut)", () => {
    expect(unique(`-- DropIndex\nDROP INDEX "inconnu_idx";\n`).classe).toBe("derive");
  });

  it("un defaut de base sur une autre colonne que id ou updatedAt", () => {
    expect(unique(`-- AlterTable\nALTER TABLE "t" ALTER COLUMN "statut" DROP DEFAULT;\n`).classe).toBe("derive");
  });

  it("une extension inconnue et une instruction non reconnue", () => {
    expect(unique(`CREATE EXTENSION "hstore";`).classe).toBe("derive");
    expect(unique(`VACUUM FULL;`).classe).toBe("derive");
  });

  it("un nom d'index different est une derive de gravite faible, nommee", () => {
    const d = unique(`-- RenameIndex\nALTER INDEX "ot_statut_idx" RENAME TO "ordres_travaux_statut_idx";\n`);
    expect(d).toMatchObject({ classe: "derive", sens: "ecart", gravite: "faible" });
    expect(d.raison).toContain('map: "ot_statut_idx"');
  });
});

describe("cles etrangeres", () => {
  it("une suppression suivie d'un ajout du meme nom est UN ecart, porte par l'ajout", () => {
    const r = classer(`-- DropForeignKey
ALTER TABLE "ot_photos" DROP CONSTRAINT "ot_photos_otId_fkey";

-- AddForeignKey
ALTER TABLE "ot_photos" ADD CONSTRAINT "ot_photos_otId_fkey" FOREIGN KEY ("otId") REFERENCES "ordres_travaux"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`);
    expect(r).toHaveLength(1);
    expect(r[0].sql).toContain("ADD CONSTRAINT");
    // Seule l'action a la mise a jour differe : sans effet sur une cle primaire qui ne change pas.
    expect(r[0]).toMatchObject({ classe: "derive", sens: "ecart", gravite: "faible" });
    expect(r[0].raison).toContain("ON UPDATE : base NO ACTION, schema CASCADE");
  });

  it("une action a la suppression differente est moyenne : le comportement change", () => {
    const r = classer(`-- DropForeignKey
ALTER TABLE "main_courante" DROP CONSTRAINT "main_courante_tronconId_fkey";

-- AddForeignKey
ALTER TABLE "main_courante" ADD CONSTRAINT "main_courante_tronconId_fkey" FOREIGN KEY ("tronconId") REFERENCES "troncons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
`);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ classe: "derive", gravite: "moyenne" });
    expect(r[0].raison).toContain("ON DELETE : base RESTRICT, schema SET NULL");
  });

  it("des colonnes ou une table cible differentes sont signalees", () => {
    const r = classer(`-- DropForeignKey
ALTER TABLE "ot_photos" DROP CONSTRAINT "ot_photos_autre_fkey";

-- AddForeignKey
ALTER TABLE "ot_photos" ADD CONSTRAINT "ot_photos_autre_fkey" FOREIGN KEY ("autreId") REFERENCES "elsewhere"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
`);
    expect(r[0].raison).toContain("colonnes ou table cible differentes");
    expect(r[0].gravite).toBe("moyenne");
  });

  it("une cle etrangere de la base absente du schema est un excedent (le champ n'a pas de @relation)", () => {
    const d = unique(`-- DropForeignKey\nALTER TABLE "sessions_roulage" DROP CONSTRAINT "sessions_roulage_userId_fkey";\n`);
    expect(d).toMatchObject({ classe: "derive", sens: "excedent_en_base" });
  });

  it("une cle etrangere du schema absente de la base manque", () => {
    const d = unique(`-- AddForeignKey\nALTER TABLE "t" ADD CONSTRAINT "t_x_fkey" FOREIGN KEY ("x") REFERENCES "u"("id") ON DELETE SET NULL ON UPDATE CASCADE;\n`);
    expect(d).toMatchObject({ classe: "derive", sens: "manque_en_base" });
  });
});

describe("EXCEPTIONS : ce que Prisma ne sait pas representer", () => {
  const cas: Array<[string, string]> = [
    ["EX-GIST", `-- DropIndex\nDROP INDEX "troncons_geom_gist";\n`],
    ["EX-PARTIEL", `-- DropIndex\nDROP INDEX "regions_code_key";\n`],
    ["EX-PARTIEL", `-- CreateIndex\nCREATE UNIQUE INDEX "regions_code_key" ON "regions"("code");\n`],
    ["EX-EXPRESSION", `-- DropIndex\nDROP INDEX "ouvrages_expr_idx";\n`],
    ["EX-EXPRESSION", `-- CreateIndex\nCREATE INDEX "ouvrages_expr_idx" ON "ouvrages"("a");\n`],
    ["EX-DEFAUT-CLIENT", `-- AlterTable\nALTER TABLE "decomptes" ALTER COLUMN "id" DROP DEFAULT;\n`],
    ["EX-DEFAUT-CLIENT", `-- AlterTable\nALTER TABLE "decomptes" ALTER COLUMN "updatedAt" DROP DEFAULT;\n`],
    ["EX-EXTENSION", `CREATE EXTENSION IF NOT EXISTS "pg_trgm";`],
    ["EX-EXTENSION", `DROP EXTENSION "btree_gist";`],
    ["EX-TABLE-OUTIL", `-- DropTable\nDROP TABLE "_prisma_migrations";\n`],
    ["EX-TABLE-OUTIL", `-- DropTable\nDROP TABLE "spatial_ref_sys";\n`],
  ];

  it.each(cas)("%s est classee exception et non comptee comme derive", (id, script) => {
    const d = unique(script);
    expect(d.classe).toBe("exception");
    expect(d.exception).toBe(id);
  });

  it("chaque exception declaree est exercee par au moins un cas, et inversement", () => {
    expect(new Set(cas.map(([id]) => id))).toEqual(new Set(EXCEPTIONS.map((e) => e.id)));
  });

  it("un script fait uniquement d'exceptions ne fait pas echouer le controle", () => {
    const b = bilan(classer(cas.map(([, s]) => s).join("\n")));
    expect(b.derive).toEqual([]);
    expect(b.exceptions.length).toBe(cas.length);
  });

  it("une exception ne masque pas la derive qui l'accompagne", () => {
    const b = bilan(classer(`-- DropIndex\nDROP INDEX "troncons_geom_gist";\n\n-- AlterTable\nALTER TABLE "t" ADD COLUMN "c" TEXT;\n`));
    expect(b.exceptions).toHaveLength(1);
    expect(b.derive).toHaveLength(1);
  });
});

describe("reference d'ecarts connus", () => {
  const script = `-- AlterTable\nALTER TABLE "t" ADD COLUMN "c" TEXT;\n\n-- AlterTable\nALTER TABLE "t" ADD COLUMN "d" TEXT;\n`;

  it("un ecart connu ne fait pas echouer, un ecart neuf si", () => {
    const connues = new Set(['ALTER TABLE "t" ADD COLUMN "c" TEXT;']);
    const b = bilan(classer(script, ctx(), connues), connues);
    expect(b.connues.map((d) => d.sql)).toEqual(['ALTER TABLE "t" ADD COLUMN "c" TEXT;']);
    expect(b.derive.map((d) => d.sql)).toEqual(['ALTER TABLE "t" ADD COLUMN "d" TEXT;']);
  });

  it("signale les entrees de la reference qui ne correspondent plus a rien", () => {
    const connues = new Set(['ALTER TABLE "t" ADD COLUMN "c" TEXT;', 'ALTER TABLE "t" ADD COLUMN "corrige" TEXT;']);
    const b = bilan(classer(script, ctx(), connues), connues);
    expect(b.obsoletes).toEqual(['ALTER TABLE "t" ADD COLUMN "corrige" TEXT;']);
  });

  it("une exception n'est jamais requalifiee en ecart connu", () => {
    const sql = 'DROP INDEX "troncons_geom_gist";';
    const b = bilan(classer(`-- DropIndex\n${sql}\n`, ctx(), new Set([sql])), new Set([sql]));
    expect(b.exceptions).toHaveLength(1);
    expect(b.connues).toHaveLength(0);
  });
});

describe("rapport et URL", () => {
  it("le rapport annonce les comptes et nomme chaque derive", () => {
    const b = bilan(classer(`-- AlterTable\nALTER TABLE "t" ADD COLUMN "c" TEXT;\n`));
    const texte = formaterRapport(b, false);
    expect(texte).toContain("Derive : 1");
    expect(texte).toContain("MANQUE EN BASE");
    expect(texte).toContain('ADD COLUMN "c" TEXT');
  });

  it("un rapport sans derive ne contient aucune section de derive", () => {
    const texte = formaterRapport(bilan([]), false);
    expect(texte).toContain("Derive : 0");
    expect(texte).not.toContain("MANQUE EN BASE");
  });

  it("change de base sans toucher a l'hote ni aux identifiants", () => {
    const u = new URL(urlVersBase("postgresql://utilisateur:secret@127.0.0.1:5434/replay", "essai_derive"));
    expect(u.pathname).toBe("/essai_derive");
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("5434");
    expect(u.username).toBe("utilisateur");
    expect(u.password).toBe("secret");
  });
});
