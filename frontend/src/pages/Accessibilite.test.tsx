import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Mesure d'accessibilite des ecrans (paragraphe 7.11) par axe-core, regles WCAG 2.1 A et AA,
 * contraste exclu (jsdom ne le calcule pas, voir `test/accessibilite.ts`).
 *
 * Chaque test rend l'ecran avec des donnees, puis exige ZERO violation. Un echec liste les
 * violations : elles se corrigent, elles ne se taisent pas.
 */

const h = vi.hoisted(() => ({ get: {} as Record<string, unknown> }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: vi.fn() }));
vi.mock("../components/CarteReleve", () => ({ CarteReleve: () => <div data-testid="carte" /> }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => ({ data: h.get[url] ?? {} })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

import { CelluleVeillePage } from "./CelluleVeillePage";
import { PatrouillesPage } from "./PatrouillesPage";
import { InfoRoutePage } from "./InfoRoutePage";
import { VeilleConfigurationPage } from "./VeilleConfigurationPage";
import { TeledetectionPage } from "./TeledetectionPage";
import { ControlTowerPage } from "./ControlTowerPage";
import { IndicateursControles } from "../components/IndicateursControles";
import { VoletPortions, VoletProgrammation } from "../components/Fiche360Volets";
import { Sidebar } from "../components/layout/Sidebar";
import { LoginPage } from "./LoginPage";
import { ImportsPage } from "./ImportsPage";
import { controle, ETAPES_SANS_CIRCUIT, lotDetail, lotListe, reponseApercu } from "../components/imports/lotsDeTest";
import type { Etape } from "../components/imports/types";
import { ReleveVehiculePage } from "./ReleveVehiculePage";
import { CurseurTemporel } from "./geoportail/CurseurTemporel";
import type { EtatCouchePortions } from "./geoportail/PortionsDateLayer";
import type { EtatCurseur } from "../lib/curseur";
import { api } from "../lib/api";
import userEvent from "@testing-library/user-event";

function rendre(el: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{el}</QueryClientProvider></MemoryRouter>);
}

// Tableau de bord, Control Tower, Fiche 360 : des donnees complettes (valeur, aucune donnee, a traiter, ecart).
const PERIMETRE_CLASSE = { code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi", definition: "Tronçons non supprimés hors voirie rattachée." };
const PERIMETRE_MC = { code: "MAIN_COURANTE_ACTIFS", libelle: "Événements de la main courante non clos", definition: "Événements dont le dernier statut n'est pas CLOS." };
const indic = (code: string, libelle: string, groupe: string, valeur: unknown, over: Record<string, unknown> = {}) => ({
  code, libelle, groupe, unite: "nombre", perimetre: PERIMETRE_CLASSE, statut: "CALCULE", valeur, motif: null, aucuneDonnee: false, sourceLibelle: null, ...over,
});
const INDICATEURS = [
  indic("troncons_classes", "Tronçons classés", "reseau", 1691),
  indic("longueur_geometrique_km", "Longueur géométrique du réseau classé saisi", "reseau", 21156.6, { unite: "km" }),
  indic("documents", "Documents", "reseau", null, { statut: "INDISPONIBLE", motif: "Cet indicateur n'existe qu'au niveau national." }),
  indic("portions_validees", "Portions validées (état constaté)", "portions", 0, { aucuneDonnee: true, sourceLibelle: "portions" }),
  indic("portions_chevauchantes", "Paires de portions courantes qui se chevauchent", "qualite", 3),
];
const VERSION = (id: string, o: Record<string, unknown> = {}) => ({
  id, debutM: 0, finM: 400, etat: "BON", etatLibelle: "Bon", revetement: "BITUME", statutValidation: "VALIDE", origine: "SAISIE_TERRAIN",
  valideDu: "2026-01-01", valideAu: null, enregistreLe: "2026-01-10T08:00:00Z", observeeLe: null, remplaceeLe: null, courante: true, issueDe: [], ...o,
});
const CONTROL_TOWER = {
  genereLe: "2026-10-22T10:00:00Z",
  portee: { national: false, regions: [{ id: 3, nom: "Kankan" }] },
  modules: [
    { code: "veille", libelle: "Cellule de veille", lien: "/veille", aucuneDonnee: false, indisponible: false, indicateurs: [
      indic("evenements_actifs", "Événements actifs de la main courante", "veille", 4, { perimetre: PERIMETRE_MC }),
      indic("trous_de_permanence", "Événements escaladés sans personne d'astreinte", "veille", 2, { perimetre: PERIMETRE_MC }),
    ] },
    { code: "teledetection", libelle: "Observation de la Terre", lien: "/teledetection", aucuneDonnee: true, indisponible: false, indicateurs: [
      indic("propositions_a_verifier", "Propositions de télédétection en attente de verdict", "teledetection", 0, { aucuneDonnee: true, sourceLibelle: "propositions de télédétection" }),
    ] },
    { code: "qualite", libelle: "Anomalies de qualité bloquantes", lien: "/qualite", aucuneDonnee: false, indisponible: true, indicateurs: [
      indic("regles_escalade_actives", "Règles d'escalade actives", "veille", null, { statut: "INDISPONIBLE" }),
    ] },
  ],
  nonCouvert: ["Doublons de géométrie : balayage national, non rejoué à chaque rafraîchissement.", "Aucune notification n'est envoyée."],
};

// Lots d'import : un lot conforme au contrat (en attente, non applique) et un lot rejete avec son motif.
const META_IMPORT = {
  formats: [
    { code: "csv", libelle: "CSV pivot", aide: "Séparateur point-virgule, première ligne = en-tête, UTF-8." },
    { code: "geojson", libelle: "GeoJSON pivot", aide: "FeatureCollection en WGS 84." },
  ],
  tailleMaxOctets: 52428800, limiteLignes: 100000, statuts: ["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"],
};
const LOT_CONFORME = lotListe({ id: "l1", reference: "IMP-2026-0001", systemeSource: "ANASUR", nomFichier: "releve.csv", importeLe: "2026-10-20T08:00:00Z" });
const LOT_REJETE = lotListe({
  id: "l2", reference: "IMP-2026-0002", systemeSource: "ANASUR", nomFichier: "releve-32628.geojson", format: "geojson", statut: "REJETE",
  importeLe: "2026-10-21T08:00:00Z", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0, motifRejetLot: "GeoJSON : CRS EPSG:32628 refusé, le pivot impose le SRID 4326",
});
// Contrat : pour un lot REJETE, echantillon et import_autorise sont NON_COMMENCEE (pas NON_DISPONIBLE).
const ETAPES_REJETE: Etape[] = [
  { id: "reception", titre: "Réception du fichier", etat: "TERMINEE", raison: "Fichier reçu et empreinte calculée." },
  { id: "controle_schema", titre: "Contrôle du schéma", etat: "ECHEC", raison: "Le fichier n'est pas conforme au contrat." },
  { id: "echantillon", titre: "Échantillon à valider", etat: "NON_COMMENCEE", raison: "Aucun circuit d'approbation n'existe encore." },
  { id: "import_autorise", titre: "Import autorisé", etat: "NON_COMMENCEE", raison: "L'écriture au référentiel n'a pas de circuit." },
];
// Le detail n'a pas de `motifRejetLot` propre : le motif vit dans `controle`.
const { motifRejetLot: _motifConforme, ...BASE_CONFORME } = LOT_CONFORME;
const { motifRejetLot: MOTIF_REJET, ...BASE_REJETE } = LOT_REJETE;
const DETAIL_CONFORME = lotDetail({ ...BASE_CONFORME, etapes: ETAPES_SANS_CIRCUIT });
const DETAIL_REJETE = lotDetail({
  ...BASE_REJETE, etapes: ETAPES_REJETE,
  controle: controle({
    motifRejetLot: MOTIF_REJET, compteurs: { lues: 0, validees: 0, rejetees: 0, enConflit: 0, ignorees: 0, importees: 0 },
    premiersRejets: [], colonnes: null, avertissements: ["Le fichier déclare un autre système de coordonnées."],
  }),
});

beforeEach(() => {
  h.get = {
    "/v2/tableau-de-bord/control-tower": CONTROL_TOWER,
    "/v2/tableau-de-bord/indicateurs": { genereLe: "2026-10-22T10:00:00Z", portee: { national: true, regions: [] }, indicateurs: INDICATEURS },
    "/v2/tableau-de-bord/controle": {
      genereLe: "2026-10-22T10:00:00Z", total: 5, egaux: 3, ecarts: 1, erreurs: 0, indisponibles: 1,
      resultats: [
        { code: "troncons_classes", libelle: "Tronçons classés", unite: "nombre", statut: "EGAL", calcul: 1691, controle: 1691, motif: null },
        { code: "longueur_geometrique_km", libelle: "Longueur", unite: "km", statut: "EGAL", calcul: 21156.6, controle: 21156.6, motif: null },
        { code: "portions_validees", libelle: "Portions", unite: "nombre", statut: "EGAL", calcul: 0, controle: 0, motif: null },
        { code: "portions_chevauchantes", libelle: "Chevauchements", unite: "nombre", statut: "ECART", calcul: 3, controle: 2, motif: "Écart" },
        { code: "documents", libelle: "Documents", unite: "nombre", statut: "INDISPONIBLE", calcul: null, controle: null, motif: "national" },
      ],
    },
    "/v2/fiche-360/troncons/t1/portions": {
      tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry", tronque: false, plafond: 500,
      courantes: [VERSION("p2", { etat: "MAUVAIS", etatLibelle: "Mauvais", valideDu: "2026-06-01", issueDe: ["p1"] })],
      historique: [VERSION("p1", { courante: false, valideAu: "2026-06-01", remplaceeLe: "2026-06-02T09:00:00Z" }), VERSION("p2", { etat: "MAUVAIS", etatLibelle: "Mauvais", valideDu: null, issueDe: ["p1"] })],
      comptes: { courantes: 1, remplacees: 1, sansDateEffet: 1 },
    },
    "/v2/fiche-360/troncons/t1/programmation": {
      tronconId: "t1", tronconCode: "GN N0001",
      previsions: [{ id: "a", annee: 2027, intitule: "Réhabilitation", statut: "RETENU", source: "SAISIE", bailleur: "AFD", typeIntervention: null, priorite: 1, montantPrevuGnf: "9007199254740993" }],
      totaux: [{ statut: "RETENU", nb: 1, montantGnf: "9007199254740993" }],
      chantiers: [{ id: "c", intitule: "Reprise radier", statut: "EN_COURS", avancementPct: 40, entreprise: "ETP", montantGnf: null, dateDebutPrevue: null, dateFinPrevue: "2026-12-31" }],
      interventionsFigees: { disponible: false, motif: "Aucune table de fiches d'intervention : le cycle de vie n'existe que comme règle." },
    },
    "/v2/portions/a-la-date": {
      dateTerrain: "2026-03-15", connuLe: null, inclureAValider: false, tronque: false, plafond: 5000,
      comptes: { retenues: 1, aValiderEcartees: 2, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 1 }, longueurCouverteM: 400,
      portions: [{ id: "p1", tronconId: "t1", tronconCode: "GN N0001", tronconNom: "Conakry", debutM: 0, finM: 400, longueurM: 400, revetement: null, etat: "BON", etatLibelle: "Bon",
        praticabilite: null, largeurM: null, source: null, confiance: null, observeeLe: null, valideDu: "2026-01-01", valideAu: "2026-06-01", enregistreLe: "2026-01-10T08:00:00Z", statut: "VALIDE", ambigue: true, geometry: null }],
    },
    "/v2/exploitation/veille/tableau": {
      genereLe: "2026-10-20T08:00:00Z",
      mode: { mode: "SAISON_PLUIES", declare: true, motif: "Crues", declareLe: "2026-10-20T06:00:00Z", declarePar: { id: "u", nomComplet: "Chef" } },
      evenements: [{ evenementId: "e1", typeCode: "COUPURE", statut: "OUVERT", ouvertLe: "2026-10-20T06:00:00Z", texte: "Radier", tronconCode: "GN N0001", ageMinutes: 125, escalade: { niveau: 1, declencheeLe: "2026-10-20T07:00:00Z", destinataire: null, sansDestinataire: true } }],
      astreintes: [{ id: "a", niveau: 1, debut: "2026-10-20T00:00:00Z", fin: "2026-10-21T00:00:00Z", user: { id: "u", nomComplet: "Agent" }, region: null }],
      regles: { actives: 1, incoherences: [], aucuneRegle: false }, infoRouteEnCours: 1, signalementsNouveaux: 2, alertesSatelliteAVerifier: 1,
      patrouilles: [{ id: "p", code: "PAT-1", libelle: "RN1", echeance: { statut: "EN_RETARD", prochaine: "2026-10-16T00:00:00Z", joursRetard: 4 } }],
    },
    "/v2/exploitation/patrouilles/programmes": { programmes: [{
      id: "p1", code: "PAT-RN1", libelle: "RN1", classeAxe: "RN", periodiciteJours: 7, moisActifs: [6, 7], actif: true, dernierPassage: null,
      responsable: { id: "u", nomComplet: "Chef" }, _count: { troncons: 2 }, echeance: { statut: "A_JOUR", prochaine: "2026-10-27T00:00:00Z", joursRetard: 0 },
    }] },
    "/v2/exploitation/veille/personnes": { personnes: [{ id: "u", nomComplet: "Chef" }] },
    "/v2/exploitation/main-courante/evenements": { evenements: [{ evenementId: "ev", typeCode: "COUPURE", texte: "x", statut: "PRIS_EN_COMPTE", ouvertLe: "2026-10-20T06:00:00Z" }] },
    "/v2/exploitation/info-route/courante": { publications: [] },
    "/v2/exploitation/info-route/bulletins": { bulletins: [{ id: "b", numero: "BR-20261020-1", situationA: "2026-10-20T06:00:00Z", empreinteSha256: "a".repeat(64), publicationsIds: [] }] },
    "/v2/exploitation/veille/mode": { mode: "NORMAL", declare: false, motif: null },
    "/v2/exploitation/veille/regles": { regles: [{ id: "r", typeCode: null, mode: "TOUS", niveau: 1, delaiMinutes: 30, actif: true }] },
    "/v2/exploitation/veille/astreintes": { astreintes: [] },
    "/v2/exploitation/referentiels": { types: [{ code: "COUPURE", libelle: "Coupure" }] },
    "/regions": [{ id: 1, nom: "Conakry" }],
    "/v2/teledetection/propositions": { propositions: [{
      id: "pr", type: "INONDATION", methode: "seuil v0", score: 0.7, statut: "A_VERIFIER", distanceTronconM: 11, missionId: null, motifVerdict: null, constatRef: null,
      produit: { code: "S1", source: "Sentinel-1", dateAcquisition: "2026-10-02T00:00:00Z" }, troncon: { code: "GN N0001", nom: "Conakry" },
    }] },
    "/v2/teledetection/precision": { lignes: [{ type: "INONDATION", methode: "seuil v0", total: 1, aVerifier: 1, confirmees: 0, infirmees: 0, precision: null }] },
    "/v2/teledetection/produits": { produits: [] },
    // Lots d'import : liste, formats, sources, details (un lot conforme, un lot rejete) et apercus.
    "/v2/imports": { lots: [LOT_CONFORME, LOT_REJETE], suivant: null, total: 2 },
    "/v2/imports/meta": META_IMPORT,
    "/v2/imports/sources": { sources: [{ valeur: "ANASUR", nombreLots: 2 }] },
    "/v2/imports/l1": DETAIL_CONFORME,
    "/v2/imports/l2": DETAIL_REJETE,
    "/v2/imports/l1/apercu": reponseApercu(),
    "/v2/imports/l2/apercu": reponseApercu({ lignes: [], tronque: false }),
  };
});

describe("L'instrument mesure vraiment", () => {
  it("contre-epreuve : un fragment defectueux produit des violations", async () => {
    const { container } = render(
      <div>
        {/* Defaut VOLONTAIRE : c'est ce que la contre-epreuve doit faire detecter a axe. */}
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img src="x.png" />
        <input type="text" />
        <button type="button"></button>
      </div>,
    );
    const v = await violationsAccessibilite(container);
    const regles = v.map((x) => x.split(" ")[0]);
    expect(regles).toEqual(expect.arrayContaining(["image-alt", "label", "button-name"]));
  });
});

describe("Accessibilite des ecrans (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it.each([
    ["Cellule de veille", <CelluleVeillePage key="v" />, "cellule-veille"],
    ["Patrouilles", <PatrouillesPage key="p" />, /PAT-RN1/],
    ["Info Route", <InfoRoutePage key="i" />, /BR-20261020-1/],
    ["Configuration de la veille", <VeilleConfigurationPage key="c" />, /Tous modes · niveau 1/],
    ["Observation de la Terre", <TeledetectionPage key="t" />, /Rattachée à GN N0001/],
    ["Menu lateral", <Sidebar key="s" open />, /Cellule de veille/],
    ["Connexion", <LoginPage key="l" />, /./],
    ["Lots d'import", <ImportsPage key="im" />, /IMP-2026-0001/],
    ["Releve en vehicule (etat initial)", <ReleveVehiculePage key="rv" />, /État de la fonction/],
    ["Control Tower (valeurs, a traiter, aucune donnee, module regional indisponible)", <ControlTowerPage key="ct" />, "control-tower"],
    ["Indicateurs du tableau de bord (perimetres, refus regional, aucune donnee)", <IndicateursControles key="ic" />, "indicateurs-controles"],
    ["Fiche 360, volet portions (version courante et historique)", <VoletPortions key="vp" tronconId="t1" />, "volet-portions"],
    ["Fiche 360, volet programmation", <VoletProgrammation key="vg" tronconId="t1" />, "volet-programmation"],
  ] as const)("%s : aucune violation", async (_nom, element, attente) => {
    const { container } = rendre(element);
    if (typeof attente === "string") await screen.findByTestId(attente, undefined, { timeout: 10_000 });
    else await screen.findAllByText(attente, undefined, { timeout: 10_000 });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});

describe("Accessibilite du releve en vehicule, resultat affiche", () => {
  it("aucune violation avec un resultat d'analyse (tableaux, avertissements, indicateurs)", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {
      parametres: { reseau: "reference", distanceMaxM: 50, pasMinM: 15, incertitudeParDefautM: 15, pointsMax: 3000 },
      indicateurs: { pointsLus: 300, pointsIgnores: 0, pointsRetenus: 276, retiresParPas: 24, pointsRattaches: 224, tauxRattachement: 0.812, pointsPrecisionInsuffisante: 0, transitionsNonVerifiees: 1, chaines: 1, distanceParcourueM: 5511, dureeS: 552, vitesseMoyenneKmH: 35.9, longueurSurReseauM: 4392 },
      passages: [{ tronconId: "t", code: "GN N0001", nom: "Conakry", indexDebut: 0, indexFin: 5, nombrePoints: 6, deM: 0, aM: 100, longueurM: 100, sens: "CROISSANT", court: false, geojson: null }],
      horsReferentiel: [{ indexDebut: 6, indexFin: 9, nombrePoints: 4, longueurM: 80, coordonnees: [[-13.6, 9.6]] }],
      trace: [[-13.6, 9.6], [-13.59, 9.6]], rattache: [true, false],
      avertissements: ["Aucune precision annoncee par le fichier."],
    } } as never);
    const { container } = rendre(<ReleveVehiculePage />);
    await userEvent.upload(screen.getByLabelText(/Fichier de trace/), new File(["<gpx></gpx>"], "sortie.gpx"));
    await userEvent.click(screen.getByRole("button", { name: /Analyser la trace/ }));
    await screen.findByRole("table", { name: /Tronçons parcourus/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});

describe("Accessibilite du curseur temporel", () => {
  const chrono = { total: 10, avecDateEffet: 6, sansDateEffet: 4, premiere: "2026-01-01", derniere: "2026-08-01", parMois: [] };
  const reponse = {
    dateTerrain: "2026-03-15", connuLe: "2026-04-01", inclureAValider: true, tronque: true, plafond: 5000,
    comptes: { retenues: 1, aValiderEcartees: 2, sansDateEffet: 0, datesIncoherentes: 1, remplaceesSansFin: 1, ambigues: 2 },
    longueurCouverteM: 500,
    portions: [{ id: "p", tronconId: "t", tronconCode: "GN N0001", tronconNom: "x", debutM: 0, finM: 500, longueurM: 500, revetement: null, etat: "BON", etatLibelle: "Bon",
      praticabilite: null, largeurM: null, source: null, confiance: null, observeeLe: null, valideDu: "2026-01-01", valideAu: null,
      enregistreLe: "2026-01-10T08:00:00Z", statut: "VALIDE" as const, ambigue: false, geometry: null }],
  };
  it.each([
    ["eteint", { actif: false, date: "2026-10-22", connu: null, inclureAValider: false }, null],
    ["allume, vue vide", { actif: true, date: "2026-03-15", connu: null, inclureAValider: false }, { zoomSuffisant: true, chargement: false, reponse: { ...reponse, portions: [], comptes: { ...reponse.comptes, retenues: 0 } }, erreur: null }],
    ["allume, avec resultats, avertissements et axe systeme", { actif: true, date: "2026-03-15", connu: "2026-04-01", inclureAValider: true }, { zoomSuffisant: true, chargement: false, reponse, erreur: null }],
    ["allume, erreur du serveur", { actif: true, date: "2026-03-15", connu: null, inclureAValider: false }, { zoomSuffisant: true, chargement: false, reponse: null, erreur: "Emprise trop large." }],
  ] as const)("%s : aucune violation", async (_n, etat, couche) => {
    // `as const` rend le tableau en lecture seule ; le composant attend des types modifiables.
    const { container } = rendre(
      <CurseurTemporel
        etat={etat as unknown as EtatCurseur}
        onChange={() => {}}
        chronologie={chrono}
        couche={couche as unknown as EtatCouchePortions | null}
        auj="2026-10-22"
      />,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});

describe("Accessibilite du tableau de bord, de la Control Tower et de la fiche 360 : etats et interactions", () => {
  it("Control Tower : l'instrument voit bien CE DOM (contre-epreuve : un defaut injecte dans la page est detecte)", async () => {
    const { container } = rendre(<ControlTowerPage />);
    await screen.findByTestId("control-tower");
    expect(await violationsAccessibilite(container)).toEqual([]);
    const defaut = document.createElement("img");
    defaut.setAttribute("src", "x.png");
    container.appendChild(defaut);
    const v = await violationsAccessibilite(container);
    expect(v.map((x) => x.split(" ")[0])).toContain("image-alt");
  }, 30_000);

  it("Control Tower : etat vide (aucun module)", async () => {
    h.get["/v2/tableau-de-bord/control-tower"] = { ...CONTROL_TOWER, modules: [] };
    const { container } = rendre(<ControlTowerPage />);
    await screen.findByText("Aucun module à afficher.");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("Control Tower : etat d'erreur", async () => {
    vi.mocked(api.get).mockRejectedValueOnce({ response: { data: { error: "Accès à ce module non autorisé pour votre compte" } } });
    const { container } = rendre(<ControlTowerPage />);
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("Indicateurs : apres le rapprochement (egaux, ecart, indisponible)", async () => {
    const { container } = rendre(<IndicateursControles />);
    await userEvent.click(await screen.findByRole("button", { name: "Rapprocher des requêtes de contrôle" }));
    await screen.findByText(/Écart : calcul 3, contrôle 2/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("Indicateurs : etat vide et etat d'erreur", async () => {
    h.get["/v2/tableau-de-bord/indicateurs"] = { genereLe: "2026-10-22T10:00:00Z", portee: { national: true, regions: [] }, indicateurs: [] };
    const vide = rendre(<IndicateursControles />);
    await screen.findByText("Aucun indicateur à afficher.");
    expect(await violationsAccessibilite(vide.container)).toEqual([]);
    vide.unmount();
    vi.mocked(api.get).mockRejectedValueOnce(new Error("503"));
    const erreur = rendre(<IndicateursControles />);
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(erreur.container)).toEqual([]);
  }, 30_000);

  it("Fiche 360, portions : etat a une date choisie (resume, avertissements, tableau)", async () => {
    const { container } = rendre(<VoletPortions tronconId="t1" />);
    await userEvent.type(await screen.findByLabelText("Jour de terrain"), "2026-03-15");
    await screen.findByRole("table", { name: /Portions vraies le/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("Fiche 360 : etat vide et refus hors perimetre", async () => {
    h.get["/v2/fiche-360/troncons/t1/portions"] = { tronconId: "t1", tronconCode: "x", tronconNom: "x", courantes: [], historique: [], tronque: false, plafond: 500, comptes: { courantes: 0, remplacees: 0, sansDateEffet: 0 } };
    const vide = rendre(<VoletPortions tronconId="t1" />);
    await screen.findByText(/n'a jamais été inventorié/);
    expect(await violationsAccessibilite(vide.container)).toEqual([]);
    vide.unmount();
    vi.mocked(api.get).mockRejectedValueOnce({ response: { data: { error: "Cette ecriture touche une region hors de votre perimetre." } } });
    const refus = rendre(<VoletProgrammation tronconId="t1" />);
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(refus.container)).toEqual([]);
  }, 30_000);
});

describe("Accessibilite de la page Lots d'import : etats cles", () => {
  const implOriginale = vi.mocked(api.get).getMockImplementation();

  // Les erreurs de lecture se simulent en mettant une `Error` dans `h.get` : la requete la leve.
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      const r = h.get[url];
      if (r instanceof Error) throw r;
      return { data: r ?? {} };
    });
  });
  afterEach(() => { if (implOriginale) vi.mocked(api.get).mockImplementation(implOriginale); });

  function rendreImports(entree: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<MemoryRouter initialEntries={[entree]}><QueryClientProvider client={qc}><ImportsPage /></QueryClientProvider></MemoryRouter>);
  }
  const erreur503 = () => Object.assign(new Error("503"), { response: { status: 503, data: {} } });

  it("liste vide (premier lot a recevoir)", async () => {
    h.get["/v2/imports"] = { lots: [], suivant: null, total: 0 };
    h.get["/v2/imports/sources"] = { sources: [] };
    const { container } = rendreImports("/imports");
    await screen.findByText(/Aucun lot reçu\. Sélectionnez un fichier et renseignez/);
    await screen.findByRole("option", { name: "CSV pivot" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("liste chargee, avec une page suivante", async () => {
    h.get["/v2/imports"] = { lots: [LOT_CONFORME, LOT_REJETE], suivant: "curseur-2", total: 3 };
    const { container } = rendreImports("/imports");
    await screen.findByText("2 lots sur 3");
    await screen.findByRole("button", { name: "Charger plus de lots" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("detail d'un lot REJETE (motif, etapes 3 et 4 non disponibles)", async () => {
    const { container } = rendreImports("/imports?lot=l2");
    await screen.findByRole("heading", { name: "IMP-2026-0002" });
    await screen.findAllByText(/CRS EPSG:32628 refusé/);
    await screen.findByText("Aucun circuit d'approbation n'existe encore.", { selector: "p" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("detail d'un lot VALIDE_SCHEMA (non applique, en attente)", async () => {
    const { container } = rendreImports("/imports?lot=l1");
    await screen.findByRole("heading", { name: "IMP-2026-0001" });
    await screen.findAllByText("Schéma validé : non appliqué");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("erreurs : liste, detail et formats indisponibles", async () => {
    h.get["/v2/imports"] = erreur503();
    h.get["/v2/imports/meta"] = erreur503();
    h.get["/v2/imports/l1"] = erreur503();
    const { container } = rendreImports("/imports?lot=l1");
    await screen.findByText("La liste des lots n'a pas pu être chargée.");
    await screen.findByText("Les formats et plafonds du serveur n'ont pas pu être chargés.");
    await screen.findAllByText("Le détail du lot n'a pas pu être chargé.");
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);

  it("formulaire avec des erreurs de saisie (champ vide, reference trop courte)", async () => {
    const { container } = rendreImports("/imports");
    // Le formulaire est remonte quand les formats arrivent : on prend celui qui est actif.
    await screen.findByRole("option", { name: "CSV pivot" });
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    const u = userEvent.setup();
    await u.clear(within(form).getByLabelText(/Système source/));
    await u.type(within(form).getByLabelText(/Référence de l'autorisation écrite/), "ab");
    await u.tab();
    await within(form).findAllByText(/Erreur :/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});
