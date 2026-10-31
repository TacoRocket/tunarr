import type { ContentBackedStreamLineupItem } from '@/db/derived_types/StreamLineup.ts';
import type { IChannelDB } from '@/db/interfaces/IChannelDB.ts';
import type {
  ISettingsDB,
  ReadableFfmpegSettings,
} from '@/db/interfaces/ISettingsDB.ts';
import type { ChannelOrm } from '@/db/schema/Channel.ts';
import type { TranscodeConfigOrm } from '@/db/schema/TranscodeConfig.ts';
import {
  AudioFormats,
  HlsDirectOutputFormat,
  HlsOutputFormat,
  MpegTsOutputFormat,
  MkvOutputFormat,
  VideoFormats,
  VideoPresets,
  defaultHlsOptions,
} from '@/ffmpeg/builder/constants.ts';
import type { PipelineBuilder } from '@/ffmpeg/builder/pipeline/PipelineBuilder.ts';
import type { PipelineBuilderFactory } from '@/ffmpeg/builder/pipeline/PipelineBuilderFactory.ts';
import { FrameState } from '@/ffmpeg/builder/state/FrameState.ts';
import { FrameSize } from '@/ffmpeg/builder/types.ts';
import {
  FfmpegState,
  type PipelineOptions,
} from '@/ffmpeg/builder/state/FfmpegState.ts';
import type { AudioInputSource } from '@/ffmpeg/builder/input/AudioInputSource.ts';
import type { FfmpegInfo, FfmpegVersionResult } from '@/ffmpeg/ffmpegInfo.ts';
import type { StreamSelector } from '@/ffmpeg/StreamSelector.ts';
import type { FeatureFlagService } from '@/services/FeatureFlagService.ts';
import type { StreamDetails, SubtitleStreamDetails } from '@/stream/types.ts';
import { FileStreamSource, HttpStreamSource } from '@/stream/types.ts';
import type { SubtitlesInputSource } from '@/ffmpeg/builder/input/SubtitlesInputSource.ts';
import type { VideoInputSource } from '@/ffmpeg/builder/input/VideoInputSource.ts';
import {
  StillImageStream,
  SubtitleMethods,
} from '@/ffmpeg/builder/MediaStream.ts';
import { InfiniteLoopInputOption } from '@/ffmpeg/builder/options/input/InfiniteLoopInputOption.ts';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import type { StreamDegradation } from '@tunarr/types';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import tmp from 'tmp-promise';
import { FfmpegStreamFactory } from './FfmpegStreamFactory.ts';

vi.mock('@/util/serverUtil.ts', () => ({
  makeLocalUrl: (path: string) => `http://localhost:8000${path}`,
}));

dayjs.extend(duration);

const mockFfmpegVersion: FfmpegVersionResult = {
  versionString: '7.0',
  majorVersion: 7,
  minorVersion: 0,
  patchVersion: 0,
  isUnknown: false,
};

function makeTranscodeConfig(
  overrides: Partial<TranscodeConfigOrm> = {},
): TranscodeConfigOrm {
  return {
    uuid: 'test-uuid',
    name: 'Test',
    threadCount: 0,
    hardwareAccelerationMode: 'none',
    vaapiDriver: 'system',
    vaapiDevice: null,
    resolution: { widthPx: 1920, heightPx: 1080 },
    videoFormat: 'h264',
    videoProfile: null,
    videoPreset: null,
    videoBitDepth: 8,
    videoBitRate: 2000,
    videoBufferSize: 4000,
    audioChannels: 2,
    audioFormat: 'aac',
    audioBitRate: 192,
    audioBufferSize: 384,
    audioSampleRate: 48,
    audioVolumePercent: 100,
    audioLoudnormConfig: null,
    normalizeFrameRate: false,
    deinterlaceVideo: true,
    disableChannelOverlay: false,
    errorScreen: 'pic',
    errorScreenAudio: 'silent',
    isDefault: true,
    disableHardwareDecoder: false,
    disableHardwareEncoding: false,
    disableHardwareFilters: false,
    ...overrides,
  } as TranscodeConfigOrm;
}

function makeChannel(overrides: Partial<ChannelOrm> = {}): ChannelOrm {
  return {
    uuid: 'channel-uuid',
    name: 'Test Channel',
    number: 1,
    streamMode: 'hls',
    subtitlesEnabled: false,
    offline: { mode: 'pic' },
    duration: 0,
    groupTitle: null,
    stealth: false,
    fillerCollections: [],
    fillerRepeatCooldownMs: 0,
    transcodeConfigId: null,
    icon: null,
    startTime: 0,
    ...overrides,
  } as ChannelOrm;
}

