import { api } from "../lib/oracle";
import { nettoyer, ongletDetail, ouvrirDetail, panneauDetail, totalAffiche } from "../lib/ecran";
import { attendreEcran, capturer, expect, test } from "../lib/fixtures";

/**
 * Parcours 2 : l'apercu REEL. Cette spec est la SEULE qui laisse l'ecran appeler `GET /produits/:id/apercu` jusqu'au serveur reel et, par lui,
 * au fournisseur reel (Copernicus, requete anonyme : de 1 a 4 requetes par apercu). Les autres specs remplacent cet appel par le 404 que
 * le serveur rend (voir lib/fixtures.ts).
 *
 * Attendu (API.md section 10, constate le 25/10/2026) : l'acces anonyme a la vignette CDSE n'est pas etabli, le serveur rend 404
 * `APERCU_INDISPONIBLE` et l'ecran DIT « Aperçu indisponible chez le fournisseur » sans image de remplacement. Si un jour le fournisseur
 * rend une image (200), l'ecran doit l'afficher : les deux issues sont verifiees, et l'issue constatee est ecrite dans la sortie.
 */
test.describe("apercu reel", () => {
  test("l'ecran dit ce que le serveur et le fournisseur ont repondu", async ({ ouvrirSession, run }) => {
    test.setTimeout(300_000);
    const s = await ouvrirSession(run.comptes.admin, { apercuReel: true });
    const reponses: { id: string; status: number; type: string; code: string | null; ms: number }[] = [];
    s.page.on("response", async (r) => {
      const m = /\/produits\/([^/]+)\/apercu/.exec(r.url());
      if (!m) return;
      let code: string | null = null;
      if (r.status() !== 200) { try { code = (await r.json()).code ?? null; } catch { /* corps non JSON */ } }
      reponses.push({ id: m[1], status: r.status(), type: r.headers()["content-type"] ?? "", code, ms: Date.now() - t0 });
    });
    const t0 = Date.now();
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    await totalAffiche(s.page);

    const page1 = (await api(run.comptes.admin, "GET", "/propositions?statut=A_VERIFIER&limite=25")).corps.items as { id: string; rattachee: boolean; dateReference: string | null }[];
    const choisie = page1.find((p) => p.rattachee && p.dateReference)!;
    expect(choisie).toBeTruthy();
    const detail = (await api(run.comptes.admin, "GET", `/propositions/${choisie.id}`)).corps;
    const idApres = /\/produits\/([^/]+)\/apercu/.exec(detail.apercus.apres.url)![1];
    const idAvant = /\/produits\/([^/]+)\/apercu/.exec(detail.apercus.avant.url)![1];
    expect(idApres).not.toBe(idAvant);

    await ouvrirDetail(s.page, choisie.id);
    const P = panneauDetail(s.page);

    // --- onglet Apercu (apres) : on attend la fin de l'appel reel (15 s de delai serveur, plus les sauts)
    await expect(P.getByText("Chargement de l'aperçu…")).toHaveCount(0, { timeout: 120_000 });
    const apres = reponses.find((r) => r.id === idApres)!;
    expect(apres, "l'ecran a appele l'apercu du produit apres").toBeTruthy();
    if (apres.status === 200) {
      expect(apres.type).toMatch(/^image\/(jpeg|png|webp)/);
      const img = P.getByRole("img", { name: /Vue satellite après le changement/ });
      await expect(img).toBeVisible();
      expect(await img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
    } else {
      expect(apres.status).toBe(404);
      expect(apres.code).toBe("APERCU_INDISPONIBLE");
      await expect(P.getByText("Aperçu indisponible chez le fournisseur")).toBeVisible();
      await expect(P.getByRole("img", { name: /Vue satellite/ })).toHaveCount(0);
      // Pas une panne de l'application : aucune alerte rouge pour cela.
      await expect(P.getByText("L'aperçu n'a pas pu être chargé")).toHaveCount(0);
    }
    console.log(`[constat apercu reel] produit apres : HTTP ${apres.status} ${apres.code ?? apres.type} en ${apres.ms} ms`);
    await capturer(s.page, "02-apercu-reel-1440");

    // --- onglet Comparaison : avant ET apres
    await ongletDetail(s.page, "Comparaison");
    await expect(P.getByText("Chargement des images…")).toHaveCount(0, { timeout: 120_000 });
    await expect.poll(() => reponses.some((r) => r.id === idAvant), { timeout: 60_000 }).toBe(true);
    const avant = reponses.find((r) => r.id === idAvant)!;
    console.log(`[constat apercu reel] produit avant : HTTP ${avant.status} ${avant.code ?? avant.type} en ${avant.ms} ms`);
    const texte = nettoyer(await P.innerText());
    if (avant.status !== 200 && apres.status !== 200) {
      expect(texte).toContain("Comparaison impossible : les images avant et après sont indisponibles chez le fournisseur.");
      await expect(P.getByRole("slider")).toBeDisabled();
    } else if (avant.status === 200 && apres.status === 200) {
      await expect(P.getByRole("slider")).toBeEnabled();
    } else {
      // Un seul cote disponible : il reste montre, le curseur est desactive, et l'autre cote est dit indisponible.
      await expect(P.getByRole("slider")).toBeDisabled();
      expect(texte).toContain("indisponible chez le fournisseur");
    }
    // Le navigateur n'a jamais vu une URL ni une cle du fournisseur : seules des adresses du serveur d'application.
    const adressesImages = await s.page.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    for (const a of adressesImages) expect(a).not.toMatch(/creodias|copernicus|amazonaws/i);
    expect(s.ecritures).toEqual([]);
    expect(s.erreursPage).toEqual([]);
  });
});
