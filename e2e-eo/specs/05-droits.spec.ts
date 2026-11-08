import { compter, requete } from "../lib/base";
import { api, comptesSql, jeton, lignesJournalTotal, propositionsSql } from "../lib/oracle";
import { http, PREFIXE_TD } from "../lib/api";
import { idsAffiches, nettoyer, onglet, ouvrirDetail, ongletDetail, panneauDetail, totalAffiche } from "../lib/ecran";
import { attendreEcran, carte, expect, test } from "../lib/fixtures";
import type { CompteRun } from "../lib/donnees";

/**
 * Parcours 5 : les DROITS, a l'ecran ET au serveur. Role, module, perimetre territorial. Le serveur decide : l'ecran n'est qu'un reflet,
 * et on verifie les deux.
 *
 * Reponse d'une ressource hors perimetre : 404 identique a celle d'un identifiant inconnu (le code d'etat ne dit pas si la ressource existe).
 */

const ID_INCONNU = "00000000-0000-4000-8000-000000000000";

async function brut(c: CompteRun, chemin: string, methode = "GET", corps?: unknown) {
  return http(methode, `${PREFIXE_TD}${chemin}`, { token: await jeton(c), corps });
}

async function idsSql(where: string, params: unknown[] = []): Promise<string[]> {
  return (await propositionsSql(where, params)).map((p) => p.id);
}

