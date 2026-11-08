import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { messageErreur } from "../../lib/exploitation";
import { empriseRectangle, lireLot, NATURES, TYPES, type TypeProposition } from "../../lib/teledetection";

/**
 * Saisies du registre de télédétection (partie E) : enregistrer un produit, déposer un lot de
 * propositions. Ce qui suit est tenu par le serveur ET par la base ; l'écran le dit avant l'envoi :
 *   - un produit porte licence, provenance, incertitude et version de traitement — la licence se
 *     relève à la source, rien n'est prérempli ;
 *   - un produit optique porte sa couverture nuageuse ; un palier payant (1 à 3) la référence de
 *     l'autorisation de dépense ;
 *   - une proposition est dans l'emprise de son produit ; une référence est antérieure ;
 *   - sans tolérance donnée, rien n'est rattaché à un tronçon.
 */

export interface ProduitRegistre { id: string; code: string; nature: string; dateAcquisition: string; source: string }

const LIBELLE_NATURE: Record<string, string> = {
  OPTIQUE: "Optique", RADAR: "Radar", ALTIMETRIE: "Altimétrie", PRECIPITATIONS: "Précipitations",
  POPULATION: "Population", INONDATION: "Inondation", ROUTES_EXTRAITES: "Routes extraites",
};
export const LIBELLE_TYPE_PROPOSITION: Record<string, string> = {
  NOUVELLE_ROUTE: "Nouvelle route", COUPURE_PROBABLE: "Coupure probable", VEGETATION: "Végétation", INONDATION: "Inondation",
};

