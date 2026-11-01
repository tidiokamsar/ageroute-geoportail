import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { BadgeStatutLot } from "../components/imports/BadgeStatutLot";
import { BandeauGouvernance } from "../components/imports/BandeauGouvernance";
import { EtatChargement, EtatErreur, EtatVide } from "../components/imports/EtatsListe";
import { FILTRES_LOTS_VIDES, FiltresLots, filtresActifs } from "../components/imports/FiltresLots";
import { FormulaireReception, type SoumettreReception } from "../components/imports/FormulaireReception";
import { IndicateurEtapes } from "../components/imports/IndicateurEtapes";
import { ListeLots } from "../components/imports/ListeLots";
import { PanneauDetailLot } from "../components/imports/PanneauDetailLot";
import { rendreVisible } from "../components/imports/CompteursLot";
import type { ParamsApercu } from "../components/imports/ApercuEchantillon";
import type { EchecReception } from "../components/imports/receptionFormulaire.noyau";
import type { FiltresLots as ValeursFiltres, LotDetail, LotListe, MetaImport, ReceptionReponse } from "../components/imports/types";
import { toast } from "../lib/toast";
import {
  CLE_DETAIL, CLE_LISTE, CLE_SOURCES, chargerApercuLot, ecrireParametres, lireParametres, messageErreurDetail, recevoirLot,
  statutHttpDe, telechargerErreursLot, useDetailLot, useListeLots, useMetaImport, useSourcesImport, useValeurRetardee,
} from "./imports/useLotsImport";

/**
 * Page « Lots d'import » (cahier des charges, paragraphe 6.1) : ASSEMBLAGE des briques de
 * `components/imports`. Elle ne décide de rien : les statuts, les étapes, les actions permises et les chiffres sont
 * ceux du serveur (docs/imports/CONTRAT-API-LOTS-IMPORT.md).
 *
 * CE QUE CETTE PAGE NE FAIT PAS
 *
 * - Aucun bouton d'approbation, d'autorisation ou d'import : aucun circuit n'existe côté serveur (les étapes 3 et 4
 *   s'affichent « Non disponible », avec la raison que le serveur donne). Recevoir un lot n'écrit rien.
 * - Aucun état « terminé » déduit d'un geste. L'indicateur d'étapes reflète le lot SÉLECTIONNÉ tel que le serveur
 *   le décrit ; sans lot (ou tant qu'il charge), il le dit.
 * - Aucune liste vide pour une liste en erreur, aucun format inventé quand `/meta` ne répond pas (le formulaire est
 *   alors inactif, avec la raison).
 * - Aucun contrôle de permission : la page est déjà sous ProtectedRoute ADMIN/GESTIONNAIRE, et le serveur revérifie
 *   chaque route. Un 403 est AFFICHÉ (liste, détail, réception), jamais masqué.
 *
 * L'ADRESSE PORTE LE CONTEXTE : `?statut=&source=&q=&lot=`. Sélectionner un lot ne réinitialise pas les filtres ;
 * recharger la page retrouve le même contexte ; un lot inconnu dans l'adresse donne une erreur de détail claire.
 * La recherche texte (`q`) n'interroge le serveur qu'après un court délai sans frappe.
 *
 * ÉCRAN QUI N'A PAS LA PLACE D'UNE DEUXIÈME COLONNE (moins de 1536 px, voir LARGEUR_DETAIL_A_COTE) : le détail s'ouvre SOUS la liste. Choisir un lot y déplace le focus et fait
 * défiler jusqu'à lui ; « Fermer le détail » rend le focus au lot.
 */

/** Délai sans frappe avant que la recherche texte interroge le serveur. */
export const DELAI_FRAPPE_MS = 350;

/**
 * Largeur à partir de laquelle le détail passe À CÔTÉ de la liste. 1536 px (`2xl`) et non 1024 px (`lg`) : la barre
 * latérale prend 256 px, donc à 1024 px la colonne principale n'a que ~430 px (formulaire écrasé, tableau de 8
 * colonnes qui défile et dont le bouton « Voir le détail » est hors champ). Mesuré au navigateur à 1024, 1280 et 1536 px.
 * En dessous, le détail s'ouvre sous la liste (focus et défilement). Une seule constante à changer pour revenir en arrière.
 */
const LARGEUR_DETAIL_A_COTE = 1536;
const REQUETE_GRAND_ECRAN = `(min-width: ${LARGEUR_DETAIL_A_COTE}px)`;

