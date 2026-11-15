import { randomUUID } from 'node:crypto';

type Scenario = {
  manifestKey: string;
  customers: { email: string; password: string; requestId: string }[];
  admins: { email: string; password: string }[];
};

type Env = { SELTIVO: DurableObjectNamespace; SELTIVO_PUBLIC_ORIGIN: string };

function valid(value: unknown): value is Scenario {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<Scenario>;
  return typeof body.manifestKey === 'string' && body.manifestKey.startsWith('seltivo-backups/v1/')
    && Array.isArray(body.customers) && body.customers.length === 2
    && body.customers.every((customer) => typeof customer?.email === 'string' && typeof customer.password === 'string' && typeof customer.requestId === 'string')
    && Array.isArray(body.admins) && body.admins.length === 2
    && body.admins.every((admin) => typeof admin?.email === 'string' && typeof admin.password === 'string');
}

function ensure(response: Response, status: number, step: string): void {
  if (response.status !== status) throw new Error(`Staging restore check failed at ${step}: ${response.status}`);
}

export async function runStagingRestoreCheck(env: Env, input: unknown): Promise<{ ok: true; restoredRows: number; messages: number }> {
  if (!valid(input)) throw new Error('Invalid staging restore scenario');
  const id = env.SELTIVO.idFromName(`restore-check-${randomUUID()}`);
  const stub = env.SELTIVO.get(id);
  const origin = env.SELTIVO_PUBLIC_ORIGIN;
  const call = (method: string, path: string, body?: unknown, cookie?: string, extraHeaders?: Record<string, string>) => stub.fetch(new Request(`https://internal.seltivo${path}`, {
    method,
    headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const login = async (email: string, password: string, step: string) => {
    const response = await call('POST', '/api/v1/auth/login', { email, password });
    ensure(response, 200, step);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error(`Staging restore check failed at ${step}: no session`);
    return cookie;
  };
  try {
    const restored = await call('POST', '/internal/restore', { manifestKey: input.manifestKey });
    ensure(restored, 200, 'restore');
    const summary = await restored.json() as { rows: number; quickCheck: string };
    if (summary.quickCheck !== 'ok') throw new Error('Staging restore check failed at quick_check');
    const customer = await login(input.customers[0].email, input.customers[0].password, 'first customer login');
    const secondCustomer = await login(input.customers[1].email, input.customers[1].password, 'second customer login');
    const requestPath = `/api/v1/requests/${encodeURIComponent(input.customers[0].requestId)}`;
    const secondRequestPath = `/api/v1/requests/${encodeURIComponent(input.customers[1].requestId)}`;
    ensure(await call('GET', requestPath, undefined, secondCustomer), 404, 'second customer isolation');
    ensure(await call('GET', secondRequestPath, undefined, customer), 404, 'first customer isolation');
    ensure(await call('GET', secondRequestPath, undefined, secondCustomer), 200, 'second customer request');
    const request = await call('GET', requestPath, undefined, customer);
    ensure(request, 200, 'customer request');
    const detail = await request.json() as { id: string; status: string; statusVersion: number; events: unknown[] };
    if (detail.id !== input.customers[0].requestId || detail.status !== 'submitted' || !detail.events.length) throw new Error('Staging restore check failed at history');
    const messagesPath = `${requestPath}/messages`;
    const before = await call('GET', messagesPath, undefined, customer);
    ensure(before, 200, 'customer chat');
    const oldCount = ((await before.json()) as { items: unknown[] }).items.length;
    if (!oldCount) throw new Error('Staging restore check failed at original message');
    const admin = await login(input.admins[0].email, input.admins[0].password, 'first admin login');
    const secondAdmin = await login(input.admins[1].email, input.admins[1].password, 'second admin login');
    ensure(await call('GET', requestPath, undefined, admin), 200, 'admin request');
    ensure(await call('POST', messagesPath, { body: 'Staging restore check', clientMessageId: randomUUID() }, admin), 201, 'admin reply');
    const after = await call('GET', messagesPath, undefined, customer);
    ensure(after, 200, 'customer reply');
    const messages = ((await after.json()) as { items: unknown[] }).items.length;
    if (messages !== oldCount + 1) throw new Error('Staging restore check failed at reply count');
    const statusPath = `/api/v1/admin/requests/${encodeURIComponent(detail.id)}/status`;
    ensure(await call('PATCH', statusPath, { status: 'reviewing' }, admin,
      { 'If-Match': String(detail.statusVersion) }), 200, 'admin status');
    ensure(await call('PATCH', statusPath, { status: 'in_progress' }, secondAdmin,
      { 'If-Match': String(detail.statusVersion) }), 409, 'stale second admin status');
    ensure(await call('PATCH', statusPath, { status: 'in_progress' }, secondAdmin,
      { 'If-Match': String(detail.statusVersion + 1) }), 200, 'second admin status');
    const updated = await call('GET', requestPath, undefined, customer);
    ensure(updated, 200, 'customer history');
    if (((await updated.json()) as { events: unknown[] }).events.length !== detail.events.length + 2) throw new Error('Staging restore check failed at status history');
    return { ok: true, restoredRows: summary.rows, messages };
  } finally {
    const discarded = await call('POST', '/internal/discard');
    ensure(discarded, 204, 'discard restore object');
  }
}
