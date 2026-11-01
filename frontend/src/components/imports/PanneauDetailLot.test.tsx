import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanneauDetailLot, type PanneauDetailLotProps } from "./PanneauDetailLot";
import { controle, lotDetail, reponseApercu } from "./lotsDeTest";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { LotDetail, ReponseApercu } from "./types";

/**
 * Ce que le panneau défend :
 *
 * - le lot REJETÉ met son motif en évidence ; le lot « schéma validé » est dit non appliqué, en ambre ;
 * - des compteurs RÉELS (jamais un nombre inventé), des colonnes « non calculable » quand `colonnes` est null ;
 * - l'empreinte est CALCULÉE, jamais « vérifiée » ;
 * - le téléchargement inactif montre la raison du SERVEUR ;
 * - aucune action d'approbation ni d'import n'existe ;
 * - l'erreur de chargement n'est pas le vide.
 */

const renderStatut = vi.fn((lot: LotDetail) => <span data-statut={lot.statut}>STATUT {lot.statut}</span>);

function props(over: Partial<PanneauDetailLotProps> = {}): PanneauDetailLotProps {
  return {
    detail: lotDetail(),
    chargement: false,
    onFermer: vi.fn(),
    onTelechargerErreurs: vi.fn(),
    telechargementEnCours: false,
    renderStatut,
    // Par défaut l'aperçu ne répond jamais : le panneau reste sur son squelette et aucun rendu tardif ne
    // sort du test. Les tests qui regardent l'aperçu fournissent leur propre réponse.
    chargerApercu: vi.fn(() => new Promise<ReponseApercu>(() => {})),
    ...over,
  };
}

const apercuPret = () => vi.fn(async () => reponseApercu());

const rejete = () => lotDetail({
  statut: "REJETE",
  reference: "IMP-2026-00002",
  lignesLues: 0, lignesValidees: 0, lignesRejetees: 0, lignesIgnorees: 0,
  controle: controle({
    motifRejetLot: "GeoJSON : CRS urn:ogc:def:crs:EPSG::32628 refusé, le pivot impose le SRID 4326",
    compteurs: { lues: 0, validees: 0, rejetees: 0, enConflit: 0, ignorees: 0, importees: 0 },
    premiersRejets: [],
    colonnes: null,
  }),
  actionsPermises: [
    { code: "TELECHARGER_ERREURS", permise: false, raison: "Aucune ligne rejetée ni ignorée : le fichier d'erreurs serait vide." },
    { code: "VOIR_APERCU", permise: false, raison: "Le lot a été rejeté avant la lecture des lignes." },
  ],
});

afterEach(() => { renderStatut.mockClear(); });

