import type { Channel } from '@tunarr/types';

export function subtitleDeliveryMode(
  channel: Pick<Channel, 'subtitleDelivery'>,
  globalSidecarEnabled: boolean,
): 'burn' | 'convert' {
  if (channel.subtitleDelivery === 'burn') return 'burn';
  if (channel.subtitleDelivery === 'sidecar') return 'convert';
  return globalSidecarEnabled ? 'convert' : 'burn';
}

export function isImageBasedSubtitle(codec: string) {
  return [
    'hdmv_pgs_subtitle',
    'dvd_subtitle',
    'dvdsub',
    'vobsub',
    'pgssub',
    'pgs',
    'dvbsub',
  ].includes(codec.toLowerCase());
}

export function extractIsAnamorphic(
  width: number,
  height: number,
  aspectRatioString: string,
) {
  const resolutionRatio = width / height;
  const [numS, denS] = aspectRatioString.split(':');
  const num = parseFloat(numS!);
  const den = parseFloat(denS!);
  if (isNaN(num) || isNaN(den)) {
    return false;
  }

  return Math.abs(resolutionRatio - num / den) > 0.01;
}
