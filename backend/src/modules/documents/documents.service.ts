import path from "path";
import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import type { DocumentCreateInput } from "./documents.schema";

const base = createCrudService(prisma.document, "Document", { troncon: true });

interface DocumentListParams extends ListParams {
  search?: string;
  type?: string;
  annee?: number;
  tronconId?: string;
}

async function list(params: DocumentListParams) {
  const where: Record<string, unknown> = { ...params.where };
  if (params.search) where.titre = { contains: params.search, mode: "insensitive" };
  if (params.type) where.type = params.type;
  if (params.annee) where.annee = params.annee;
  if (params.tronconId) where.tronconId = params.tronconId;
  return base.list({ ...params, where });
}

interface UploadedFile {
  filename: string;
  originalname: string;
  mimetype: string;
  size: number;
}

async function create(data: DocumentCreateInput, file: UploadedFile, userId: string) {
  return base.create(
    {
      titre: data.titre,
      type: data.type,
      annee: data.annee,
      tronconId: data.tronconId,
      fileName: file.originalname,
      filePath: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    },
    userId
  );
}

async function getDownloadInfo(id: string) {
  const doc = await base.getById(id) as { fileName: string; filePath: string; mimeType: string };
  return {
    absolutePath: path.join(process.cwd(), "uploads", "documents", doc.filePath),
    fileName: doc.fileName,
    mimeType: doc.mimeType,
  };
}

export const documentsService = { ...base, list, create, getDownloadInfo };
