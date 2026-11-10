import { beforeEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), put: vi.fn(), delete: h.del } }));

import { OngletDocuments } from "./OngletDocuments";
import { violationsAccessibilite } from "../../../test/accessibilite";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";

/**
 * Onglet « Documents » (lot D1, interface UI-D). Donnees 100 % SYNTHETIQUES (aucun nom de ville, de concessionnaire ni de coordonnee reels).
 * On verifie, sur du contenu CHARGE : les roles (un lecteur ne voit aucun bouton d'ecriture, contre-epreuve ADMIN), la separation des taches (VALIDE
 * jamais propose au deposant, explique), la matrice du serveur (rien n'est deduit), creation, depot, version, statut et retrait, DWG et PDF, filtres et
 * curseur, ce que les documents permettent (independance, troncature), les erreurs typees, le hors ligne et l'accessibilite (axe).
 */

configure({ asyncUtilTimeout: 8000 });
const B = "/v2/projets-voirie/p1";
const MOI = "u-moi";

const doc = (id: string, over: Record<string, unknown> = {}) => ({
  id, projetId: "p1", ligneeId: id, version: 1, remplaceId: null, typeCode: "PLAN_AXES", type: { code: "PLAN_AXES", libelle: "Plan d'axes", actif: true },
  titre: `Piece ${id}`, description: null, dateDocument: "2026-10-30", concessionnaire: null, statut: "EXPLOITABLE",
  piece: { reference: "REF-SYNTH", nomFichier: "plan-synthetique.pdf", format: "PDF", sha256: "b".repeat(64), tailleOctets: 4096, jeuLie: false },
  jeu: null, exploitable: { possible: true, raison: null }, aide: "Un PDF est une piece de reference.", creePar: { id: "u-auteur", nomComplet: "Auteur Test" }, createdAt: "2026-11-01T08:00:00Z",
  deposePar: { id: "u-auteur", nomComplet: "Auteur Test" }, deposeLe: "2026-11-01T08:00:00Z", validePar: null, valideLe: null,
  derniereAction: { par: { id: "u-auteur", nomComplet: "Auteur Test" }, le: "2026-11-01T08:00:00Z", justification: null },
  transitionsPossibles: ["VALIDE", "A_CORRIGER", "REJETE"], ...over,
});
const sansDecideur = (d: Record<string, unknown>) => { const { transitionsPossibles: _t, ...r } = d; void _t; return { ...r, derniereAction: { ...(d.derniereAction as object), justification: null } }; };

const COMPLETUDE = {
  projetId: "p1", calculeLe: "2026-11-10T07:00:00Z",
  fonctions: [
    { code: "ANALYSE_2D", libelle: "x", etat: "DISPONIBLE", conditions: [{ code: "PLAN_AXES_AUTORISE", remplie: true, nb: 1 }, { code: "RESEAU_AUTORISE", remplie: true, nb: 2 }] },
    { code: "COMPARAISON_SOURCES", etat: "INDISPONIBLE", conditions: [{ code: "DEUX_SOURCES_MEME_RESEAU", remplie: false, nb: 0 }] },
    { code: "RECOLEMENT", etat: "INDISPONIBLE", conditions: [{ code: "DECISION_DEPLACEMENT", remplie: false, nb: 0 }] },
    { code: "EXPORT_DOSSIER", etat: "DISPONIBLE", conditions: [] },
    { code: "FONCTION_FUTURE", libelle: "Fonction future", etat: "NON_LIVREE", conditions: [] },
  ],
  reseaux: [], documents: { total: 3, parStatut: { VALIDE: 1, ATTENDU: 2 } }, regle: "r",
  piecesManquantes: [
    { nature: "CONDITION", code: "SECONDE_SOURCE", libelle: "x", reseau: { concessionnaire: "Operateur Synthetique", typeReseau: "TELECOM" }, fonctions: ["COMPARAISON_SOURCES"], suffiraitPour: ["COMPARAISON_SOURCES"], typesDocument: [{ code: "RESEAU_CONCESSIONNAIRE", libelle: "Plan de réseau" }] },
    { nature: "CONDITION", code: "DECISION_DEPLACEMENT", libelle: "x", reseau: null, fonctions: ["RECOLEMENT"], suffiraitPour: ["RECOLEMENT"], typesDocument: [] },
    { nature: "TYPE_OBLIGATOIRE", typeDocument: { code: "PV_RECEPTION", libelle: "Procès-verbal de réception" }, roleJeu: null, fonctions: [], suffiraitPour: [] },
  ],
};

