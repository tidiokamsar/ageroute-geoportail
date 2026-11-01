import type { Request, RequestHandler } from "express";
import { PHOTOS_UPLOAD_DIR } from "./upload-photo.middleware";
import { stat } from "node:fs/promises";
import {
  refusQuota, statutHttp, octetsDuRepertoire, ajouterAuCache, plafonds, EXPLICATIONS,
} from "../lib/quota-photos";

/**
 * Refuse une photo AVANT que multer ne l'ecrive sur le disque.
 *
 * POURQUOI AVANT, ET PAS DANS LE GESTIONNAIRE
 *
 * `multer` ecrit le fichier pendant son propre traitement : quand le gestionnaire de
 * route s'execute, les huit mebioctets sont deja sur le disque. Les routes les
 * suppriment correctement sur chaque chemin de refus, mais refuser APRES avoir ecrit
 * revient a ecrire puis effacer a chaque tentative — exactement le travail que le
 * plafond existe pour eviter, et une fenetre pendant laquelle le disque est plein quand
 * c'est precisement lui qui manque.
 *
 * Ce garde-fou se place donc devant `uploadPhoto` dans la chaine.
 *
 * LE COMPTEUR EST FOURNI PAR LA ROUTE
 *
 * Les quatre routes qui acceptent des photos les rangent de trois manieres :
 * `MediaDefaut` en table, `Inspection.photos` et `Ouvrage.photos` en tableaux de chaines,
 * `OrdreTravaux.photos` en relation. La POLITIQUE doit rester unique — sinon le prochain
 * module qui accepte des photos n'en aura aucune — mais le COMPTAGE est local.
 *
 * UN OBJET INTROUVABLE N'EST PAS TRAITE ICI
 *
 * Quand le compteur rend `null`, la chaine continue et la route rend son propre 404.
 * Repondre ici changerait un comportement deja eprouve : la route des defauts rend 404 a
 * qui n'est ni l'auteur ni gestionnaire, pour ne pas reveler l'existence de la ligne, et
 * dupliquer ce raisonnement dans un middleware le ferait diverger.
 */
export function plafondPhotos(
  compter: (req: Request) => Promise<number | null>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const dejaPresentes = await compter(req);
      // Cible inconnue ou hors perimetre : c'est a la route de repondre, pas a nous.
      if (dejaPresentes === null) return next();

      // Les plafonds sont relus a chaque requete plutot que figes a l'import : cela
      // coute deux lectures de `process.env` et evite d'entrainer `config/env`, qui
      // appelle `process.exit(1)` sans `.env` et empecherait tout test important une
      // route de DEMARRER.
      const { parObjet, disqueOctets } = plafonds();
      const octetsUtilises = await octetsDuRepertoire(PHOTOS_UPLOAD_DIR);
      const motif = refusQuota({
        dejaPresentes,
        plafondParObjet: parObjet,
        octetsUtilises,
        plafondOctets: disqueOctets,
      });

      if (motif) {
        return res.status(statutHttp(motif)).json({
          message: EXPLICATIONS[motif],
          motif,
          ...(motif === "PLAFOND_PAR_OBJET"
            ? { dejaPresentes, plafond: parObjet }
            : {}),
        });
      }

      /**
       * TENIR LE COMPTE A JOUR, DEPUIS LE SEUL ENDROIT QUI VOIT LES QUATRE ROUTES.
       *
       * La mesure du repertoire est en cache une minute. Sans ce rattrapage, une file de
       * synchronisation qui se rejoue vite passerait TOUT ENTIERE au travers du plafond
       * global : chaque requete lirait la meme valeur perimee.
       *
       * Le controle a lieu avant multer, donc la taille du fichier n'est pas encore
       * connue ici ; elle l'est a la fin de la reponse. Placer ce rattrapage dans les
       * quatre gestionnaires de route aurait produit quatre endroits a ne pas oublier,
       * dont un oublie.
       *
       * On verifie que le fichier EXISTE ENCORE : une route qui refuse la photo la
       * supprime, et la route des defauts rend meme un 200 sans rien garder quand
       * l'empreinte SHA-256 est deja connue. Compter ces octets gonflerait le total pour
       * des fichiers absents.
       */
      res.on("finish", () => {
        const fichier = req.file;
        if (!fichier || res.statusCode >= 400) return;
        void stat(fichier.path)
          .then((s) => ajouterAuCache(s.size))
          .catch(() => {
            // Fichier supprime par la route : rien a compter, et surtout rien a signaler.
          });
      });

      return next();
    } catch (err) {
      return next(err);
    }
  };
}
