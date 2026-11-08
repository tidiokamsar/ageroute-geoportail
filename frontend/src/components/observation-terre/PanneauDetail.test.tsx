import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { usePropositionDetail } from "../../lib/teledetectionHooks";
import type { PropositionDetail } from "../../lib/teledetectionApi";
import { PanneauDetail } from "./PanneauDetail";
import { rendreAvecClient } from "./rendre.testutil";
import { detail, echec, echecBlob, routeurGet } from "./synthetique.testutil";

/**
 * Panneau Detail et decisions.
 * Defendu : quatre indicateurs de qualite SEPARES, limites et provenance visibles, image absente dite
 * absente, motif obligatoire, corps exact des transitions, roles (le serveur decide), verdict definitif.
 */

function Harnais({ profil, onFermer = () => {} }: { profil: string; onFermer?: () => void }) {
  const q = usePropositionDetail("p-1");
  return <PanneauDetail detail={q} role={profil} onFermer={onFermer} />;
}

const NOM = "inondation GN N0001 · Conakry - Coyah";
const OBSERVATIONS = [
  { id: "o-1", date: "2026-10-22T09:00:00Z", auteur: "Agent A", resume: "Chaussée submergée sur 200 m" },
  { id: "o-2", date: "2026-10-23T09:00:00Z", auteur: "Agent B", resume: "Eau retirée" },
];

