import { expect, seConnecter, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, JUSTIFICATION, auditDe, codeProjet, comptesInterdits, creerCompte, empreinteTroncons, exigerAccessible, jeuxDuProjet, ouvrirProjet, type CompteVoirie,
} from "../lib/voirie";
import { AXES, AXE_ISOLE, RESEAU_GAZ, RESEAU_TELECOM, geojson, kml } from "../lib/voirie-geo";
import { requete } from "../lib/base";

/**
 * KIS-CLASH-01 (cahier 22.3, AT-05 a AT-09, AT-13, AT-14) : l'analyse de conflits, ses dossiers et leurs decisions.
 *
 *   - les jeux sont autorises (justification, role habilite) ; l'analyse est lancee DANS LE NAVIGATEUR ; les dossiers portent mesure, regle, statut ;
 *   - un axe qu'aucun reseau ne couvre donne « a investiguer » (zone a investiguer), jamais « pas de reseau » ;
 *   - un conflit confirme avec decision de deplacement exige un responsable et un planning ;
 *   - la separation des taches empeche la meme personne d'approuver sa propre decision (sans derogation valable) ;
 *   - rejouer l'analyse ne change aucun verdict humain ;
 *   - aucun bouton, aucune route ne cree d'ordre de deplacement ni de travaux : les comptes des tables d'execution ne bougent pas.
 */

test.describe.configure({ mode: "serial" });

