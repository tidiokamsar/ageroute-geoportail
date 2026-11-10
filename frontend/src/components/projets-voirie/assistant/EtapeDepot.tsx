import { useId, useState, type DragEvent } from "react";
import { FileText, UploadCloud } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { toast } from "../../../lib/toast";
import { useConcessionnaires, useCreerConcessionnaire } from "../../../lib/projetsVoirieHooks";
import { useReferentiel } from "../../../lib/projetsVoirieTerritoiresHooks";
import {
  AIDE_CLASSE, CLASSES_PRECISION, LIBELLE_CONFIDENTIALITE, LIBELLE_NATURE, LIBELLE_ROLE, MESSAGE_QUARANTAINE, NIVEAUX_CONFIDENTIALITE, ROLES_JEU, STYLE_RESEAU,
  classerErreur, confidentialiteParDefaut, controlerFichier, formaterTaille, natureParDefaut, naturesProposees,
  type ClassePrecision, type Confidentialite, type NatureObjet, type RoleJeu,
} from "../../../lib/projetsVoirie";
import {
  LIBELLE_FORMAT, LIBELLE_FORMAT_GDAL, MARCHE_GDAL_DESACTIVE, MESSAGE_CODE_GDAL_ASYNCHRONE, formatGdalDuFichier, messageGdalDesactive, type OptionsImportApi, type Saisie,
} from "../../../lib/projetsVoirieImport";
import { classerErreurTerritoires, familleDuType, libelleDeCode, optionsDeChoix } from "../../../lib/projetsVoirieTerritoires";
import { Champ, Encart } from "./commun";

const aujourdhui = () => new Date().toISOString().slice(0, 10);

/**
 * Etape 1 : depot du fichier et metadonnees du jeu. Formats acceptes, taille maximale et mode de conservation viennent de l'API (rien n'est code en
 * dur). Le fichier n'est ni lu ni apercu par le navigateur : il est transmis au serveur a l'etape suivante, sans copie locale.
 *
 * Lot UI-C : les types de reseau et les methodes d'acquisition se chargent depuis les referentiels (`GET /referentiels/:domaine`) ; une valeur
 * desactivee n'est plus proposee. Les formats GDAL (GeoPackage, Shapefile ZIP, DXF) sont annonces avec leur etat sur ce serveur ; desactives, ils
 * sont refuses localement avec la marche a suivre (deposer en GeoJSON, KML, GPX ou CSV).
 */
