import { requete } from "../lib/base";
import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, JUSTIFICATION, codeProjet, creerCompte, jeuxDuProjet, nombreObjetsDuJeu, ouvrirProjet, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, geojson, kml, type Ligne } from "../lib/voirie-geo";

/**
 * KIS-REV-01 (cahier 22.3) et delta de versions (CONTRAT-IMPORT.md, 14) :
 *
 *   - une nouvelle version qui RETIRE des objets ne s'autorise pas tant que la revue des suppressions n'est pas faite et justifiee ;
 *     retirer l'ancienne version pour contourner est refuse ; le retour arriere est possible et ne perd rien (assistant, en reprise) ;
 *   - une seconde version du plan d'axes qui modifie un axe : comparaison d'analyses, dossiers dependants a reexaminer, verdict humain conserve,
 *     version precedente conservee.
 */

test.describe.configure({ mode: "serial" });

let gestionnaire: CompteVoirie;
test.beforeAll(async () => { gestionnaire = await creerCompte("e2e-rev-gest", "Gestionnaire Versions E2E", "GESTIONNAIRE"); });

const etat: { projetId: string; nom: string; v1: string; v2: string; concessionnaireId: string; objetsV1: number } = { projetId: "", nom: "", v1: "", v2: "", concessionnaireId: "", objetsV1: 0 };

test("préparation : version 1 autorisée (6 objets), version 2 déposée en quarantaine sans 2 objets", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  etat.projetId = await api.creerProjet(codeProjet(marqueur, "REV"));
  etat.nom = `Projet ${codeProjet(marqueur, "REV")}`;
  etat.concessionnaireId = await api.creerConcessionnaire(`Operateur ${marqueur}`, "TELECOM");
  etat.v1 = await api.deposerEtAutoriser(etat.projetId, { name: "reseau-v1.geojson", buffer: geojson(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: etat.concessionnaireId, classePrecision: "B" });
  etat.objetsV1 = await nombreObjetsDuJeu(etat.v1);
  expect(etat.objetsV1).toBe(6);
  // Version 2 : memes noms, deux circuits (P et K) retires.
  const sansDeux = RESEAU_TELECOM.filter((l) => !["Fibre-Synth P", "Fibre-Synth K"].includes(l.nom));
  etat.v2 = await api.deposerOk(etat.projetId, { name: "reseau-v2.geojson", buffer: geojson(sansDeux) }, { role: "RESEAU_TIERS", concessionnaireId: etat.concessionnaireId, classePrecision: "B" });
  const jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.v2)).toMatchObject({ version: 2, statut: "CONTROLE", remplaceId: etat.v1 });
  const delta = await api.get(`${BASE}/${etat.projetId}/jeux/${etat.v2}/delta`);
  expect(delta.statut).toBe(200);
  expect(delta.corps.delta).toMatchObject({ retires: 2, ajoutes: 0 });
  expect(delta.corps.suppressions).toMatchObject({ statut: "A_REVOIR", nb: 2 });
  await api.fermer();
});

test("KIS-REV-01 : l'autorisation est bloquée tant que les suppressions ne sont pas revues ; retirer l'ancienne version pour contourner est refusé", async () => {
  test.skip(!etat.v2, "depend de la preparation");
  const api = await ApiVoirie.connecter(gestionnaire);
  const base = `${BASE}/${etat.projetId}`;
  const sansRevue = await api.autoriser(etat.projetId, etat.v2);
  expect(sansRevue.statut).toBe(409);
  expect(sansRevue.corps).toMatchObject({ code: "SUPPRESSIONS_A_REVOIR", nb: 2 });
  // Contournement : retirer l'ancienne version (autorisee) pour que la nouvelle ne remplace plus rien.
  const contournement = await api.delete(`${base}/jeux/${etat.v1}`);
  expect(contournement.statut, "l'ancienne version ne se retire pas tant qu'une nouvelle l'attend").toBe(409);
  expect(contournement.corps.code).toBe("DEPOT_EN_ATTENTE");
  // Revue : la justification est obligatoire (10 caracteres au moins).
  expect((await api.post(`${base}/jeux/${etat.v2}/revue-suppressions`, { decision: "ACCEPTER", justification: "ok" })).statut, "justification trop courte").toBe(400);
  expect((await api.autoriser(etat.projetId, etat.v2)).corps.code, "toujours bloquee").toBe("SUPPRESSIONS_A_REVOIR");
  // Les deux jeux sont inchanges, aucun objet n'a ete supprime.
  const jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.v1)!.statut).toBe("AUTORISE");
  expect(jeux.find((j) => j.id === etat.v2)!.statut).toBe("CONTROLE");
  expect(await nombreObjetsDuJeu(etat.v1)).toBe(etat.objetsV1);
  await api.fermer();
});

