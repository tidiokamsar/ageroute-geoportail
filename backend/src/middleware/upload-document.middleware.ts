import multer from "multer";
import path from "path";
import crypto from "crypto";

// Stockage disque (volume Docker dedie /app/uploads, monte en persistant) plutot que
// memoire : ce sont des fichiers officiels (arretes, cahiers des charges) destines a
// rester accessibles au telechargement, pas des imports ponctuels comme uploadExcel.
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "documents");

const ALLOWED_EXT = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;

export const uploadDocument = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname)) {
      cb(new Error("Format de fichier non supporté (pdf, doc, docx, jpg, png attendu)"));
      return;
    }
    cb(null, true);
  },
}).single("file");

export { UPLOAD_DIR };