export function ProduitModal({ open, onClose, onFait }: { open: boolean; onClose: () => void; onFait: () => void }) {
  const [f, setF] = useState({
    code: "", palier: "0", source: "", nature: "", dateAcquisition: "", dateFin: "", resolutionM: "", couvertureNuagesPct: "",
    incertitude: "", provenance: "", licence: "", versionTraitement: "", autorisationDepenseRef: "", ouest: "", sud: "", est: "", nord: "",
  });
  const maj = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const palier = Number(f.palier);
  const emprise = f.ouest && f.sud && f.est && f.nord ? empriseRectangle(Number(f.ouest), Number(f.sud), Number(f.est), Number(f.nord)) : null;
  const manques: string[] = [];
  for (const [k, l] of [["code", "code"], ["source", "source"], ["nature", "nature"], ["dateAcquisition", "date d'acquisition"], ["resolutionM", "résolution"], ["incertitude", "incertitude"], ["provenance", "provenance"], ["licence", "licence"], ["versionTraitement", "version de traitement"]] as const) {
    if (!f[k].trim()) manques.push(l);
  }
  if (f.nature === "OPTIQUE" && !f.couvertureNuagesPct.trim()) manques.push("couverture nuageuse (optique)");
  if (palier > 0 && !f.autorisationDepenseRef.trim()) manques.push("référence de l'autorisation de dépense (palier payant)");
  if (!emprise) manques.push("emprise");
  const erreurEmprise = typeof emprise === "string" ? emprise : null;
  const periodeInversee = f.dateFin && f.dateAcquisition && f.dateFin < f.dateAcquisition;

  const enregistrer = useMutation({
    mutationFn: async () => (await api.post("/v2/teledetection/produits", {
      code: f.code.trim(), palier, source: f.source.trim(), nature: f.nature, dateAcquisition: f.dateAcquisition,
      dateFin: f.dateFin || null, resolutionM: Number(f.resolutionM),
      couvertureNuagesPct: f.couvertureNuagesPct.trim() ? Number(f.couvertureNuagesPct) : null,
      incertitude: f.incertitude.trim(), provenance: f.provenance.trim(), licence: f.licence.trim(), versionTraitement: f.versionTraitement.trim(),
      autorisationDepenseRef: f.autorisationDepenseRef.trim() || null, emprise,
    })).data,
    onSuccess: () => { toast.success("Produit enregistré au registre"); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Produit refusé")),
  });
  const pret = manques.length === 0 && !erreurEmprise && !periodeInversee;
  const champ = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <label className="block">{label}<input className="mt-1 w-full rounded border px-2 py-1.5" value={f[k]} onChange={maj(k)} {...props} /></label>
  );

  return (
    <Modal open={open} onClose={onClose} title="Enregistrer un produit au registre" sale={() => f.code !== "" || f.licence !== ""}>
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (pret) enregistrer.mutate(); }}>
        <div className="grid grid-cols-2 gap-2">
          {champ("code", "Code (unique)", { maxLength: 64 })}
          <label className="block">Palier
            <select className="mt-1 w-full rounded border px-2 py-1.5" value={f.palier} onChange={maj("palier")}>
              <option value="0">0 — gratuit</option><option value="1">1 — payant</option><option value="2">2 — payant</option><option value="3">3 — payant</option>
            </select>
          </label>
        </div>
        {champ("source", "Source (mission ou jeu, telle que la source la nomme)", { maxLength: 200 })}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">Nature
            <select className="mt-1 w-full rounded border px-2 py-1.5" value={f.nature} onChange={maj("nature")}>
              <option value="">—</option>
              {NATURES.map((n) => <option key={n} value={n}>{LIBELLE_NATURE[n]}</option>)}
            </select>
          </label>
          {champ("resolutionM", "Résolution (m)", { inputMode: "decimal" })}
          {champ("dateAcquisition", "Acquisition (début)", { type: "date" })}
          {champ("dateFin", "Fin de période (facultatif)", { type: "date" })}
          {champ("couvertureNuagesPct", f.nature === "OPTIQUE" ? "Couverture nuageuse (%)" : "Couverture nuageuse (%, optique seulement)", { inputMode: "decimal" })}
          {champ("versionTraitement", "Version de traitement", { maxLength: 200 })}
        </div>
        {periodeInversee && <p className="text-xs text-red-700">La fin de la période suit son début.</p>}
        {champ("incertitude", "Incertitude (géoréférencement, chatoiement…)", { maxLength: 1000 })}
        {champ("provenance", "Provenance (identifiant de scène ou adresse de la page d'origine)", { maxLength: 1000 })}
        {champ("licence", "Licence, relevée à la source", { maxLength: 500 })}
        {palier > 0 && champ("autorisationDepenseRef", "Référence de l'autorisation de dépense", { maxLength: 200 })}
        <fieldset className="grid grid-cols-4 gap-2">
          <legend className="col-span-4">Emprise (degrés, EPSG:4326)</legend>
          {champ("ouest", "Ouest", { inputMode: "decimal" })}{champ("sud", "Sud", { inputMode: "decimal" })}
          {champ("est", "Est", { inputMode: "decimal" })}{champ("nord", "Nord", { inputMode: "decimal" })}
          {erreurEmprise && <p className="col-span-4 text-xs text-red-700">{erreurEmprise}</p>}
        </fieldset>
        {manques.length > 0 && <p className="text-xs text-gray-600">À renseigner : {manques.join(", ")}.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={!pret || enregistrer.isPending}>Enregistrer le produit</Button>
        </div>
      </form>
    </Modal>
  );
}

