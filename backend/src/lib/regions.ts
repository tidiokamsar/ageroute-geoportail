import { prisma } from "./prisma";

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

let cache: Map<string, number> | null = null;

async function loadCache(): Promise<Map<string, number>> {
  if (cache) return cache;
  const regions = await prisma.region.findMany();
  cache = new Map(regions.map((r) => [normalize(r.nom), r.id]));
  return cache;
}

export function invalidateRegionCache(): void {
  cache = null;
}

export async function resolveRegionId(nom: string | null | undefined): Promise<number | null> {
  if (!nom) return null;
  const map = await loadCache();
  return map.get(normalize(nom)) ?? null;
}
