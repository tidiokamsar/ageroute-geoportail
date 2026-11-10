import { forwardRef } from "react";
import { FilePlus2, History, Trash2, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { BadgeStatutDocument } from "./commun";
import { useFicheDocument } from "../../../lib/projetsVoirieDocumentsHooks";
import { formaterDate, formaterTaille } from "../../../lib/projetsVoirie";
import {
  LIBELLE_STATUT_DOCUMENT, classerErreurDocuments, estStatutDocument, gestePiece, peutRetirerDocument, transitionsPourCompte, textePiece,
  type DocumentProjet, type StatutDocument,
} from "../../../lib/projetsVoirieDocuments";

/**
 * Fiche d'un document : piece, statut, versions, historique (decideurs). Les gestes (statut, piece, retrait) ne sont montres qu'a un compte qui decide
 * (`peutEcrire`) ; parmi eux, seules les transitions rendues par le serveur, moins VALIDE pour le deposant (explique). Un lecteur ne voit que des
 * documents VALIDE et AUCUN bouton.
 */

const LIBELLE_ACTION: Record<string, string> = { CREATION: "Création", DEPOT: "Dépôt de la pièce", STATUT: "Changement de statut", REMPLACEMENT: "Remplacement", RETRAIT: "Retrait" };

export interface GestesFiche {
  onStatut: (d: DocumentProjet, statut: StatutDocument, justificationExigee: boolean) => void;
  onPiece: (d: DocumentProjet, geste: "DEPOT" | "VERSION") => void;
  onRetrait: (d: DocumentProjet) => void;
  onVoirVersion: (docId: string) => void;
}

export const FicheDocument = forwardRef<HTMLHeadingElement, {
  projetId: string; docId: string; peutEcrire: boolean; role: string | undefined; compteId: string | undefined; enLigne: boolean; gestes: GestesFiche; onFermer: () => void;
}>(function FicheDocument({ projetId, docId, peutEcrire, role, compteId, enLigne, gestes, onFermer }, ref) {
  const q = useFicheDocument(projetId, docId);
  const d = q.data?.document;
  return (
    <section aria-labelledby={`pv-fiche-doc-${docId}`} className="space-y-2 rounded-md border border-navy bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <h4 ref={ref} tabIndex={-1} id={`pv-fiche-doc-${docId}`} className="text-sm font-semibold text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-navy">
          {d ? d.titre : "Fiche du document"}
        </h4>
        <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" onClick={onFermer}><X aria-hidden="true" /> Fermer la fiche</Button>
      </div>
      {q.isPending && <EtatChargement libelle="Chargement du document…" />}
      {q.isError && <EtatErreur erreur={classerErreurDocuments(q.error)} sujet="Document" onReessayer={() => void q.refetch()} enCours={q.isFetching} />}
      {q.isSuccess && d && (() => {
        const fiche = q.data;
        const { proposees, ecartees } = peutEcrire ? transitionsPourCompte(d, compteId) : { proposees: [], ecartees: [] };
        const retrait = peutEcrire ? peutRetirerDocument(d, role) : { possible: false, raison: null };
        const geste = gestePiece(d);
        return (
          <>
            <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs text-gray-800">
              <dt className="font-medium text-gray-900">Statut</dt><dd><BadgeStatutDocument statut={d.statut} /></dd>
              <dt className="font-medium text-gray-900">Type</dt><dd>{d.type ? `${d.type.libelle}${d.type.actif ? "" : " (type désactivé)"}` : d.typeCode}</dd>
              <dt className="font-medium text-gray-900">Version</dt><dd>{d.version}</dd>
              <dt className="font-medium text-gray-900">Pièce</dt><dd className="break-words">{textePiece(d)}</dd>
              {d.piece.sha256 && <><dt className="font-medium text-gray-900">Empreinte SHA-256</dt><dd className="break-all font-mono">{d.piece.sha256}</dd></>}
              {d.piece.tailleOctets !== null && <><dt className="font-medium text-gray-900">Taille</dt><dd>{formaterTaille(d.piece.tailleOctets)}</dd></>}
              {d.concessionnaire && <><dt className="font-medium text-gray-900">Concessionnaire</dt><dd>{d.concessionnaire.nom}</dd></>}
              {d.dateDocument && <><dt className="font-medium text-gray-900">Date du document</dt><dd>{formaterDate(d.dateDocument)}</dd></>}
              <dt className="font-medium text-gray-900">Créé</dt><dd>{formaterDate(d.createdAt)}{d.creePar?.nomComplet ? `, par ${d.creePar.nomComplet}` : ""}</dd>
              {d.deposeLe && <><dt className="font-medium text-gray-900">Pièce déposée</dt><dd>{formaterDate(d.deposeLe)}{d.deposePar?.nomComplet ? `, par ${d.deposePar.nomComplet}` : ""}</dd></>}
              {d.valideLe && <><dt className="font-medium text-gray-900">Validé</dt><dd>{formaterDate(d.valideLe)}{d.validePar?.nomComplet ? `, par ${d.validePar.nomComplet}` : ""}</dd></>}
              {d.derniereAction?.justification && <><dt className="font-medium text-gray-900">Dernière justification</dt><dd className="break-words">{d.derniereAction.justification}</dd></>}
            </dl>
            {d.description && <p className="max-w-prose break-words text-xs text-gray-800">{d.description}</p>}
            {d.aide && <p data-testid="aide-format" className={`rounded border p-2 text-xs ${d.piece.format === "DWG" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-gray-50 text-gray-800"}`}>{d.piece.format === "DWG" ? "DWG non exploitable. " : d.piece.format === "PDF" ? "PDF, pièce de référence. " : ""}{d.aide}</p>}
            {d.exploitable && !d.exploitable.possible && d.exploitable.raison === "JEU_NON_AUTORISE" && <p className="text-xs text-amber-900">Le jeu lié n&apos;est pas autorisé : la pièce ne deviendra exploitable qu&apos;une fois le jeu autorisé.</p>}

            {peutEcrire && (
              <div className="space-y-1" data-testid="gestes-document">
                <div className="flex flex-wrap gap-2">
                  {proposees.map((t) => (
                    <Button key={t.statut} type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => gestes.onStatut(d, t.statut, t.justificationExigee)}>
                      {t.libelle}
                    </Button>
                  ))}
                  <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => gestes.onPiece(d, geste)}>
                    <FilePlus2 aria-hidden="true" /> {geste === "DEPOT" ? "Déposer la pièce" : "Nouvelle version"}
                  </Button>
                  {retrait.possible && (
                    <Button type="button" size="sm" variant="ghost" className="min-h-[44px] text-red-800 xl:min-h-8" disabled={!enLigne} onClick={() => gestes.onRetrait(d)}>
                      <Trash2 aria-hidden="true" /> Retirer
                    </Button>
                  )}
                </div>
                {ecartees.map((e) => <p key={e.statut} data-testid={`ecartee-${e.statut}`} className="text-xs text-gray-700">« {LIBELLE_STATUT_DOCUMENT[e.statut]} » n&apos;est pas proposé : {e.raison}</p>)}
                {retrait.raison && <p className="text-xs text-gray-700">{retrait.raison}</p>}
                {proposees.length === 0 && ecartees.length === 0 && (d.statut === "REJETE" || d.statut === "REMPLACE") && <p className="text-xs text-gray-700">Statut définitif : la suite est une nouvelle version.</p>}
              </div>
            )}

            <div className="space-y-1">
              <h5 className="text-xs font-semibold text-gray-900">Versions{peutEcrire ? "" : " validées"}</h5>
              <ul className="space-y-0.5 text-xs">
                {fiche.versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900">Version {v.version}</span>
                    {v.statut && <BadgeStatutDocument statut={v.statut} />}
                    <span className="text-gray-700">{formaterDate(v.createdAt)}</span>
                    {v.id === d.id ? <span className="text-gray-700">(affichée)</span> : (
                      <button type="button" className="min-h-[44px] font-medium text-navy underline xl:min-h-0" onClick={() => gestes.onVoirVersion(v.id)}>Voir<span className="sr-only"> la version {v.version}</span></button>
                    )}
                  </li>
                ))}
              </ul>
              {fiche.versionsTronquees && <p className="text-xs text-amber-900">Liste tronquée : seules les 200 versions les plus récentes sont montrées.</p>}
            </div>

            {fiche.historique && (
              <div className="space-y-1">
                <h5 className="flex items-center gap-1 text-xs font-semibold text-gray-900"><History aria-hidden="true" className="h-3 w-3" />Historique de la lignée (écrit par la base)</h5>
                {fiche.historique.length === 0 ? <p className="text-xs text-gray-700">Aucun geste consigné.</p> : (
                  <ol className="space-y-1 text-xs text-gray-800">
                    {fiche.historique.map((h, i) => (
                      <li key={`${h.id}-${i}`} className="rounded border border-gray-200 p-1.5">
                        <p><span className="font-medium text-gray-900">{LIBELLE_ACTION[h.action] ?? h.action}</span>{h.version !== null ? `, version ${h.version}` : ""} · {formaterDate(h.le)}{h.par?.nomComplet ? ` · ${h.par.nomComplet}` : ""}</p>
                        {(h.statutAvant || h.statutApres) && (
                          <p className="flex flex-wrap items-center gap-1">
                            {h.statutAvant && estStatutDocument(h.statutAvant) ? <BadgeStatutDocument statut={h.statutAvant} /> : h.statutAvant}
                            {h.statutAvant && h.statutApres ? <span aria-hidden="true">→</span> : null}
                            {h.statutAvant && h.statutApres ? <span className="sr-only">vers</span> : null}
                            {h.statutApres && estStatutDocument(h.statutApres) ? <BadgeStatutDocument statut={h.statutApres} /> : h.statutApres}
                          </p>
                        )}
                        {h.justification && <p className="break-words">Justification : {h.justification}</p>}
                        {h.details?.jeuMasque === true && <p className="text-gray-700">Jeu lié non lisible : ses détails sont masqués.</p>}
                      </li>
                    ))}
                  </ol>
                )}
                {fiche.historiqueTronque && <p className="text-xs text-amber-900">Historique tronqué : seuls les 500 gestes les plus récents sont montrés.</p>}
              </div>
            )}
          </>
        );
      })()}
    </section>
  );
});
