import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatEvents } from '../src/chat-events.js';
import type { Actor } from '../src/auth.js';

process.env.NODE_ENV = 'test';

const actor = (id: string, role: Actor['role']): Actor => ({
  id, email: `${id}@example.test`, role, name: id, email_verified_at: null,
});

test('new request events reach admins through the live chat channel', async () => {
  const events = createChatEvents();
  const stream = events.subscribe(actor('admin-1', 'admin'), () => true);
  assert.ok(stream);
  const reader = stream!.getReader();
  try {
    //Перший кадр — ready.
    await reader.read();
    events.publish('customer-1', { kind: 'request', requestId: 'request-1' });
    const frame = await reader.read();
    const text = new TextDecoder().decode(frame.value);
    assert.match(text, /event: chat/);
    assert.match(text, /"kind":"request"/);
    assert.match(text, /"requestId":"request-1"/);
  } finally {
    await reader.cancel();
  }
});
