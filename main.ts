// main.ts - Proxy Cache para iNaturalist API
import { Hono } from "https://deno.land/x/hono@v4.5.8/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.5.8/middleware.ts";

const app = new Hono();

// Cache em memória (Map simples para Deno Deploy)
const cache = new Map<
  string,
  {
    data: string;
    timestamp: number;
    headers: Record<string, string>;
  }
>();

// Deno KV para rate limiting global
const kv = await Deno.openKv();

// Rate limiting global com Deno KV
class GlobalRateLimiter {
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;

  constructor(requestsPerSecond: number = 1, maxRetries: number = 30) {
    this.minInterval = 1000 / requestsPerSecond; // 1000ms para 1 req/seg
    this.maxRetries = maxRetries;
    this.retryDelay = 100; // 100ms entre tentativas
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let retries = 0;

    while (retries < this.maxRetries) {
      const canExecute = await this.acquireLock();

      if (canExecute) {
        try {
          console.log(`📡 Executando requisição (tentativa ${retries + 1})`);
          return await fn();
        } catch (error) {
          throw error;
        }
      }

      retries++;
      const waitTime = this.retryDelay + retries * 50; // Backoff exponencial suave
      console.log(
        `⏱️ Rate limit ativo, aguardando ${waitTime}ms (tentativa ${retries}/${this.maxRetries})`,
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    throw new Error("Rate limit: máximo de tentativas excedido");
  }

  private async acquireLock(): Promise<boolean> {
    const now = Date.now();
    const lockKey = ["rate_limit", "inat_api"];

    // Tentar pegar o último timestamp
    const result = await kv.get(lockKey);
    const lastRequest = (result.value as number) || 0;

    // Verificar se já passou tempo suficiente
    if (now - lastRequest < this.minInterval) {
      return false;
    }

    // Usar compare-and-swap para atomicidade
    const success = await kv
      .atomic()
      .check(result) // Verificar se valor não mudou
      .set(lockKey, now) // Atualizar timestamp
      .commit();

    return success.ok;
  }

  async getStats(): Promise<{
    lastRequest: number;
    queueWaitEstimate: number;
  }> {
    const result = await kv.get(["rate_limit", "inat_api"]);
    const lastRequest = (result.value as number) || 0;
    const now = Date.now();
    const queueWaitEstimate = Math.max(
      0,
      this.minInterval - (now - lastRequest),
    );

    return { lastRequest, queueWaitEstimate };
  }
}

// Instância do rate limiter global
const globalRateLimiter = new GlobalRateLimiter(1);

// Configurações
const API_KEY = Deno.env.get("API_KEY") || "sua-chave-secreta-aqui";
const CACHE_DURATION = 60 * 24 * 60 * 60 * 1000; // 60 dias em ms
const ALLOWED_ORIGINS = [
  "https://seudominio.com",
  "https://www.seudominio.com",
  "http://localhost:3000",
  "http://localhost:5173", // Vite dev
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

// Função para limpar cache antigo (opcional)
const cleanExpiredCache = () => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
};

// Rota principal do proxy cache
app.get("/api/inat/*", authMiddleware, async (c) => {
  try {
    // Extrair path e query parameters
    const originalPath = c.req.path;
    const inatPath = originalPath.replace("/api/inat", "");
    const searchParams = new URL(c.req.url).searchParams;
    const queryString = searchParams.toString();

    // Construir URL completa para iNaturalist
    const inatUrl = `https://api.inaturalist.org${inatPath}${queryString ? "?" + queryString : ""}`;

    // Chave do cache
    const cacheKey = inatUrl;

    // Verificar cache
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log(`🎯 Cache HIT: ${inatPath}`);

      return new Response(cached.data, {
        headers: {
          "Content-Type": cached.headers["content-type"] || "application/json",
          "X-Cache": "HIT",
          "X-Cache-Age": Math.floor(
            (Date.now() - cached.timestamp) / 1000,
          ).toString(),
          "Access-Control-Allow-Origin": c.req.header("Origin") || "*",
        },
      });
    }

    console.log(`🌐 Cache MISS: ${inatPath} - Aguardando rate limit global`);

    // Fazer requisição com rate limiting global via KV
    const response = await globalRateLimiter.execute(async () => {
      return await fetch(inatUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Proxy-Cache/1.0",
          Accept: "application/json",
          // NÃO incluir X-API-Key aqui!
        },
      });
    });

    if (!response.ok) {
      throw new Error(
        `iNaturalist API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.text();
    const contentType =
      response.headers.get("content-type") || "application/json";

    // Cachear resposta
    cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      headers: { "content-type": contentType },
    });

    console.log(`✅ Cached: ${inatPath}`);

    return new Response(data, {
      headers: {
        "Content-Type": contentType,
        "X-Cache": "MISS",
        "Access-Control-Allow-Origin": c.req.header("Origin") || "*",
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return c.json(
      {
        error: "Proxy Error",
        message: error.message,
      },
      500,
    );
  }
});

// Rota de health check
app.get("/health", (c) => {
  cleanExpiredCache(); // Limpar cache expirado

  return c.json({
    status: "ok",
    cache_size: cache.size,
    timestamp: new Date().toISOString(),
  });
});

// Rota de informações do cache e rate limiting
app.get("/cache/stats", authMiddleware, async (c) => {
  const rateLimitStats = await globalRateLimiter.getStats();

  const stats = {
    total_entries: cache.size,
    rate_limit: {
      requests_per_second: 1,
      last_request_ms_ago: Date.now() - rateLimitStats.lastRequest,
      estimated_wait_ms: rateLimitStats.queueWaitEstimate,
    },
    entries: Array.from(cache.entries()).map(([key, value]) => ({
      url: key,
      age_seconds: Math.floor((Date.now() - value.timestamp) / 1000),
      size_bytes: value.data.length,
    })),
  };

  return c.json(stats);
});

// Limpar cache manualmente
app.delete("/cache/clear", authMiddleware, (c) => {
  cache.clear();
  return c.json({
    message: "Cache cleared",
    timestamp: new Date().toISOString(),
  });
});

// Rota raiz
app.get("/", (c) => {
  return c.json({
    message: "iNaturalist Proxy Cache API",
    endpoints: {
      proxy: "/api/inat/*",
      health: "/health",
      stats: "/cache/stats",
      clear: "/cache/clear",
    },
  });
});

export default app;
