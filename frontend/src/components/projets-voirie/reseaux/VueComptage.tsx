import { useId, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Select } from "../../ui/Input";
import { EtatErreur } from "../EtatsPv";
import { nomDuJeu } from "../PanneauCouches";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";
import type { ComptageReseau } from "../../../lib/projetsVoirieReseauxApi";
import { useComptageReseau } from "../../../lib/projetsVoirieReseauxHooks";
import { MENTION_3D, MENTION_LIGNES_CABLES, ROLES_JEU_QUALIFIABLES, classerErreurReseau, libelleTypeObjet, texteMetres } from "../../../lib/projetsVoirieReseaux";
import { formaterNombre } from "../../../lib/projetsVoirie";

/**
 * Comptage par nature. Trois grandeurs DISTINCTES, chacune avec son libelle et dans sa propre carte, jamais additionnees :
 *   - le nombre d'infrastructures physiques DECLAREES (objets declares, sans dedoublonnage geometrique) ;
 *   - la longueur de trace FUSIONNEE (union des traces : un trace superpose compte une fois) ;
 *   - la SOMME des longueurs de circuits (un trace partage par N circuits y compte N fois : ce n'est pas une longueur de cable).
 * Il n'existe aucun total « tous objets ». Un fichier de N lignes n'est pas N cables. Une valeur absente est « non fournie », jamais zero.
 */

const n0 = (v: number | null) => (v === null ? "non fourni" : formaterNombre(v, 0));
const m = (v: number | null) => texteMetres(v, "non fournie");

function Carte({ id, titre, sousTitre, children }: { id: string; titre: string; sousTitre?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} data-testid={id} className="space-y-1.5 rounded-md border border-gray-300 bg-white p-2">
      <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-800">{titre}</h4>
      {sousTitre && <p className="text-[11px] text-gray-700">{sousTitre}</p>}
      {children}
    </section>
  );
}

function Mesure({ libelle, valeur, aide, essentiel }: { libelle: string; valeur: string; aide?: string; essentiel?: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-1.5">
      <dt className="text-[11px] text-gray-800">{libelle}</dt>
      <dd className={`${essentiel ? "text-base font-bold" : "text-sm font-semibold"} text-gray-900`}>{valeur}</dd>
      {aide && <dd className="text-[11px] text-gray-700">{aide}</dd>}
    </div>
  );
}

const typesTexte = (parType: Record<string, number>) => {
  const e = Object.entries(parType).filter(([, v]) => v > 0);
  return e.length === 0 ? null : e.map(([t, v]) => `${t === "INCONNU" ? "type non renseigné" : libelleTypeObjet(t).toLowerCase()} : ${formaterNombre(v, 0)}`).join(" · ");
};

