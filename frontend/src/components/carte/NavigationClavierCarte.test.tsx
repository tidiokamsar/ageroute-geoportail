import { useEffect, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Vrai Leaflet et vrai react-leaflet sous jsdom. Deux accommodements, tous deux sans effet sur la logique testee :
 *  - jsdom ne sait pas dessiner du SVG : Leaflet ne choisit le moteur SVG que si `createSVGRect` existe, on le fournit (le trace est un
 *    `<path>` ordinaire du DOM, c'est tout ce dont la navigation a besoin) ;
 *  - jsdom ne calcule aucune mise en page : le conteneur de la carte recoit une taille de 800 x 600, sans quoi la vue est un point.
 * Ce qui est verifie : le contrat du composant (arrets de Tab, fleches, Entree, Echap, annonce), et que les couches REELLES de la page
 * (marqueur + infobulle + click, trace + infobulle + click, marqueur + popup) sont parcourues sans modification.
 * Le comportement dans un vrai navigateur (arrets de Tab comptes, focus, rendu) est mesure dans Chromium : voir le rapport de la PR.
 */
vi.hoisted(() => {
  (SVGElement.prototype as unknown as { createSVGRect: () => object }).createSVGRect = () => ({});
});

import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, Tooltip, useMap } from "react-leaflet";
import { NavigationClavierCarte, CLASSE_ACTIF } from "./NavigationClavierCarte";
import { violationsAccessibilite } from "../../test/accessibilite";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
});
afterEach(() => { document.body.innerHTML = ""; });

const ICONE = L.divIcon({ className: "bdri-test", html: "<span>x</span>", iconSize: [20, 20] });

interface Spies { clic: ReturnType<typeof vi.fn> }

/**
 * Une carte centree sur (10, -11), zoom 8 (environ 5 degres de large pour 800 px). Du plus proche du centre au plus eloigne :
 * le pont (10.0, -11.0), le troncon (passe a 10.05), le poste (10.4, -10.5), le point noir popup (10.6, -11.6).
 */
function Carte({ spies, plafond, ajouterMarqueurSansInfobulle = true }: { spies: Spies; plafond?: number; ajouterMarqueurSansInfobulle?: boolean }) {
  return (
    <MapContainer center={[10, -11]} zoom={8} style={{ height: 600, width: 800 }}>
      <NavigationClavierCarte plafond={plafond} />
      <Marker position={[10, -11]} icon={ICONE} eventHandlers={{ click: () => spies.clic("ouvrage") }}>
        <Tooltip>Pont — Pont de test (Bon)<br />position héritée</Tooltip>
      </Marker>
      <Polyline positions={[[10.05, -12], [10.05, -10]]} eventHandlers={{ click: () => spies.clic("troncon") }}>
        <Tooltip sticky>RN1 Tronçon de test</Tooltip>
      </Polyline>
      <Marker position={[10.4, -10.5]} icon={ICONE} eventHandlers={{ click: () => spies.clic("poste") }}>
        <Tooltip>Péage — Poste de test</Tooltip>
      </Marker>
      <Marker position={[10.6, -11.6]} icon={ICONE}>
        <Tooltip>Franchissement de test</Tooltip>
        <Popup>Fiche du franchissement <button type="button">Ajouter</button></Popup>
      </Marker>
      <Marker position={[14, -11.2]} icon={ICONE} eventHandlers={{ click: () => spies.clic("hors-vue") }}>
        <Tooltip>Hors de la vue</Tooltip>
      </Marker>
      {ajouterMarqueurSansInfobulle && <Marker position={[10.1, -11.1]} icon={ICONE} />}
    </MapContainer>
  );
}

function rendre(props: { plafond?: number } = {}) {
  const spies: Spies = { clic: vi.fn() };
  const r = render(<Carte spies={spies} {...props} />);
  return { ...r, spies };
}

const controleur = () => document.querySelector<HTMLElement>("[data-navigation-clavier-carte]")!;
const annonce = () => (document.querySelector("[data-annonce-carte]")!.textContent ?? "").replace(/\u00A0/g, "").trim();
const conteneurCarte = () => document.querySelector<HTMLElement>(".leaflet-container")!;

