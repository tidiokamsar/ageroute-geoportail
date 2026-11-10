import { requete } from "../lib/base";
import { expect, test } from "../lib/fixtures";
import {
  ApiVoirie, BASE, auditDe, codeProjet, creerCompte, dwgSynthetique, pdfSynthetique, sha256, type CompteVoirie,
} from "../lib/voirie";
import { AXES, RESEAU_TELECOM, geojson } from "../lib/voirie-geo";

/**
 * Lot C1 bis, scenario d : completude documentaire (CONTRAT-DOCUMENTS.md ; decision architecturale 2, sections 6 et 7).
 *
 * L'interface ne porte PAS d'ecran des documents (lot UI-C : « Documents du projet et completude (D1) : hors perimetre ») : le scenario est couvert
 * par l'API, de bout en bout contre la vraie base. Il prouve :
 *   - des documents ATTENDUS (sans piece) ; une reference PDF deposee (empreinte, jamais une geometrie) ; un DWG conserve comme document NON exploitable ;
 *   - la separation des taches a la validation (le deposant ne valide pas) ;
 *   - « ce que les documents permettent » : aucune piece manquante ne bloque une fonction qui n'en depend pas (l'analyse tourne malgre les pieces
 *     attendues et le DWG inexploitable) ;
 *   - un lecteur ne voit que les documents VALIDE.
 * Pieces 100 % synthetiques (lib/voirie.ts : PDF d'une page vide, DWG reduit a sa signature).
 */

test.describe.configure({ mode: "serial" });

const UUID_INCONNU = "00000000-0000-4000-8000-0000000000dc";
let g1: CompteVoirie;
let g2: CompteVoirie;
let lecteur: CompteVoirie;

const etat = { projetId: "", attenduAxes: "", attenduReseau: "", pdf: "", dwg: "" };
const PDF = pdfSynthetique("Plan d'axes signe synthetique");
const DWG = dwgSynthetique();
type Fonction = { code: string; etat: string; conditions: Array<{ code: string; remplie: boolean }> };

