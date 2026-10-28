import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Crosshair, FilePlus2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { BandeauHorsLigne, EtatChargement, EtatErreur, EtatVide } from "../components/projets-voirie/EtatsPv";
import { PanneauAnalyse } from "../components/projets-voirie/PanneauAnalyse";
import { PanneauCouches, nomDuJeu } from "../components/projets-voirie/PanneauCouches";
import { FicheObjet } from "../components/projets-voirie/FicheObjet";
import { Echantillon, EchantillonAxes, EchantillonConflit } from "../components/projets-voirie/Motifs";
import { useAuth } from "../lib/auth";
import {
  useAnalyse, useCarte, useDecisionJeu, useEnLigne, useModifierProjet, useProjet, useRetirerJeu, useValeurDifferee,
} from "../lib/projetsVoirieHooks";
import { exporterCsv, lireObjetCarte, type JeuProjet, type ObjetCarte } from "../lib/projetsVoirieApi";
import {
  CLES_CONFLIT, STYLE_CONFLIT, arrondirBbox, classerErreur, contientBbox, elargirBbox, formaterNombre, peutEcrireProjets, styleJeu,
  type Bbox, type CleConflit, type Largeurs,
} from "../lib/projetsVoirie";

// Leaflet n'est charge qu'a l'ouverture d'un projet.
const CarteProjet = lazy(() => import("../components/projets-voirie/CarteProjet").then((m) => ({ default: m.CarteProjet })));
const DialogueDepot = lazy(() => import("../components/projets-voirie/DialogueDepot").then((m) => ({ default: m.DialogueDepot })));

/**
 * Page d'un projet : carte plein cadre et panneau a deux onglets (Analyse, Couches).
 *
 * Disposition : l'ordre du DOM est l'ordre de lecture ET de tabulation (barre de la carte, carte, panneau) ; il ne change pas d'un point de
 * rupture a l'autre. Sous 1280 px, une seule colonne : la carte puis le panneau. A partir de 1280 px, la carte a gauche et le panneau a droite.
 *
 * Aucun stockage local : l'etat vit dans React, les donnees dans la memoire de React Query. Les jeux en quarantaine (CONTROLE) ne sont ni sur
 * la carte ni dans l'analyse tant que l'interrupteur « Afficher aussi les donnees non autorisees » est eteint.
 *
 * La carte est dans un contexte d'empilement propre (`isolate z-0`) : sans lui, les panneaux de Leaflet (z-index 400 a 1000) passent AU-DESSUS
 * des dialogues (z-50).
 */

type IdOnglet = "analyse" | "couches";
const ONGLETS: { id: IdOnglet; libelle: string }[] = [{ id: "analyse", libelle: "Analyse" }, { id: "couches", libelle: "Couches" }];
const PLAFOND_OBJETS_LISTE = 5000;
const CONFLITS_PAR_DEFAUT: Record<CleConflit, boolean> = { chaussee: true, emprise: true, hors: false, croisements: true };