export function DepotModal({ open, onClose, onFait, produits }: { open: boolean; onClose: () => void; onFait: () => void; produits: ProduitRegistre[] }) {
  const [produitId, setProduitId] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const [methode, setMethode] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [typeParDefaut, setTypeParDefaut] = useState<TypeProposition | "">("");
  const [texte, setTexte] = useState("");
  const produit = produits.find((p) => p.id === produitId);
  // Une référence est antérieure au produit : on ne propose que celles-là.
  const references = produit ? produits.filter((p) => p.id !== produit.id && p.dateAcquisition < produit.dateAcquisition) : [];
  const lecture = texte.trim() ? lireLot(texte, typeParDefaut) : null;
  const tol = tolerance.trim() ? Number(tolerance) : null;
  const tolInvalide = tol !== null && !(tol > 0 && tol <= 5000);
  const pret = produitId && methode.trim() && lecture && lecture.erreurs.length === 0 && lecture.propositions.length > 0 && !tolInvalide;

  const deposer = useMutation({
    mutationFn: async () => (await api.post<{ deposees: number; rattachees: number }>("/v2/teledetection/propositions", {
      produitId, produitReferenceId: referenceId || null, methode: methode.trim(), toleranceRattachementM: tol,
      propositions: lecture!.propositions,
    })).data,
    onSuccess: (r) => { toast.success(`${r.deposees} proposition(s) déposée(s), ${r.rattachees} rattachée(s) à un tronçon`); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Lot refusé")),
  });

  const lireFichier = async (fichier: File | undefined) => { if (fichier) setTexte(await fichier.text()); };

  return (
    <Modal open={open} onClose={onClose} title="Déposer un lot de propositions" sale={() => texte.trim() !== ""}>
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (pret) deposer.mutate(); }}>
        <label className="block">Produit analysé
          <select className="mt-1 w-full rounded border px-2 py-1.5" value={produitId} onChange={(e) => { setProduitId(e.target.value); setReferenceId(""); }}>
            <option value="">—</option>
            {produits.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.source} du {new Date(p.dateAcquisition).toLocaleDateString("fr-FR")}</option>)}
          </select>
        </label>
        <label className="block">Produit de référence (comparaison de deux dates, facultatif)
          <select className="mt-1 w-full rounded border px-2 py-1.5" value={referenceId} onChange={(e) => setReferenceId(e.target.value)} disabled={!produit}>
            <option value="">Aucun</option>
            {references.map((p) => <option key={p.id} value={p.id}>{p.code} — {new Date(p.dateAcquisition).toLocaleDateString("fr-FR")}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">Méthode (nom et version)<input className="mt-1 w-full rounded border px-2 py-1.5" maxLength={200} value={methode} onChange={(e) => setMethode(e.target.value)} /></label>
          <label className="block">Tolérance de rattachement (m, facultatif)<input className="mt-1 w-full rounded border px-2 py-1.5" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></label>
        </div>
        {tolInvalide && <p className="text-xs text-red-700">Tolérance : strictement positive, au plus 5 000 m.</p>}
        {tol === null && <p className="text-xs text-gray-600">Sans tolérance, aucune proposition n'est rattachée à un tronçon : aucune n'est supposée.</p>}
        <label className="block">Type par défaut (pour les entités sans propriété « type »)
          <select className="mt-1 w-full rounded border px-2 py-1.5" value={typeParDefaut} onChange={(e) => setTypeParDefaut(e.target.value as TypeProposition | "")}>
            <option value="">Aucun : chaque entité porte son type</option>
            {TYPES.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_PROPOSITION[t]}</option>)}
          </select>
        </label>
        <label className="block">Fichier GeoJSON
          <input type="file" accept=".json,.geojson,application/geo+json,application/json" className="mt-1 block w-full text-sm" onChange={(e) => lireFichier(e.target.files?.[0])} />
        </label>
        <label className="block">ou GeoJSON collé
          <textarea className="mt-1 w-full rounded border px-2 py-1.5 font-mono text-xs" rows={5} value={texte} onChange={(e) => setTexte(e.target.value)} />
        </label>
        {lecture && (lecture.erreurs.length > 0
          ? <ul className="list-disc pl-5 text-xs text-red-700">{lecture.erreurs.slice(0, 10).map((m) => <li key={m}>{m}</li>)}{lecture.erreurs.length > 10 && <li>… et {lecture.erreurs.length - 10} autre(s)</li>}</ul>
          : <p className="text-xs text-gray-700">{lecture.propositions.length} proposition(s) prête(s). L'emprise du produit est contrôlée par le serveur : une seule entité dehors fait refuser tout le lot.</p>)}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={!pret || deposer.isPending}>Déposer le lot</Button>
        </div>
      </form>
    </Modal>
  );
}