/** Sans `matchMedia` (tests, vieux navigateurs), on suppose un grand écran : le détail est à côté, rien à défiler. */
function lireGrandEcran(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(REQUETE_GRAND_ECRAN).matches;
}

function useGrandEcran(): boolean {
  const [grand, setGrand] = useState(lireGrandEcran);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REQUETE_GRAND_ECRAN);
    const maj = () => setGrand(mq.matches);
    maj();
    mq.addEventListener?.("change", maj);
    return () => mq.removeEventListener?.("change", maj);
  }, []);
  return grand;
}

/** Valeur de substitution tant que `/meta` n'a pas répondu : AUCUN format, AUCUN plafond (rien n'est inventé). */
const META_INDISPONIBLE: MetaImport = { formats: [], tailleMaxOctets: 0, limiteLignes: 0, statuts: [] };

const RAISON_META_EN_COURS = "Chargement des formats pris en charge par le serveur : la réception s'activera dès qu'ils seront connus.";
const RAISON_META_ERREUR = "La réception est indisponible tant que les formats pris en charge par le serveur ne sont pas chargés.";

function texteErreurTechnique(erreur: unknown): string {
  const statut = statutHttpDe(erreur);
  return statut === null ? "Pas de réponse du serveur." : `Réponse du serveur : code ${statut}.`;
}

function messageErreurReception(erreur: unknown): string {
  const brut = (erreur as { response?: { data?: { error?: unknown } } } | null | undefined)?.response?.data?.error;
  return typeof brut === "string" && brut.trim() !== "" ? brut : "Réception refusée.";
}

