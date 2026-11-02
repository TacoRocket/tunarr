import fs from 'node:fs/promises';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  POTION_MODEL_ID,
  POTION_MODEL_REVISION,
  potionModelFiles,
  validatePotionModelFile,
} from '../src/services/search/potionModelManifest.ts';
import type { PotionModelFilename } from '../src/services/search/potionModelManifest.ts';

export async function downloadPotion(targetDirectory = './bin/potion') {
  await fs.mkdir(targetDirectory, { recursive: true });
  const filenames = Object.keys(potionModelFiles) as PotionModelFilename[];
  for (const assetName of filenames) {
    const response = await fetch(
      `https://huggingface.co/${POTION_MODEL_ID}/resolve/${POTION_MODEL_REVISION}/${assetName}`,
    );
    if (!response.ok) {
      throw new Error(
        `Could not download Potion ${assetName}: HTTP ${response.status}`,
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    validatePotionModelFile(assetName, data);
    const destination = path.join(targetDirectory, assetName);
    const temporaryPath = `${destination}.download`;
    await fs.writeFile(temporaryPath, data);
    await fs.rename(temporaryPath, destination);
    console.log(`Downloaded verified Potion asset: ${assetName}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const args = await yargs(hideBin(process.argv))
    .scriptName('download-potion')
    .option('output', { type: 'string', default: './bin/potion' })
    .parseAsync();
  await downloadPotion(args.output);
}