describe("États du panneau : vide, chargement, erreur", () => {
  it("sans lot choisi : la région est labellisée et invite à choisir", () => {
    render(<PanneauDetailLot {...props({ detail: undefined })} />);
    const region = screen.getByRole("region", { name: "Détail du lot" });
    expect(within(region).getByText("Sélectionnez un lot pour voir ses contrôles.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Détail du lot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fermer/ })).not.toBeInTheDocument();
  });

  it("pendant le chargement : un squelette, annoncé, et la région est occupée", () => {
    render(<PanneauDetailLot {...props({ detail: undefined, chargement: true })} />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Chargement du détail du lot.");
    expect(screen.queryByText(/Sélectionnez un lot/)).not.toBeInTheDocument();
  });

  it("une erreur est distincte du vide : alerte, texte propre, bouton Réessayer", async () => {
    const onReessayer = vi.fn();
    render(<PanneauDetailLot {...props({ detail: undefined, erreur: new Error("500"), onReessayer })} />);
    const alerte = screen.getByRole("alert");
    expect(alerte).toHaveTextContent("Le détail du lot n'a pas pu être chargé.");
    expect(alerte).toHaveTextContent("Aucune donnée n'a été modifiée.");
    expect(screen.queryByText(/Sélectionnez un lot/)).not.toBeInTheDocument();
    expect(alerte).not.toHaveTextContent("500"); // l'objet d'erreur brut n'est pas montré
    await userEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(onReessayer).toHaveBeenCalledTimes(1);
  });

  it("un message d'erreur du serveur (texte) est affiché tel quel", () => {
    render(<PanneauDetailLot {...props({ detail: undefined, erreur: "Lot introuvable." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Lot introuvable.");
  });

  it("l'erreur prime sur un ancien détail resté en mémoire", () => {
    render(<PanneauDetailLot {...props({ erreur: true })} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("IMP-2026-00001")).not.toBeInTheDocument();
  });

  it("le bouton « Fermer le détail » appelle onFermer", async () => {
    const onFermer = vi.fn();
    render(<PanneauDetailLot {...props({ onFermer })} />);
    await userEvent.click(screen.getByRole("button", { name: "Fermer le détail" }));
    expect(onFermer).toHaveBeenCalledTimes(1);
  });
});

describe("Annonce du changement de lot", () => {
  it("la région aria-live annonce le lot affiché, puis le suivant", () => {
    const { rerender } = render(<PanneauDetailLot {...props()} />);
    const zone = screen.getAllByRole("status").find((z) => z.className.includes("sr-only"))!;
    expect(zone).toHaveAttribute("aria-live", "polite");
    expect(zone).toHaveTextContent("Détail du lot IMP-2026-00001 affiché.");
    rerender(<PanneauDetailLot {...props({ detail: lotDetail({ id: "lot-2", reference: "IMP-2026-00002" }) })} />);
    expect(zone).toHaveTextContent("Détail du lot IMP-2026-00002 affiché.");
  });

  it("le titre h2 est la référence du lot et nomme la région", () => {
    render(<PanneauDetailLot {...props()} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("IMP-2026-00001");
    expect(screen.getByRole("region", { name: "IMP-2026-00001" })).toBeInTheDocument();
  });
});

describe("En-tête du lot", () => {
  it("statut fourni, source, format, fichier, taille lisible, importateur et date", () => {
    render(<PanneauDetailLot {...props()} />);
    expect(renderStatut).toHaveBeenCalledWith(expect.objectContaining({ id: "lot-1" }));
    expect(screen.getByText("STATUT VALIDE_SCHEMA")).toBeInTheDocument();
    const dl = screen.getAllByRole("term").find((t) => t.textContent === "Source")!.parentElement!;
    expect(within(dl).getByText("ONR_BDR")).toBeInTheDocument();
    expect(within(dl).getByText("CSV")).toBeInTheDocument();
    expect(within(dl).getByText("rn1.csv")).toBeInTheDocument();
    expect(within(dl).getByText("1,5 Mo")).toHaveAttribute("title", expect.stringMatching(/1.572.864 octets/));
    expect(within(dl).getByText(/Tidiane Diallo/)).toBeInTheDocument();
    expect(dl.querySelector("time")).toHaveAttribute("datetime", "2026-10-14T20:00:00.000Z");
  });

  it("la taille BigInt-chaîne n'est jamais arrondie par Number", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ tailleOctets: "9007199254740993" }) })} />);
    const taille = screen.getByText(/To$/);
    expect(taille.getAttribute("title")!.replace(/\D/g, "")).toBe("9007199254740993");
  });

  it("une taille illisible est dite inconnue, pas devinée", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ tailleOctets: "n/a" }) })} />);
    expect(screen.getByText("Taille inconnue")).toBeInTheDocument();
  });

  it("un nom de fichier hostile, démesuré ou accentué reste du texte", () => {
    const hostile = "<img src=x onerror=alert(1)>.csv";
    const { container, rerender } = render(<PanneauDetailLot {...props({ detail: lotDetail({ nomFichier: hostile }) })} />);
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    const long = `${"é".repeat(250)}.csv`;
    rerender(<PanneauDetailLot {...props({ detail: lotDetail({ nomFichier: long }) })} />);
    expect(screen.getByText(long).className).toMatch(/break-all/);
  });

  it("un importateur inconnu est dit non renseigné", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ importePar: null }) })} />);
    expect(screen.getByText("Non renseigné")).toBeInTheDocument();
  });
});

