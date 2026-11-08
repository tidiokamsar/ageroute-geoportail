import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, FileText, UploadCloud, XCircle } from "lucide-react";
import { Button } from "../ui/Button";
import type { MetaImport } from "./types";
import {
  accepterDepuisMeta, controlerFichier, formaterTaille, texteAideFormats, tronquerNom,
} from "./receptionFormulaire.noyau";

/**
 * Zone de dépôt du fichier d'un lot.
 *
 * LE CHOIX PAR LE CLAVIER ET LE POINTEUR EST LE CHEMIN PRINCIPAL ; LE GLISSER-DÉPOSER EST UN BONUS
 *
 * Le contrôle réel est un `<input type="file">` natif, lié à un libellé visible et atteignable au
 * clavier (Entrée et Espace ouvrent le sélecteur du système). Il est masqué visuellement mais pas
 * retiré de l'ordre de tabulation ; la zone affiche l'anneau de focus quand il le reçoit. Le bouton
 * « Parcourir vos fichiers » fait la même chose, pour qui cherche un bouton. Sans glisser-déposer,
 * rien ne manque.
 *
 * CE QUE LA ZONE NE DIT PAS
 *
 * Elle affiche le nom, la taille et le format DÉCLARÉ, et dit que le fichier n'est pas encore
 * contrôlé. Elle ne prétend jamais qu'il est valide : refuser un fichier trop gros avant l'envoi est
 * une économie de transfert, pas un contrôle. L'extension n'est qu'un indice (avertissement non
 * bloquant) ; le serveur lit les octets et décide.
 *
 * Contrôlée par le parent : le fichier choisi vit dans le formulaire, qui le garde après un échec.
 */

export interface ZoneDepotProps {
  /** Formats et plafonds annoncés par le serveur (route /meta) : jamais écrits en dur ici. */
  meta: MetaImport;
  /** Code du format déclaré dans le formulaire (sert à l'indice d'extension et au résumé). */
  formatDeclare: string;
  fichier: File | null;
  onChoisir: (fichier: File) => void;
  onRetirer: () => void;
  desactive?: boolean;
  /** Identifiant de l'`<input>` (cible des liens du résumé d'erreurs) ; généré si absent. */
  id?: string;
  /** Refus renvoyé par le serveur pour ce champ (fichier vide, trop gros, ...). */
  erreurServeur?: string | null;
  /** Montre « Choisissez le fichier » quand rien n'est choisi (après une tentative d'envoi). */
  afficherErreurAbsence?: boolean;
}

/** Longueur au-delà de laquelle le nom est abrégé à l'écran (le nom complet reste lisible : infobulle et lecteurs d'écran). */
const LONGUEUR_NOM_AFFICHE = 36;

