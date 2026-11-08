import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Megaphone } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/auth";
import { downloadViaApi } from "../lib/download";
import { Button } from "../components/ui/Button";
import { messageErreur } from "../lib/exploitation";

/**
 * Info Route et bulletin routier (paragraphe 7.17, EX-05 et EX-06), côté exploitant.
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Ce qui est écrit ici sort tel quel vers le public.** Le texte de la main courante, lui, reste
 * interne : l'exploitant rédige pour l'usager. L'écran le rappelle au-dessus du formulaire.
 *
 * **Un événement OUVERT ne se publie pas** : personne ne l'a encore pris en compte. Le serveur le
 * refuse, et l'écran n'offre la publication que pour un événement pris en compte ou en cours.
 *
 * **Pas de niveau P1–P4** : ils ne sont pas approuvés (D-02) et ne peuvent pas être annoncés.
 *
 * **Rien n'est jamais modifié ni effacé** : on publie une mise à jour ou un retrait, et le journal
 * de l'événement garde tout.
 *
 * **Le bulletin n'est envoyé nulle part** : il est généré, archivé, téléchargeable.
 */

interface Evenement { evenementId: string; typeCode: string; texte: string; statut: string; ouvertLe: string }
interface Courante { evenementId: string; publicationId: string; categorie: string; titre: string }
interface LigneJournal { id: string; action: string; categorie: string | null; titre: string | null; publieLe: string; publiePar: { nomComplet: string } }
interface Bulletin { id: string; numero: string; situationA: string; empreinteSha256: string; publicationsIds: string[] }

const CATEGORIES = [["COUPURE", "Coupure"], ["DEVIATION", "Déviation"], ["RESTRICTION", "Restriction"], ["TRAVAUX", "Travaux"]] as const;

function Formulaire({ ev, publie, onFait }: { ev: Evenement; publie: boolean; onFait: () => void }) {
  const [categorie, setCategorie] = useState("");
  const [titre, setTitre] = useState("");
  const [textePublic, setTexte] = useState("");
  const [localisation, setLocalisation] = useState("");
  const [deviation, setDeviation] = useState("");
  const [fin, setFin] = useState("");

  const envoyer = useMutation({
    mutationFn: async (action: "PUBLICATION" | "MISE_A_JOUR" | "RETRAIT") => {
      const corps = action === "RETRAIT" ? { action } : {
        action, categorie, titre: titre.trim(), textePublic: textePublic.trim(), localisationPublique: localisation.trim(),
        deviation: categorie === "DEVIATION" ? deviation.trim() : null, finValidite: fin ? new Date(fin).toISOString() : null,
      };
      return (await api.post(`/v2/exploitation/info-route/evenements/${ev.evenementId}/publications`, corps)).data;
    },
    onSuccess: (_d, action) => { toast.success(action === "RETRAIT" ? "Retiré de l'Info Route." : "Publié sur l'Info Route."); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Publication refusée.")),
  });

  const ouvert = ev.statut === "OUVERT";
  const clos = ev.statut === "CLOS";
  const complet = categorie && titre.trim() && textePublic.trim() && localisation.trim() && (categorie !== "DEVIATION" || deviation.trim());

  if (ouvert) return <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Événement OUVERT : prenez-le en compte dans la main courante avant de le publier.</p>;

  return (
    <div className="space-y-2">
      {!clos && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (complet) envoyer.mutate(publie ? "MISE_A_JOUR" : "PUBLICATION"); }}>
          <p className="rounded bg-sky-50 p-2 text-xs text-sky-900">Ce que vous écrivez ici est <strong>public</strong>. Aucun nom, aucun numéro, rien d'interne. Niveaux P1–P4 non approuvés : ils ne peuvent pas être annoncés.</p>
          <label className="block text-sm">Catégorie
            <select className="mt-1 w-full rounded border px-2 py-1" value={categorie} onChange={(e) => setCategorie(e.target.value)}>
              <option value="">—</option>
              {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="block text-sm">Titre (120 caractères au plus)
            <input className="mt-1 w-full rounded border px-2 py-1" maxLength={120} value={titre} onChange={(e) => setTitre(e.target.value)} />
          </label>
          <label className="block text-sm">Texte public
            <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={1000} rows={3} value={textePublic} onChange={(e) => setTexte(e.target.value)} />
          </label>
          <label className="block text-sm">Localisation publique (ex. « RN1, PK 45, Kindia »)
            <input className="mt-1 w-full rounded border px-2 py-1" maxLength={200} value={localisation} onChange={(e) => setLocalisation(e.target.value)} />
          </label>
          {categorie === "DEVIATION" && (
            <label className="block text-sm">Itinéraire de déviation
              <input className="mt-1 w-full rounded border px-2 py-1" maxLength={500} value={deviation} onChange={(e) => setDeviation(e.target.value)} />
            </label>
          )}
          <label className="block text-sm">Fin de validité (facultative)
            <input type="datetime-local" className="mt-1 w-full rounded border px-2 py-1" value={fin} onChange={(e) => setFin(e.target.value)} />
          </label>
          <Button type="submit" disabled={!complet || envoyer.isPending}>{publie ? "Publier la mise à jour" : "Publier"}</Button>
        </form>
      )}
      {clos && <p className="text-sm text-gray-600">Événement clos : il ne peut plus qu'être retiré de l'Info Route.</p>}
      {publie && <Button variant="danger" disabled={envoyer.isPending} onClick={() => envoyer.mutate("RETRAIT")}>Retirer de l'Info Route</Button>}
    </div>
  );
}

