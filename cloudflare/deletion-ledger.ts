import { DurableObject } from 'cloudflare:workers';

// Canonical UUID (v1-v5): fixed 8-4-4-4-12 hex layout, version nibble 1-5, variant 8/9/a/b.
// Matches the ids z.uuid() accepts in app.ts; structure, version and variant are still checked.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Акаунти й заявки зберігаються під різними префіксами; старі записи без `kind` — акаунти.
const PREFIX = { customer: 'customer:', request: 'request:' } as const;

const listIds = async (storage: DurableObjectStorage, prefix: string) =>
  [...(await storage.list<string>({ prefix })).keys()].map((key) => key.slice(prefix.length));

// Stored in a separate Durable Object so restoring the primary object's PITR
// history cannot restore an account or request whose deletion was already confirmed.
export class DeletionLedger extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/deletions') {
      return Response.json({
        ids: await listIds(this.ctx.storage, PREFIX.customer),
        requestIds: await listIds(this.ctx.storage, PREFIX.request),
      });
    }
    if (request.method === 'POST' && url.pathname === '/deletions') {
      const body = await request.json().catch(() => null) as { id?: unknown; kind?: unknown } | null;
      const kind = body?.kind ?? 'customer';
      if (typeof body?.id !== 'string' || !UUID.test(body.id) || (kind !== 'customer' && kind !== 'request')) return new Response(null, { status: 422 });
      await this.ctx.storage.put(`${PREFIX[kind]}${body.id}`, new Date().toISOString());
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
}
