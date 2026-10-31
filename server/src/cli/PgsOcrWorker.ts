import { parseArgs } from 'node:util';
import { pgsToSrt } from '../services/subtitles/PgsToSrt.ts';

async function run() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      stream: { type: 'string' },
    },
  });
  if (
    !values.input ||
    !values.output ||
    !values.stream ||
    !/^\d+$/.test(values.stream)
  )
    throw new Error('Expected input, output and PGS stream index');
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  // The supervisor owns stdin. Its death must also stop native OCR work.
  process.stdin.once('end', () => controller.abort());
  process.stdin.resume();
  let lastPercent = -5;
  const result = await pgsToSrt({
    inputPath: values.input,
    outputPath: values.output,
    streamIndex: Number(values.stream),
    language: 'eng',
    signal: controller.signal,
    onReadProgress: (position, _bytes, size) => {
      const percent = Math.floor((position * 100) / size);
      if (percent >= lastPercent + 5) {
        lastPercent = percent;
        console.error(`Reading PGS: ${percent}%`);
      }
    },
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total)
        console.error(`OCR: ${done}/${total}`);
    },
  });
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