test.beforeAll(async () => {
  g1 = await creerCompte("e2e-doc-g1", "Gestionnaire deposant C1bis", "GESTIONNAIRE");
  g2 = await creerCompte("e2e-doc-g2", "Gestionnaire valideur C1bis", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-doc-lect", "Lecteur documents C1bis", "LECTEUR");
});

const etatDe = (fonctions: Fonction[], code: string) => fonctions.find((f) => f.code === code)?.etat;

test("d. projet vide : rien n'est disponible sauf l'export, chaque pièce manquante dit ce qu'elle débloquerait", async ({ marqueur }) => {
  const g = await ApiVoirie.connecter(g1);
  const vide = await g.creerProjet(codeProjet(marqueur, "DOC-VIDE"));
  const c = await g.get(`${BASE}/${vide}/completude`);
  expect(c.statut, c.texte.slice(0, 300)).toBe(200);
  const f = c.corps.fonctions as Fonction[];
  expect(etatDe(f, "ANALYSE_2D")).toBe("INDISPONIBLE");
  expect(etatDe(f, "CONFLITS")).toBe("INDISPONIBLE");
  expect(etatDe(f, "COMPARAISON_SOURCES")).toBe("INDISPONIBLE");
  expect(etatDe(f, "RECOLEMENT")).toBe("INDISPONIBLE");
  expect(etatDe(f, "EXPORT_DOSSIER"), "l'export ne depend d'aucune piece (lot X1)").toBe("DISPONIBLE");
  const codes = (c.corps.piecesManquantes as Array<{ nature: string; code?: string; fonctions: string[]; suffiraitPour: string[] }>).filter((p) => p.nature === "CONDITION");
  const axes = codes.find((p) => p.code === "PLAN_AXES_AUTORISE")!;
  expect(axes.fonctions).toEqual(expect.arrayContaining(["ANALYSE_2D", "CONFLITS"]));
  expect(axes.suffiraitPour, "le plan d'axes seul ne suffit pas : il faut aussi un reseau").toEqual([]);
  await g.fermer();
});

test("d. documents attendus, référence PDF, DWG non exploitable ; l'import refuse PDF et DWG comme géométrie", async ({ marqueur }) => {
  const g = await ApiVoirie.connecter(g1);
  etat.projetId = await g.creerProjet(codeProjet(marqueur, "DOC"));
  const p = `${BASE}/${etat.projetId}`;
  const conc = await g.creerConcessionnaire(`Operateur synthetique DOC ${marqueur}`, "TELECOM");
  await g.deposerEtAutoriser(etat.projetId, { name: "axes-doc.geojson", buffer: geojson(AXES) }, { role: "AXES_TRAVAUX" });
  await g.deposerEtAutoriser(etat.projetId, { name: "reseau-doc.geojson", buffer: geojson(RESEAU_TELECOM) }, { role: "RESEAU_TIERS", concessionnaireId: conc, classePrecision: "B" });

  // Deux pieces ATTENDUES (aucune piece) : types du referentiel TYPE_DOCUMENT (donnees, pas du code).
  const a1 = await g.post(`${p}/documents`, { typeCode: "PLAN_AXES", titre: "Plan d'axes signe (attendu)" });
  expect(a1.statut, a1.texte.slice(0, 300)).toBe(201);
  expect(a1.corps.document).toMatchObject({ statut: "ATTENDU", typeCode: "PLAN_AXES", version: 1 });
  etat.attenduAxes = a1.corps.document.id;
  const a2 = await g.post(`${p}/documents`, { typeCode: "RESEAU_CONCESSIONNAIRE", titre: "Plan de recolement du reseau (attendu)", concessionnaireId: conc });
  expect(a2.statut).toBe(201);
  etat.attenduReseau = a2.corps.document.id;

  // Reference PDF deposee sur la piece attendue : empreinte et taille, jamais le fichier ; avertissement « reference ».
  const dp = await g.multipart(`${p}/documents/${etat.attenduAxes}/depot`, { name: "plan-axes-signe.pdf", buffer: PDF, mimeType: "application/pdf" }, { reference: "Courrier synthetique n. 001" });
  expect(dp.statut, dp.texte.slice(0, 300)).toBe(200);
  expect(dp.corps.document).toMatchObject({ statut: "RECU", piece: { format: "PDF", sha256: sha256(PDF), tailleOctets: PDF.length, reference: "Courrier synthetique n. 001" } });
  expect(dp.corps.avertissements.map((a: { code: string }) => a.code)).toContain("PDF_REFERENCE");
  etat.pdf = etat.attenduAxes;

  // DWG : conserve comme document RECU, jamais exploitable (aucun convertisseur).
  const dw = await g.multipart(`${p}/documents`, { name: "plan-axes-bureau-etudes.dwg", buffer: DWG }, { typeCode: "AUTRE", titre: "Plan DWG du bureau d'etudes synthetique" });
  expect(dw.statut, dw.texte.slice(0, 300)).toBe(201);
  expect(dw.corps.document).toMatchObject({ statut: "RECU", piece: { format: "DWG", sha256: sha256(DWG) }, exploitable: { possible: false } });
  expect(dw.corps.avertissements.map((a: { code: string }) => a.code)).toContain("DWG_NON_EXPLOITABLE");
  etat.dwg = dw.corps.document.id;
  expect((await g.post(`${p}/documents/${etat.dwg}/statut`, { statut: "EN_ANALYSE" })).statut).toBe(200);
  const nonExpl = await g.post(`${p}/documents/${etat.dwg}/statut`, { statut: "EXPLOITABLE" });
  expect(nonExpl.statut).toBe(409);
  expect(nonExpl.corps.code).toBe("DOCUMENT_NON_EXPLOITABLE");
  // Aucun fichier binaire stocke : la table ne porte que l'empreinte (aucune colonne d'octets).
  const colonnes = await requete<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'documents_projet_voirie' AND data_type = 'bytea'`);
  expect(colonnes, "aucune colonne de contenu de fichier").toEqual([]);

  // A l'import, un PDF n'est jamais une geometrie (422) et un DWG n'est pas lu (415) : rien n'est depose.
  const avant = (await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_jeux WHERE "projetId" = $1`, [etat.projetId]))[0].n;
  const ipdf = await g.deposer(etat.projetId, { name: "plan.pdf", buffer: PDF }, { role: "AXES_TRAVAUX" });
  expect(ipdf.statut).toBe(422);
  expect(ipdf.corps.code).toBe("CONTENU_NON_RECONNU");
  const idwg = await g.deposer(etat.projetId, { name: "plan.dwg", buffer: DWG }, { role: "AXES_TRAVAUX" });
  expect(idwg.statut).toBe(415);
  expect(idwg.corps.code).toBe("FORMAT_NON_SUPPORTE");
  expect((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_jeux WHERE "projetId" = $1`, [etat.projetId]))[0].n).toBe(avant);
  // Un contenu qui n'est ni PDF ni DWG n'est pas une piece de document.
  const autre = await g.multipart(`${p}/documents`, { name: "plan.pdf", buffer: Buffer.from("ceci n'est pas un PDF") }, { typeCode: "AUTRE", titre: "Faux PDF" });
  expect(autre.statut).toBe(415);
  expect(autre.corps.code).toBe("FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE");
  await g.fermer();
});

test("d. séparation des tâches : le déposant ne valide pas sa pièce ; une autre personne la valide ; historique écrit par la base", async () => {
  test.skip(!etat.pdf, "depend des documents");
  const p = `${BASE}/${etat.projetId}`;
  const a = await ApiVoirie.connecter(g1);
  const b = await ApiVoirie.connecter(g2);
  expect((await a.post(`${p}/documents/${etat.pdf}/statut`, { statut: "EN_ANALYSE" })).statut).toBe(200);
  expect((await a.post(`${p}/documents/${etat.pdf}/statut`, { statut: "EXPLOITABLE" })).statut).toBe(200);
  const sienne = await a.post(`${p}/documents/${etat.pdf}/statut`, { statut: "VALIDE", justification: "Je valide ma propre piece" });
  expect(sienne.statut).toBe(409);
  expect(sienne.corps.code).toBe("SEPARATION_DES_TACHES");
  const courte = await b.post(`${p}/documents/${etat.pdf}/statut`, { statut: "VALIDE", justification: "ok" });
  expect(courte.statut, "justification de 10 caracteres au moins").toBe(400);
  const ok = await b.post(`${p}/documents/${etat.pdf}/statut`, { statut: "VALIDE", justification: "Plan signe conforme au marche synthetique" });
  expect(ok.statut, ok.texte.slice(0, 300)).toBe(200);
  expect(ok.corps.document).toMatchObject({ statut: "VALIDE", validePar: { id: g2.id }, deposePar: { id: g1.id } });
  const base = await requete<{ depose: string; valide: string }>(`SELECT "deposeParId" AS depose, "valideParId" AS valide FROM documents_projet_voirie WHERE id = $1`, [etat.pdf]);
  expect(base[0]).toEqual({ depose: g1.id, valide: g2.id });
  // Transition hors matrice : refusee avec les possibles.
  const hors = await b.post(`${p}/documents/${etat.dwg}/statut`, { statut: "VALIDE", justification: "Un DWG ne se valide jamais" });
  expect(hors.statut).toBe(409);
  const fiche = await b.get(`${p}/documents/${etat.pdf}`);
  expect(fiche.corps.historique.map((h: { action: string }) => h.action), "historique ecrit par la base, ajout seul").toEqual(expect.arrayContaining(["CREATION", "DEPOT", "STATUT"]));
  const audit = await auditDe("DocumentProjetVoirie", etat.pdf);
  expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["CREATE", "UPDATE", "VALIDATE"]));
  expect(JSON.stringify(audit), "audit sans contenu de fichier").not.toContain(PDF.toString("base64").slice(0, 24));
  await Promise.all([a.fermer(), b.fermer()]);
});

test("d. ce que les documents permettent : aucune pièce manquante ne bloque l'analyse ; un lecteur ne voit que les documents validés", async () => {
  test.skip(!etat.pdf, "depend des documents");
  const p = `${BASE}/${etat.projetId}`;
  const g = await ApiVoirie.connecter(g1);
  const c = (await g.get(`${p}/completude`)).corps;
  const f = c.fonctions as Fonction[];
  expect(etatDe(f, "ANALYSE_2D"), "pieces attendues et DWG inexploitable ne bloquent pas l'analyse 2D").toBe("DISPONIBLE");
  expect(etatDe(f, "CONFLITS")).toBe("DISPONIBLE");
  expect(etatDe(f, "COMPARAISON_SOURCES"), "une seule source : indisponible").toBe("INDISPONIBLE");
  expect(etatDe(f, "EXPORT_DOSSIER")).toBe("DISPONIBLE");
  const manquantes = c.piecesManquantes as Array<{ nature: string; code?: string; fonctions: string[]; suffiraitPour?: string[]; document?: { id: string } }>;
  const seconde = manquantes.find((m) => m.nature === "CONDITION" && m.code === "SECONDE_SOURCE")!;
  expect(seconde.suffiraitPour).toEqual(["COMPARAISON_SOURCES"]);
  // Le document attendu du reseau est une piece manquante pour le decideur, et il ne rend indisponible aucune fonction deja disponible.
  const attendu = manquantes.find((m) => m.nature === "DOCUMENT" && m.document?.id === etat.attenduReseau);
  expect(attendu, "le document attendu est liste pour le decideur").toBeTruthy();
  for (const code of attendu!.fonctions) expect(etatDe(f, code)).not.toBe("DISPONIBLE");
  // Preuve par l'action : l'analyse persistee tourne, avec les pieces manquantes.
  const r = await g.analyser(etat.projetId);
  expect(r.statut, r.texte.slice(0, 300)).toBe(201);

  // Lecteur : seulement le PDF VALIDE ; le DWG, la piece attendue : 404 identiques a l'inexistant.
  const l = await ApiVoirie.connecter(lecteur);
  const docs = (await l.get(`${p}/documents`)).corps.documents as Array<{ id: string; statut: string }>;
  expect(docs.map((d) => [d.id, d.statut])).toEqual([[etat.pdf, "VALIDE"]]);
  const inconnu = await l.get(`${p}/documents/${UUID_INCONNU}`);
  for (const id of [etat.dwg, etat.attenduReseau]) {
    const r2 = await l.get(`${p}/documents/${id}`);
    expect(r2.statut).toBe(404);
    expect(r2.corps).toEqual(inconnu.corps);
  }
  const cl = (await l.get(`${p}/completude`)).corps;
  expect(cl.documents.total, "un lecteur ne compte que les documents valides").toBe(1);
  expect((cl.piecesManquantes as Array<{ nature: string }>).filter((m) => m.nature === "DOCUMENT"), "aucune piece en cours pour un lecteur").toEqual([]);
  // Un lecteur n'ecrit aucun document.
  expect((await l.post(`${p}/documents`, { typeCode: "AUTRE", titre: "Interdit" })).statut).toBe(403);
  expect((await l.post(`${p}/documents/${etat.dwg}/statut`, { statut: "REJETE", justification: "Je ne devrais pas pouvoir" })).statut).toBe(403);
  await Promise.all([g.fermer(), l.fermer()]);
});
