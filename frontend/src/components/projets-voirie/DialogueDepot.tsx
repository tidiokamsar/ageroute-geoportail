import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FileText, UploadCloud, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input, Select } from "../ui/Input";
import { toast } from "../../lib/toast";
import { useConcessionnaires, useCreerConcessionnaire, useEcrireDepot, useSimulerDepot } from "../../lib/projetsVoirieHooks";
import type { DonneesDepot, ReponseDepot } from "../../lib/projetsVoirieApi";
import {
  AIDE_CLASSE, CLASSES_PRECISION, LIBELLE_CONFIDENTIALITE, LIBELLE_NATURE, LIBELLE_NB_OBJETS, LIBELLE_ROLE, LIBELLE_TRACE_FUSIONNE, MESSAGE_QUARANTAINE,
  NIVEAUX_CONFIDENTIALITE, ROLES_JEU, STYLE_RESEAU, TYPES_RESEAU, classerErreur, confidentialiteParDefaut, controlerFichier, formaterLongueur, formaterNombre, formaterTaille,
  lireSaisieNombre, natureParDefaut, naturesProposees,
  type ClassePrecision, type Confidentialite, type ErreurPv, type NatureObjet, type RoleJeu, type TypeReseau,
} from "../../lib/projetsVoirie";

/**
 * Dialogue « Ajouter des donnees » : fichier KML ou GeoJSON, role, concessionnaire, type de reseau, nature des objets, date des donnees,
 * qualite (classe de precision, precisions, methode, date de constat), origine du fichier (texte libre FACULTATIF, jamais bloquant),
 * confidentialite a cinq niveaux.
 *
 * SIMULATION D'ABORD. « Simuler le depot » envoie le fichier avec `?simuler=true` : le serveur lit, valide, rend le resume, le bloc de
 * systeme de coordonnees, le delta (si c'est un remplacement) et les avertissements, et N'ECRIT RIEN. L'ecriture n'a lieu qu'apres « Confirmer
 * l'ecriture », sur un second envoi du meme fichier, et cree un jeu CONTROLE (quarantaine) : il n'alimente la carte et l'analyse qu'apres
 * autorisation. Modifier un parametre apres la simulation oblige a la refaire. La creation d'un concessionnaire est un geste a part, annonce
 * comme tel (enregistree tout de suite).
 *
 * Le navigateur ne lit pas le contenu du fichier : il le transmet, sans apercu ni execution. Il n'est conserve nulle part en dehors de l'etat
 * de ce dialogue.
 */

interface Saisie {
  fichier: File | null;
  role: RoleJeu;
  concessionnaireId: string;
  typeReseau: TypeReseau | "";
  natureObjet: NatureObjet;
  dateDonnees: string;
  origineFichier: string;
  classePrecision: ClassePrecision;
  precisionH: string;
  precisionV: string;
  methode: string;
  dateConstat: string;
  confidentialite: Confidentialite;
}

export const SAISIE_VIDE: Saisie = {
  fichier: null, role: "RESEAU_TIERS", concessionnaireId: "", typeReseau: "", natureObjet: natureParDefaut("RESEAU_TIERS"), dateDonnees: "", origineFichier: "",
  classePrecision: "INCONNUE", precisionH: "", precisionV: "", methode: "", dateConstat: "", confidentialite: confidentialiteParDefaut("RESEAU_TIERS"),
};

const aujourdhui = () => new Date().toISOString().slice(0, 10);

function lirePrecision(texte: string, cle: string, erreurs: Record<string, string>): number | undefined {
  if (texte.trim() === "") return undefined;
  const p = lireSaisieNombre(texte);
  if (p === null || p <= 0 || p > 10000) { erreurs[cle] = "Une précision est un nombre de mètres supérieur à zéro, jusqu'à 10 000."; return undefined; }
  return p;
}

