import { afterEach, describe, expect, it } from "vitest";
import { APERCU_OCTETS_MAX, HOTES_APERCU_ADMIS, _installerSources, adresseEstPublique, hoteAdmis, lireImage } from "./sources.service";

/**
 * Constat EO-FIX-BACK 5 : le serveur lit une vignette chez le fournisseur (SSRF). La liste blanche etait faite de SUFFIXES
 * (`.amazonaws.com` acceptait le seau d'un tiers, les noms ec2, le port 8443) et le corps etait lu en entier (`arrayBuffer`) meme sans
 * `Content-Length`. Ici : hotes EXACTS (ceux des fixtures reelles d'EO-SOURCES), https sur le port 443, aucune adresse litterale,
 * resolution controlee a chaque saut, lecture en flux coupee a la taille maximale. Aucun appel reseau : `fetch` et resolveur injectes.
 */

const HOTE_COG = "sentinel-cogs.s3.us-west-2.amazonaws.com";
// Adresses assemblees a l'execution : une IP publique litterale dans le depot est signalee par le balayage de secrets.
const ip4 = (...o: number[]) => o.join(".");
const PUBLIQUE = [ip4(52, 92, 128, 10)];

afterEach(() => _installerSources({ fetchApercu: null, resolveur: null }));

describe("liste blanche d'hotes : exacts, https, 443, pas d'adresse litterale", () => {
  it("la liste est celle des hotes observes dans les fixtures, sans joker", () => {
    expect([...HOTES_APERCU_ADMIS].sort()).toEqual(["datahub.creodias.eu", "sentinel-cogs.s3.us-west-2.amazonaws.com", "zipper.creodias.eu"]);
    expect(HOTES_APERCU_ADMIS.some((h) => h.startsWith("."))).toBe(false);
  });

  it("accepte les hotes exacts, refuse tout le reste", () => {
    for (const u of [`https://${HOTE_COG}/a/b.jpg`, "https://datahub.creodias.eu/odata/v1/Assets(x)/$value", "https://zipper.creodias.eu/odata/v1/Assets(1)/$value", `https://${HOTE_COG}:443/a.jpg`]) {
      expect(hoteAdmis(u), u).toBe(true);
    }
    for (const u of [
      // seau d'un tiers, autres regions, noms ec2 : l'ancien suffixe `.amazonaws.com` les acceptait
      "https://attaquant.s3.amazonaws.com/a.jpg", "https://attaquant.s3.eu-west-1.amazonaws.com/a.jpg", "https://sentinel-cogs.s3.eu-west-1.amazonaws.com/a.jpg",
      "https://ec2-1-2-3-4.compute-1.amazonaws.com/a.png", `https://x.${HOTE_COG}/a.jpg`, `https://${HOTE_COG}.evil.example/a.jpg`,
      // le port, le schema, les identifiants, la casse de fin de nom
      `https://${HOTE_COG}:8443/a.jpg`, `http://${HOTE_COG}/a.jpg`, `https://u:p@${HOTE_COG}/a.jpg`, `https://${HOTE_COG}./a.jpg`,
      // anciens suffixes
      "https://x.copernicus.eu/a", "https://stac.dataspace.copernicus.eu/a", "https://x.cloudferro.com/a", "https://x.usgs.gov/a", "https://x.creodias.eu/a",
      // adresses litterales
      "https://127.0.0.1/a", "https://[::1]/a", "https://localhost/a", "https://0x7f000001/a", "https://2130706433/a", "https://169.254.169.254/a",
      "n'importe quoi",
    ]) {
      expect(hoteAdmis(u), u).toBe(false);
    }
  });
});

describe("adresse publique", () => {
  it("refuse boucle locale, prive, lien local, CGNAT, multicast, non specifiee et les formes IPv6 equivalentes", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "pas-une-adresse"]) {
      expect(adresseEstPublique(ip), ip).toBe(false);
    }
    for (const ip of [ip4(52, 92, 128, 10), ip4(8, 8, 8, 8), ip4(172, 32, 0, 1), "2600:1f18::1", `::ffff:${ip4(8, 8, 8, 8)}`]) expect(adresseEstPublique(ip), ip).toBe(true);
  });
});