function servir(d: PropositionDetail | Error) {
  h.get.mockImplementation(routeurGet({ "/v2/teledetection/propositions/p-1": d }));
}
async function ouvrir(role = "GESTIONNAIRE") {
  const r = rendreAvecClient(<Harnais profil={role} />);
  await screen.findByRole("heading", { name: "Détail de la proposition" });
  await screen.findByText("Indicateurs de qualité", undefined, { timeout: 5000 }).catch(() => {});
  return r;
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:essai") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("contenu du detail", () => {
  it("quatre indicateurs de qualite separes, chacun avec ce qu'il mesure", async () => {
    servir(detail());
    await ouvrir();
    const zone = await screen.findByRole("region", { name: "Indicateurs de qualité" });
    for (const dt of ["Confiance de détection", "Qualité de l'image", "Confiance du rattachement au tronçon", "Priorité d'inspection"]) {
      expect(within(zone).getByText(dt, { selector: "dt" })).toBeInTheDocument();
    }
    expect(within(zone).getByText("indice 0,87")).toBeInTheDocument();
    expect(within(zone).getByText("Indice de la méthode, non calibré : pas une probabilité.")).toBeInTheDocument();
    expect(within(zone).getByText("12 % de nuages")).toBeInTheDocument();
    expect(within(zone).getByText("Rattachement de confiance haute")).toBeInTheDocument();
    expect(within(zone).getByText(/Distance au tronçon : 18 m/)).toBeInTheDocument();
    expect(within(zone).getByText(/Règle : Type inondation sur un tronçon classé RN/)).toBeInTheDocument();
    // Aucune note unique fusionnee.
    expect(document.body.textContent).not.toMatch(/score global|note globale/i);
  });

  it("fiche : source, dates d'acquisition et de reference, resolution native, methode et version, statut", async () => {
    servir(detail());
    await ouvrir();
    const fiche = (await screen.findByText("Résolution native")).closest("dl") as HTMLElement;
    expect(within(fiche).getByText("Source A · Capteur A")).toBeInTheDocument();
    expect(within(fiche).getByText("20 oct. 2026")).toBeInTheDocument();
    expect(within(fiche).getByText("15 sept. 2026")).toBeInTheDocument();
    expect(within(fiche).getByText("10 m")).toBeInTheDocument();
    expect(within(fiche).getByText("seuil-sar (version 0)")).toBeInTheDocument();
    expect(screen.getByText("À vérifier", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("GN N0001 · Conakry - Coyah")).toBeInTheDocument();
  });

  it("limites connues : celles du serveur ET la limite de resolution native ; vide du serveur dit", async () => {
    servir(detail());
    await ouvrir();
    const limites = (await screen.findByRole("heading", { name: "Limites connues" })).closest("section") as HTMLElement;
    expect(within(limites).getByText(/Rien n'est affirmé au-delà de la résolution native de 10 m/)).toBeInTheDocument();
    expect(within(limites).getByText("Un nuage résiduel peut produire une fausse détection.")).toBeInTheDocument();
  });

  it("aucune limite fournie par le serveur : la mention le dit, elle n'est pas omise", async () => {
    servir(detail({ limites: [] }));
    await ouvrir();
    expect(await screen.findByText(/n'a fourni aucune limite propre à cette proposition/)).toBeInTheDocument();
  });

  it("limites NULL (ligne d'avant la migration) : « Limites non renseignées pour cette proposition », jamais « aucune limite »", async () => {
    servir(detail({ limites: null, limitesNonRenseignees: true }));
    await ouvrir();
    const limites = (await screen.findByRole("heading", { name: "Limites connues" })).closest("section") as HTMLElement;
    expect(within(limites).getByTestId("limites-non-renseignees")).toHaveTextContent("Limites non renseignées pour cette proposition");
    expect(within(limites).queryByText(/aucune limite/i)).not.toBeInTheDocument();
    // la limite de resolution reste dite (elle vient de la source, pas de la colonne vide)
    expect(within(limites).getByText(/Rien n'est affirmé au-delà de la résolution native de 10 m/)).toBeInTheDocument();
  });

  it("limites renseignees : pas de mention « non renseignees »", async () => {
    servir(detail({ limitesNonRenseignees: false }));
    await ouvrir();
    await screen.findByRole("heading", { name: "Limites connues" });
    expect(screen.queryByTestId("limites-non-renseignees")).not.toBeInTheDocument();
  });

  it("resolution de repli (PRODUIT_LIVRE) et capteur de repli (SOURCE) : l'origine est dite, ce n'est pas presente comme native", async () => {
    servir(detail({ source: { code: "SRC-A", nom: "Source A", capteur: "Capteur A", resolutionM: 20, resolutionOrigine: "PRODUIT_LIVRE", capteurOrigine: "SOURCE" } }));
    await ouvrir();
    const fiche = (await screen.findByText("Résolution du produit livré")).closest("dl") as HTMLElement;
    expect(within(fiche).queryByText("Résolution native")).not.toBeInTheDocument();
    expect(within(fiche).getByTestId("origine-resolution")).toHaveTextContent(/résolution du produit livré, ce n'est pas la résolution native du capteur/);
    expect(within(fiche).getByTestId("origine-resolution")).toHaveTextContent(/capteur de la source, le produit n'en indique pas/);
    const limites = screen.getByRole("heading", { name: "Limites connues" }).closest("section") as HTMLElement;
    expect(within(limites).getByText(/résolution du produit livré \(qui n'est pas la résolution native\) de 20 m/)).toBeInTheDocument();
  });

  it("resolution native du produit (NATIVE_PRODUIT) : intitule « Résolution native », aucune mention de repli", async () => {
    servir(detail({ source: { code: "SRC-A", nom: "Source A", capteur: "Capteur A", resolutionM: 10, resolutionOrigine: "NATIVE_PRODUIT", capteurOrigine: "PRODUIT" } }));
    await ouvrir();
    expect(await screen.findByText("Résolution native")).toBeInTheDocument();
    expect(screen.queryByTestId("origine-resolution")).not.toBeInTheDocument();
  });

  it("observations hors perimetre : « N observation(s) hors de votre périmètre ne sont pas affichées », dans l'onglet Terrain", async () => {
    servir(detail({ terrain: { observations: OBSERVATIONS.slice(0, 1), observationsMasquees: 3 } }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Terrain" }));
    expect(await screen.findByTestId("observations-masquees")).toHaveTextContent("3 observations hors de votre périmètre ne sont pas affichées.");
    expect(screen.getByText("Chaussée submergée sur 200 m")).toBeInTheDocument();
  });

  it("une seule observation masquee, aucune visible : le vide dit « aucune observation visible dans votre périmètre », pas « aucune observation liée »", async () => {
    servir(detail({ terrain: { observations: [], observationsMasquees: 1 } }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Terrain" }));
    expect(await screen.findByTestId("observations-masquees")).toHaveTextContent("1 observation hors de votre périmètre n'est pas affichée.");
    expect(screen.getByText("Aucune observation visible dans votre périmètre")).toBeInTheDocument();
    expect(screen.queryByText("Aucune observation de terrain liée")).not.toBeInTheDocument();
  });

  it("observations masquees : le formulaire de verdict le dit aussi, sans les compter comme preuves", async () => {
    servir(detail({ terrain: { observations: [], observationsMasquees: 2 } }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    expect(screen.getByText("2 observations hors de votre périmètre ne sont pas affichées.")).toBeInTheDocument();
  });

  it("aucune observation masquee : aucune mention", async () => {
    servir(detail({ terrain: { observations: OBSERVATIONS, observationsMasquees: 0 } }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Terrain" }));
    await screen.findByText("Chaussée submergée sur 200 m");
    expect(screen.queryByTestId("observations-masquees")).not.toBeInTheDocument();
  });

  it("provenance : fournisseur, identifiant, licence, attribution, traitement, empreinte ; absent = « Non renseigné »", async () => {
    servir(detail());
    await ouvrir();
    const prov = (await screen.findByText("Provenance")).closest("details") as HTMLElement;
    expect(within(prov).getByText("Fournisseur A")).toBeInTheDocument();
    expect(within(prov).getByText("ID-123")).toBeInTheDocument();
    expect(within(prov).getByText("Licence A")).toBeInTheDocument();
    expect(within(prov).getByText("t1")).toBeInTheDocument();
    expect(within(prov).getByText("Non calculée")).toBeInTheDocument();
  });

  it("proposition non rattachee : « Anomalie non rattachée » et reserve sur le troncon candidat", async () => {
    servir(detail({ rattachee: true, rattachement: { confiance: "FAIBLE", distanceM: 900, algorithme: "a" } }));
    await ouvrir();
    expect(await screen.findByText("Anomalie non rattachée")).toBeInTheDocument();
    expect(screen.getByText(/Tronçon candidat : GN N0001/)).toBeInTheDocument();
  });
});

describe("onglets Apercu, Comparaison, Terrain, Historique", () => {
  it("tablist accessible, Apercu selectionne, fleches pour naviguer", async () => {
    servir(detail());
    const u = userEvent.setup();
    await ouvrir();
    const tabs = await screen.findAllByRole("tab", { name: /Aperçu|Comparaison|Terrain|Historique/ });
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Aperçu" })).toHaveAttribute("aria-selected", "true");
    screen.getByRole("tab", { name: "Aperçu" }).focus();
    await u.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Comparaison" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "onglet-detail-comparaison");
  });

  it("apercu absent : l'absence est dite, aucune image n'est rendue", async () => {
    servir(detail());
    await ouvrir();
    expect(await screen.findByText("Aucun aperçu disponible")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("apercu present : charge par le client authentifie (blob), alt descriptif, date", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === "/v2/teledetection/produits/prod-1/apercu") return { data: new Blob(["x"], { type: "image/png" }) };
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/api/v2/teledetection/produits/prod-1/apercu", date: "2026-10-20T10:00:00Z" } } }) };
    });
    await ouvrir();
    // Le composant est correct (mesure : 60 a 170 ms isole). Le delai par defaut de 1 s de findByRole, qui calcule le
    // nom accessible de tout le DOM, expire quand la machine est chargee (suites en parallele) : meme delai que les
    // autres attentes asynchrones du fichier, l'assertion d'accessibilite (role img + nom descriptif) est inchangee.
    const img = await screen.findByRole("img", { name: /Vue satellite après le changement \(inondation\), acquise le/ }, { timeout: 8000 });
    expect(img).toHaveAttribute("src", "blob:essai");
    expect(h.get).toHaveBeenCalledWith("/v2/teledetection/produits/prod-1/apercu", { responseType: "blob" });
    expect(screen.getByText(/seul le terrain le confirme/)).toBeInTheDocument();
  });

  it("apercu en erreur (panne du serveur) : alerte, pas d'image de remplacement", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/apercu")) throw echec(500, "Erreur interne");
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/v2/teledetection/produits/prod-1/apercu", date: null } } }) };
    });
    await ouvrir();
    expect(await screen.findByText(/L'aperçu n'a pas pu être chargé/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("apercu dont l'URL existe mais repond 404 APERCU_INDISPONIBLE : « indisponible chez le fournisseur », pas l'erreur generique", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/apercu")) throw echec(404, "Aperçu indisponible : le fournisseur a répondu 404", "APERCU_INDISPONIBLE");
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/api/v2/teledetection/produits/prod-1/apercu", date: null } } }) };
    });
    await ouvrir();
    expect(await screen.findByText("Aperçu indisponible chez le fournisseur")).toBeInTheDocument();
    expect(screen.queryByText(/rouvrant la proposition|n'a pas pu être chargé/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("apercu : 404 APERCU_INDISPONIBLE rendu en BLOB (forme reelle d'axios en responseType blob) : « indisponible chez le fournisseur »", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/apercu")) throw echecBlob(404, { error: "Aperçu indisponible : le fournisseur a répondu 404", code: "APERCU_INDISPONIBLE" });
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/api/v2/teledetection/produits/prod-1/apercu", date: null } } }) };
    });
    await ouvrir();
    expect(await screen.findByText("Aperçu indisponible chez le fournisseur")).toBeInTheDocument();
    expect(screen.queryByText(/rouvrant la proposition|n'a pas pu être chargé/)).not.toBeInTheDocument();
  });

  it("apercu : une panne 500 rendue en Blob reste l'erreur generique (jamais « indisponible chez le fournisseur »)", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/apercu")) throw echecBlob(500, { error: "Erreur interne" });
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/api/v2/teledetection/produits/prod-1/apercu", date: null } } }) };
    });
    await ouvrir();
    expect(await screen.findByText(/L'aperçu n'a pas pu être chargé/)).toBeInTheDocument();
    expect(screen.queryByText("Aperçu indisponible chez le fournisseur")).not.toBeInTheDocument();
  });

  it("apercu : reponse 200 dont le contenu n'est pas une image (HTML de repli) : « aperçu illisible », jamais affiche comme image", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/apercu")) return { data: new Blob(["<!doctype html><html></html>"], { type: "text/html" }) };
      return { data: detail({ apercus: { avant: { url: null, date: null }, apres: { url: "/api/v2/teledetection/produits/prod-1/apercu", date: null } } }) };
    });
    await ouvrir();
    expect(await screen.findByText(/Aperçu illisible/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("comparaison : un cote dont le contenu n'est pas une image est dit illisible, l'autre reste affiche", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.includes("avant")) return { data: new Blob(["<html></html>"], { type: "text/html" }) };
      if (url.endsWith("/apercu")) return { data: new Blob(["x"], { type: "image/png" }) };
      return { data: detail({ apercus: { avant: { url: "/api/v2/teledetection/produits/avant/apercu", date: null }, apres: { url: "/api/v2/teledetection/produits/apres/apercu", date: null } } }) };
    });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Comparaison" }));
    expect(await screen.findByText(/Image avant illisible/, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /vignette satellite après/ })).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByText(/Comparaison impossible : l'image avant est illisible/)).toBeInTheDocument();
  });

  it("comparaison : seule l'image avant est indisponible chez le fournisseur : l'image apres reste affichee, le curseur est desactive et dit pourquoi", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.includes("avant")) throw echec(404, "Aperçu indisponible", "APERCU_INDISPONIBLE");
      if (url.endsWith("/apercu")) return { data: new Blob(["x"], { type: "image/png" }) };
      return { data: detail({ apercus: { avant: { url: "/api/v2/teledetection/produits/avant/apercu", date: "2026-09-15T10:00:00Z" }, apres: { url: "/api/v2/teledetection/produits/apres/apercu", date: "2026-10-20T10:00:00Z" } } }) };
    });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Comparaison" }));
    expect(await screen.findByText("Image avant indisponible chez le fournisseur", undefined, { timeout: 5000 })).toBeInTheDocument();
    const img = screen.getByRole("img", { name: /vignette satellite après/ });
    expect(img).toHaveAttribute("src", "blob:essai");
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByText(/Comparaison impossible : l'image avant est indisponible chez le fournisseur/)).toBeInTheDocument();
  });

  it("comparaison : une panne autre que 404 sur l'image avant n'efface pas l'image apres non plus", async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.includes("avant")) throw echec(500, "Erreur interne");
      if (url.endsWith("/apercu")) return { data: new Blob(["x"], { type: "image/png" }) };
      return { data: detail({ apercus: { avant: { url: "/api/v2/teledetection/produits/avant/apercu", date: null }, apres: { url: "/api/v2/teledetection/produits/apres/apercu", date: null } } }) };
    });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Comparaison" }));
    expect(await screen.findByText("Image avant impossible à charger", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /vignette satellite après/ })).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeDisabled();
  });

  it("comparaison : les deux images absentes sont dites absentes par le composant de comparaison", async () => {
    servir(detail());
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Comparaison" }));
    expect(await screen.findByText(/Image avant non disponible/)).toBeInTheDocument();
    expect(screen.getByText(/Image après non disponible/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("terrain : observations liees et mission ; sinon absence dite", async () => {
    servir(detail({ terrain: { observations: OBSERVATIONS }, mission: { id: "M-7", statut: "EN_COURS", assigneNom: "Agent A" }, missionId: "M-7" }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Terrain" }));
    expect(await screen.findByText("Chaussée submergée sur 200 m")).toBeInTheDocument();
    expect(screen.getByText(/Mission de vérification/)).toHaveTextContent("M-7");
    expect(screen.getByText(/affectée à Agent A/)).toBeInTheDocument();
  });

  it("terrain sans observation ni mission : etat vide explicite", async () => {
    servir(detail());
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Terrain" }));
    expect(await screen.findByText("Aucune observation de terrain liée")).toBeInTheDocument();
    expect(screen.getByText(/Aucune mission de vérification n'est liée/)).toBeInTheDocument();
  });

  it("historique : auteur, date, motif et commentaire de chaque transition ; sinon etat vide", async () => {
    servir(detail({ statut: "EN_ATTENTE", historique: [{ de: "A_VERIFIER", vers: "EN_ATTENTE", auteur: { id: "u", nom: "Chef Dupont" }, date: "2026-10-21T08:30:00Z", motif: "Image floue", commentaire: "Attendre le prochain passage" }] }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Historique" }));
    const liste = await screen.findByRole("list", { name: "Historique des décisions" });
    expect(liste).toHaveTextContent("Chef Dupont");
    expect(liste).toHaveTextContent("À vérifier vers En attente");
    expect(liste).toHaveTextContent("Motif : Image floue");
    expect(liste).toHaveTextContent("Commentaire : Attendre le prochain passage");
  });

  it("historique vide : « Aucune décision enregistrée »", async () => {
    servir(detail());
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("tab", { name: "Historique" }));
    expect(await screen.findByText("Aucune décision enregistrée")).toBeInTheDocument();
  });
});

describe("decisions : formulaire, corps envoye, roles", () => {
  it("boutons au nom accessible distinct par proposition, uniquement pour ADMIN et GESTIONNAIRE", async () => {
    servir(detail());
    await ouvrir("GESTIONNAIRE");
    expect(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Infirmer la proposition ${NOM}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Mettre en attente la proposition ${NOM}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Demander des informations sur la proposition ${NOM}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Affecter à une inspection la proposition ${NOM}` })).toBeInTheDocument();
  });

  it.each(["LECTEUR", "INSPECTEUR"])("%s : aucune action de decision, un message de consultation seule", async (role) => {
    servir(detail());
    await ouvrir(role);
    expect(await screen.findByText(/Consultation seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Confirmer|Infirmer|Mettre en attente|Demander|Affecter|Non concluante|Remettre)/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Décision")).not.toBeInTheDocument();
    if (role === "INSPECTEUR") expect(screen.getByText(/mission d'inspection qui vous est affectée/)).toBeInTheDocument();
  });

  it("le motif est obligatoire : l'envoi reste inactif sans lui, puis le corps exact part au serveur", async () => {
    servir(detail({ terrain: { observations: OBSERVATIONS } }));
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    const formulaire = screen.getByRole("group", { name: /Confirmer : formulaire de décision/ });
    const envoyer = within(formulaire).getByRole("button", { name: "Enregistrer la décision" });
    expect(envoyer).toBeDisabled();
    const motif = within(formulaire).getByLabelText(/Motif/);
    expect(motif).toBeRequired();
    await u.type(motif, "   ");
    expect(envoyer).toBeDisabled(); // des espaces ne sont pas un motif
    await u.type(motif, "Chaussée submergée constatée");
    await u.type(within(formulaire).getByLabelText(/Commentaire/), "Photos jointes");
    await u.click(within(formulaire).getByRole("checkbox", { name: /Chaussée submergée sur 200 m/ }));
    expect(envoyer).toBeEnabled();
    await u.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", {
      vers: "CONFIRMEE", motif: "Chaussée submergée constatée", commentaire: "Photos jointes", observationIds: ["o-1"],
    }));
    expect(await screen.findByText(/Décision enregistrée : la proposition est maintenant « Confirmée »/)).toBeInTheDocument();
  });

  it("sans preuve de terrain disponible, une decision SANS verdict (non concluante) part sans observationIds ni constatRef, et l'ecran le dit", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Non concluante : classer la proposition ${NOM}` }));
    expect(screen.getByText(/décision sera enregistrée sans preuve jointe/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Référence du constat/)).not.toBeInTheDocument(); // un verdict seul cite un constat
    await u.type(screen.getByLabelText(/Motif/), "Image trop floue");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", { vers: "NON_CONCLUANTE", motif: "Image trop floue" }));
  });

  it.each([["Confirmer", "CONFIRMEE"], ["Infirmer", "INFIRMEE"]])("%s sans observation liee : la reference du constat est OBLIGATOIRE ; le bouton est inactif et la raison est dite", async (action, vers) => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `${action} la proposition ${NOM}` }));
    // le texte ne ment plus : il n'y a pas de « decision sans preuve jointe » pour un verdict
    expect(screen.queryByText(/décision sera enregistrée sans preuve jointe/)).not.toBeInTheDocument();
    expect(screen.getByText(/saisissez la référence du constat qui fonde le verdict/)).toBeInTheDocument();
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    await u.type(screen.getByLabelText(/Motif/), "Constat sur place");
    expect(envoyer).toBeDisabled();
    expect(screen.getByTestId("raison-inactif")).toHaveTextContent(/joignez au moins une observation ou saisissez la référence du constat/);
    expect(envoyer).toHaveAccessibleDescription(/référence du constat/);
    const champ = screen.getByLabelText(/Référence du constat/);
    expect(champ).toHaveAttribute("maxlength", "200");
    await u.type(champ, "   ");
    expect(envoyer).toBeDisabled(); // des espaces ne sont pas une reference
    await u.type(champ, "  MISSION-SYN-12  ");
    expect(envoyer).toBeEnabled();
    expect(screen.queryByTestId("raison-inactif")).not.toBeInTheDocument();
    await u.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", { vers, motif: "Constat sur place", constatRef: "MISSION-SYN-12" }));
  });

  it("verdict avec une observation liee : observationIds suffit, aucune reference n'est exigee ; avec les deux, les deux partent", async () => {
    servir(detail({ terrain: { observations: OBSERVATIONS } }));
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Infirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Eau retirée");
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    expect(envoyer).toBeDisabled();
    await u.click(screen.getByRole("checkbox", { name: /Eau retirée/ }));
    expect(envoyer).toBeEnabled();
    await u.type(screen.getByLabelText(/Référence du constat/), "RAPPORT-9");
    await u.click(envoyer);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", {
      vers: "INFIRMEE", motif: "Eau retirée", observationIds: ["o-2"], constatRef: "RAPPORT-9",
    }));
  });

  it("envoyer() refuse un motif vide meme si le bouton est contourne (defense en profondeur, aucune requete)", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    // « Mettre en attente » n'exige aucun constat : la seule barriere est ici le motif.
    await u.click(await screen.findByRole("button", { name: `Mettre en attente la proposition ${NOM}` }));
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    expect(envoyer).toBeDisabled();
    // On appelle directement le gestionnaire React, comme si la garde « disabled » du bouton n'existait pas.
    const cle = Object.keys(envoyer).find((k) => k.startsWith("__reactProps")) as string;
    (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick();
    await u.type(screen.getByLabelText(/Motif/), "    ");
    (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.post).not.toHaveBeenCalled();
  });

  it("envoyer() refuse un verdict sans constat meme motive et meme si le bouton est contourne (le serveur dirait CONSTAT_REQUIS)", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Un motif");
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    expect(envoyer).toBeDisabled();
    const cle = Object.keys(envoyer).find((k) => k.startsWith("__reactProps")) as string;
    (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.post).not.toHaveBeenCalled();
  });

  it("double clic et trois clics dans le meme tick : UNE seule requete (verrou synchrone), pour une transition", async () => {
    servir(detail());
    let resoudre: (v: unknown) => void = () => {};
    h.post.mockImplementation(() => new Promise((r) => { resoudre = r; }));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Mettre en attente la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Accès impossible");
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    await u.dblClick(envoyer);
    expect(h.post).toHaveBeenCalledTimes(1);
    // trois clics dans le MEME tick : React n'a pas rendu entre eux, seul le verrou les arrete
    const cle = Object.keys(envoyer).find((k) => k.startsWith("__reactProps")) as string;
    const onClick = (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick;
    onClick(); onClick(); onClick();
    expect(h.post).toHaveBeenCalledTimes(1);
    resoudre({ data: {} });
    await screen.findByText(/Décision enregistrée/);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("trois clics dans le meme tick avant tout rendu : une seule requete, y compris pour un verdict", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Constat");
    await u.type(screen.getByLabelText(/Référence du constat/), "REF-7");
    const envoyer = screen.getByRole("button", { name: "Enregistrer la décision" });
    const cle = Object.keys(envoyer).find((k) => k.startsWith("__reactProps")) as string;
    const onClick = (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick;
    act(() => { onClick(); onClick(); onClick(); });
    await screen.findByText(/Décision enregistrée/);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("le verrou est leve apres un echec : on peut renvoyer", async () => {
    servir(detail());
    h.post.mockRejectedValueOnce(echec(500, "Panne")).mockResolvedValueOnce({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Mettre en attente la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Accès impossible");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await screen.findByRole("alert");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await screen.findByText(/Décision enregistrée/);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("« Affecter » : double clic = une seule mission", async () => {
    servir(detail());
    h.post.mockImplementation(() => new Promise((r) => setTimeout(() => r({ data: { code: "VER-1" } }), 60)));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Affecter à une inspection la proposition ${NOM}` }));
    await u.dblClick(screen.getByRole("button", { name: "Créer la mission de vérification" }));
    await screen.findByText("Mission VER-1 créée en brouillon.");
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("« Affecter » : trois clics dans le MEME tick (aucun rendu entre eux) = une seule mission", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: { code: "VER-2" } });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Affecter à une inspection la proposition ${NOM}` }));
    const envoyer = screen.getByRole("button", { name: "Créer la mission de vérification" });
    const cle = Object.keys(envoyer).find((k) => k.startsWith("__reactProps")) as string;
    const onClick = (envoyer as unknown as Record<string, { onClick: () => void }>)[cle].onClick;
    act(() => { onClick(); onClick(); onClick(); });
    await screen.findByText("Mission VER-2 créée en brouillon.");
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("EN_ATTENTE : « Mettre en attente » (nouveau motif) et « Demander des informations » sont offerts, avec leur motif d'attente", async () => {
    servir(detail({ statut: "EN_ATTENTE" }));
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Demander des informations sur la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Précision attendue de l'équipe");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", { vers: "EN_ATTENTE", motif: "Précision attendue de l'équipe", motifAttente: "INFO_DEMANDEE" }));
    expect(screen.getByRole("button", { name: `Mettre en attente la proposition ${NOM}` })).toBeInTheDocument();
  });

  it("« Demander des informations » : vers EN_ATTENTE avec le motif INFO_DEMANDEE", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Demander des informations sur la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Photo récente demandée");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/transition", { vers: "EN_ATTENTE", motif: "Photo récente demandée", motifAttente: "INFO_DEMANDEE" }));
  });

  it("« Mettre en attente » : vers EN_ATTENTE avec le motif AUTRE", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Mettre en attente la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Accès impossible");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post.mock.calls[0][1]).toMatchObject({ vers: "EN_ATTENTE", motifAttente: "AUTRE" }));
  });

  it("« Affecter à une inspection » : POST de verification avec un corps vide, mission annoncee", async () => {
    servir(detail());
    h.post.mockResolvedValue({ data: { code: "VER-TD-1" } });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Affecter à une inspection la proposition ${NOM}` }));
    await u.click(screen.getByRole("button", { name: "Créer la mission de vérification" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/propositions/p-1/verification", {}));
    expect(await screen.findByText("Mission VER-TD-1 créée en brouillon.")).toBeInTheDocument();
  });

  it("une mission deja affectee : plus d'affectation proposee, et c'est dit", async () => {
    servir(detail({ missionId: "M-7", mission: { id: "M-7", statut: "EN_COURS", assigneNom: null } }));
    await ouvrir();
    expect(await screen.findByText(/mission de vérification est déjà affectée/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Affecter à une inspection/ })).not.toBeInTheDocument();
  });

  it("refus du serveur (409 verdict definitif) : le message du serveur est affiche, sans faux succes", async () => {
    servir(detail());
    h.post.mockRejectedValue(echec(409, "Verdict définitif : la proposition est déjà confirmée", "VERDICT_DEFINITIF"));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Constat");
    await u.type(screen.getByLabelText(/Référence du constat/), "REF-1");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("Le serveur refuse cette décision");
    expect(alerte).toHaveTextContent("Verdict définitif : la proposition est déjà confirmée");
    expect(screen.queryByText(/Décision enregistrée/)).not.toBeInTheDocument();
  });

  it("refus de droit (403) : le serveur decide, meme si le bouton etait offert", async () => {
    servir(detail());
    h.post.mockRejectedValue(echec(403, "Hors de votre périmètre", "HORS_PERIMETRE"));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Infirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Constat");
    await u.type(screen.getByLabelText(/Référence du constat/), "REF-1");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Le serveur refuse cette action pour votre compte : Hors de votre périmètre");
  });

  it("traitement en cours : message role status et boutons inactifs", async () => {
    servir(detail());
    h.post.mockImplementation(() => new Promise(() => {}));
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Confirmer la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Constat");
    await u.type(screen.getByLabelText(/Référence du constat/), "REF-1");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    expect(await screen.findByText("Enregistrement en cours…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer la décision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Annuler" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Infirmer la proposition ${NOM}` })).toBeDisabled();
  });

  it("verdict definitif : aucune action, une explication", async () => {
    servir(detail({ statut: "CONFIRMEE" }));
    await ouvrir();
    expect(await screen.findByText(/Verdict définitif : cette proposition est « Confirmée »/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Confirmer|Infirmer|Mettre en attente|Demander|Affecter|Non concluante|Remettre)/ })).not.toBeInTheDocument();
  });

  // Regression (test de bout en bout, parcours 3) : le serveur rend la fiche CONFIRMEE/INFIRMEE apres le verdict, la section « Decision » bascule
  // sur le message de verdict definitif ; le succes de l'enregistrement doit rester dit (le toast seul disparait).
  it.each([["Confirmer", "CONFIRMEE", "Confirmée"], ["Infirmer", "INFIRMEE", "Infirmée"]])(
    "%s : la fiche relue bascule en verdict definitif ET le succes de l'enregistrement reste affiche",
    async (action, vers, libelle) => {
      let poste = false;
      h.get.mockImplementation(routeurGet({ "/v2/teledetection/propositions/p-1": () => (poste ? detail({ statut: vers as PropositionDetail["statut"] }) : detail()) }));
      h.post.mockImplementation(async () => { poste = true; return { data: {} }; });
      const u = userEvent.setup();
      await ouvrir();
      await u.click(await screen.findByRole("button", { name: `${action} la proposition ${NOM}` }));
      await u.type(screen.getByLabelText(/Motif/), "Constat sur place");
      await u.type(screen.getByLabelText(/Référence du constat/), "REF-1");
      await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
      expect(await screen.findByText(new RegExp(`Verdict définitif : cette proposition est « ${libelle} »`))).toBeInTheDocument();
      expect(screen.getByText(`Décision enregistrée : la proposition est maintenant « ${libelle} ».`)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^(Confirmer|Infirmer|Mettre en attente|Demander|Affecter|Non concluante|Remettre)/ })).not.toBeInTheDocument();
    },
  );

  it("EN_ATTENTE : on peut la remettre a verifier", async () => {
    servir(detail({ statut: "EN_ATTENTE" }));
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    await ouvrir();
    await u.click(await screen.findByRole("button", { name: `Remettre à vérifier la proposition ${NOM}` }));
    await u.type(screen.getByLabelText(/Motif/), "Information reçue");
    await u.click(screen.getByRole("button", { name: "Enregistrer la décision" }));
    await waitFor(() => expect(h.post.mock.calls[0][1]).toMatchObject({ vers: "A_VERIFIER", motif: "Information reçue" }));
  });
});

