import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ShieldAlert, Trash2, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/Input";
import type { JeuProjet, ObjetCarte } from "../../lib/projetsVoirieApi";
import {
  AIDE_CLASSE, CLES_CONFLIT, JUSTIFICATION_MIN, LIBELLE_CONFIDENTIALITE, LIBELLE_NATURE, LIBELLE_ROLE, LIBELLE_STATUT_JEU, MESSAGE_QUARANTAINE, ROLES_JEU, STYLE_CONFLIT,
  classerErreur, classeIncertaine, formaterDate, formaterNombre, styleJeu,
  type CleConflit, type RoleJeu, type StatutJeu,
} from "../../lib/projetsVoirie";
import { Echantillon, EchantillonConflit } from "./Motifs";

/**
 * Onglet « Couches » : une ligne par jeu de donnees (case, couleur ET motif, concessionnaire, version, statut, date, classe de precision,
 * retrait avec confirmation), les jeux RECUS A AUTORISER (quarantaine : non affiches par defaut, boutons Autoriser et Rejeter avec
 * justification obligatoire), les couches de conflit, et une LISTE des objets affiches : c'est la voie clavier vers la fiche d'un objet
 * (les traces de la carte ne sont pas des arrets de tabulation, voir ElementsCarteHorsTabulation).
 */

export const nomDuJeu = (j: Pick<JeuProjet, "concessionnaire" | "role" | "nomFichier">) => j.concessionnaire?.nom ?? (j.role === "RESEAU_TIERS" ? j.nomFichier : LIBELLE_ROLE[j.role]);

