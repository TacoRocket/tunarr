import type { ChannelCrtSettings } from '@tunarr/types/schemas';

export function usesCrtHardwareProcessing(
  settings: ChannelCrtSettings | undefined,
): boolean {
  return (
    settings?.enabled === true &&
    (settings.processing === 'performance' ||
      settings.processing === 'experimental')
  );
}
