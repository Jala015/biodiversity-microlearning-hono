// main.ts - Proxy Cache com Deno Deploy CDN
import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { cache } from "@hono/hono/cache"; // ← Correção do import

const app = new Hono();

// Configurações
const API_KEY = Deno.env.get("API_KEY") || "sua-chave-secreta-aqui";
const ALLOWED_ORIGINS = [
  "https://microlearning-biodiversidade.vercel.app",
  "http://localhost:3000",
];

// CORS middleware
app.use(
  "/api/*",
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET"],
    allowHeaders: ["X-API-Key", "Content-Type"],
  }),
);

// Middleware de autenticação
const authMiddleware = async (c: any, next: any) => {
  const apiKey = c.req.header("X-API-Key");

  if (!apiKey || apiKey !== API_KEY) {
    return c.json(
      {
        error: "Unauthorized",
        message: "API Key inválida ou ausente",
      },
      401,
    );
  }

  await next();
};

// Rota principal com cache nativo do Hono
app.get(
  "/api/inat/*",
  authMiddleware,
  cache({
    cacheName: "inat-api-caching",
    cacheControl: "max-age=86400", //um dia
    wait: true,
  }),
  async (c: any) => {
    try {
      const originalPath = c.req.path;
      const inatPath = originalPath.replace("/api/inat", "");
      const searchParams = new URL(c.req.url).searchParams;
      const queryString = searchParams.toString();

      const inatUrl = `https://api.inaturalist.org${inatPath}${queryString ? "?" + queryString : ""}`;

      console.log(`🌐 Proxy para: ${inatPath}`);

      const response = await fetch(inatUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Proxy-Cache/1.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `iNaturalist API error: ${response.status} ${response.statusText}`,
        );
      }

      console.log(`✅ Sucesso: ${inatPath}`);

      return response;
    } catch (error: any) {
      console.error("Proxy error:", error);
      return c.json(
        {
          error: "Proxy Error",
          message: error.message,
        },
        500,
      );
    }
  }, // ← Faltava fechar a função
);

// Função para arredondar coordenadas
const roundGeodistance = (
  lat: number,
  lon: number,
  radius: number,
  decimals: number = 4,
) => {
  const factor = Math.pow(10, decimals);
  return {
    lat: Math.round(lat * factor) / factor,
    lon: Math.round(lon * factor) / factor,
    radius: radius.toPrecision(2),
  };
};

// rota para buscar no gbif
app.get(
  "/api/gbif/*",
  authMiddleware,
  cache({
    cacheName: "gbif-api-caching",
    cacheControl: "max-age=86400", //um dia
    wait: true,
  }),
  async (c: any) => {
    try {
      const originalPath = c.req.path;
      const gbifPath = originalPath.replace("/api/gbif", "");
      const searchParams = new URL(c.req.url).searchParams;

      //arredondar coordenadas
      const geoDistanceParam = searchParams.get("geoDistance");
      if (geoDistanceParam) {
        const [lat, lon, radius] = geoDistanceParam.split(",");
        const rounded = roundGeodistance(parseFloat(lat), parseFloat(lon), 4);

        // Substituir no searchParams
        searchParams.set(
          "geoDistance",
          `${rounded.lat},${rounded.lon},${rounded.radius}`,
        );
      }

      const queryString = searchParams.toString();

      const gbifUrl = `https://api.gbif.org${gbifPath}${queryString ? "?" + queryString : ""}`;

      console.log(`🌐 Proxy para: ${gbifPath}`);

      const response = await fetch(gbifUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Proxy-Cache/1.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `GBIF API error: ${response.status} ${response.statusText}`,
        );
      }

      console.log(`✅ Sucesso: ${gbifPath}`);

      return response;
    } catch (error: any) {
      console.error("Proxy error:", error);
      return c.json(
        {
          error: "Proxy Error",
          message: error.message,
        },
        500,
      );
    }
  },
);

app.get("/", (c: any) => {
  return c.json({
    message: "iNaturalist Proxy",
    cache: "1 day with Hono cache middleware",
  });
});

export default app;