export function EtapeDepot({ saisie: s, erreurs, options, occupe, enLigne, onSaisie, onFichier }: {
  saisie: Saisie; erreurs: Record<string, string>; options: OptionsImportApi; occupe: boolean; enLigne: boolean;
  onSaisie: (patch: Partial<Saisie>) => void; onFichier: (f: File | null) => void;
}) {
  const id = useId();
  const concessionnaires = useConcessionnaires(true);
  const creerConc = useCreerConcessionnaire();
  const types = useReferentiel("TYPE_RESEAU");
  const methodes = useReferentiel("METHODE_ACQUISITION");
  const [glisse, setGlisse] = useState(false);
  const [nouveau, setNouveau] = useState(false);
  const [nc, setNc] = useState<{ nom: string; typeCode: string; contact: string }>({ nom: "", typeCode: "", contact: "" });
  const [erreurNc, setErreurNc] = useState<string | null>(null);

  const tailleMax = options.limites.tailleMaxOctets;
  const verdict = controlerFichier(s.fichier, options.formats, tailleMax);
  const gdalFichier = formatGdalDuFichier(s.fichier?.name, options.formatsGdal);
  const gdalIndisponibles = options.formatsGdal?.formats.filter((f) => f.etat === "INDISPONIBLE") ?? [];
  const gdalSupportes = options.formatsGdal?.formats.filter((f) => f.etat === "SUPPORTE") ?? [];
  const typesV = types.data?.valeurs;
  // Revue UI-C m1 : sans type precise, la famille envoyee est celle du CONCESSIONNAIRE, jamais celle d'un type choisi puis abandonne.
  const familleConcessionnaire = concessionnaires.data?.find((x) => x.id === s.concessionnaireId)?.typeReseau ?? "";
  const libelleFamille = (f: string | null | undefined) => (f && f in STYLE_RESEAU ? STYLE_RESEAU[f as keyof typeof STYLE_RESEAU].libelle : null);
  const tiers = s.role === "RESEAU_TIERS";
  const err = (k: string) => erreurs[k];
  const extensions = options.formats.flatMap((f) => f.extensions);

  function changerRole(role: RoleJeu) {
    // Valeurs par defaut selon le role (contrat v2) ; l'utilisateur peut les changer ensuite.
    onSaisie({ role, natureObjet: natureParDefaut(role), confidentialite: confidentialiteParDefaut(role) });
  }
  function choisirConcessionnaire(cid: string) {
    const c = concessionnaires.data?.find((x) => x.id === cid);
    // Le type est celui du concessionnaire choisi : son code s'il en porte un, sinon sa famille (repli du contrat T1). Revue UI-C m1 : rien n'est
    // garde du concessionnaire precedent (le jeu partirait avec le type d'un autre reseau) ; l'utilisateur peut ensuite le preciser.
    onSaisie({ concessionnaireId: cid, typeReseauCode: c?.typeReseauCode ?? "", typeReseau: c?.typeReseau ?? "" });
  }
  function surDepot(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setGlisse(false);
    const f = e.dataTransfer.files?.[0];
    if (!occupe && f) onFichier(f);
  }
  async function creerConcessionnaire() {
    const nom = nc.nom.trim();
    if (!nom) { setErreurNc("Saisissez le nom du concessionnaire."); return; }
    if (!nc.typeCode) { setErreurNc("Choisissez le type de réseau du concessionnaire."); return; }
    setErreurNc(null);
    try {
      const c = await creerConc.mutateAsync({ nom, typeReseauCode: nc.typeCode, ...(nc.contact.trim() ? { contact: nc.contact.trim() } : {}) });
      setNouveau(false);
      setNc({ nom: "", typeCode: "", contact: "" });
      onSaisie({ concessionnaireId: c.id, typeReseauCode: c.typeReseauCode ?? nc.typeCode, typeReseau: c.typeReseau ?? "" });
      toast.success(`Concessionnaire « ${c.nom} » créé.`);
    } catch (e) {
      setErreurNc(classerErreurTerritoires(e).message);
    }
  }

  return (
    <div className="space-y-4">
      <Encart ton="attention" titre="Confidentialité">
        <p>Les tracés de concessionnaires sont des données d&apos;infrastructure sensibles. Le fichier est transmis au serveur sans copie sur cet appareil ; l&apos;aperçu n&apos;affiche qu&apos;un échantillon borné de ce que vous venez d&apos;envoyer, jamais un jeu enregistré. {MESSAGE_QUARANTAINE}</p>
        <p className="mt-1" data-testid="conservation-original">
          {options.conservationOriginal === "STOCKE"
            ? "Conservation du fichier d'origine : le serveur en garde une copie, qu'aucune route ne relit ni n'exporte."
            : "Conservation du fichier d'origine : le serveur ne garde que l'empreinte (SHA-256) et la taille, pas le contenu."}
        </p>
      </Encart>

      <div>
        <span className="block text-sm font-medium text-gray-900">Fichier ({formaterTaille(tailleMax)} maximum)</span>
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
          <input id={`${id}-fichier`} type="file" accept={extensions.join(",")} className="sr-only" disabled={occupe} aria-describedby={`${id}-formats ${id}-fichier-etat`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFichier(f); e.target.value = ""; }} />
        </label>
        <div id={`${id}-formats`} className="mt-1 text-xs text-gray-700" data-testid="formats-acceptes">
          <p>Formats acceptés (le format réel est détecté par le contenu du fichier, pas par son extension) :</p>
          <ul className="list-disc pl-5">
            {options.formats.map((f) => <li key={f.format}>{LIBELLE_FORMAT[f.format] ?? f.format} : {f.extensions.join(", ")}</li>)}
          </ul>
          {gdalIndisponibles.length > 0 && (
            <div data-testid="formats-gdal-desactives" className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">
              <p><strong>Désactivés sur ce serveur :</strong> {gdalIndisponibles.map((f) => `${LIBELLE_FORMAT_GDAL[f.format] ?? f.format} (${f.extensions.join(", ")})`).join(" ; ")}.{options.formatsGdal?.raison ? ` Raison : ${options.formatsGdal.raison}.` : ""}</p>
              <p>{MARCHE_GDAL_DESACTIVE}</p>
            </div>
          )}
          {gdalSupportes.length > 0 && <p data-testid="formats-gdal-actifs">Lus en tâche de fond par la chaîne de conversion isolée de ce serveur : {gdalSupportes.map((f) => LIBELLE_FORMAT_GDAL[f.format] ?? f.format).join(", ")}. {MESSAGE_CODE_GDAL_ASYNCHRONE}</p>}
          {options.nonSupportes.length > 0 && <p>Non lus : {options.nonSupportes.map((n) => n.format).join(", ")}{options.nonSupportes.some((n) => n.format === "DWG") ? " (exportez un DWG en DXF)" : ""}. Le PDF reste une pièce jointe ; une page HTML n&apos;est jamais importée.</p>}
        </div>
        <p id={`${id}-fichier-etat`} className="mt-0.5 text-xs">
          {s.fichier && verdict.ok && verdict.format && <span className="text-green-800">Extension reconnue : {LIBELLE_FORMAT[verdict.format] ?? verdict.format} (indice : le serveur vérifie le contenu).</span>}
          {s.fichier && verdict.ok && !verdict.format && gdalFichier && <span role="alert" className="text-red-700">{gdalFichier.etat === "INDISPONIBLE" ? messageGdalDesactive(gdalFichier) : MESSAGE_CODE_GDAL_ASYNCHRONE}</span>}
          {s.fichier && verdict.ok && !verdict.format && !gdalFichier && verdict.avertissement && <span className="text-amber-900">{verdict.avertissement}</span>}
          {s.fichier && !verdict.ok && <span role="alert" className="text-red-700">{verdict.message}</span>}
          {!s.fichier && err("fichier") && <span role="alert" className="text-red-700">{err("fichier")}</span>}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Champ id={`${id}-role`} libelle="Rôle du fichier" aide="Le rôle fixe la confidentialité et la nature proposées, et le jeu qu'une nouvelle version remplace.">
          <Select id={`${id}-role`} value={s.role} onChange={(e) => changerRole(e.target.value as RoleJeu)} disabled={occupe} className="mt-1 border-gray-300">
            {ROLES_JEU.map((r) => <option key={r} value={r}>{LIBELLE_ROLE[r]}</option>)}
          </Select>
        </Champ>
        {tiers && (
          <Champ id={`${id}-type`} libelle="Type de réseau" aide={types.isError ? `Liste indisponible : ${classerErreurTerritoires(types.error).message}` : "Repris du concessionnaire s'il est connu. La famille technique en est déduite par le serveur."}>
            <Select id={`${id}-type`} value={s.typeReseauCode} onChange={(e) => onSaisie({ typeReseauCode: e.target.value, typeReseau: (e.target.value ? familleDuType(typesV?.find((t) => t.code === e.target.value)) : null) ?? familleConcessionnaire })} disabled={occupe || types.isPending} className="mt-1 border-gray-300">
              <option value="">{types.isPending ? "Chargement des types…" : s.typeReseau && libelleFamille(s.typeReseau) ? `Non précisé (famille du concessionnaire : ${libelleFamille(s.typeReseau)})` : "Non précisé"}</option>
              {optionsDeChoix(typesV, s.typeReseauCode || null).map((o) => <option key={o.code} value={o.code} disabled={o.desactivee}>{o.libelle}</option>)}
            </Select>
          </Champ>
        )}
        <Champ id={`${id}-nature`} libelle="Nature des objets" aide={naturesProposees(s.role).length === 1 ? "Imposée par le rôle du fichier." : "Un circuit logique n'est pas un câble posé : ne le dites pas physique si vous ne le savez pas."}>
          <Select id={`${id}-nature`} value={s.natureObjet} onChange={(e) => onSaisie({ natureObjet: e.target.value as NatureObjet })} disabled={occupe || naturesProposees(s.role).length === 1} className="mt-1 border-gray-300">
            {naturesProposees(s.role).map((n) => <option key={n} value={n}>{LIBELLE_NATURE[n]}</option>)}
          </Select>
        </Champ>
      </div>

      {tiers && (
        <div className="space-y-2 rounded-md border border-gray-200 p-3">
          <Champ id={`${id}-conc`} libelle="Concessionnaire propriétaire du réseau" erreur={err("concessionnaire")}>
            <Select id={`${id}-conc`} value={s.concessionnaireId} onChange={(e) => choisirConcessionnaire(e.target.value)} disabled={occupe || concessionnaires.isPending} aria-invalid={err("concessionnaire") ? true : undefined} aria-describedby={err("concessionnaire") ? `${id}-conc-erreur` : undefined} className="mt-1 border-gray-300">
              <option value="">{concessionnaires.isPending ? "Chargement de la liste…" : "Choisir un concessionnaire"}</option>
              {(concessionnaires.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nom}{c.typeReseauCode ? ` (${libelleDeCode(c.typeReseauCode, typesV)})` : c.typeReseau ? ` (${STYLE_RESEAU[c.typeReseau].libelle})` : ""}</option>)}
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
                  <Select id={`${id}-nc-type`} value={nc.typeCode} onChange={(e) => setNc({ ...nc, typeCode: e.target.value })} disabled={types.isPending} className="mt-1 border-gray-300">
                    <option value="">{types.isPending ? "Chargement des types…" : "Choisir un type"}</option>
                    {optionsDeChoix(typesV).map((o) => <option key={o.code} value={o.code}>{o.libelle}</option>)}
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
          <Select id={`${id}-classe`} value={s.classePrecision} onChange={(e) => onSaisie({ classePrecision: e.target.value as ClassePrecision })} disabled={occupe} className="mt-1 border-gray-300">
            {CLASSES_PRECISION.map((c) => <option key={c} value={c}>{AIDE_CLASSE[c]}</option>)}
          </Select>
        </Champ>
        <div className="grid gap-3 sm:grid-cols-2">
          <Champ id={`${id}-ph`} libelle="Précision horizontale, en mètres" erreur={err("precisionH")}>
            <Input id={`${id}-ph`} inputMode="decimal" value={s.precisionH} onChange={(e) => onSaisie({ precisionH: e.target.value })} disabled={occupe} autoComplete="off" aria-invalid={err("precisionH") ? true : undefined} className="mt-1 border-gray-300" />
          </Champ>
          <Champ id={`${id}-pv`} libelle="Précision verticale, en mètres" erreur={err("precisionV")}>
            <Input id={`${id}-pv`} inputMode="decimal" value={s.precisionV} onChange={(e) => onSaisie({ precisionV: e.target.value })} disabled={occupe} autoComplete="off" aria-invalid={err("precisionV") ? true : undefined} className="mt-1 border-gray-300" />
          </Champ>
          <Champ id={`${id}-methode`} libelle="Méthode de levé ou d'obtention">
            <Input id={`${id}-methode`} value={s.methode} onChange={(e) => onSaisie({ methode: e.target.value })} disabled={occupe} maxLength={200} autoComplete="off" className="mt-1 border-gray-300" />
          </Champ>
          <Champ id={`${id}-constat`} libelle="Date de constat" aide="Date à laquelle la position a été constatée." erreur={err("dateConstat")}>
            <Input id={`${id}-constat`} type="date" max={aujourdhui()} value={s.dateConstat} onChange={(e) => onSaisie({ dateConstat: e.target.value })} disabled={occupe} aria-invalid={err("dateConstat") ? true : undefined} className="mt-1 border-gray-300" />
          </Champ>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Champ id={`${id}-acq`} libelle="Méthode d'acquisition (facultatif)" aide={methodes.isError ? `Liste indisponible : ${classerErreurTerritoires(methodes.error).message}` : "Comment la donnée a été obtenue. Pour un réseau, deux méthodes différentes font deux sources comparables ; la même méthode, une nouvelle version."}>
          <Select id={`${id}-acq`} value={s.methodeAcquisition} onChange={(e) => onSaisie({ methodeAcquisition: e.target.value })} disabled={occupe || methodes.isPending} className="mt-1 border-gray-300">
            <option value="">{methodes.isPending ? "Chargement des méthodes…" : "Non renseignée"}</option>
            {optionsDeChoix(methodes.data?.valeurs, s.methodeAcquisition || null).map((o) => <option key={o.code} value={o.code} disabled={o.desactivee}>{o.libelle}</option>)}
          </Select>
        </Champ>
        <Champ id={`${id}-date`} libelle="Date des données (facultatif)" aide="Date de validité de la donnée (levé ou fourniture), distincte de la date du dépôt." erreur={err("dateDonnees")}>
          <Input id={`${id}-date`} type="date" max={aujourdhui()} value={s.dateDonnees} onChange={(e) => onSaisie({ dateDonnees: e.target.value })} disabled={occupe} aria-invalid={err("dateDonnees") ? true : undefined} className="mt-1 border-gray-300" />
        </Champ>
        <Champ id={`${id}-conf`} libelle="Confidentialité" aide="Proposée selon le rôle. Les tracés de concessionnaires ne figurent jamais dans l'API publique, et aucune géométrie n'est exportée.">
          <Select id={`${id}-conf`} value={s.confidentialite} onChange={(e) => onSaisie({ confidentialite: e.target.value as Confidentialite })} disabled={occupe} className="mt-1 border-gray-300">
            {NIVEAUX_CONFIDENTIALITE.map((c) => <option key={c} value={c}>{LIBELLE_CONFIDENTIALITE[c]}</option>)}
          </Select>
        </Champ>
      </div>

      <Champ id={`${id}-origine`} libelle="Origine du fichier (facultatif)" aide="Texte libre, pour mémoire (d'où vient ce fichier, qui l'a fourni). Ne bloque aucune étape.">
        <Input id={`${id}-origine`} value={s.origineFichier} onChange={(e) => onSaisie({ origineFichier: e.target.value })} disabled={occupe} maxLength={300} autoComplete="off" placeholder="reçu d'un concessionnaire le jj/mm/aaaa par …" className="mt-1 border-gray-300" />
      </Champ>
    </div>
  );
}
