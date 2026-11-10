import { requete } from "../lib/base";
import { expect, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, JUSTIFICATION, codeProjet, comptesInterdits, creerCompte, empreinteTroncons, jeuxDuProjet, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_GAZ, RESEAU_TELECOM, geojson, kml } from "../lib/voirie-geo";

/**
 * Workflow concessionnaire, referents et recolement (API ; l'interface du workflow n'existe pas encore dans cette branche) :
 *
 *   - un referent concessionnaire rattache ne voit QUE son concessionnaire et n'agit que dans le workflow (403 ailleurs, 404 masque hors perimetre) ;
 *   - une demande enregistree n'emet AUCUN message (l'application n'envoie rien, elle enregistre ce qu'une personne a fait) ;
 *   - un recolement ne se valide pas par son createur, ni sans preuve ; valider n'ecrit ni dans le referentiel, ni dans un jeu, ni dans un conflit.
 * La correspondance des roles et la matrice des droits sont provisoires, en attente de la decision du DSI (CONTRAT-WORKFLOW.md).
 */

test.describe.configure({ mode: "serial" });

let admin: CompteVoirie;
let gestionnaire: CompteVoirie;
let gestionnaire2: CompteVoirie;
let referentA: CompteVoirie;
let referentB: CompteVoirie;

test.beforeAll(async () => {
  admin = await creerCompte("e2e-wf-admin", "Admin Workflow E2E", "ADMIN", []);
  gestionnaire = await creerCompte("e2e-wf-gest", "Gestionnaire Workflow E2E", "GESTIONNAIRE");
  gestionnaire2 = await creerCompte("e2e-wf-gest2", "Gestionnaire 2 Workflow E2E", "GESTIONNAIRE");
  referentA = await creerCompte("e2e-wf-refa", "Referent A E2E", "LECTEUR");
  referentB = await creerCompte("e2e-wf-refb", "Referent B E2E", "LECTEUR");
});

const etat: {
  projetId: string; autreProjetId: string; concA: string; concB: string; jeuA: string; jeuB: string; conflitA: string; conflitB: string;
  demandeA: string; demandeB: string; brouillonA: string; interdits: Record<string, number>; troncons: string;
} = { projetId: "", autreProjetId: "", concA: "", concB: "", jeuA: "", jeuB: "", conflitA: "", conflitB: "", demandeA: "", demandeB: "", brouillonA: "", interdits: {}, troncons: "" };

const wf = (id = etat.projetId) => `${BASE}/${id}/workflow`;

