import { FilterOption } from '@/ffmpeg/builder/filter/FilterOption.js';
import type { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import { FrameDataLocation } from '@/ffmpeg/builder/types.js';

export class HardwareUploadVaapiFilter extends FilterOption {
  constructor(
    private setFormat: boolean,
    private extraHardwareFrames?: number,
    private deriveVaapi: boolean = false,
  ) {
    super();
  }

  get filter() {
    const format = this.setFormat ? 'format=nv12|p010le|vaapi,' : '';
    const options = [
      ...(this.deriveVaapi ? ['derive_device=vaapi'] : []),
      ...(this.extraHardwareFrames
        ? [`extra_hw_frames=${this.extraHardwareFrames}`]
        : []),
    ];
    return `${format}hwupload${options.length > 0 ? '=' + options.join(':') : ''}`;
  }

  nextState(currentState: FrameState): FrameState {
    return currentState.updateFrameLocation(FrameDataLocation.Hardware);
  }
}
