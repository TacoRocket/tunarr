import { createHash } from 'node:crypto';

export const POTION_MODEL_ID = 'minishlab/potion-base-8M';
export const POTION_MODEL_REVISION = 'bf8b056651a2c21b8d2565580b8569da283cab23';
export const POTION_EMBEDDING_DIMENSIONS = 256;
export const POTION_MODEL_IDENTITY = `${POTION_MODEL_ID}@${POTION_MODEL_REVISION}`;

export const potionModelFiles = {
  'model.safetensors': {
    bytes: 30236760,
    sha256: 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2',
  },
  'tokenizer.json': {
    bytes: 683666,
    sha256: 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50',
  },
  'config.json': {
    bytes: 202,
    sha256: '2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553',
  },
  'tokenizer_config.json': {
    bytes: 1431,
    sha256: '6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567',
  },
} as const;

export type PotionModelFilename = keyof typeof potionModelFiles;

export function validatePotionModelFile(
  filename: PotionModelFilename,
  data: Uint8Array,
): void {
  const expected = potionModelFiles[filename];
  if (
    data.byteLength !== expected.bytes ||
    createHash('sha256').update(data).digest('hex') !== expected.sha256
  ) {
    throw new Error(
      `Potion asset ${filename} does not match ${POTION_MODEL_IDENTITY}`,
    );
  }
}