export function construireDonnees(s: Saisie): { donnees: DonneesDepot | null; erreurs: Record<string, string> } {
  const erreurs: Record<string, string> = {};
  const verdict = controlerFichier(s.fichier);
  if (!s.fichier) erreurs.fichier = "Choisissez un fichier KML ou GeoJSON.";
  else if (!verdict.ok) erreurs.fichier = verdict.message ?? "Fichier non utilisable.";
  if (s.role === "RESEAU_TIERS" && !s.concessionnaireId) erreurs.concessionnaire = "Choisissez le concessionnaire propriétaire du réseau, ou créez-le.";
  if (s.dateDonnees && s.dateDonnees > aujourdhui()) erreurs.dateDonnees = "La date des données ne peut pas être dans le futur.";
  if (s.dateConstat && s.dateConstat > aujourdhui()) erreurs.dateConstat = "La date de constat ne peut pas être dans le futur.";
  const h = lirePrecision(s.precisionH, "precisionH", erreurs);
  const v = lirePrecision(s.precisionV, "precisionV", erreurs);
  if (Object.keys(erreurs).length > 0 || !s.fichier) return { donnees: null, erreurs };
  const tiers = s.role === "RESEAU_TIERS";
  return {
    erreurs,
    donnees: {
      fichier: s.fichier,
      role: s.role,
      ...(tiers ? { concessionnaireId: s.concessionnaireId } : {}),
      ...(tiers && s.typeReseau ? { typeReseau: s.typeReseau } : {}),
      natureObjet: s.natureObjet,
      ...(s.dateDonnees ? { dateDonnees: s.dateDonnees } : {}),
      ...(s.origineFichier.trim() ? { origineFichier: s.origineFichier.trim() } : {}),
      classePrecision: s.classePrecision,
      ...(h !== undefined ? { precisionHorizontaleM: h } : {}),
      ...(v !== undefined ? { precisionVerticaleM: v } : {}),
      ...(s.methode.trim() ? { methode: s.methode.trim() } : {}),
      ...(s.dateConstat ? { dateConstat: s.dateConstat } : {}),
      confidentialite: s.confidentialite,
    },
  };
}

function Champ({ id, libelle, aide, erreur, children }: { id: string; libelle: string; aide?: string; erreur?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">{libelle}</label>
      {children}
      {aide && !erreur && <p id={`${id}-aide`} className="mt-0.5 text-xs text-gray-600">{aide}</p>}
      {erreur && <p id={`${id}-erreur`} role="alert" className="mt-0.5 text-xs text-red-700">{erreur}</p>}
    </div>
  );
}

