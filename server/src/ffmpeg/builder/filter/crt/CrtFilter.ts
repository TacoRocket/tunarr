import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import { FilterOption } from '../FilterOption.ts';
import {
  PixelFormatNv12,
  PixelFormatYuv420P,
} from '../../format/PixelFormat.ts';
import type { FrameState } from '../../state/FrameState.ts';
import { FrameDataLocation, FrameSize } from '../../types.ts';
import { crtLottesShader } from './crtLottesShader.ts';
import { ColorSpaces } from '../../constants.ts';
import { ColorFormat } from '../../format/ColorFormat.ts';
import {
  createPairedChromaBleedShader,
  crtChromaBleedShader,
} from './crtChromaBleedShader.ts';
import { crtLumaPeakingShader } from './crtLumaPeakingShader.ts';
import {
  createBroadcastGrainShader,
  crtBroadcastGrainShader,
} from './crtBroadcastGrainShader.ts';
import { createBroadcastCompositeShader } from './crtBroadcastCompositeShader.ts';
import { broadcastColorFunctions } from './broadcastColor.ts';
import { resolveBroadcastFrameClock } from './broadcastFrameClock.ts';
import { vaapiScalingModeOption } from '../vaapi/scalingMode.ts';
import { usesCrtHardwareProcessing } from './processingTier.ts';

const shaders = {
  strong: crtLottesShader,
  classicFlat:
    crtLumaPeakingShader +
    crtChromaBleedShader +
    crtLottesShader
      .replace('#define HARD_SCAN -8.0', '#define HARD_SCAN -6.0')
      .replace(
        '#define SCANLINE_ROWS MAIN_size.y',
        '#define SCANLINE_ROWS (target_size.y / 3.0)',
      )
      .replace(
        '#define CURVATURE vec2(0.031, 0.041)',
        '#define CURVATURE vec2(0.0, 0.0)',
      )
      .replace('#define MASK_DARK 0.5', '#define MASK_DARK 0.85')
      .replace('#define MASK_LIGHT 1.5', '#define MASK_LIGHT 1.15')
      .replace(
        '#define BLOOM_AMOUNT (1.0/16.0)',
        '#define BLOOM_AMOUNT (3.0/64.0)',
      ),
  subtle: crtLottesShader
    .replace('#define HARD_SCAN -8.0', '#define HARD_SCAN -4.0')
    .replace(
      '#define CURVATURE vec2(0.031, 0.041)',
      '#define CURVATURE vec2(0.0, 0.0)',
    )
    .replace('#define MASK_DARK 0.5', '#define MASK_DARK 0.9')
    .replace('#define MASK_LIGHT 1.5', '#define MASK_LIGHT 1.1')
    .replace(
      '#define BLOOM_AMOUNT (1.0/16.0)',
      '#define BLOOM_AMOUNT (1.0/32.0)',
    ),
};
const broadcastShader = shaders.classicFlat
  .replace('center.r + 1.5 *', 'center.r + 0.75 *')
  .replace('#define MASK_DARK 0.85', '#define MASK_DARK 0.95')
  .replace('#define MASK_LIGHT 1.15', '#define MASK_LIGHT 1.05')
  .replace('// Parameters', broadcastColorFunctions + '\n// Parameters')
  .replace(
    'return in_bounds * delinearize(vec4(color, 1.0));',
    'return in_bounds * vec4(broadcast_v5_color(delinearize(vec4(color, 1.0)).rgb), 1.0);',
  );

/**
 * The shader a look draws on `size`, the active output picture. The broadcast
 * looks expect the picture already scaled to `CrtFilter.broadcastSize`.
 */