describe("Empreinte : calculée, jamais « vérifiée »", () => {
  it("affiche l'algorithme, la valeur et la phrase sur le calcul serveur", () => {
    render(<PanneauDetailLot {...props()} />);
    expect(screen.getByText(/Calculée par le serveur sur les octets reçus/)).toBeInTheDocument();
    expect(screen.getByText("SHA-256")).toBeInTheDocument();
    expect(screen.getByText("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBeInTheDocument();
  });

  it("le mot « vérifiée » n'apparaît nulle part dans le panneau", () => {
    const { container } = render(<PanneauDetailLot {...props()} />);
    expect(container.textContent).not.toMatch(/v[ée]rifi[ée]e?s?\b/i);
  });

  it("se copie, et annonce la copie", async () => {
    const u = userEvent.setup();
    const ecrire = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<PanneauDetailLot {...props()} />);
    await u.click(screen.getByRole("button", { name: "Copier l'empreinte" }));
    expect(ecrire).toHaveBeenCalledWith("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    expect(await screen.findByText("Empreinte copiée.")).toBeInTheDocument();
  });

  it("dit que la copie a échoué au lieu de se taire", async () => {
    const u = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("refusé"));
    render(<PanneauDetailLot {...props()} />);
    await u.click(screen.getByRole("button", { name: "Copier l'empreinte" }));
    expect(await screen.findByText(/Copie impossible/)).toBeInTheDocument();
  });
});

describe("Métadonnées de la source", () => {
  it("méthode, version du mapping, autorisation écrite ; auteur et date seulement s'ils existent", () => {
    const { rerender } = render(<PanneauDetailLot {...props()} />);
    const bloc = screen.getByRole("heading", { name: "Métadonnées de la source" }).parentElement!;
    expect(within(bloc).getByText("export L2R Mesure")).toBeInTheDocument();
    expect(within(bloc).getByText("v0")).toBeInTheDocument();
    expect(within(bloc).getByText("AUT-2026-01")).toBeInTheDocument();
    expect(within(bloc).queryByText("Auteur de la source")).not.toBeInTheDocument();
    expect(within(bloc).queryByText("Date de la source")).not.toBeInTheDocument();
    rerender(<PanneauDetailLot {...props({ detail: lotDetail({ auteurSource: "Service cartographie", dateSource: "2026-09-30" }) })} />);
    expect(within(bloc).getByText("Service cartographie")).toBeInTheDocument();
    expect(within(bloc).getByText("Date de la source")).toBeInTheDocument();
  });
});

describe("Lot REJETE : le motif en évidence, rien d'inventé", () => {
  it("montre le motif du rejet, des compteurs à zéro réels et « non calculable » pour les colonnes", () => {
    const { container } = render(<PanneauDetailLot {...props({ detail: rejete() })} />);
    expect(screen.getByText("STATUT REJETE")).toBeInTheDocument();
    expect(screen.getByText("Lot rejeté :")).toBeInTheDocument();
    expect(screen.getByText(/32628 refusé/)).toBeInTheDocument();
    expect(screen.getByText(/Colonnes reconnues et inconnues : non calculable pour ce lot\./)).toBeInTheDocument();
    // Pas deux listes vides à la place de « inconnu ».
    expect(screen.queryByText(/Colonnes reconnues \(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Colonnes inconnues \(/)).not.toBeInTheDocument();
    // Le lot rejeté n'est jamais habillé de réussite ni d'attente d'application.
    expect(container.innerHTML).not.toMatch(/green|emerald|teal|lime/);
    expect(screen.queryByText(/en attente d'application/)).not.toBeInTheDocument();
    const t = screen.getByRole("table", { name: /Compteurs du contrôle du schéma/ });
    expect(within(t).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0", "0", "0", "0", "0"]);
  });

  it("un lot rejeté sans motif le dit au lieu de laisser une case vide", () => {
    const d = rejete();
    d.controle.motifRejetLot = null;
    render(<PanneauDetailLot {...props({ detail: d })} />);
    expect(screen.getByText(/le serveur n'a pas fourni de motif/)).toBeInTheDocument();
  });

  it("sans ligne rejetée ni ignorée : « Aucune ligne rejetée ni ignorée. »", () => {
    render(<PanneauDetailLot {...props({ detail: rejete() })} />);
    expect(screen.getByText("Aucune ligne rejetée ni ignorée.")).toBeInTheDocument();
  });
});

describe("Lot VALIDE_SCHEMA : conforme au contrat, pas appliqué", () => {
  it("dit en ambre « en attente d'application », sans aucune couleur de réussite", () => {
    const { container } = render(<PanneauDetailLot {...props()} />);
    const strong = screen.getByText("en attente d'application");
    const encart = strong.closest("p")!;
    expect(encart.className).toMatch(/amber/);
    expect(encart).toHaveTextContent("8 ligne(s) conformes au contrat, en attente d'application. Aucun objet n'a été créé.");
    expect(container.innerHTML).not.toMatch(/green|emerald|teal|lime/);
    expect(screen.queryByText("Lot rejeté :")).not.toBeInTheDocument();
  });

  it("n'affiche pas le même encart pour un lot reçu", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ statut: "RECU" }) })} />);
    expect(screen.queryByText("en attente d'application")).not.toBeInTheDocument();
  });
});

describe("Compteurs, colonnes, rejets, avertissements", () => {
  it("les compteurs réels sont un tableau légendé, sans colonne « importées »", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: controle({ compteurs: { lues: 12, validees: 7, rejetees: 3, enConflit: 1, ignorees: 1, importees: 0 } }) }) })} />);
    const t = screen.getByRole("table", { name: /Compteurs du contrôle du schéma/ });
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Lues", "Conformes", "Rejetées", "Ignorées", "En conflit"]);
    expect(within(t).getAllByRole("cell").map((c) => c.textContent)).toEqual(["12", "7", "3", "1", "1"]);
  });

  it("deux listes lisibles quand les colonnes sont calculées, avec « Aucune. » pour une liste réellement vide", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: controle({ colonnes: { reconnues: ["a", "b"], inconnues: [] } }) }) })} />);
    expect(screen.getByRole("heading", { name: "Colonnes reconnues (2)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Colonnes inconnues (0)" })).toBeInTheDocument();
    expect(screen.getByText("Aucune.")).toBeInTheDocument();
    expect(screen.queryByText(/non calculable pour ce lot/)).not.toBeInTheDocument();
  });

  it("les premiers rejets : ligne, statut, motif, puis « N autres dans le fichier d'erreurs »", () => {
    const c = controle({
      compteurs: { lues: 20, validees: 15, rejetees: 4, enConflit: 0, ignorees: 1, importees: 0 },
      premiersRejets: [
        { numeroLigne: 3, statut: "REJETEE", motif: "identifiant_source manquant" },
        { numeroLigne: 4, statut: "IGNOREE", motif: "doublon dans le lot" },
      ],
    });
    render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: c }) })} />);
    const t = screen.getByRole("table", { name: /Premiers rejets du lot/ });
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Ligne", "Statut", "Motif"]);
    expect(within(t).getByText("identifiant_source manquant")).toBeInTheDocument();
    expect(within(t).getByText("Rejetée")).toBeInTheDocument();
    expect(within(t).getByText("Ignorée")).toBeInTheDocument();
    expect(screen.getByText("3 autres dans le fichier d'erreurs.")).toBeInTheDocument();
  });

  it("sans « autres » quand tout est montré, et un motif absent est dit", () => {
    const c = controle({
      compteurs: { lues: 2, validees: 1, rejetees: 1, enConflit: 0, ignorees: 0, importees: 0 },
      premiersRejets: [{ numeroLigne: 2, statut: "REJETEE", motif: null }],
    });
    render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: c }) })} />);
    expect(screen.queryByText(/dans le fichier d'erreurs/)).not.toBeInTheDocument();
    expect(screen.getByText("Motif non fourni")).toBeInTheDocument();
  });

  it("les avertissements sont listés en ambre ; « Aucun avertissement. » sinon", () => {
    const { rerender } = render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: controle({ avertissements: ["Colonne « commentaire_libre » ignorée"] }) }) })} />);
    const item = screen.getByText("Colonne « commentaire_libre » ignorée");
    expect(item.closest("ul")!.className).toMatch(/amber/);
    rerender(<PanneauDetailLot {...props()} />);
    expect(screen.getByText("Aucun avertissement.")).toBeInTheDocument();
  });

  it("les valeurs d'un tiers (motif, colonne, avertissement) sont du texte", () => {
    const c = controle({
      motifRejetLot: "<img src=x onerror=alert(1)>",
      colonnes: { reconnues: ["<b>x</b>"], inconnues: [] },
      premiersRejets: [{ numeroLigne: 1, statut: "REJETEE", motif: "<script>alert(1)</script>" }],
      avertissements: ["<iframe src=x>"],
    });
    const { container } = render(<PanneauDetailLot {...props({ detail: lotDetail({ statut: "REJETE", controle: c }) })} />);
    expect(container.querySelector("img, b, script, iframe")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  });
});

