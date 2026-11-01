import {
  parseNativeNv12Support,
  parseVideoDecoderNames,
} from './ffmpegInfo.ts';

const decodersOutput = `Decoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V..... libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)
 V....D libaom-av1           libaom AV1 (codec av1)
 V....D av1                  Alliance for Open Media AV1
 V..... av1_cuvid            Nvidia CUVID AV1 decoder (codec av1)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... srt                  SubRip subtitle
`;

describe('parseVideoDecoderNames', () => {
  test('returns only video decoder names', () => {
    expect(parseVideoDecoderNames(decodersOutput)).toEqual([
      'h264',
      'libdav1d',
      'libaom-av1',
      'av1',
      'av1_cuvid',
    ]);
  });

  test('returns nothing for empty output', () => {
    expect(parseVideoDecoderNames('')).toEqual([]);
  });
});

// libplacebo also has a lut_type=native value, unrelated to NV12 output.
test('native LUT support does not advertise the native NV12 output mode', () => {
  const matchOnly = `   lut_type          <int>        ..FV....... Application mode of the custom LUT
     auto            0            ..FV.......
     native          1            ..FV.......
   nv12_output       <int>        ..FV....... Direct NV12 output (from 0 to 1)
     off             0            ..FV....... Normal output
     match           1            ..FV....... One pass
   dither_temporal    <boolean>    ..FV.....T. Enable temporal dithering
`;
  expect(parseNativeNv12Support(matchOnly)).toBe(false);
  expect(
    parseNativeNv12Support(
      matchOnly.replace(
        '   dither_temporal',
        "     native          2            ..FV....... libplacebo's own NV12 output\n   dither_temporal",
      ),
    ),
  ).toBe(true);
});