function makeFfmpegSettings(): ReadableFfmpegSettings {
  return {
    configVersion: 5,
    ffmpegExecutablePath: '/usr/bin/ffmpeg',
    ffprobeExecutablePath: '/usr/bin/ffprobe',
    enableLogging: false,
    enableFileLogging: false,
    logLevel: 'warning',
    languagePreferences: {
      preferences: [{ iso6391: 'en', iso6392: 'eng', displayName: 'English' }],
    },
    scalingAlgorithm: 'bicubic',
    deinterlaceFilter: 'none',
    hlsDirectOutputFormat: 'mpegts',
    enableSubtitleExtraction: false,
  } as ReadableFfmpegSettings;
}

function makeStreamDetails(): StreamDetails {
  return {
    duration: dayjs.duration({ seconds: 30 }),
    videoDetails: [
      {
        codec: 'h264',
        profile: 'Main',
        width: 1920,
        height: 1080,
        framerate: 24,
        pixelFormat: 'yuv420p',
        bitDepth: 8,
        streamIndex: 0,
        sampleAspectRatio: '1:1',
        displayAspectRatio: '16:9',
        anamorphic: false,
        bitrate: 5000,
        isAttachedPic: false,
        colorRange: null,
        colorSpace: null,
        colorTransfer: null,
        colorPrimaries: null,
      },
    ],
    audioDetails: [
      {
        codec: 'aac',
        channels: 2,
        index: 1,
      },
    ],
  };
}

function makeLineupItem(): ContentBackedStreamLineupItem {
  return {
    type: 'program',
    streamDuration: 30000,
    programBeginMs: 0,
    duration: 30000,
    infiniteLoop: false,
    program: {
      uuid: 'program-uuid',
      mediaSourceId: 'source-id',
      externalIds: [],
    },
  } as ContentBackedStreamLineupItem;
}

/**
 * Creates a mock PipelineBuilderFactory that intercepts PipelineBuilder.build()
 * to capture the FrameState for assertion.
 */
function createCapturingPipelineBuilderFactory(
  pipelineDegradations: StreamDegradation[] = [],
): {
  factory: PipelineBuilderFactory;
  getCapturedFrameState: () => FrameState | undefined;
  getCapturedFfmpegState: () => FfmpegState | undefined;
  getCapturedHwAccel: () => string | undefined;
  getCapturedSubtitleInput: () => SubtitlesInputSource | null | undefined;
  getCapturedVideoInput: () => VideoInputSource | undefined;
  getCapturedAudioInput: () => AudioInputSource | null | undefined;
  getCapturedPipelineOptions: () => PipelineOptions | undefined;
} {
  let capturedFrameState: FrameState | undefined;
  let capturedFfmpegState: FfmpegState | undefined;
  let capturedHwAccel: string | undefined;
  let capturedSubtitleInput: SubtitlesInputSource | null | undefined;
  let capturedVideoInput: VideoInputSource | undefined;
  let capturedAudioInput: AudioInputSource | null | undefined;
  let capturedPipelineOptions: PipelineOptions | undefined;

  const factory: PipelineBuilderFactory = () => {
    const builderProxy: Record<string, unknown> = {};
    for (const method of ['setWatermarkInputSource', 'setConcatInputSource']) {
      builderProxy[method] = vi.fn().mockReturnValue(builderProxy);
    }

    builderProxy.setAudioInputSource = vi.fn(
      (input: AudioInputSource | null) => {
        capturedAudioInput = input;
        return builderProxy;
      },
    );

    builderProxy.setVideoInputSource = vi.fn((input: VideoInputSource) => {
      capturedVideoInput = input;
      return builderProxy;
    });

    builderProxy.setSubtitleInputSource = vi.fn(
      (input: SubtitlesInputSource | null) => {
        capturedSubtitleInput = input;
        return builderProxy;
      },
    );

    builderProxy.setHardwareAccelerationMode = vi.fn((mode: string) => {
      capturedHwAccel = mode;
      return builderProxy;
    });

    builderProxy.build = vi.fn().mockResolvedValue({
      build: (
        ffmpegState: FfmpegState,
        frameState: FrameState,
        options: PipelineOptions,
      ) => {
        capturedPipelineOptions = options;
        capturedFfmpegState = ffmpegState;
        capturedFrameState = frameState;
        return {
          getCommandArgs: () => [],
          getCommandEnvironment: () => ({}),
          inputs: {},
          steps: [],
          setInputs: vi.fn(),
          degradations: pipelineDegradations,
        };
      },
    } as unknown as PipelineBuilder);

    return builderProxy as ReturnType<PipelineBuilderFactory>;
  };

  return {
    factory,
    getCapturedFrameState: () => capturedFrameState,
    getCapturedFfmpegState: () => capturedFfmpegState,
    getCapturedHwAccel: () => capturedHwAccel,
    getCapturedSubtitleInput: () => capturedSubtitleInput,
    getCapturedVideoInput: () => capturedVideoInput,
    getCapturedAudioInput: () => capturedAudioInput,
    getCapturedPipelineOptions: () => capturedPipelineOptions,
  };
}

function makeMockFfmpegInfo(): FfmpegInfo {
  return {
    getVersion: vi.fn().mockResolvedValue(mockFfmpegVersion),
  } as unknown as FfmpegInfo;
}

