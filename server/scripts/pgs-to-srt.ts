import { parseArgs } from 'node:util';
import { pgsToSrt } from '../src/services/subtitles/PgsToSrt.ts';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    stream: { type: 'string' },
    language: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'pnpm exec tsx scripts/pgs-to-srt.ts --input <file.mkv> --stream <zero-based stream index> --language <eng> --output <new-file.srt>',
  );
} else {
  if (
    !values.input ||
    !values.output ||
    values.stream === undefined ||
    !/^\d+$/.test(values.stream) ||
    !values.language
  )
    throw new Error(
      'Specify --input, --stream, --language and --output; see --help',
    );
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  let reportedPercent = -5;
  console.error('Reading selected PGS stream...');
  const result = await pgsToSrt({
    inputPath: values.input,
    outputPath: values.output,
    streamIndex: Number(values.stream),
    language: values.language,
    signal: controller.signal,
    onReadProgress: (position, bytesRead, sourceSize) => {
      const percent = Math.floor((position / sourceSize) * 100);
      if (percent >= reportedPercent + 5) {
        reportedPercent = percent;
        console.error(
          `Read position ${percent}%; ${(bytesRead / 1048576).toFixed(1)} MiB read`,
        );
      }
    },
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total)
        console.error(`OCR ${done}/${total}`);
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
