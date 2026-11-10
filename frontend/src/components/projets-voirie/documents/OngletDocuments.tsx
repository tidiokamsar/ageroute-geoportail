import { useId, useMemo, useRef, useState } from "react";
import { FilePlus } from "lucide-react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsPv";
import { BadgeStatutDocument } from "./commun";
import { CompletudeDocuments } from "./CompletudeDocuments";
import { FicheDocument, type GestesFiche } from "./FicheDocument";
import { DialogueCreationDocument, DialoguePiece, DialogueRetraitDocument, DialogueStatutDocument, type JeuLiable } from "./DialoguesDocument";
import { useConcessionnaires } from "../../../lib/projetsVoirieHooks";
import { useReferentiel } from "../../../lib/projetsVoirieTerritoiresHooks";
import {
  useChangerStatutDocument, useCreerDocument, useDeposerPiece, useDocuments, useNouvelleVersion, useRetirerDocument,
} from "../../../lib/projetsVoirieDocumentsHooks";
import { libelleDeCode } from "../../../lib/projetsVoirieTerritoires";
import {
  LIBELLE_STATUT_DOCUMENT, STATUTS_DOCUMENT, classerErreurDocuments, textePiece,
  type Avertissement, type DocumentProjet, type ResultatEcritureDocument, type StatutDocument,
} from "../../../lib/projetsVoirieDocuments";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";

/**
 * Onglet « Documents » de la fiche projet (lot D1, interface UI-D) : ce que les documents permettent, puis la liste des documents (versions courantes
 * ou toutes, filtre par statut et par type, pagination par curseur), la fiche d'un document et ses gestes.
 *
 * - Lecteur (ni ADMIN ni GESTIONNAIRE) : le serveur ne rend que les documents VALIDE ; aucun bouton d'ecriture, aucun filtre de statut.
 * - Decideur : creation d'un document attendu ou recu, depot, nouvelle version, statut (matrice du serveur ; VALIDE jamais propose au deposant), retrait.
 * Rien n'est conserve localement ; les filtres ne sont pas dans l'adresse de la page.
 */

type Dialogue =
  | { genre: "creation" }
  | { genre: "piece"; d: DocumentProjet; geste: "DEPOT" | "VERSION" }
  | { genre: "statut"; d: DocumentProjet; statut: StatutDocument; justificationExigee: boolean }
  | { genre: "retrait"; d: DocumentProjet };