export function ProjetVoirieDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const enLigne = useEnLigne();
  const peutEcrire = peutEcrireProjets(user?.role);
  const estAdmin = user?.role === "ADMIN";

  const projet = useProjet(id);
  const [onglet, setOnglet] = useState<IdOnglet>("analyse");
  const [fond, setFond] = useState<"osm" | "satellite">("osm");
  const [apercu, setApercu] = useState<Largeurs | null>(null);
  const [afficherNonAutorises, setAfficherNonAutorises] = useState(false);
  const [masques, setMasques] = useState<ReadonlySet<string>>(new Set());
  const [conflitsVisibles, setConflitsVisibles] = useState(CONFLITS_PAR_DEFAUT);
  const [vue, setVue] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [requete, setRequete] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [cadrageCle, setCadrageCle] = useState(0);
  const [selection, setSelection] = useState<ObjetCarte | null>(null);
  const [depot, setDepot] = useState(false);
  const [jeuEnAvant, setJeuEnAvant] = useState<string | null>(null);
  const refTitreFiche = useRef<HTMLHeadingElement>(null);
  const refOnglets = useRef<Array<HTMLButtonElement | null>>([]);
  const tronqueRef = useRef(false);

  const fiche = projet.data;
  const jeux = useMemo(() => fiche?.jeux ?? [], [fiche]);
  const jeuParId = useMemo(() => new Map(jeux.map((j) => [j.id, j])), [jeux]);

  // Jeux qui peuvent apparaitre : AUTORISE toujours, CONTROLE/RECU seulement a la demande ; moins ceux que l'utilisateur a decoches.
  const idsVisibles = useMemo(() => jeux
    .filter((j) => j.statut === "AUTORISE" || ((j.statut === "CONTROLE" || j.statut === "RECU") && afficherNonAutorises))
    .filter((j) => !masques.has(j.id)).map((j) => j.id), [jeux, afficherNonAutorises, masques]);
  const visibles = useMemo(() => new Set(idsVisibles), [idsVisibles]);

  // Emprise de requete : la vue elargie de 10 %, redemandee seulement quand la vue en sort, change de zoom, ou si le serveur a tronque.
  const vueDiff = useValeurDifferee(vue, 350);
  useEffect(() => {
    if (!vueDiff) return;
    setRequete((r) => {
      const a = arrondirBbox(elargirBbox(vueDiff.bbox));
      if (r && r.zoom === vueDiff.zoom && contientBbox(r.bbox, vueDiff.bbox) && !tronqueRef.current) return r;
      return { bbox: a, zoom: vueDiff.zoom };
    });
  }, [vueDiff]);

  const carte = useCarte(id, { jeux: idsVisibles, bbox: requete?.bbox ?? null, zoom: requete?.zoom ?? null, inclureNonAutorises: afficherNonAutorises }, !!requete && enLigne);
  const analyse = useAnalyse(id, apercu, afficherNonAutorises);

  const couches = useMemo(() => (carte.data ?? []).filter((c) => visibles.has(c.jeuId)), [carte.data, visibles]);
  const tronques = useMemo(() => new Set(couches.filter((c) => c.tronque).map((c) => c.jeuId)), [couches]);
  tronqueRef.current = tronques.size > 0;
  const objets = useMemo(() => {
    const sortie: ObjetCarte[] = [];
    for (const c of couches) {
      for (const f of c.features) {
        if (sortie.length >= PLAFOND_OBJETS_LISTE) return sortie;
        sortie.push({ ...lireObjetCarte(c.jeuId, f), nonAutorise: c.nonAutorise || (jeuParId.get(c.jeuId)?.nonAutorise ?? false) });
      }
    }
    return sortie;
  }, [couches, jeuParId]);

  const modifier = useModifierProjet(id ?? "");
  const retirer = useRetirerJeu(id ?? "");
  const decision = useDecisionJeu(id ?? "");

  const surVue = useCallback((bbox: Bbox, zoom: number) => setVue({ bbox, zoom }), []);
  const nomJeu = useCallback((jeuId: string | null) => { const j = jeuId ? jeuParId.get(jeuId) : undefined; return j ? `${nomDuJeu(j)}, v${j.version}` : "Jeu inconnu"; }, [jeuParId]);

  function choisirObjet(o: ObjetCarte) {
    setSelection(o);
    setTimeout(() => refTitreFiche.current?.focus(), 0);
  }

  function voirJeu(jeuId: string) {
    setDepot(false);
    setOnglet("couches");
    // Un instant de retard : a la fermeture du dialogue, Radix rend le focus au bouton d'origine (setTimeout 0) ; le jeu doit le reprendre APRES.
    setTimeout(() => setJeuEnAvant(jeuId), 100);
    setTimeout(() => setJeuEnAvant(null), 1200);
  }

  function surToucheOnglet(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let cible = i;
    if (e.key === "ArrowRight") cible = (i + 1) % ONGLETS.length;
    else if (e.key === "ArrowLeft") cible = (i - 1 + ONGLETS.length) % ONGLETS.length;
    else if (e.key === "Home") cible = 0;
    else if (e.key === "End") cible = ONGLETS.length - 1;
    else return;
    e.preventDefault();
    setOnglet(ONGLETS[cible].id);
    refOnglets.current[cible]?.focus();
  }

  // Un changement de projet repart de zero.
  useEffect(() => { setSelection(null); setApercu(null); setMasques(new Set()); setRequete(null); setVue(null); }, [id]);

  if (projet.isPending) return <EtatChargement libelle="Chargement du projet…" />;
  if (projet.isError || !fiche) {
    return (
      <div className="space-y-3">
        <Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Projets de voirie</Link>
        {!enLigne && <BandeauHorsLigne />}
        <EtatErreur erreur={classerErreur(projet.error)} sujet="Projet" onReessayer={() => void projet.refetch()} enCours={projet.isFetching} />
      </div>
    );
  }

  const autorises = jeux.filter((j) => j.statut === "AUTORISE");
  const enAttente = jeux.filter((j) => j.statut === "CONTROLE" || j.statut === "RECU").length;
  const sansDonnee = autorises.length === 0;
  const erreurCarte = carte.isError ? classerErreur(carte.error) : null;
  const zones = analyse.data?.conflits;
  const conflitsDisponibles = !!zones && (!!zones.zones.chaussee || !!zones.zones.emprise || !!zones.zones.hors || (zones.croisements?.features.length ?? 0) > 0);
  const jeuxAffiches = jeux.filter((j) => visibles.has(j.id));
  const selJeu = selection ? jeuParId.get(selection.jeuId) ?? null : null;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Projets de voirie</Link>
          <h1 className="break-words text-xl font-bold text-navy">{fiche.nom}</h1>
          <p className="text-sm text-gray-600">{fiche.code}{(fiche.commune || fiche.prefecture) ? ` · ${[fiche.commune, fiche.prefecture].filter(Boolean).join(", ")}` : ""}</p>
          {fiche.description && <p className="max-w-prose text-sm text-gray-700">{fiche.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={() => setCadrageCle((c) => c + 1)} disabled={!fiche.bbox}>
            <Crosshair aria-hidden="true" /> Centrer sur le projet
          </Button>
          {peutEcrire && (
            <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setDepot(true)}>
              <FilePlus2 aria-hidden="true" /> Ajouter des données
            </Button>
          )}
        </div>
      </header>

      {!enLigne && <BandeauHorsLigne />}
      {enAttente > 0 && (
        <p role="status" data-testid="bandeau-a-autoriser" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <strong>{enAttente} fichier(s) à autoriser.</strong> Un fichier reçu n&apos;est pas un fichier importé : il n&apos;alimente le projet qu&apos;après autorisation.{" "}
          <button type="button" className="font-medium underline" onClick={() => setOnglet("couches")}>Ouvrir l&apos;onglet Couches</button>
        </p>
      )}

      <div className="flex flex-col gap-3 xl:grid xl:grid-cols-[minmax(0,1fr)_420px] xl:items-start">
        <section aria-label="Zone cartographique" className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <h2 className="sr-only">Carte du projet</h2>
          <a href="#pv-panneau" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded focus:bg-white focus:p-2 focus:text-sm">
            Passer la carte et aller au panneau d&apos;analyse
          </a>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-200 px-3 py-2">
            <fieldset className="flex items-center gap-3">
              <legend className="sr-only">Fond de carte</legend>
              {(["osm", "satellite"] as const).map((k) => (
                <label key={k} className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-sm text-gray-900 xl:min-h-0">
                  <input type="radio" name="pv-fond" value={k} checked={fond === k} onChange={() => setFond(k)} className="h-4 w-4" />
                  {k === "osm" ? "Plan (OpenStreetMap)" : "Satellite (Esri)"}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-gray-600" aria-live="polite">
              {carte.isFetching && requete ? "Chargement des objets…" : `${formaterNombre(objets.length, 0)} objet(s) affiché(s)`}
            </p>
          </div>
          {tronques.size > 0 && (
            <p role="status" data-testid="bandeau-tronque" className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
              Affichage tronqué : le serveur plafonne le nombre d&apos;objets par réponse (20 000). Zoomez pour voir le détail de la zone.
            </p>
          )}
          {erreurCarte && (
            <div className="p-2"><EtatErreur erreur={erreurCarte} sujet="Carte" onReessayer={() => void carte.refetch()} enCours={carte.isFetching} /></div>
          )}
          <div className="relative isolate z-0 h-[55vh] min-h-[340px] xl:h-[calc(100vh-17rem)]" data-fond={fond}>
            <Suspense fallback={<EtatChargement libelle="Chargement de la carte…" />}>
              <CarteProjet
                fond={fond} bbox={fiche.bbox} cadrageCle={cadrageCle} couches={couches} jeux={jeux} analyse={analyse.data}
                conflitsVisibles={conflitsVisibles} selection={selection} onSelect={choisirObjet} onVue={surVue}
              />
            </Suspense>
            {sansDonnee && (
              <p data-testid="carte-vide" className="pointer-events-none absolute left-1/2 top-3 z-[500] w-[min(92%,26rem)] -translate-x-1/2 rounded-md border border-gray-300 bg-white/95 p-2 text-center text-sm text-gray-800 shadow">
                Ce projet n&apos;a pas encore de données autorisées. Ajoutez un plan d&apos;axes ou un réseau, puis autorisez le fichier reçu.
              </p>
            )}
          </div>
          <Legende jeux={jeuxAffiches} conflitsVisibles={conflitsDisponibles ? conflitsVisibles : null} />
        </section>

        <aside id="pv-panneau" aria-label="Panneau du projet" className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm xl:max-h-[calc(100vh-11rem)] xl:overflow-y-auto">
          {selection && (
            <div className="mb-3">
              <FicheObjet ref={refTitreFiche} objet={selection} jeu={selJeu} onFermer={() => setSelection(null)} />
            </div>
          )}
          <div role="tablist" aria-label="Contenu du panneau" className="flex gap-1">
            {ONGLETS.map((o, i) => (
              <button
                key={o.id} ref={(el) => { refOnglets.current[i] = el; }} type="button" role="tab" id={`pv-onglet-${o.id}`}
                aria-selected={onglet === o.id} aria-controls={`pv-panneau-${o.id}`} tabIndex={onglet === o.id ? 0 : -1}
                onClick={() => setOnglet(o.id)} onKeyDown={(e) => surToucheOnglet(e, i)}
                className={`min-h-[44px] rounded-md px-4 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 ${onglet === o.id ? "bg-navy text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
              >
                {o.libelle}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`pv-panneau-${onglet}`} aria-labelledby={`pv-onglet-${onglet}`} className="mt-3">
            {onglet === "analyse" ? (
              <div className="space-y-3">
                {sansDonnee && (
                  <EtatVide titre="Ce projet n'a pas encore de données">
                    <p>Pour commencer : 1. déposez le plan d&apos;axes de travaux ; 2. déposez les réseaux des concessionnaires ; 3. autorisez les fichiers reçus (onglet Couches).</p>
                    <p>Chaque dépôt est d&apos;abord simulé : rien n&apos;est écrit avant votre confirmation. Les formats acceptés sont KML et GeoJSON.</p>
                    {!peutEcrire && <p>Seuls un gestionnaire et un administrateur peuvent déposer des fichiers.</p>}
                  </EtatVide>
                )}
                <PanneauAnalyse
                  projet={fiche} jeux={jeux} requete={analyse} apercu={apercu} onApercu={setApercu} nomJeu={nomJeu}
                  peutEcrire={peutEcrire} estAdmin={estAdmin} enLigne={enLigne}
                  enregistrer={(corps) => modifier.mutateAsync(corps)}
                  exporter={() => exporterCsv(fiche.id, fiche.code, apercu, afficherNonAutorises)}
                />
              </div>
            ) : (
              <PanneauCouches
                jeux={jeux} visibles={visibles}
                onBasculerJeu={(jid, v) => setMasques((m) => { const n = new Set(m); if (v) n.delete(jid); else n.add(jid); return n; })}
                afficherNonAutorises={afficherNonAutorises} onAfficherNonAutorises={setAfficherNonAutorises}
                conflitsVisibles={conflitsVisibles} onBasculerConflit={(c, v) => setConflitsVisibles((x) => ({ ...x, [c]: v }))} conflitsDisponibles={conflitsDisponibles}
                tronques={tronques} objets={objets} onChoisirObjet={choisirObjet}
                peutEcrire={peutEcrire} enLigne={enLigne}
                retirer={(jid) => retirer.mutateAsync(jid)}
                decider={(jid, d, justification) => decision.mutateAsync({ jeuId: jid, decision: d, justification })}
                jeuMisEnAvant={jeuEnAvant}
              />
            )}
          </div>
        </aside>
      </div>

      {depot && (
        <Suspense fallback={null}>
          <DialogueDepot projetId={fiche.id} enLigne={enLigne} onFermer={() => setDepot(false)} onVoirJeu={voirJeu} />
        </Suspense>
      )}
    </div>
  );
}

/** Legende TEXTUELLE de ce qui est affiche : couleur, motif de trait (nomme) et libelle. */
function Legende({ jeux, conflitsVisibles }: { jeux: JeuProjet[]; conflitsVisibles: Record<CleConflit, boolean> | null }) {
  const lignes = new Map<string, { s: ReturnType<typeof styleJeu>; nonAutorise: boolean }>();
  for (const j of jeux) {
    const s = styleJeu(j.role, j.typeReseau ?? j.concessionnaire?.typeReseau ?? null);
    lignes.set(`${s.libelle}-${j.nonAutorise}`, { s, nonAutorise: j.nonAutorise });
  }
  const conflits = conflitsVisibles ? CLES_CONFLIT.filter((c) => conflitsVisibles[c]) : [];
  return (
    <div className="border-t border-gray-200 px-3 py-2">
      <p className="text-xs font-semibold text-gray-800">Légende</p>
      {lignes.size === 0 && conflits.length === 0 ? (
        <p className="text-xs text-gray-600">Aucune couche affichée.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-800">
          {[...lignes.values()].map(({ s, nonAutorise }) => (
            <li key={`${s.libelle}-${nonAutorise}`} className="flex items-center gap-1">
              {s.libelle === "Axes de travaux" ? <EchantillonAxes /> : <Echantillon couleur={s.couleur} motif={s.motif} epaisseur={s.epaisseur} />}
              {s.libelle} ({s.nomMotif}){nonAutorise ? ", non autorisé, trait atténué" : ""}
            </li>
          ))}
          {conflits.map((c) => (
            <li key={c} className="flex items-center gap-1"><EchantillonConflit cle={c} />{STYLE_CONFLIT[c].libelle} ({STYLE_CONFLIT[c].nomMotif})</li>
          ))}
        </ul>
      )}
    </div>
  );
}
