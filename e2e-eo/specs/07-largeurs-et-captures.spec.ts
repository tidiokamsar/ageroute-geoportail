import { api } from "../lib/oracle";
import { idsAffiches, ouvrirDetail, panneauDetail, totalAffiche } from "../lib/ecran";
import { attendreEcran, capturer, expect, test } from "../lib/fixtures";
import type { Page } from "@playwright/test";

/**
 * Parcours 7 : l'ecran REEL, avec les VRAIES donnees, a 1440, 768 et 375 de large. Captures (fond de carte reel : tuiles publiques Esri),
 * absence de defilement horizontal, ordre du DOM = ordre de lecture, cibles tactiles (44 px sous 1280 px, contrat §10), retour liste/detail.
 * Les captures sont ecrites hors du depot (voir lib/env.ts, DOSSIER_CAPTURES).
 */

const LARGEURS = [{ l: 1440, h: 900 }, { l: 768, h: 1024 }, { l: 375, h: 812 }] as const;
const ORDRE = ["titre-carte", "titre-propositions", "titre-detail", "titre-taux", "titre-qualite-methodes", "titre-sources"];

async function debordement(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Cibles interactives visibles de la zone principale plus petites que 44 px (dans l'une ou l'autre dimension). */
async function petitesCibles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const racine = document.querySelector("main") ?? document.body;
    const sel = "button, a[href], select, input:not([type=checkbox]):not([type=radio]), textarea, [role=tab], [role=slider], summary";
    const trop: string[] = [];
    for (const e of Array.from(racine.querySelectorAll<HTMLElement>(sel))) {
      const r = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      if (e.closest(".sr-only") || e.closest("[inert]")) continue;
      // Attribution de la carte (« Leaflet », « OpenStreetMap ») : mention legale imposee par la licence des tuiles, liens tiers qui ne
      // sont pas une commande de l'ecran. Exclue ici ; les boutons de zoom, eux, restent verifies (l'application leur impose 44 px sous xl).
      if (e.closest(".leaflet-control-attribution")) continue;
      if (r.height < 43.5 || r.width < 43.5) {
        const nom = (e.getAttribute("aria-label") ?? e.textContent ?? e.getAttribute("placeholder") ?? e.tagName).trim().replace(/\s+/g, " ").slice(0, 60);
        trop.push(`${e.tagName.toLowerCase()}[${nom}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return trop;
  });
}

for (const { l, h } of LARGEURS) {
  test.describe(`largeur ${l}`, () => {
    test(`ecran ADMIN a ${l} px : captures, pas de defilement horizontal, ordre de lecture, cibles tactiles`, async ({ ouvrirSession, run }) => {
      test.setTimeout(300_000);
      const s = await ouvrirSession(run.comptes.admin, { viewport: { width: l, height: h }, tuilesReelles: true });
      await s.page.goto("/teledetection");
      await attendreEcran(s.page);
      await totalAffiche(s.page);
      await expect.poll(() => s.page.locator(".bdri-proposition-eo").count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await s.page.waitForTimeout(3_000); // laisse arriver les tuiles du fond de carte reel
      await capturer(s.page, `07-admin-${l}-ecran-haut`);
      await capturer(s.page, `07-admin-${l}-ecran-complet`, { pleinePage: true });

      expect(await debordement(s.page), "defilement horizontal de la page").toBeLessThanOrEqual(1);

      // Garde du harnais : la feuille de style Leaflet est bien appliquee (sans elle, ni la mise en page de la carte ni les tailles
      // mesurees plus bas ne veulent rien dire ; voir l'ordre des routes dans lib/fixtures.ts).
      expect(await s.page.evaluate(() => { const p = document.querySelector(".leaflet-pane"); return p ? getComputedStyle(p).position : null; }), "feuille Leaflet appliquee").toBe("absolute");

      // Ordre du DOM = ordre de lecture et de tabulation (carte, liste, detail, taux, qualite, sources), a toute largeur.
      const positions = await s.page.evaluate((ordre) => {
        const el = (id: string) => document.getElementById(id) ?? (id === "titre-detail" ? document.getElementById("titre-detail-vide") : null);
        const res: (boolean | null)[] = [];
        for (let i = 1; i < ordre.length; i++) {
          const x = el(ordre[i - 1]);
          const y = el(ordre[i]);
          res.push(x && y ? !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) : null);
        }
        return res;
      }, ORDRE);
      expect(positions.every((p) => p === true), `ordre du DOM : ${JSON.stringify(positions)}`).toBe(true);

      // Cibles tactiles : 44 px sous 1280 px.
      const petites = await petitesCibles(s.page);
      console.log(`[largeur ${l}] cibles interactives < 44 px : ${petites.length}${petites.length ? "\n   - " + petites.join("\n   - ") : ""}`);
      if (l < 1280) {
        const graves = petites.filter((x) => /Charger plus|Filtres|Retour|Réessayer|Vérifier|Enregistrer|Confirmer|Infirmer|^button\[(À vérifier|En attente|Non concluantes|Confirmées|Infirmées)/.test(x) || /^a\[/.test(x));
        expect(graves, "cibles principales trop petites").toEqual([]);
      }

      // Detail : une proposition rattachee avec reference.
      const page1 = (await api(run.comptes.admin, "GET", "/propositions?statut=A_VERIFIER&limite=25")).corps.items as { id: string; rattachee: boolean; dateReference: string | null }[];
      const choisie = page1.find((p) => p.rattachee && p.dateReference) ?? page1[0];
      expect((await idsAffiches(s.page)).includes(choisie.id)).toBe(true);
      await ouvrirDetail(s.page, choisie.id);
      await s.page.waitForTimeout(500);
      await capturer(s.page, `07-admin-${l}-detail-haut`);
      await capturer(s.page, `07-admin-${l}-detail-complet`, { pleinePage: true });
      expect(await debordement(s.page), "defilement horizontal avec le detail").toBeLessThanOrEqual(1);
      if (l < 1280) {
        // Le detail prend la place de la liste, avec un retour clair ; le retour redonne la liste.
        await expect(s.page.getByRole("button", { name: "Retour à la liste" })).toBeVisible();
        await expect(s.page.locator("#panneau-propositions")).toBeHidden();
        await s.page.getByRole("button", { name: "Retour à la liste" }).click();
        await expect(s.page.locator("#panneau-propositions")).toBeVisible();
        await expect(panneauDetail(s.page)).toHaveCount(0);
      } else {
        await expect(s.page.getByRole("button", { name: "Fermer le détail de la proposition" })).toBeVisible();
      }
      expect(s.erreursPage).toEqual([]);
    });
  });
}
