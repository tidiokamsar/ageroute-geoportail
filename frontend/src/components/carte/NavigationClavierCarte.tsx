import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ToucheReact } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { useMap } from "react-leaflet";
import {
  AIDE_CLAVIER, LIBELLE_CONTROLEUR, PLAFOND_ELEMENTS, actionPourTouche, libelleGroupe, ordonner, positionApres, texteButee, texteElement, texteResume,
  type ElementOrdonne,
} from "./ordreClavierCarte";
import { collecterCandidats, lireLibelle, retirerDeLaTabulation, vueDe, type CandidatCarte } from "./candidatsCarte";

/**
 * Navigation au clavier d'une carte Leaflet : UN SEUL arret de Tab pour tous les elements cartographiques interactifs (troncons, ouvrages,
 * points noirs, postes, chantiers, alertes, voirie, franchissements, portions, groupes), parcourus ensuite aux fleches.
 *
 * LE PROBLEME QUE CELA RESOUT (mesure dans Chromium, donnees synthetiques) : chaque trace avec infobulle, chaque marqueur et chaque icone de
 * groupe est un arret de Tab (50 arrets avec 40 troncons, 30 ouvrages, 10 points noirs, 6 postes et 12 chantiers ; 1 712 avec 1 700 troncons).
 * L'infobulle ouverte au focus etait la seule exploration clavier de la carte, et Entree n'ouvrait pas la fiche (Leaflet emet `keypress`,
 * l'application n'ecoute que `click`).
 *
 * COMMENT.
 *  - Le controleur est un element focalisable unique, place dans les commandes de la carte (apres le conteneur, avant le zoom), invisible
 *    tant qu'il n'a pas le focus, puis affichant l'aide. Les elements DOM des couches parcourues recoivent `tabindex="-1"` (un
 *    `MutationObserver` rejoue le retrait pour les elements ajoutes plus tard) : ils restent focalisables a la souris, mais plus a Tab.
 *  - Fleches, Debut, Fin, Page precedente et suivante passent d'un element a l'autre dans l'ordre decrit dans `ordreClavierCarte.ts`
 *    (du plus proche du centre de la vue au plus eloigne, plafonne). L'element choisi est entoure sur la carte et son infobulle s'ouvre,
 *    exactement celle de la souris.
 *  - Entree ou Espace declenchent le MEME `click` que la souris sur la couche (`layer.fire("click")`) : la fiche de la page s'ouvre, ou la
 *    popup liee, ou le groupe zoome. Le focus passe alors dans la fiche (ou la popup) ; en la fermant par Echap il revient au controleur.
 *  - Echap ferme la popup, ou laisse la fiche se fermer elle-meme, ou - sans rien d'ouvert - efface le choix et rend le focus a la carte.
 *
 * L'ANNONCE AUX TECHNOLOGIES D'ASSISTANCE passe par une region `role="status"` (aria-live polie), pas par `aria-activedescendant` :
 *  - `aria-activedescendant` exige que chaque element designe existe dans le DOM, dans le meme conteneur ARIA. Or un groupe replie n'a pas
 *    d'element, 1 700 troncons ne se dupliquent pas en 1 700 `option`, et le libelle (le contenu de l'infobulle) n'existe qu'une fois
 *    l'infobulle ouverte : il faudrait un double DOM cache, a synchroniser avec Leaflet, pour un benefice incertain ;
 *  - la region vit en permanence dans la page (une region creee a la volee n'est souvent pas annoncee) ; son texte est change a chaque
 *    deplacement, et l'annonce est temporisee de quelques dizaines de millisecondes pour que seule la derniere fleche d'une rafale soit lue ;
 *  - ce choix n'a PAS ete verifie avec un lecteur d'ecran reel (NVDA, JAWS, VoiceOver) : voir le rapport de la PR.
 */

/** Selecteur de la fiche cartographique de la page (DetailPanel : role dialog, nom "Fiche : ..." ou "Fiche reduite : ..."). */
export const SELECTEUR_FICHE = '[role="dialog"][aria-label^="Fiche"]';

/** Classe posee sur l'element de la carte choisi au clavier (anneau : voir index.css). */
export const CLASSE_ACTIF = "carte-nav-actif";

/** Delai de l'annonce : la derniere fleche d'une rafale est seule lue. Assez long pour laisser React rendre le contenu d'une infobulle. */
const DELAI_ANNONCE_MS = 60;
const ESSAIS_LECTURE = 8;

