import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { BandeauHorsLigne, EtatChargement, EtatErreur, EtatVide } from "../components/projets-voirie/EtatsPv";
import { ProfilWorkflowVue, SectionDossiersJeux } from "../components/projets-voirie/workflow/SectionProfilEtDossiers";
import { SectionDemandes } from "../components/projets-voirie/workflow/SectionDemandes";
import { SectionRecolements } from "../components/projets-voirie/workflow/SectionRecolements";
import { SectionReferents } from "../components/projets-voirie/workflow/SectionReferents";
import { SectionTaches } from "../components/projets-voirie/workflow/SectionTaches";
import { useAuth } from "../lib/auth";
import { useConcessionnaires, useEnLigne, useProjet } from "../lib/projetsVoirieHooks";
import { useMonProfil } from "../lib/projetsVoirieWorkflowHooks";
import type { ProfilWorkflow } from "../lib/projetsVoirieWorkflowApi";
import { BANDEAU_WORKFLOW, LIBELLE_SECTION, aLeDroit, classerErreurWorkflow, sectionsOuvertes, type SectionWorkflow } from "../lib/projetsVoirieWorkflow";

/**
 * « Echanges avec les concessionnaires » (lot B3) : mon profil, demandes de donnees, taches, recolements, dossiers et jeux, referents.
 *
 * L'APPLICATION N'ENVOIE RIEN (courriel, message, ordre) : elle ENREGISTRE des echanges faits hors application. Aucune action ne deplace un reseau ni n'ordonne des travaux.
 * Seules les actions que le serveur permet au compte sont proposees (`droits` de `GET workflow/mon-profil`, `transitionsPossibles` de chaque element).
 *
 * Un compte REFERENT (rattache a un concessionnaire) n'ouvre que cet ecran : le serveur lui refuse tout le reste du module (403 COMPTE_REFERENT_RESTREINT) et la liste et
 * la page projet le redirigent ici sans message d'erreur brut. Aucun stockage local : l'etat vit dans React, les donnees dans la memoire de React Query.
 */

export const CHEMIN_ECHANGES = "/projets-voirie/echanges";

