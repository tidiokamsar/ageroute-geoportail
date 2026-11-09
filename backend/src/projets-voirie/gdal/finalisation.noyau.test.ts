import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ServiceOccupe } from "../../import/limiteur";
import { ErreurLecture } from "../lecture.types";
import { ErreurDelai } from "./delai.noyau";
import { classerErreurFinalisation } from "./finalisation.noyau";
import { ErreurSortie } from "./sortie.noyau";

/** M3 de la revue : seul un ecart de la SORTIE DU CONTENEUR donne ECHEC ; une panne du backend laisse le job EN_COURS (nouvelle tentative au tour suivant). */

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`EACCES: /tmp/geoconv/sortie/x/resultat.json`), { code });

describe("classerErreurFinalisation", () => {
  it("ErreurSortie : ECHEC avec son code (SORTIE_INVALIDE, SORTIE_INCOHERENTE, TROP_D_OBJETS, SORTIE_TROP_GROSSE...)", () => {
    expect(classerErreurFinalisation(new ErreurSortie("SORTIE_INCOHERENTE", "x"))).toEqual({ type: "ECHEC", code: "SORTIE_INCOHERENTE" });
    expect(classerErreurFinalisation(new ErreurSortie("TROP_D_OBJETS", "x"))).toEqual({ type: "ECHEC", code: "TROP_D_OBJETS" });
  });

  it("ErreurLecture (regle de CRS ou d'unites) : ECHEC avec le code s'il est connu des jobs, sinon SORTIE_INVALIDE", () => {
    expect(classerErreurFinalisation(new ErreurLecture("DXF_UNITES_CONFLIT", "x"))).toEqual({ type: "ECHEC", code: "DXF_UNITES_CONFLIT" });
    expect(classerErreurFinalisation(new ErreurLecture("CRS_REQUIS", "x"))).toEqual({ type: "ECHEC", code: "SORTIE_INVALIDE" });
  });

  it("fichier annonce absent (ENOENT, ENOTDIR) : le worker ecrit resultat.json avant statut.json, c'est une rupture du contrat : ECHEC SORTIE_INVALIDE", () => {
    expect(classerErreurFinalisation(errno("ENOENT"))).toEqual({ type: "ECHEC", code: "SORTIE_INVALIDE" });
    expect(classerErreurFinalisation(errno("ENOTDIR"))).toEqual({ type: "ECHEC", code: "SORTIE_INVALIDE" });
  });

  it("limiteur sature, base, descripteurs epuises, E/S, droits, delai du sondage : REESSAYER (jamais ECHEC), sans chemin dans la raison", () => {
    const cas: unknown[] = [
      new ServiceOccupe("occupe"),
      new Prisma.PrismaClientKnownRequestError("pool", { code: "P2024", clientVersion: "x" }),
      errno("EMFILE"), errno("EIO"), errno("EACCES"), errno("EBUSY"),
      new ErreurDelai("validation du resultat", 1000),
      new TypeError("inattendue"),
      "pas une erreur",
    ];
    for (const e of cas) {
      const v = classerErreurFinalisation(e);
      expect(v.type, String(e)).toBe("REESSAYER");
      if (v.type === "REESSAYER") expect(v.raison).not.toMatch(/tmp|geoconv|[\\/]/);
    }
    expect(classerErreurFinalisation(errno("EMFILE"))).toEqual({ type: "REESSAYER", raison: "Error (EMFILE)" });
  });
});
