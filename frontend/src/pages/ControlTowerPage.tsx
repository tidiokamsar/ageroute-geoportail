import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";
import { aTraiter, etatAffichage, texteIndicateur, textePortee, type IndicateurEvalue, type ModuleControlTower, type ReponseControlTower } from "../lib/tableauDeBord";

/**
 * Control Tower : la synthese d'exploitation, lue sur ce qui existe (MAINTENANCE_PROGRAMMING_DESIGN.md).
 *
 * CE QUE CET ECRAN DIT, ET QUI NE VA PAS DE SOI
 *
 * **Rien n'est invente.** Chaque chiffre est un indicateur du registre : une requete, un perimetre, une
 * requete de controle. Un module dont la table source est vide dit « aucune donnee » avec son perimetre ;
 * ce n'est pas un zero rassurant.
 *
 * **Un compte regional ne lit que ses regions.** Un indicateur qui ne se ventile pas par region lui est
 * refuse, et l'ecran le dit.
 *
 * **Aucune cible, aucun seuil.** Une valeur positive d'un indicateur de traitement est « a traiter » ;
 * zero ne l'est pas. L'ecran ne dit pas si c'est « grave ».
 *
 * **Ce qu'il ne couvre pas** est affiche en bas de page, pas laisse a deviner.
 */

function Indicateur({ i }: { i: IndicateurEvalue }) {
  const etat = etatAffichage(i);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-gray-800">{i.libelle}</span>
        <span className={etat === "valeur" ? "text-xl font-semibold text-navy" : "text-sm text-gray-600"}>{texteIndicateur(i)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
        <span>Périmètre : {i.perimetre.libelle}</span>
        {aTraiter(i) && <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-800">À traiter</span>}
      </div>
      {i.motif && etat !== "valeur" && <p className="text-xs text-gray-600">{i.motif}</p>}
    </li>
  );
}

function Module({ m }: { m: ModuleControlTower }) {
  const titre = `ct-${m.code}`;
  return (
    <section aria-labelledby={titre} className="rounded-lg border border-gray-200 bg-white" data-testid={`module-${m.code}`}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 id={titre} className="font-semibold text-gray-800">{m.libelle}</h2>
        <Link to={m.lien} className="text-sm font-medium text-navy underline">Ouvrir la page</Link>
      </div>
      {m.indisponible ? (
        <p className="p-4 text-sm text-gray-700">
          Ce module n'est pas communiqué à un compte régional : ses indicateurs ne sont pas ventilés par région.
        </p>
      ) : m.aucuneDonnee ? (
        <div className="p-4 text-sm text-gray-700">
          <p className="font-medium">Aucune donnée.</p>
          <p>
            {m.indicateurs[0]?.sourceLibelle
              ? `La source (${m.indicateurs[0].sourceLibelle}) ne contient rien dans ce périmètre : ce n'est pas un « zéro à signaler », rien n'a encore été enregistré.`
              : "La source ne contient rien dans ce périmètre."}
          </p>
          <p className="mt-1 text-xs text-gray-600">Périmètre : {m.indicateurs[0]?.perimetre.libelle}</p>
        </div>
      ) : (
        <ul className="divide-y px-4">
          {m.indicateurs.map((i) => <Indicateur key={i.code} i={i} />)}
        </ul>
      )}
    </section>
  );
}

export function ControlTowerPage() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ["tdb", "control-tower"],
    queryFn: async () => (await api.get<ReponseControlTower>("/v2/tableau-de-bord/control-tower")).data,
    refetchInterval: 60_000,
    retry: false,
  });

  if (isLoading) return <div role="status" className="p-6 text-gray-500">Chargement de la Control Tower…</div>;
  if (isError || !data) {
    return (
      <div role="alert" className="p-6 text-red-700">
        La Control Tower n'a pas pu être chargée. {messageErreur(error, "Réessayez dans un instant.")}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="control-tower">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Control Tower</h1>
        <p className="text-sm text-gray-700">{textePortee(data.portee)}</p>
        <p className="text-xs text-gray-600">Mis à jour à {new Date(dataUpdatedAt).toLocaleTimeString("fr-FR")}, puis toutes les minutes.</p>
      </div>

      {data.modules.length === 0 ? (
        <p className="text-gray-600">Aucun module à afficher.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.modules.map((m) => <Module key={m.code} m={m} />)}
        </div>
      )}

      <section aria-labelledby="ct-limites" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 id="ct-limites" className="font-semibold">Ce que cette synthèse ne couvre pas</h2>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {data.nonCouvert.map((t) => <li key={t}>{t}</li>)}
        </ul>
      </section>
    </div>
  );
}
