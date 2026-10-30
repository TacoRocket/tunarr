import { FileStreamSource } from '../../../stream/types.ts';
import { FfmpegCommandGenerator } from '../FfmpegCommandGenerator.ts';
import {
  ExternalSubtitleStream,
  StillImageStream,
  SubtitleMethods,
} from '../MediaStream.ts';
import { SubtitlesInputSource } from '../input/SubtitlesInputSource.ts';
import { VideoInputSource } from '../input/VideoInputSource.ts';
import { FrameSize } from '../types.ts';
import { ComplexFilter } from './ComplexFilter.ts';
import { CreditSqueezeFilter } from './CreditSqueezeFilter.ts';
import { FilterChain } from './FilterChain.ts';

test('burned external text does not consume the credit background input index', () => {
  const video = VideoInputSource.withStream(
    new FileStreamSource('/program.mkv'),
    StillImageStream.create({ index: 0, frameSize: FrameSize.FHD }),
  );
  const background = VideoInputSource.withStream(
    new FileStreamSource('/background.png'),
    StillImageStream.create({ index: 0, frameSize: FrameSize.FHD }),
  );
  const subtitles = new SubtitlesInputSource(
    new FileStreamSource('/program.srt'),
    [new ExternalSubtitleStream('srt', SubtitleMethods.Burn)],
    SubtitleMethods.Burn,
  );
  const chain = new FilterChain();
  chain.creditSqueeze = new CreditSqueezeFilter(
    {
      backgroundImage: background.path,
      startSeconds: 8,
      sourceOffsetSeconds: 0,
    },
    FrameSize.FHD,
    undefined,
    false,
  );
  const filter = new ComplexFilter(
    video,
    null,
    subtitles,
    null,
    chain,
    background,
  );
  const args = new FfmpegCommandGenerator().generateArgs(
    video,
    null,
    null,
    subtitles,
    null,
    [filter],
    background,
  );
  const inputs = args.filter((_, index) => args[index - 1] === '-i');
  expect(inputs).toEqual(['/program.mkv', '/background.png']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  expect(graph).toContain('[1:0]format=rgba,hwupload');
  expect(graph).not.toContain('[2:0]');
});