async function entrer() {
  const user = userEvent.setup();
  await waitFor(() => expect(controleur()).toBeTruthy());
  act(() => controleur().focus());
  await waitFor(() => expect(annonce()).toMatch(/dans la vue/));
  return user;
}

describe("NavigationClavierCarte : un seul arret de Tab", () => {
  it("retire de la tabulation les marqueurs et les traces qui ont une infobulle, et pose UN controleur focalisable", async () => {
    rendre();
    await waitFor(() => expect(controleur()).toBeTruthy());
    const marqueursAvecInfobulle = Array.from(document.querySelectorAll<HTMLElement>(".leaflet-marker-icon")).slice(0, 5);
    expect(marqueursAvecInfobulle.length).toBeGreaterThan(0);
    await waitFor(() => {
      // 4 marqueurs avec infobulle + 1 trace : tous a -1.
      const tabulables = Array.from(document.querySelectorAll<HTMLElement>(".leaflet-container, .leaflet-container [tabindex='0']")).filter((e) => e.getAttribute("tabindex") === "0");
      // Restent tabulables : le conteneur de la carte (fleches pour deplacer), le controleur, et le marqueur SANS infobulle (hors parcours).
      const noms = tabulables.map((e) => (e.matches(".leaflet-container") ? "conteneur" : e.hasAttribute("data-navigation-clavier-carte") ? "controleur" : "autre"));
      expect(noms.filter((n) => n === "controleur")).toHaveLength(1);
      expect(noms.filter((n) => n === "conteneur")).toHaveLength(1);
      expect(noms.filter((n) => n === "autre")).toHaveLength(1);
    });
    expect(document.querySelectorAll("path.leaflet-interactive[tabindex='-1']")).toHaveLength(1);
    expect(document.querySelectorAll("path.leaflet-interactive:not([tabindex='-1'])")).toHaveLength(0);
  });

  it("garde-fou : un marqueur sans infobulle (hors parcours) garde son arret de Tab, il n'est retire que s'il est couvert", async () => {
    rendre();
    await waitFor(() => expect(document.querySelectorAll(".leaflet-marker-icon[tabindex='-1']")).toHaveLength(4));
    const nus = Array.from(document.querySelectorAll<HTMLElement>(".leaflet-marker-icon")).filter((e) => e.getAttribute("tabindex") === "0");
    expect(nus).toHaveLength(1);
  });

  it("retire aussi les marqueurs ajoutes apres coup (zoom, rechargement d'un calque)", async () => {
    function Tardive() {
      const [plus, setPlus] = useState(false);
      useEffect(() => {
        const t = setTimeout(() => setPlus(true), 50);
        return () => clearTimeout(t);
      }, []);
      return (
        <MapContainer center={[10, -11]} zoom={8} style={{ height: 600, width: 800 }}>
          <NavigationClavierCarte />
          {plus && <Marker position={[10.2, -11.2]} icon={ICONE}><Tooltip>Arrive plus tard</Tooltip></Marker>}
        </MapContainer>
      );
    }
    render(<Tardive />);
    await waitFor(() => expect(document.querySelectorAll(".leaflet-marker-icon")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".leaflet-marker-icon")?.getAttribute("tabindex")).toBe("-1"));
  });
});

