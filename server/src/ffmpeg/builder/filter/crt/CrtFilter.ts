import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import { FilterOption } from '../FilterOption.ts';
import {
  PixelFormatNv12,
  PixelFormatYuv420P,
} from '../../format/PixelFormat.ts';
import type { FrameState } from '../../state/FrameState.ts';
import { FrameDataLocation, type FrameSize } from '../../types.ts';
import { crtLottesShader } from './crtLottesShader.ts';
import { ColorSpaces } from '../../constants.ts';
import { ColorFormat } from '../../format/ColorFormat.ts';
import { crtChromaBleedShader } from './crtChromaBleedShader.ts';
import { crtLumaPeakingShader } from './crtLumaPeakingShader.ts';
import { crtBroadcastGrainShader } from './crtBroadcastGrainShader.ts';
import { crtBroadcastCompositeShader } from './crtBroadcastCompositeShader.ts';
import { broadcastColorFunctions } from './broadcastColor.ts';
import { resolveBroadcastFrameClock } from './broadcastFrameClock.ts';

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
const shaderHex = {
  subtle: Buffer.from(shaders.subtle).toString('hex'),
  strong: Buffer.from(shaders.strong).toString('hex'),
  'classic-flat': Buffer.from(shaders.classicFlat).toString('hex'),
  'dvd-broadcast': Buffer.from(broadcastShader).toString('hex'),
  'tv-broadcast': Buffer.from(broadcastShader).toString('hex'),
};

export class CrtFilter extends FilterOption {
  constructor(
    private settings: ChannelCrtSettings,
    private size: FrameSize,
  ) {
    super();
  }

  get filter(): string {
    const broadcastHeight =
      this.settings.look === 'dvd-broadcast'
        ? 480
        : this.settings.look === 'tv-broadcast'
          ? 360
          : undefined;
    let broadcastScale = '';
    let selectedShaderHex = shaderHex[this.settings.look];
    if (broadcastHeight !== undefined) {
      let selectedShader = broadcastShader;
      if (this.settings.broadcastTexture === 'classic-flat') {
        selectedShader = selectedShader
          .replace('#define MASK_DARK 0.95', '#define MASK_DARK 0.85')
          .replace('#define MASK_LIGHT 1.05', '#define MASK_LIGHT 1.15');
      }
      if (
        this.settings.broadcastGrain === true ||
        this.settings.broadcastGrain === 'half'
      ) {
        const grain =
          this.settings.broadcastGrain === 'half'
            ? crtBroadcastGrainShader.replace('(4.0 / 255.0)', '(2.0 / 255.0)')
            : crtBroadcastGrainShader;
        selectedShader = grain + selectedShader;
      }
      if (this.settings.broadcastComposite === true) {
        selectedShader = crtBroadcastCompositeShader + selectedShader;
      }
      selectedShader = resolveBroadcastFrameClock(
        selectedShader,
        crtBroadcastGrainShader + broadcastShader,
      );
      selectedShaderHex = Buffer.from(selectedShader).toString('hex');
      // Use the active output aspect ratio, including anamorphic correction,
      // and even dimensions for NV12. Padding and subtitles follow the effect.
      const width = Math.max(
        2,
        Math.round((broadcastHeight * this.size.width) / this.size.height / 2) *
          2,
      );
      broadcastScale = `scale_vaapi=w=${width}:h=${broadcastHeight}:format=nv12,`;
    }
    const format = this.settings.processing === 'standard' ? 'nv12' : 'rgba';
    // scale_vulkan cannot convert RGB to NV12 with an unspecified matrix.
    // Let libplacebo produce a defined output rather than relabeling the input.
    const colorSpace =
      this.settings.processing === 'performance' ? 'colorspace=bt709:' : '';
    // scale_vulkan provides a renderable encoder surface. Removing this stage
    // produced blank frames despite a successful FFmpeg exit in the VAAPI probe.
    return (
      broadcastScale +
      'hwmap=derive_device=drm,format=drm_prime,' +
      `libplacebo=w=${this.size.width}:h=${this.size.height}:format=${format}:${colorSpace}custom_shader_bin=${selectedShaderHex},` +
      'format=vulkan,scale_vulkan=format=nv12,' +
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
      colorFormat:
        this.settings.processing === 'performance'
          ? new ColorFormat({
              ...(currentState.colorFormat ?? ColorFormat.unknown),
              colorSpace: ColorSpaces.Bt709,
            })
          : currentState.colorFormat,
    });
  }
}
