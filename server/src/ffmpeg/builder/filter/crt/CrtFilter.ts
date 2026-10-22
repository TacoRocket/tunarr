import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import { FilterOption } from '../FilterOption.ts';
import {
  PixelFormatNv12,
  PixelFormatYuv420P,
} from '../../format/PixelFormat.ts';
import type { FrameState } from '../../state/FrameState.ts';
import { FrameDataLocation, type FrameSize } from '../../types.ts';
import { crtLottesShader } from './crtLottesShader.ts';

const shaders = {
  strong: crtLottesShader,
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
const shaderHex = {
  subtle: Buffer.from(shaders.subtle).toString('hex'),
  strong: Buffer.from(shaders.strong).toString('hex'),
};

export class CrtFilter extends FilterOption {
  constructor(
    private settings: ChannelCrtSettings,
    private size: FrameSize,
  ) {
    super();
  }

  get filter(): string {
    const format = this.settings.processing === 'standard' ? 'nv12' : 'rgba';
    // scale_vulkan provides a renderable encoder surface. Removing this stage
    // produced blank frames despite a successful FFmpeg exit in the VAAPI probe.
    return (
      'hwmap=derive_device=drm,format=drm_prime,' +
      `libplacebo=w=${this.size.width}:h=${this.size.height}:format=${format}:custom_shader_bin=${shaderHex[this.settings.look]},` +
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
    });
  }
}