test.describe("gestionnaire REGIONAL : seulement sa region", () => {
  test("ecran et serveur : liste, GeoJSON, totaux, compteurs ne voient que la region A", async ({ ouvrirSession, run }) => {
    const A = run.regions.A.id;
    const s = await ouvrirSession(run.comptes.gestRegional);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const sqlA = await comptesSql([A]);
    const sqlTout = await comptesSql();
    expect(sqlA.total).toBeGreaterThan(0);
    expect(sqlA.total).toBeLessThan(sqlTout.total); // le test n'a de sens que si d'autres regions existent

    // Indicateurs = base filtree par region (et JAMAIS le total national).
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sqlA.aVerifier));
    expect(sqlA.aVerifier).not.toBe(sqlTout.aVerifier);
    await expect(carte(s.page, "Propositions à vérifier").detail).toContainText(`dont ${sqlA.prioritaires} ${sqlA.prioritaires > 1 ? "prioritaires" : "prioritaire"}`);
    await expect(carte(s.page, "Confirmées").valeur).toHaveText(String(sqlA.confirmees));
    await expect(carte(s.page, "Infirmées").valeur).toHaveText(String(sqlA.infirmees));
    for (const [lib, n] of [["À vérifier", sqlA.aVerifier], ["En attente", sqlA.enAttente], ["Non concluantes", sqlA.nonConcluantes], ["Confirmées", sqlA.confirmees], ["Infirmées", sqlA.infirmees]] as const) {
      await expect(onglet(s.page, lib)).toContainText(String(n));
    }
    const syn = (await api(run.comptes.gestRegional, "GET", "/synthese")).corps;
    expect(syn.propositions).toEqual({ aVerifier: sqlA.aVerifier, enAttente: sqlA.enAttente, nonConcluantes: sqlA.nonConcluantes, confirmees: sqlA.confirmees, infirmees: sqlA.infirmees, prioritaires: sqlA.prioritaires });
    // Le taux regional vient de la synthese, filtre par region (effectif de la region seulement).
    expect(syn.tauxConfirmation.confirmees).toBe(sqlA.confirmees);
    expect(syn.tauxConfirmation.infirmees).toBe(sqlA.infirmees);

    // Liste : total de la region, identifiants de la region, rien d'autre.
    expect(await totalAffiche(s.page)).toBe(sqlA.aVerifier);
    const attendus = await idsSql(`pt."regionId" = $1 AND pt.statut = 'A_VERIFIER'`, [A]);
    const affiches = await idsAffiches(s.page);
    for (const id of affiches) expect(attendus).toContain(id);
    // Tout le serveur, page apres page : exactement les propositions de la region A.
    const vues: string[] = [];
    let curseur: string | null = null;
    do {
      const r: any = (await api(run.comptes.gestRegional, "GET", `/propositions?limite=100${curseur ? `&curseur=${encodeURIComponent(curseur)}` : ""}`)).corps;
      vues.push(...r.items.map((i: { id: string }) => i.id));
      for (const i of r.items) expect(i.troncon?.regionId ?? null).toBe(A);
      curseur = r.suivant;
    } while (curseur);
    expect([...vues].sort()).toEqual((await idsSql(`pt."regionId" = $1`, [A])).sort());

    // GeoJSON : seulement la region A (toutes emprises du pays, 10 degres).
    const geo = (await api(run.comptes.gestRegional, "GET", "/propositions.geojson?bbox=-15.5,9,-8,12&limite=1000")).corps as { features: { properties: { id: string } }[]; total: number; tronque: boolean };
    expect(geo.features.map((f) => f.properties.id).sort()).toEqual((await idsSql(`pt."regionId" = $1`, [A])).sort());
    expect(geo.total).toBe(sqlA.total);
    expect(geo.tronque).toBe(false);
    // La carte de l'ecran : aucun marqueur de plus que ce que le serveur lui a donne.
    await expect.poll(() => s.page.locator(".bdri-proposition-eo").count(), { timeout: 30_000 }).toBeLessThanOrEqual(sqlA.total);

    // Filtre sur une autre region : refuse (403), meme pour la synthese. Les non rattachees n'existent pas pour lui.
    const f403 = await brut(run.comptes.gestRegional, `/propositions?regionId=${run.regions.B.id}`);
    expect(f403.status).toBe(403);
    expect(f403.corps.code).toBe("HORS_PERIMETRE");
    expect((await brut(run.comptes.gestRegional, `/synthese?regionId=${run.regions.B.id}`)).status).toBe(403);
    const non = await brut(run.comptes.gestRegional, `/propositions?rattachee=false`);
    expect(non.status).toBe(200);
    expect(non.corps.total).toBe(0);
    expect(s.erreursPage).toEqual([]);
  });

  test("detail d'une proposition d'une autre region ou non rattachee : 404 IDENTIQUE a un identifiant inconnu", async ({ run }) => {
    const B = run.regions.B.id;
    const [autre] = await idsSql(`pt."regionId" = $1`, [B]);
    const [libre] = await idsSql(`pt."tronconId" IS NULL`);
    const inconnue = await brut(run.comptes.gestRegional, `/propositions/${ID_INCONNU}`);
    const malformee = await brut(run.comptes.gestRegional, `/propositions/pas-un-uuid`);
    const horsRegion = await brut(run.comptes.gestRegional, `/propositions/${autre}`);
    const nonRattachee = await brut(run.comptes.gestRegional, `/propositions/${libre}`);
    for (const r of [inconnue, malformee, horsRegion, nonRattachee]) {
      expect(r.status).toBe(404);
      expect(r.corps).toEqual({ error: "Ressource introuvable", code: "INTROUVABLE" });
    }
    // Meme corps octet pour octet, meme sur une ecriture : le code d'etat ne distingue pas « n'existe pas » de « hors perimetre ».
    const journal = await lignesJournalTotal();
    for (const cible of [autre, libre, ID_INCONNU]) {
      const e = await brut(run.comptes.gestRegional, `/propositions/${cible}/transition`, "POST", { vers: "EN_ATTENTE", motif: "hors perimetre" });
      expect(e.status).toBe(404);
      expect(e.corps).toEqual({ error: "Ressource introuvable", code: "INTROUVABLE" });
    }
    // Y compris avec un corps invalide : l'existence n'est pas un oracle.
    const inv = await brut(run.comptes.gestRegional, `/propositions/${autre}/transition`, "POST", { n: "importe quoi" });
    expect(inv.status).toBe(404);
    expect(await lignesJournalTotal()).toBe(journal);
    // L'administrateur, lui, la voit.
    expect((await api(run.comptes.admin, "GET", `/propositions/${autre}`)).status).toBe(200);
  });

  test("« Qualite par methode » : absence de permission pour le regional (ni erreur ni vide), visible du national", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.gestRegional);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const section = s.page.locator('section[aria-labelledby="titre-qualite-methodes"]');
    await expect(section.getByText("Qualité par méthode : accès refusé.")).toBeVisible();
    await expect(section).toContainText("réservé aux comptes nationaux");
    await expect(section).toContainText("Taux de confirmation terrain");
    await expect(section.getByRole("table")).toHaveCount(0);
    await expect(section.getByRole("alert")).toHaveCount(0); // ce n'est pas une panne
    await expect(section.getByText("Aucune méthode n'a encore produit de proposition")).toHaveCount(0); // ni un vide
    // Le serveur : 403 HORS_PERIMETRE sur les deux agregats nationaux.
    for (const chemin of ["/qualite-methodes", "/precision"]) {
      const r = await brut(run.comptes.gestRegional, chemin);
      expect(r.status).toBe(403);
      expect(r.corps.code).toBe("HORS_PERIMETRE");
    }
    // Les comptes nationaux : 200 avec leurs lignes.
    for (const c of [run.comptes.admin, run.comptes.gestNational]) {
      const r = await brut(c, "/qualite-methodes");
      expect(r.status).toBe(200);
      expect(r.corps.lignes.length).toBeGreaterThan(0);
    }
    // Le widget « Taux de confirmation terrain » reste affiche (donnee regionale de /synthese).
    await expect(s.page.locator('section[aria-labelledby="titre-taux"]')).toBeVisible();
  });

  test("le regional decide dans son perimetre (Non concluante) ; hors perimetre le serveur refuse et la base ne bouge pas", async ({ ouvrirSession, run }) => {
    const A = run.regions.A.id;
    const s = await ouvrirSession(run.comptes.gestRegional);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    await totalAffiche(s.page);
    const [cible] = await idsSql(`pt."regionId" = $1 AND pt.statut = 'A_VERIFIER' AND pt."missionId" IS NULL`, [A]);
    // Cette proposition peut deja avoir un journal (parcours 3) : on prouve que la LIGNE AJOUTEE porte le regional.
    const avantJournal = await requete<{ auteurId: string }>(`SELECT "auteurId" FROM propositions_teledetection_transitions WHERE "propositionId" = $1 ORDER BY "creeLe", id`, [cible]);
    await ouvrirDetail(s.page, cible);
    const P = panneauDetail(s.page);
    await P.getByRole("button", { name: /^Non concluante/ }).click();
    await P.getByLabel(/^Motif/).fill("Image inexploitable (perimetre regional)");
    await P.getByRole("button", { name: "Enregistrer la décision" }).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « Non concluante ».")).toBeVisible();
    const [p] = await propositionsSql("pt.id = $1", [cible]);
    expect(p.statut).toBe("NON_CONCLUANTE");
    const j = await requete<{ auteurId: string }>(`SELECT "auteurId" FROM propositions_teledetection_transitions WHERE "propositionId" = $1 ORDER BY "creeLe", id`, [cible]);
    expect(j).toHaveLength(avantJournal.length + 1);
    expect(j.slice(0, avantJournal.length)).toEqual(avantJournal);
    expect(j[j.length - 1].auteurId).toBe(run.comptes.gestRegional.id);
    // Hors perimetre (region B) : 404, rien ne change.
    const [autre] = await idsSql(`pt."regionId" = $1 AND pt.statut = 'A_VERIFIER'`, [run.regions.B.id]);
    const e = await brut(run.comptes.gestRegional, `/propositions/${autre}/transition`, "POST", { vers: "NON_CONCLUANTE", motif: "intrusion" });
    expect(e.status).toBe(404);
    expect((await propositionsSql("pt.id = $1", [autre]))[0].statut).toBe("A_VERIFIER");
    // Depot de lot, synchronisation : des operations nationales, refusees au regional.
    const depot = await brut(run.comptes.gestRegional, `/propositions`, "POST", { produitId: ID_INCONNU, methodeNom: "x", methodeVersion: "y", propositions: [] });
    expect(depot.status).toBe(403);
    expect(depot.corps.code).toBe("HORS_PERIMETRE");
    const synchro = await brut(run.comptes.gestRegional, `/sources/cdse-stac/synchroniser-catalogue`, "POST", {});
    expect(synchro.status).toBe(403);
    expect(synchro.corps.code).toBe("HORS_PERIMETRE");
  });
});