interface Etat { documents: unknown[]; suivant: string | null; fiches: Record<string, unknown>; completude: unknown; erreurs: Record<string, unknown> }
let e: Etat;

function installer() {
  h.get.mockImplementation(async (url: string, cfg: { params?: Record<string, string> } = {}) => {
    const err = e.erreurs[url];
    if (err) { delete e.erreurs[url]; throw err; }
    if (url === `${B}/documents`) return { data: { documents: cfg.params?.curseur ? [doc("d9", { titre: "Piece de la page 2" })] : e.documents, curseurSuivant: cfg.params?.curseur ? null : e.suivant } };
    if (url.startsWith(`${B}/documents/`)) return { data: e.fiches[url.slice(`${B}/documents/`.length)] };
    if (url === `${B}/completude`) return { data: e.completude };
    if (url === "/v2/projets-voirie/referentiels/TYPE_DOCUMENT") return { data: { valeurs: [
      { id: "t1", domaine: "TYPE_DOCUMENT", code: "PLAN_AXES", libelle: "Plan d'axes", actif: true, parametres: {} },
      { id: "t2", domaine: "TYPE_DOCUMENT", code: "ANCIEN", libelle: "Ancien type", actif: false, parametres: {} },
    ] } };
    if (url === "/v2/projets-voirie/concessionnaires") return { data: [{ id: "c1", nom: "Operateur Synthetique", typeReseau: "TELECOM" }] };
    return { data: {} };
  });
}

const JEUX = [
  { id: "j-axes", nomFichier: "axes-synth.geojson", role: "AXES_TRAVAUX", version: 2, statut: "AUTORISE", confidentialite: "RESTREINT_PROJET" },
  { id: "j-retire", nomFichier: "retire.geojson", role: "AXES_TRAVAUX", version: 1, statut: "RETIRE", confidentialite: "RESTREINT_PROJET" },
] as unknown as JeuProjet[];

function rendre(p: { role?: string; enLigne?: boolean } = {}) {
  const role = p.role ?? "GESTIONNAIRE";
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletDocuments projetId="p1" actif peutEcrire={role === "ADMIN" || role === "GESTIONNAIRE"} role={role} compteId={MOI} enLigne={p.enLigne ?? true} jeux={JEUX} /></QueryClientProvider>);
}

async function ouvrirFiche(u: ReturnType<typeof userEvent.setup>, titre: string) {
  const art = await screen.findByRole("article", { name: new RegExp(`^${titre}, version`) });
  await u.click(within(art).getByRole("button", { name: /Ouvrir la fiche/ }));
  const fiche = await screen.findByRole("region", { name: titre });
  // Contenu CHARGE de la fiche (le statut vient de GET /documents/:docId), pas seulement son titre.
  await within(fiche).findByText("Empreinte SHA-256");
  return fiche;
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.del.mockReset();
  e = {
    documents: [doc("d1"), doc("d2", { statut: "ATTENDU", piece: { reference: null, nomFichier: null, format: null, sha256: null, tailleOctets: null, jeuLie: false }, deposePar: null, deposeLe: null, transitionsPossibles: [] })],
    suivant: null,
    fiches: {
      d1: { document: doc("d1"), versions: [{ id: "d1", version: 1, statut: "EXPLOITABLE", createdAt: "2026-11-01T08:00:00Z" }], versionsTronquees: false, historique: [{ id: 1, documentId: "d1", version: 1, action: "CREATION", statutAvant: null, statutApres: "RECU", par: { id: "u-auteur", nomComplet: "Auteur Test" }, justification: null, details: {}, le: "2026-11-01T08:00:00Z" }], historiqueTronque: false },
      d2: { document: doc("d2", { statut: "ATTENDU", piece: { reference: null, nomFichier: null, format: null, sha256: "c".repeat(64), tailleOctets: null, jeuLie: false }, transitionsPossibles: [] }), versions: [], historique: [] },
    },
    completude: COMPLETUDE,
    erreurs: {},
  };
  installer();
});