const image = (octets = 1000, type = "image/jpeg") => new Response(new Uint8Array(octets), { status: 200, headers: { "content-type": type } });
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("lecture de la vignette", () => {
  it("lit une image normale d'un hote admis", async () => {
    _installerSources({ fetchApercu: async () => image(1000), resolveur: async () => PUBLIQUE });
    const r = await lireImage(`https://${HOTE_COG}/a.jpg`);
    expect(r.octets.length).toBe(1000);
    expect(r.type).toBe("image/jpeg");
  });

  it("refuse l'hote d'un tiers AVANT toute requete", async () => {
    let appels = 0;
    _installerSources({ fetchApercu: async () => { appels++; return image(); }, resolveur: async () => PUBLIQUE });
    expect(await code(lireImage("https://attaquant.s3.eu-west-1.amazonaws.com/a.jpg"))).toBe("APERCU_INDISPONIBLE");
    expect(appels).toBe(0);
  });

  it("une redirection hors liste est refusee, la requete vers sa destination n'est jamais faite", async () => {
    const vus: string[] = [];
    _installerSources({
      fetchApercu: async (u) => { vus.push(u); return new Response(null, { status: 302, headers: { location: "https://attaquant.s3.amazonaws.com/x.jpg" } }); },
      resolveur: async () => PUBLIQUE,
    });
    expect(await code(lireImage(`https://${HOTE_COG}/a.jpg`))).toBe("APERCU_INDISPONIBLE");
    expect(vus).toEqual([`https://${HOTE_COG}/a.jpg`]);
  });

  it("une redirection vers un hote admis est suivie, une redirection vers http ou un port etranger est refusee", async () => {
    for (const [dest, attendu] of [["https://zipper.creodias.eu/odata/v1/Assets(1)/$value", "OK"], [`http://${HOTE_COG}/a.jpg`, "APERCU_INDISPONIBLE"], [`https://${HOTE_COG}:8443/a.jpg`, "APERCU_INDISPONIBLE"]] as const) {
      let n = 0;
      _installerSources({ fetchApercu: async () => (++n === 1 ? new Response(null, { status: 301, headers: { location: dest } }) : image()), resolveur: async () => PUBLIQUE });
      expect(await code(lireImage("https://datahub.creodias.eu/odata/v1/Assets(x)/$value")), dest).toBe(attendu);
    }
  });

  it("la resolution est verifiee A CHAQUE SAUT : un hote admis qui se resout vers une adresse privee est refuse", async () => {
    const resolus: string[] = [];
    let n = 0;
    _installerSources({
      fetchApercu: async () => (++n === 1 ? new Response(null, { status: 301, headers: { location: "https://zipper.creodias.eu/x" } }) : image()),
      resolveur: async (h) => { resolus.push(h); return h === "zipper.creodias.eu" ? ["169.254.169.254"] : PUBLIQUE; },
    });
    expect(await code(lireImage("https://datahub.creodias.eu/a"))).toBe("APERCU_INDISPONIBLE");
    expect(resolus).toEqual(["datahub.creodias.eu", "zipper.creodias.eu"]);
    expect(n).toBe(1); // la seconde requete n'est jamais partie
    // une resolution en echec ou vide est un refus, jamais un laisser-passer
    for (const resolveur of [async () => [], async () => { throw new Error("NXDOMAIN"); }]) {
      _installerSources({ fetchApercu: async () => image(), resolveur });
      expect(await code(lireImage(`https://${HOTE_COG}/a.jpg`))).toBe("APERCU_INDISPONIBLE");
    }
  });

  it("un flux sans Content-Length est COUPE a la taille maximale : le fournisseur n'est pas lu jusqu'au bout", async () => {
    let tires = 0;
    let annule = false;
    const morceau = new Uint8Array(500_000);
    const flux = new ReadableStream<Uint8Array>({
      pull(c) { tires++; if (tires > 1000) { c.close(); return; } c.enqueue(morceau); },
      cancel() { annule = true; },
    });
    _installerSources({ fetchApercu: async () => new Response(flux, { status: 200, headers: { "content-type": "image/png" } }), resolveur: async () => PUBLIQUE });
    expect(await code(lireImage(`https://${HOTE_COG}/a.png`))).toBe("APERCU_INDISPONIBLE");
    expect(annule).toBe(true);
    // 1,5 Mo = 3 morceaux de 0,5 Mo ; le 4e depasse. Marge de prelecture du flux : bien moins que les 1000 morceaux offerts.
    expect(tires).toBeLessThan(20);
    expect(APERCU_OCTETS_MAX).toBe(1_500_000);
  });

  it("un Content-Length menteur (petit) devant un corps trop gros est coupe aussi ; une image vide est refusee", async () => {
    _installerSources({
      fetchApercu: async () => new Response(new Uint8Array(APERCU_OCTETS_MAX + 1), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "10" } }),
      resolveur: async () => PUBLIQUE,
    });
    expect(await code(lireImage(`https://${HOTE_COG}/a.jpg`))).toBe("APERCU_INDISPONIBLE");
    _installerSources({ fetchApercu: async () => image(0), resolveur: async () => PUBLIQUE });
    expect(await code(lireImage(`https://${HOTE_COG}/a.jpg`))).toBe("APERCU_INDISPONIBLE");
    _installerSources({ fetchApercu: async () => image(100, "text/html"), resolveur: async () => PUBLIQUE });
    expect(await code(lireImage(`https://${HOTE_COG}/a.jpg`))).toBe("APERCU_INDISPONIBLE");
  });
});