test("KIS-REV-01 : revue, autorisation et retour arrière dans l'assistant (reprise sur un jeu déposé)", async ({ ouvrirProfil }) => {
  test.skip(!etat.v2, "depend de la preparation");
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Couches" }).click();
  await page.getByRole("button", { name: /Versions et suppressions du jeu .*, version 2/ }).click();
  const d = page.getByRole("dialog", { name: "Ajouter des données au projet" });
  await expect(d.getByTestId("etape-texte")).toContainText("Comparaison avec la version autorisée");
  // Delta : 2 retires, a revoir.
  await expect(d.getByTestId("delta-retires")).toHaveText("2");
  await expect(d.getByTestId("delta-identiques")).toHaveText("4");
  const revue = d.getByTestId("revue-suppressions");
  await expect(revue).toHaveAttribute("data-statut", "A_REVOIR");
  await expect(revue).toContainText("Rien n'est supprimé tant qu'une personne n'a pas revu et accepté");

  // Approbation AVANT la revue : le bouton « Autoriser » est inactif et le blocage est dit.
  await d.getByRole("button", { name: "Continuer vers l'approbation" }).click();
  await expect(d.getByTestId("blocage-suppressions")).toBeVisible();
  await d.getByLabel(/Justification \(10 caractères minimum\)/).first().fill(JUSTIFICATION);
  await expect(d.getByRole("button", { name: "Autoriser ce jeu" })).toBeDisabled();
  expect((await jeuxDuProjet(etat.projetId)).find((j) => j.id === etat.v2)!.statut).toBe("CONTROLE");

  // Retour a la comparaison : revue acceptee, avec justification.
  await d.getByRole("button", { name: "Précédent" }).click();
  await d.getByLabel(/Justification de la revue/).fill("Les circuits P et K sont abandonnes par l'operateur (courrier du 05/11)");
  await d.getByRole("button", { name: "Accepter les suppressions" }).click();
  await expect(d.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "ACCEPTEES");
  await expect(d.getByTestId("derniere-revue")).toContainText("acceptée");
  const evenements = await requete<{ type: string }>(`SELECT type::text AS type FROM projets_voirie_import_evenements WHERE "jeuId" = $1 ORDER BY "createdAt"`, [etat.v2]);
  expect(evenements.map((e) => e.type), "revue consignee (acceptation)").toEqual(expect.arrayContaining(["SUPPRESSIONS_ACCEPTEES"]));
  expect(await nombreObjetsDuJeu(etat.v1), "accepter une revue ne supprime rien").toBe(etat.objetsV1);

  // Autorisation : maintenant possible.
  await d.getByRole("button", { name: "Continuer vers l'approbation" }).click();
  await expect(d.getByTestId("blocage-suppressions")).toHaveCount(0);
  await d.getByLabel(/Justification \(10 caractères minimum\)/).first().fill(JUSTIFICATION);
  await d.getByRole("button", { name: "Autoriser ce jeu" }).click();
  await expect(d.getByTestId("issue-autorise")).toBeVisible();
  let jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.v2)!.statut).toBe("AUTORISE");
  expect(jeux.find((j) => j.id === etat.v1)!.statut, "l'ancienne version est remplacee, conservee").toBe("REMPLACE");
  expect(await nombreObjetsDuJeu(etat.v1)).toBe(etat.objetsV1);

  // Retour arriere : confirmation + justification ; la version 1 revient, la 2 est remplacee, rien n'est perdu.
  const ra = d.getByTestId("retour-arriere");
  await expect(ra).toBeVisible();
  await ra.getByLabel(/Justification du retour arrière/).fill("La version 2 supprimait P et K a tort : retour a la version 1");
  const bouton = ra.getByRole("button", { name: "Remettre la version précédente en service" });
  await expect(bouton, "sans confirmation, inactif").toBeDisabled();
  await ra.getByRole("checkbox").check();
  await bouton.click();
  await expect(d.getByTestId("issue-retour")).toContainText("La version 1 est de nouveau autorisée");
  jeux = await jeuxDuProjet(etat.projetId);
  expect(jeux.find((j) => j.id === etat.v1)!.statut).toBe("AUTORISE");
  expect(jeux.find((j) => j.id === etat.v2)!.statut).toBe("REMPLACE");
  expect(await nombreObjetsDuJeu(etat.v1)).toBe(etat.objetsV1);
  expect(await nombreObjetsDuJeu(etat.v2), "la version retiree du service est conservee").toBe(4);
  const api = await ApiVoirie.connecter(gestionnaire);
  const encore = await api.post(`${BASE}/${etat.projetId}/jeux/${etat.v1}/retour-arriere`, { justification: "Un second retour arriere n'a rien a restaurer" });
  expect(encore.statut, "la version 1 ne remplacait rien : pas de retour possible").toBe(409);
  expect(encore.corps.code).toBe("AUCUNE_VERSION_PRECEDENTE");
  await api.fermer();
});

