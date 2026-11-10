import { useId, useState } from "react";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { BadgeStatutDocument } from "./commun";
import { LIBELLE_ROLE, LIBELLE_STATUT_JEU, type RoleJeu, type StatutJeu } from "../../../lib/projetsVoirie";
import {
  ACTION_VERS_STATUT, AIDE_DWG_LOCALE, AIDE_PDF_LOCALE, JUSTIFICATION_DOCUMENT_MIN, MENTION_FICHIER_NON_CONSERVE, classerErreurDocuments, controlerFichierPiece,
  type DocumentProjet, type ResultatEcritureDocument, type StatutDocument,
} from "../../../lib/projetsVoirieDocuments";
import type { CreationDocument, PieceSaisie } from "../../../lib/projetsVoirieDocumentsApi";
import type { ValeurReferentiel } from "../../../lib/projetsVoirieTerritoires";

/**
 * Dialogues d'ecriture des documents (ADMIN, GESTIONNAIRE) : creation, depot d'une piece, nouvelle version, changement de statut, retrait.
 * Chaque dialogue reste ouvert sur une erreur typee du serveur (400, 403, 404, 409, 413, 415, 422, 429, 503, 504) et se ferme sur un succes.
 * Le fichier d'une piece n'est JAMAIS lu par le navigateur : il part au serveur, qui en calcule l'empreinte et l'oublie.
 */

export interface JeuLiable { id: string; nomFichier: string; role: RoleJeu; version: number; statut: StatutJeu }
type ModePiece = "aucune" | "reference" | "fichier" | "jeu";

interface EtatPiece { mode: ModePiece; reference: string; fichier: File | null; jeuId: string }
const PIECE_VIDE = (mode: ModePiece): EtatPiece => ({ mode, reference: "", fichier: null, jeuId: "" });

function erreursPiece(p: EtatPiece): string[] {
  const e: string[] = [];
  if (p.reference.trim().length > 300) e.push("La référence compte au plus 300 caractères.");
  if (p.mode === "reference" && p.reference.trim() === "") e.push("Saisissez la référence de la pièce (numéro de courrier, cote de classement...).");
  if (p.mode === "fichier") {
    const v = controlerFichierPiece(p.fichier);
    if (!p.fichier) e.push("Choisissez le fichier PDF ou DWG.");
    else if (!v.ok && v.message) e.push(v.message);
  }
  if (p.mode === "jeu" && !p.jeuId) e.push("Choisissez le jeu de données du projet.");
  return e;
}

function versPiece(p: EtatPiece): PieceSaisie {
  if (p.mode === "aucune") return {};
  return { reference: p.reference.trim() || null, fichier: p.mode === "fichier" ? p.fichier : null, jeuId: p.mode === "jeu" ? p.jeuId : null };
}