export function NavigationClavierCarte({ plafond = PLAFOND_ELEMENTS }: { plafond?: number }) {
  const carte = useMap();
  const [hote, setHote] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const controle = new L.Control({ position: "bottomleft" });
    controle.onAdd = () => {
      const d = L.DomUtil.create("div", "leaflet-control carte-nav-clavier");
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      return d;
    };
    controle.addTo(carte);
    setHote(controle.getContainer() ?? null);
    return () => {
      controle.remove();
      setHote(null);
    };
  }, [carte]);

  // Retrait des arrets de Tab : une fois, puis a chaque changement du DOM de la carte (ajout de calque, zoom, groupe recalcule, icone recreee).
  useEffect(() => {
    const conteneur = carte.getContainer?.();
    if (!conteneur) return;
    let image = 0;
    const planifier = () => {
      if (image) return;
      image = requestAnimationFrame(() => {
        image = 0;
        retirerDeLaTabulation(carte);
      });
    };
    retirerDeLaTabulation(carte);
    if (typeof MutationObserver === "undefined") return;
    const o = new MutationObserver(planifier);
    o.observe(conteneur, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    return () => {
      o.disconnect();
      if (image) cancelAnimationFrame(image);
    };
  }, [carte]);

  return hote ? createPortal(<Controleur carte={carte} plafond={plafond} />, hote) : null;
}