describe("Télécharger le rapport des erreurs", () => {
  it("permis : un clic appelle le gestionnaire", async () => {
    const onTelechargerErreurs = vi.fn();
    render(<PanneauDetailLot {...props({ onTelechargerErreurs })} />);
    const b = screen.getByRole("button", { name: "Télécharger le rapport des erreurs" });
    expect(b).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(b);
    expect(onTelechargerErreurs).toHaveBeenCalledTimes(1);
  });

  it("non permis : inactif, la raison du SERVEUR est visible et reliée au bouton, le clic ne fait rien", async () => {
    const onTelechargerErreurs = vi.fn();
    render(<PanneauDetailLot {...props({ detail: rejete(), onTelechargerErreurs })} />);
    const b = screen.getByRole("button", { name: "Télécharger le rapport des erreurs" });
    expect(b).toHaveAttribute("aria-disabled", "true");
    const raison = screen.getByText("Aucune ligne rejetée ni ignorée : le fichier d'erreurs serait vide.");
    expect(b).toHaveAccessibleDescription(raison.textContent!);
    await userEvent.click(b);
    expect(onTelechargerErreurs).not.toHaveBeenCalled();
    // Reste atteignable au clavier : la raison se lit en tabulant.
    b.focus();
    expect(b).toHaveFocus();
  });

  it("action absente du serveur : inactif, avec une raison neutre", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ actionsPermises: [] }) })} />);
    expect(screen.getByRole("button", { name: "Télécharger le rapport des erreurs" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Le serveur ne propose pas ce téléchargement pour ce lot.")).toBeInTheDocument();
  });

  it("pendant le téléchargement : occupé, libellé changé, pas de double clic", async () => {
    const onTelechargerErreurs = vi.fn();
    render(<PanneauDetailLot {...props({ telechargementEnCours: true, onTelechargerErreurs })} />);
    const b = screen.getByRole("button", { name: /Téléchargement en cours/ });
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(b).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(b);
    expect(onTelechargerErreurs).not.toHaveBeenCalled();
  });
});

