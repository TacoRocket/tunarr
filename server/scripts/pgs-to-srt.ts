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
  const result = await pgsToSrt({
    inputPath: values.input,
    outputPath: values.output,
    streamIndex: Number(values.stream),
    language: values.language,
    signal: controller.signal,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total)
        console.error(`OCR ${done}/${total}`);
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