test("KIS-REV-01 : une seconde version du plan d'axes modifie un axe : comparaison, dossiers à réexaminer, verdict conservé, version précédente conservée", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "REV2"));
  const conc = await api.creerConcessionnaire(`Operateur axes ${marqueur}`, "TELECOM");
  const axesV1 = await api.deposerEtAutoriser(projetId, { name: "axes-v1.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  // Reseau L2 (2 m de l'axe A, en chaussee) : le dossier INTERSECTION_CHAUSSEE servira de verdict humain a conserver.
  const reseau: Ligne[] = RESEAU_TELECOM.filter((l) => l.nom === "Fibre-Synth L2" || l.nom === "Fibre-Synth L6" || l.nom === "Fibre-Synth P");
  await api.deposerEtAutoriser(projetId, { name: "reseau.kml", buffer: kml(reseau) }, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });
  const a1 = await api.analyser(projetId);
  expect(a1.statut, a1.texte.slice(0, 200)).toBe(201);
  const liste1 = (await api.get(`${BASE}/${projetId}/conflits?limite=200`)).corps.conflits as Array<{ id: string; cle: string; type: string; objet: { nom: string } | null; statut: string; aReexaminer: boolean }>;
  const cible = liste1.find((c) => c.type === "INTERSECTION_CHAUSSEE" && c.objet?.nom === "Fibre-Synth L2")!;
  expect(cible).toBeTruthy();
  const chemin = `${BASE}/${projetId}/conflits/${cible.id}`;
  await api.post(`${chemin}/preuves`, { type: "NOTE", texte: "Cable observe a 2 m de l'axe lors d'une visite" });
  expect((await api.post(`${chemin}/statut`, { vers: "CONFIRME", justification: "Confirme apres visite de terrain" })).statut).toBe(200);

  // Version 2 du plan : l'axe A est decale de 1 m (le circuit L2 n'est plus qu'a 1 m), l'axe B est inchange.
  const axesDecale = AXES.map((l) => (l.nom === "Axe A" ? { ...l, coords: l.coords.map(([x, y]) => [x, y + 1] as [number, number]) } : l));
  const axesV2 = await api.deposerOk(projetId, { name: "axes-v2.geojson", buffer: geojson(axesDecale) }, { role: "AXES_TRAVAUX" });
  const delta = (await api.get(`${BASE}/${projetId}/jeux/${axesV2}/delta`)).corps;
  expect(delta.delta, "un axe modifie, un identique, rien de retire").toMatchObject({ retires: 0 });
  expect(delta.suppressions.nb).toBe(0);
  const aut = await api.autoriser(projetId, axesV2);
  expect(aut.statut, aut.texte.slice(0, 300)).toBe(200);
  const jeux = await jeuxDuProjet(projetId);
  expect(jeux.find((j) => j.id === axesV1)!.statut, "version precedente conservee").toBe("REMPLACE");
  expect(await nombreObjetsDuJeu(axesV1), "ses objets sont toujours la").toBe(2);

  const a2 = await api.analyser(projetId);
  expect(a2.statut, a2.texte.slice(0, 200)).toBe(201);
  // Comparaison des deux analyses : la modification de l'axe A est visible (modifies ou apparus/disparus), sans conflit inexplique.
  const cmp = await api.get(`${BASE}/${projetId}/analyses/${a2.corps.analyse.id}/comparaison?avec=${a1.corps.analyse.id}`);
  expect(cmp.statut, cmp.texte.slice(0, 300)).toBe(200);
  expect(cmp.corps.modifies.nb + cmp.corps.apparus.nb + cmp.corps.disparus.nb, "la comparaison montre ce qui a change").toBeGreaterThan(0);
  expect(cmp.corps.reference.numero).toBeLessThan(cmp.corps.comparee.numero);
  // Dossiers dependants marques a reexaminer ; le verdict humain (CONFIRME) est conserve.
  const fiche = (await api.get(chemin)).corps;
  expect(fiche.conflit.statut, "un calcul ne modifie jamais un verdict humain").toBe("CONFIRME");
  expect(fiche.conflit.aReexaminer, "dossier dependant de l'axe modifie : a reexaminer").toBe(true);
  expect(["MESURE_MODIFIEE", "NOUVELLE_VERSION_DONNEES"]).toContain(fiche.conflit.motifReexamen);
  expect(fiche.preuves).toHaveLength(1);
  expect(a2.corps.resume.marquesAReexaminer + a2.corps.resume.modifies).toBeGreaterThan(0);
  // Tout dossier marque a reexaminer porte un motif connu (la regle du serveur marque les dossiers dependants du plan modifie, pas seulement ceux
  // dont la mesure change) ; aucun n'est marque sans motif, et aucun statut humain n'a ete touche.
  const toutes = (await api.get(`${BASE}/${projetId}/conflits?limite=200`)).corps.conflits as Array<{ aReexaminer: boolean; motifReexamen: string | null; statut: string }>;
  const marques = toutes.filter((c) => c.aReexaminer);
  expect(marques.length).toBeGreaterThan(0);
  for (const c of marques) expect(["MESURE_MODIFIEE", "NOUVELLE_VERSION_DONNEES", "NON_RETROUVE"], "motif du reexamen").toContain(c.motifReexamen);
  expect(toutes.filter((c) => c.statut === "CONFIRME")).toHaveLength(1);
  await api.fermer();
});