function makeMockSettingsDB(
  ffmpegSettings: ReadableFfmpegSettings,
): ISettingsDB {
  return {
    systemSettings: vi.fn().mockReturnValue({
      logging: { logsDirectory: null },
    }),
    ffmpegSettings: vi.fn().mockReturnValue(ffmpegSettings),
  } as unknown as ISettingsDB;
}

function makeMockChannelDB(): IChannelDB {
  return {
    getChannelSubtitlePreferences: vi.fn().mockResolvedValue([]),
  } as unknown as IChannelDB;
}

function makeMockFeatureFlagService(
  flags: Record<string, boolean> = {},
): FeatureFlagService {
  return {
    get: vi.fn((flag: string) => flags[flag] ?? false),
    getAll: vi.fn().mockReturnValue(flags),
  } as unknown as FeatureFlagService;
}

function makeMockStreamSelector(
  subtitleStream: SubtitleStreamDetails | null = null,
  unextractedSubtitle?: SubtitleStreamDetails,
): StreamSelector {
  return {
    selectAudioAndSubtitleStreams: vi.fn().mockImplementation(async () => ({
      audioStream: { index: 1, codec: 'aac', channels: 2 },
      subtitleStream,
      unextractedSubtitle,
    })),
  } as unknown as StreamSelector;
}