describe("roles : sur du contenu charge", () => {
  it("lecteur : documents VALIDE seulement, AUCUN bouton d'ecriture, ni filtre de statut, ni historique", async () => {
    const valide = sansDecideur(doc("d1", { statut: "VALIDE", validePar: { id: "u-v", nomComplet: "Valideur" }, valideLe: "2026-11-03T00:00:00Z" }));
    e.documents = [valide];
    e.fiches.d1 = { document: valide, versions: [{ id: "d1", version: 1, statut: "VALIDE", createdAt: "2026-11-01" }], versionsTronquees: false };
    const u = userEvent.setup();
    rendre({ role: "LECTEUR" });
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(within(fiche).getAllByText("Validé", { selector: "[data-statut-document]" }).length).toBeGreaterThan(0);
    for (const nom of [/Nouveau document/, /^Valider$/, /Nouvelle version/, /Déposer/, /Retirer/, /Rejeter/, /correction/]) expect(screen.queryByRole("button", { name: nom })).toBeNull();
    expect(screen.queryByTestId("gestes-document")).toBeNull();
    expect(screen.queryByRole("group", { name: /Statuts/ })).toBeNull();
    expect(within(fiche).queryByText(/Historique de la lignée/)).toBeNull();
    expect(screen.getByText(/Seules les pièces validées sont visibles/)).toBeInTheDocument();
  });
  it("contre-epreuve ADMIN : memes donnees, les boutons d'ecriture sont la", async () => {
    const u = userEvent.setup();
    rendre({ role: "ADMIN" });
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(screen.getByRole("button", { name: /Nouveau document/ })).toBeInTheDocument();
    expect(within(fiche).getByRole("button", { name: "Valider" })).toBeInTheDocument();
    expect(within(fiche).getByRole("button", { name: /Nouvelle version/ })).toBeInTheDocument();
    expect(within(fiche).getByRole("button", { name: /Retirer/ })).toBeInTheDocument();
    expect(within(fiche).getByText(/Historique de la lignée/)).toBeInTheDocument();
  });
  it("GESTIONNAIRE : pas de retrait d'une piece VALIDE (ADMIN seulement), explique", async () => {
    e.fiches.d1 = { ...(e.fiches.d1 as object), document: doc("d1", { statut: "VALIDE", transitionsPossibles: [] }) };
    const u = userEvent.setup();
    rendre({ role: "GESTIONNAIRE" });
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(within(fiche).queryByRole("button", { name: /Retirer/ })).toBeNull();
    expect(within(fiche).getByText(/réservé à un administrateur/)).toBeInTheDocument();
  });
});