test.describe("gestionnaire NATIONAL", () => {
  test("voit toutes les regions et les non rattachees, decide, et lit la qualite par methode", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.gestNational);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const sql = await comptesSql();
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
    expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
    const nonRattachees = await compter(`SELECT count(*) FROM propositions_teledetection WHERE "tronconId" IS NULL AND statut = 'A_VERIFIER'`);
    expect(nonRattachees).toBeGreaterThan(0);
    await expect(s.page.getByText("Anomalie non rattachée").first()).toBeVisible();
    const section = s.page.locator('section[aria-labelledby="titre-qualite-methodes"]');
    await expect(section.getByRole("table")).toBeVisible();
    expect(nettoyer(await section.innerText())).toContain("fixture-e2e-eo v0");
    // Decision offerte.
    const [premiere] = await idsAffiches(s.page);
    await ouvrirDetail(s.page, premiere);
    await expect(panneauDetail(s.page).getByRole("button", { name: /^Mettre en attente/ })).toBeVisible();
    await expect(s.page.getByRole("button", { name: /^Vérifier la source/ })).toHaveCount(0);
  });
});

for (const nom of ["inspecteur", "lecteur"] as const) {
  test.describe(`${nom.toUpperCase()} : consultation seule`, () => {
    test("l'ecran se consulte (liste, detail, onglets) sans aucun bouton d'ecriture ni requete d'ecriture", async ({ ouvrirSession, run }) => {
      const c = run.comptes[nom];
      const s = await ouvrirSession(c);
      await s.page.goto("/teledetection");
      await attendreEcran(s.page);
      const sql = await comptesSql();
      await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
      expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
      const [premiere] = await idsAffiches(s.page);
      await ouvrirDetail(s.page, premiere);
      const P = panneauDetail(s.page);
      for (const o of ["Aperçu", "Comparaison", "Terrain", "Historique"] as const) await ongletDetail(s.page, o);
      // Consultation seule : le message le dit, aucune decision n'est offerte.
      await expect(P.getByText("Consultation seule : seuls les administrateurs et les gestionnaires décident du sort d'une proposition.")).toBeVisible();
      if (nom === "inspecteur") await expect(P.getByText("Les preuves de terrain s'ajoutent depuis la mission d'inspection qui vous est affectée.")).toBeVisible();
      await expect(P.getByRole("button", { name: /^(Confirmer|Infirmer|Mettre en attente|Demander des informations|Non concluante|Remettre à vérifier|Affecter)/ })).toHaveCount(0);
      await expect(P.getByRole("button", { name: "Enregistrer la décision" })).toHaveCount(0);
      await expect(s.page.getByRole("button", { name: /^Vérifier la source/ })).toHaveCount(0);
      await expect(s.page.getByRole("button", { name: "État des sources" })).toHaveCount(0);
      expect(s.ecritures, "aucun POST/PUT/PATCH/DELETE pendant la consultation").toEqual([]);
      expect(s.erreursPage).toEqual([]);
    });

    test("le serveur refuse toute ecriture (403) et la base ne bouge pas", async ({ run }) => {
      const c = run.comptes[nom];
      const [une] = await idsSql(`pt.statut = 'A_VERIFIER' AND pt."missionId" IS NULL`);
      const avant = { journal: await lignesJournalTotal(), missions: await compter(`SELECT count(*) FROM missions`), prop: await compter(`SELECT count(*) FROM propositions_teledetection`), produits: await compter(`SELECT count(*) FROM earth_observation_products`), etats: await compter(`SELECT count(*) FROM sources_observation_etats`) };
      const essais: [string, string, unknown][] = [
        ["POST", `/propositions/${une}/transition`, { vers: "EN_ATTENTE", motif: "intrusion" }],
        ["POST", `/propositions/${une}/verification`, {}],
        ["POST", `/sources/cdse-stac/verifier`, {}],
        ["POST", `/sources/cdse-stac/synchroniser-catalogue`, {}],
        ["POST", `/propositions`, { produitId: ID_INCONNU, methodeNom: "x", methodeVersion: "y", propositions: [] }],
        ["POST", `/produits`, {}],
      ];
      for (const [m, chemin, corps] of essais) {
        const r = await brut(c, chemin, m, corps);
        expect(r.status, `${m} ${chemin}`).toBe(403);
        expect(r.corps.code, `${m} ${chemin}`).toBe("ROLE_INSUFFISANT");
      }
      // Preuves : l'inspecteur n'ecrit que sur une mission qui lui est affectee ; le lecteur jamais.
      const p = await brut(c, `/propositions/${une}/preuves`, "POST", { observationIds: [ID_INCONNU] });
      expect(p.status).toBe(403);
      expect(p.corps.code).toBe(nom === "inspecteur" ? "MISSION_NON_AFFECTEE" : "ROLE_INSUFFISANT");
      expect({ journal: await lignesJournalTotal(), missions: await compter(`SELECT count(*) FROM missions`), prop: await compter(`SELECT count(*) FROM propositions_teledetection`), produits: await compter(`SELECT count(*) FROM earth_observation_products`), etats: await compter(`SELECT count(*) FROM sources_observation_etats`) }).toEqual(avant);
      // La lecture, elle, passe.
      expect((await brut(c, `/synthese`)).status).toBe(200);
      expect((await brut(c, `/sources`)).status).toBe(200);
    });
  });
}

