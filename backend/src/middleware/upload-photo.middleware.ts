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
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname)) {
      cb(new Error("Format de fichier non supporté (jpg, png, webp attendu)"));
      return;
    }
    cb(null, true);
  },
}).single("photo");

export { UPLOAD_DIR as PHOTOS_UPLOAD_DIR };