describe("Aperçu dans le panneau", () => {
  it("charge l'aperçu du lot par chargerApercu quand l'action est permise", async () => {
    const chargerApercu = vi.fn(async () => reponseApercu());
    render(<PanneauDetailLot {...props({ chargerApercu })} />);
    expect(await screen.findByRole("table", { name: /Aperçu des lignes du lot/ })).toBeInTheDocument();
    expect(chargerApercu).toHaveBeenCalledWith({ limite: 20 });
  });

  it("n'appelle pas le serveur quand l'action est refusée, et dit pourquoi", () => {
    const chargerApercu = vi.fn(async () => reponseApercu());
    render(<PanneauDetailLot {...props({ detail: rejete(), chargerApercu })} />);
    expect(chargerApercu).not.toHaveBeenCalled();
    expect(screen.getByText(/Le lot a été rejeté avant la lecture des lignes/)).toBeInTheDocument();
  });

  it("un autre lot recharge un aperçu neuf", async () => {
    const chargerApercu = vi.fn(async () => reponseApercu());
    const { rerender } = render(<PanneauDetailLot {...props({ chargerApercu })} />);
    await screen.findByRole("table", { name: /Aperçu/ });
    rerender(<PanneauDetailLot {...props({ chargerApercu, detail: lotDetail({ id: "lot-2", reference: "IMP-2026-00002" }) })} />);
    await waitFor(() => expect(chargerApercu).toHaveBeenCalledTimes(2));
  });
});

