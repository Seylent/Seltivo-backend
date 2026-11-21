import { z } from 'zod';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = Buffer.from([255, 216, 255]);
const imageData = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function isInlineImage(value: string): boolean {
  const match = imageData.exec(value);
  if (!match || match[2].length < 16 || match[2].length % 4 !== 0) return false;
  const signature = Buffer.from(match[2].slice(0, 16), 'base64');
  if (match[1] === 'png') return signature.subarray(0, 8).equals(png);
  if (match[1] === 'jpeg') return signature.subarray(0, 3).equals(jpeg);
  return signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
}

const field = {
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/),
  label: z.string().min(1).max(120),
};

export const trialSnapshot = z.object({
  version: z.literal(1),
  templateId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  changes: z.array(z.discriminatedUnion('kind', [
    z.object({ ...field, kind: z.literal('text'), value: z.string().max(240) }),
    z.object({ ...field, kind: z.literal('image'), value: z.string().max(230_000).refine((value) =>
      isInlineImage(value) || value.length <= 2048 && /^(?:\/(?!\/)|https:\/\/)[^\s\\]*$/.test(value)) }),
  ])).max(12),
}).strict().refine((value) => {
  if (new Set(value.changes.map((change) => change.id)).size !== value.changes.length) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 1_700_000;
});
