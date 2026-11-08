/**
 * A channel update body that leaves server-owned playback state alone.
 *
 * Sending `startTime` overwrites a clock the server may have rebased since the
 * channel was read. Sending `onDemand` at all makes the server restart an
 * on-demand channel from its first program (BasicChannelRepository resets the
 * paused cursor). Callers that mean to change one of them add it back.
 */
export function channelSettingsUpdate<
  T extends { startTime?: unknown; onDemand?: unknown },
>(channel: T): Omit<T, 'startTime' | 'onDemand'> {
  const { startTime: _startTime, onDemand: _onDemand, ...settings } = channel;
  return settings;
}