function Controleur({ carte, plafond }: { carte: L.Map; plafond: number }) {
  const idAide = useId();
  const refControleur = useRef<HTMLDivElement>(null);
  const [resume, setResume] = useState("");
  const [annonce, setAnnonce] = useState("");

  const etat = useRef({
    liste: [] as ElementOrdonne<CandidatCarte>[],
    index: -1,
    actif: false, // le controleur a le focus
    libelle: "", // dernier libelle lu pour l'element choisi
    marque: null as Element | null,
    minuteur: 0,
    bascule: false,
    popupFocalisee: false,
    arretFiche: null as (() => void) | null,
    attenteFiche: 0, // identifiant de l'image d'animation qui guette l'ouverture d'une fiche
  });

  const annoncer = useCallback((texte: string) => {
    const e = etat.current;
    e.bascule = !e.bascule;
    // Un meme texte deux fois de suite n'est pas relu : on alterne un espace insecable final, muet.
    setAnnonce(e.bascule ? texte : `${texte}\u00A0`);
  }, []);

  const demarquer = useCallback(() => {
    const e = etat.current;
    e.marque?.classList.remove(CLASSE_ACTIF);
    e.marque = null;
  }, []);

  const fermerInfobulle = useCallback(() => {
    const cur = etat.current.liste[etat.current.index];
    cur?.element.couche.closeTooltip?.();
  }, []);

  const marquer = useCallback(
    (cur: ElementOrdonne<CandidatCarte>) => {
      demarquer();
      const el = cur.element.couche.getElement?.();
      if (el) {
        el.classList.add(CLASSE_ACTIF);
        etat.current.marque = el;
      }
    },
    [demarquer],
  );

  /** Recalcule la liste pour la vue courante, en gardant l'element choisi s'il est toujours dans la vue. */
  const recalculer = useCallback(() => {
    const e = etat.current;
    const cleCourante = e.liste[e.index]?.element.cle;
    const r = ordonner(collecterCandidats(carte), vueDe(carte), plafond);
    e.liste = r.elements;
    e.index = cleCourante ? r.elements.findIndex((x) => x.element.cle === cleCourante) : -1;
    const texte = texteResume(r.totalDansVue, r.tronque, plafond);
    setResume(texte);
    return texte;
  }, [carte, plafond]);

  /** Lit le libelle de l'element choisi (apres ouverture de l'infobulle) puis l'annonce. */
  const lireEtAnnoncer = useCallback(
    (i: number, essai: number, butee?: "debut" | "fin") => {
      const e = etat.current;
      const cur = e.liste[i];
      if (!cur || e.index !== i) return;
      const libelle = cur.element.genre === "groupe" ? libelleGroupe(cur.element.nbEnfants ?? 0) : lireLibelle(cur.element.couche);
      if (!libelle && essai < ESSAIS_LECTURE) {
        e.minuteur = window.setTimeout(() => lireEtAnnoncer(i, essai + 1, butee), DELAI_ANNONCE_MS);
        return;
      }
      e.libelle = libelle || "Élément sans nom";
      annoncer(butee ? texteButee(butee, e.libelle, i, e.liste.length) : texteElement(e.libelle, i, e.liste.length));
    },
    [annoncer],
  );

  const afficher = useCallback(
    (i: number, butee?: "debut" | "fin") => {
      const e = etat.current;
      const precedent = e.liste[e.index];
      if (precedent && e.index !== i) precedent.element.couche.closeTooltip?.();
      e.index = i;
      const cur = e.liste[i];
      if (!cur) return;
      marquer(cur);
      if (cur.element.genre !== "groupe") {
        const couche = cur.element.couche;
        // Une ligne ouvre son infobulle au point visible le plus proche du centre : le milieu d'une route qui traverse la vue peut etre hors cadre.
        if (cur.element.genre === "ligne") couche.openTooltip?.(L.latLng(cur.ancrage[0], cur.ancrage[1]));
        else couche.openTooltip?.();
      }
      window.clearTimeout(e.minuteur);
      e.minuteur = window.setTimeout(() => lireEtAnnoncer(i, 0, butee), DELAI_ANNONCE_MS);
    },
    [lireEtAnnoncer, marquer],
  );

  /** Rend le focus au controleur s'il est perdu (corps de page) ou reste dans `zone` (une popup qui s'efface en fondu garde le focus ~200 ms). */
  const rendreLeFocus = useCallback((zone?: Element | null) => {
    const a = document.activeElement;
    if (!a || a === document.body || zone?.contains(a)) refControleur.current?.focus({ preventScroll: true });
  }, []);

  /** Arrete l'attente d'une fiche : appelee a chaque nouvelle touche et au demontage, pour qu'une attente ancienne ne vole pas le focus plus tard. */
  const annulerAttenteFiche = useCallback(() => {
    cancelAnimationFrame(etat.current.attenteFiche);
    etat.current.attenteFiche = 0;
  }, []);

  /** Apres l'ouverture d'une fiche, met le focus dedans (en l'attendant quelques images), et le rend au controleur quand elle disparait. */
  const suivreFiche = useCallback(
    (essai = 0) => {
      const fiche = document.querySelector<HTMLElement>(SELECTEUR_FICHE);
      if (!fiche) {
        if (essai < 20) etat.current.attenteFiche = requestAnimationFrame(() => suivreFiche(essai + 1));
        else annoncer("Aucune fiche pour cet élément.");
        return;
      }
      fiche.focus({ preventScroll: true });
      const parent = fiche.parentElement;
      if (!parent || typeof MutationObserver === "undefined") return;
      etat.current.arretFiche?.();
      const o = new MutationObserver(() => {
        if (fiche.isConnected) return;
        o.disconnect();
        etat.current.arretFiche = null;
        rendreLeFocus();
      });
      o.observe(parent, { childList: true });
      etat.current.arretFiche = () => o.disconnect();
    },
    [annoncer, rendreLeFocus],
  );

  const focaliserPopup = useCallback(
    (couche: CandidatCarte["couche"]) => {
      const el = couche.getPopup?.()?.getElement();
      if (!el) return;
      el.querySelector(".leaflet-popup-close-button")?.setAttribute("aria-label", "Fermer la fiche");
      const contenu = el.querySelector<HTMLElement>(".leaflet-popup-content") ?? el;
      contenu.setAttribute("tabindex", "-1");
      contenu.focus({ preventScroll: true });
      etat.current.popupFocalisee = true;
    },
    [],
  );

  const activer = useCallback(() => {
    const e = etat.current;
    const cur = e.liste[e.index];
    if (!cur) {
      annoncer("Aucun élément choisi. Utilisez les flèches.");
      return;
    }
    const { couche, genre } = cur.element;
    annulerAttenteFiche();
    // Le meme evenement que la souris : les gestionnaires `click` de la page et la popup liee (bindPopup) le recoivent.
    couche.fire("click", { latlng: L.latLng(cur.ancrage[0], cur.ancrage[1]) }, true);
    if (genre === "groupe") return; // le zoom se fait, `moveend` recalcule et annonce la nouvelle vue
    if (couche.isPopupOpen?.()) focaliserPopup(couche);
    else suivreFiche();
  }, [annoncer, annulerAttenteFiche, focaliserPopup, suivreFiche]);

  const surTouche = (ev: ToucheReact<HTMLDivElement>) => {
    const action = actionPourTouche(ev.nativeEvent);
    if (!action) return;
    const e = etat.current;
    if (action.type !== "activer") annulerAttenteFiche();
    if (action.type === "deplacer") {
      ev.preventDefault();
      if (e.liste.length === 0) {
        annoncer(resume || recalculer());
        return;
      }
      const p = positionApres(e.index, action.vers, e.liste.length);
      if (p.butee) {
        e.index = p.index;
        window.clearTimeout(e.minuteur);
        e.minuteur = window.setTimeout(() => lireEtAnnoncer(p.index, 0, p.butee ?? undefined), 0);
        return;
      }
      afficher(p.index);
    } else if (action.type === "activer") {
      ev.preventDefault();
      activer();
    } else {
      const cur = e.liste[e.index];
      if (cur?.element.couche.isPopupOpen?.()) {
        // Popup liee ouverte : Echap la ferme, ce que Leaflet ne fait que lorsque le conteneur a le focus.
        ev.preventDefault();
        carte.closePopup();
        annoncer("Fiche fermée.");
      } else if (document.querySelector(SELECTEUR_FICHE)) {
        // Fiche de la page ouverte : elle ecoute Echap elle-meme (avec confirmation d'une saisie en cours). Rien a faire ici.
      } else {
        ev.preventDefault();
        fermerInfobulle();
        demarquer();
        e.index = -1;
        carte.getContainer().focus({ preventScroll: true });
      }
    }
  };

  const surFocus = () => {
    const e = etat.current;
    e.actif = true;
    const texte = recalculer();
    if (e.index >= 0) afficher(e.index);
    else annoncer(texte);
  };

  const surPerteFocus = (ev: React.FocusEvent<HTMLDivElement>) => {
    if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
    const e = etat.current;
    e.actif = false;
    window.clearTimeout(e.minuteur);
    fermerInfobulle();
    demarquer();
  };

  // La carte bouge (zoom d'un groupe, deplacement a la souris, popup qui recadre) : la liste est recalculee, le choix gardé s'il reste dans la vue.
  useEffect(() => {
    let t = 0;
    const surMouvement = () => {
      if (!etat.current.actif) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const e = etat.current;
        const texte = recalculer();
        if (e.index >= 0) marquer(e.liste[e.index]);
        // Toujours dit : la vue a change (zoom d'un groupe, deplacement), le nombre d'elements aussi, meme si le choix est conserve.
        annoncer(texte);
      }, 150);
    };
    carte.on("moveend", surMouvement);
    return () => {
      carte.off("moveend", surMouvement);
      window.clearTimeout(t);
    };
  }, [carte, recalculer, marquer, annoncer]);

  // Popups : Echap depuis la popup la ferme (le gestionnaire clavier de Leaflet n'ecoute que le conteneur), et sa fermeture rend le focus au controleur.
  useEffect(() => {
    const conteneur = carte.getContainer();
    const surEchap = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !(ev.target instanceof Element) || !ev.target.closest(".leaflet-popup")) return;
      ev.preventDefault();
      carte.closePopup();
    };
    const surFermeture = (ev: L.PopupEvent) => {
      const e = etat.current;
      if (!e.popupFocalisee) return;
      e.popupFocalisee = false;
      rendreLeFocus(ev.popup?.getElement());
    };
    conteneur.addEventListener("keydown", surEchap);
    carte.on("popupclose", surFermeture);
    return () => {
      conteneur.removeEventListener("keydown", surEchap);
      carte.off("popupclose", surFermeture);
    };
  }, [carte, rendreLeFocus]);

  useEffect(() => {
    const e = etat.current;
    return () => {
      window.clearTimeout(e.minuteur);
      cancelAnimationFrame(e.attenteFiche);
      e.arretFiche?.();
      e.marque?.classList.remove(CLASSE_ACTIF);
    };
  }, []);

  return (
    <>
      {/* Composant composite a un seul arret de Tab (modele des widgets ARIA) : le role application est voulu, les fleches sont a lui. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={refControleur}
        role="application"
        aria-label={LIBELLE_CONTROLEUR}
        aria-describedby={idAide}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onKeyDown={surTouche}
        onFocus={surFocus}
        onBlur={surPerteFocus}
        data-navigation-clavier-carte=""
        className="sr-only focus:not-sr-only focus:block focus:max-w-[22rem] focus:rounded-md focus:bg-navy focus:px-3 focus:py-2 focus:text-xs focus:leading-snug focus:text-white focus:shadow-lg"
      >
        <span aria-hidden="true">
          <strong className="block">{LIBELLE_CONTROLEUR}</strong>
          {resume}
          <span className="mt-1 block text-white/80">Flèches : suivant, précédent · Entrée : fiche · Échap : fermer · Tab : quitter</span>
        </span>
      </div>
      <span id={idAide} className="sr-only">
        {AIDE_CLAVIER}
      </span>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-annonce-carte="">
        {annonce}
      </div>
    </>
  );
}
