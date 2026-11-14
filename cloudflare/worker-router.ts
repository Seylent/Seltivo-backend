import type { FastifyInstance } from 'fastify';

type Handler = (request: any, reply: Reply) => unknown | Promise<unknown>;
type ErrorHandler = (error: unknown, request: any, reply: Reply) => unknown | Promise<unknown>;
type Route = { method: string; pattern: RegExp; names: string[]; handler: Handler };

class Reply {
  statusCode = 200;
  headers: Record<string, string> = {};
  payload: unknown;
  sent = false;

  code(status: number) { this.statusCode = status; return this; }
  header(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; }
  send(payload?: unknown) { this.payload = payload; this.sent = true; return this; }
}

export function createWorkerRouter(): FastifyInstance {
  const routes: Route[] = [];
  const hooks: Record<string, Handler[]> = { onRequest: [], onSend: [] };
  let errorHandler: ErrorHandler | undefined;
  const add = (method: string, path: string, handler: Handler) => {
    const names: string[] = [];
    const pattern = new RegExp(`^${path.split('/').map((segment) => {
      if (segment.startsWith(':')) { names.push(segment.slice(1)); return '([^/]+)'; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/')}/?$`);
    routes.push({ method, pattern, names, handler });
  };
  const router = {
    log: { error: (...args: unknown[]) => console.error(...args) },
    get: (path: string, handler: Handler) => add('GET', path, handler),
    post: (path: string, handler: Handler) => add('POST', path, handler),
    patch: (path: string, handler: Handler) => add('PATCH', path, handler),
    delete: (path: string, handler: Handler) => add('DELETE', path, handler),
    addHook: (name: string, handler: Handler) => { hooks[name]?.push(handler); },
    setErrorHandler: (handler: ErrorHandler) => { errorHandler = handler; },
    async inject(input: { method: string; url: string; headers?: Record<string, string>; payload?: Buffer }) {
      const url = new URL(input.url, 'https://worker.local');
      const route = routes.find((item) => item.method === input.method && item.pattern.test(url.pathname));
      const reply = new Reply();
      if (!route) reply.code(404).send({ error: 'Не знайдено.' });
      else {
        const match = route.pattern.exec(url.pathname)!;
        const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
        const request = {
          method: input.method,
          url: input.url,
          headers: input.headers ?? {},
          ip: input.headers?.['cf-connecting-ip'] ?? '127.0.0.1',
          params,
          query: Object.fromEntries(url.searchParams),
          body: undefined as unknown,
        };
        try {
          if ((input.payload?.length ?? 0) > 9 * 1024 * 1024) reply.code(413).send({ error: 'Запит завеликий.' });
          else if (input.payload?.length) {
            try { request.body = JSON.parse(input.payload.toString('utf8')); }
            catch { reply.code(400).send({ error: 'Невірний формат запиту.' }); }
          }
          if (!reply.sent) for (const hook of hooks.onRequest) {
            await hook(request, reply);
            if (reply.sent) break;
          }
          if (!reply.sent) {
            const result = await route.handler(request, reply);
            if (!reply.sent) reply.send(result);
          }
          for (const hook of hooks.onSend) await hook(request, reply);
        } catch (error) {
          if (errorHandler) await errorHandler(error, request, reply);
          else throw error;
        }
      }
      const payload = reply.statusCode === 204 || reply.payload === undefined ? Buffer.alloc(0)
        : Buffer.from(typeof reply.payload === 'string' ? reply.payload : JSON.stringify(reply.payload));
      if (reply.payload !== undefined && typeof reply.payload !== 'string') reply.header('Content-Type', 'application/json; charset=utf-8');
      return { statusCode: reply.statusCode, headers: reply.headers, rawPayload: payload };
    },
  };
  return router as unknown as FastifyInstance;
}
