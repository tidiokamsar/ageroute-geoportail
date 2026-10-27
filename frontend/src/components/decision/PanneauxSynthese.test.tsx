import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { PanneauBudget, PanneauQualite, PanneauRegions, PanneauRepartition, TITRE_PANNEAU_REGIONS } from "./PanneauxSynthese";
import { syntheseReelle, type NomReponse } from "./synthetique.testutil";
import { analyserSynthese, type SyntheseLue } from "../../lib/aideDecisionApi";
import { violationsAccessibilite } from "../../test/accessibilite";

const nette = (s: string | null) => (s ?? "").replace(/[\u00a0\u202f]/g, " ");
const lu = (nom: NomReponse = "nationale", surcharge: Record<string, unknown> = {}) => analyserSynthese(syntheseReelle(nom, surcharge)) as SyntheseLue;
const enRouteur = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("PanneauRepartition : etat du reseau (reponse reelle)", () => {
  const rendre = (s = lu()) => enRouteur(<PanneauRepartition section={s.repartitionEtat} periode="Période : état courant" situation="situation au 26/10/2026" onReessayer={() => {}} />);

  it("donne km ET %, pour chaque etat, dans un tableau (alternative texte de l'anneau)", () => {
    rendre();
    const t = screen.getByRole("table", { name: /Répartition de l'état du réseau/ });
    expect(within(t).getAllByRole("row").slice(1)).toHaveLength(6);
    const bon = within(t).getByRole("row", { name: /^Bon/ });
    expect(nette(bon.textContent)).toMatch(/70 km.*35 %.*9/);
    expect(nette(within(t).getByRole("row", { name: /^Moyen/ }).textContent)).toMatch(/80 km.*40 %.*8/);
    expect(screen.getByRole("img", { name: /Anneau de répartition/ })).toBeInTheDocument();
  });

  it("met les non evalues ET les etats non valides dans deux tranches DISTINCTES et nommees, exclues des taux", () => {
    rendre();
    const ne = screen.getByRole("row", { name: /Non évalué/ });
    expect(ne).toHaveAttribute("data-non-evalue", "oui");
    expect(nette(ne.textContent)).toMatch(/100 km.*exclu des taux.*12,5 % du périmètre.*10/);
    const nv = screen.getByRole("row", { name: /État non valide/ });
    expect(nette(nv.textContent)).toMatch(/500 km.*exclu des taux.*62,5 % du périmètre.*5/);
    // aucune des tranches evaluees ne porte les km des non evalues ou des etats non valides
    expect(nette(screen.getByRole("row", { name: /^Bon/ }).textContent)).not.toMatch(/(600|170|500|100) km/);
    expect(screen.getByText(/jamais assimilés à « bon »/)).toBeInTheDocument();
  });

  it("la somme des parts des classes vaut 100 % (rapportees aux seuls etats valides)", () => {
    rendre();
    const parts = ["Bon", "Moyen", "Mauvais", "Critique"].map((e) => Number(nette(screen.getByRole("row", { name: new RegExp(`^${e}`) }).querySelectorAll("td")[1].textContent).replace(/[^\d,]/g, "").replace(",", ".")));
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("dit la periode, la date de situation, la longueur a etat valide sur la longueur connue et les troncons sans longueur", () => {
    rendre();
    expect(screen.getByText(/Période : état courant/)).toBeInTheDocument();
    expect(screen.getByText(/situation au 26\/10\/2026/)).toBeInTheDocument();
    expect(nette(screen.getByText(/Longueur à état valide/).textContent)).toMatch(/200 km sur 800 km de longueur connue/);
    expect(screen.getByText(/2 tronçons sans longueur métier/)).toBeInTheDocument();
  });

  it("perimetre sans aucun troncon (reponse reelle vide) : etat vide explicite, pas un anneau de zeros", () => {
    rendre(lu("vide"));
    expect(screen.getByText("Aucun tronçon dans ce périmètre.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("des km inconnus s'affichent « Non disponible », jamais 0 km", () => {
    rendre(lu("nationale", { repartitionEtat: { ...(syntheseReelle().repartitionEtat as object), classes: [{ classe: "BON", km: null, troncons: 3, partPct: null }], nonEvalue: { km: null, troncons: 1, partDuPerimetre: null }, etatNonValide: { km: null, troncons: 0, partDuPerimetre: null } } }));
    const bon = screen.getByRole("row", { name: /^Bon/ });
    expect(bon).toHaveTextContent("Non disponible");
    expect(nette(bon.textContent)).not.toMatch(/(^|\D)0 km/);
    expect(screen.getByText(/km non disponibles/)).toBeInTheDocument();
  });

  it("section mal formee : reponse inattendue, role alert, Reessayer au nom unique", async () => {
    const onReessayer = vi.fn();
    enRouteur(<PanneauRepartition section={{ ok: false }} periode="p" situation="s" onReessayer={onReessayer} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/État du réseau : réponse inattendue/);
    await userEvent.click(screen.getByRole("button", { name: "Réessayer : état du réseau" }));
    expect(onReessayer).toHaveBeenCalled();
  });
});

describe("PanneauRegions : part du reseau degrade, pas un score de priorite (reponse reelle)", () => {
  const rendre = (s = lu(), onFiltres = vi.fn(), filtres = {}) => {
    enRouteur(<PanneauRegions section={s.degradationParRegion} filtres={filtres} onFiltres={onFiltres} onReessayer={() => {}} />);
    return onFiltres;
  };

  it("porte un libelle honnete et la mention du SERVEUR (« PAS un score de priorité »)", () => {
    rendre();
    expect(screen.getByRole("heading", { name: TITRE_PANNEAU_REGIONS })).toBeInTheDocument();
    expect(TITRE_PANNEAU_REGIONS).not.toMatch(/priorit/i);
    expect(screen.getByText(/PAS un score de priorité/)).toBeInTheDocument();
  });

  it("classe par part degradee decroissante : Boké 30 %, Kindia 20 %", () => {
    rendre();
    const noms = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(noms).toEqual(["Filtrer sur la région Boké", "Filtrer sur la région Kindia"]);
    expect(nette(screen.getByTestId("degrade-1").textContent)).toBe("30 %");
    expect(nette(screen.getByTestId("degrade-2").textContent)).toBe("20 %");
  });

  it("une region sans taux (partDegradeePct null) est « Non calculable », en fin de liste, jamais 0 %", () => {
    const brut = syntheseReelle().degradationParRegion as { mention: string; regions: Record<string, unknown>[] };
    rendre(lu("nationale", { degradationParRegion: { ...brut, regions: [{ ...brut.regions[0], regionId: 7, regionNom: null, partDegradeePct: null, eligibleKm: 0, nonEvalueKm: 30 }, ...brut.regions] } }));
    const boutons = screen.getAllByRole("button");
    expect(boutons.at(-1)).toHaveAttribute("aria-label", "Filtrer sur la région Région n° 7");
    expect(screen.getByTestId("degrade-7")).toHaveTextContent("Non calculable");
    expect(boutons.at(-1)).toHaveTextContent("Aucun tronçon à état valide dans cette région");
  });

  it("montre la couverture de chaque region et les troncons sans longueur", () => {
    rendre();
    expect(nette(screen.getByRole("button", { name: /Boké/ }).textContent)).toMatch(/Longueur : 100 km à état valide, 100 km non évalués, sur 200 km de longueur connue.*2 tronçons sans longueur métier/);
    expect(nette(screen.getByRole("button", { name: /Kindia/ }).textContent)).toMatch(/Longueur : 100 km à état valide/);
  });

  it("cliquer une region filtre dessus en conservant les autres filtres", async () => {
    const onFiltres = rendre(lu(), vi.fn(), { etat: ["CRITIQUE"] });
    await userEvent.click(screen.getByRole("button", { name: /Boké/ }));
    expect(onFiltres).toHaveBeenCalledWith({ etat: ["CRITIQUE"], regionId: 1 });
  });

  it("liste vide : etat vide explicite", () => {
    rendre(lu("nationale", { degradationParRegion: { mention: "m", regions: [] } }));
    expect(screen.getByText("Aucune région dans ce périmètre.")).toBeInTheDocument();
  });
});

describe("PanneauBudget : quatre montants separes (reponse reelle)", () => {
  const rendre = (s = lu()) => enRouteur(<PanneauBudget section={s.budget} onReessayer={() => {}} />);
  const bloc = (l: string) => document.querySelector(`[data-montant="${l}"]`) as HTMLElement;

  it("affiche contractuel, engage, decaisse et previsionnel SEPARES, chacun avec son etat", () => {
    rendre();
    expect(["Contractuel", "Engagé", "Décaissé", "Prévisionnel"].map((l) => bloc(l).dataset.etat)).toEqual(["PARTIEL", "NON_DISPONIBLE", "DISPONIBLE", "DISPONIBLE"]);
  });

  it("montre le montant contractuel SANS perte de precision (chaine, pas flottant)", () => {
    rendre();
    expect(nette(bloc("Contractuel").textContent)).toContain("9 007 199 254 740 993 GNF");
    expect(nette(bloc("Décaissé").textContent)).toContain("1 000 GNF");
    expect(nette(bloc("Prévisionnel").textContent)).toContain("777 GNF");
  });

  it("le budget engage NON_DISPONIBLE dit « Non disponible » avec la raison du serveur, jamais 0 GNF", () => {
    rendre();
    const engage = bloc("Engagé");
    expect(engage).toHaveTextContent("Non disponible");
    expect(engage).toHaveTextContent(/source financière de référence non validée \(B-08, ADR-003\)/);
    expect(nette(engage.textContent)).not.toMatch(/0 GNF/);
  });

  it("un montant PARTIEL montre sa valeur et son avertissement", () => {
    rendre();
    expect(bloc("Contractuel")).toHaveTextContent(/1 marché sans montant saisi/);
  });

  it("COMPTE SANS DROIT FINANCIER : NON_AUTORISE est affiche « Non autorisé », pas « réponse inattendue » ni « Non disponible »", () => {
    rendre(lu("regionaleSansDroits"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    for (const l of ["Contractuel", "Décaissé", "Prévisionnel"]) {
      expect(bloc(l).dataset.etat).toBe("NON_AUTORISE");
      expect(bloc(l)).toHaveTextContent("Non autorisé");
      expect(bloc(l)).not.toHaveTextContent("Non disponible");
      expect(nette(bloc(l).textContent)).not.toMatch(/GNF$|\d GNF/);
    }
    expect(bloc("Engagé").dataset.etat).toBe("NON_DISPONIBLE");
    // la ventilation par bailleur dit aussi le refus de droit, au lieu d'un vide
    expect(screen.getByText(/Budget par bailleur : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("ne montre pas le montant d'un etat NON_DISPONIBLE ni NON_AUTORISE meme si une valeur est jointe", () => {
    const brut = syntheseReelle().budget as Record<string, unknown>;
    rendre(lu("nationale", { budget: { ...brut, engage: { etat: "NON_DISPONIBLE", valeurGnf: "123456", source: "s", avertissement: null }, decaisse: { etat: "NON_AUTORISE", valeurGnf: "654321", source: null, avertissement: null } } }));
    expect(nette(bloc("Engagé").textContent)).not.toContain("123 456");
    expect(nette(bloc("Décaissé").textContent)).not.toContain("654 321");
  });

  it("bailleurs : montants CONTRACTUELS etiquetes comme tels, tries, parts sur le TOTAL contractuel", () => {
    rendre();
    expect(screen.getByRole("heading", { name: /montants contractuels/i })).toBeInTheDocument();
    expect(screen.getByText(/ni des montants engagés ni des montants décaissés/)).toBeInTheDocument();
    const lignes = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(lignes[0]).toHaveTextContent("Bailleur A");
    expect(nette(lignes[0].textContent)).toMatch(/9 007,2 T GNF.*99,9 %.*2/);
    expect(lignes[1]).toHaveTextContent("Bailleur non renseigné");
    expect(nette(lignes[1].textContent)).toMatch(/993 GNF.*0 %.*2/);
    // l'avertissement du serveur sur les marches sans bailleur ou hors GNF reste visible
    expect(screen.getByText(/1 marché sans montant saisi, jamais comptés comme 0/)).toBeInTheDocument();
  });

  it("liste TRONQUEE : la ligne « Autres bailleurs » existe et les parts restent calculees sur le total, pas sur les lignes affichees", () => {
    rendre(lu("tronque"));
    const lignes = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toHaveTextContent("Bailleur A");
    const autres = lignes[1];
    expect(autres).toHaveAttribute("data-ligne", "autres");
    expect(autres).toHaveTextContent("Autres bailleurs (2)");
    expect(nette(autres.textContent)).toMatch(/993 GNF/);
    // la part de A est 99,9 % du total, pas 100 % de la seule ligne affichee
    expect(nette(lignes[0].textContent)).toMatch(/99,9 %/);
    expect(nette(lignes[0].textContent)).not.toMatch(/100 %/);
    expect(screen.getByText(/Liste limitée aux 20 bailleurs/)).toBeInTheDocument();
  });

  it("bailleur SANS montant GNF : « Montant non disponible », jamais 0 ; ses marches restent comptes ; pas de part ; les autres parts sont inchangees", () => {
    rendre(lu("bailleurSansMontant"));
    const lignes = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(lignes).toHaveLength(2);
    const sans = lignes[1];
    expect(sans).toHaveTextContent("Bailleur sans montant");
    expect(sans).toHaveTextContent("Montant non disponible");
    expect(sans.querySelector("[data-montant-inconnu]")).not.toBeNull();
    expect(nette(sans.textContent)).toMatch(/Non disponible.*3$/);
    expect(nette(sans.textContent)).not.toMatch(/(^|\D)0 (GNF|%)/);
    expect(nette(lignes[0].textContent)).toMatch(/9 007,2 T GNF.*100 %.*2/);
  });

  it("liste tronquee dont « Autres bailleurs » n'a aucun montant : « Montant non disponible », marches comptes", () => {
    rendre(lu("tronqueAutresSansMontant"));
    const autres = document.querySelector('[data-ligne="autres"]') as HTMLElement;
    expect(autres).toHaveTextContent("Autres bailleurs (2)");
    expect(autres).toHaveTextContent("Montant non disponible");
    expect(autres).toHaveTextContent("Non disponible");
    expect(nette(autres.textContent)).toMatch(/2$/);
  });

  it("sans total contractuel lisible, les parts ne sont pas calculees (dit), jamais deduites des lignes", () => {
    const brut = syntheseReelle().budget as { contractuel: Record<string, unknown> };
    rendre(lu("nationale", { budget: { ...brut, contractuel: { ...brut.contractuel, etat: "NON_DISPONIBLE", valeurGnf: null } } }));
    expect(screen.getByText(/Total contractuel non disponible : les parts ne sont pas calculées/)).toBeInTheDocument();
    const lignes = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(lignes[0]).toHaveTextContent("Non disponible");
  });

  it("aucun marche (reponse reelle vide) : etat vide explicite avec l'avertissement du serveur", () => {
    rendre(lu("vide"));
    expect(screen.getByText("Aucune ventilation par bailleur disponible.")).toBeInTheDocument();
    expect(screen.getAllByText(/Aucun marché saisi dans ce périmètre/).length).toBeGreaterThan(0);
    expect(bloc("Contractuel")).toHaveTextContent("Non disponible");
  });

  it("section mal formee : reponse inattendue", () => {
    enRouteur(<PanneauBudget section={{ ok: false }} onReessayer={() => {}} />);
    expect(screen.getByRole("button", { name: "Réessayer : budget" })).toBeInTheDocument();
  });
});

describe("PanneauQualite (reponse reelle)", () => {
  const rendre = (s = lu()) => enRouteur(<PanneauQualite section={s.qualite} onReessayer={() => {}} />);

  it("resume les anomalies, les troncons examines et les gravites du serveur, avec un lien vers la liste", () => {
    rendre();
    expect(screen.getByText(/13 anomalies détectées/)).toBeInTheDocument();
    expect(screen.getByText(/sur 37 tronçons examinés/)).toBeInTheDocument();
    expect(screen.getByText("Bloquantes : 0")).toBeInTheDocument();
    expect(screen.getByText("À traiter : 3")).toBeInTheDocument();
    expect(screen.getByText("À surveiller : 10")).toBeInTheDocument();
    expect(screen.getByText(/Données à confirmer.*13/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Qualité des données/ })).toHaveAttribute("href", "/qualite");
  });

  it("familles non executees : le nombre est une BORNE BASSE, dit", () => {
    const q = syntheseReelle().qualite as Record<string, unknown>;
    rendre(lu("nationale", { qualite: { ...q, etat: "PARTIEL", famillesNonExecutees: ["REGION", "DOUBLON"] } }));
    expect(screen.getByText(/Au moins 13 anomalies/)).toBeInTheDocument();
    expect(screen.getByTestId("qualite-borne-basse")).toHaveTextContent(/REGION, DOUBLON.*borne basse/);
  });

  it("un nombre d'anomalies inconnu (perimetre vide) n'est pas « aucune anomalie »", () => {
    rendre(lu("vide"));
    expect(screen.queryByText(/Aucune anomalie/)).not.toBeInTheDocument();
  });

  it("un zero envoye par le serveur se dit « aucune anomalie détectée »", () => {
    const q = syntheseReelle().qualite as Record<string, unknown>;
    rendre(lu("nationale", { qualite: { ...q, total: 0, parGravite: { BLOQUANTE: 0, A_TRAITER: 0, A_SURVEILLER: 0 } } }));
    expect(screen.getByText("Aucune anomalie détectée dans ce périmètre.")).toBeInTheDocument();
  });

  it("total null : « Non disponible », pas zero", () => {
    const q = syntheseReelle().qualite as Record<string, unknown>;
    rendre(lu("nationale", { qualite: { ...q, total: null, parGravite: null } }));
    expect(screen.getByText(/Non disponible/)).toBeInTheDocument();
    expect(screen.queryByText(/Aucune anomalie/)).not.toBeInTheDocument();
  });
});

describe("accessibilite de la zone de synthese", () => {
  it.each(["nationale", "regionaleSansDroits", "tronque", "vide"] as const)("passe axe (reponse reelle %s)", async (nom) => {
    const s = lu(nom);
    const { container } = enRouteur(
      <>
        <PanneauRepartition section={s.repartitionEtat} periode="p" situation="s" onReessayer={() => {}} />
        <PanneauRegions section={s.degradationParRegion} filtres={{}} onFiltres={() => {}} onReessayer={() => {}} />
        <PanneauBudget section={s.budget} onReessayer={() => {}} />
        <PanneauQualite section={s.qualite} onReessayer={() => {}} />
      </>,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
