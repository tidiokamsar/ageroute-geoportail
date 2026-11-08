import { compter, requete } from "../lib/base";
import { api, comptesSql, journalDe, LIBELLE_TYPE, lignesJournalTotal, propositionsSql } from "../lib/oracle";
import { attendreTotal, nettoyer, onglet, ouvrirDetail, ongletDetail, panneauDetail, totalAffiche } from "../lib/ecran";
import { attendreEcran, carte, expect, test, type Session } from "../lib/fixtures";
import type { Page } from "@playwright/test";

/**
 * Parcours 3 : les DECISIONS, par l'ecran, ecrites en base REELLE. Pour chaque geste on lit ensuite la base : statut, journal (une ligne par
 * transition, auteur authentifie, motif), audit, compteurs. Le referentiel (troncons, portions, ouvrages) ne doit pas bouger : son
 * empreinte est comparee au parcours 8.
 */

const ids: { [k: string]: string } = {};

function bouton(page: Page, nom: RegExp | string) { return panneauDetail(page).getByRole("button", { name: nom }); }
const enregistrer = (page: Page) => panneauDetail(page).getByRole("button", { name: "Enregistrer la décision" });

async function ouvrirFormulaire(page: Page, action: RegExp) {
  await bouton(page, action).click();
  await expect(panneauDetail(page).getByRole("group", { name: /formulaire de décision/ })).toBeVisible();
}

async function remplir(page: Page, { motif, commentaire, reference }: { motif?: string; commentaire?: string; reference?: string }) {
  const P = panneauDetail(page);
  if (motif !== undefined) await P.getByLabel(/^Motif/).fill(motif);
  if (commentaire !== undefined) await P.getByLabel("Commentaire (facultatif)").fill(commentaire);
  if (reference !== undefined) await P.getByLabel(/^Référence du constat/).fill(reference);
}