/** Pastille de statut : le MOT porte l'information, jamais la seule couleur. */
export function BadgeStatutJeu({ statut }: { statut: StatutJeu }) {
  const classes: Record<StatutJeu, string> = {
    CONTROLE: "border-amber-400 bg-amber-100 text-amber-900",
    RECU: "border-amber-400 bg-amber-100 text-amber-900",
    AUTORISE: "border-green-400 bg-green-50 text-green-900",
    REJETE: "border-red-300 bg-red-50 text-red-900",
    REMPLACE: "border-gray-300 bg-gray-100 text-gray-800",
    RETIRE: "border-gray-300 bg-gray-100 text-gray-800",
  };
  return <span data-statut={statut} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold ${classes[statut]}`}>{LIBELLE_STATUT_JEU[statut]}</span>;
}

export type Decision = "autoriser" | "rejeter";

export interface PropsPanneauCouches {
  jeux: JeuProjet[];
  visibles: ReadonlySet<string>;
  onBasculerJeu: (id: string, visible: boolean) => void;
  afficherNonAutorises: boolean;
  onAfficherNonAutorises: (b: boolean) => void;
  conflitsVisibles: Record<CleConflit, boolean>;
  onBasculerConflit: (cle: CleConflit, visible: boolean) => void;
  conflitsDisponibles: boolean;
  tronques: ReadonlySet<string>;
  objets: ObjetCarte[];
  onChoisirObjet: (o: ObjetCarte) => void;
  peutEcrire: boolean;
  enLigne: boolean;
  retirer: (jeuId: string) => Promise<unknown>;
  decider: (jeuId: string, decision: Decision, justification: string) => Promise<unknown>;
  /** Jeu a mettre en avant (lien « voir le jeu existant » d'un 409) : la ligne prend le focus. */
  jeuMisEnAvant?: string | null;
}

type PropsLigne = PropsPanneauCouches & { onDecision: (j: JeuProjet, d: Decision) => void; onRetrait: (j: JeuProjet) => void };

const PLAFOND_LISTE = 100;

function LigneJeu({ j, p, enAvant }: { j: JeuProjet; p: PropsLigne; enAvant: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (enAvant) { ref.current?.scrollIntoView?.({ block: "nearest" }); ref.current?.focus(); } }, [enAvant]);
  const s = styleJeu(j.role, j.typeReseau ?? j.concessionnaire?.typeReseau ?? null);
  const idCase = `pv-case-${j.id}`;
  const quarantaine = j.statut === "CONTROLE" || j.statut === "RECU";
  const affichable = !quarantaine || p.afficherNonAutorises;
  return (
    <li ref={ref} id={`pv-jeu-${j.id}`} tabIndex={-1} className="rounded border border-gray-200 bg-white p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy">
      <div className="flex items-start gap-2">
        <input id={idCase} type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={affichable && p.visibles.has(j.id)} disabled={!affichable} onChange={(e) => p.onBasculerJeu(j.id, e.target.checked)} />
        <div className="min-w-0 flex-1">
          <label htmlFor={idCase} className="block cursor-pointer text-sm font-medium text-gray-900 break-words">
            <Echantillon couleur={s.couleur} motif={s.motif} epaisseur={s.epaisseur} /> {nomDuJeu(j)}
          </label>
          <p className="mt-0.5"><BadgeStatutJeu statut={j.statut} />{" "}
            <span className="text-[11px] text-gray-700">{s.libelle} · trait : {s.nomMotif} · version {j.version}</span></p>
          <p className="text-[11px] text-gray-700">
            {formaterNombre(j.nbObjets, 0)} circuit(s) ou objet(s) · {j.dateDonnees ? `données du ${formaterDate(j.dateDonnees)}` : "date des données non renseignée"} · {j.format ?? "format inconnu"}
          </p>
          <p className="text-[11px] text-gray-700" data-testid={`classe-${j.id}`}>
            Classe de précision : <strong>{AIDE_CLASSE[j.classePrecision]}</strong>
            {j.role === "RESEAU_TIERS" && classeIncertaine(j.classePrecision) && <> : position indicative, les résultats sont une proximité à vérifier</>}
          </p>
          <p className="text-[11px] text-gray-700">Nature : {LIBELLE_NATURE[j.natureObjet]} · {LIBELLE_CONFIDENTIALITE[j.confidentialite]}</p>
          <p className="break-all text-[11px] text-gray-600">{j.nomFichier}</p>
          {j.origineFichier && <p className="break-words text-[11px] text-gray-600">Origine : {j.origineFichier}</p>}
          {j.justification && <p className="break-words text-[11px] text-gray-600">Justification : {j.justification}</p>}
          {quarantaine && !p.afficherNonAutorises && <p className="text-[11px] text-amber-900">Non affiché : activez « Afficher aussi les données non autorisées » pour le voir sur la carte.</p>}
          {p.tronques.has(j.id) && (
            <p role="status" className="mt-1 flex items-start gap-1 text-[11px] text-amber-900">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
              Affichage tronqué : le serveur plafonne le nombre d&apos;objets envoyés. Zoomez pour voir le détail.
            </p>
          )}
        </div>
      </div>
      {p.peutEcrire && (
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          {quarantaine && (
            <>
              <Button type="button" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Autoriser le jeu ${nomDuJeu(j)}, version ${j.version}`} onClick={() => p.onDecision(j, "autoriser")}>
                <Check aria-hidden="true" /> Autoriser
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Rejeter le jeu ${nomDuJeu(j)}, version ${j.version}`} onClick={() => p.onDecision(j, "rejeter")}>
                <X aria-hidden="true" /> Rejeter
              </Button>
            </>
          )}
          {j.statut === "AUTORISE" && (
            <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!p.enLigne} aria-label={`Retirer le jeu ${nomDuJeu(j)}, version ${j.version}`} onClick={() => p.onRetrait(j)}>
              <Trash2 aria-hidden="true" /> Retirer
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function PanneauCouches(p: PropsPanneauCouches) {
  const idFiltre = useId();
  const idJustif = useId();
  const [filtre, setFiltre] = useState("");
  const [aRetirer, setARetirer] = useState<JeuProjet | null>(null);
  const [decision, setDecision] = useState<{ jeu: JeuProjet; type: Decision } | null>(null);
  const [justification, setJustification] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const autorises = p.jeux.filter((j) => j.statut === "AUTORISE");
  const quarantaine = p.jeux.filter((j) => j.statut === "CONTROLE" || j.statut === "RECU");
  const rejetes = p.jeux.filter((j) => j.statut === "REJETE").length;
  const remplaces = p.jeux.filter((j) => j.statut === "REMPLACE").length;
  const nomParJeu = useMemo(() => new Map(p.jeux.map((j) => [j.id, nomDuJeu(j)])), [p.jeux]);

  const correspondants = useMemo(() => {
    const f = filtre.trim().toLowerCase();
    return f ? p.objets.filter((o) => (o.nom ?? "").toLowerCase().includes(f) || (nomParJeu.get(o.jeuId) ?? "").toLowerCase().includes(f)) : p.objets;
  }, [p.objets, filtre, nomParJeu]);

  const ligneProps: PropsLigne = {
    ...p,
    onDecision: (jeu, type) => { setErreur(null); setJustification(""); setDecision({ jeu, type }); },
    onRetrait: (j) => { setErreur(null); setARetirer(j); },
  };

  async function confirmerRetrait() {
    if (!aRetirer) return;
    setEnCours(true);
    setErreur(null);
    try { await p.retirer(aRetirer.id); setARetirer(null); } catch (e) { setErreur(classerErreur(e).message); } finally { setEnCours(false); }
  }

  const justifOk = justification.trim().length >= JUSTIFICATION_MIN;
  async function confirmerDecision() {
    if (!decision || !justifOk) return;
    setEnCours(true);
    setErreur(null);
    try { await p.decider(decision.jeu.id, decision.type, justification.trim()); setDecision(null); } catch (e) { setErreur(classerErreur(e).message); } finally { setEnCours(false); }
  }

  const ligne = (j: JeuProjet) => <LigneJeu key={j.id} j={j} p={ligneProps} enAvant={p.jeuMisEnAvant === j.id} />;

  return (
    <div className="space-y-4">
      <section aria-labelledby="pv-titre-jeux" className="space-y-2">
        <h3 id="pv-titre-jeux" className="text-sm font-semibold text-navy">Jeux de données autorisés</h3>
        {autorises.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-700">Aucun jeu autorisé. Utilisez « Ajouter des données » pour déposer un plan d&apos;axes, un réseau de concessionnaire ou des limites de route ; le fichier devra ensuite être autorisé.</p>
        ) : (
          ROLES_JEU.map((role: RoleJeu) => {
            const lignes = autorises.filter((j) => j.role === role);
            if (lignes.length === 0) return null;
            return (
              <div key={role} role="group" aria-label={LIBELLE_ROLE[role]} className="space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">{LIBELLE_ROLE[role]}</h4>
                <ul className="space-y-1">{lignes.map(ligne)}</ul>
              </div>
            );
          })
        )}
        {remplaces > 0 && <p className="text-[11px] text-gray-600">{remplaces} version(s) remplacée(s) restent conservées en base ; elles ne s&apos;affichent plus.</p>}
        {rejetes > 0 && <p className="text-[11px] text-gray-600">{rejetes} jeu(x) rejeté(s) restent conservés en base avec leur justification ; ils n&apos;alimentent ni la carte ni l&apos;analyse.</p>}
      </section>

      <section aria-labelledby="pv-titre-quarantaine" className="space-y-2">
        <h3 id="pv-titre-quarantaine" className="flex items-center gap-1 text-sm font-semibold text-navy"><ShieldAlert aria-hidden="true" className="h-4 w-4" /> Fichiers reçus, à autoriser</h3>
        <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{MESSAGE_QUARANTAINE}</p>
        <label className="flex items-start gap-2 text-sm text-gray-900">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={p.afficherNonAutorises} onChange={(e) => p.onAfficherNonAutorises(e.target.checked)} />
          <span>Afficher aussi les données non autorisées <span className="block text-[11px] text-gray-600">Carte et analyse : elles sont alors marquées « non autorisé ».</span></span>
        </label>
        {quarantaine.length === 0 ? (
          <p className="text-xs text-gray-600">Aucun fichier en attente d&apos;autorisation.</p>
        ) : (
          <ul className="space-y-1">{quarantaine.map(ligne)}</ul>
        )}
      </section>

      <section aria-labelledby="pv-titre-conflits-couches" className="space-y-2">
        <h3 id="pv-titre-conflits-couches" className="text-sm font-semibold text-navy">Couches de conflit</h3>
        {!p.conflitsDisponibles && <p className="text-xs text-gray-700">Les couches de conflit apparaissent quand l&apos;analyse est calculée (il faut au moins un axe de travaux et un réseau autorisés).</p>}
        <ul className="space-y-1">
          {CLES_CONFLIT.map((cle) => {
            const s = STYLE_CONFLIT[cle];
            const idCase = `pv-conflit-${cle}`;
            return (
              <li key={cle} className="flex items-start gap-2 rounded border border-gray-200 bg-white p-2">
                <input id={idCase} type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={p.conflitsVisibles[cle]} disabled={!p.conflitsDisponibles} onChange={(e) => p.onBasculerConflit(cle, e.target.checked)} />
                <div className="min-w-0">
                  <label htmlFor={idCase} className="block cursor-pointer text-sm font-medium text-gray-900"><EchantillonConflit cle={cle} /> {s.libelle}</label>
                  <p className="text-[11px] text-gray-700">{s.explication} Tracé : {s.nomMotif}.</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="pv-titre-objets" className="space-y-2">
        <h3 id="pv-titre-objets" className="text-sm font-semibold text-navy">Objets affichés sur la carte</h3>
        <p className="text-xs text-gray-700">Liste alternative à la carte, au clavier : choisissez un objet pour ouvrir sa fiche.</p>
        <label htmlFor={idFiltre} className="block text-xs font-medium text-gray-800">Filtrer par nom d&apos;objet ou de jeu</label>
        <Input id={idFiltre} value={filtre} onChange={(e) => setFiltre(e.target.value)} autoComplete="off" className="border-gray-300" />
        {p.objets.length === 0 ? (
          <p className="text-xs text-gray-600">Aucun objet n&apos;est affiché pour la vue actuelle (couche masquée, vue hors des données, ou chargement en cours).</p>
        ) : correspondants.length === 0 ? (
          <p role="status" className="text-xs text-gray-600">Aucun objet ne correspond à ce filtre.</p>
        ) : (
          <>
            <p role="status" className="text-xs text-gray-600">{correspondants.length > PLAFOND_LISTE ? `${PLAFOND_LISTE} premiers objets sur ${formaterNombre(correspondants.length, 0)} : affinez le filtre.` : `${correspondants.length} objet(s).`}</p>
            <ul className="max-h-64 space-y-0.5 overflow-auto rounded border border-gray-200 bg-white p-1">
              {correspondants.slice(0, PLAFOND_LISTE).map((o, i) => (
                <li key={`${o.jeuId}-${o.id ?? i}`}>
                  <button type="button" onClick={() => p.onChoisirObjet(o)} className="flex min-h-[44px] w-full flex-col rounded px-2 py-1 text-left text-xs hover:bg-gray-100 xl:min-h-0">
                    <span className="font-medium text-gray-900 break-words">{o.nom ?? "Objet sans nom"}</span>
                    <span className="text-[11px] text-gray-600 break-words">{nomParJeu.get(o.jeuId) ?? "Jeu inconnu"}{o.nonAutorise ? " · non autorisé" : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <Dialog open={aRetirer !== null} onOpenChange={(o) => { if (!o && !enCours) setARetirer(null); }}>
        <DialogContent masquerCroix className="max-w-[440px]">
          <DialogTitle className="text-base font-semibold text-primary">Retirer ce jeu de données ?</DialogTitle>
          <DialogDescription className="text-sm text-gray-700">
            {aRetirer && <>Le jeu <strong>{nomDuJeu(aRetirer)}</strong> (version {aRetirer.version}, fichier {aRetirer.nomFichier}) disparaît de la carte et de l&apos;analyse. </>}
            Il n&apos;est pas supprimé : le retrait est logique, le jeu reste conservé et le retrait est consigné dans le journal d&apos;audit.
          </DialogDescription>
          {erreur && aRetirer && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={enCours} onClick={() => setARetirer(null)}>Annuler</Button>
            <Button type="button" variant="danger" disabled={enCours} onClick={() => void confirmerRetrait()}>{enCours ? "Retrait…" : "Retirer le jeu"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={decision !== null} onOpenChange={(o) => { if (!o && !enCours) setDecision(null); }}>
        <DialogContent masquerCroix className="max-w-[480px]">
          <DialogTitle className="text-base font-semibold text-primary">{decision?.type === "autoriser" ? "Autoriser ce jeu de données" : "Rejeter ce jeu de données"}</DialogTitle>
          <DialogDescription className="text-sm text-gray-700">
            {decision && <>Jeu <strong>{nomDuJeu(decision.jeu)}</strong> (version {decision.jeu.version}, fichier {decision.jeu.nomFichier}). </>}
            {decision?.type === "autoriser"
              ? "Une fois autorisé, il alimente la carte et l'analyse du projet."
              : "Une fois rejeté, il n'alimente jamais la carte ni l'analyse ; il reste conservé avec sa justification."}
            {" "}La justification est obligatoire et consignée dans le journal d&apos;audit.
          </DialogDescription>
          <div>
            <label htmlFor={idJustif} className="block text-sm font-medium text-gray-900">Justification ({JUSTIFICATION_MIN} caractères minimum)</label>
            <textarea id={idJustif} value={justification} onChange={(e) => setJustification(e.target.value)} rows={3} maxLength={1000} disabled={enCours} aria-describedby={`${idJustif}-aide`} className="mt-1 w-full rounded-md border border-gray-400 p-2 text-sm" />
            <p id={`${idJustif}-aide`} className={`text-xs ${justifOk ? "text-green-800" : "text-gray-600"}`}>{justification.trim().length} / {JUSTIFICATION_MIN} caractères minimum</p>
          </div>
          {erreur && decision && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={enCours} onClick={() => setDecision(null)}>Annuler</Button>
            <Button type="button" disabled={enCours || !justifOk} onClick={() => void confirmerDecision()}>
              {enCours ? "Enregistrement…" : decision?.type === "autoriser" ? "Autoriser le jeu" : "Rejeter le jeu"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