test.describe("compte SANS le module `teledetection`", () => {
  test("liste de modules sans la cle : entree de menu absente, route refusee, serveur 403 MODULE_NON_AUTORISE sur toutes les routes", async ({ ouvrirSession, run }) => {
    const c = run.comptes.sansModule;
    const s = await ouvrirSession(c);
    const menu = s.page.getByRole("link", { name: "Observation de la Terre", exact: true });
    await expect(menu).toHaveCount(0);
    await s.page.goto("/teledetection");
    await s.page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(s.page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toHaveCount(0);
    await expect(s.page.getByText("Propositions à vérifier")).toHaveCount(0);
    // Aucune donnee du module n'a ete demandee ni recue par l'ecran.
    const reqTd = s.reponsesErreur.filter((r) => r.url.includes("/teledetection/"));
    expect(reqTd.filter((r) => r.status !== 403)).toEqual([]);
    // Serveur : meme refus partout, avec le meme code.
    const [une] = await idsSql(`TRUE`);
    for (const chemin of ["/synthese", "/propositions", `/propositions/${une}`, "/propositions.geojson?bbox=-15,9,-8,12", "/sources", "/produits", "/qualite-methodes", "/precision"]) {
      const r = await brut(c, chemin);
      expect(r.status, chemin).toBe(403);
      expect(r.corps.code, chemin).toBe("MODULE_NON_AUTORISE");
    }
    expect((await brut(c, `/propositions/${une}/transition`, "POST", { vers: "EN_ATTENTE", motif: "x" })).status).toBe(403);
    // Sans jeton : 401.
    const sans = await http("GET", `${PREFIXE_TD}/synthese`);
    expect(sans.status).toBe(401);
    expect(sans.corps.code).toBe("NON_AUTHENTIFIE");
  });

  // E2E-EO-3 (corrige : frontend/src/lib/modules.ts `hasModuleAccess`). Le serveur lit une liste de modules VIDE comme « AUCUN module »
  // (backend/src/lib/access.ts, correction du 05/09/2026) ; le frontend la lisait comme « aucune restriction » : un compte dont personne n'avait
  // encore choisi les modules voyait l'entree « Observation de la Terre » (et toutes les autres), l'ouvrait, et ne recevait que des refus du
  // serveur. Il lit maintenant la meme regle : seul ADMIN est exempte.
  test("liste de modules VIDE : le serveur dit « aucun module », l'entree de menu est absente aussi (E2E-EO-3)", async ({ ouvrirSession, run }) => {
    const c = run.comptes.modulesVides;
    const s = await ouvrirSession(c);
    expect((await brut(c, "/synthese")).status).toBe(403); // le serveur : aucun module
    await expect(s.page.getByRole("link", { name: "Observation de la Terre", exact: true })).toHaveCount(0, { timeout: 5_000 });
  });

  test("liste de modules VIDE : l'ecran dit « Accès non autorisé » et n'appelle pas l'API du module (E2E-EO-3)", async ({ ouvrirSession, run }) => {
    const c = run.comptes.modulesVides;
    const s = await ouvrirSession(c);
    const appels: string[] = [];
    s.page.on("request", (r) => { if (r.url().includes("/teledetection/")) appels.push(r.url()); });
    await s.page.goto("/teledetection");
    await expect(s.page.getByRole("heading", { name: "Accès non autorisé", level: 1 })).toBeVisible();
    await expect(s.page.getByText("Votre compte n'a pas accès à ce module.")).toBeVisible();
    // Ni l'ecran du module, ni ses indicateurs, ni un faux zero : le module n'est meme pas monte.
    await expect(s.page.getByRole("heading", { name: "Observation de la Terre", level: 1 })).toHaveCount(0);
    await expect(s.page.getByRole("region", { name: "Indicateurs de synthèse" })).toHaveCount(0);
    expect(appels, "aucun appel a /teledetection/ depuis un ecran refuse").toEqual([]);
  });
});
