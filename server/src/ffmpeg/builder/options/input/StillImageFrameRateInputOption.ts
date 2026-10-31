import type { InputSource } from '../../input/InputSource.ts';
import { InputOption } from './InputOption.ts';

export class StillImageFrameRateInputOption extends InputOption {
  constructor(private frameRate: number) {
    super();
  }

  appliesToInput(input: InputSource): boolean {
    return (
      input.isVideo() &&
      input.streams.every((stream) => stream.inputKind === 'stillimage')
    );
  }

  options(): string[] {
    return ['-framerate', String(this.frameRate)];
  }
}
