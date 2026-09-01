import multer from "multer";

// Fichiers Excel en memoire uniquement (pas d'ecriture disque), taille limitee a 10 Mo.
// Filtre par extension (le mimetype envoye par le client n'est pas fiable selon l'outil/OS) :
// la lib xlsx n'a pas de version corrigee sur npm pour ses CVE connues, on reduit la surface
// d'attaque en se limitant aux feuilles de calcul, route de toute facon reservee
// ADMIN/GESTIONNAIRE par requireRole.
export const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(xlsx|xls)$/i.test(file.originalname)) {
      cb(new Error("Format de fichier non supporté (xlsx/xls attendu)"));
      return;
    }
    cb(null, true);
  },
}).single("file");
