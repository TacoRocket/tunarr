import { Tokenizer } from '@huggingface/tokenizers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import throttle from '../../util/throttle.ts';
import {
  POTION_EMBEDDING_DIMENSIONS,
  validatePotionModelFile,
} from './potionModelManifest.ts';
import type { PotionModelFilename } from './potionModelManifest.ts';

const VocabularySize = 29528;
const UnknownTokenId = 1;
const BatchSize = 100;
const TensorHeader = z.object({
  embeddings: z.object({
    dtype: z.literal('F32'),
    shape: z.tuple([
      z.literal(VocabularySize),
      z.literal(POTION_EMBEDDING_DIMENSIONS),
    ]),
    data_offsets: z.tuple([z.literal(0), z.literal(30236672)]),
  }),
});

type PotionTokenizer = {
  encode(
    text: string,
    options: { add_special_tokens: false },
  ): { ids: number[] };
};

// Tokenizers 0.2.0's extensionless declaration exports do not resolve in NodeNext.
// Keep its exercised API typed here until the upstream declarations are corrected.
const PotionTokenizerConstructor = Tokenizer as new (
  tokenizer: Record<string, unknown>,
  config: Record<string, unknown>,
) => PotionTokenizer;

type LoadedPotion = {
  tokenizer: PotionTokenizer;
  embeddings: Float32Array;
};

export class PotionModel {
  private model: Promise<LoadedPotion> | undefined;

  constructor(private readonly assetDirectory: string) {}

  async encode(texts: readonly string[]): Promise<number[][]> {
    this.model ??= this.load();
    const model = await this.model;
    const results: number[][] = [];
    for (const [index, text] of texts.entries()) {
      if (index > 0 && index % BatchSize === 0) {
        await throttle();
      }
      results.push(this.encodeText(model, text));
    }
    return results;
  }

  private async load(): Promise<LoadedPotion> {
    const readAsset = async (filename: PotionModelFilename) => {
      const data = await fs.readFile(path.join(this.assetDirectory, filename));
      validatePotionModelFile(filename, data);
      return data;
    };
    const [weights, tokenizerData, tokenizerConfigData, configData] =
      await Promise.all([
        readAsset('model.safetensors'),
        readAsset('tokenizer.json'),
        readAsset('tokenizer_config.json'),
        readAsset('config.json'),
      ]);

    z.object({
      model_type: z.literal('model2vec'),
      hidden_dim: z.literal(POTION_EMBEDDING_DIMENSIONS),
      normalize: z.literal(true),
    }).parse(JSON.parse(configData.toString('utf8')));

    const headerLength = Number(weights.readBigUInt64LE(0));
    const dataStart = 8 + headerLength;
    if (!Number.isSafeInteger(headerLength) || dataStart > weights.byteLength) {
      throw new Error('Potion tensor header exceeds the asset bounds');
    }
    const header = TensorHeader.parse(
      JSON.parse(weights.toString('utf8', 8, dataStart)),
    );
    const [start, end] = header.embeddings.data_offsets;
    const valueCount = VocabularySize * POTION_EMBEDDING_DIMENSIONS;
    if (
      end - start !== valueCount * Float32Array.BYTES_PER_ELEMENT ||
      dataStart + end !== weights.byteLength
    ) {
      throw new Error(
        'Potion tensor data does not match its declared dimensions',
      );
    }
    const embeddings = new Float32Array(valueCount);
    for (let index = 0; index < valueCount; index++) {
      embeddings[index] = weights.readFloatLE(dataStart + start + index * 4);
    }
    const jsonObject = z.record(z.string(), z.unknown());
    const tokenizer = new PotionTokenizerConstructor(
      jsonObject.parse(JSON.parse(tokenizerData.toString('utf8'))),
      jsonObject.parse(JSON.parse(tokenizerConfigData.toString('utf8'))),
    );
    return { tokenizer, embeddings };
  }

  private encodeText(model: LoadedPotion, text: string): number[] {
    // Model2Vec removes UNK after tokenization; other literal special tokens remain.
    const ids = model.tokenizer
      .encode(text, { add_special_tokens: false })
      .ids.filter((id) => id !== UnknownTokenId);
    const result = new Float32Array(POTION_EMBEDDING_DIMENSIONS);
    if (ids.length === 0) {
      return Array.from(result);
    }
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= VocabularySize) {
        throw new Error(`Potion tokenizer returned an invalid token ID: ${id}`);
      }
    }
    // Mean pooling and L2 normalization follow Model2Vec (see POTION-LICENSE).
    for (
      let dimension = 0;
      dimension < POTION_EMBEDDING_DIMENSIONS;
      dimension++
    ) {
      let sum = 0;
      for (const id of ids) {
        sum += model.embeddings[id * POTION_EMBEDDING_DIMENSIONS + dimension]!;
      }
      result[dimension] = sum / ids.length;
    }
    const norm = Math.sqrt(
      result.reduce((sum, value) => sum + value * value, 0),
    );
    return Array.from(result.map((value) => value / (norm + 1e-32)));
  }
}
