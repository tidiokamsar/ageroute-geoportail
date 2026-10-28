import { http } from "../lib/api";
import { compter, requete } from "../lib/base";
import { expect, ouvrirEcran, test, capturer } from "../lib/fixtures";

/**
 * Parcours 0 : la pile est la bonne et le semis est ce qu'il dit etre. Sans cela, aucun resultat des parcours suivants ne veut rien dire.
 * Ce sont des controles de la base REELLE, pas des tests de l'application.
 */
test.describe("pile et semis", () => {
  test("la base, les comptes et les fixtures sont en place", async ({ run }) => {
    expect(await compter(`SELECT count(*) FROM users`)).toBe(7);
    expect(await compter(`SELECT count(*) FROM troncons`)).toBe(4);
    expect(await compter(`SELECT count(*) FROM portions`)).toBe(2);
    expect(await compter(`SELECT count(*) FROM ouvrages`)).toBe(1);
    expect(await compter(`SELECT count(*) FROM propositions_teledetection`)).toBe(run.depot!.total);
    expect(run.produits.length).toBeGreaterThan(0);
    // Les produits sont de VRAIES metadonnees du catalogue : identifiant fournisseur, collection Sentinel-2, jamais synthetiques.
    const p = await requete<{ fournisseur: string; collection: string; synthetique: boolean; cycleVie: string }>(
      `SELECT fournisseur, collection, synthetique, "cycleVie" FROM earth_observation_products WHERE id = ANY($1::text[])`, [run.produits.map((x) => x.id)]);
    expect(p.length).toBe(run.produits.length);
    for (const l of p) { expect(l.fournisseur).toBeTruthy(); expect(l.collection).toBe("sentinel-2-l2a"); expect(l.synthetique).toBe(false); expect(l.cycleVie).toBe("CATALOGUE"); }
  });

  test("connexion par l'interface et ouverture de l'ecran", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await ouvrirEcran(s.page);
    await capturer(s.page, "00-admin-1440");
    expect(s.erreursPage).toEqual([]);
  });
});

/**
 * E2E-EO-D (HORS MODULE, pre-existant, backend/src/modules/auth/auth.service.ts l.79 `signRefreshToken`) : le jeton de rafraichissement est un
 * JWT sans identifiant (`jti`) ; deux jetons du meme compte emis dans la meme seconde sont identiques, donc de meme empreinte, et la contrainte
 * d'unicite de `refresh_tokens.tokenHash` rend 409 « Une entree avec cette valeur unique existe deja ». Consequences constatees pendant ce
 * chantier : deux connexions simultanees du meme compte (la seconde echoue), et un rechargement de page dans la seconde qui suit la connexion
 * (le rafraichissement echoue, l'utilisateur retombe sur /login). Le harnais espace ses connexions (lib/api.ts) ; ce test dit le defaut.
 */
test.describe("defaut hors module : jeton de rafraichissement", () => {
  test("deux connexions simultanees du meme compte reussissent toutes les deux (E2E-EO-D)", async ({ run }) => {
    test.fail(true, "E2E-EO-D : 409 « entree unique existe deja » sur la seconde connexion de la meme seconde");
    const c = { email: run.comptes.lecteur.email, password: run.comptes.lecteur.motDePasse };
    const statuts: number[] = [];
    for (let essai = 0; essai < 3; essai++) {
      // Aligne sur le debut d'une seconde : les deux jetons sont emis dans la meme seconde.
      await new Promise((r) => setTimeout(r, 1_100 - (Date.now() % 1000)));
      const rs = await Promise.all([http("POST", "/api/auth/login", { corps: c }), http("POST", "/api/auth/login", { corps: c })]);
      statuts.push(...rs.map((r) => r.status));
      if (rs.some((r) => r.status === 409)) break;
    }
    expect(statuts.every((s) => s === 200), `statuts : ${statuts.join(", ")}`).toBe(true);
  });
});
