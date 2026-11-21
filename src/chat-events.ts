import type { Actor } from './auth.js';

type ChatEvent = { kind: 'message' | 'status' | 'request'; requestId: string };
type Subscriber = { actor: Actor; send: (frame: Uint8Array) => void };

export function createChatEvents() {
  const subscribers = new Set<Subscriber>();
  const encoder = new TextEncoder();
  const ready = encoder.encode('retry: 3000\nevent: ready\ndata: {}\n\n');
  const ping = encoder.encode(': ping\n\n');

  return {
    subscribe(actor: Actor, isSessionValid: () => boolean) {
      if (subscribers.size >= 1024) return null;
      const active = [...subscribers].filter((subscriber) => subscriber.actor.id === actor.id).length;
      if (active >= 8) return null;

      let cleanup: () => void;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => {
            cleanup();
            controller.close();
          };
          const subscriber: Subscriber = {
            actor,
            send(frame) {
              try {
                if (!isSessionValid() || (controller.desiredSize ?? 0) <= 0) {
                  close();
                  return;
                }
                controller.enqueue(frame);
              } catch {
                cleanup();
                controller.error(new Error('Chat event stream closed'));
              }
            },
          };
          const timer = setInterval(() => subscriber.send(ping), 20_000);
          cleanup = () => {
            subscribers.delete(subscriber);
            clearInterval(timer);
          };
          subscribers.add(subscriber);
          controller.enqueue(ready);
        },
        cancel() { cleanup(); },
      }, { highWaterMark: 16 });
    },
    publish(customerId: string, event: ChatEvent) {
      const frame = encoder.encode('event: chat\ndata: ' + JSON.stringify(event) + '\n\n');
      for (const subscriber of subscribers) {
        if (subscriber.actor.id === customerId || subscriber.actor.role === 'admin') subscriber.send(frame);
      }
    },
  };
}