/** Les cinq compteurs et le taux de l'ecran = l'API = la base. */
async function verifierCompteurs(s: Session, run: import("../lib/donnees").DonneesRun) {
  const sql = await comptesSql();
  const serveur = (await api(run.comptes.admin, "GET", "/synthese")).corps;
  expect(serveur.propositions).toEqual({ aVerifier: sql.aVerifier, enAttente: sql.enAttente, nonConcluantes: sql.nonConcluantes, confirmees: sql.confirmees, infirmees: sql.infirmees, prioritaires: sql.prioritaires });
  await expect(carte(s.page, "Propositions à vérifier").valeur).toHaveText(String(sql.aVerifier));
  await expect(carte(s.page, "Confirmées").valeur).toHaveText(String(sql.confirmees));
  await expect(carte(s.page, "Infirmées").valeur).toHaveText(String(sql.infirmees));
  for (const [lib, n] of [["À vérifier", sql.aVerifier], ["En attente", sql.enAttente], ["Non concluantes", sql.nonConcluantes], ["Confirmées", sql.confirmees], ["Infirmées", sql.infirmees]] as const) {
    await expect(onglet(s.page, lib)).toContainText(String(n));
  }
  const jugees = sql.confirmees + sql.infirmees;
  const attendu = jugees === 0 ? "Aucun verdict" : `${((sql.confirmees / jugees) * 100).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  await expect.poll(async () => nettoyer(await s.page.getByTestId("valeur-taux").textContent()), { timeout: 15_000 }).toBe(attendu);
  if (jugees > 0 && jugees < 30) await expect(s.page.getByTestId("mention-echantillon")).toHaveText(`échantillon insuffisant (n = ${jugees})`);
  expect(serveur.tauxConfirmation.jugees).toBe(jugees);
  expect(serveur.tauxConfirmation.echantillonSuffisant).toBe(false);
}

async function ouvrirSessionAdmin(ouvrirSession: (c: import("../lib/donnees").CompteRun) => Promise<Session>, run: import("../lib/donnees").DonneesRun): Promise<Session> {
  const s = await ouvrirSession(run.comptes.admin);
  await s.page.goto("/teledetection");
  await attendreEcran(s.page);
  await totalAffiche(s.page);
  return s;
}

test.describe.serial("decisions sur les propositions", () => {
  test("preparation : les propositions visees sont dans la premiere page", async ({ run }) => {
    const items = (await api(run.comptes.admin, "GET", "/propositions?statut=A_VERIFIER&limite=25")).corps.items as { id: string; rattachee: boolean }[];
    const rattachees = items.filter((i) => i.rattachee);
    expect(rattachees.length).toBeGreaterThanOrEqual(8);
    [ids.attente, ids.infirmee, ids.double, ids.info, ids.nonConcluante, ids.mission] = rattachees.slice(0, 6).map((i) => i.id);
    expect(new Set(Object.values(ids)).size).toBe(6);
  });

  test("Mettre en attente : motif obligatoire, journal, statut, compteurs", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    const avant = await comptesSql();
    const journalAvant = await lignesJournalTotal();
    await ouvrirDetail(s.page, ids.attente);
    await ouvrirFormulaire(s.page, /^Mettre en attente/);
    // Sans motif : le bouton est inactif et dit pourquoi.
    await expect(enregistrer(s.page)).toBeDisabled();
    await expect(s.page.getByTestId("raison-inactif")).toHaveText("Saisissez le motif de la décision.");
    const ecrituresAvant = s.ecritures.length;
    await enregistrer(s.page).click({ force: true });
    await s.page.waitForTimeout(400);
    expect(s.ecritures.length, "un bouton inactif n'envoie rien").toBe(ecrituresAvant);
    await remplir(s.page, { motif: "Equipe prevenue, passage prevu semaine prochaine", commentaire: "Voir le chef de district" });
    await expect(enregistrer(s.page)).toBeEnabled();
    await enregistrer(s.page).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « En attente ».")).toBeVisible();

    // Base REELLE.
    const [p] = await propositionsSql("pt.id = $1", [ids.attente]);
    expect(p.statut).toBe("EN_ATTENTE");
    expect(p.motifAttente).toBe("AUTRE");
    const j = await journalDe(ids.attente);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ de: "A_VERIFIER", vers: "EN_ATTENTE", auteurId: run.comptes.admin.id, motif: "Equipe prevenue, passage prevu semaine prochaine", commentaire: "Voir le chef de district", motifAttente: "AUTRE" });
    expect(await lignesJournalTotal()).toBe(journalAvant + 1);
    // Compteurs : un de moins a verifier, un de plus en attente (ecran = API = base).
    const apres = await comptesSql();
    expect(apres.aVerifier).toBe(avant.aVerifier - 1);
    expect(apres.enAttente).toBe(avant.enAttente + 1);
    await verifierCompteurs(s, run);
    await attendreTotal(s.page, apres.aVerifier);
    // Historique de l'ecran = journal.
    await ongletDetail(s.page, "Historique");
    const h = nettoyer(await panneauDetail(s.page).getByRole("list", { name: "Historique des décisions" }).innerText());
    expect(h).toContain(run.comptes.admin.nomComplet);
    expect(h).toContain("À vérifier vers En attente");
    expect(h).toContain("Motif : Equipe prevenue, passage prevu semaine prochaine");
    expect(h).toContain("Commentaire : Voir le chef de district");
    expect(s.erreursPage).toEqual([]);
  });

  test("Confirmer : sans constat le bouton reste inactif et dit pourquoi ; avec une reference, verdict definitif", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    await onglet(s.page, "En attente").click();
    await ouvrirDetail(s.page, ids.attente);
    await ouvrirFormulaire(s.page, /^Confirmer/);
    await remplir(s.page, { motif: "Equipe sur place : la zone est coupee sur 40 m" });
    // Motif saisi, mais ni observation ni reference : inactif, avec la raison du constat.
    await expect(enregistrer(s.page)).toBeDisabled();
    await expect(s.page.getByTestId("raison-inactif")).toContainText("Un verdict cite le constat de terrain qui le fonde");
    await expect(s.page.getByText("Aucune observation de terrain n'est liée à cette proposition : saisissez la référence du constat qui fonde le verdict.")).toBeVisible();
    const ecrituresAvant = s.ecritures.length;
    await enregistrer(s.page).click({ force: true });
    await s.page.waitForTimeout(400);
    expect(s.ecritures.length).toBe(ecrituresAvant);
    expect((await propositionsSql("pt.id = $1", [ids.attente]))[0].statut).toBe("EN_ATTENTE");

    // Avec la reference du constat : le verdict part.
    await remplir(s.page, { reference: "CONSTAT-E2E-0001" });
    await expect(enregistrer(s.page)).toBeEnabled();
    await enregistrer(s.page).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « Confirmée ».")).toBeVisible();
    // Base : verdict pose, signe, cite son constat ; journal = 2 lignes.
    const [p] = await propositionsSql("pt.id = $1", [ids.attente]);
    expect(p.statut).toBe("CONFIRMEE");
    expect(p.constatRef).toBe("CONSTAT-E2E-0001");
    expect(p.verifieeParId).toBe(run.comptes.admin.id);
    expect(p.motifVerdict).toBe("Equipe sur place : la zone est coupee sur 40 m");
    expect(p.motifAttente).toBeNull();
    const j = await journalDe(ids.attente);
    expect(j.map((l) => `${l.de}>${l.vers}`)).toEqual(["A_VERIFIER>EN_ATTENTE", "EN_ATTENTE>CONFIRMEE"]);
    // Ecran : plus de bouton de decision, verdict dit definitif.
    await expect(s.page.getByText("Verdict définitif : cette proposition est « Confirmée » et ne peut plus être modifiée.")).toBeVisible();
    await expect(bouton(s.page, /^(Confirmer|Infirmer|Mettre en attente|Non concluante|Remettre à vérifier|Affecter)/)).toHaveCount(0);
    await ongletDetail(s.page, "Historique");
    await expect(panneauDetail(s.page).getByRole("list", { name: "Historique des décisions" }).getByRole("listitem")).toHaveCount(2);
    await verifierCompteurs(s, run);
    // Taux : 1 verdict, 100 %, MAIS « echantillon insuffisant (n = 1) » : jamais une performance fiable.
    await expect(s.page.getByTestId("valeur-taux")).toContainText("100,0");
    await expect(s.page.getByTestId("mention-echantillon")).toHaveText("échantillon insuffisant (n = 1)");
    // Qualite par methode (ADMIN = national) : la ligne de la methode, avec son effectif.
    const qualite = nettoyer(await s.page.locator('section[aria-labelledby="titre-qualite-methodes"]').innerText());
    expect(qualite).toContain("fixture-e2e-eo v0");
    expect(qualite).toContain(LIBELLE_TYPE[p.type]);
    expect(qualite).toContain("100,0 % (n = 1)");
    expect(qualite).toMatch(/[ÉE]chantillon insuffisant \(n = 1\)/);
    // Le serveur confirme : un verdict ne se reprend pas (409 VERDICT_DEFINITIF), et la base le refuse aussi.
    const r = await api(run.comptes.admin, "POST", `/propositions/${ids.attente}/transition`, { vers: "EN_ATTENTE", motif: "tentative de reprise" });
    expect(r.status).toBe(409);
    expect(r.corps.code).toBe("VERDICT_DEFINITIF");
    expect(await journalDe(ids.attente)).toHaveLength(2);
    expect(s.erreursPage).toEqual([]);
  });

  test("Infirmer une autre proposition : taux 1 sur 2, pas de reference = pas de verdict", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    await ouvrirDetail(s.page, ids.infirmee);
    await ouvrirFormulaire(s.page, /^Infirmer/);
    await remplir(s.page, { motif: "Rien a signaler sur place", commentaire: "Zone verifiee a pied" });
    await expect(enregistrer(s.page)).toBeDisabled();
    // Une reference faite d'espaces ne vaut pas constat.
    await remplir(s.page, { reference: "    " });
    await expect(enregistrer(s.page)).toBeDisabled();
    await remplir(s.page, { reference: "RAPPORT-E2E-0002" });
    await enregistrer(s.page).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « Infirmée ».")).toBeVisible();
    const [p] = await propositionsSql("pt.id = $1", [ids.infirmee]);
    expect(p).toMatchObject({ statut: "INFIRMEE", constatRef: "RAPPORT-E2E-0002", verifieeParId: run.comptes.admin.id });
    expect((await journalDe(ids.infirmee)).map((l) => `${l.de}>${l.vers}`)).toEqual(["A_VERIFIER>INFIRMEE"]);
    await verifierCompteurs(s, run);
    await expect(s.page.getByTestId("valeur-taux")).toContainText("50,0");
    await expect(s.page.getByTestId("mention-echantillon")).toHaveText("échantillon insuffisant (n = 2)");
    // Le panneau « Taux de confirmation » ne dit jamais « precision » comme valeur.
    const widget = nettoyer(await s.page.locator('section[aria-labelledby="titre-taux"]').innerText());
    expect(widget).toContain("Ce n'est pas la précision statistique de la détection");
    expect(s.erreursPage).toEqual([]);
  });

  test("un double clic ne fait qu'une transition (clic natif double, puis deux clics du meme tick)", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    const posts: string[] = [];
    s.page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/transition")) posts.push(r.url()); });

    // 1. dblclick de la souris
    const avant = await lignesJournalTotal();
    await ouvrirDetail(s.page, ids.double);
    await ouvrirFormulaire(s.page, /^Mettre en attente/);
    await remplir(s.page, { motif: "Test du double clic (souris)" });
    await enregistrer(s.page).dblclick();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « En attente ».")).toBeVisible();
    await s.page.waitForTimeout(800);
    expect(posts.filter((u) => u.includes(ids.double))).toHaveLength(1);
    expect(await journalDe(ids.double)).toHaveLength(1);
    expect(await lignesJournalTotal()).toBe(avant + 1);

    // 2. deux clics dans le MEME tick (le rendu React n'a pas encore pose « en cours » : seul le verrou synchrone protege)
    await ouvrirDetail(s.page, ids.info);
    await ouvrirFormulaire(s.page, /^Demander des informations/);
    await remplir(s.page, { motif: "Test du double clic (meme tick)" });
    await enregistrer(s.page).evaluate((el: HTMLButtonElement) => { el.click(); el.click(); el.click(); });
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « En attente ».")).toBeVisible();
    await s.page.waitForTimeout(800);
    expect(posts.filter((u) => u.includes(ids.info))).toHaveLength(1);
    const j = await journalDe(ids.info);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ vers: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE" });
    expect((await propositionsSql("pt.id = $1", [ids.info]))[0].motifAttente).toBe("INFO_DEMANDEE");
    expect(await lignesJournalTotal()).toBe(avant + 2);
    // Aucune erreur de conflit affichee a l'agent.
    await expect(s.page.getByRole("alert").filter({ hasText: /refuse|Échec/ })).toHaveCount(0);
    expect(s.erreursPage).toEqual([]);
  });

  test("Non concluante, puis Remettre a verifier : le chemin retour existe, le journal garde les deux", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    await ouvrirDetail(s.page, ids.nonConcluante);
    await ouvrirFormulaire(s.page, /^Non concluante/);
    await remplir(s.page, { motif: "Nuages sur toute la scene, impossible de trancher" });
    await expect(enregistrer(s.page)).toBeEnabled(); // aucun constat exige pour une non-conclusion
    await enregistrer(s.page).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « Non concluante ».")).toBeVisible();
    expect((await propositionsSql("pt.id = $1", [ids.nonConcluante]))[0].statut).toBe("NON_CONCLUANTE");
    await expect(onglet(s.page, "Non concluantes")).toContainText("1");
    // Retour a la file.
    await ouvrirFormulaire(s.page, /^Remettre à vérifier/);
    await remplir(s.page, { motif: "Nouvelle image disponible, a revoir" });
    await enregistrer(s.page).click();
    await expect(s.page.getByText("Décision enregistrée : la proposition est maintenant « À vérifier ».")).toBeVisible();
    expect((await propositionsSql("pt.id = $1", [ids.nonConcluante]))[0].statut).toBe("A_VERIFIER");
    expect((await journalDe(ids.nonConcluante)).map((l) => `${l.de}>${l.vers}`)).toEqual(["A_VERIFIER>NON_CONCLUANTE", "NON_CONCLUANTE>A_VERIFIER"]);
    await verifierCompteurs(s, run);
  });

  test("Affecter a une inspection : une mission de verification est creee, region et emprise renseignees, la proposition ne change pas de statut", async ({ ouvrirSession, run }) => {
    const s = await ouvrirSessionAdmin(ouvrirSession, run);
    const missionsAvant = await compter(`SELECT count(*) FROM missions`);
    await ouvrirDetail(s.page, ids.mission);
    await ouvrirFormulaire(s.page, /^Affecter à une inspection/);
    // Pas de motif pour cette action : le bouton est direct.
    await panneauDetail(s.page).getByRole("button", { name: "Créer la mission de vérification" }).click();
    await expect(s.page.getByText(/Mission .* créée en brouillon\./)).toBeVisible();
    expect(await compter(`SELECT count(*) FROM missions`)).toBe(missionsAvant + 1);
    const [p] = await propositionsSql("pt.id = $1", [ids.mission]);
    expect(p.statut).toBe("A_VERIFIER");
    expect(p.missionId).toBeTruthy();
    const [m] = await requete<{ code: string; statut: string; type: string; regionId: number | null; emprise_ok: boolean; createurId: string; intitule: string }>(
      `SELECT code, statut::text AS statut, type::text AS type, "regionId", emprise IS NOT NULL AS emprise_ok, "createurId", intitule FROM missions WHERE id = $1`, [p.missionId]);
    expect(m.statut).toBe("BROUILLON");
    expect(m.regionId).toBe(p.regionId); // ecart d'audit corrige : la mission porte la region de la proposition
    expect(m.emprise_ok).toBe(true);
    expect(m.createurId).toBe(run.comptes.admin.id);
    expect(m.intitule).toContain(p.tronconCode!);
    // L'ecran : la fiche dit la mission, l'action n'est plus offerte une seconde fois.
    await expect(s.page.getByText("Une mission de vérification est déjà affectée à cette proposition.")).toBeVisible();
    await expect(bouton(s.page, /^Affecter à une inspection/)).toHaveCount(0);
    await ongletDetail(s.page, "Terrain");
    await expect(panneauDetail(s.page).getByText(/Mission de vérification .* : BROUILLON, non assignée\./)).toBeVisible();
    // Deuxieme demande par l'API : refusee (409 MISSION_DEJA_DEPECHEE), aucune seconde mission.
    const r = await api(run.comptes.admin, "POST", `/propositions/${ids.mission}/verification`, {});
    expect(r.status).toBe(409);
    expect(r.corps.code).toBe("MISSION_DEJA_DEPECHEE");
    expect(await compter(`SELECT count(*) FROM missions`)).toBe(missionsAvant + 1);
  });

  test("audit : chaque ecriture est tracee, par le compte authentifie", async ({ run }) => {
    // Pas de filtre sur une heure du poste (les colonnes de date de la base sont sans fuseau) : on part de la premiere ligne de journal de ce parcours.
    const debut = "(SELECT min(\"creeLe\") FROM propositions_teledetection_transitions)";
    for (const [nom, id] of Object.entries(ids)) {
      const l = await requete<{ entityType: string; action: string; userId: string | null }>(
        `SELECT "entityType", action::text AS action, "userId" FROM audit_logs
          WHERE ("entityId" = $1 OR after->>'propositionTeledetectionId' = $1) AND "createdAt" >= ${debut} - interval '1 day' ORDER BY "createdAt"`, [id]);
      // Une proposition decidee a une ligne d'audit a son nom. L'affectation a une inspection est tracee par la ligne de la MISSION creee, qui cite la
      // proposition (`after.propositionTeledetectionId`) : l'ecriture du lien missionId n'a pas de ligne propre a la proposition (constat E2E-EO-5, faible).
      expect(l.length, `ligne d'audit pour la proposition ${nom} (${id})`).toBeGreaterThan(0);
      expect(l.every((x) => x.userId === run.comptes.admin.id), nom).toBe(true);
      if (nom === "mission") expect(l.map((x) => `${x.entityType}/${x.action}`)).toEqual(["Mission/CREATE"]);
    }
    const parType = await requete<{ entityType: string; action: string; n: string }>(
      `SELECT "entityType", action::text AS action, count(*)::text AS n FROM audit_logs WHERE "userId" = $1 AND "entityType" IN ('PropositionTeledetection', 'Mission') AND "createdAt" >= ${debut} - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2`, [run.comptes.admin.id]);
    console.log(`[audit] ecritures de ce parcours : ${parType.map((x) => `${x.entityType}/${x.action}=${x.n}`).join(", ")}`);
    expect(parType.length).toBeGreaterThan(0);
  });
});
