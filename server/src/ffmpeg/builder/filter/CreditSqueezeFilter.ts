import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import type { CreditSqueezePlayback } from '../../CreditSqueeze.ts';
import type { FrameSize } from '../types.ts';
import { CrtFilter } from './crt/CrtFilter.ts';
import { usesCrtHardwareProcessing } from './crt/processingTier.ts';
import { vaapiScalingModeOption } from './vaapi/scalingMode.ts';

export class CreditSqueezeFilter {
  constructor(
    private playback: CreditSqueezePlayback,
    private size: FrameSize,
    private crt: ChannelCrtSettings | undefined,
    private copyTimestamps: boolean,
  ) {}

  graph(video: string, background: string, softwareOutput = false): string {
    const working = this.crt?.enabled
      ? (CrtFilter.broadcastSize(this.crt, this.size) ?? this.size)
      : this.size;
    const offset = this.copyTimestamps ? this.playback.sourceOffsetSeconds : 0;
    const start = this.playback.startSeconds + offset;
    const active = 'eq(idx,1)';
    const placement = [
      `pos_x='if(${active},ow*0.05,0)'`,
      `pos_y='if(${active},oh*0.225,0)'`,
      `pos_w='if(${active},ow*0.55,ow)'`,
      `pos_h='if(${active},oh*0.55,oh)'`,
    ].join(':');
    const toVaapi =
      'scale_vulkan=format=nv12:out_range=limited,hwmap=derive_device=vaapi:reverse=1,format=vaapi';
    const effect = this.crt?.enabled
      ? new CrtFilter(this.crt, this.size, true).filter
      : 'setsar=1';
    const hasLeadIn = this.playback.startSeconds > 0;
    // Each branch owns a different hardware frame pool. A software overlay
    // must download within each branch, before concat switches between pools.
    const download = softwareOutput ? ',hwdownload,format=nv12' : '';
    const graph: string[] = [];
    if (hasLeadIn) {
      const normalEffect = this.crt?.enabled
        ? new CrtFilter(this.crt, this.size).filter
        : 'setsar=1';
      // scale_vaapi converts to BT.709/limited, but its format query does not
      // declare that conversion. Prevent concat from pushing it back to decode.
      const colorMetadata = this.crt?.enabled
        ? ''
        : 'setparams=colorspace=bt709:range=tv,';
      graph.push(
        `${video}${colorMetadata}split=2[cs_before_raw][cs_after_raw]`,
        `[cs_before_raw]trim=end=${start},${normalEffect}${download}[cs_before]`,
        `[cs_after_raw]trim=start=${start}[cs_after]`,
      );
    }
    graph.push(
      `${hasLeadIn ? '[cs_after]' : video}scale_vaapi=w=${working.width}:h=${working.height}:format=nv12${vaapiScalingModeOption(usesCrtHardwareProcessing(this.crt))},hwmap=derive_device=drm,format=drm_prime,libplacebo=format=rgba,format=vulkan,split=2[cs_clock][cs_program]`,
      `[cs_clock]${toVaapi}[cs_clock_va]`,
      `${background}format=rgba,hwupload,loop=loop=-1:size=1:start=0,setpts=PTS+${start}/TB[cs_background]`,
      `[cs_background][cs_program]libplacebo=inputs=2:w=${working.width}:h=${working.height}:format=rgba:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:${placement},format=vulkan,${toVaapi}[cs_composed]`,
      // The program owns frame timestamps and EOF; the still must never extend it.
      `[cs_clock_va][cs_composed]overlay_vaapi=eof_action=pass:repeatlast=0,${effect}${download}${hasLeadIn ? '[cs_credits]' : '[vsqueeze]'}`,
    );
    if (hasLeadIn) {
      // Keep the source clock, including gaps: ordinary concat shifts the tail.
      graph.push(
        '[cs_before][cs_credits]concat=n=2:v=1:a=0:preserve_ts=1[vsqueeze]',
      );
    }
    return graph.join(';');
  }
}
