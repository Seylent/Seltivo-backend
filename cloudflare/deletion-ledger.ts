import { DurableObject } from 'cloudflare:workers';

// Stored in a separate Durable Object so restoring the primary object's PITR
// history cannot restore an account whose deletion was already confirmed.
export class DeletionLedger extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/deletions') {
      const entries = await this.ctx.storage.list<string>({ prefix: 'customer:' });
      return Response.json({ ids: [...entries.keys()].map((key) => key.slice('customer:'.length)) });
    }
    if (request.method === 'POST' && url.pathname === '/deletions') {
      const body = await request.json().catch(() => null) as { id?: unknown } | null;
      if (typeof body?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return new Response(null, { status: 422 });
      await this.ctx.storage.put(`customer:${body.id}`, new Date().toISOString());
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
}
