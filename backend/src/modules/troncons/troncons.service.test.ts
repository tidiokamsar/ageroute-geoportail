import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `listGeo` — ce qui protege la carte publique.
 *
 * Cette fonction est appelee SANS emprise par la carte publique, la carte embarquee
 * SharePoint et le geoportail : les trois peignent tout ce qu'elle rend.
 *
 * Mesure du 03/09/2026 : 2 040 troncons pesent 3,0 Mo bruts ; les 262 306 voies
 * restantes representent 132 Mo de GeoJSON. Sans l'exclusion testee ici, la
 * promotion nationale porterait le corps de reponse a environ 135 Mo et la carte
 * publique cesserait de fonctionner — d'abord sur les connexions mobiles de Guinee.
 *
 * Ce n'est pas un masquage : une voie promue est au registre, dans les exports, et
 * peut porter des chantiers. Elle est aussi deja affichee par la couche voirie,
 * cadree par emprise. La servir une seconde fois, sans emprise, couterait 132 Mo
 * pour rien.
 */

const etat = { texte: "", valeurs: [] as unknown[] };

/**
 * Le drapeau `tout` est cherche PAR SON TYPE, pas par sa position.
 *
 * Deux fois deja, une assertion sur `valeurs[n]` a casse parce qu'une interpolation
 * s'etait ajoutee plus haut dans le gabarit SQL — la tolerance de simplification
 * cette fois. L'indice n'a aucun sens metier ; le seul booleen de la requete, si.
 */
function drapeauTout(valeurs: unknown[]): boolean | undefined {
  return valeurs.find((v) => typeof v === "boolean") as boolean | undefined;
}

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...valeurs: unknown[]) => {
      /**
       * Reconstituer le SQL EFFECTIF, pas le gabarit.
       *
       * Un `Prisma.raw(...)` n'est pas un parametre : son texte part tel quel a la
       * base. Le mock le remplacait par « ? » comme n'importe quelle valeur, si bien
       * que deplacer le predicat de perimetre dans un helper partage a fait echouer
       * deux assertions qui, elles, etaient justes. Le gabarit avait change, la
       * requete envoyee non.
       *
       * On distingue donc les deux : un fragment SQL porte `strings`, une valeur non.
       */
      etat.texte = strings.reduce((acc, part, i) => {
        if (i === 0) return part;
        const v = valeurs[i - 1] as { strings?: readonly string[] } | undefined;
        return acc + (Array.isArray(v?.strings) ? v!.strings!.join("?") : "?") + part;
      }, "");
      etat.valeurs = valeurs.filter((v) => !Array.isArray((v as { strings?: unknown })?.strings));
      return [];
    }),
  },
}));

import { tronconsService } from "./troncons.service";

beforeEach(() => {
  etat.texte = "";
  etat.valeurs = [];
});

describe("listGeo borne ce qui part sur le reseau", () => {
  it("exclut la voirie promue par defaut", async () => {
    await tronconsService.listGeo();
    expect(etat.texte).toContain("voirie_locale:%");
    expect(drapeauTout(etat.valeurs)).toBe(false);
  });

  it("laisse passer un appelant qui demande explicitement tout", async () => {
    await tronconsService.listGeo({ tout: true });
    expect(drapeauTout(etat.valeurs)).toBe(true);
  });

  it("retient les troncons sans provenance — sinon la promotion effacerait les 1 690", async () => {
    // Les troncons anterieurs n'ont pas de sourceReference. Une clause qui se
    // contenterait de « NOT LIKE 'voirie_locale:%' » les exclurait tous : en SQL,
    // NULL NOT LIKE '...' vaut NULL, donc faux. Le IS NULL n'est pas decoratif.
    await tronconsService.listGeo();
    expect(etat.texte).toMatch(/"sourceReference"\s+IS NULL/);
  });

  it("garde le filtre des troncons supprimes et sans geometrie", async () => {
    await tronconsService.listGeo();
    expect(etat.texte).toMatch(/"deletedAt" IS NULL/);
    expect(etat.texte).toMatch(/t\.geom IS NOT NULL/);
  });

  it("expose toujours si l'etat est declare", async () => {
    // Un etat declare ne doit pas se lire comme une inspection : le drapeau part
    // avec chaque troncon, promu ou non.
    await tronconsService.listGeo();
    expect(etat.texte).toContain("etatDeclare");
    expect(etat.texte).toContain("IMPORTED_UNVERIFIED");
  });
});
