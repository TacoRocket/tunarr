import { VideoFormats } from '../constants.ts';
import {
  PixelFormatYuv420P,
  PixelFormatYuv420P10Le,
} from '../format/PixelFormat.ts';
import { RateControlMode } from '../types.ts';
import {
  VaapiEntrypoint,
  VaapiHardwareCapabilities,
  VaapiProfileEntrypoint,
  VaapiProfiles,
} from './VaapiHardwareCapabilities.ts';

describe('VaapiHardwareCapabilities', () => {
  describe('canEncode mpeg2video', () => {
    test.each([VaapiEntrypoint.Encode, VaapiEntrypoint.EncodeLowPower])(
      'true with an MPEG-2 Main %s entrypoint',
      (entrypoint) => {
        const capabilities = new VaapiHardwareCapabilities([
          new VaapiProfileEntrypoint(VaapiProfiles.Mpeg2Main, entrypoint),
        ]);

        expect(
          capabilities.canEncode(
            VideoFormats.Mpeg2Video,
            undefined,
            new PixelFormatYuv420P(),
          ),
        ).toBe(true);
      },
    );

    test('false with only an MPEG-2 decode entrypoint', () => {
      const capabilities = new VaapiHardwareCapabilities([
        new VaapiProfileEntrypoint(
          VaapiProfiles.Mpeg2Main,
          VaapiEntrypoint.Decode,
        ),
      ]);

      expect(
        capabilities.canEncode(
          VideoFormats.Mpeg2Video,
          undefined,
          new PixelFormatYuv420P(),
        ),
      ).toBe(false);
    });
  });

  describe('canDecode h264 constrained baseline', () => {
    const capabilities = new VaapiHardwareCapabilities([
      new VaapiProfileEntrypoint(
        VaapiProfiles.H264ConstrainedBaseline,
        VaapiEntrypoint.Decode,
      ),
    ]);

    // ffprobe reports the name, or the number when built with --enable-small.
    test.each(['constrained baseline', '578'])(
      'true for profile %s with a decode entrypoint',
      (profile) => {
        expect(
          capabilities.canDecode(
            VideoFormats.H264,
            profile,
            new PixelFormatYuv420P(),
          ),
        ).toBe(true);
      },
    );

    test('false without a constrained baseline decode entrypoint', () => {
      const mainOnly = new VaapiHardwareCapabilities([
        new VaapiProfileEntrypoint(
          VaapiProfiles.H264Main,
          VaapiEntrypoint.Decode,
        ),
      ]);

      expect(
        mainOnly.canDecode(
          VideoFormats.H264,
          'constrained baseline',
          new PixelFormatYuv420P(),
        ),
      ).toBe(false);
    });
  });
});

describe('H.264 low-power fallback', () => {
  function entrypoint(kind: string, ...modes: RateControlMode[]) {
    const result = new VaapiProfileEntrypoint(VaapiProfiles.H264Main, kind);
    modes.forEach((mode) => result.addRateControlMode(mode));
    return result;
  }

  test('uses regular encoding when the device has no low-power entrypoint', () => {
    const capabilities = new VaapiHardwareCapabilities([
      entrypoint(VaapiEntrypoint.Encode, RateControlMode.VBR),
    ]);
    expect(
      capabilities.resolveH264LowPowerEncoding(new PixelFormatYuv420P()),
    ).toEqual({
      lowPower: false,
      rateControlMode: RateControlMode.VBR,
      fallbackReason:
        'The device does not advertise H.264 VAAPI low-power encoding.',
    });
  });

  test('uses the regular entrypoint rate control when low-power modes are unusable', () => {
    const capabilities = new VaapiHardwareCapabilities([
      entrypoint(VaapiEntrypoint.EncodeLowPower),
      entrypoint(VaapiEntrypoint.Encode, RateControlMode.CQP),
    ]);
    expect(
      capabilities.resolveH264LowPowerEncoding(new PixelFormatYuv420P()),
    ).toEqual({
      lowPower: false,
      rateControlMode: RateControlMode.CQP,
      fallbackReason:
        'H.264 VAAPI low-power encoding has no supported rate-control mode.',
    });
  });

  test('preserves low-power encoding and its preferred rate control when available', () => {
    const capabilities = new VaapiHardwareCapabilities([
      entrypoint(
        VaapiEntrypoint.EncodeLowPower,
        RateControlMode.CQP,
        RateControlMode.CBR,
        RateControlMode.VBR,
      ),
    ]);
    expect(
      capabilities.resolveH264LowPowerEncoding(new PixelFormatYuv420P()),
    ).toEqual({
      lowPower: true,
      rateControlMode: RateControlMode.VBR,
    });
  });

  test('still rejects a device with neither usable low-power nor regular encoding', () => {
    const capabilities = new VaapiHardwareCapabilities([
      entrypoint(VaapiEntrypoint.EncodeLowPower),
    ]);
    expect(() =>
      capabilities.resolveH264LowPowerEncoding(new PixelFormatYuv420P()),
    ).toThrow('regular H.264 VAAPI encoding is not supported');
  });

  test('does not claim regular H.264 encoding can accept 10-bit output', () => {
    const capabilities = new VaapiHardwareCapabilities([
      entrypoint(VaapiEntrypoint.Encode, RateControlMode.VBR),
    ]);
    expect(() =>
      capabilities.resolveH264LowPowerEncoding(new PixelFormatYuv420P10Le()),
    ).toThrow('requires 8-bit output');
  });
});