export function ImportsPage() {
  const client = useQueryClient();
  const idCycle = useId();
  const idListe = useId();
  const [params, setParams] = useSearchParams();
  const { filtres: filtresUrl, lot: lotId } = useMemo(() => lireParametres(params), [params]);
  const grandEcran = useGrandEcran();

  const meta = useMetaImport();
  const sources = useSourcesImport();
  const liste = useListeLots(filtresUrl);
  const detail = useDetailLot(lotId);

  // ---- Adresse -------------------------------------------------------------------------------------
  // `setParams` change d'identité à chaque navigation et sa forme fonctionnelle lit les paramètres de SON rendu :
  // on passe par une référence tenue à jour, pour qu'une réponse arrivée tard (réception) ne rejoue pas une adresse périmée.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const mettreAJourUrl = useCallback((patch: { filtres?: ValeursFiltres; lot?: string | null }, remplacer: boolean) => {
    setParamsRef.current((precedents) => ecrireParametres(precedents, patch), { replace: remplacer });
  }, []);

  // ---- Filtres : le texte saisi s'affiche tout de suite, l'adresse (donc la requête) le suit après le délai ----
  const [qSaisi, setQSaisi] = useState(filtresUrl.q);
  // Dernière valeur de `q` que cette page a écrite dans l'adresse : si l'adresse diffère, le changement vient
  // d'ailleurs (retour arrière) et le champ le suit. Sans cette référence, une espace tapée puis « rognée » par
  // l'adresse disparaîtrait sous les doigts.
  const qEcrit = useRef(filtresUrl.q);
  useEffect(() => {
    if (filtresUrl.q !== qEcrit.current) {
      qEcrit.current = filtresUrl.q;
      setQSaisi(filtresUrl.q);
    }
  }, [filtresUrl.q]);

  const ecrireFiltres = useCallback((f: ValeursFiltres) => {
    qEcrit.current = f.q.trim() === "" ? "" : f.q;
    mettreAJourUrl({ filtres: f }, true);
  }, [mettreAJourUrl]);

  const filtresRef = useRef(filtresUrl);
  filtresRef.current = filtresUrl;
  const ecrireFiltresRef = useRef(ecrireFiltres);
  ecrireFiltresRef.current = ecrireFiltres;
  const qRetardee = useValeurRetardee(qSaisi, DELAI_FRAPPE_MS);
  useEffect(() => {
    if (qRetardee !== qEcrit.current) ecrireFiltresRef.current({ ...filtresRef.current, q: qRetardee });
  }, [qRetardee]);

  function changerFiltres(suivants: ValeursFiltres) {
    const seulementLaFrappe = suivants.q !== qSaisi;
    setQSaisi(suivants.q);
    // Statut, source, « effacer » : tout de suite. Une frappe qui laisse du texte attend le délai.
    if (!seulementLaFrappe || suivants.q.trim() === "") ecrireFiltres(suivants);
  }

  const filtresAffiches: ValeursFiltres = { ...filtresUrl, q: qSaisi };
  const actifs = filtresActifs(filtresUrl);

  // ---- Lot sélectionné, focus et défilement --------------------------------------------------------
  const refDetail = useRef<HTMLDivElement>(null);
  const refListe = useRef<HTMLElement>(null);
  const refTitreListe = useRef<HTMLHeadingElement>(null);
  const focusDetailAttendu = useRef(false);
  const retourFocus = useRef<HTMLElement | "titre" | null>(null);

  const allerAuDetail = useCallback(() => {
    const conteneur = refDetail.current;
    if (!conteneur) return;
    const titre = conteneur.querySelector<HTMLElement>("h2");
    if (titre) {
      titre.setAttribute("tabindex", "-1");
      titre.focus({ preventScroll: true });
    }
    const reduit = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    conteneur.scrollIntoView?.({ block: "start", behavior: reduit ? "auto" : "smooth" });
  }, []);

  function selectionner(id: string) {
    if (!grandEcran) {
      if (id === lotId) allerAuDetail();
      else focusDetailAttendu.current = true;
    }
    mettreAJourUrl({ lot: id }, false);
  }

  // Le conteneur du détail n'existe, sous 1024 px, qu'une fois le lot dans l'adresse : on attend donc ce rendu.
  useEffect(() => {
    if (!focusDetailAttendu.current || lotId === null) return;
    focusDetailAttendu.current = false;
    allerAuDetail();
  }, [lotId, allerAuDetail]);

  function fermerDetail() {
    retourFocus.current = refListe.current?.querySelector<HTMLElement>('[aria-current="true"] button[data-voir-detail]') ?? "titre";
    mettreAJourUrl({ lot: null }, false);
  }

  useEffect(() => {
    if (lotId !== null || retourFocus.current === null) return;
    const cible = retourFocus.current;
    retourFocus.current = null;
    if (cible !== "titre" && cible.isConnected) cible.focus();
    else refTitreListe.current?.focus();
  }, [lotId]);

  // ---- Réception -----------------------------------------------------------------------------------
  // Dernière erreur d'envoi, gardée pour le texte du toast : le formulaire reçoit l'erreur axios telle quelle.
  const derniereErreur = useRef<unknown>(null);
  const soumettre = useCallback<SoumettreReception>(async (donnees, fichier, options) => {
    try {
      return await recevoirLot(donnees, fichier, options);
    } catch (e) {
      derniereErreur.current = e;
      throw e;
    }
  }, []);

  function apresReception(r: ReceptionReponse) {
    if (r.dejaRecu) {
      toast.info(`Fichier déjà reçu : lot ${r.reference}. Rien n'a été écrit.`);
    } else if (r.statut === "REJETE") {
      toast.error(`Lot ${r.reference} rejeté : ${r.motifRejetLot ?? "aucune ligne conforme"}.`);
    } else {
      toast.success(`Lot ${r.reference} reçu : ${r.compteurs.validees} ligne(s) validée(s), ${r.compteurs.rejetees} rejetée(s), ${r.compteurs.ignorees} ignorée(s). Rien n'est encore appliqué.`);
    }
    // Un lot déjà reçu est sélectionné comme les autres : la personne voit le lot existant, pas un lot de plus.
    mettreAJourUrl({ lot: r.id }, false);
    void client.invalidateQueries({ queryKey: CLE_LISTE });
    void client.invalidateQueries({ queryKey: CLE_SOURCES });
    void client.invalidateQueries({ queryKey: [...CLE_DETAIL, r.id] });
  }

  function apresEchec(echec: EchecReception) {
    if (echec.nature === "incertain") {
      // Réponse perdue : le lot a peut-être été enregistré. On recharge la liste sans rien supposer.
      toast.error("La réception n'a pas pu être confirmée : vérifiez la liste des lots avant de réessayer.");
      void client.invalidateQueries({ queryKey: CLE_LISTE });
      void client.invalidateQueries({ queryKey: CLE_SOURCES });
    } else {
      toast.error(messageErreurReception(derniereErreur.current));
    }
    derniereErreur.current = null;
  }

  // ---- Détail ---------------------------------------------------------------------------------------
  const lotDetaille: LotDetail | undefined = detail.data;
  const detailId = lotDetaille?.id;
  const apercu = useCallback((p: ParamsApercu) => chargerApercuLot(detailId ?? "", p), [detailId]);

  const [telechargement, setTelechargement] = useState<string | null>(null);
  async function telechargerErreurs() {
    if (!lotDetaille || telechargement !== null) return;
    setTelechargement(lotDetaille.id);
    try {
      await telechargerErreursLot(lotDetaille);
    } catch {
      toast.error("Téléchargement impossible.");
    } finally {
      setTelechargement(null);
    }
  }

  // ---- Liste ----------------------------------------------------------------------------------------
  const lots = useMemo(() => {
    const vus = new Set<string>();
    const sortie: LotListe[] = [];
    for (const page of liste.data?.pages ?? []) {
      for (const l of page.lots) {
        if (!vus.has(l.id)) { vus.add(l.id); sortie.push(l); }
      }
    }
    return sortie;
  }, [liste.data]);
  const pages = liste.data?.pages ?? [];
  const total = pages.length > 0 ? pages[pages.length - 1].total : undefined;
  const enActualisation = liste.isPlaceholderData;
  const lotHorsFiltres = lotId !== null && actifs && liste.data !== undefined && !enActualisation && !liste.hasNextPage && !lots.some((l) => l.id === lotId);

  let corpsListe: ReactNode;
  if (liste.isPending) {
    corpsListe = <EtatChargement />;
  } else if (liste.isError && !liste.data) {
    corpsListe = (
      <EtatErreur
        statutHttp={statutHttpDe(liste.error)}
        detail={texteErreurTechnique(liste.error)}
        onReessayer={() => void liste.refetch()}
        reessaiEnCours={liste.isFetching}
      />
    );
  } else {
    corpsListe = (
      <div aria-busy={enActualisation} className={enActualisation ? "opacity-60" : undefined}>
        {liste.isError && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-jeton-md border border-etat-critique-trait bg-etat-critique-fond p-3 text-corps text-etat-critique">
            <p className="min-w-0 flex-1 basis-60">
              {liste.isFetchNextPageError
                ? "Les lots suivants n'ont pas pu être chargés. Les lots affichés sont ceux déjà reçus."
                : "La liste n'a pas pu être actualisée : les lots affichés peuvent ne pas être à jour."}
            </p>
            {!liste.isFetchNextPageError && (
              <Button type="button" variant="outline" className="h-auto min-h-cible px-j4" disabled={liste.isFetching} onClick={() => void liste.refetch()}>
                Réessayer
              </Button>
            )}
          </div>
        )}
        {lotHorsFiltres && (
          <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded-jeton-md border border-etat-moyen-trait bg-etat-moyen-fond p-3 text-corps text-avertissement">
            <p className="min-w-0 flex-1 basis-60">Le lot sélectionné ne correspond pas aux filtres actuels : il n'apparaît pas dans cette liste.</p>
            <Button type="button" variant="outline" className="h-auto min-h-cible px-j4" onClick={() => changerFiltres(FILTRES_LOTS_VIDES)}>
              Effacer les filtres
            </Button>
          </div>
        )}
        <ListeLots
          lots={lots}
          total={total ?? lots.length}
          selectionId={lotId}
          onSelect={selectionner}
          onChargerPlus={() => void liste.fetchNextPage()}
          peutChargerPlus={Boolean(liste.hasNextPage)}
          chargementPlus={liste.isFetchingNextPage}
          renderStatut={(l) => <BadgeStatutLot statut={l.statut} />}
          renderVide={() => (actifs
            ? <EtatVide filtresActifs onEffacerFiltres={() => changerFiltres(FILTRES_LOTS_VIDES)} />
            : <EtatVide />)}
        />
      </div>
    );
  }

  // ---- Cycle (indicateur d'étapes) -------------------------------------------------------------------
  const detailEnErreur = lotId !== null && detail.isError && !lotDetaille;
  const detailEnChargement = lotId !== null && detail.isPending;
  let legendeCycle: string;
  if (lotId === null) legendeCycle = "Aucun lot sélectionné : choisissez un lot dans la liste pour voir où il en est.";
  else if (lotDetaille) legendeCycle = `Étapes du lot ${rendreVisible(lotDetaille.reference)}, telles que le serveur les décrit.`;
  else if (detailEnErreur) legendeCycle = "Les étapes du lot sélectionné n'ont pas pu être chargées : les étapes ci-dessous ne décrivent aucun lot.";
  else legendeCycle = "Chargement des étapes du lot sélectionné : les étapes ci-dessous ne décrivent encore aucun lot.";

  const metaPrete = meta.data;
  const raisonMeta = metaPrete ? undefined : meta.isError ? RAISON_META_ERREUR : RAISON_META_EN_COURS;

  return (
    <div className="min-w-0 space-y-4">
      <BandeauGouvernance />

      <section aria-labelledby={idCycle} aria-busy={detailEnChargement} className="min-w-0 space-y-2">
        <h2 id={idCycle} className="text-section font-semibold text-foreground">Cycle du lot</h2>
        <p className="text-corps text-muted-foreground">{legendeCycle}</p>
        <IndicateurEtapes etapes={lotDetaille?.etapes} />
      </section>

      <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)] 2xl:items-start">
        <div className="min-w-0 space-y-4">
          {meta.isError && !metaPrete && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-jeton-md border border-etat-critique-trait bg-etat-critique-fond p-j4 text-corps text-etat-critique">
              <div className="min-w-0 flex-1 basis-60">
                <p className="font-semibold">Les formats et plafonds du serveur n'ont pas pu être chargés.</p>
                <p className="text-foreground">{texteErreurTechnique(meta.error)} Le formulaire reste inactif : il n'affiche que ce que le serveur annonce.</p>
              </div>
              <Button type="button" variant="default" className="h-auto min-h-cible px-j4" disabled={meta.isFetching} aria-busy={meta.isFetching} onClick={() => void meta.refetch()}>
                {meta.isFetching ? "Nouvelle tentative en cours" : "Recharger les formats"}
              </Button>
            </div>
          )}

          <FormulaireReception
            // Remonté quand `/meta` arrive : le format par défaut se choisit à l'ouverture, d'après les formats annoncés.
            key={metaPrete ? "formats-connus" : "formats-inconnus"}
            meta={metaPrete ?? META_INDISPONIBLE}
            sourcesConnues={sources.data ?? []}
            desactive={!metaPrete}
            raisonDesactive={raisonMeta}
            onSoumettre={soumettre}
            onRecu={apresReception}
            onEchec={apresEchec}
          />

          {!grandEcran && lotId !== null && (
            <div>
              <Button type="button" variant="outline" className="h-auto min-h-cible px-j4" onClick={allerAuDetail}>
                Aller au détail du lot sélectionné
              </Button>
            </div>
          )}

          <section ref={refListe} aria-labelledby={idListe} className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-card-foreground sm:p-6">
            <h2 id={idListe} ref={refTitreListe} tabIndex={-1} className="text-section font-semibold text-foreground">Lots reçus</h2>
            <FiltresLots
              filtres={filtresAffiches}
              sources={sources.data ?? []}
              onChange={changerFiltres}
              total={enActualisation ? undefined : total}
            />
            {sources.isError && (
              <div role="status" className="flex flex-wrap items-center gap-3 text-corps text-muted-foreground">
                <p className="min-w-0 flex-1 basis-60">Les sources déjà reçues n'ont pas pu être chargées : le filtre par source est incomplet.</p>
                <Button type="button" variant="outline" className="h-auto min-h-cible px-j4" disabled={sources.isFetching} onClick={() => void sources.refetch()}>
                  Réessayer
                </Button>
              </div>
            )}
            {corpsListe}
          </section>
        </div>

        {(grandEcran || lotId !== null) && (
          <div ref={refDetail} className="min-w-0 2xl:sticky 2xl:top-0 2xl:max-h-[calc(100dvh-8rem)] 2xl:overflow-y-auto">
            <PanneauDetailLot
              detail={lotDetaille}
              chargement={detailEnChargement}
              erreur={detailEnErreur ? messageErreurDetail(detail.error) : undefined}
              onFermer={fermerDetail}
              onReessayer={() => void detail.refetch()}
              onTelechargerErreurs={() => void telechargerErreurs()}
              telechargementEnCours={telechargement !== null && telechargement === lotDetaille?.id}
              renderStatut={(l) => <BadgeStatutLot statut={l.statut} />}
              chargerApercu={apercu}
            />
          </div>
        )}
      </div>
    </div>
  );
}