export function crtShader(
  settings: ChannelCrtSettings,
  size: FrameSize,
): string {
  const broadcastSize = CrtFilter.broadcastSize(settings, size);
  if (broadcastSize === undefined) {
    return settings.look === 'classic-flat'
      ? shaders.classicFlat
      : shaders[settings.look as 'subtle' | 'strong'];
  }
  let selectedShader = broadcastShader;
  if (settings.processing === 'experimental') {
    selectedShader = selectedShader.replace(
      crtChromaBleedShader,
      createPairedChromaBleedShader(broadcastSize.width / 2, size.width),
    );
  }
  if (settings.broadcastTexture === 'classic-flat') {
    selectedShader = selectedShader
      .replace('#define MASK_DARK 0.95', '#define MASK_DARK 0.85')
      .replace('#define MASK_LIGHT 1.05', '#define MASK_LIGHT 1.15');
  }
  const fuseGrain =
    settings.processing === 'experimental' &&
    settings.broadcastComposite === true;
  if (
    !fuseGrain &&
    (settings.broadcastGrain === true || settings.broadcastGrain === 'half')
  ) {
    const grain = createBroadcastGrainShader(
      settings.broadcastGrain === 'half',
    );
    selectedShader = grain + selectedShader;
  }
  if (settings.broadcastComposite === true) {
    selectedShader =
      createBroadcastCompositeShader(
        fuseGrain ? (settings.broadcastGrain ?? false) : false,
      ) + selectedShader;
  }
  selectedShader = resolveBroadcastFrameClock(
    selectedShader,
    crtBroadcastGrainShader + broadcastShader,
  );
  return selectedShader;
}

/**
 * What the ErsatzTV next worker draws for a look, decided the way `CrtFilter`
 * and the VAAPI pipeline decide it for a picture that fills `frame`: the
 * tier's shader, the broadcast line count, the driver's dedicated scaler on the
 * faster tiers, native NV12 output where this runtime enables it, point chroma
 * on Experimental, and HDR10 through the fixed-Hable LUT for DVD Broadcast.
 *
 * The worker applies native NV12 output and point chroma only when the picture
 * fills the frame, as here. Where it doesn't (4:3 in 16:9), the worker hands
 * libplacebo's ordinary NV12 to VAAPI without `scale_vulkan`, the handoff this
 * pipeline can also use for supported picture sizes. The Experimental shader's
 * chroma pairing is sized for the full frame; a narrower picture shifts its ratio by rounding only.
 */
export function crtWorkerStage(
  settings: ChannelCrtSettings,
  frame: FrameSize,
): {
  shader: string;
  inputHeight?: number;
  inputScaleMode?: 'default';
  nativeNv12Output: boolean;
  directNv12Handoff: boolean;
  pointChroma: boolean;
  hdrVaapiLut: boolean;
} {
  const broadcastSize = CrtFilter.broadcastSize(settings, frame);
  // The worker checks its own FFmpeg capability before accepting these options.
  const nativeNv12Output =
    CrtFilter.usesDirectNv12Handoff(settings, frame, true) &&
    process.env.TUNARR_CRT_NV12_OUTPUT === 'native';
  return {
    shader: crtShader(settings, frame),
    inputHeight: broadcastSize?.height,
    inputScaleMode:
      broadcastSize !== undefined && usesCrtHardwareProcessing(settings)
        ? 'default'
        : undefined,
    nativeNv12Output,
    // same runtime and tier conditions; the worker uses it below a full frame
    directNv12Handoff: nativeNv12Output,
    pointChroma:
      nativeNv12Output && CrtFilter.usesPointChroma(settings, frame, true),
    hdrVaapiLut:
      nativeNv12Output &&
      settings.look === 'dvd-broadcast' &&
      process.env.TUNARR_VAAPI_HABLE_LUT === '1',
  };
}

export class CrtFilter extends FilterOption {
  constructor(
    private settings: ChannelCrtSettings,
    private size: FrameSize,
    private broadcastInputPrepared = false,
    private nativeNv12Available = false,
  ) {
    super();
  }

  static broadcastSize(
    settings: ChannelCrtSettings,
    size: FrameSize,
  ): FrameSize | undefined {
    const height =
      settings.look === 'dvd-broadcast'
        ? 480
        : settings.look === 'tv-broadcast'
          ? 360
          : undefined;
    if (height === undefined) return undefined;
    return FrameSize.withDimensions(
      Math.max(2, Math.round((height * size.width) / size.height / 2) * 2),
      height,
    );
  }