function ChampsPiece({ etat, onChange, jeux, avecAucune, enCours }: { etat: EtatPiece; onChange: (p: EtatPiece) => void; jeux: readonly JeuLiable[]; avecAucune: boolean; enCours: boolean }) {
  const id = useId();
  const verdict = etat.mode === "fichier" ? controlerFichierPiece(etat.fichier) : null;
  const modes: { m: ModePiece; libelle: string }[] = [
    ...(avecAucune ? [{ m: "aucune" as const, libelle: "Aucune pour l'instant : la pièce est attendue" }] : []),
    { m: "reference", libelle: "Une référence seulement (courrier, cote de classement)" },
    { m: "fichier", libelle: "Un fichier PDF ou DWG" },
    { m: "jeu", libelle: "Un jeu de données déjà importé dans ce projet" },
  ];
  return (
    <>
      <fieldset className="space-y-1 rounded-md border border-gray-300 p-2">
        <legend className="px-1 text-sm font-medium text-gray-900">Pièce</legend>
        {modes.map(({ m, libelle }) => (
          <label key={m} className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="radio" name={`${id}-mode`} className="h-4 w-4" checked={etat.mode === m} disabled={enCours} onChange={() => onChange({ ...etat, mode: m })} />
            {libelle}
          </label>
        ))}
      </fieldset>
      {etat.mode !== "aucune" && (
        <div>
          <label htmlFor={`${id}-ref`} className={LIBELLE_CHAMP}>Référence{etat.mode === "reference" ? "" : " (facultative)"}</label>
          <Input id={`${id}-ref`} value={etat.reference} maxLength={300} disabled={enCours} onChange={(e) => onChange({ ...etat, reference: e.target.value })} className="mt-1 border-gray-300" autoComplete="off" />
        </div>
      )}
      {etat.mode === "fichier" && (
        <div className="space-y-1">
          <label htmlFor={`${id}-fichier`} className={LIBELLE_CHAMP}>Fichier PDF ou DWG (25 Mo au plus)</label>
          <input id={`${id}-fichier`} type="file" accept=".pdf,.dwg,application/pdf" disabled={enCours} aria-describedby={`${id}-fichier-aide`}
            onChange={(e) => onChange({ ...etat, fichier: e.target.files?.[0] ?? null })} className="mt-1 block w-full text-sm text-gray-900" />
          <p id={`${id}-fichier-aide`} className="text-xs text-gray-700">{MENTION_FICHIER_NON_CONSERVE}</p>
          {verdict?.format === "DWG" && <p data-testid="aide-dwg" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{AIDE_DWG_LOCALE}</p>}
          {verdict?.format === "PDF" && <p data-testid="aide-pdf" className="rounded border border-gray-300 bg-white p-2 text-xs text-gray-800">{AIDE_PDF_LOCALE}</p>}
          {verdict?.avertissement && <p className="text-xs text-amber-900">{verdict.avertissement}</p>}
        </div>
      )}
      {etat.mode === "jeu" && (
        <div>
          <label htmlFor={`${id}-jeu`} className={LIBELLE_CHAMP}>Jeu de données du projet</label>
          <Select id={`${id}-jeu`} value={etat.jeuId} disabled={enCours} onChange={(e) => onChange({ ...etat, jeuId: e.target.value })} className="mt-1 border-gray-300">
            <option value="">Choisir un jeu…</option>
            {jeux.map((j) => <option key={j.id} value={j.id}>{j.nomFichier}, v{j.version} ({LIBELLE_ROLE[j.role]}, {LIBELLE_STATUT_JEU[j.statut].toLowerCase()})</option>)}
          </Select>
          {jeux.length === 0 && <p className="mt-1 text-xs text-gray-700">Aucun jeu de données dans ce projet : importez d&apos;abord le plan avec « Ajouter des données ».</p>}
          <p className="mt-1 text-xs text-gray-700">Une pièce liée à un jeu en quarantaine ne devient exploitable qu&apos;une fois le jeu autorisé.</p>
        </div>
      )}
    </>
  );
}