test("KIS-REV-01 : un refus de revue est définitif côté serveur (l'autorisation reste bloquée, l'acceptation tardive est refusée)", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "REV3"));
  const conc = await api.creerConcessionnaire(`Operateur refus ${marqueur}`, "TELECOM");
  const champs = { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" };
  const v1 = await api.deposerEtAutoriser(projetId, { name: "r1.geojson", buffer: geojson(RESEAU_TELECOM) }, champs);
  const v2 = await api.deposerOk(projetId, { name: "r2.geojson", buffer: geojson(RESEAU_TELECOM.slice(0, 4)) }, champs);
  const refus = await api.post(`${BASE}/${projetId}/jeux/${v2}/revue-suppressions`, { decision: "REFUSER", justification: "Les circuits P et K existent toujours sur le terrain" });
  expect(refus.statut, refus.texte.slice(0, 300)).toBe(200);
  const refusee = await api.autoriser(projetId, v2);
  expect(refusee.statut).toBe(409);
  expect(refusee.corps.code).toBe("SUPPRESSIONS_REFUSEES");
  // Regle O1 du serveur : le refus ne se leve pas par une acceptation (409), il faut un fichier corrige.
  const tard = await api.post(`${BASE}/${projetId}/jeux/${v2}/revue-suppressions`, { decision: "ACCEPTER", justification: "Je change d'avis apres le refus" });
  expect(tard.statut).toBe(409);
  expect(tard.corps.code).toBe("SUPPRESSIONS_REFUSEES");
  const jeux = await jeuxDuProjet(projetId);
  expect(jeux.find((j) => j.id === v1)!.statut).toBe("AUTORISE");
  expect(jeux.find((j) => j.id === v2)!.statut).toBe("CONTROLE");
  expect(await nombreObjetsDuJeu(v1), "aucun objet supprime").toBe(6);
  await api.fermer();
});

/**
 * DEFAUT C1-02 (confirme le 08/11/2026, capture de l'echec) : apres un REFUS de revue, l'assistant dit « Une nouvelle revue remplace celle-ci » et propose
 * encore « Accepter les suppressions » (`frontend/src/components/projets-voirie/assistant/EtapeDelta.tsx`, bloc « revue-suppressions »), alors que le
 * serveur refuse toute acceptation apres un refus (`backend/src/projets-voirie/formats/revue-versions.service.ts:127-130`, 409 SUPPRESSIONS_REFUSEES).
 * Le geste aboutit a un message d'erreur au lieu de n'etre pas propose. Ce test decrit le comportement attendu ; suspendu jusqu'a la correction.
 */
test.fixme("DEFAUT C1-02 : après un refus de revue, l'assistant ne propose plus « Accepter les suppressions »", async ({ ouvrirProfil, marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  const projetId = await api.creerProjet(codeProjet(marqueur, "REV4"));
  const conc = await api.creerConcessionnaire(`Operateur C102 ${marqueur}`, "TELECOM");
  const champs = { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" };
  await api.deposerEtAutoriser(projetId, { name: "r1.geojson", buffer: geojson(RESEAU_TELECOM) }, champs);
  const v2 = await api.deposerOk(projetId, { name: "r2.geojson", buffer: geojson(RESEAU_TELECOM.slice(0, 4)) }, champs);
  await api.post(`${BASE}/${projetId}/jeux/${v2}/revue-suppressions`, { decision: "REFUSER", justification: "Les circuits P et K existent toujours sur le terrain" });
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, projetId);
  await page.getByRole("tab", { name: "Couches" }).click();
  await page.getByRole("button", { name: /Versions et suppressions du jeu .*, version 2/ }).click();
  const d = page.getByRole("dialog", { name: "Ajouter des données au projet" });
  await expect(d.getByTestId("revue-suppressions")).toHaveAttribute("data-statut", "REFUSEES");
  await expect(d.getByRole("button", { name: "Accepter les suppressions" })).toHaveCount(0);
  await api.fermer();
});
