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

app.get("/", (c: any) => {
  return c.json({
    message: "iNaturalist Proxy",
    cache: "1 day with Hono cache middleware",
  });
});

export default app;