export function DialogueCreationDocument({ types, concessionnaires, jeux, enLigne, onFermer, onValider }: {
  types: readonly ValeurReferentiel[]; concessionnaires: readonly { id: string; nom: string }[]; jeux: readonly JeuLiable[]; enLigne: boolean;
  onFermer: () => void; onValider: (d: CreationDocument, piece: PieceSaisie) => Promise<ResultatEcritureDocument>;
}) {
  const id = useId();
  const actifs = types.filter((t) => t.actif);
  const [typeCode, setTypeCode] = useState("");
  const [titre, setTitre] = useState("");
  const [description, setDescription] = useState("");
  const [dateDocument, setDateDocument] = useState("");
  const [concessionnaireId, setConcessionnaireId] = useState("");
  const [piece, setPiece] = useState<EtatPiece>(PIECE_VIDE("aucune"));
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurDocuments);
  const erreurs = [
    ...(typeCode ? [] : ["Choisissez le type de document."]),
    ...(titre.trim() ? [] : ["Saisissez le titre du document."]),
    ...(titre.trim().length > 200 ? ["Le titre compte au plus 200 caractères."] : []),
    ...(description.length > 2000 ? ["La description compte au plus 2 000 caractères."] : []),
    ...erreursPiece(piece),
  ];
  return (
    <CadreDialogue
      titre="Nouveau document du dossier"
      description={<><p>Sans pièce, le document est créé « attendu » : il signale une pièce demandée. Avec une pièce, il est créé « reçu ».</p><p>Titre, description, date et concessionnaire ne changent plus ensuite : une erreur se corrige par une nouvelle version ou un retrait.</p></>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Créer le document" libelleEnCours="Création…"
      onFermer={onFermer} enLigne={enLigne} large
      onValider={() => void envoyer(() => onValider({ typeCode, titre: titre.trim(), description: description.trim() || null, dateDocument: dateDocument || null, concessionnaireId: concessionnaireId || null }, versPiece(piece)))}
    >
      <div>
        <label htmlFor={`${id}-type`} className={LIBELLE_CHAMP}>Type de document</label>
        <Select id={`${id}-type`} value={typeCode} disabled={enCours} onChange={(e) => setTypeCode(e.target.value)} className="mt-1 border-gray-300">
          <option value="">Choisir un type…</option>
          {actifs.map((t) => <option key={t.code} value={t.code}>{t.libelle}</option>)}
        </Select>
        {actifs.length === 0 && <p className="mt-1 text-xs text-amber-900">Aucun type de document actif : un administrateur les crée dans Paramètres du module, onglet Référentiels.</p>}
      </div>
      <div>
        <label htmlFor={`${id}-titre`} className={LIBELLE_CHAMP}>Titre</label>
        <Input id={`${id}-titre`} value={titre} maxLength={200} disabled={enCours} onChange={(e) => setTitre(e.target.value)} className="mt-1 border-gray-300" autoComplete="off" />
      </div>
      <div>
        <label htmlFor={`${id}-desc`} className={LIBELLE_CHAMP}>Description (facultative)</label>
        <textarea id={`${id}-desc`} value={description} maxLength={2000} rows={2} disabled={enCours} onChange={(e) => setDescription(e.target.value)} className={CHAMP_TEXTE} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-date`} className={LIBELLE_CHAMP}>Date du document (facultative)</label>
          <Input id={`${id}-date`} type="date" value={dateDocument} disabled={enCours} onChange={(e) => setDateDocument(e.target.value)} className="mt-1 border-gray-300" />
        </div>
        <div>
          <label htmlFor={`${id}-conc`} className={LIBELLE_CHAMP}>Concessionnaire (facultatif)</label>
          <Select id={`${id}-conc`} value={concessionnaireId} disabled={enCours} onChange={(e) => setConcessionnaireId(e.target.value)} className="mt-1 border-gray-300">
            <option value="">Aucun</option>
            {concessionnaires.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
          </Select>
        </div>
      </div>
      <ChampsPiece etat={piece} onChange={setPiece} jeux={jeux} avecAucune enCours={enCours} />
    </CadreDialogue>
  );
}

/** Depot de la piece d'un document ATTENDU, ou piece de la version suivante d'un document recu. */
export function DialoguePiece({ document, geste, jeux, enLigne, onFermer, onValider }: {
  document: DocumentProjet; geste: "DEPOT" | "VERSION"; jeux: readonly JeuLiable[]; enLigne: boolean;
  onFermer: () => void; onValider: (piece: PieceSaisie) => Promise<ResultatEcritureDocument>;
}) {
  const [piece, setPiece] = useState<EtatPiece>(PIECE_VIDE(document.piece.format === "DWG" && geste === "VERSION" ? "jeu" : "reference"));
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurDocuments);
  const erreurs = erreursPiece(piece);
  const titre = geste === "DEPOT" ? "Déposer la pièce" : "Déposer une nouvelle version";
  return (
    <CadreDialogue
      titre={titre}
      description={<>
        <p><strong>{document.titre}</strong>, version {document.version}</p>
        {geste === "DEPOT"
          ? <p>Le document attendu devient « reçu » avec cette pièce.</p>
          : <p>La version {document.version + 1} sera créée « reçue ». La version actuelle passe « remplacée » si elle est en cours d&apos;examen ; une version validée le reste jusqu&apos;à la validation de la nouvelle.</p>}
        {document.piece.format === "DWG" && geste === "VERSION" && <p>La suite normale d&apos;un DWG : lier cette version au jeu importé depuis son export DXF.</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider={geste === "DEPOT" ? "Déposer la pièce" : "Déposer la version"} libelleEnCours="Envoi…"
      onFermer={onFermer} enLigne={enLigne} large onValider={() => void envoyer(() => onValider(versPiece(piece)))}
    >
      <ChampsPiece etat={piece} onChange={setPiece} jeux={jeux} avecAucune={false} enCours={enCours} />
    </CadreDialogue>
  );
}

export function DialogueStatutDocument({ document, statut, justificationExigee, enLigne, onFermer, onValider }: {
  document: DocumentProjet; statut: StatutDocument; justificationExigee: boolean; enLigne: boolean; onFermer: () => void; onValider: (justification: string | null) => Promise<unknown>;
}) {
  const id = useId();
  const [justification, setJustification] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurDocuments);
  const n = justification.trim().length;
  const erreurs = justificationExigee && n < JUSTIFICATION_DOCUMENT_MIN ? [`Ce geste exige une justification d'au moins ${JUSTIFICATION_DOCUMENT_MIN} caractères.`] : n > 2000 ? ["La justification compte au plus 2 000 caractères."] : [];
  return (
    <CadreDialogue
      titre={ACTION_VERS_STATUT[statut]}
      description={<>
        <p><strong>{document.titre}</strong>, version {document.version}</p>
        <p className="flex flex-wrap items-center gap-1">Statut actuel <BadgeStatutDocument statut={document.statut} /> ; nouveau statut <BadgeStatutDocument statut={statut} /></p>
        {statut === "VALIDE" && <p>La validation est faite par une autre personne que celle qui a déposé la pièce ; elle est consignée avec votre nom et votre justification.</p>}
        {statut === "REJETE" && <p>Un rejet est définitif pour cette version : la suite est une nouvelle version.</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider={ACTION_VERS_STATUT[statut]} libelleEnCours="Enregistrement…"
      onFermer={onFermer} enLigne={enLigne} onValider={() => void envoyer(() => onValider(justification.trim() || null))}
    >
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification{justificationExigee ? "" : " (facultative)"}</label>
        <textarea id={`${id}-j`} value={justification} maxLength={2000} rows={3} disabled={enCours} aria-describedby={`${id}-c`} onChange={(e) => setJustification(e.target.value)} className={CHAMP_TEXTE} />
        {justificationExigee ? <Compteur id={`${id}-c`} texte={justification} /> : <p id={`${id}-c`} className="text-xs text-gray-700">Conservée dans l&apos;historique du document.</p>}
      </div>
    </CadreDialogue>
  );
}

export function DialogueRetraitDocument({ document, enLigne, onFermer, onValider }: { document: DocumentProjet; enLigne: boolean; onFermer: () => void; onValider: (justification: string) => Promise<unknown> }) {
  const id = useId();
  const [justification, setJustification] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurDocuments);
  const erreurs = justification.trim().length < JUSTIFICATION_DOCUMENT_MIN ? [`Le retrait exige une justification d'au moins ${JUSTIFICATION_DOCUMENT_MIN} caractères.`] : [];
  return (
    <CadreDialogue
      titre="Retirer cette version du document"
      description={<>
        <p><strong>{document.titre}</strong>, version {document.version}</p>
        <p>Le retrait est logique : la version est figée et n&apos;est plus montrée, son historique reste conservé et consigné. La version précédente redevient la dernière.</p>
        {document.statut === "VALIDE" && <p>Cette pièce est validée : son retrait est réservé à un administrateur.</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Retirer la version" libelleEnCours="Retrait…"
      onFermer={onFermer} enLigne={enLigne} onValider={() => void envoyer(() => onValider(justification.trim()))}
    >
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification du retrait</label>
        <textarea id={`${id}-j`} value={justification} maxLength={2000} rows={3} disabled={enCours} aria-describedby={`${id}-c`} onChange={(e) => setJustification(e.target.value)} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-c`} texte={justification} />
      </div>
    </CadreDialogue>
  );
}