describe('FfmpegStreamFactory', () => {
  describe('credit squeeze setup fallback', () => {
    test.each(['missing background', 'unsupported concat'] as const)(
      '%s keeps the remaining program full-screen with unchanged audio and duration',
      async (failure) => {
        const fixture = await tmp.dir({ unsafeCleanup: true });
        onTestFinished(() => fixture.cleanup());
        const backgroundImage = path.join(fixture.path, 'background.png');
        if (failure === 'unsupported concat') {
          await writeFile(
            backgroundImage,
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j56kAAAAASUVORK5CYII=',
              'base64',
            ),
          );
        }
        const supportsConcat = vi.fn().mockResolvedValue(false);
        const ffmpegInfo = Object.assign(makeMockFfmpegInfo(), {
          supportsTimestampPreservingConcat: supportsConcat,
        });
        const capturing = createCapturingPipelineBuilderFactory();
        const config = makeTranscodeConfig({
          hardwareAccelerationMode: 'vaapi',
        });
        const details = makeStreamDetails();
        details.chapters = [
          {
            index: 0,
            chapterType: 'outro',
            isFinal: true,
            startTime: 20000,
            endTime: 30000,
          },
        ];
        const lineupItem = makeLineupItem();
        lineupItem.program.duration = 30000;
        const options = {
          startTime: dayjs.duration({ seconds: 5 }),
          duration: dayjs.duration({ seconds: 25 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 90000,
          realtime: true,
          streamMode: 'hls' as const,
        };
        const createSession = (enabled: boolean) =>
          new FfmpegStreamFactory(
            ffmpegInfo,
            makeMockSettingsDB(makeFfmpegSettings()),
            capturing.factory,
            makeMockChannelDB(),
            makeMockFeatureFlagService(),
            makeMockStreamSelector(),
            config,
            makeChannel({ creditSqueeze: { enabled, backgroundImage } }),
          ).createStreamSession({
            stream: {
              source: new HttpStreamSource('http://example.com/video.ts'),
              details,
            },
            options,
            lineupItem,
          });

        await createSession(false);
        const normalAudio = capturing.getCapturedAudioInput();
        const normalState = capturing.getCapturedFfmpegState();
        const result = await createSession(true);

        expect(capturing.getCapturedPipelineOptions()).toBeDefined();
        expect(
          capturing.getCapturedPipelineOptions()?.creditSqueeze,
        ).toBeUndefined();
        expect(capturing.getCapturedFfmpegState()).toEqual(normalState);
        expect(
          capturing.getCapturedFfmpegState()?.start?.asMilliseconds(),
        ).toBe(5000);
        expect(
          capturing.getCapturedFfmpegState()?.duration?.asMilliseconds(),
        ).toBe(25000);
        expect(capturing.getCapturedAudioInput()).toEqual(normalAudio);
        expect(
          capturing.getCapturedAudioInput()?.desiredState.audioDuration,
        ).toBe(25000);
        expect(result?.session.degradations).toEqual([
          {
            code: 'credit_squeeze_unavailable',
            message: expect.stringContaining(
              failure === 'missing background'
                ? 'ENOENT'
                : 'FFmpeg lacks concat preserve_ts support.',
            ),
            firstSeen: expect.any(Number),
          },
        ]);
        expect(supportsConcat).toHaveBeenCalledTimes(
          failure === 'missing background' ? 0 : 1,
        );
      },
    );
  });

  describe('videoPreset wiring into FrameState', () => {
    test('createStreamSession passes videoPreset=veryfast for software h264', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('createStreamSession passes videoPreset=veryfast for software hevc', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'hevc',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBe(VideoPresets.VeryFast);
    });

    test('createStreamSession does not set videoPreset for hardware-accelerated encoding', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'cuda',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (error) wires videoPreset into FrameState', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
        errorScreen: 'testsrc',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'error',
        title: 'Test Error',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
        realtime: true,
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      // calculateForErrorStream doesn't compute a videoPreset, so it should be null
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (offline) wires videoPreset into FrameState', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFrameState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = makeFfmpegSettings();
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'offline',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
      });

      const frameState = getCapturedFrameState();
      expect(frameState).toBeDefined();
      // calculateForErrorStream (used by offline) doesn't set videoPreset
      expect(frameState!.videoPreset).toBeNull();
    });

    test('createPlaceholderSession (offline) applies software deinterlace + scaling filters', async () => {
      const config = makeTranscodeConfig({
        hardwareAccelerationMode: 'none',
        videoFormat: 'h264',
      });
      const { factory, getCapturedFfmpegState } =
        createCapturingPipelineBuilderFactory();

      const ffmpegSettings = {
        ...makeFfmpegSettings(),
        deinterlaceFilter: 'yadif=0',
        scalingAlgorithm: 'lanczos',
      };
      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(ffmpegSettings),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      await sut.createPlaceholderSession({
        kind: 'offline',
        duration: dayjs.duration({ seconds: 10 }),
        outputFormat: MpegTsOutputFormat,
      });

      const ffmpegState = getCapturedFfmpegState();
      expect(ffmpegState).toBeDefined();
      // Mirrors the error session: reuse the configured ffmpegSettings,
      // not the FfmpegState class defaults.
      expect(ffmpegState!.softwareDeinterlaceFilter).toBe('yadif=0');
      expect(ffmpegState!.softwareScalingAlgorithm).toBe('lanczos');
    });
  });

  describe('passthrough mode (HlsDirectV2 / remux)', () => {
    const hlsDirectV2Format = HlsDirectOutputFormat(defaultHlsOptions);

    function createPassthroughSut(
      configOverrides: Partial<TranscodeConfigOrm> = {},
      streamDetails?: StreamDetails,
    ) {
      const config = makeTranscodeConfig(configOverrides);
      const capturing = createCapturingPipelineBuilderFactory();

      const sut = new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        capturing.factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        config,
        makeChannel(),
      );

      return {
        sut,
        ...capturing,
        streamDetails: streamDetails ?? makeStreamDetails(),
      };
    }

    test('HlsDirectV2 does not crash (playbackParams is null)', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedFrameState()).toBeDefined();
    });

    test('remux mode does not crash (playbackParams is null)', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: MpegTsOutputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
          encoding: { mode: 'remux' },
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedFrameState()).toBeDefined();
    });

    test('HlsDirectV2 sets passthrough defaults in FrameState', async () => {
      const { sut, getCapturedFrameState, streamDetails } =
        createPassthroughSut();

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState()!;
      expect(frameState.videoFormat).toBe(VideoFormats.Copy);
      // videoPreset falls back to DefaultFrameState (null) because lodash
      // merge skips the undefined value passed in passthrough mode.
      expect(frameState.videoPreset).toBeNull();
      expect(frameState.deinterlace).toBe(false);
      expect(frameState.videoBitrate).toBeNull();
      expect(frameState.videoBufferSize).toBeNull();
      expect(frameState.frameRate).toBeNull();
      expect(frameState.videoTrackTimescale).toBe(90000);
    });

    test('passthrough forces hardware acceleration to none', async () => {
      const { sut, getCapturedHwAccel, streamDetails } = createPassthroughSut({
        hardwareAccelerationMode: 'cuda',
      });

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(getCapturedHwAccel()).toBe('none');
    });

    test('passthrough sets copyAllStreams and zeroes threadCount in FfmpegState', async () => {
      const { sut, getCapturedFfmpegState, streamDetails } =
        createPassthroughSut({ threadCount: 4 });

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: streamDetails,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const ffmpegState = getCapturedFfmpegState()!;
      expect(ffmpegState.copyAllStreams).toBe(true);
      expect(ffmpegState.threadCount).toBe(0);
      expect(ffmpegState.vaapiDevice).toBeNull();
      expect(ffmpegState.vaapiDriver).toBeNull();
      // lodash merge skips undefined, so FfmpegState class defaults are kept.
      expect(ffmpegState.softwareDeinterlaceFilter).toBe('yadif=1');
      expect(ffmpegState.softwareScalingAlgorithm).toBe('fast_bilinear');
    });

    test.each([
      hlsDirectV2Format,
      HlsOutputFormat(defaultHlsOptions),
      MkvOutputFormat,
    ])(
      'passthrough preserves audio indexes and limits FLAC conversion to HLS ($type)',
      async (outputFormat) => {
        const details = makeStreamDetails();
        details.audioDetails = [
          { codec: AudioFormats.Aac, channels: 2, index: 1 },
          { codec: AudioFormats.Dca, channels: 6, index: 2 },
          { codec: AudioFormats.TrueHd, channels: 8, index: 3 },
          { codec: AudioFormats.Flac, channels: 2, index: 4 },
          { codec: AudioFormats.Flac, channels: 6, index: 5 },
        ];

        const { sut, getCapturedFfmpegState } = createPassthroughSut(
          {},
          details,
        );

        await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
            encoding: { mode: 'remux' },
          },
          lineupItem: makeLineupItem(),
        });

        const ffmpegState = getCapturedFfmpegState()!;
        expect(ffmpegState.audioCodecOverrides).toEqual([
          { outputIndex: 1, codec: AudioFormats.Ac3 },
          { outputIndex: 2, codec: AudioFormats.Ac3 },
          ...(outputFormat.type === 'mkv'
            ? []
            : [
                { outputIndex: 3, codec: AudioFormats.Ac3, bitrateKbps: 192 },
                { outputIndex: 4, codec: AudioFormats.Ac3, bitrateKbps: 640 },
              ]),
        ]);
      },
    );

    test('FLAC above six channels retains the explicit-decision refusal', async () => {
      const details = makeStreamDetails();
      details.audioDetails = [
        { codec: AudioFormats.Flac, channels: 8, index: 1 },
      ];
      const { sut } = createPassthroughSut({}, details);
      await expect(
        sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.mkv'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        }),
      ).rejects.toThrow(
        'FLAC with more than six channels requires an explicit audio decision',
      );
    });

    test('passthrough uses source video dimensions for FrameState sizes', async () => {
      const details = makeStreamDetails();
      details.videoDetails = [
        {
          ...details.videoDetails![0],
          width: 3840,
          height: 2160,
        },
      ];

      const { sut, getCapturedFrameState } = createPassthroughSut(
        { resolution: { widthPx: 1920, heightPx: 1080 } },
        details,
      );

      await sut.createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: hlsDirectV2Format,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      const frameState = getCapturedFrameState()!;
      // In passthrough, scaled/padded sizes come from the source, not the
      // transcode config resolution (1920x1080).
      expect(frameState.scaledSize.width).toBe(3840);
      expect(frameState.scaledSize.height).toBe(2160);
      expect(frameState.paddedSize.width).toBe(3840);
      expect(frameState.paddedSize.height).toBe(2160);
    });
  });

  describe('audio renditions', () => {
    function makeMultiAudioStreamDetails(
      defaults: [boolean, boolean] = [false, false],
    ): StreamDetails {
      return {
        ...makeStreamDetails(),
        audioDetails: [
          {
            codec: 'aac',
            channels: 2,
            index: 1,
            language: 'Japanese',
            languageCodeISO6392: 'jpn',
            default: defaults[0],
          },
          {
            codec: 'aac',
            channels: 2,
            index: 2,
            language: 'English',
            languageCodeISO6392: 'eng',
            default: defaults[1],
          },
        ],
      };
    }

    function makeSut() {
      return new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        createCapturingPipelineBuilderFactory().factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        makeTranscodeConfig(),
        makeChannel(),
      );
    }

    test('transcode mode advertises no audio renditions', async () => {
      const result = await makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeMultiAudioStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: HlsOutputFormat(defaultHlsOptions),
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
        },
        lineupItem: makeLineupItem(),
      });

      expect(result?.renditions.audio).toEqual([]);
    });

    test('passthrough mode advertises every source audio track', async () => {
      const result = await makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details: makeMultiAudioStreamDetails(),
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls_direct_v2',
        },
        lineupItem: makeLineupItem(),
      });

      expect(result?.renditions.audio.map((r) => r.language)).toEqual([
        'jpn',
        'eng',
      ]);
    });

    function createPassthroughSession(details: StreamDetails) {
      return makeSut().createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/video.ts'),
          details,
        },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat: HlsDirectOutputFormat(defaultHlsOptions),
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls_direct_v2',
        },
        lineupItem: makeLineupItem(),
      });
    }

    test('passthrough mode defaults to the first track when none is flagged', async () => {
      const result = await createPassthroughSession(
        makeMultiAudioStreamDetails(),
      );

      expect(result?.renditions.audio.map((r) => r.default)).toEqual([
        true,
        false,
      ]);
    });

    test('passthrough mode defaults only to the source-flagged track', async () => {
      const result = await createPassthroughSession(
        makeMultiAudioStreamDetails([false, true]),
      );

      expect(result?.renditions.audio.map((r) => r.default)).toEqual([
        false,
        true,
      ]);
    });

    test('passthrough mode marks one default when several tracks are flagged', async () => {
      const result = await createPassthroughSession(
        makeMultiAudioStreamDetails([true, true]),
      );

      expect(result?.renditions.audio.map((r) => r.default)).toEqual([
        true,
        false,
      ]);
    });
  });

  describe('audio-only programs', () => {
    function makeAudioOnlyStreamDetails(
      placeholderImage?: HttpStreamSource,
    ): StreamDetails {
      return {
        ...makeStreamDetails(),
        videoDetails: undefined,
        audioOnly: true,
        placeholderImage,
      };
    }

    function makeSut(factory: PipelineBuilderFactory) {
      return new FfmpegStreamFactory(
        makeMockFfmpegInfo(),
        makeMockSettingsDB(makeFfmpegSettings()),
        factory,
        makeMockChannelDB(),
        makeMockFeatureFlagService(),
        makeMockStreamSelector(),
        makeTranscodeConfig(),
        makeChannel(),
      );
    }

    const options = {
      startTime: dayjs.duration(0),
      duration: dayjs.duration({ seconds: 30 }),
      outputFormat: HlsOutputFormat(defaultHlsOptions),
      ptsOffset: 0,
      realtime: true,
      streamMode: 'hls',
    } as const;

    test('loops the placeholder image as the video input', async () => {
      const { factory, getCapturedVideoInput } =
        createCapturingPipelineBuilderFactory();
      const placeholder = new HttpStreamSource(
        'http://localhost:8000/images/generic-music-screen.png',
      );

      const result = await makeSut(factory).createStreamSession({
        stream: {
          source: new HttpStreamSource('http://example.com/track.flac'),
          details: makeAudioOnlyStreamDetails(placeholder),
        },
        options,
        lineupItem: makeLineupItem(),
      });

      expect(result).not.toBeNull();
      const videoInput = getCapturedVideoInput();
      expect(videoInput?.source).toBe(placeholder);
      expect(videoInput?.streams[0]).toBeInstanceOf(StillImageStream);
      expect(videoInput?.hasInputOption(InfiniteLoopInputOption)).toBe(true);
    });

    test('rejects an audio-only stream without a placeholder image', async () => {
      const { factory } = createCapturingPipelineBuilderFactory();

      await expect(
        makeSut(factory).createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/track.flac'),
            details: makeAudioOnlyStreamDetails(),
          },
          options,
          lineupItem: makeLineupItem(),
        }),
      ).rejects.toThrow('Streams with no video are not currently supported.');
    });
  });

  describe('subtitle handling', () => {
    const textSubtitleStream: SubtitleStreamDetails = {
      type: 'embedded',
      codec: 'subrip',
      index: 2,
      default: true,
      forced: false,
      sdh: false,
      language: 'English',
      languageCodeISO6392: 'eng',
      title: 'English SRT',
    };

    const imageSubtitleStream: SubtitleStreamDetails = {
      type: 'embedded',
      codec: 'hdmv_pgs_subtitle',
      index: 3,
      default: false,
      forced: false,
      sdh: false,
      language: 'English',
      languageCodeISO6392: 'eng',
      title: 'English PGS',
    };

    const externalSubtitleStream: SubtitleStreamDetails = {
      type: 'external',
      codec: 'subrip',
      default: false,
      forced: false,
      sdh: false,
      language: 'Spanish',
      languageCodeISO6392: 'spa',
      path: 'http://example.com/subs.srt',
      title: 'Spanish SRT',
    };

    describe('non-passthrough modes (HLS, mpegts, etc.)', () => {
      test('uses sidecar (Convert) when webvttSidecarEnabled and text-based subtitle', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        expect(result!.renditions.subtitle).toEqual({
          language: 'eng',
          languageName: 'English',
          default: true,
          forced: false,
          title: 'English SRT',
        });
      });

      test('uses burn-in when webvttSidecarEnabled is false', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: false }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Burn);
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('falls back to burn-in for image-based subtitles even when sidecar enabled', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(imageSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Burn);
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('skips subtitles when channel.subtitlesEnabled is false', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(textSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: false }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      describe('unextracted subtitle track (#68)', () => {
        const createSession = (
          channel: ReturnType<typeof makeChannel>,
          pipelineDegradations: StreamDegradation[] = [],
        ) =>
          new FfmpegStreamFactory(
            makeMockFfmpegInfo(),
            makeMockSettingsDB(makeFfmpegSettings()),
            createCapturingPipelineBuilderFactory(pipelineDegradations).factory,
            makeMockChannelDB(),
            makeMockFeatureFlagService(),
            makeMockStreamSelector(null, textSubtitleStream),
            makeTranscodeConfig(),
            channel,
          ).createStreamSession({
            stream: {
              source: new HttpStreamSource('http://example.com/video.ts'),
              details: makeStreamDetails(),
            },
            options: {
              startTime: dayjs.duration(0),
              duration: dayjs.duration({ seconds: 30 }),
              outputFormat: { type: 'mpegts' as const },
              ptsOffset: 0,
              realtime: true,
              streamMode: 'hls',
            },
            lineupItem: makeLineupItem(),
          });

        test("is reported on the transcode with the builder's degradations", async () => {
          const crt = {
            code: 'crt_hdr_bypassed',
            message: 'hdr',
            firstSeen: 1,
          } as const;

          const result = await createSession(
            makeChannel({ subtitlesEnabled: true }),
            [crt],
          );

          expect(result!.session.degradations).toEqual([
            {
              code: 'subtitle_not_extracted',
              message:
                'Subtitle track 2 (English, "English SRT") hasn\'t been extracted, so it can\'t be shown; no subtitles are shown.',
              firstSeen: expect.any(Number),
            },
            crt,
          ]);
        });

        test('is not reported when the channel has subtitles off', async () => {
          const result = await createSession(
            makeChannel({ subtitlesEnabled: false }),
          );

          expect(result!.session.degradations).toEqual([]);
        });
      });

      test('skips subtitles when stream selector returns no subtitle', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(null),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
      });

      test('handles external subtitle streams with sidecar', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(externalSubtitleStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        expect(result!.renditions.subtitle).toEqual({
          language: 'spa',
          languageName: 'Spanish',
          default: false,
          forced: false,
          title: 'Spanish SRT',
        });
      });

      test('extracted embedded subtitle uses stream index 0, not the original container index', async () => {
        // Simulates the bug from issue #1904: an embedded subtitle at index 2
        // in the source MKV is extracted to a standalone .srt file. The stream
        // selector returns it with type still set to 'embedded' and the
        // original container index. The pipeline should treat this as external
        // (index 0) since the .srt only has one stream, but without the fix it
        // creates an EmbeddedSubtitleStream with index 2, producing the wrong
        // ffmpeg map (e.g. -map 2:2 instead of -map 2:0).
        const extractedEmbeddedStream: SubtitleStreamDetails = {
          type: 'embedded',
          codec: 'subrip',
          index: 2,
          default: true,
          forced: false,
          sdh: false,
          language: 'English',
          languageCodeISO6392: 'eng',
          title: 'English SRT',
          // Path is a local file, different from the video source — this means
          // the subtitle has been extracted and is no longer embedded.
          path: '/tmp/cache/subtitles/ab/cd/abcdef1234.srt',
        };

        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService({ webvttSidecarEnabled: true }),
          makeMockStreamSelector(extractedEmbeddedStream),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details: makeStreamDetails(),
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: { type: 'mpegts' as const },
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        // The subtitle source path should be the extracted file, not the video
        expect(subtitleInput!.path).toBe(
          '/tmp/cache/subtitles/ab/cd/abcdef1234.srt',
        );
        // Critical: the stream must be treated as external with index 0, since
        // the standalone .srt only has one stream. Using the original container
        // index (2) would produce -map 2:2 which matches nothing.
        const stream = subtitleInput!.streams[0];
        expect(stream.inputKind).toBe('external');
        expect(stream.index).toBe(0);
      });
    });

    describe('passthrough mode (remux / HlsDirectV2)', () => {
      const hlsDirectV2Format = HlsDirectOutputFormat(defaultHlsOptions);

      test('uses sidecar (Convert) for text-based subtitles', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();
        const details = makeStreamDetails();
        details.subtitleDetails = [textSubtitleStream];

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService(),
          makeMockStreamSelector(),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).not.toBeNull();
        expect(subtitleInput!.method).toBe(SubtitleMethods.Convert);
        expect(result?.session.degradations).toEqual([]);
        expect(result!.renditions.subtitle).toEqual({
          language: 'eng',
          languageName: 'English',
          default: true,
          forced: false,
          title: 'English SRT',
        });
      });

      test('reports the selected image subtitle omitted by passthrough (#102)', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();
        const details = makeStreamDetails();
        details.subtitleDetails = [imageSubtitleStream];

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService(),
          makeMockStreamSelector(),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
        expect(result?.session.degradations).toEqual([
          {
            code: 'subtitle_passthrough_unsupported',
            message:
              'Subtitle track 3 (English, "English PGS") cannot be shown while video is passed through; no subtitles are shown.',
            firstSeen: expect.any(Number),
          },
        ]);
      });

      test('skips subtitles when channel.subtitlesEnabled is false', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();
        const details = makeStreamDetails();
        details.subtitleDetails = [textSubtitleStream];

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService(),
          makeMockStreamSelector(),
          config,
          makeChannel({ subtitlesEnabled: false }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
        expect(result?.session.degradations).toEqual([]);
      });

      test('skips subtitles when no subtitle details in stream', async () => {
        const config = makeTranscodeConfig();
        const capturing = createCapturingPipelineBuilderFactory();
        const details = makeStreamDetails();
        // No subtitleDetails set

        const sut = new FfmpegStreamFactory(
          makeMockFfmpegInfo(),
          makeMockSettingsDB(makeFfmpegSettings()),
          capturing.factory,
          makeMockChannelDB(),
          makeMockFeatureFlagService(),
          makeMockStreamSelector(),
          config,
          makeChannel({ subtitlesEnabled: true }),
        );

        const result = await sut.createStreamSession({
          stream: {
            source: new HttpStreamSource('http://example.com/video.ts'),
            details,
          },
          options: {
            startTime: dayjs.duration(0),
            duration: dayjs.duration({ seconds: 30 }),
            outputFormat: hlsDirectV2Format,
            ptsOffset: 0,
            realtime: true,
            streamMode: 'hls',
          },
          lineupItem: makeLineupItem(),
        });

        const subtitleInput = capturing.getCapturedSubtitleInput();
        expect(subtitleInput).toBeNull();
        expect(result!.renditions.subtitle).toBeUndefined();
        expect(result?.session.degradations).toEqual([]);
      });
    });
  });
});

