import type { AxiosError } from "axios";

export interface ApiErrorInfo {
  message: string;
  fieldErrors: Record<string, string[]>;
}

interface ApiErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
}

// Le backend renvoie soit { error } (ApiError/Prisma/Multer), soit { error, details }
// pour un ZodError (details = err.flatten(), avec fieldErrors par nom de champ).
export function parseApiError(err: unknown): ApiErrorInfo {
  const body = (err as AxiosError<ApiErrorBody>)?.response?.data;
  const fieldErrors = body?.details?.fieldErrors ?? {};
  const message = body?.error ?? body?.details?.formErrors?.[0] ?? "Une erreur est survenue";
  return { message, fieldErrors };
}
