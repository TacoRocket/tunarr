import type { FrameSize } from '../../types.ts';
import type { InputSource } from '../../input/InputSource.ts';
import { InputOption } from './InputOption.ts';

/**
 * Subtitle canvas for the image subtitles read from this input, as
 * `-canvas_size WxH`.
 */
export class CanvasSizeInputOption extends InputOption {
  constructor(private canvas: FrameSize) {
    super();
  }

  appliesToInput(input: InputSource): boolean {
    return input.type === 'video';
  }

  options(_inputSource: InputSource): string[] {
    return ['-canvas_size', `${this.canvas.width}x${this.canvas.height}`];
  }
}