test("préparation : deux concessionnaires, dossiers confirmés, rattachement des référents par l'administrateur (seul)", async ({ marqueur }) => {
  const g = await ApiVoirie.connecter(gestionnaire);
  const adm = await ApiVoirie.connecter(admin);
  etat.projetId = await g.creerProjet(codeProjet(marqueur, "WF"));
  etat.autreProjetId = await g.creerProjet(codeProjet(marqueur, "WF-AUTRE"));
  etat.concA = await g.creerConcessionnaire(`Telecom A ${marqueur}`, "TELECOM");
  etat.concB = await g.creerConcessionnaire(`Gaz B ${marqueur}`, "GAZ_HYDROCARBURES");
  await g.deposerEtAutoriser(etat.projetId, { name: "axes.kml", buffer: kml(AXES) }, { role: "AXES_TRAVAUX" });
  etat.jeuA = await g.deposerEtAutoriser(etat.projetId, { name: "a.geojson", buffer: geojson(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: etat.concA, classePrecision: "B" });
  // Le reseau B passe a 4 m de l'axe A (dans l'emprise) : il produit lui aussi des dossiers.
  etat.jeuB = await g.deposerEtAutoriser(etat.projetId, { name: "b.geojson", buffer: geojson([{ nom: "Gaz-Synth W", coords: [[20, -4], [80, -4]] }]) }, { role: "RESEAU_TIERS", concessionnaireId: etat.concB, classePrecision: "B" });
  const a = await g.analyser(etat.projetId);
  expect(a.statut).toBe(201);
  const liste = (await g.get(`${BASE}/${etat.projetId}/conflits?limite=200`)).corps.conflits as Array<{ id: string; type: string; concessionnaire: { id: string } | null; objet: { nom: string } | null }>;
  const dossierDe = (conc: string) => liste.find((c) => c.concessionnaire?.id === conc && c.type !== "COUVERTURE_INSUFFISANTE")!;
  etat.conflitA = dossierDe(etat.concA).id;
  etat.conflitB = dossierDe(etat.concB).id;
  expect(etat.conflitA && etat.conflitB).toBeTruthy();
  // Un dossier de chaque concessionnaire est CONFIRME par une personne (le referent ne voit que les dossiers confirmes).
  for (const id of [etat.conflitA, etat.conflitB]) {
    await g.post(`${BASE}/${etat.projetId}/conflits/${id}/preuves`, { type: "NOTE", texte: "Observation de terrain consignee pour l'essai" });
    expect((await g.post(`${BASE}/${etat.projetId}/conflits/${id}/statut`, { vers: "CONFIRME", justification: "Confirme sur releve de terrain" })).statut).toBe(200);
  }
  // Rattachement : seul l'ADMIN le pose (referent.gerer) ; un compte qui n'est pas LECTEUR est refuse.
  const corpsA = { userId: referentA.id, concessionnaireId: etat.concA, motif: "Referent du concessionnaire A pour ce projet" };
  expect((await g.post(`${wf()}/referents`, corpsA)).statut, "un gestionnaire ne rattache pas").toBe(403);
  expect((await adm.post(`${wf()}/referents`, { ...corpsA, userId: gestionnaire.id })).corps.code, "un gestionnaire ne peut pas etre referent").toBe("COMPTE_NON_ELIGIBLE");
  const ra = await adm.post(`${wf()}/referents`, corpsA);
  expect(ra.statut, ra.texte.slice(0, 300)).toBe(201);
  expect((await adm.post(`${wf()}/referents`, corpsA)).corps.code).toBe("RATTACHEMENT_DEJA_ACTIF");
  expect((await adm.post(`${wf()}/referents`, { userId: referentB.id, concessionnaireId: etat.concB, motif: "Referent du concessionnaire B pour ce projet" })).statut).toBe(201);
  // Deux demandes enregistrees : une pour A (envoyee), une pour B (envoyee), plus un brouillon pour A.
  const demande = async (conc: string, objet: string) => (await g.post(`${wf()}/demandes`, { concessionnaireId: conc, objet })).corps.demande.id as string;
  etat.brouillonA = await demande(etat.concA, "Brouillon pour A, jamais envoye");
  etat.demandeA = await demande(etat.concA, "Plan de recolement du reseau A");
  etat.demandeB = await demande(etat.concB, "Profondeur du reseau B");
  etat.interdits = await comptesInterdits();
  etat.troncons = await empreinteTroncons();
  await Promise.all([g.fermer(), adm.fermer()]);
});

test("une demande enregistrée n'émet aucun message : l'application n'envoie rien, elle consigne ce qu'une personne a fait", async () => {
  test.skip(!etat.demandeA, "depend de la preparation");
  const g = await ApiVoirie.connecter(gestionnaire);
  const compter = async () => (await requete<{ n: string }>(`SELECT (SELECT count(*) FROM outbox_evenements) + (SELECT count(*) FROM outbox_tentatives) AS n`))[0].n;
  const sortiesAvant = await compter();
  const avant = (await g.get(`${wf()}/demandes/${etat.demandeA}`)).corps;
  expect(avant.demande.statut).toBe("BROUILLON");
  for (const [vers, corps] of [
    ["ENVOYEE", { canalEnvoi: "courrier papier remis en main propre", dateEnvoi: "2026-11-05", referenceEnvoi: "Bordereau synthetique 12", interlocuteur: "Service technique" }],
  ] as const) {
    const r = await g.post(`${wf()}/demandes/${etat.demandeA}/statut`, { vers, ...corps });
    expect(r.statut, r.texte.slice(0, 300)).toBe(200);
    expect(r.corps.demande.statut).toBe("ENVOYEE");
  }
  expect((await g.post(`${wf()}/demandes/${etat.demandeB}/statut`, { vers: "ENVOYEE", canalEnvoi: "telephone puis courriel", dateEnvoi: "2026-11-05" })).statut).toBe(200);
  // Envoi dans le futur : refuse (on ne consigne pas ce qui n'est pas arrive).
  expect((await g.post(`${wf()}/demandes/${etat.brouillonA}/statut`, { vers: "ENVOYEE", canalEnvoi: "courrier", dateEnvoi: "2099-01-01" })).statut).toBeGreaterThanOrEqual(400);
  // Aucun evenement sortant n'a ete empile, aucune tentative d'envoi n'a ete faite.
  expect(await compter(), "aucun message n'est emis par l'enregistrement d'une demande").toBe(sortiesAvant);
  const histo = (await g.get(`${wf()}/demandes/${etat.demandeA}`)).corps;
  expect(histo.historique.map((h: { nouveauStatut: string }) => h.nouveauStatut)).toEqual(expect.arrayContaining(["ENVOYEE"]));
  expect(histo.demande.envoi, "ce qu'une personne a fait est consigne : date, canal, reference").toMatchObject({ dateEnvoi: "2026-11-05", canal: "courrier papier remis en main propre", reference: "Bordereau synthetique 12" });
  // La reception d'une reponse ne modifie ni un jeu, ni le referentiel : le jeu recu reste ce qu'il etait.
  const jeuxAvant = await jeuxDuProjet(etat.projetId);
  const recue = await g.post(`${wf()}/demandes/${etat.demandeA}/statut`, { vers: "RECUE", dateReception: "2026-11-06", jeuRecuId: etat.jeuA, note: "Reponse reçue par courrier" });
  expect(recue.statut, recue.texte.slice(0, 300)).toBe(200);
  expect(await jeuxDuProjet(etat.projetId), "recevoir une reponse ne change aucun jeu").toEqual(jeuxAvant);
  expect(await comptesInterdits()).toEqual(etat.interdits);
  await g.fermer();
});

test("un référent rattaché ne voit que son concessionnaire et n'agit que dans le workflow", async () => {
  test.skip(!etat.demandeA, "depend de la preparation");
  const ra = await ApiVoirie.connecter(referentA);
  const rb = await ApiVoirie.connecter(referentB);
  const p = (await ra.get(`${BASE}/workflow/mon-profil`)).corps;
  expect(p.profil).toBe("REFERENT");
  expect(p.provisoire, "la matrice des droits est provisoire, en attente du DSI").toBe(true);
  expect(p.rattachements.map((r: { concessionnaire: { id: string } }) => r.concessionnaire.id)).toEqual([etat.concA]);

  // Jeux : seulement ceux de A, sans geometrie ni empreinte.
  const jeux = await ra.get(`${wf()}/jeux`);
  expect(jeux.statut).toBe(200);
  expect(jeux.corps.jeux.map((j: { id: string }) => j.id)).toEqual([etat.jeuA]);
  expect(JSON.stringify(jeux.corps)).not.toMatch(/sha256|geometrie|coordinates/);
  // Dossiers : seulement ceux de A, confirmes, vue concessionnaire (ni geometrie ni mesure).
  const conflits = await ra.get(`${wf()}/conflits`);
  expect(conflits.corps.conflits.map((c: { id: string }) => c.id)).toEqual([etat.conflitA]);
  expect(JSON.stringify(conflits.corps)).not.toMatch(/geometrie|mesure|coordinates|responsable/);
  const confB = await rb.get(`${wf()}/conflits`);
  expect(confB.corps.conflits.map((c: { id: string }) => c.id)).toEqual([etat.conflitB]);
  // Demandes : celle de A (envoyee), jamais le brouillon ni la demande de B ; detail d'une demande de B : 404 masque.
  const demandes = (await ra.get(`${wf()}/demandes`)).corps.demandes.map((d: { id: string }) => d.id);
  expect(demandes).toContain(etat.demandeA);
  expect(demandes).not.toContain(etat.demandeB);
  expect(demandes).not.toContain(etat.brouillonA);
  const hors = await ra.get(`${wf()}/demandes/${etat.demandeB}`);
  expect(hors.statut).toBe(404);
  expect(hors.corps.code).toBe("DEMANDE_INTROUVABLE");
  expect((await ra.get(`${wf()}/demandes/${etat.brouillonA}`)).statut, "un brouillon n'est pas visible du referent").toBe(404);
  expect((await ra.get(`${wf()}/demandes/${etat.demandeA}`)).statut).toBe(200);
  // Une preuve partagee sur sa propre demande : permise ; sur la demande d'un autre concessionnaire : 404.
  const preuve = await ra.post(`${wf()}/demandes/${etat.demandeA}/preuves`, { type: "REPONSE_CONCESSIONNAIRE", texte: "Plan de recolement transmis par le concessionnaire", reference: "Courrier synthetique 7" });
  expect(preuve.statut, preuve.texte.slice(0, 300)).toBe(201);
  expect((await ra.post(`${wf()}/demandes/${etat.demandeB}/preuves`, { type: "NOTE", texte: "Je ne devrais pas pouvoir" })).statut).toBe(404);
  // Pas de creation de demande, de tache, de recolement ni de rattachement : droit absent (403 ACTION_NON_AUTORISEE).
  for (const [u, corps] of [[`${wf()}/demandes`, { concessionnaireId: etat.concA, objet: "Je ne devrais pas pouvoir" }], [`${wf()}/taches`, { titre: "Interdit", responsableId: referentA.id }],
    [`${wf()}/recolements`, { conflitId: etat.conflitA, objet: "Interdit" }], [`${wf()}/referents`, { userId: referentB.id, concessionnaireId: etat.concA, motif: "Je ne devrais pas pouvoir" }]] as const) {
    const r = await ra.post(u, corps);
    expect(r.statut, `POST ${u.replace(etat.projetId, ":id")}`).toBe(403);
  }

  // Confine au workflow : AUCUNE route du socle, de l'analyse, des conflits, du reseau, ni du journal d'audit (403 COMPTE_REFERENT_RESTREINT).
  for (const u of [`${BASE}`, `${BASE}/${etat.projetId}`, `${BASE}/${etat.projetId}/jeux`, `${BASE}/${etat.projetId}/carte?jeux=${etat.jeuA}`, `${BASE}/${etat.projetId}/analyse`,
    `${BASE}/${etat.projetId}/conflits`, `${BASE}/${etat.projetId}/conflits/${etat.conflitA}`, `${BASE}/${etat.projetId}/reseau/objets`, `${BASE}/${etat.projetId}/reseau/comptage`,
    `${BASE}/concessionnaires`, `/api/audit?entityType=JeuDonneesProjet&entityId=${etat.jeuA}`]) {
    const r = await ra.get(u);
    expect(r.statut, `GET ${u.replace(etat.projetId, ":id")} par un referent`).toBe(403);
    expect(r.corps.code, `GET ${u.replace(etat.projetId, ":id")}`).toBe("COMPTE_REFERENT_RESTREINT");
  }
  expect((await ra.post(`${BASE}/${etat.projetId}/analyses`, {})).corps.code).toBe("COMPTE_REFERENT_RESTREINT");
  // Un projet ou il n'est pas rattache : 404 masque, comme un projet inexistant.
  const autre = await ra.get(`${wf(etat.autreProjetId)}/jeux`);
  const inconnu = await ra.get(`${wf("00000000-0000-4000-8000-0000000000ee")}/jeux`);
  expect(autre.statut).toBe(404);
  expect(autre.corps, "meme reponse qu'un projet inexistant").toEqual(inconnu.corps);
  await Promise.all([ra.fermer(), rb.fermer()]);
});

test("un récolement ne se valide pas par son créateur, ni sans preuve ; valider n'écrit ni dans le référentiel, ni dans un jeu, ni dans le conflit", async () => {
  test.skip(!etat.conflitA, "depend de la preparation");
  const g = await ApiVoirie.connecter(gestionnaire);
  const g2 = await ApiVoirie.connecter(gestionnaire2);
  const adm = await ApiVoirie.connecter(admin);
  const cflt = `${BASE}/${etat.projetId}/conflits/${etat.conflitA}`;
  // Un deplacement decide : responsable, planning, decision proposee par g, approuvee par g2, traitement decide.
  expect((await g.patch(cflt, { responsableId: gestionnaire2.id })).statut).toBe(200);
  const prop = await g.post(`${cflt}/decisions`, { option: "DEPLACER_RESEAU", justification: "Le reseau A est dans la chaussee prevue", dateDebutPrevue: "2027-02-01", dateFinPrevue: "2027-02-15" });
  expect(prop.statut, prop.texte.slice(0, 300)).toBe(201);
  expect((await g2.post(`${cflt}/decisions/${prop.corps.decision.id}/approuver`, { motif: "Approuvee par le second gestionnaire" })).statut).toBe(200);
  expect((await g.post(`${cflt}/statut`, { vers: "TRAITEMENT_DECIDE", justification: "Decision approuvee, deplacement a realiser" })).statut).toBe(200);

  // Un recolement n'existe que pour un conflit dont un deplacement est decide.
  const rec = await g.post(`${wf()}/recolements`, { conflitId: etat.conflitA, objet: "Recolement du reseau A deplace", constat: "Reseau reporte a 9 m de l'axe, hors chaussee", dateRecolement: "2026-11-06" });
  expect(rec.statut, rec.texte.slice(0, 300)).toBe(201);
  const rid = rec.corps.recolement.id as string;
  const statut = (c: ApiVoirie, vers: string, extra: object = {}) => c.post(`${wf()}/recolements/${rid}/statut`, { vers, justification: JUSTIFICATION, ...extra });
  expect((await statut(g, "SOUMIS")).statut).toBe(200);
  // Sans preuve (autre qu'une simple note) : valider est refuse meme par l'ADMIN tiers.
  const sansPreuve = await statut(adm, "VALIDE");
  expect(sansPreuve.statut).toBe(409);
  expect(sansPreuve.corps.code).toBe("PREUVE_REQUISE");
  expect((await g.post(`${wf()}/recolements/${rid}/preuves`, { type: "NOTE", texte: "Une simple note ne suffit pas a valider" })).statut).toBe(201);
  expect((await statut(adm, "VALIDE")).corps.code, "une note seule n'est pas une preuve suffisante").toBe("PREUVE_REQUISE");
  expect((await g.post(`${wf()}/recolements/${rid}/preuves`, { type: "REFERENCE_DOCUMENT", texte: "Plan de recolement signe", reference: "PR-2027-02", sha256: "a".repeat(64) })).statut).toBe(201);

  // Le createur (gestionnaire) ne valide pas : la matrice reserve la validation a l'ADMIN (403) ; un second gestionnaire non plus.
  const parCreateur = await statut(g, "VALIDE");
  expect(parCreateur.statut).toBe(403);
  expect(parCreateur.corps.code).toBe("ACTION_NON_AUTORISEE");
  expect((await statut(g2, "VALIDE")).statut).toBe(403);
  const avant = { jeux: await jeuxDuProjet(etat.projetId), interdits: await comptesInterdits(), troncons: await empreinteTroncons(), conflit: (await g.get(cflt)).corps.conflit.statut };
  expect(avant.conflit).toBe("TRAITEMENT_DECIDE");
  // Un ADMIN qui a lui-meme cree puis soumis un recolement ne le valide pas sans derogation motivee.
  const recAdmin = await adm.post(`${wf()}/recolements`, { conflitId: etat.conflitA, objet: "Recolement cree par l'administrateur", constat: "Constat de l'administrateur" });
  // Un seul recolement en cours par conflit : le premier doit etre ecarte avant (retrait au brouillon), sinon 409.
  expect([201, 409]).toContain(recAdmin.statut);
  if (recAdmin.statut === 409) expect(recAdmin.corps.code).toBe("RECOLEMENT_EN_COURS");

  // Un tiers (ADMIN, ni createur ni auteur de la soumission) valide : c'est le chemin normal.
  const ok = await statut(adm, "VALIDE");
  expect(ok.statut, ok.texte.slice(0, 300)).toBe(200);
  expect(ok.corps.recolement.statut).toBe("VALIDE");
  // Valider un recolement n'ecrit ni dans le referentiel, ni dans un jeu, ni dans le conflit.
  const apres = { jeux: await jeuxDuProjet(etat.projetId), interdits: await comptesInterdits(), troncons: await empreinteTroncons(), conflit: (await g.get(cflt)).corps.conflit.statut };
  expect(apres, "aucune ecriture hors du recolement").toEqual(avant);
  // Un recolement valide ne se corrige pas.
  expect((await g.patch(`${wf()}/recolements/${rid}`, { constat: "Je corrige apres validation", justification: JUSTIFICATION })).statut).toBeGreaterThanOrEqual(400);
  // Cloture du dossier appuyee sur ce recolement valide : plus besoin de la mention.
  const cloture = await adm.post(`${cflt}/statut`, { vers: "CLOTURE", justification: "Deplacement realise et recolement valide", recolementId: rid });
  expect(cloture.statut, cloture.texte.slice(0, 300)).toBe(200);
  expect(await comptesInterdits(), "meme la cloture ne cree aucun ordre").toEqual(etat.interdits);
  await Promise.all([g.fermer(), g2.fermer(), adm.fermer()]);
});

test("séparation des tâches : l'ADMIN créateur et soumetteur d'un récolement ne le valide pas sans dérogation motivée", async ({ marqueur }) => {
  const g = await ApiVoirie.connecter(gestionnaire);
  const adm = await ApiVoirie.connecter(admin);
  const projetId = await g.creerProjet(codeProjet(marqueur, "WF-SEP"));
  const conc = await g.creerConcessionnaire(`Reseau ${marqueur}`, "TELECOM");
  const jeu = await g.deposerEtAutoriser(projetId, { name: "plan-recolement.kml", buffer: kml(RESEAU_GAZ) }, { role: "RESEAU_TIERS", concessionnaireId: conc });
  // Recolement lie a un jeu recu (plan de recolement depose par le socle) : creer, soumettre, prouver, puis valider par la meme personne.
  const w = `${BASE}/${projetId}/workflow/recolements`;
  const rec = await adm.post(w, { jeuId: jeu, objet: "Plan de recolement recu", constat: "Plan conforme au deplacement decide" });
  expect(rec.statut, rec.texte.slice(0, 300)).toBe(201);
  const rid = rec.corps.recolement.id as string;
  expect((await adm.post(`${w}/${rid}/statut`, { vers: "SOUMIS", justification: JUSTIFICATION })).statut).toBe(200);
  expect((await adm.post(`${w}/${rid}/preuves`, { type: "REFERENCE_DOCUMENT", texte: "Plan signe par le concessionnaire", reference: "PR-9", sha256: "b".repeat(64) })).statut).toBe(201);
  const seul = await adm.post(`${w}/${rid}/statut`, { vers: "VALIDE", justification: JUSTIFICATION });
  expect(seul.statut, "le createur ne valide pas son propre recolement").toBe(409);
  expect(seul.corps.code).toBe("SEPARATION_DES_TACHES");
  expect((await adm.get(`${w}/${rid}`)).corps.recolement.statut, "toujours soumis").toBe("SOUMIS");
  const derog = await adm.post(`${w}/${rid}/statut`, { vers: "VALIDE", justification: JUSTIFICATION, derogation: "Seul administrateur disponible pendant la mission de terrain" });
  expect(derog.statut, derog.texte.slice(0, 300)).toBe(200);
  const hist = (await adm.get(`${w}/${rid}`)).corps.historique as Array<{ nouveauStatut: string; donnees: Record<string, unknown> }>;
  expect(JSON.stringify(hist), "la derogation est inscrite dans l'historique").toContain("Seul administrateur disponible");
  await Promise.all([g.fermer(), adm.fermer()]);
});