export function OngletDocuments({ projetId, actif, peutEcrire, role, compteId, enLigne, jeux }: {
  projetId: string; actif: boolean; peutEcrire: boolean; role: string | undefined; compteId: string | undefined; enLigne: boolean; jeux: readonly JeuProjet[];
}) {
  const id = useId();
  const [versions, setVersions] = useState<"courantes" | "toutes">("courantes");
  const [statuts, setStatuts] = useState<StatutDocument[]>([]);
  const [typeCode, setTypeCode] = useState("");
  const filtres = useMemo(() => ({ versions, statuts, typeCode: typeCode || null }), [versions, statuts, typeCode]);
  const liste = useDocuments(projetId, filtres, actif);
  const types = useReferentiel("TYPE_DOCUMENT", actif);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const [retour, setRetour] = useState<{ message: string; avertissements: Avertissement[] } | null>(null);
  const refFiche = useRef<HTMLHeadingElement>(null);
  const concessionnaires = useConcessionnaires(peutEcrire && dialogue?.genre === "creation");

  const creer = useCreerDocument(projetId);
  const deposer = useDeposerPiece(projetId);
  const version = useNouvelleVersion(projetId);
  const statut = useChangerStatutDocument(projetId);
  const retirer = useRetirerDocument(projetId);

  const documents = liste.data?.pages.flatMap((p) => p.documents) ?? [];
  const ignores = liste.data?.pages.reduce((n, p) => n + p.ignores, 0) ?? 0;
  const jeuxLiables: JeuLiable[] = jeux.filter((j) => j.statut !== "RETIRE").map((j) => ({ id: j.id, nomFichier: j.nomFichier, role: j.role, version: j.version, statut: j.statut }));

  function ouvrir(docId: string) {
    setOuvert(docId);
    setTimeout(() => refFiche.current?.focus(), 0);
  }
  function apres(r: ResultatEcritureDocument, message: string) {
    setRetour({ message, avertissements: r.avertissements });
    ouvrir(r.document.id);
    return r;
  }
  const gestes: GestesFiche = {
    onStatut: (d, s, justificationExigee) => setDialogue({ genre: "statut", d, statut: s, justificationExigee }),
    onPiece: (d, geste) => setDialogue({ genre: "piece", d, geste }),
    onRetrait: (d) => setDialogue({ genre: "retrait", d }),
    onVoirVersion: (docId) => ouvrir(docId),
  };
  function basculerStatut(s: StatutDocument, coche: boolean) {
    setStatuts((x) => (coche ? [...x, s] : x.filter((y) => y !== s)));
  }

  return (
    <section aria-labelledby="pv-titre-documents" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="pv-titre-documents" className="text-sm font-semibold text-navy">Documents du dossier</h3>
          <p className="text-xs text-gray-700">
            {peutEcrire ? "Pièces attendues et reçues, versionnées ; chaque geste est consigné dans l'historique du document." : "Seules les pièces validées sont visibles de votre compte."}
          </p>
        </div>
        {peutEcrire && (
          <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setDialogue({ genre: "creation" })}>
            <FilePlus aria-hidden="true" /> Nouveau document
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{retour?.message ?? ""}</p>
      {retour && (retour.avertissements.length > 0) && (
        <div data-testid="avertissements-depot" className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-semibold">{retour.message}</p>
          <ul className="list-disc pl-5">{retour.avertissements.map((a) => <li key={a.code} data-code={a.code}>{a.message || a.code}</li>)}</ul>
          <button type="button" className="min-h-[44px] font-medium underline xl:min-h-0" onClick={() => setRetour(null)}>Masquer ces avertissements</button>
        </div>
      )}

      <CompletudeDocuments projetId={projetId} actif={actif} />

      <div className="space-y-2 rounded-md border border-gray-200 p-2">
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Versions affichées</legend>
          {(["courantes", "toutes"] as const).map((v) => (
            <label key={v} className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-sm text-gray-900 xl:min-h-0">
              <input type="radio" name={`${id}-versions`} className="h-4 w-4" checked={versions === v} onChange={() => setVersions(v)} />
              {v === "courantes" ? "Versions courantes" : "Toutes les versions"}
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor={`${id}-type`} className="block text-xs font-medium text-gray-900">Type de document</label>
          <Select id={`${id}-type`} value={typeCode} onChange={(e) => setTypeCode(e.target.value)} className="mt-0.5 border-gray-300">
            <option value="">Tous les types</option>
            {(types.data?.valeurs ?? []).map((t) => <option key={t.code} value={t.code}>{libelleDeCode(t.code, types.data?.valeurs)}</option>)}
          </Select>
        </div>
        {peutEcrire && (
          <fieldset>
            <legend className="text-xs font-medium text-gray-900">Statuts (aucune case : tous)</legend>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {STATUTS_DOCUMENT.map((s) => (
                <label key={s} className="flex min-h-[44px] cursor-pointer items-center gap-1 text-xs text-gray-900 xl:min-h-0">
                  <input type="checkbox" className="h-4 w-4" checked={statuts.includes(s)} onChange={(e) => basculerStatut(s, e.target.checked)} />
                  {LIBELLE_STATUT_DOCUMENT[s]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      {liste.isPending && <EtatChargement libelle="Chargement des documents…" />}
      {liste.isError && <EtatErreur erreur={classerErreurDocuments(liste.error)} sujet="Documents" onReessayer={() => void liste.refetch()} enCours={liste.isFetching} />}
      {liste.isSuccess && documents.length === 0 && (
        statuts.length || typeCode ? <EtatVide titre="Aucun document ne correspond à ces filtres" /> : (
          <EtatVide titre={peutEcrire ? "Aucun document dans ce dossier" : "Aucune pièce validée dans ce dossier"}>
            <p>{peutEcrire ? "Créez un document attendu pour signaler une pièce demandée, ou déposez directement une pièce reçue." : "Les pièces apparaissent ici une fois validées par un gestionnaire ou un administrateur."}</p>
          </EtatVide>
        )
      )}
      {ignores > 0 && <p className="text-xs text-amber-900">{ignores} document(s) de forme illisible n&apos;ont pas pu être affichés.</p>}
      {documents.length > 0 && (
        <ul aria-label="Documents du dossier" className="space-y-2">
          {documents.map((d) => (
            <li key={d.id}>
              <article aria-label={`${d.titre}, version ${d.version}`} className={`space-y-1 rounded-md border p-2 text-xs ${ouvert === d.id ? "border-navy bg-gray-50" : "border-gray-200"}`}>
                <p className="flex flex-wrap items-center gap-2"><span className="break-words text-sm font-semibold text-gray-900">{d.titre}</span><BadgeStatutDocument statut={d.statut} /></p>
                <p className="text-gray-800">{d.type?.libelle ?? libelleDeCode(d.typeCode, types.data?.valeurs)} · version {d.version}{d.concessionnaire ? ` · ${d.concessionnaire.nom}` : ""}</p>
                <p className="break-words text-gray-700">Pièce : {textePiece(d)}</p>
                <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" aria-pressed={ouvert === d.id} onClick={() => (ouvert === d.id ? setOuvert(null) : ouvrir(d.id))}>
                  {ouvert === d.id ? "Fermer la fiche" : "Ouvrir la fiche"}<span className="sr-only"> du document {d.titre}, version {d.version}</span>
                </Button>
              </article>
            </li>
          ))}
        </ul>
      )}
      {liste.hasNextPage && (
        <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={liste.isFetchingNextPage} onClick={() => void liste.fetchNextPage()}>
          {liste.isFetchingNextPage ? "Chargement…" : "Documents suivants"}
        </Button>
      )}

      {ouvert && (
        <FicheDocument key={ouvert} ref={refFiche} projetId={projetId} docId={ouvert} peutEcrire={peutEcrire} role={role} compteId={compteId} enLigne={enLigne} gestes={gestes} onFermer={() => setOuvert(null)} />
      )}

      {peutEcrire && dialogue?.genre === "creation" && (
        <DialogueCreationDocument
          types={types.data?.valeurs ?? []} concessionnaires={concessionnaires.data ?? []} jeux={jeuxLiables} enLigne={enLigne} onFermer={() => setDialogue(null)}
          onValider={async (d, piece) => apres(await creer.mutateAsync({ d, piece }), "Document créé.")}
        />
      )}
      {peutEcrire && dialogue?.genre === "piece" && (
        <DialoguePiece
          document={dialogue.d} geste={dialogue.geste} jeux={jeuxLiables} enLigne={enLigne} onFermer={() => setDialogue(null)}
          onValider={async (piece) => {
            const d = dialogue.d;
            return dialogue.geste === "DEPOT"
              ? apres(await deposer.mutateAsync({ docId: d.id, piece }), "Pièce déposée : le document est reçu.")
              : apres(await version.mutateAsync({ docId: d.id, piece }), `Version ${d.version + 1} déposée.`);
          }}
        />
      )}
      {peutEcrire && dialogue?.genre === "statut" && (
        <DialogueStatutDocument
          document={dialogue.d} statut={dialogue.statut} justificationExigee={dialogue.justificationExigee} enLigne={enLigne} onFermer={() => setDialogue(null)}
          onValider={async (justification) => apres(await statut.mutateAsync({ docId: dialogue.d.id, statut: dialogue.statut, justification }), `Statut enregistré : ${LIBELLE_STATUT_DOCUMENT[dialogue.statut].toLowerCase()}.`)}
        />
      )}
      {peutEcrire && dialogue?.genre === "retrait" && (
        <DialogueRetraitDocument
          document={dialogue.d} enLigne={enLigne} onFermer={() => setDialogue(null)}
          onValider={async (justification) => { await retirer.mutateAsync({ docId: dialogue.d.id, justification }); setOuvert(null); setRetour({ message: "Version retirée.", avertissements: [] }); }}
        />
      )}
    </section>
  );
}