describe("etats du detail", () => {
  it("chargement : role status", () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendreAvecClient(<Harnais profil="ADMIN" />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement de la proposition");
  });

  it("404 (inexistante ou hors perimetre) : alerte avec le message, pas un panneau vide", async () => {
    servir(echec(404));
    rendreAvecClient(<Harnais profil="ADMIN" />);
    const a = await screen.findByRole("alert");
    expect(a).toHaveTextContent("Ressource introuvable ou hors de votre périmètre");
    expect(screen.queryByText("Décision")).not.toBeInTheDocument();
  });

  it("403 : message de permission dedie", async () => {
    servir(echec(403));
    rendreAvecClient(<Harnais profil="LECTEUR" />);
    expect(await screen.findByText(/Détail de la proposition : accès refusé/)).toBeInTheDocument();
  });

  it("le bouton de fermeture appelle le retour", async () => {
    servir(detail());
    const onFermer = vi.fn();
    const u = userEvent.setup();
    rendreAvecClient(<Harnais profil="ADMIN" onFermer={onFermer} />);
    await screen.findByText("Indicateurs de qualité");
    await u.click(screen.getByRole("button", { name: "Retour à la liste" }));
    await u.click(screen.getByRole("button", { name: "Fermer le détail de la proposition" }));
    expect(onFermer).toHaveBeenCalledTimes(2);
  });
});