describe("Historique", () => {
  it("liste date, action et acteur, du plus ancien au plus récent", () => {
    const historique = [
      { date: "2026-10-15T08:00:00.000Z", action: "UPDATE", acteur: null, details: "Téléchargement du rapport" },
      { date: "2026-10-14T20:00:00.000Z", action: "CREATE", acteur: "Tidiane Diallo", details: null },
    ];
    render(<PanneauDetailLot {...props({ detail: lotDetail({ historique }) })} />);
    const items = within(screen.getByRole("list", { name: "Historique du lot" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Création");
    expect(items[0]).toHaveTextContent("par Tidiane Diallo");
    expect(items[1]).toHaveTextContent("Modification");
    expect(items[1]).toHaveTextContent("un acteur non renseigné");
    expect(items[1]).toHaveTextContent("Téléchargement du rapport");
  });

  it("un historique vide est dit, pas laissé blanc", () => {
    render(<PanneauDetailLot {...props({ detail: lotDetail({ historique: [] }) })} />);
    expect(screen.getByText("Aucun événement enregistré pour ce lot.")).toBeInTheDocument();
  });
});

describe("État des validations : aucune action d'approbation ni d'import", () => {
  it("dit, sans bouton, que ces actions ne sont pas proposées, avec les raisons du serveur", () => {
    render(<PanneauDetailLot {...props()} />);
    const encart = screen.getByRole("heading", { name: "État des validations" }).parentElement!;
    expect(encart).toHaveTextContent("Aucune action d'approbation de l'échantillon ni d'écriture au référentiel n'est proposée");
    expect(within(encart).queryAllByRole("button")).toHaveLength(0);
    expect(encart).toHaveTextContent("Aucun circuit d'approbation n'existe encore.");
    expect(encart).toHaveTextContent("L'écriture au référentiel n'a pas de circuit.");
  });

  it("n'expose nulle part un bouton d'approbation, de validation, d'import ou d'autorisation", () => {
    render(<PanneauDetailLot {...props()} />);
    const noms = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(noms.filter((n) => /approuv|valider|import|autoris|appliquer|écrire/i.test(n))).toEqual([]);
  });

  it("renderEtapes remplace la liste de secours quand l'intégrateur le fournit", () => {
    const renderEtapes = vi.fn(() => <p>INDICATEUR D'ETAPES</p>);
    render(<PanneauDetailLot {...props({ renderEtapes })} />);
    expect(screen.getByText("INDICATEUR D'ETAPES")).toBeInTheDocument();
    expect(renderEtapes).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "echantillon" })]), expect.objectContaining({ id: "lot-1" }));
    expect(screen.queryByText(/Aucun circuit d'approbation/)).not.toBeInTheDocument();
  });
});

describe("Cibles tactiles", () => {
  it("chaque bouton du panneau a une hauteur minimale de 44 px", async () => {
    render(<PanneauDetailLot {...props({ chargerApercu: apercuPret() })} />);
    await screen.findByRole("table", { name: /Aperçu/ });
    for (const b of screen.getAllByRole("button")) expect(b.className, b.textContent ?? "").toMatch(/min-h-\[44px\]/);
    for (const s of screen.getAllByRole("combobox")) expect(s.className).toMatch(/min-h-\[44px\]/);
  });
});

describe("Accessibilité (axe)", () => {
  it("détail d'un lot REJETE", async () => {
    const { container } = render(<PanneauDetailLot {...props({ detail: rejete() })} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("détail d'un lot VALIDE_SCHEMA, aperçu chargé, avertissements et rejets", async () => {
    const c = controle({
      avertissements: ["Colonne inconnue ignorée"],
      compteurs: { lues: 10, validees: 7, rejetees: 2, enConflit: 0, ignorees: 1, importees: 0 },
      premiersRejets: [{ numeroLigne: 3, statut: "REJETEE", motif: "identifiant_source manquant" }],
    });
    const { container } = render(<PanneauDetailLot {...props({ detail: lotDetail({ controle: c }), chargerApercu: apercuPret() })} />);
    await screen.findByRole("table", { name: /Aperçu/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("états vide, chargement et erreur", async () => {
    const vide = render(<PanneauDetailLot {...props({ detail: undefined })} />);
    expect(await violationsAccessibilite(vide.container)).toEqual([]);
    vide.unmount();
    const chargement = render(<PanneauDetailLot {...props({ detail: undefined, chargement: true })} />);
    expect(await violationsAccessibilite(chargement.container)).toEqual([]);
    chargement.unmount();
    const erreur = render(<PanneauDetailLot {...props({ detail: undefined, erreur: true, onReessayer: vi.fn() })} />);
    expect(await violationsAccessibilite(erreur.container)).toEqual([]);
  });
});
