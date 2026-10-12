import multer from "multer";
import path from "path";
import crypto from "crypto";

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "photos");

const ALLOWED_EXT = /\.(jpg|jpeg|png|webp)$/i;

export const uploadPhoto = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  // `files: 1` est redondant avec `.single()` mais le dit au niveau ou la limite se lit.
  // Les plafonds qui manquaient reellement — nombre par objet et total du repertoire —
  // ne peuvent pas vivre ici : multer ignore quel objet est vise. Voir
  // `quota-photos.middleware.ts`, pose DEVANT celui-ci pour refuser avant l'ecriture.
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname)) {
      cb(new Error("Format de fichier non supporté (jpg, png, webp attendu)"));
      return;
    }
    cb(null, true);
  },
}).single("photo");

export { UPLOAD_DIR as PHOTOS_UPLOAD_DIR };