export function ResultatComptage({ c }: { c: ComptageReseau }) {
  const L = c.libelles;
  const i = c.infrastructures;
  const k = c.circuits;
  return (
    <div className="space-y-3" data-testid="resultat-comptage">
      <p role="note" data-testid="mention-lignes-cables" className="rounded-md border border-navy/40 border-l-4 bg-blue-50 p-2 text-xs font-medium text-blue-900">{MENTION_LIGNES_CABLES}</p>
      <p role="note" data-testid="mention-aucun-total" className="text-xs text-gray-900">
        Ces grandeurs sont distinctes et ne s&apos;additionnent jamais : <strong>il n&apos;existe aucun total « tous objets »</strong>. Chacune se lit avec son libellé.
      </p>

      <Carte id="pv-cpt-infra" titre="Infrastructures physiques" sousTitre="Ce qui est posé : conduites, gaines, câbles, chambres.">
        <dl className="grid gap-1.5 sm:grid-cols-2">
          <Mesure libelle={L.nombreInfrastructuresDeclarees ?? "Nombre d'infrastructures physiques déclarées (objets déclarés, sans dédoublonnage géométrique)"} valeur={n0(i.nombreDeclare)} essentiel />
          <Mesure libelle={L.longueurTraceFusionneM ?? "Longueur de trace fusionnée (union des tracés : un tracé superposé ne compte qu'une fois)"} valeur={m(i.longueurTraceFusionneM)} />
          <Mesure libelle="Somme des longueurs des infrastructures linéaires" valeur={m(i.longueurSommeM)} aide={i.nombreLineaires !== null ? `${formaterNombre(i.nombreLineaires, 0)} infrastructure(s) linéaire(s)` : undefined} />
        </dl>
        {typesTexte(i.parType) && <p className="text-[11px] text-gray-700">Par type : {typesTexte(i.parType)}</p>}
      </Carte>

      <Carte id="pv-cpt-circuits" titre="Circuits logiques" sousTitre="Des parcours (liaisons, fibres, services), pas des câbles : plusieurs circuits peuvent suivre le même support.">
        <dl className="grid gap-1.5 sm:grid-cols-2">
          <Mesure libelle={L.nombreCircuitsDeclares ?? "Nombre de circuits logiques déclarés (ce n'est pas un nombre de câbles physiques)"} valeur={n0(k.nombreDeclare)} essentiel />
          <Mesure libelle={L.sommeLongueursCircuitsM ?? "Somme des longueurs de circuits (un tracé partagé par N circuits y compte N fois : ce n'est pas une longueur de câble)"} valeur={m(k.sommeLongueursCircuitsM)} />
          <Mesure libelle={L.longueurTraceFusionneM ?? "Longueur de trace fusionnée (union des tracés : un tracé superposé ne compte qu'une fois)"} valeur={m(k.longueurTraceFusionneM)} />
          <Mesure libelle="Circuits qui se superposent exactement" valeur={`${n0(k.tracesPartagees.circuitsConcernes)} circuit(s) en ${n0(k.tracesPartagees.groupes)} groupe(s) de tracé identique`} aide="Ils restent séparés : ce ne sont pas des câbles distincts." />
        </dl>
        <div data-testid="support-physique">
          <p className="text-[11px] font-medium text-gray-800">Support physique des circuits (une proposition n&apos;est pas un support validé)</p>
          <ul className="list-disc pl-5 text-xs text-gray-900">
            <li>Avec un support validé par une personne : {n0(k.supportPhysique.avecSupportValide)}</li>
            <li>Avec une proposition seulement (aucun effet) : {n0(k.supportPhysique.avecPropositionSeulement)}</li>
            <li>Sans support connu (inconnu, jamais supposé) : {n0(k.supportPhysique.sansSupportConnu)}</li>
          </ul>
        </div>
        {typesTexte(k.parType) && <p className="text-[11px] text-gray-700">Par type : {typesTexte(k.parType)}</p>}
      </Carte>

      <Carte id="pv-cpt-equipements" titre="Équipements" sousTitre="Comptés à part : ni infrastructures, ni circuits.">
        <dl className="grid gap-1.5 sm:grid-cols-2"><Mesure libelle="Nombre d'équipements déclarés" valeur={n0(c.equipements.nombreDeclare)} essentiel /></dl>
        {typesTexte(c.equipements.parType) && <p className="text-[11px] text-gray-700">Par type : {typesTexte(c.equipements.parType)}</p>}
      </Carte>

      <Carte id="pv-cpt-inconnue" titre="Nature inconnue" sousTitre={L.natureInconnue ?? "Objets de nature inconnue : comptés ni comme infrastructures ni comme circuits."}>
        <dl className="grid gap-1.5 sm:grid-cols-2"><Mesure libelle="Objets de nature inconnue" valeur={n0(c.natureInconnue.nombreObjets)} essentiel /></dl>
      </Carte>

      {c.avertissements.length > 0 && (
        <section aria-labelledby="pv-cpt-avert" className="space-y-1">
          <h4 id="pv-cpt-avert" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Avertissements du serveur</h4>
          <ul data-testid="avertissements-comptage" className="list-disc space-y-0.5 pl-5 text-xs text-gray-900">{c.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>
      )}

      {c.qualite && (
        <section aria-labelledby="pv-cpt-qualite" className="space-y-1">
          <h4 id="pv-cpt-qualite" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Qualité des objets comptés</h4>
          <p className="text-xs text-gray-900">
            Classe de précision déclarée : {["A", "B", "C", "D", "E", "inconnue"].map((cl) => `${cl === "inconnue" ? "non renseignée" : cl} : ${n0(c.qualite?.parClasse[cl] ?? null)}`).join(" · ")}.
          </p>
          <p className="text-xs text-gray-900">
            Objets avec une profondeur ou une altitude fournie : {n0(c.qualite.objetsAvecDonneesVerticales)} ; sans profondeur : {n0(c.qualite.sansProfondeur)} ; sans altitude : {n0(c.qualite.sansAltitude)}. Évaluables en 3D : {n0(c.qualite.evaluables)}.
          </p>
          <p className="text-[11px] text-gray-700">{c.qualite.mentionVerticale ?? MENTION_3D}</p>
        </section>
      )}

      {c.jeux.length > 0 && (
        <section aria-labelledby="pv-cpt-jeux" className="space-y-1">
          <h4 id="pv-cpt-jeux" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Faits de chaque jeu (jamais additionnés)</h4>
          <ul className="space-y-1">
            {c.jeux.map((j, idx) => (
              <li key={`${j.jeuId ?? idx}`} className="rounded border border-gray-200 p-1.5 text-xs text-gray-900">
                <span className="font-medium break-words">{j.concessionnaire ?? j.nomFichier ?? "Jeu sans nom"}</span>{j.version !== null ? `, version ${j.version}` : ""}{j.nonAutorise ? " (non autorisé)" : ""}
                {" : "}{n0(j.nbObjets)} circuit(s) ou objet(s) du fichier ; longueur totale {m(j.longueurTotaleM)} ; trace fusionnée {m(j.longueurTraceFusionneM)}.
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.limites.length > 0 && (
        <section aria-labelledby="pv-cpt-limites" className="space-y-1">
          <h4 id="pv-cpt-limites" className="text-xs font-semibold uppercase tracking-wide text-gray-800">Limites</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-900">{c.limites.map((l) => <li key={l}>{l}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

export function VueComptage({ projetId, jeux, peutEcrire, actif }: { projetId: string; jeux: JeuProjet[]; peutEcrire: boolean; actif: boolean }) {
  const idJeu = useId();
  const idNA = useId();
  const [jeuId, setJeuId] = useState("");
  const [inclure, setInclure] = useState(false);
  const requete = useComptageReseau(projetId, jeuId || null, peutEcrire && inclure, actif);
  const jeuxReseau = jeux.filter((j) => ROLES_JEU_QUALIFIABLES.includes(j.role) && j.statut !== "RETIRE");
  const erreur = requete.isError ? classerErreurReseau(requete.error) : null;
  return (
    <section aria-labelledby="pv-titre-comptage" className="space-y-3">
      <h3 id="pv-titre-comptage" className="text-sm font-semibold text-navy">Comptage par nature</h3>
      <div className="grid gap-2">
        <div>
          <label htmlFor={idJeu} className="block text-xs font-medium text-gray-800">Jeu compté</label>
          <Select id={idJeu} value={jeuId} onChange={(e) => setJeuId(e.target.value)} className="border-gray-300">
            <option value="">Tous les jeux autorisés du projet</option>
            {jeuxReseau.map((j) => <option key={j.id} value={j.id}>{nomDuJeu(j)}, version {j.version}{j.nonAutorise ? " (non autorisé)" : ""}</option>)}
          </Select>
        </div>
        {peutEcrire && (
          <label htmlFor={idNA} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input id={idNA} type="checkbox" className="h-4 w-4" checked={inclure} onChange={(e) => setInclure(e.target.checked)} />
            Inclure aussi les jeux en attente d&apos;autorisation (un jeu en attente remplace le jeu autorisé du même réseau)
          </label>
        )}
      </div>
      {requete.isPending && actif && <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Calcul du comptage… (jusqu&apos;à 20 s)</p>}
      {erreur && <EtatErreur erreur={erreur} sujet="Comptage" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
      {requete.isSuccess && <ResultatComptage c={requete.data} />}
    </section>
  );
}