export function DialogueDepot({ projetId, onFermer, enLigne, onVoirJeu }: { projetId: string; onFermer: () => void; enLigne: boolean; onVoirJeu?: (jeuId: string) => void }) {
  const [s, setS] = useState<Saisie>(SAISIE_VIDE);
  const [etape, setEtape] = useState<"saisie" | "apercu" | "termine">("saisie");
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreurEnvoi, setErreurEnvoi] = useState<ErreurPv | null>(null);
  const [simulation, setSimulation] = useState<{ reponse: ReponseDepot; donnees: DonneesDepot } | null>(null);
  const [ecrit, setEcrit] = useState<ReponseDepot | null>(null);
  const [progression, setProgression] = useState<number | null>(null);
  const [glisse, setGlisse] = useState(false);
  const [nouveau, setNouveau] = useState(false);
  const [nc, setNc] = useState<{ nom: string; type: TypeReseau; contact: string }>({ nom: "", type: "TELECOM", contact: "" });
  const [erreurNc, setErreurNc] = useState<string | null>(null);
  const refTitreApercu = useRef<HTMLHeadingElement>(null);
  const refEntete = useRef<HTMLDivElement>(null);

  const id = useId();
  const concessionnaires = useConcessionnaires(true);
  const creerConc = useCreerConcessionnaire();
  const simuler = useSimulerDepot(projetId);
  const ecrire = useEcrireDepot(projetId);
  const occupe = simuler.isPending || ecrire.isPending;
  const verdict = controlerFichier(s.fichier);

  useEffect(() => {
    if (etape === "apercu") refTitreApercu.current?.focus();
    if (etape === "termine") refEntete.current?.focus();
  }, [etape]);

  const maj = (p: Partial<Saisie>) => { setS((x) => ({ ...x, ...p })); setErreurs({}); setErreurEnvoi(null); };
  function changerRole(role: RoleJeu) {
    // Les valeurs par defaut dependent du role (contrat v2) ; l'utilisateur peut les changer ensuite.
    maj({ role, natureObjet: natureParDefaut(role), confidentialite: confidentialiteParDefaut(role) });
  }

  function choisir(f: File | undefined | null) { if (f) maj({ fichier: f }); }
  function surDepot(e: DragEvent<HTMLLabelElement>) { e.preventDefault(); setGlisse(false); if (!occupe) choisir(e.dataTransfer.files?.[0]); }

  function choisirConcessionnaire(cid: string) {
    const c = concessionnaires.data?.find((x) => x.id === cid);
    maj({ concessionnaireId: cid, typeReseau: s.typeReseau || c?.typeReseau || "" });
  }

  async function creerConcessionnaire() {
    const nom = nc.nom.trim();
    if (!nom) { setErreurNc("Saisissez le nom du concessionnaire."); return; }
    setErreurNc(null);
    try {
      const c = await creerConc.mutateAsync({ nom, typeReseau: nc.type, ...(nc.contact.trim() ? { contact: nc.contact.trim() } : {}) });
      setNouveau(false);
      setNc({ nom: "", type: "TELECOM", contact: "" });
      maj({ concessionnaireId: c.id, typeReseau: c.typeReseau ?? nc.type });
      toast.success(`Concessionnaire « ${c.nom} » créé.`);
    } catch (e) {
      setErreurNc(classerErreur(e).message);
    }
  }

  async function lancerSimulation() {
    const { donnees, erreurs: errs } = construireDonnees(s);
    setErreurs(errs);
    setErreurEnvoi(null);
    if (!donnees) return;
    setProgression(0);
    try {
      const reponse = await simuler.mutateAsync({ donnees, onProgression: (e, t) => setProgression(t ? Math.round((e / t) * 100) : null) });
      setSimulation({ reponse, donnees });
      setEtape("apercu");
    } catch (e) {
      setErreurEnvoi(classerErreur(e));
    } finally {
      setProgression(null);
    }
  }

  async function confirmerEcriture() {
    if (!simulation) return;
    setErreurEnvoi(null);
    setProgression(0);
    try {
      const reponse = await ecrire.mutateAsync({ donnees: simulation.donnees, onProgression: (e, t) => setProgression(t ? Math.round((e / t) * 100) : null) });
      setEcrit(reponse);
      setEtape("termine");
      toast.success("Fichier reçu : il doit maintenant être autorisé.");
    } catch (e) {
      setErreurEnvoi(classerErreur(e));
    } finally {
      setProgression(null);
    }
  }

  const tiers = s.role === "RESEAU_TIERS";
  const err = (k: string) => erreurs[k];
  const reponse = etape === "termine" ? ecrit : simulation?.reponse;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !occupe) onFermer(); }}>
      <DialogContent masquerCroix className="max-h-[90vh] max-w-2xl overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
        <div ref={refEntete} tabIndex={-1} className="flex items-start justify-between gap-3 focus:outline-none">
          <div>
            <DialogTitle className="text-base font-semibold text-primary">Ajouter des données au projet</DialogTitle>
            <DialogDescription className="text-sm text-gray-700">
              {etape === "saisie" && "Le fichier est d'abord simulé : le serveur le lit et le valide sans rien enregistrer. L'écriture demande ensuite votre confirmation."}
              {etape === "apercu" && "Simulation terminée. Rien n'a été écrit pour l'instant."}
              {etape === "termine" && "Le fichier est reçu et contrôlé."}
            </DialogDescription>
          </div>
          <button type="button" onClick={() => { if (!occupe) onFermer(); }} aria-label="Fermer" className="shrink-0 rounded-md p-1.5 text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        {etape === "saisie" && (
          <form className="space-y-4" aria-label="Ajouter des données" onSubmit={(e) => { e.preventDefault(); void lancerSimulation(); }} noValidate>
            <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{MESSAGE_QUARANTAINE}</p>
            <div>
              <span className="block text-sm font-medium text-gray-900">Fichier (KML ou GeoJSON, 25 Mo maximum)</span>
              <label
                htmlFor={`${id}-fichier`}
                onDragOver={(e) => { e.preventDefault(); setGlisse(true); }} onDragLeave={() => setGlisse(false)} onDrop={surDepot}
                className={`mt-1 flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed p-4 text-center text-sm focus-within:ring-2 focus-within:ring-navy focus-within:ring-offset-2 ${glisse ? "border-navy bg-gray-100" : "border-gray-400 bg-white"}`}
              >
                <UploadCloud aria-hidden="true" className="h-6 w-6 text-gray-600" />
                {s.fichier ? (
                  <span className="flex items-center gap-1 break-all font-medium text-gray-900"><FileText aria-hidden="true" className="h-4 w-4 shrink-0" />{s.fichier.name} ({formaterTaille(s.fichier.size)})</span>
                ) : (
                  <span className="text-gray-800">Glissez le fichier ici, ou <span className="font-semibold underline">choisissez-le</span></span>
                )}
                <span className="text-xs text-gray-600">Le fichier n&apos;est pas encore contrôlé : le serveur le lit à l&apos;étape de simulation. KMZ, ZIP, Shapefile, DXF, PDF et HTML : format prévu au lot suivant.</span>
                <input id={`${id}-fichier`} type="file" accept=".kml,.geojson,.json,application/geo+json,application/vnd.google-earth.kml+xml" className="sr-only" disabled={occupe} aria-describedby={`${id}-fichier-etat`} onChange={(e) => { choisir(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <p id={`${id}-fichier-etat`} className="mt-0.5 text-xs">
                {s.fichier && verdict.ok && <span className="text-green-800">Format détecté d&apos;après l&apos;extension : {verdict.format}.</span>}
                {s.fichier && !verdict.ok && <span role="alert" className="text-red-700">{verdict.message}</span>}
                {!s.fichier && err("fichier") && <span role="alert" className="text-red-700">{err("fichier")}</span>}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Champ id={`${id}-role`} libelle="Rôle du fichier">
                <Select id={`${id}-role`} value={s.role} onChange={(e) => changerRole(e.target.value as RoleJeu)} disabled={occupe} className="mt-1 border-gray-300">
                  {ROLES_JEU.map((r) => <option key={r} value={r}>{LIBELLE_ROLE[r]}</option>)}
                </Select>
              </Champ>
              {tiers && (
                <Champ id={`${id}-type`} libelle="Type de réseau" aide="Repris du concessionnaire s'il est connu.">
                  <Select id={`${id}-type`} value={s.typeReseau} onChange={(e) => maj({ typeReseau: e.target.value as TypeReseau | "" })} disabled={occupe} className="mt-1 border-gray-300">
                    <option value="">Non précisé</option>
                    {TYPES_RESEAU.map((t) => <option key={t} value={t}>{STYLE_RESEAU[t].libelle}</option>)}
                  </Select>
                </Champ>
              )}
              <Champ id={`${id}-nature`} libelle="Nature des objets" aide={naturesProposees(s.role).length === 1 ? "Imposée par le rôle du fichier." : "Un circuit logique n'est pas un câble posé : ne le dites pas physique si vous ne le savez pas."}>
                <Select id={`${id}-nature`} value={s.natureObjet} onChange={(e) => maj({ natureObjet: e.target.value as NatureObjet })} disabled={occupe || naturesProposees(s.role).length === 1} className="mt-1 border-gray-300">
                  {naturesProposees(s.role).map((n) => <option key={n} value={n}>{LIBELLE_NATURE[n]}</option>)}
                </Select>
              </Champ>
            </div>

            {tiers && (
              <div className="space-y-2 rounded-md border border-gray-200 p-3">
                <Champ id={`${id}-conc`} libelle="Concessionnaire propriétaire du réseau" erreur={err("concessionnaire")}>
                  <Select id={`${id}-conc`} value={s.concessionnaireId} onChange={(e) => choisirConcessionnaire(e.target.value)} disabled={occupe || concessionnaires.isPending} aria-invalid={err("concessionnaire") ? true : undefined} aria-describedby={err("concessionnaire") ? `${id}-conc-erreur` : undefined} className="mt-1 border-gray-300">
                    <option value="">{concessionnaires.isPending ? "Chargement de la liste…" : "Choisir un concessionnaire"}</option>
                    {(concessionnaires.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nom}{c.typeReseau ? ` (${STYLE_RESEAU[c.typeReseau].libelle})` : ""}</option>)}
                  </Select>
                </Champ>
                {concessionnaires.isError && <p role="alert" className="text-xs text-red-700">La liste des concessionnaires n&apos;a pas pu être chargée. {classerErreur(concessionnaires.error).message}</p>}
                {!nouveau ? (
                  <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" disabled={occupe || !enLigne} onClick={() => setNouveau(true)}>Le concessionnaire n&apos;est pas dans la liste : le créer</Button>
                ) : (
                  <fieldset className="space-y-2 rounded border border-gray-300 bg-gray-50 p-2">
                    <legend className="px-1 text-xs font-semibold text-gray-800">Nouveau concessionnaire</legend>
                    <p className="text-xs text-gray-700">La création est enregistrée tout de suite, indépendamment du dépôt de fichier.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Champ id={`${id}-nc-nom`} libelle="Nom">
                        <Input id={`${id}-nc-nom`} value={nc.nom} onChange={(e) => setNc({ ...nc, nom: e.target.value })} maxLength={120} autoComplete="off" className="mt-1 border-gray-300" />
                      </Champ>
                      <Champ id={`${id}-nc-type`} libelle="Type de réseau">
                        <Select id={`${id}-nc-type`} value={nc.type} onChange={(e) => setNc({ ...nc, type: e.target.value as TypeReseau })} className="mt-1 border-gray-300">
                          {TYPES_RESEAU.map((t) => <option key={t} value={t}>{STYLE_RESEAU[t].libelle}</option>)}
                        </Select>
                      </Champ>
                    </div>
                    <Champ id={`${id}-nc-contact`} libelle="Contact (facultatif)">
                      <Input id={`${id}-nc-contact`} value={nc.contact} onChange={(e) => setNc({ ...nc, contact: e.target.value })} maxLength={200} autoComplete="off" className="mt-1 border-gray-300" />
                    </Champ>
                    {erreurNc && <p role="alert" className="text-xs text-red-700">{erreurNc}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" className="min-h-[44px] sm:min-h-8" disabled={creerConc.isPending || !enLigne} onClick={() => void creerConcessionnaire()}>{creerConc.isPending ? "Création…" : "Créer le concessionnaire"}</Button>
                      <Button type="button" size="sm" variant="ghost" className="min-h-[44px] sm:min-h-8" onClick={() => { setNouveau(false); setErreurNc(null); }}>Annuler la création</Button>
                    </div>
                  </fieldset>
                )}
              </div>
            )}

            <fieldset className="space-y-3 rounded-md border border-gray-200 p-3">
              <legend className="px-1 text-sm font-semibold text-navy">Qualité des données (facultatif)</legend>
              <Champ id={`${id}-classe`} libelle="Classe de précision" aide="Sans information, laissez « Inconnue » : l'analyse parlera alors de proximité à vérifier.">
                <Select id={`${id}-classe`} value={s.classePrecision} onChange={(e) => maj({ classePrecision: e.target.value as ClassePrecision })} disabled={occupe} className="mt-1 border-gray-300">
                  {CLASSES_PRECISION.map((c) => <option key={c} value={c}>{AIDE_CLASSE[c]}</option>)}
                </Select>
              </Champ>
              <div className="grid gap-3 sm:grid-cols-2">
                <Champ id={`${id}-ph`} libelle="Précision horizontale, en mètres" erreur={err("precisionH")}>
                  <Input id={`${id}-ph`} inputMode="decimal" value={s.precisionH} onChange={(e) => maj({ precisionH: e.target.value })} disabled={occupe} autoComplete="off" aria-invalid={err("precisionH") ? true : undefined} className="mt-1 border-gray-300" />
                </Champ>
                <Champ id={`${id}-pv`} libelle="Précision verticale, en mètres" erreur={err("precisionV")}>
                  <Input id={`${id}-pv`} inputMode="decimal" value={s.precisionV} onChange={(e) => maj({ precisionV: e.target.value })} disabled={occupe} autoComplete="off" aria-invalid={err("precisionV") ? true : undefined} className="mt-1 border-gray-300" />
                </Champ>
                <Champ id={`${id}-methode`} libelle="Méthode de levé ou d'obtention">
                  <Input id={`${id}-methode`} value={s.methode} onChange={(e) => maj({ methode: e.target.value })} disabled={occupe} maxLength={200} autoComplete="off" className="mt-1 border-gray-300" />
                </Champ>
                <Champ id={`${id}-constat`} libelle="Date de constat" aide="Date à laquelle la position a été constatée." erreur={err("dateConstat")}>
                  <Input id={`${id}-constat`} type="date" max={aujourdhui()} value={s.dateConstat} onChange={(e) => maj({ dateConstat: e.target.value })} disabled={occupe} aria-invalid={err("dateConstat") ? true : undefined} className="mt-1 border-gray-300" />
                </Champ>
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <Champ id={`${id}-date`} libelle="Date des données (facultatif)" aide="Date du levé ou de la fourniture du fichier." erreur={err("dateDonnees")}>
                <Input id={`${id}-date`} type="date" max={aujourdhui()} value={s.dateDonnees} onChange={(e) => maj({ dateDonnees: e.target.value })} disabled={occupe} aria-invalid={err("dateDonnees") ? true : undefined} className="mt-1 border-gray-300" />
              </Champ>
              <Champ id={`${id}-conf`} libelle="Confidentialité" aide="Proposée selon le rôle. Les tracés de concessionnaires ne figurent jamais dans l'API publique, et aucune géométrie n'est exportée.">
                <Select id={`${id}-conf`} value={s.confidentialite} onChange={(e) => maj({ confidentialite: e.target.value as Confidentialite })} disabled={occupe} className="mt-1 border-gray-300">
                  {NIVEAUX_CONFIDENTIALITE.map((c) => <option key={c} value={c}>{LIBELLE_CONFIDENTIALITE[c]}</option>)}
                </Select>
              </Champ>
            </div>

            <Champ id={`${id}-origine`} libelle="Origine du fichier (facultatif)" aide="Texte libre, pour mémoire. Ne bloque ni la simulation ni l'écriture.">
              <Input id={`${id}-origine`} value={s.origineFichier} onChange={(e) => maj({ origineFichier: e.target.value })} disabled={occupe} maxLength={300} autoComplete="off" placeholder="reçu d'Orange le 24/10/2026 par …" className="mt-1 border-gray-300" />
            </Champ>

            {erreurEnvoi && <ZoneErreur erreur={erreurEnvoi} onVoirJeu={onVoirJeu} />}
            {Object.keys(erreurs).length > 0 && <p role="alert" className="text-sm text-red-700">Corrigez les champs signalés avant de lancer la simulation.</p>}
            {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : le dépôt a besoin du réseau.</p>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {progression !== null && <span role="status" className="mr-auto text-sm text-gray-700">Envoi du fichier à simuler… {progression} %</span>}
              <Button type="button" variant="ghost" disabled={occupe} onClick={onFermer}>Annuler</Button>
              <Button type="submit" disabled={occupe || !enLigne}>{simuler.isPending ? "Simulation…" : "Simuler le dépôt"}</Button>
            </div>
          </form>
        )}

        {etape === "apercu" && simulation && reponse && (
          <div className="space-y-3">
            <h3 ref={refTitreApercu} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">Résultat de la simulation</h3>
            <p role="note" className="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-900">
              Simulation seulement : <strong>rien n&apos;a été écrit</strong>. Vérifiez le résumé et les avertissements, puis confirmez l&apos;écriture. {MESSAGE_QUARANTAINE}
            </p>
            <ResumeDepot reponse={reponse} fichier={simulation.donnees.fichier.name} />
            <Avertissements liste={reponse.avertissements} />
            {erreurEnvoi && <ZoneErreur erreur={erreurEnvoi} onVoirJeu={onVoirJeu} />}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {progression !== null && <span role="status" className="mr-auto text-sm text-gray-700">Envoi du fichier… {progression} %</span>}
              <Button type="button" variant="ghost" disabled={ecrire.isPending} onClick={() => { setEtape("saisie"); setSimulation(null); setErreurEnvoi(null); }}>Modifier les paramètres</Button>
              <Button type="button" disabled={ecrire.isPending || !enLigne} onClick={() => void confirmerEcriture()}>{ecrire.isPending ? "Écriture…" : "Confirmer l'écriture"}</Button>
            </div>
          </div>
        )}

        {etape === "termine" && ecrit && (
          <div className="space-y-3">
            <p role="status" className="flex items-start gap-2 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-900">
              <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span><strong>Fichier reçu et contrôlé.</strong> {ecrit.jeu ? `Version ${ecrit.jeu.version} du jeu, ` : ""}{formaterNombre(ecrit.resume.nbObjets, 0)} circuit(s) ou objet(s).{" "}
                Il est <strong>à autoriser</strong> : {MESSAGE_QUARANTAINE} Autorisez-le ou rejetez-le depuis l&apos;onglet Couches. L&apos;opération est consignée dans le journal d&apos;audit.</span>
            </p>
            <ResumeDepot reponse={ecrit} fichier={ecrit.jeu?.nomFichier ?? "fichier"} />
            <Avertissements liste={ecrit.avertissements} />
            <div className="flex justify-end"><Button type="button" onClick={onFermer}>Fermer</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const CODES_AVEC_LIEN = ["JEU_DEJA_CHARGE", "DEPOT_EN_ATTENTE"];

function ZoneErreur({ erreur, onVoirJeu }: { erreur: ErreurPv; onVoirJeu?: (jeuId: string) => void }) {
  const dejaCharge = erreur.code === "JEU_DEJA_CHARGE";
  const lien = erreur.code !== null && CODES_AVEC_LIEN.includes(erreur.code) && erreur.jeuId && onVoirJeu;
  return (
    <div role="alert" data-code={erreur.code ?? undefined} className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p>{dejaCharge ? <strong>Ce fichier est déjà chargé. </strong> : null}{erreur.message}{erreur.code && <span className="block text-xs text-red-800">Code : {erreur.code}</span>}</p>
        {lien && (
          <button type="button" onClick={() => onVoirJeu(erreur.jeuId as string)} className="mt-1 min-h-[44px] text-left font-medium underline sm:min-h-0">Voir le jeu existant</button>
        )}
      </div>
    </div>
  );
}

function ResumeDepot({ reponse, fichier }: { reponse: ReponseDepot; fichier: string }) {
  const { resume, crs, delta, remplace } = reponse;
  const version = reponse.jeu?.version ?? null;
  const types = Object.entries(resume.parTypeGeom).filter(([, n]) => (n ?? 0) > 0);
  const ecart = resume.longueurTotaleM !== null && resume.longueurTraceFusionneM !== null ? resume.longueurTotaleM - resume.longueurTraceFusionneM : 0;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-white p-3 text-sm">
        <dt className="text-gray-600">Fichier</dt><dd className="break-all">{fichier}</dd>
        {version !== null && (<><dt className="text-gray-600">Version prévue</dt><dd>{version}</dd></>)}
        {remplace && (<><dt className="text-gray-600">Remplacera</dt><dd>la version {remplace.version} autorisée, une fois cette version autorisée à son tour</dd></>)}
        <dt className="text-gray-600">{LIBELLE_NB_OBJETS}</dt>
        <dd>{formaterNombre(resume.nbObjets, 0)}{types.length > 0 && <> ({types.map(([k, n]) => `${formaterNombre(n ?? 0, 0)} ${k === "LIGNE" ? "ligne(s)" : k === "POINT" ? "point(s)" : "polygone(s)"}`).join(", ")})</>}</dd>
        <dt className="text-gray-600">Longueur totale</dt><dd>{formaterLongueur(resume.longueurTotaleM)} (somme des longueurs des objets)</dd>
        <dt className="text-gray-600">{LIBELLE_TRACE_FUSIONNE}</dt>
        <dd>{formaterLongueur(resume.longueurTraceFusionneM)}{ecart > 0.5 && <> : {formaterLongueur(ecart)} de circuits superposés ne sont comptés qu&apos;une fois</>}</dd>
        {resume.bbox && (<><dt className="text-gray-600">Emprise</dt><dd className="break-words">longitude {resume.bbox[0].toFixed(4)} à {resume.bbox[2].toFixed(4)}, latitude {resume.bbox[1].toFixed(4)} à {resume.bbox[3].toFixed(4)}</dd></>)}
        <dt className="text-gray-600">Attributs détectés</dt>
        <dd className="break-words">{resume.attributsDetectes.length > 0 ? resume.attributsDetectes.slice(0, 30).join(", ") + (resume.attributsDetectes.length > 30 ? `… (+${resume.attributsDetectes.length - 30})` : "") : "Aucun"}</dd>
      </dl>
      {crs && (
        <dl data-testid="bloc-crs" aria-label="Système de coordonnées" className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <dt className="text-gray-600">Système source</dt><dd>{crs.source ?? "Non indiqué"}</dd>
          <dt className="text-gray-600">Système cible</dt><dd>{crs.cible ?? "Non indiqué"}</dd>
          <dt className="text-gray-600">Méthode</dt><dd>{crs.methode ?? "Non indiquée"}</dd>
          <dt className="text-gray-600">Justification</dt><dd className="break-words">{crs.justification ?? "Non indiquée"}</dd>
        </dl>
      )}
      {delta && (
        <div data-testid="delta" className="rounded border border-gray-200 bg-white p-3 text-sm">
          <p className="font-semibold text-navy">Comparaison avec la version précédente</p>
          <p>{formaterNombre(delta.ajoutes, 0)} ajouté(s), {formaterNombre(delta.retires, 0)} retiré(s), {formaterNombre(delta.identiques, 0)} identique(s).</p>
          <p className="text-xs text-gray-600">Information seulement : les suppressions ne sont jamais appliquées automatiquement.</p>
        </div>
      )}
    </div>
  );
}

function Avertissements({ liste }: { liste: ReponseDepot["avertissements"] }) {
  if (liste.length === 0) return <p className="text-sm text-gray-700">Aucun avertissement du serveur.</p>;
  return (
    <div>
      <h4 className="text-sm font-semibold text-amber-900">Avertissements ({liste.length})</h4>
      <ul className="mt-1 space-y-1">
        {liste.map((a, i) => (
          <li key={`${a.code}-${i}`} className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{a.message}{a.nb !== null && <> ({formaterNombre(a.nb, 0)} concerné(s))</>}<span className="block text-xs text-amber-900">Code : {a.code}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