describe("NavigationClavierCarte : fleches, infobulle, annonce", () => {
  it("annonce le nombre d'elements dans la vue a l'entree (le marqueur hors vue et le marqueur sans infobulle ne comptent pas)", async () => {
    rendre();
    await entrer();
    expect(annonce()).toBe("4 éléments dans la vue.");
  });

  it("la premiere fleche choisit le plus proche du centre, ouvre son infobulle et l'annonce avec son rang", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(annonce()).toBe("Pont — Pont de test (Bon). position héritée, 1 sur 4"));
    // L'infobulle est celle de la souris : visible dans la carte.
    expect(document.querySelector(".leaflet-tooltip")?.textContent).toContain("Pont de test");
    // L'element est entoure sur la carte.
    expect(document.querySelectorAll(`.${CLASSE_ACTIF}`)).toHaveLength(1);
  });

  it("parcourt dans l'ordre du centre vers l'exterieur, recule, saute a Fin et Debut, et dit la butee au lieu de boucler", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(annonce()).toContain("Pont de test"));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(annonce()).toBe("RN1 Tronçon de test, 2 sur 4"));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(annonce()).toBe("Péage — Poste de test, 3 sur 4"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(annonce()).toBe("RN1 Tronçon de test, 2 sur 4"));
    await user.keyboard("{End}");
    await waitFor(() => expect(annonce()).toBe("Franchissement de test, 4 sur 4"));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(annonce()).toBe("Dernier élément. Franchissement de test, 4 sur 4"));
    await user.keyboard("{Home}");
    await waitFor(() => expect(annonce()).toBe("Pont — Pont de test (Bon). position héritée, 1 sur 4"));
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(annonce()).toBe("Premier élément. Pont — Pont de test (Bon). position héritée, 1 sur 4"));
    // Un seul element est entoure a la fois, et un seul infobulle est ouverte par le controleur.
    expect(document.querySelectorAll(`.${CLASSE_ACTIF}`)).toHaveLength(1);
  });

  it("le trace est parcouru comme un marqueur : son infobulle s'ouvre dans la vue", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(annonce()).toBe("RN1 Tronçon de test, 2 sur 4"));
    expect(document.querySelector("path.leaflet-interactive")?.classList.contains(CLASSE_ACTIF)).toBe(true);
  });

  it("dit le plafond quand il est atteint, et ne parcourt que les plus proches", async () => {
    rendre({ plafond: 2 });
    const user = await entrer();
    expect(annonce()).toContain("4 éléments dans la vue : seuls les 2 plus proches du centre");
    await user.keyboard("{End}");
    await waitFor(() => expect(annonce()).toBe("RN1 Tronçon de test, 2 sur 2"));
  });

  it("Tab n'est pas pris par le controleur (il quitte la carte) ; la region d'annonce est polie et permanente", async () => {
    rendre();
    const user = await entrer();
    const region = document.querySelector("[data-annonce-carte]")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    await user.keyboard("{Tab}");
    expect(document.activeElement).not.toBe(controleur());
  });
});

describe("NavigationClavierCarte : Entree et Echap", () => {
  it("Entree sur un marqueur declenche le meme click que la souris (gestionnaire de la page)", async () => {
    const { spies } = rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(spies.clic).toHaveBeenCalledWith("ouvrage");
    expect(spies.clic).toHaveBeenCalledTimes(1);
  });

  it("Espace fait de meme, sur un trace", async () => {
    const { spies } = rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}{ArrowDown}{ }");
    expect(spies.clic).toHaveBeenCalledWith("troncon");
  });

  it("Entree sur un poste ouvre le gestionnaire du poste, et seulement lui", async () => {
    const { spies } = rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(spies.clic.mock.calls).toEqual([["poste"]]);
  });

  it("sans element choisi, Entree ne declenche rien et le dit", async () => {
    const { spies } = rendre();
    const user = await entrer();
    await user.keyboard("{Enter}");
    expect(spies.clic).not.toHaveBeenCalled();
    await waitFor(() => expect(annonce()).toBe("Aucun élément choisi. Utilisez les flèches."));
  });

  it("Entree sur un element a popup ouvre la popup liee et y met le focus ; Echap la ferme et rend le focus au controleur", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{End}{Enter}");
    await waitFor(() => expect(document.querySelector(".leaflet-popup")).toBeTruthy());
    await waitFor(() => expect(document.activeElement?.classList.contains("leaflet-popup-content")).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".leaflet-popup")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(controleur()));
  });

  it("Echap sans rien d'ouvert efface le choix, ferme l'infobulle et rend le focus a la carte", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.querySelector(".leaflet-tooltip")).toBeTruthy());
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(conteneurCarte());
    await waitFor(() => expect(document.querySelector(".leaflet-tooltip")).toBeNull());
    expect(document.querySelectorAll(`.${CLASSE_ACTIF}`)).toHaveLength(0);
  });

  it("quand la fiche de la page est ouverte, Echap n'est pas consomme (la fiche se ferme elle-meme) et le focus revient apres sa fermeture", async () => {
    rendre();
    const user = await entrer();
    // La fiche de la page : un role=dialog "Fiche : ..." frere de la carte, comme le DetailPanel. Elle apparait apres le click.
    const hote = conteneurCarte().parentElement!.parentElement!;
    const fiche = document.createElement("div");
    fiche.setAttribute("role", "dialog");
    fiche.setAttribute("aria-label", "Fiche : Pont de test");
    fiche.tabIndex = -1;
    const surWindow = vi.fn();
    window.addEventListener("keydown", surWindow);
    await user.keyboard("{ArrowDown}");
    act(() => { hote.appendChild(fiche); });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(fiche));
    // Echap dans la fiche : l'evenement atteint window, non annule par le controleur ; la fiche se ferme.
    await user.keyboard("{Escape}");
    expect(surWindow.mock.calls.at(-1)![0].defaultPrevented).toBe(false);
    act(() => { fiche.remove(); });
    await waitFor(() => expect(document.activeElement).toBe(controleur()));
    window.removeEventListener("keydown", surWindow);
  });
});