export function InfoRoutePage() {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const client = useQueryClient();
  const [selection, setSelection] = useState<string | null>(null);

  const evenements = useQuery({
    queryKey: ["main-courante", "evenements"],
    queryFn: async () => (await api.get<{ evenements: Evenement[] }>("/v2/exploitation/main-courante/evenements")).data.evenements,
  });
  const courante = useQuery({
    queryKey: ["info-route", "courante"],
    queryFn: async () => (await api.get<{ publications: Courante[] }>("/v2/exploitation/info-route/courante")).data.publications,
  });
  const journal = useQuery({
    queryKey: ["info-route", "journal", selection],
    enabled: selection !== null,
    queryFn: async () => (await api.get<{ publications: LigneJournal[] }>(`/v2/exploitation/info-route/evenements/${selection}/journal`)).data.publications,
  });
  const bulletins = useQuery({
    queryKey: ["info-route", "bulletins"],
    queryFn: async () => (await api.get<{ bulletins: Bulletin[] }>("/v2/exploitation/info-route/bulletins")).data.bulletins,
  });
  const generer = useMutation({
    mutationFn: async () => (await api.post<Bulletin>("/v2/exploitation/info-route/bulletins")).data,
    onSuccess: (b) => { toast.success(`Bulletin ${b.numero} archivé. Il n'est envoyé nulle part.`); client.invalidateQueries({ queryKey: ["info-route", "bulletins"] }); },
    onError: (e) => toast.error(messageErreur(e, "Génération refusée.")),
  });

  const publies = new Set(courante.data?.map((c) => c.evenementId) ?? []);
  const ev = evenements.data?.find((e) => e.evenementId === selection) ?? null;
  // Publie au sens de la sequence : la derniere ligne du journal n'est pas un retrait. Une
  // publication expiree reste « publiee » pour la sequence, meme si elle a quitte la vue publique.
  const derniere = journal.data?.[journal.data.length - 1]?.action ?? null;
  const enCours = derniere !== null && derniere !== "RETRAIT";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-gray-200 bg-white lg:col-span-1">
        <h2 className="border-b px-3 py-2 font-semibold">Événements de la main courante</h2>
        {evenements.isLoading ? <p className="p-3 text-gray-500">Chargement…</p>
          : !evenements.data?.length ? <p className="p-3 text-gray-500">Aucun événement.</p>
          : (
            <ul className="divide-y">
              {evenements.data.map((e) => (
                <li key={e.evenementId}>
                  <button type="button" onClick={() => setSelection(e.evenementId)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${selection === e.evenementId ? "bg-gray-100" : ""}`}>
                    <span className="font-medium">{e.typeCode}</span> — {e.statut}
                    {publies.has(e.evenementId) && <span className="ml-2 inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 text-xs text-sky-900"><Megaphone className="h-3 w-3" /> en ligne</span>}
                    <div className="truncate text-gray-600">{e.texte}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 lg:col-span-2">
        {!ev ? <p className="text-gray-500">Choisissez un événement pour voir son journal de publication.</p> : (
          <>
            <h2 className="font-semibold">{ev.typeCode} — {ev.statut}</h2>
            <p className="text-sm text-gray-600">Texte interne (non publié) : {ev.texte}</p>
            <div>
              <h3 className="text-sm font-medium">Journal de publication</h3>
              {!journal.data?.length ? <p className="text-sm text-gray-500">Jamais publié.</p> : (
                <ol className="text-sm">
                  {journal.data.map((l) => (
                    <li key={l.id}>{new Date(l.publieLe).toLocaleString("fr-FR")} — {l.action}{l.titre ? ` : ${l.titre}` : ""} ({l.publiePar.nomComplet})</li>
                  ))}
                </ol>
              )}
            </div>
            {peutEcrire && journal.isSuccess && (
              <Formulaire key={`${ev.evenementId}-${journal.data.length}`} ev={ev} publie={enCours}
                onFait={() => client.invalidateQueries({ queryKey: ["info-route"] })} />
            )}
          </>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-3 lg:col-span-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Bulletins routiers</h2>
          {peutEcrire && <Button disabled={generer.isPending} onClick={() => generer.mutate()}>Générer le bulletin de la situation présente</Button>}
        </div>
        <p className="text-xs text-gray-500">Un bulletin reprend les publications en cours, est archivé avec son empreinte, et n'est envoyé nulle part.</p>
        {!bulletins.data?.length ? <p className="text-sm text-gray-500">Aucun bulletin archivé.</p> : (
          <ul className="mt-2 divide-y text-sm">
            {bulletins.data.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span>{b.numero} — situation à {new Date(b.situationA).toLocaleString("fr-FR")} — {b.publicationsIds.length} publication(s)</span>
                <Button size="sm" variant="ghost"
                  onClick={() => downloadViaApi(`/v2/exploitation/info-route/bulletins/${b.id}/texte`, `${b.numero}.txt`).catch(() => toast.error("Téléchargement impossible."))}>
                  <Download className="h-4 w-4" /> Texte
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