describe('FfmpegStreamFactory source probes', () => {
  const pgsTrack: SubtitleStreamDetails = {
    type: 'embedded',
    codec: 'hdmv_pgs_subtitle',
    index: 3,
    default: false,
    forced: false,
    sdh: false,
    language: 'English',
    languageCodeISO6392: 'eng',
  };
  const localFile = new FileStreamSource('/media/movie.mkv');
  const remoteFile = new HttpStreamSource('http://plex.local/movie.mkv');
  // A fresh object: FfmpegState.create can rewrite the shared
  // MpegTsOutputFormat (#91).
  const mpegts = () => ({ type: 'mpegts' }) as const;

  function makeSut(
    configOverrides: Partial<TranscodeConfigOrm> = {},
    subtitleStream: SubtitleStreamDetails | null = null,
  ) {
    const capturing = createCapturingPipelineBuilderFactory();
    const sut = new FfmpegStreamFactory(
      makeMockFfmpegInfo(),
      makeMockSettingsDB(makeFfmpegSettings()),
      capturing.factory,
      makeMockChannelDB(),
      makeMockFeatureFlagService(),
      makeMockStreamSelector(subtitleStream),
      makeTranscodeConfig(configOverrides),
      makeChannel({ subtitlesEnabled: true }),
    );
    const probes = {
      hlsCopyBandwidth: vi.fn().mockResolvedValue(26_261_316),
      pgsCanvas: vi.fn().mockResolvedValue(FrameSize.FHD),
    };
    (sut as unknown as { sourceProbes: typeof probes }).sourceProbes = probes;
    const play = (
      source: FileStreamSource | HttpStreamSource,
      outputFormat: Parameters<
        FfmpegStreamFactory['createStreamSession']
      >[0]['options']['outputFormat'],
      encoding?: { mode: 'remux' },
    ) =>
      sut.createStreamSession({
        stream: { source, details: makeStreamDetails() },
        options: {
          startTime: dayjs.duration(0),
          duration: dayjs.duration({ seconds: 30 }),
          outputFormat,
          ptsOffset: 0,
          realtime: true,
          streamMode: 'hls',
          encoding,
        },
        lineupItem: makeLineupItem(),
      });
    return { probes, play, ...capturing };
  }

  test('labels a local HLS stream copy with the probed bandwidth', async () => {
    const { probes, play, getCapturedFfmpegState } = makeSut();
    await play(localFile, HlsDirectOutputFormat(defaultHlsOptions));

    expect(probes.hlsCopyBandwidth).toHaveBeenCalledWith('/media/movie.mkv');
    expect(getCapturedFfmpegState()?.hlsCopyBandwidthBps).toBe(26_261_316);
  });

  test('does not probe bandwidth for remote files, MPEG-TS copies or transcodes', async () => {
    const { probes, play } = makeSut();
    await play(remoteFile, HlsDirectOutputFormat(defaultHlsOptions));
    await play(localFile, mpegts(), { mode: 'remux' });
    await play(localFile, mpegts());
    await play(localFile, HlsOutputFormat(defaultHlsOptions));

    expect(probes.hlsCopyBandwidth).not.toHaveBeenCalled();
  });

  test('probes the canvas of a PGS track burned in on VAAPI', async () => {
    const { probes, play, getCapturedSubtitleInput } = makeSut(
      { hardwareAccelerationMode: 'vaapi' },
      pgsTrack,
    );
    await play(localFile, mpegts());

    expect(probes.pgsCanvas).toHaveBeenCalledWith('/media/movie.mkv', 3);
    expect(getCapturedSubtitleInput()?.streams[0]?.canvasSize).toBe(
      FrameSize.FHD,
    );
  });

  test('does not probe the PGS canvas off VAAPI, for remote files, or with hardware filters off', async () => {
    const software = makeSut({ hardwareAccelerationMode: 'none' }, pgsTrack);
    await software.play(localFile, mpegts());
    const remote = makeSut({ hardwareAccelerationMode: 'vaapi' }, pgsTrack);
    await remote.play(remoteFile, mpegts());
    const filtersOff = makeSut(
      { hardwareAccelerationMode: 'vaapi', disableHardwareFilters: true },
      pgsTrack,
    );
    await filtersOff.play(localFile, mpegts());
    const textTrack = makeSut(
      { hardwareAccelerationMode: 'vaapi' },
      { ...pgsTrack, codec: 'subrip' },
    );
    await textTrack.play(localFile, mpegts());

    for (const { probes } of [software, remote, filtersOff, textTrack]) {
      expect(probes.pgsCanvas).not.toHaveBeenCalled();
    }
  });
});