export function ZoneDepot({
  meta, formatDeclare, fichier, onChoisir, onRetirer, desactive = false, id, erreurServeur = null, afficherErreurAbsence = false,
}: ZoneDepotProps) {
  const base = useId();
  const idEntree = id ?? `${base}-fichier`;
  const idAide = `${idEntree}-aide`;
  const idErreur = `${idEntree}-erreur`;
  const idAvertissement = `${idEntree}-avertissement`;
  const idResume = `${idEntree}-resume`;
  const entree = useRef<HTMLInputElement>(null);
  const boutonParcourir = useRef<HTMLButtonElement>(null);
  const [survol, setSurvol] = useState(false);
  const [retire, setRetire] = useState(false);
  const [pluriel, setPluriel] = useState(false);

  // Quand le parent vide le fichier (après un envoi réussi, ou « Retirer »), on vide aussi l'input :
  // sinon rechoisir le MÊME fichier ne déclencherait aucun évènement `change`.
  useEffect(() => {
    if (!fichier && entree.current) entree.current.value = "";
  }, [fichier]);

  const controle = controlerFichier(fichier ? { nom: fichier.name, taille: fichier.size } : null, formatDeclare, meta);
  const erreurAffichee = erreurServeur ?? (fichier ? controle.erreur : afficherErreurAbsence ? controle.erreur : null);
  const avertissement = fichier ? controle.avertissement : null;
  const libelleFormat = meta.formats.find((f) => f.code === formatDeclare)?.libelle ?? (formatDeclare || "non choisi");
  const aideAccept = accepterDepuisMeta(meta);
  const nomCourt = fichier ? tronquerNom(fichier.name, LONGUEUR_NOM_AFFICHE) : "";

  function choisir(f: File | undefined, plusieurs = false) {
    if (!f || desactive) return;
    setRetire(false);
    setPluriel(plusieurs);
    onChoisir(f);
  }

  function pendantDepot(e: DragEvent<HTMLDivElement>) {
    if (desactive) return;
    // Sans preventDefault, le navigateur ouvre le fichier dans l'onglet au lieu de nous le remettre.
    e.preventDefault();
    if (e.type === "dragenter" || e.type === "dragover") setSurvol(true);
  }

  function quandSortDeLaZone(e: DragEvent<HTMLDivElement>) {
    // dragleave part aussi en passant sur un enfant : on ne retire le survol qu'en quittant la zone.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSurvol(false);
  }

  function quandDepose(e: DragEvent<HTMLDivElement>) {
    if (desactive) return;
    e.preventDefault();
    setSurvol(false);
    const fichiers = e.dataTransfer?.files;
    choisir(fichiers?.[0], (fichiers?.length ?? 0) > 1);
  }

  function retirer() {
    setRetire(true);
    setPluriel(false);
    onRetirer();
    // Le bouton « Retirer » disparaît : sans cette reprise, le focus tomberait sur le document.
    boutonParcourir.current?.focus();
  }

  const annonce = fichier
    ? `Fichier choisi : ${fichier.name}, ${formaterTaille(fichier.size)}.${pluriel ? " Un seul fichier est reçu à la fois : seul le premier a été retenu." : ""}`
    : retire ? "Fichier retiré. Aucun fichier choisi." : "";

  const decrit = [idAide, erreurAffichee ? idErreur : null, avertissement ? idAvertissement : null, fichier ? idResume : null]
    .filter(Boolean).join(" ");

  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={idEntree} className="block text-sm font-medium text-foreground">
        Fichier à recevoir <span aria-hidden="true" className="text-danger">*</span>
      </label>
      <p id={idAide} className="text-sm text-muted-foreground">{texteAideFormats(meta)}</p>

      <div
        onDragEnter={pendantDepot}
        onDragOver={pendantDepot}
        onDragLeave={quandSortDeLaZone}
        onDrop={quandDepose}
        className={[
          "flex min-w-0 flex-col items-start gap-3 rounded-md border-2 border-dashed p-4 sm:flex-row sm:items-center",
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
          survol ? "border-primary bg-muted" : erreurAffichee ? "border-danger bg-card" : "border-input bg-card",
          desactive ? "opacity-60" : "",
        ].join(" ")}
      >
        <input
          ref={entree}
          id={idEntree}
          type="file"
          className="sr-only"
          accept={aideAccept}
          disabled={desactive}
          // aria-required et non `required` : un fichier déposé par glisser-déposer n'est jamais dans input.files, et
          // `required` rendrait le champ « invalide » pour le navigateur alors qu'un fichier est bien choisi.
          aria-required="true"
          aria-invalid={erreurAffichee ? true : undefined}
          aria-describedby={decrit}
          onChange={(e) => choisir(e.target.files?.[0], (e.target.files?.length ?? 0) > 1)}
        />
        <UploadCloud aria-hidden="true" className="h-8 w-8 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-foreground">
            Déposez le fichier ici (facultatif), ou choisissez-le dans vos dossiers.
          </p>
          <Button
            ref={boutonParcourir}
            type="button"
            variant="outline"
            className="h-11"
            disabled={desactive}
            onClick={() => entree.current?.click()}
          >
            Parcourir vos fichiers
          </Button>
        </div>
      </div>

      {/* Région d'annonce toujours présente : une région ajoutée en même temps que son texte n'est pas lue. */}
      <p aria-live="polite" role="status" className="sr-only">{annonce}</p>

      {!fichier && !erreurAffichee && <p className="text-sm text-muted-foreground">Aucun fichier choisi.</p>}

      {erreurAffichee && (
        <p id={idErreur} className="flex items-start gap-2 text-sm text-danger">
          <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="font-medium">Erreur : </span>{erreurAffichee}</span>
        </p>
      )}

      {avertissement && (
        <p id={idAvertissement} className="flex items-start gap-2 text-sm text-avertissement">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="font-medium">Attention : </span>{avertissement}</span>
        </p>
      )}

      {fichier && (
        <section id={idResume} aria-label="Résumé du fichier choisi" className="space-y-3 rounded-md border border-input bg-muted p-3">
          <div className="flex items-start gap-2">
            <FileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Nom</dt>
              <dd className="min-w-0 break-words font-medium text-foreground" data-testid="nom-fichier">
                {nomCourt !== fichier.name ? (
                  <span title={fichier.name}>
                    <span aria-hidden="true">{nomCourt}</span>
                    <span className="sr-only">{fichier.name}</span>
                  </span>
                ) : fichier.name}
              </dd>
              <dt className="text-muted-foreground">Taille</dt>
              <dd className="text-foreground">{formaterTaille(fichier.size)}</dd>
              <dt className="text-muted-foreground">Format déclaré</dt>
              <dd className="min-w-0 break-words text-foreground">{libelleFormat}</dd>
            </dl>
          </div>
          {!controle.erreur && (
            <p className="text-sm text-foreground">
              Ce fichier n'est pas encore contrôlé. Le serveur calcule son empreinte à la réception.
            </p>
          )}
          <Button type="button" variant="outline" className="h-11" disabled={desactive} onClick={retirer}>
            Retirer le fichier
          </Button>
        </section>
      )}
    </div>
  );
}