let admin: CompteVoirie;
let gestionnaire: CompteVoirie;
let gestionnaire2: CompteVoirie;
let lecteur: CompteVoirie;
test.beforeAll(async () => {
  admin = await creerCompte("e2e-clash-admin", "Admin Conflits E2E", "ADMIN", []);
  gestionnaire = await creerCompte("e2e-clash-gest", "Gestionnaire Conflits E2E", "GESTIONNAIRE");
  gestionnaire2 = await creerCompte("e2e-clash-gest2", "Gestionnaire 2 Conflits E2E", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-clash-lect", "Lecteur Conflits E2E", "LECTEUR");
});

interface Dossier {
  id: string; cle: string; type: string; axe: string; statut: string; aReexaminer: boolean; verticalEvalue: boolean; classePrecision: string | null;
  responsable: { id: string } | null; objet: { id: string; nom: string } | null; mesure: Record<string, number | null>;
}

const etat: {
  projetId: string; code: string; nom: string; nomTelecom: string; jeuTelecom: string; jeuAxes: string; jeuGaz: string;
  interdits: Record<string, number>; troncons: string; dossiers: Dossier[]; cible?: Dossier;
} = { projetId: "", code: "", nom: "", nomTelecom: "", jeuTelecom: "", jeuAxes: "", jeuGaz: "", interdits: {}, troncons: "", dossiers: [] };

async function dossiers(api: ApiVoirie, projetId: string): Promise<Dossier[]> {
  const r = await api.get(`${BASE}/${projetId}/conflits?limite=200`);
  expect(r.statut, r.texte.slice(0, 300)).toBe(200);
  return r.corps.conflits as Dossier[];
}

test("préparation : trois jeux déposés en quarantaine ; le réseau est autorisé par un gestionnaire dans l'interface (justification obligatoire)", async ({ ouvrirProfil, marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  etat.code = codeProjet(marqueur, "CLASH");
  etat.nom = `Projet ${etat.code}`;
  etat.projetId = await api.creerProjet(etat.code);
  etat.interdits = await comptesInterdits();
  etat.troncons = await empreinteTroncons();
  etat.nomTelecom = `Telecom ${marqueur}`;
  const telecom = await api.creerConcessionnaire(etat.nomTelecom, "TELECOM");
  const gaz = await api.creerConcessionnaire(`Gaz ${marqueur}`, "GAZ_HYDROCARBURES");
  etat.jeuAxes = await api.deposerOk(etat.projetId, { name: "axes.kml", buffer: kml([...AXES, AXE_ISOLE]) }, { role: "AXES_TRAVAUX" });
  etat.jeuTelecom = await api.deposerOk(etat.projetId, { name: "telecom.geojson", buffer: geojson(RESEAU_TELECOM) },
    { role: "RESEAU_TIERS", concessionnaireId: telecom, classePrecision: "B", precisionHorizontaleM: "3.5", origineFichier: "essai synthetique" });
  etat.jeuGaz = await api.deposerOk(etat.projetId, { name: "gaz.kml", buffer: kml(RESEAU_GAZ) }, { role: "RESEAU_TIERS", concessionnaireId: gaz, classePrecision: "A" });
  for (const j of await jeuxDuProjet(etat.projetId)) expect(j.statut).toBe("CONTROLE");

  // Aucune analyse possible tant que rien n'est autorise : la quarantaine ne compte pas.
  const vide = await api.analyser(etat.projetId);
  expect(vide.statut, vide.texte.slice(0, 200)).toBe(201);
  expect(vide.corps.analyse.nbConflitsTrouves, "aucun jeu autorise : aucun conflit").toBe(0);

  // Role habilite : un lecteur ne peut pas autoriser (403) ; le gestionnaire le fait dans le navigateur.
  const l = await ApiVoirie.connecter(lecteur);
  expect((await l.autoriser(etat.projetId, etat.jeuTelecom)).statut).toBe(403);
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Couches" }).click();
  await page.getByRole("button", { name: `Autoriser le jeu ${etat.nomTelecom}, version 1` }).click();
  const dialogue = page.getByRole("dialog", { name: "Autoriser ce jeu de données" });
  const valider = dialogue.getByRole("button", { name: "Autoriser le jeu" });
  await expect(valider, "sans justification, le bouton est inactif").toBeDisabled();
  await dialogue.getByLabel(/Justification/).fill("trop bref");
  await expect(valider).toBeDisabled();
  await dialogue.getByLabel(/Justification/).fill("Controle effectue avec le chef de projet");
  await valider.click();
  await expect(dialogue).toBeHidden();
  const jeuxApres = await jeuxDuProjet(etat.projetId);
  expect(jeuxApres.find((j) => j.id === etat.jeuTelecom)!.statut).toBe("AUTORISE");
  const audit = (await auditDe("JeuDonneesProjet", etat.jeuTelecom)).filter((a) => a.action === "VALIDATE");
  expect(audit, "l'autorisation est auditee, avec son auteur").toHaveLength(1);
  expect(audit[0].userId).toBe(gestionnaire.id);
  expect(JSON.stringify(audit[0].after)).toContain("Controle effectue avec le chef de projet");
  // Les deux autres jeux sont autorises par l'API (meme regle, meme justification).
  for (const id of [etat.jeuAxes, etat.jeuGaz]) expect((await api.autoriser(etat.projetId, id)).statut).toBe(200);
  await Promise.all([api.fermer(), l.fermer()]);
});

test("KIS-CLASH-01 : l'analyse est lancée dans le navigateur ; chaque dossier porte mesure, règle et statut ; un axe sans réseau est « à investiguer »", async ({ ouvrirProfil }) => {
  test.skip(!etat.projetId, "depend de la preparation");
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Conflits" }).click();
  const garde = page.getByTestId("bandeau-garde-fous");
  await expect(garde).toBeVisible();
  await expect(garde).toContainText(/ordre|déplacement|aide à la décision|signal/i);
  await page.getByRole("button", { name: "Lancer une analyse" }).click();
  const fin = page.getByTestId("analyse-terminee");
  // Le calcul est fait cote serveur (PostGIS) : large plafond, la machine de test est souvent chargee.
  await expect(fin).toBeVisible({ timeout: 180_000 });
  await expect(fin).toContainText("Aucun verdict humain n'a été modifié");

  const api = await ApiVoirie.connecter(gestionnaire);
  etat.dossiers = await dossiers(api, etat.projetId);
  expect(etat.dossiers.length, "des dossiers ont ete crees").toBeGreaterThan(3);
  const types = new Set(etat.dossiers.map((d) => d.type));
  for (const t of ["INTERSECTION_CHAUSSEE", "INTERSECTION_EMPRISE", "TRAVERSEE", "COUVERTURE_INSUFFISANTE"]) expect(types, `type ${t}`).toContain(t);
  for (const d of etat.dossiers) {
    expect(["POTENTIEL", "A_INVESTIGUER"], `statut initial de ${d.type} / ${d.axe} : un calcul ne produit jamais un verdict humain`).toContain(d.statut);
    expect(d.verticalEvalue, "profondeur et altitude absentes : aucun conflit 3D").toBe(false);
  }
  // Mesure, regle, versions et sources d'une fiche complete (une intersection de chaussee).
  const chaussee = etat.dossiers.find((d) => d.type === "INTERSECTION_CHAUSSEE" && d.objet?.nom === "Fibre-Synth L2")!;
  expect(chaussee, "le circuit L2, a 2 m de l'axe A, est en chaussee").toBeTruthy();
  expect(chaussee.statut).toBe("POTENTIEL");
  const fiche = (await api.get(`${BASE}/${etat.projetId}/conflits/${chaussee.id}`)).corps;
  expect(fiche.conflit.mesure.longueurChausseeM, "60 m de L2 sont dans la chaussee").toBeGreaterThan(59);
  expect(fiche.conflit.mesure.longueurChausseeM).toBeLessThan(61);
  expect(fiche.regle).toMatchObject({ code: "RC-2D-0.1", version: 0 });
  expect(fiche.sources.map((s: { role: string }) => s.role).sort()).toEqual(["AXES_TRAVAUX", "RESEAU_TIERS"]);
  expect(fiche.sources.every((s: { sha256: string; version: number }) => /^[0-9a-f]{64}$/.test(s.sha256) && s.version === 1)).toBe(true);
  expect(fiche.avertissements.join(" ")).toMatch(/aucun déplacement n'est décidé ni ordonné/);

  // Axe sans reseau : B (150 m) et C (isole) ne sont contenus dans l'emprise d'aucun reseau.
  const couverture = etat.dossiers.filter((d) => d.type === "COUVERTURE_INSUFFISANTE");
  expect(couverture.map((d) => d.axe).sort()).toEqual(["Axe B", "Axe C"]);
  for (const c of couverture) expect(c.statut, "zone a investiguer").toBe("A_INVESTIGUER");
  expect(etat.dossiers.some((d) => d.type === "COUVERTURE_INSUFFISANTE" && d.axe === "Axe A"), "l'axe A est couvert par le reseau de gaz").toBe(false);
  expect(JSON.stringify(etat.dossiers)).not.toMatch(/AUCUN_RESEAU|PAS_DE_RESEAU|ABSENCE_RESEAU/i);

  // Dans l'interface : le dossier de couverture dit « zone a investiguer », jamais « pas de reseau ».
  const coverture = couverture.find((c) => c.axe === "Axe C")!;
  await page.locator(`button[data-conflit-id="${coverture.id}"]`).click();
  const ficheUi = page.getByTestId("fiche-conflit");
  await expect(ficheUi).toBeVisible();
  await expect(ficheUi.getByRole("heading", { name: "Couverture insuffisante : Axe C" })).toBeVisible();
  await expect(ficheUi).toContainText("zone à investiguer, jamais une preuve d'absence de réseau");
  await expect(ficheUi).toContainText("À investiguer");
  const texte = (await ficheUi.innerText()).toLowerCase();
  expect(texte).not.toMatch(/pas de réseau|aucun réseau (n'existe|détecté)|réseau absent|sans réseau/);
  // Vertical : mention explicite, jamais de conflit 3D affirme.
  await expect(ficheUi.getByTestId("mention-vertical")).not.toHaveText("Évalué");
  // Aucun bouton ne cree d'ordre, de deplacement ni de travaux.
  const interdit = /ordonner|exécuter|executer|ordre de (déplacement|travaux)|créer un ordre|lancer les travaux|déplacer maintenant/i;
  await expect(page.getByRole("button", { name: interdit })).toHaveCount(0);
  await expect(page.getByRole("link", { name: interdit })).toHaveCount(0);
  await api.fermer();
});

test("KIS-CLASH-01 : une décision de déplacement exige un responsable et un planning ; la séparation des tâches l'empêche d'être approuvée par son auteur", async ({ marqueur }) => {
  test.skip(etat.dossiers.length === 0, "depend de l'analyse");
  const g1 = await ApiVoirie.connecter(gestionnaire);
  const g2 = await ApiVoirie.connecter(gestionnaire2);
  const adm = await ApiVoirie.connecter(admin);
  const cible = etat.dossiers.find((d) => d.type === "INTERSECTION_CHAUSSEE" && d.objet?.nom === "Fibre-Synth L2")!;
  etat.cible = cible;
  const base = `${BASE}/${etat.projetId}/conflits/${cible.id}`;

  // Une decision ne se propose que pour un conflit CONFIRME : le passage de POTENTIEL a CONFIRME exige une preuve et une justification.
  const tropTot = await g1.post(`${base}/decisions`, { option: "PROTEGER", justification: JUSTIFICATION });
  expect(tropTot.statut, "decision proposee pour un conflit encore potentiel").toBe(409);
  expect((await g1.post(`${base}/statut`, { vers: "CONFIRME", justification: JUSTIFICATION })).corps.code, "sans preuve").toBe("PREUVE_REQUISE");
  expect((await g1.post(`${base}/statut`, { vers: "CONFIRME", justification: "court" })).statut).toBe(422);
  expect((await g1.post(`${base}/preuves`, { type: "RELEVE_TERRAIN", texte: "Cable observe a 2 m de l'axe lors du releve de terrain", reference: "Releve synthetique 1" })).statut).toBe(201);
  const conf = await g1.post(`${base}/statut`, { vers: "CONFIRME", justification: "Confirme sur releve de terrain et courrier de l'operateur" });
  expect(conf.statut, conf.texte.slice(0, 300)).toBe(200);

  // Deplacement : responsable, puis planning.
  const sansResp = await g1.post(`${base}/decisions`, { option: "DEPLACER_RESEAU", justification: "Le cable est dans la chaussee prevue", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" });
  expect(sansResp.statut).toBe(422);
  expect(sansResp.corps.code).toBe("RESPONSABLE_REQUIS");
  expect((await g1.patch(base, { responsableId: gestionnaire2.id, echeance: "2027-03-01" })).statut).toBe(200);
  const sansPlanning = await g1.post(`${base}/decisions`, { option: "DEPLACER_RESEAU", justification: "Le cable est dans la chaussee prevue" });
  expect(sansPlanning.statut).toBe(422);
  expect(sansPlanning.corps.code).toBe("PLANNING_REQUIS");
  const inverse = await g1.post(`${base}/decisions`, { option: "DEPLACER_RESEAU", justification: "Le cable est dans la chaussee prevue", dateDebutPrevue: "2027-01-20", dateFinPrevue: "2027-01-10" });
  expect(inverse.corps.code, "dates inversees").toBe("PLANNING_REQUIS");
  const prop = await g1.post(`${base}/decisions`, { option: "DEPLACER_RESEAU", justification: "Le cable est dans la chaussee prevue", dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20", coutEstime: 1500000, deviseCout: "GNF" });
  expect(prop.statut, prop.texte.slice(0, 300)).toBe(201);
  expect(prop.corps.decision).toMatchObject({ option: "DEPLACER_RESEAU", statut: "PROPOSEE", coutReel: null });
  const did = prop.corps.decision.id as string;
  // Le responsable ne peut plus etre retire tant qu'un deplacement est propose.
  expect((await g1.patch(base, { responsableId: null })).corps.code).toBe("RESPONSABLE_REQUIS");

  // Separation des taches : l'auteur ne tranche pas sa decision ; une derogation de non-admin ne vaut rien pour un deplacement.
  const seul = await g1.post(`${base}/decisions/${did}/approuver`, { motif: "Je l'approuve moi-meme sans derogation" });
  expect(seul.statut).toBe(409);
  expect(seul.corps.code).toBe("SEPARATION_DES_TACHES");
  const derogNonAdmin = await g1.post(`${base}/decisions/${did}/approuver`, { motif: "Je l'approuve moi-meme avec derogation", derogation: "Absence de mon collegue pendant la semaine" });
  expect(derogNonAdmin.statut, "deplacement : seule la derogation d'un ADMIN est admise").toBe(409);
  expect(derogNonAdmin.corps.code).toBe("SEPARATION_DES_TACHES");
  const avantApprobation = await g1.get(`${base}`);
  expect(avantApprobation.corps.conflit.statut).toBe("CONFIRME");
  expect(avantApprobation.corps.decisions[0].statut, "la decision n'a pas bouge").toBe("PROPOSEE");
  // Un autre gestionnaire habilite tranche : c'est une personne differente.
  const ok = await g2.post(`${base}/decisions/${did}/approuver`, { motif: "Decision approuvee par un second gestionnaire" });
  expect(ok.statut, ok.texte.slice(0, 300)).toBe(200);
  expect(ok.corps.decision).toMatchObject({ statut: "APPROUVEE" });
  expect(ok.corps.decision.approuvePar.id).toBe(gestionnaire2.id);
  // Une decision tranchee ne change plus.
  expect((await g2.post(`${base}/decisions/${did}/refuser`, { motif: "Je change d'avis apres coup" })).corps.code).toBe("DECISION_DEJA_TRANCHEE");

  // Traitement decide, puis cloture : reservee a l'ADMIN, avec la mention du recolement.
  expect((await g1.post(`${base}/statut`, { vers: "TRAITEMENT_DECIDE", justification: "Decision approuvee par le second gestionnaire" })).statut).toBe(200);
  expect((await g1.post(`${base}/statut`, { vers: "CLOTURE", justification: "Je cloture sans etre administrateur" })).statut).toBe(403);
  const sansMention = await adm.post(`${base}/statut`, { vers: "CLOTURE", justification: "Cloture par l'administrateur" });
  expect(sansMention.statut).toBe(422);
  expect(sansMention.corps.code, "un deplacement decide ne se cloture pas sans mention du recolement").toBe("MENTION_RECOLEMENT_REQUISE");
  // Ce que le systeme n'a PAS fait : aucun ordre, aucun chantier, aucune ecriture dans le referentiel.
  expect(await comptesInterdits()).toEqual(etat.interdits);
  expect(await empreinteTroncons()).toBe(etat.troncons);
  await Promise.all([g1.fermer(), g2.fermer(), adm.fermer()]);
  void marqueur;
});

test("KIS-CLASH-01 : aucune route ne crée d'ordre de déplacement ni de travaux", async () => {
  test.skip(!etat.cible, "depend du dossier decide");
  const g1 = await ApiVoirie.connecter(gestionnaire);
  const adm = await ApiVoirie.connecter(admin);
  const base = `${BASE}/${etat.projetId}/conflits/${etat.cible!.id}`;
  for (const c of [g1, adm]) {
    for (const suffixe of ["ordre", "ordres", "deplacer", "deplacement", "executer", "ordonner", "ordre-de-travaux", "travaux"]) {
      expect((await c.post(`${base}/${suffixe}`, {})).statut, `POST .../${suffixe}`).toBe(404);
      expect((await c.post(`${BASE}/${etat.projetId}/${suffixe}`, {})).statut).toBe(404);
    }
    // Un statut ou une option que le contrat ne connait pas est refuse, jamais cree.
    expect((await c.post(`${base}/statut`, { vers: "ORDRE_EMIS", justification: JUSTIFICATION })).statut).toBe(400);
    expect((await c.post(`${base}/decisions`, { option: "EXECUTER_DEPLACEMENT", justification: JUSTIFICATION })).statut).toBe(400);
  }
  expect(await comptesInterdits()).toEqual(etat.interdits);
  await Promise.all([g1.fermer(), adm.fermer()]);
});

test("KIS-CLASH-01 : rejouer l'analyse ne change aucun verdict humain (statut, responsable, preuve, décision)", async ({ ouvrirProfil }) => {
  test.skip(!etat.cible, "depend du dossier decide");
  const g1 = await ApiVoirie.connecter(gestionnaire);
  const instantane = async () => {
    const liste = await dossiers(g1, etat.projetId);
    const fiche = (await g1.get(`${BASE}/${etat.projetId}/conflits/${etat.cible!.id}`)).corps;
    return {
      statuts: liste.map((d) => `${d.cle}:${d.statut}`).sort(),
      cible: { statut: fiche.conflit.statut, responsable: fiche.conflit.responsable?.id, echeance: fiche.conflit.echeance, preuves: fiche.preuves.map((p: { id: string }) => p.id), decisions: fiche.decisions.map((d: { id: string; statut: string; approuvePar: { id: string } | null }) => `${d.id}:${d.statut}:${d.approuvePar?.id}`) },
    };
  };
  const avant = await instantane();
  expect(avant.cible.statut).toBe("TRAITEMENT_DECIDE");
  const nbAvant = Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM conflits_projet WHERE "projetId" = $1`, [etat.projetId]))[0].n);

  // La cadence : une analyse tout de suite apres une analyse terminee est refusee (429), sans rien ecrire.
  const a1 = await g1.analyser(etat.projetId);
  expect(a1.statut, a1.texte.slice(0, 200)).toBe(201);
  const trop = await g1.post(`${BASE}/${etat.projetId}/analyses`, {});
  expect(trop.statut, "deux analyses terminees a moins de 3 s d'ecart").toBe(429);
  expect(trop.corps.code).toBe("ANALYSE_TROP_FREQUENTE");
  expect(Number(trop.entetes["retry-after"])).toBeGreaterThan(0);
  expect(trop.corps.retryAfterS).toBeGreaterThan(0);

  const apres = await instantane();
  expect(apres, "aucun verdict humain n'a bouge").toEqual(avant);
  expect(Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM conflits_projet WHERE "projetId" = $1`, [etat.projetId]))[0].n), "pas de doublon de dossier").toBe(nbAvant);
  expect(a1.corps.resume.nouveaux, "rien de nouveau : memes entrees").toBe(0);
  expect(a1.corps.resume.disparus).toBe(0);
  expect(a1.corps.resume.marquesAReexaminer, "rien a reexaminer").toBe(0);
  // La base refuse aussi, hors API, qu'un calcul modifie un verdict : UPDATE direct du statut d'un dossier clos ou decide passe par la contrainte du lot ;
  // ici on verifie seulement que le calcul n'a laisse aucune ligne d'historique de statut a son nom.
  const lignes = await requete<{ n: string }>(
    `SELECT count(*)::text AS n FROM conflits_projet_historique h WHERE h."conflitId" = $1 AND h.action = 'STATUT' AND h."acteurId" IS NULL`, [etat.cible!.id]);
  expect(lignes[0].n, "aucun changement de statut sans acteur humain").toBe("0");

  // Interface : la liste montre le verdict conserve (statut « Traitement decide »).
  const { page } = await ouvrirProfil();
  await seConnecter(page, gestionnaire);
  await ouvrirProjet(page, etat.projetId, etat.nom);
  await page.getByRole("tab", { name: "Conflits" }).click();
  await page.locator(`button[data-conflit-id="${etat.cible!.id}"]`).click();
  const ficheUi = page.getByTestId("fiche-conflit");
  await expect(ficheUi).toContainText("Traitement décidé");
  await expect(ficheUi).toContainText("Déplacer le réseau (proposition)");
  await expect(ficheUi).toContainText("Approuvée");
  await exigerAccessible(page, "fiche d'un dossier de conflit", { racine: '[data-testid="fiche-conflit"]' });
  await g1.fermer();
});