function SelectionProjet({ profil }: { profil: ProfilWorkflow }) {
  if (profil.referent && profil.rattachements.length === 1) return <Navigate to={`/projets-voirie/${encodeURIComponent(profil.rattachements[0].projet.id)}/echanges`} replace />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold text-navy">Échanges avec les concessionnaires</h1>
      <p role="note" data-testid="bandeau-workflow" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{BANDEAU_WORKFLOW}</p>
      {profil.referent ? (
        profil.rattachements.length === 0 ? (
          <EtatVide titre="Aucun rattachement actif"><p>Votre compte est rattaché à un concessionnaire, mais aucun projet visible pour votre compte n&apos;est associé à un rattachement actif. Contactez un administrateur.</p></EtatVide>
        ) : (
          <section aria-labelledby="pv-choix-projet" className="space-y-2">
            <h2 id="pv-choix-projet" className="text-sm font-semibold text-navy">Choisissez un projet</h2>
            <ul className="space-y-1.5">
              {profil.rattachements.map((r) => (
                <li key={r.id}>
                  <Link to={`/projets-voirie/${encodeURIComponent(r.projet.id)}/echanges`} className="flex min-h-[44px] flex-col justify-center rounded border border-gray-300 bg-white p-2 text-sm text-navy underline hover:bg-gray-50">
                    <span className="font-medium">{r.projet.nom ?? r.projet.code ?? "Projet sans nom"}{r.projet.code ? ` (${r.projet.code})` : ""}</span>
                    <span className="text-xs text-gray-700">Concessionnaire : {r.concessionnaire.nom ?? "sans nom"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <EtatVide titre="Choisissez d'abord un projet">
          <p>Les échanges avec les concessionnaires se tiennent projet par projet : ouvrez un projet depuis la liste, puis « Échanges avec les concessionnaires ».</p>
          <p><Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center text-navy underline">Aller à la liste des projets</Link></p>
        </EtatVide>
      )}
    </div>
  );
}

function EcranProjet({ projetId, profil }: { projetId: string; profil: ProfilWorkflow }) {
  const { user } = useAuth();
  const enLigne = useEnLigne();
  const referent = profil.referent;
  const estAdmin = user?.role === "ADMIN";
  const projet = useProjet(referent ? undefined : projetId);
  const sections = useMemo(() => sectionsOuvertes(profil.droits), [profil.droits]);
  const initiale: SectionWorkflow = sections.includes("demandes") ? "demandes" : sections.includes("taches") ? "taches" : "profil";
  const [section, setSection] = useState<SectionWorkflow>(initiale);
  const [visitees, setVisitees] = useState<ReadonlySet<SectionWorkflow>>(new Set([initiale]));
  const refOnglets = useRef<Array<HTMLButtonElement | null>>([]);
  const peutLireConcessionnaires = !referent && (aLeDroit(profil.droits, "demande.ecrire") || aLeDroit(profil.droits, "referent.gerer"));
  const concessionnaires = useConcessionnaires(peutLireConcessionnaires);
  const rattachement = profil.rattachements.find((r) => r.projet.id === projetId) ?? null;

  const choisir = (s: SectionWorkflow) => { setSection(s); setVisitees((v) => new Set(v).add(s)); };
  function surTouche(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let cible = i;
    if (e.key === "ArrowRight") cible = (i + 1) % sections.length;
    else if (e.key === "ArrowLeft") cible = (i - 1 + sections.length) % sections.length;
    else if (e.key === "Home") cible = 0;
    else if (e.key === "End") cible = sections.length - 1;
    else return;
    e.preventDefault();
    choisir(sections[cible]);
    refOnglets.current[cible]?.focus();
  }

  // Un referent n'ouvre que les projets ou il est rattache : sinon on le dit, sans appeler le serveur.
  if (referent && !rattachement) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold text-navy">Échanges avec les concessionnaires</h1>
        <EtatVide titre="Vous n'êtes pas rattaché à ce projet">
          <p>Votre compte n&apos;a pas de rattachement actif sur ce projet.</p>
          <p><Link to={CHEMIN_ECHANGES} className="inline-flex min-h-[44px] items-center text-navy underline">Voir mes projets</Link></p>
        </EtatVide>
      </div>
    );
  }
  if (!referent && projet.isError) {
    return (
      <div className="space-y-3">
        <Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Projets de voirie</Link>
        <EtatErreur erreur={classerErreurWorkflow(projet.error)} sujet="Projet" onReessayer={() => void projet.refetch()} enCours={projet.isFetching} />
      </div>
    );
  }

  const nomProjet = referent ? rattachement?.projet.nom ?? rattachement?.projet.code : projet.data?.nom;
  const codeProjet = referent ? rattachement?.projet.code : projet.data?.code;
  const commun = { projetId, profil, enLigne, concessionnaires: concessionnaires.data ?? [] };

  return (
    <div className="space-y-3">
      <header className="min-w-0 space-y-0.5">
        {referent ? (
          profil.rattachements.length > 1 && <Link to={CHEMIN_ECHANGES} className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Mes projets</Link>
        ) : (
          <Link to={`/projets-voirie/${encodeURIComponent(projetId)}`} className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Retour au projet</Link>
        )}
        <h1 className="break-words text-xl font-bold text-navy">Échanges avec les concessionnaires</h1>
        <p className="text-sm text-gray-600">{nomProjet ?? "Chargement du projet…"}{codeProjet ? ` (${codeProjet})` : ""}{referent && rattachement ? ` · concessionnaire ${rattachement.concessionnaire.nom ?? "sans nom"}` : ""}</p>
      </header>

      {!enLigne && <BandeauHorsLigne />}
      <p role="note" data-testid="bandeau-workflow" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{BANDEAU_WORKFLOW}</p>

      <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div role="tablist" aria-label="Sections des échanges" className="flex flex-wrap gap-1">
          {sections.map((s, i) => (
            <button
              key={s} ref={(el) => { refOnglets.current[i] = el; }} type="button" role="tab" id={`pv-ech-onglet-${s}`} aria-selected={section === s} aria-controls={`pv-ech-panneau-${s}`} tabIndex={section === s ? 0 : -1}
              onClick={() => choisir(s)} onKeyDown={(e) => surTouche(e, i)}
              className={`min-h-[44px] rounded-md px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 ${section === s ? "bg-navy text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
            >
              {LIBELLE_SECTION[s]}
            </button>
          ))}
        </div>
        <div className="mt-3">
          {sections.filter((s) => visitees.has(s)).map((s) => (
            <div key={s} role="tabpanel" id={`pv-ech-panneau-${s}`} aria-labelledby={`pv-ech-onglet-${s}`} hidden={section !== s}>
              {s === "profil" && <ProfilWorkflowVue profil={profil} />}
              {s === "demandes" && <SectionDemandes {...commun} />}
              {s === "taches" && <SectionTaches {...commun} userId={user?.id} nomUtilisateur={user?.nomComplet} estAdmin={estAdmin} />}
              {s === "recolements" && <SectionRecolements {...commun} estAdmin={estAdmin} />}
              {s === "dossiers" && <SectionDossiersJeux projetId={projetId} />}
              {s === "referents" && <SectionReferents projetId={projetId} profil={profil} enLigne={enLigne} concessionnaires={commun.concessionnaires} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProjetVoirieWorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const profil = useMonProfil();
  const enLigne = useEnLigne();
  if (profil.isPending) return <EtatChargement libelle="Chargement de votre profil…" />;
  if (profil.isError || !profil.data) {
    return (
      <div className="space-y-3">
        {!enLigne && <BandeauHorsLigne />}
        <EtatErreur erreur={classerErreurWorkflow(profil.error)} sujet="Profil" onReessayer={() => void profil.refetch()} enCours={profil.isFetching} />
      </div>
    );
  }
  return id ? <EcranProjet key={id} projetId={id} profil={profil.data} /> : <SelectionProjet profil={profil.data} />;
}
