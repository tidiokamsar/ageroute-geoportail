import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TYPES_INSPECTION, inspectionCreateSchema, inspectionUpdateSchema, manquesInspection } from "./inspections.schema";

/**
 * L'inspection post-travaux (paragraphe 7.7) : un constat d'etat, pas une reception.
 *
 * - POST_TRAVAUX exige la reference d'intervention, un etat mesure et une photo « apres »,
 *   et chaque manque a son message ;
 * - GENERALE par defaut : les clients existants n'envoient pas de type et restent valides ;
 * - un IRI estime va avec sa methode ;
 * - le modele ne porte AUCUN champ de reception, de reserve, de proces-verbal ni de montant --
 *   la reception est un acte contractuel qui vit dans DigitalRoad (§ A.3).
 */

const base = { tronconId: "11111111-1111-4111-8111-111111111111", dateInspection: "2026-10-15", etatObserve: "BON" as const };

describe("Types", () => {
  it("les quatre types sont ceux de la contrainte en base, GENERALE par defaut", () => {
    expect([...TYPES_INSPECTION]).toEqual(["GENERALE", "PERIODIQUE", "VERIFICATION", "POST_TRAVAUX"]);
    const r = inspectionCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("GENERALE");
  });

  it("un type inconnu -- RECEPTION par exemple -- est refuse", () => {
    expect(inspectionCreateSchema.safeParse({ ...base, type: "RECEPTION" }).success).toBe(false);
  });
});

describe("POST_TRAVAUX : trois exigences, trois messages", () => {
  it("sans reference, sans photo et avec NON_EVALUE : trois erreurs nommees", () => {
    const r = inspectionCreateSchema.safeParse({ ...base, type: "POST_TRAVAUX", etatObserve: "NON_EVALUE" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const chemins = r.error.issues.map((i) => i.path.join("."));
    expect(chemins).toEqual(expect.arrayContaining(["interventionRef", "photos", "etatObserve"]));
    expect(r.error.issues.find((i) => i.path[0] === "etatObserve")?.message).toMatch(/se mesure/);
  });

  it("complete, elle passe, et un IRI estime avec sa methode aussi", () => {
    const r = inspectionCreateSchema.safeParse({ ...base, type: "POST_TRAVAUX", interventionRef: "INT-2026-0007", photos: ["apres.jpg"], iriEstime: 3.2, iriMethode: "smartphone_experimental" });
    expect(r.success).toBe(true);
  });

  it("une reference faite d'espaces ne compte pas", () => {
    const r = inspectionCreateSchema.safeParse({ ...base, type: "POST_TRAVAUX", interventionRef: "   ", photos: ["a.jpg"] });
    expect(r.success).toBe(false);
  });
});

describe("IRI estime", () => {
  it("sans methode, ou methode sans valeur : refuse a la creation", () => {
    expect(inspectionCreateSchema.safeParse({ ...base, iriEstime: 4.1 }).success).toBe(false);
    expect(inspectionCreateSchema.safeParse({ ...base, iriMethode: "x" }).success).toBe(false);
  });

  it("en edition, la regle se juge sur la ligne FUSIONNEE, pas sur le corps seul", () => {
    // Corriger la valeur d'un IRI dont la methode est deja enregistree : legitime. Le corps seul
    // passe donc le schema d'edition, et c'est `manquesInspection` qui tranche sur la fusion.
    expect(inspectionUpdateSchema.safeParse({ iriEstime: 4.1 }).success).toBe(true);
    expect(manquesInspection({ iriEstime: 4.1, iriMethode: "smartphone_experimental" })).toEqual([]);
    expect(manquesInspection({ iriEstime: 4.1, iriMethode: null }).map((m) => m.champ)).toEqual(["iriMethode"]);
  });

  it("manquesInspection nomme les trois manques d'un post-travaux incomplet, et rien pour une ligne complete", () => {
    expect(manquesInspection({ type: "POST_TRAVAUX", interventionRef: "  ", photos: [], etatObserve: "NON_EVALUE" }).map((m) => m.champ).sort())
      .toEqual(["etatObserve", "interventionRef", "photos"]);
    expect(manquesInspection({ type: "POST_TRAVAUX", interventionRef: "INT-1", photos: ["a.jpg"], etatObserve: "BON" })).toEqual([]);
    expect(manquesInspection({ type: "GENERALE", etatObserve: "NON_EVALUE" })).toEqual([]);
  });

  it("borne a [0, 30] : au-dela, ce n'est plus une rugosite de route", () => {
    expect(inspectionCreateSchema.safeParse({ ...base, iriEstime: -1, iriMethode: "x" }).success).toBe(false);
    expect(inspectionCreateSchema.safeParse({ ...base, iriEstime: 31, iriMethode: "x" }).success).toBe(false);
  });
});

describe("Frontiere : une inspection n'est pas une reception", () => {
  it("le modele Inspection ne porte aucun champ de reception, reserve, proces-verbal ni montant", () => {
    const schema = readFileSync(join(__dirname, "..", "..", "..", "prisma", "schema.prisma"), "utf8");
    const bloc = /^model Inspection \{([\s\S]*?)^\}/m.exec(schema);
    expect(bloc).not.toBeNull();
    const corps = bloc![1].replace(/^\s*\/\/.*$/gm, "");
    for (const mot of ["reception", "reserve", "procesVerbal", "pv", "montant", "decompte", "marche", "acceptation"]) {
      expect(new RegExp(`^\\s*\\w*${mot}\\w*\\s`, "im").test(corps), `champ interdit : ${mot}`).toBe(false);
    }
    // Et la presence de ce que le paragraphe 7.7 exige.
    for (const champ of ["type", "interventionRef", "iriEstime", "iriMethode", "photos", "etatObserve"]) {
      expect(new RegExp(`^\\s*${champ}\\s`, "m").test(corps), `champ attendu : ${champ}`).toBe(true);
    }
  });
});
