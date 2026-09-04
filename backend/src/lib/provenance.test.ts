import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Provenance des valeurs saisies.
 *
 * Ce module existe parce qu'une correction faite depuis l'interface laissait sa ligne
 * de qualite intacte : la base affirmait « absent de la source » pour une valeur
 * qu'un agent venait de taper. Les tests portent sur la frontiere exacte entre ce
 * qu'une saisie prouve et ce qu'elle ne prouve pas.
 */

const upserts: { entityType: string; entityId: string; champ: string; statut: string; observedById: string }[] = [];

vi.mock("./prisma", () => ({
  prisma: {
    valeurQualite: {
      upsert: vi.fn(async (args: { where: { entityType_entityId_champ: Record<string, string> }; create: Record<string, string> }) => {
        upserts.push({ ...args.where.entityType_entityId_champ, ...args.create } as never);
        return {};
      }),
    },
  },
}));

import { enregistrerSaisie, construireSaisies, CHAMPS_SUIVIS } from "./provenance";

beforeEach(() => { upserts.length = 0; });

describe("Ce qu'une saisie enregistre", () => {
  it("marque le champ OBSERVED avec son auteur", async () => {
    const n = await enregistrerSaisie("Troncon", "t1", { etat: "BON" }, "user-9");
    expect(n).toBe(1);
    expect(upserts[0]).toMatchObject({
      entityType: "Troncon", entityId: "t1", champ: "etat",
      statut: "OBSERVED", observedById: "user-9",
    });
  });

  it("couvre tous les champs presents dans la requete", async () => {
    await enregistrerSaisie("Troncon", "t1", { etat: "BON", revetement: "TERRE" }, "u");
    expect(upserts.map((u) => u.champ).sort()).toEqual(["etat", "revetement"]);
  });
});

describe("Ce qu'une saisie ne prouve PAS", () => {
  it("ne touche pas un champ absent de la requete", async () => {
    // Modifier le nom ne dit rien du revetement. Pretendre le contraire serait le
    // meme mensonge qu'on corrige, en sens inverse.
    await enregistrerSaisie("Troncon", "t1", { nom: "RN1" }, "u");
    expect(upserts.map((u) => u.champ)).toEqual(["nom"]);
  });

  it("ignore les champs non suivis", async () => {
    const n = await enregistrerSaisie("Troncon", "t1", { observations: "texte libre" }, "u");
    expect(n).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("n'ecrit rien pour une entite non suivie", async () => {
    expect(await enregistrerSaisie("Marche", "m1", { statut: "X" }, "u")).toBe(0);
  });

  it("traite null comme une valeur, pas comme une absence", async () => {
    // Effacer une valeur est une affirmation : « ce qu'on croyait savoir est faux ».
    // Elle merite une trace autant qu'une valeur posee.
    await enregistrerSaisie("Troncon", "t1", { traficMoyenJma: null, etat: null }, "u");
    expect(upserts.map((u) => u.champ)).toEqual(["etat"]);
  });

  it("ne confond pas undefined avec une saisie", async () => {
    const n = await enregistrerSaisie("Troncon", "t1", { etat: undefined }, "u");
    // `undefined` sur une cle presente signifie « non touche » cote Prisma : la
    // presence de la cle ne suffit donc pas, mais hasOwnProperty la voit. On
    // documente le comportement retenu plutot que de le laisser au hasard.
    expect(n).toBe(1);
  });
});

describe("Le perimetre des champs suivis", () => {
  it("couvre les valeurs qui commandent une decision", async () => {
    // L'etat commande la programmation ; revetement et longueur commandent les couts.
    for (const c of ["etat", "revetement", "longueurKm"]) {
      expect(CHAMPS_SUIVIS.Troncon).toContain(c);
    }
  });

  it("ne suit pas le texte libre", () => {
    expect(CHAMPS_SUIVIS.Troncon).not.toContain("observations");
  });

  it("suit aussi ouvrages et chantiers", () => {
    expect(CHAMPS_SUIVIS.Ouvrage).toContain("etat");
    expect(CHAMPS_SUIVIS.Chantier).toContain("regionId");
  });
});

describe("Les ecritures sont construites, pas executees", () => {
  it("rend une promesse par champ sans rien ecrire tout de suite", () => {
    // C'est ce qui permet a l'appelant de les passer a $transaction avec SA propre
    // mise a jour : la valeur et sa provenance changent ensemble, ou pas du tout.
    const e = construireSaisies("Troncon", "t1", { etat: "BON", revetement: "TERRE" }, "u");
    expect(e).toHaveLength(2);
  });

  it("ne rend rien quand aucun champ suivi n'est touche", () => {
    expect(construireSaisies("Troncon", "t1", { observations: "x" }, "u")).toEqual([]);
    expect(construireSaisies("Marche", "m1", { statut: "X" }, "u")).toEqual([]);
  });
});
