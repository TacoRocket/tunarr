import type { TranscodeConfigSchema } from '@tunarr/types/schemas';
import type z from 'zod';

export type BaseTranscodeConfigProps = {
  initialConfig: z.input<typeof TranscodeConfigSchema>;
  showAdvancedSettings?: boolean;
  /**
   * New profiles are made for ErsatzTV next: settings it doesn't use are left
   * out and only formats it can encode are offered. Existing profiles keep
   * every field and say which ones Next ignores.
   */
  nextFirst?: boolean;
};