  static usesPointChroma(
    settings: ChannelCrtSettings,
    size: FrameSize,
    nativeNv12Available: boolean,
  ): boolean {
    return (
      settings.processing === 'experimental' &&
      CrtFilter.usesDirectNv12Handoff(settings, size, nativeNv12Available)
    );
  }

  static usesDirectNv12Handoff(
    settings: ChannelCrtSettings,
    size: FrameSize,
    nativeNv12Available = false,
  ): boolean {
    const nativeNv12 = process.env.TUNARR_CRT_NV12_OUTPUT === 'native';
    return (
      process.env.TUNARR_CRT_DIRECT_NV12 === '1' &&
      process.env.ETV_VAAPI_DIRECT_NV12 === '1' &&
      (nativeNv12
        ? nativeNv12Available
        : process.env.ETV_INLINE_NV12_RTZ === '1' &&
          size.equals(FrameSize.FHD)) &&
      usesCrtHardwareProcessing(settings) &&
      CrtFilter.broadcastSize(settings, size) !== undefined &&
      Number.isInteger(size.width) &&
      Number.isInteger(size.height) &&
      size.width > 0 &&
      size.height > 0 &&
      size.width % 2 === 0 &&
      size.height % 2 === 0
    );
  }

  get filter(): string {
    const broadcastSize = CrtFilter.broadcastSize(this.settings, this.size);
    let broadcastScale = '';
    const selectedShaderHex = Buffer.from(
      crtShader(this.settings, this.size),
    ).toString('hex');
    if (broadcastSize !== undefined && !this.broadcastInputPrepared) {
      broadcastScale = `scale_vaapi=w=${broadcastSize.width}:h=${broadcastSize.height}:format=nv12${vaapiScalingModeOption(usesCrtHardwareProcessing(this.settings))},`;
    }
    const nativeNv12 = process.env.TUNARR_CRT_NV12_OUTPUT === 'native';
    const directNv12 = CrtFilter.usesDirectNv12Handoff(
      this.settings,
      this.size,
      this.nativeNv12Available,
    );
    const outputSampling = CrtFilter.usesPointChroma(
      this.settings,
      this.size,
      this.nativeNv12Available,
    )
      ? "chroma_location=topleft:skip_aa=1:extra_opts='plane_downscaler=custom\\:plane_downscaler_kernel=box\\:plane_downscaler_radius=0.5':"
      : "chroma_location=topleft:extra_opts='plane_downscaler=mitchell':";
    // The revised fork selects producer storage per filter; keep legacy builds usable.
    const outputMode = directNv12 && nativeNv12 ? 'nv12_output=native:' : '';
    // Direct output requires the opt-in runtime's writable NV12 import fix.
    const outputConversion = directNv12 ? '' : 'scale_vulkan=format=nv12,';
    return (
      broadcastScale +
      'hwmap=derive_device=drm,format=drm_prime,' +
      `libplacebo=w=${this.size.width}:h=${this.size.height}:format=nv12:colorspace=bt709:range=tv:${outputMode}${outputSampling}custom_shader_bin=${selectedShaderHex},` +
      `format=vulkan,${outputConversion}` +
      'hwmap=derive_device=vaapi:reverse=1,format=vaapi,setsar=1'
    );
  }

  nextState(currentState: FrameState): FrameState {
    return currentState.update({
      scaledSize: this.size,
      paddedSize: this.size,
      isAnamorphic: false,
      frameDataLocation: FrameDataLocation.Hardware,
      pixelFormat: new PixelFormatNv12(new PixelFormatYuv420P()),
      colorFormat: new ColorFormat({
        ...(currentState.colorFormat ?? ColorFormat.unknown),
        colorSpace: ColorSpaces.Bt709,
      }),
    });
  }
}