describe("separation des taches et matrice du serveur", () => {
  it("le deposant ne se voit jamais proposer VALIDE, avec l'explication", async () => {
    e.fiches.d1 = { ...(e.fiches.d1 as object), document: doc("d1", { deposePar: { id: MOI, nomComplet: "Moi" } }) };
    const u = userEvent.setup();
    rendre();
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(within(fiche).queryByRole("button", { name: "Valider" })).toBeNull();
    expect(within(fiche).getByTestId("ecartee-VALIDE")).toHaveTextContent(/vous avez déposé cette pièce.*séparation des tâches/);
    expect(within(fiche).getByRole("button", { name: "Demander une correction" })).toBeInTheDocument();
  });
  it("une autre personne valide : justification de 10 caracteres exigee, corps { statut, justification }", async () => {
    h.post.mockResolvedValue({ data: { document: doc("d1", { statut: "VALIDE", transitionsPossibles: [] }) } });
    const u = userEvent.setup();
    rendre();
    const fiche = await ouvrirFiche(u, "Piece d1");
    await u.click(within(fiche).getByRole("button", { name: "Valider" }));
    const d = await screen.findByRole("dialog", { name: "Valider" });
    expect(within(d).getByRole("button", { name: "Valider" })).toBeDisabled();
    await u.type(within(d).getByLabelText("Justification"), "Pièce conforme au cahier");
    await u.click(within(d).getByRole("button", { name: "Valider" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/documents/d1/statut`, { statut: "VALIDE", justification: "Pièce conforme au cahier" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("409 SEPARATION_DES_TACHES et 409 TRANSITION_INTERDITE : expliques, le dialogue reste ouvert", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { code: "SEPARATION_DES_TACHES" } } }).mockRejectedValueOnce({ response: { status: 409, data: { code: "TRANSITION_INTERDITE", de: "EXPLOITABLE", vers: "VALIDE", possibles: [] } } });
    const u = userEvent.setup();
    rendre();
    const fiche = await ouvrirFiche(u, "Piece d1");
    await u.click(within(fiche).getByRole("button", { name: "Valider" }));
    const d = await screen.findByRole("dialog");
    await u.type(within(d).getByLabelText("Justification"), "Justification suffisante");
    await u.click(within(d).getByRole("button", { name: "Valider" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/ne la valide pas/);
    await u.click(within(d).getByRole("button", { name: "Valider" }));
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/Rechargez la fiche/));
  });
  it("DWG : ni EXPLOITABLE ni VALIDE proposes, aide a l'export DXF affichee", async () => {
    e.fiches.d1 = { ...(e.fiches.d1 as object), document: doc("d1", { statut: "EN_ANALYSE", piece: { reference: null, nomFichier: "plan.dwg", format: "DWG", sha256: "d".repeat(64), tailleOctets: 10, jeuLie: false }, exploitable: { possible: false, raison: "DWG_NON_EXPLOITABLE" }, aide: "Exportez le dessin en DXF ASCII.", transitionsPossibles: ["EXPLOITABLE", "INCOMPLET", "A_CORRIGER", "REJETE"] }) };
    const u = userEvent.setup();
    rendre();
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(within(fiche).queryByRole("button", { name: "Déclarer exploitable" })).toBeNull();
    expect(within(fiche).getByTestId("ecartee-EXPLOITABLE")).toHaveTextContent(/DXF/);
    expect(within(fiche).getByTestId("aide-format")).toHaveTextContent(/DWG non exploitable.*DXF/);
  });
});

describe("ecritures", () => {
  it("creation d'un document attendu : JSON, aucun champ vide envoye", async () => {
    h.post.mockResolvedValue({ data: { document: doc("d3", { statut: "ATTENDU" }), avertissements: [] } });
    e.fiches.d3 = e.fiches.d1;
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(screen.getByRole("button", { name: /Nouveau document/ }));
    const d = await screen.findByRole("dialog", { name: "Nouveau document du dossier" });
    // Un type desactive n'est pas propose a la creation.
    expect(within(d).queryByRole("option", { name: "Ancien type" })).toBeNull();
    await u.selectOptions(within(d).getByLabelText("Type de document"), "PLAN_AXES");
    await u.type(within(d).getByLabelText("Titre"), "Plan d'axes attendu");
    await u.click(within(d).getByRole("button", { name: "Créer le document" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/documents`, { typeCode: "PLAN_AXES", titre: "Plan d'axes attendu" }));
  });
  it("creation avec un fichier DWG : multipart (champ fichier), aide DXF avant l'envoi, avertissement DWG apres", async () => {
    h.post.mockResolvedValue({ data: { document: doc("d3", { statut: "RECU" }), avertissements: [{ code: "DWG_NON_EXPLOITABLE", message: "Le DWG n'est jamais exploitable : exportez-le en DXF." }] } });
    e.fiches.d3 = e.fiches.d1;
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(screen.getByRole("button", { name: /Nouveau document/ }));
    const d = await screen.findByRole("dialog");
    await u.selectOptions(within(d).getByLabelText("Type de document"), "PLAN_AXES");
    await u.type(within(d).getByLabelText("Titre"), "Plan DWG");
    await u.click(within(d).getByLabelText("Un fichier PDF ou DWG"));
    await u.upload(within(d).getByLabelText(/Fichier PDF ou DWG/), new File(["AC1027 synthetique"], "plan.dwg", { type: "application/octet-stream" }));
    expect(within(d).getByTestId("aide-dwg")).toHaveTextContent(/ne devient jamais exploitable ni validé/);
    expect(within(d).getByText(/il n'est conservé ni en base, ni sur disque, ni sur cet appareil/)).toBeInTheDocument();
    await u.click(within(d).getByRole("button", { name: "Créer le document" }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    const corps = h.post.mock.calls[0][1] as FormData;
    expect(corps).toBeInstanceOf(FormData);
    expect((corps.get("fichier") as File).name).toBe("plan.dwg");
    expect(corps.get("typeCode")).toBe("PLAN_AXES");
    expect(corps.get("jeuId")).toBeNull();
    expect(await screen.findByTestId("avertissements-depot")).toHaveTextContent(/exportez-le en DXF/);
  });
  it("PDF : explique comme piece de reference", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(screen.getByRole("button", { name: /Nouveau document/ }));
    const d = await screen.findByRole("dialog");
    await u.click(within(d).getByLabelText("Un fichier PDF ou DWG"));
    await u.upload(within(d).getByLabelText(/Fichier PDF ou DWG/), new File(["%PDF-1.4"], "note.pdf", { type: "application/pdf" }));
    expect(within(d).getByTestId("aide-pdf")).toHaveTextContent(/pièce de référence.*jamais importé comme géométrie/);
  });
  it("413, 415, 400 et 503 a la creation : expliques, le dialogue reste ouvert", async () => {
    h.post
      .mockRejectedValueOnce({ response: { status: 413, data: { code: "FICHIER_TROP_GROS" } } })
      .mockRejectedValueOnce({ response: { status: 415, data: { code: "FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE" } } })
      .mockRejectedValueOnce({ response: { status: 400, data: { code: "TYPE_DOCUMENT_INCONNU" } } })
      .mockRejectedValueOnce({ response: { status: 503, data: { code: "SERVICE_OCCUPE", retryAfterS: 4 }, headers: {} } });
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(screen.getByRole("button", { name: /Nouveau document/ }));
    const d = await screen.findByRole("dialog");
    await u.selectOptions(within(d).getByLabelText("Type de document"), "PLAN_AXES");
    await u.type(within(d).getByLabelText("Titre"), "Plan");
    const valider = within(d).getByRole("button", { name: "Créer le document" });
    await u.click(valider);
    expect(await within(d).findByRole("alert")).toHaveTextContent(/25 Mo/);
    await u.click(valider);
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/ni un PDF ni un DWG/));
    await u.click(valider);
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/type actif/));
    await u.click(valider);
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/4 secondes/));
  });
  it("depot d'une piece sur un document attendu : reference seule, route depot", async () => {
    h.post.mockResolvedValue({ data: { document: doc("d2", { statut: "RECU" }), avertissements: [] } });
    const u = userEvent.setup();
    rendre();
    const art = await screen.findByRole("article", { name: /^Piece d2/ });
    await u.click(within(art).getByRole("button", { name: /Ouvrir la fiche/ }));
    const fiche = await screen.findByRole("region", { name: "Piece d2" });
    await u.click(await within(fiche).findByRole("button", { name: /Déposer la pièce/ }));
    const d = await screen.findByRole("dialog", { name: "Déposer la pièce" });
    await u.type(within(d).getByLabelText("Référence"), "COURRIER-2026-001");
    await u.click(within(d).getByRole("button", { name: "Déposer la pièce" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${B}/documents/d2/depot`, { reference: "COURRIER-2026-001" }));
  });
  it("nouvelle version liee a un jeu du projet (jamais un jeu retire) ; 409 VERSION_NON_COURANTE explique", async () => {
    h.post.mockRejectedValueOnce({ response: { status: 409, data: { code: "VERSION_NON_COURANTE" } } }).mockResolvedValueOnce({ data: { document: doc("d1b", { version: 2, statut: "RECU" }), remplace: { id: "d1", version: 1, statut: "REMPLACE" }, avertissements: [{ code: "JEU_NON_AUTORISE", message: "Le jeu lie est en CONTROLE." }] } });
    e.fiches.d1b = e.fiches.d1;
    const u = userEvent.setup();
    rendre();
    const fiche = await ouvrirFiche(u, "Piece d1");
    await u.click(within(fiche).getByRole("button", { name: /Nouvelle version/ }));
    const d = await screen.findByRole("dialog", { name: "Déposer une nouvelle version" });
    await u.click(within(d).getByLabelText("Un jeu de données déjà importé dans ce projet"));
    const liste = within(d).getByLabelText("Jeu de données du projet");
    expect(within(liste).queryByRole("option", { name: /retire\.geojson/ })).toBeNull();
    await u.selectOptions(liste, "j-axes");
    await u.click(within(d).getByRole("button", { name: "Déposer la version" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/dernière/);
    await u.click(within(d).getByRole("button", { name: "Déposer la version" }));
    await waitFor(() => expect(h.post).toHaveBeenLastCalledWith(`${B}/documents/d1/versions`, { jeuId: "j-axes" }));
    expect(await screen.findByTestId("avertissements-depot")).toHaveTextContent(/CONTROLE/);
  });
  it("retrait ADMIN : justification obligatoire, DELETE avec { justification } ; 403 ROLE_INSUFFISANT explique", async () => {
    h.del.mockRejectedValueOnce({ response: { status: 403, data: { code: "ROLE_INSUFFISANT" } } }).mockResolvedValueOnce({ data: { id: "d1", retire: true } });
    const u = userEvent.setup();
    rendre({ role: "ADMIN" });
    const fiche = await ouvrirFiche(u, "Piece d1");
    await u.click(within(fiche).getByRole("button", { name: /Retirer/ }));
    const d = await screen.findByRole("dialog", { name: "Retirer cette version du document" });
    expect(within(d).getByRole("button", { name: "Retirer la version" })).toBeDisabled();
    await u.type(within(d).getByLabelText("Justification du retrait"), "Doublon déposé par erreur");
    await u.click(within(d).getByRole("button", { name: "Retirer la version" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/réservé à un administrateur/);
    await u.click(within(d).getByRole("button", { name: "Retirer la version" }));
    await waitFor(() => expect(h.del).toHaveBeenLastCalledWith(`${B}/documents/d1`, { data: { justification: "Doublon déposé par erreur" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("hors ligne : les boutons d'ecriture sont desactives", async () => {
    const u = userEvent.setup();
    rendre({ enLigne: false });
    const fiche = await ouvrirFiche(u, "Piece d1");
    expect(screen.getByRole("button", { name: /Nouveau document/ })).toBeDisabled();
    expect(within(fiche).getByRole("button", { name: "Valider" })).toBeDisabled();
  });
});

describe("liste : filtres et curseur", () => {
  it("versions toutes, statuts et type partent en parametres ; page suivante par curseur", async () => {
    e.suivant = "c-2";
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(screen.getByLabelText("Toutes les versions"));
    await u.click(screen.getByLabelText("Validé"));
    await u.selectOptions(screen.getByLabelText("Type de document"), "PLAN_AXES");
    await waitFor(() => expect(h.get).toHaveBeenLastCalledWith(`${B}/documents`, expect.objectContaining({ params: { limite: 50, versions: "toutes", statut: "VALIDE", typeCode: "PLAN_AXES" } })));
    await u.click(await screen.findByRole("button", { name: "Documents suivants" }));
    expect(await screen.findByRole("article", { name: /^Piece de la page 2/ })).toBeInTheDocument();
    expect(h.get).toHaveBeenLastCalledWith(`${B}/documents`, expect.objectContaining({ params: expect.objectContaining({ curseur: "c-2" }) }));
  });
  it("vide : marche a suivre ; erreurs : 404 masque introuvable, 504 avec reessai, 403, hors ligne", async () => {
    e.documents = [];
    const a = rendre();
    expect(await screen.findByText("Aucun document dans ce dossier")).toBeInTheDocument();
    a.unmount();
    e.erreurs[`${B}/documents`] = { response: { status: 404, data: { code: "PROJET_INTROUVABLE" } } };
    const b = rendre();
    expect(await screen.findByText(/Documents : introuvable/)).toBeInTheDocument();
    b.unmount();
    e.erreurs[`${B}/documents`] = { response: { status: 504, data: { code: "DOCUMENTS_LECTURE_TROP_LONGUE" } } };
    e.documents = [doc("d1")];
    const c = rendre();
    const al = (await screen.findByText(/Documents : chargement impossible/)).closest("[role=alert]") as HTMLElement;
    expect(al).toHaveTextContent(/délai/);
    await userEvent.click(within(al).getByRole("button", { name: "Réessayer : Documents" }));
    expect(await screen.findByRole("article", { name: /^Piece d1/ })).toBeInTheDocument();
    c.unmount();
    e.erreurs[`${B}/documents`] = { response: { status: 403, data: {} } };
    const d = rendre();
    expect(await screen.findByText(/clé de module/)).toBeInTheDocument();
    d.unmount();
    e.erreurs[`${B}/documents`] = new Error("Network Error");
    rendre({ enLigne: false });
    expect(await screen.findByText(/Documents : réseau indisponible/)).toBeInTheDocument();
  });
  it("fiche : 404 DOCUMENT_INTROUVABLE (masque) rendu introuvable", async () => {
    e.erreurs[`${B}/documents/d1`] = { response: { status: 404, data: { code: "DOCUMENT_INTROUVABLE" } } };
    const u = userEvent.setup();
    rendre();
    const art = await screen.findByRole("article", { name: /^Piece d1/ });
    await u.click(within(art).getByRole("button", { name: /Ouvrir la fiche/ }));
    expect((await screen.findByText(/Document : introuvable/)).closest("[role=alert]")).toHaveTextContent(/pas visible de votre compte/);
  });
});

describe("ce que les documents disponibles permettent", () => {
  it("fonctions et conditions ; pieces manquantes avec ce qu'elles debloqueraient ; jamais bloquante d'une fonction independante", async () => {
    rendre({ role: "LECTEUR" });
    const fonctions = await screen.findByRole("list", { name: "Fonctions du module" });
    const analyse = within(fonctions).getByText(/Analyse 2D/).closest("li") as HTMLElement;
    expect(analyse).toHaveTextContent("Disponible");
    expect(analyse).toHaveTextContent(/Un plan d'axes autorisé : remplie \(1\)/);
    expect(within(fonctions).getByText(/Récolement/).closest("li")).toHaveTextContent(/Indisponible.*non remplie/);
    expect(within(fonctions).getByText(/Export du dossier technique/).closest("li")).toHaveTextContent(/Ne dépend d'aucune pièce/);
    expect(within(fonctions).getByText("Fonction future").closest("li")).toHaveTextContent(/non livrée/);
    const pieces = screen.getByRole("list", { name: "Pièces manquantes" });
    expect(within(pieces).getByText(/Une seconde source autorisée de ce réseau/).closest("li")).toHaveTextContent(/Operateur Synthetique.*débloquerait : Comparaison de deux sources/);
    expect(within(pieces).getByText(/Procès-verbal de réception/).closest("li")).toHaveTextContent("Manque au dossier sans bloquer aucune fonction.");
    expect(within(pieces).getByText(/décision de déplacement de réseau/).closest("li")).toHaveTextContent(/onglet Conflits/);
    expect(screen.getByText(/ne bloque que les fonctions qui en dépendent, jamais une fonction indépendante/)).toBeInTheDocument();
  });
  it("liste tronquee signalee ; plus de 20 pieces : les autres a la demande ; 504 explique", async () => {
    e.completude = { ...COMPLETUDE, documents: { total: 6000, parStatut: {}, tronque: true }, piecesManquantes: Array.from({ length: 23 }, (_, i) => ({ nature: "DOCUMENT", document: { id: `x${i}`, version: 1, titre: `Pièce ${i}`, statut: "ATTENDU" }, fonctions: ["CONFLITS"] })) };
    const u = userEvent.setup();
    const a = rendre();
    expect(await screen.findByTestId("completude-tronquee")).toHaveTextContent(/plus de 5 000 documents/);
    expect(within(screen.getByRole("list", { name: "Pièces manquantes" })).getAllByRole("listitem").length).toBe(20);
    await u.click(screen.getByRole("button", { name: /Afficher les 3 autres/ }));
    expect(within(screen.getByRole("list", { name: "Pièces manquantes" })).getAllByRole("listitem").length).toBe(23);
    a.unmount();
    e.erreurs[`${B}/completude`] = { response: { status: 504, data: { code: "COMPLETUDE_TROP_LONGUE" } } };
    rendre();
    expect(await screen.findByText(/Complétude du dossier : chargement impossible/)).toBeInTheDocument();
  });
});

describe("accessibilite", () => {
  it("axe : onglet charge, fiche ouverte, dialogue de creation ouvert", async () => {
    const u = userEvent.setup();
    const { container } = rendre({ role: "ADMIN" });
    await ouvrirFiche(u, "Piece d1");
    await screen.findByRole("list", { name: "Fonctions du module" });
    expect(await violationsAccessibilite(container)).toEqual([]);
    await u.click(screen.getByRole("button", { name: /Nouveau document/ }));
    const d = await screen.findByRole("dialog");
    await u.click(within(d).getByLabelText("Un fichier PDF ou DWG"));
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