describe("NavigationClavierCarte : attentes qui ne survivent pas", () => {
  it("l'attente d'une fiche est annulee au demontage : une fiche qui apparait ensuite n'est PAS focalisee", async () => {
    const { unmount } = rendre();
    const user = await entrer();
    // Aucune fiche n'apparait : le controleur attend quelques images, puis on le demonte pendant l'attente.
    await user.keyboard("{ArrowDown}{Enter}");
    unmount();
    const fiche = document.createElement("div");
    fiche.setAttribute("role", "dialog");
    fiche.setAttribute("aria-label", "Fiche : arrivee tardive");
    fiche.tabIndex = -1;
    document.body.appendChild(fiche);
    await new Promise((r) => setTimeout(r, 400));
    expect(document.activeElement).not.toBe(fiche);
  });

  it("une touche pressee pendant l'attente d'une fiche l'annule (l'utilisateur est passe a autre chose)", async () => {
    rendre();
    const user = await entrer();
    await user.keyboard("{ArrowDown}{Enter}{ArrowDown}");
    const fiche = document.createElement("div");
    fiche.setAttribute("role", "dialog");
    fiche.setAttribute("aria-label", "Fiche : arrivee tardive");
    fiche.tabIndex = -1;
    document.body.appendChild(fiche);
    await new Promise((r) => setTimeout(r, 400));
    expect(document.activeElement).toBe(controleur());
  });

  it("une popup qui s'efface en fondu garde le focus ~200 ms : Echap le rend quand meme au controleur", async () => {
    let carteLeaflet: L.Map | undefined;
    function Capture() {
      carteLeaflet = useMap();
      return null;
    }
    const spies: Spies = { clic: vi.fn() };
    render(
      <MapContainer center={[10, -11]} zoom={8} style={{ height: 600, width: 800 }}>
        <Capture />
        <NavigationClavierCarte />
        <Marker position={[10, -11]} icon={ICONE}><Tooltip>Avec popup</Tooltip><Popup>Contenu <button type="button">Ajouter</button></Popup></Marker>
      </MapContainer>,
    );
    void spies;
    // jsdom n'a pas les transitions CSS (any3d) : on active l'animation de fondu de Leaflet, qui laisse la popup au DOM 200 ms apres sa fermeture.
    (carteLeaflet as unknown as { _fadeAnimated: boolean })._fadeAnimated = true;
    const user = await entrer();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(document.activeElement?.classList.contains("leaflet-popup-content")).toBe(true));
    await user.keyboard("{Escape}");
    // La popup est encore dans le DOM (fondu) et le focus est deja revenu.
    expect(document.querySelector(".leaflet-popup")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(controleur()));
  });
});

describe("NavigationClavierCarte : accessibilite", () => {
  it("le DOM de la carte et du controleur ne presente aucune violation axe (WCAG 2.1 A et AA)", async () => {
    rendre();
    await entrer();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });

  it("le controleur a un nom, un role et l'aide des touches en description", async () => {
    rendre();
    await waitFor(() => expect(controleur()).toBeTruthy());
    expect(screen.getByRole("application", { name: "Éléments de la carte" })).toBe(controleur());
    const id = controleur().getAttribute("aria-describedby")!;
    expect(document.getElementById(id)?.textContent).toMatch(/Flèches.*Entrée ou Espace.*Échap.*Tab/);
  });
});
