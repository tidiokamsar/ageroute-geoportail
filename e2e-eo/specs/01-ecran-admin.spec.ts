import { compter, requete } from "../lib/base";
import { api, comptesSql, dateEcran, LIBELLE_TYPE, propositionsSql } from "../lib/oracle";
import { attendreTotal, filtre, idsAffiches, lignes, nettoyer, onglet, ouvrirDetail, ongletDetail, ouvrirFiltres, panneauDetail, reinitialiserFiltres, totalAffiche } from "../lib/ecran";
import { attendreEcran, capturer, carte, expect, test } from "../lib/fixtures";

/**
 * Parcours 1 : l'ecran REEL, ADMIN, contre l'API REELLE et la base REELLE. Lecture seule (aucune decision : les decisions sont au
 * parcours 3). Chaque valeur lue a l'ecran est comparee a l'API (jeton du meme compte) ET a un comptage SQL direct.
 *
 * CORRIGES (voir docs/observation-terre/E2E.md) : E2E-EO-1 (les propositions deposees en LIGNE etaient comptees « illisibles » par la
 * carte ; elles sont maintenant tracees) et E2E-EO-2 (la recherche trouve aussi le nom de la region).
 */
test.describe.serial("ecran ADMIN : indicateurs, carte, liste, filtres, detail", () => {
  test("indicateurs : memes valeurs que GET /synthese et que la base", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    const reponse = s.page.waitForResponse((r) => r.url().includes("/teledetection/synthese") && r.status() === 200);
    await s.page.goto("/teledetection");
    const enLigne = await (await reponse).json();
    await attendreEcran(s.page);

    const sql = await comptesSql();
    const serveur = (await api(run.comptes.admin, "GET", "/synthese")).corps;
    // 1. serveur = base
    expect(serveur.propositions).toEqual({ aVerifier: sql.aVerifier, enAttente: sql.enAttente, nonConcluantes: sql.nonConcluantes, confirmees: sql.confirmees, infirmees: sql.infirmees, prioritaires: sql.prioritaires });
    expect(enLigne.propositions).toEqual(serveur.propositions);
    // 2. ecran = serveur = base
    await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
    await expect(carte(s.page, "Propositions à vérifier").detail).toContainText(`dont ${sql.prioritaires} ${sql.prioritaires > 1 ? "prioritaires" : "prioritaire"}`);
    await expect(carte(s.page, "Confirmées").valeur).toHaveText(String(sql.confirmees));
    await expect(carte(s.page, "Infirmées").valeur).toHaveText(String(sql.infirmees));
    // Aucune source n'est « active » : ni dans la base, ni dans l'API, ni a l'ecran.
    const actives = await compter(`SELECT count(*) FROM sources_observation WHERE etat = 'TRAITEMENT_OPERATIONNEL'`);
    expect(actives).toBe(0);
    expect(serveur.sources.actives).toBe(0);
    await expect(carte(s.page, "Sources actives").valeur).toHaveText("0");
    const totalSources = await compter(`SELECT count(*) FROM sources_observation WHERE "deletedAt" IS NULL`);
    await expect(carte(s.page, "Sources actives").detail).toContainText(`sur ${totalSources} enregistrées`);
    // Derniere acquisition = le produit reel le plus recent de la base.
    const [dernier] = await requete<{ d: Date; resolutionM: number }>(`SELECT max("dateAcquisition") AS d, (array_agg("resolutionM" ORDER BY "dateAcquisition" DESC))[1] AS "resolutionM" FROM earth_observation_products WHERE NOT synthetique`);
    await expect(carte(s.page, "Dernière acquisition").valeur).toHaveText(dateEcran(dernier.d));
    await expect(carte(s.page, "Dernière acquisition").detail).toContainText(`${dernier.resolutionM} m`);
    // Zero verdict : « Aucun verdict », jamais 0 %.
    expect(sql.confirmees + sql.infirmees).toBe(0);
    await expect(carte(s.page, "Taux de confirmation terrain").valeur).toHaveText("Aucun verdict");
    await expect(s.page.getByText("Ce n'est pas la précision statistique.").first()).toBeVisible();
    // Compteurs d'onglets = synthese.
    for (const [lib, n] of [["À vérifier", sql.aVerifier], ["En attente", sql.enAttente], ["Non concluantes", sql.nonConcluantes], ["Confirmées", sql.confirmees], ["Infirmées", sql.infirmees]] as const) {
      await expect(onglet(s.page, lib)).toContainText(String(n));
    }
    expect(s.erreursPage).toEqual([]);
  });

  test("carte : marqueurs reels, vue d'ouverture, troncature dite", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    const reponse = s.page.waitForResponse((r) => r.url().includes("/teledetection/propositions.geojson") && r.status() === 200);
    await s.page.goto("/teledetection");
    const r = await reponse;
    await attendreEcran(s.page);
    const fc = await r.json() as { features: { geometry: { type: string }; properties: { id: string } }[]; tronque: boolean; total: number };
    // Emprise demandee : bornee a 10 degres de cote, centree sur la Guinee (vue d'ouverture, contrat §10).
    const bbox = new URL(r.url()).searchParams.get("bbox")!.split(",").map(Number);
    const [o, su, e, n] = bbox;
    expect(e - o).toBeGreaterThan(1);
    expect(e - o).toBeLessThanOrEqual(10);
    expect(n - su).toBeLessThanOrEqual(10);
    expect((o + e) / 2).toBeGreaterThan(-13);
    expect((o + e) / 2).toBeLessThan(-9);
    expect((su + n) / 2).toBeGreaterThan(8.5);
    expect((su + n) / 2).toBeLessThan(12.5);
    // L'API dit combien de propositions elle a dans l'emprise : toutes les 42, rien de tronque.
    const sql = await comptesSql();
    expect(fc.total).toBe(sql.total);
    expect(fc.tronque).toBe(false);
    await expect(s.page.getByText("Zoomez pour afficher les propositions")).toHaveCount(0);

    // Marqueurs dessines = features a geometrie GeoJSON valide : tous les types que le depot accepte (E2E-EO-1 corrige : les lignes sont tracees).
    const TYPES_VALIDES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];
    const dessinables = fc.features.filter((f) => TYPES_VALIDES.includes(f.geometry.type)).length;
    expect(dessinables, "aucune geometrie servie n'est d'un type inconnu").toBe(fc.features.length);
    await expect.poll(() => s.page.locator(".bdri-proposition-eo").count(), { timeout: 30_000 }).toBe(dessinables);
    // Chaque marqueur a un nom accessible.
    const noms = await s.page.locator(".bdri-proposition-eo [role=img]").evaluateAll((els) => els.map((x) => x.getAttribute("aria-label") ?? ""));
    expect(noms.length).toBe(dessinables);
    expect(noms.every((x) => x.length > 5)).toBe(true);
    // Le total annonce sous la carte est celui des marqueurs.
    await expect(s.page.getByText(new RegExp(`^${dessinables} propositions? affichées?`))).toBeVisible();
    // Types de geometrie servis (preuve, pas supposition).
    const types = fc.features.reduce<Record<string, number>>((m, f) => ({ ...m, [f.geometry.type]: (m[f.geometry.type] ?? 0) + 1 }), {});
    console.log(`[constat] geometries servies par propositions.geojson : ${JSON.stringify(types)} ; marqueurs dessines : ${dessinables} sur ${fc.features.length}`);
    await capturer(s.page, "01-carte-ouverture-1440");
  });

  // E2E-EO-1 (corrige) : le depot (backend/src/teledetection/api.noyau.ts) accepte LineString, MultiLineString, MultiPoint, MultiPolygon et
  // `propositions.geojson` rend la geometrie telle quelle (api.lecture.ts). `lireProposition` (frontend/src/lib/teledetectionCarte.ts) les lit
  // maintenant toutes : une « nouvelle route » ou une « coupure » deposee en ligne est tracee et recoit son repere ; seule une geometrie
  // vraiment invalide reste comptee « illisible ».
  test("carte : aucune proposition valide n'est declaree illisible (E2E-EO-1)", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    await expect(s.page.locator(".bdri-proposition-eo").first()).toBeVisible();
    await expect(s.page.getByText(/propositions? illisibles? ignorées?/)).toHaveCount(0, { timeout: 5_000 });
  });

  test("liste : 25 par page, « Charger plus », tri, memes identifiants que l'API", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const sql = await comptesSql();
    expect(sql.aVerifier).toBeGreaterThan(25);
    expect(await totalAffiche(s.page)).toBe(sql.aVerifier);
    await expect(lignes(s.page)).toHaveCount(25);
    await expect(s.page.getByText(`25 affichées sur ${sql.aVerifier}`)).toBeVisible();
    // « Charger plus » : le reste, une seule fois.
    await s.page.getByRole("button", { name: "Charger plus" }).click();
    await expect(lignes(s.page)).toHaveCount(sql.aVerifier);
    await expect(s.page.getByRole("button", { name: "Charger plus" })).toHaveCount(0);
    await expect(s.page.getByText(`${sql.aVerifier} affichées sur ${sql.aVerifier}`)).toBeVisible();
    // Memes identifiants, meme ordre que les pages de l'API.
    const ecran = await idsAffiches(s.page);
    const p1 = (await api(run.comptes.admin, "GET", "/propositions?statut=A_VERIFIER&limite=25")).corps;
    const p2 = (await api(run.comptes.admin, "GET", `/propositions?statut=A_VERIFIER&limite=25&curseur=${encodeURIComponent(p1.suivant)}`)).corps;
    expect(p2.suivant).toBeNull();
    expect(ecran).toEqual([...p1.items, ...p2.items].map((i: { id: string }) => i.id));
    expect(new Set(ecran).size).toBe(ecran.length);
    // Tri : date d'observation decroissante.
    const dates = await s.page.locator("#panneau-propositions time").evaluateAll((els) => els.map((e) => e.getAttribute("datetime") ?? ""));
    const ms = dates.map((d) => Date.parse(d));
    expect(ms.every((x, i) => i === 0 || x <= ms[i - 1])).toBe(true);
    // Chaque ligne nomme le changement ; une proposition non rattachee le dit.
    const nonRattachees = await compter(`SELECT count(*) FROM propositions_teledetection WHERE "tronconId" IS NULL AND statut = 'A_VERIFIER'`);
    await expect(s.page.getByText("Anomalie non rattachée")).toHaveCount(nonRattachees);
    // « Indice non calibre » : jamais un pourcentage de probabilite.
    await expect(s.page.getByText(/Détection : indice \d,\d\d \(non calibré\)/).first()).toBeVisible();
    await expect(s.page.locator("#panneau-propositions").getByText(/Détection : \d+\s?%/)).toHaveCount(0);
    expect(s.erreursPage).toEqual([]);
  });

  test("filtres : statut, type, priorite, rattachement, recherche, region, dates", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const P = s.page;
    const base = await comptesSql();
    await totalAffiche(P);

    // Statut : un onglet vide dit qu'il est vide.
    await onglet(P, "En attente").click();
    await attendreTotal(P, base.enAttente);
    await expect(P.getByText("Aucune proposition « En attente »")).toBeVisible();
    await expect(P.getByText("Il n'y a rien à traiter dans cette catégorie.")).toBeVisible();
    await onglet(P, "À vérifier").click();
    await attendreTotal(P, base.aVerifier);

    await ouvrirFiltres(P);
    // Type de changement
    for (const type of ["INONDATION", "VEGETATION", "COUPURE_PROBABLE", "NOUVELLE_ROUTE"]) {
      await filtre(P, "Type de changement").selectOption({ label: LIBELLE_TYPE[type] });
      const n = await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = 'A_VERIFIER' AND type = $1`, [type]);
      await attendreTotal(P, n);
      const pagine = Math.min(n, 25);
      await expect(lignes(P)).toHaveCount(pagine);
      await expect(P.getByTestId("total-filtre")).toContainText(`${n}`);
    }
    await filtre(P, "Type de changement").selectOption({ label: "Tous les types" });
    await attendreTotal(P, base.aVerifier);

    // Priorite haute
    await filtre(P, "Priorité").selectOption({ label: "Haute" });
    const haute = await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = 'A_VERIFIER' AND "prioriteNiveau" = 'HAUTE'`);
    await attendreTotal(P, haute);
    await filtre(P, "Priorité").selectOption({ label: "Toutes les priorités" });

    // Rattachement
    await filtre(P, "Rattachement au tronçon").selectOption({ label: "Anomalies non rattachées" });
    const non = await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = 'A_VERIFIER' AND "tronconId" IS NULL`);
    await attendreTotal(P, non);
    await expect(P.getByText("Anomalie non rattachée")).toHaveCount(non);
    await filtre(P, "Rattachement au tronçon").selectOption({ label: "Rattachées à un tronçon" });
    await attendreTotal(P, base.aVerifier - non);
    await filtre(P, "Rattachement au tronçon").selectOption({ label: "Rattachées ou non" });

    // Region
    await filtre(P, "Région").selectOption({ label: run.regions.B.nom });
    const regB = await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = 'A_VERIFIER' AND "regionId" = $1`, [run.regions.B.id]);
    await attendreTotal(P, regB);
    // La synthese suit la region : le compteur d'onglet aussi.
    const synB = (await api(run.comptes.admin, "GET", `/synthese?regionId=${run.regions.B.id}`)).corps;
    expect(synB.propositions.aVerifier).toBe(regB);
    await expect(carte(P, "Propositions à vérifier").valeur).toHaveText(String(regB));
    await filtre(P, "Région").selectOption({ label: "Toutes les régions" });
    await attendreTotal(P, base.aVerifier);

    // Recherche libre : code d'un troncon de test.
    const code = run.troncons[2].code;
    await P.getByRole("searchbox", { name: "Rechercher dans les propositions" }).fill(code);
    const parCode = await compter(`SELECT count(*) FROM propositions_teledetection pt JOIN troncons t ON t.id = pt."tronconId" WHERE NOT pt.synthetique AND pt.statut = 'A_VERIFIER' AND t.code = $1`, [code]);
    expect(parCode).toBeGreaterThan(0);
    await attendreTotal(P, parCode);
    await expect(P.getByText(new RegExp(`${code} · `)).first()).toBeVisible();
    await P.getByRole("searchbox", { name: "Rechercher dans les propositions" }).fill("zzz-introuvable-zzz");
    await attendreTotal(P, 0);
    await expect(P.getByText("Aucune proposition « À vérifier »")).toBeVisible();
    await expect(P.getByText(/Aucune proposition ne correspond à ces filtres/)).toBeVisible();

    // Dates : une fenetre future ne contient rien ; un intervalle incoherent est dit.
    await reinitialiserFiltres(P);
    await attendreTotal(P, base.aVerifier);
    const demain = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await filtre(P, "Observée à partir du").fill(demain);
    await attendreTotal(P, 0);
    await filtre(P, "Observée à partir du").fill("2026-10-20");
    await filtre(P, "Observée jusqu'au").fill("2026-10-10");
    await expect(P.getByRole("alert").filter({ hasText: "La date de début est postérieure à la date de fin" })).toBeVisible();
    await reinitialiserFiltres(P);
    await attendreTotal(P, base.aVerifier);
    expect(s.erreursPage).toEqual([]);
  });

  // E2E-EO-2 (corrige) : le champ de recherche annonce « Rechercher une zone, un tronçon… » et la liste affiche la region de chaque proposition
  // comme sa « zone » ; `q` porte maintenant aussi sur le nom de la region (backend/src/teledetection/api.lecture.ts), en plus du code et du
  // nom du troncon, de la methode et du debut de l'identifiant.
  test("recherche : le nom de la zone (region) affichee dans la liste trouve ses propositions (E2E-EO-2)", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    const regB = await compter(`SELECT count(*) FROM propositions_teledetection WHERE NOT synthetique AND statut = 'A_VERIFIER' AND "regionId" = $1`, [run.regions.B.id]);
    await s.page.getByRole("searchbox", { name: "Rechercher dans les propositions" }).fill(run.regions.B.nom);
    await attendreTotal(s.page, regB, 8_000);
  });

  test("detail : ce que dit l'ecran = ce que dit l'API ; limites, provenance, onglets", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    // Une proposition rattachee, avec une image de reference, parmi les 25 premieres.
    const page1 = (await api(run.comptes.admin, "GET", "/propositions?statut=A_VERIFIER&limite=25")).corps.items as { id: string; rattachee: boolean; dateReference: string | null }[];
    const choisie = page1.find((p) => p.rattachee && p.dateReference);
    expect(choisie, "une proposition rattachee avec reference dans la premiere page").toBeTruthy();
    await totalAffiche(s.page);
    await ouvrirDetail(s.page, choisie!.id);
    const d = (await api(run.comptes.admin, "GET", `/propositions/${choisie!.id}`)).corps;
    const P = panneauDetail(s.page);
    const texte = nettoyer(await P.innerText());

    expect(texte).toContain(LIBELLE_TYPE[d.type]);
    await expect(P.getByText("À vérifier", { exact: true }).first()).toBeVisible();
    expect(texte).toContain(`${d.troncon.code} · ${d.troncon.nom}`);
    expect(texte).toContain(d.troncon.regionNom);
    expect(texte).toContain(`Date d'acquisition ${dateEcran(d.dateObservation)}`);
    expect(texte).toContain(`Image de référence ${dateEcran(d.dateReference)}`);
    expect(texte).toContain("Résolution native 10 m");
    expect(texte).toContain(`${d.methode.nom} (version ${d.methode.version})`);
    expect(texte).toContain(`indice ${d.confianceDetection.valeur.toLocaleString("fr-FR", { minimumFractionDigits: 2 })}`);
    expect(texte).toContain("indice non calibré".toLowerCase());
    expect(texte).toContain(`${d.imageNote ?? d.qualiteImage.note}`);
    expect(texte).toContain(`${String(d.qualiteImage.couvertureNuagesPct).replace(".", ",")} % de nuages`);
    // Rattachement : distance et algorithme viennent du serveur.
    expect(texte).toContain(`Distance au tronçon : ${Math.round(d.rattachement.distanceM)} m`);
    expect(texte).toContain(d.rattachement.algorithme);
    // Les limites propres a la proposition sont toutes la, et la resolution native est rappelee.
    for (const l of d.limites as string[]) expect(texte).toContain(l);
    expect(texte).toContain("Rien n'est affirmé au-delà de la résolution native de 10 m");
    expect(d.limitesNonRenseignees).toBe(false);
    // Provenance (details repliable) : valeurs du produit reel.
    await P.getByText("Provenance", { exact: true }).click();
    const [prod] = await requete<{ fournisseur: string; identifiantFournisseur: string; licenceCode: string }>(
      `SELECT p.fournisseur, p."identifiantFournisseur", p."licenceCode" FROM propositions_teledetection pt JOIN earth_observation_products p ON p.id = pt."produitId" WHERE pt.id = $1`, [choisie!.id]);
    await expect(P.getByText(prod.identifiantFournisseur, { exact: true })).toBeVisible();
    await expect(P.getByText(prod.fournisseur, { exact: true })).toBeVisible();
    await expect(P.getByText("Non calculée")).toBeVisible(); // aucune empreinte : produit de catalogue, aucun pixel chez nous

    // Onglets. Aperçus REMPLACES par le harnais dans cette spec (le vrai fournisseur est examine au parcours 2).
    await ongletDetail(s.page, "Aperçu");
    await expect(P.getByText("Aperçu indisponible chez le fournisseur")).toBeVisible();
    await expect(P.getByRole("img", { name: /Vue satellite/ })).toHaveCount(0);
    await ongletDetail(s.page, "Comparaison");
    await expect(P.getByText("Comparaison impossible : les images avant et après sont indisponibles chez le fournisseur.")).toBeVisible();
    await expect(P.getByRole("slider")).toBeDisabled();
    await ongletDetail(s.page, "Terrain");
    await expect(P.getByText("Aucune mission de vérification n'est liée à cette proposition.")).toBeVisible();
    await expect(P.getByText("Aucune observation de terrain liée")).toBeVisible();
    await ongletDetail(s.page, "Historique");
    await expect(P.getByText("Aucune décision enregistrée")).toBeVisible();
    // ADMIN : toutes les decisions sont offertes.
    for (const b of ["Confirmer", "Infirmer", "Mettre en attente", "Demander des informations", "Non concluante", "Affecter à une inspection"]) {
      await expect(P.getByRole("button", { name: new RegExp(`^${b}`) })).toBeVisible();
    }
    expect(s.ecritures).toEqual([]); // consulter n'ecrit rien
    await capturer(s.page, "01-detail-1440");
    expect(s.erreursPage).toEqual([]);
  });

  test("hors detail : la proposition choisie sur la liste est celle de la carte (selection et fermeture)", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSession(run.comptes.admin);
    await s.page.goto("/teledetection");
    await attendreEcran(s.page);
    await totalAffiche(s.page);
    const [premiere] = await idsAffiches(s.page);
    await ouvrirDetail(s.page, premiere);
    await expect(s.page.locator(`#proposition-${premiere}`)).toHaveAttribute("aria-current", "true");
    await s.page.getByRole("button", { name: "Fermer le détail de la proposition" }).click();
    await expect(s.page.getByText("Aucune proposition sélectionnée")).toBeVisible();
    await expect(s.page.locator(`#proposition-${premiere}`)).not.toHaveAttribute("aria-current", "true");
    const total = await propositionsSql();
    expect(total.length).toBeGreaterThan(0);
  });
});

