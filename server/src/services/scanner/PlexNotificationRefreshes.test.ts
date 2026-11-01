import { describe, expect, it } from 'vitest';
import type { Movie } from '../../types/Media.ts';
import type { ScanContext } from './MediaSourceScanner.ts';
import { PlexNotificationRefreshes } from './PlexNotificationRefreshes.ts';

const item = {
  externalId: '10',
  canonicalId: 'full-metadata',
  title: 'Movie',
  duration: 1000,
  mediaItem: {
    locations: [
      {
        type: 'remote',
        externalKey: 'part',
        path: '/movie',
        sourceType: 'plex',
      },
    ],
  },
} as Movie;
const context = {
  library: { uuid: 'library' },
  mediaSource: { uuid: 'source' },
  force: false,
} as ScanContext<unknown>;

describe('reuse of a successful Plex notification import', () => {
  it('replaces one duplicate detail read without trusting a partial listing hash', () => {
    const refreshes = new PlexNotificationRefreshes();
    refreshes.connect('source', ['library']);
    const notified = {
      ...context,
      notification: true,
      notificationToken: refreshes.token('library'),
    };
    refreshes.record(notified, item);
    const listing = {
      ...item,
      canonicalId: 'partial-listing',
      mediaItem: {
        ...item.mediaItem!,
        locations: [
          {
            externalKey: 'part',
            path: '/movie',
            sourceType: 'plex' as const,
            type: 'remote' as const,
          },
        ],
      },
    };
    expect(refreshes.has(context, listing)).toBe(true);
    expect(refreshes.consume(context, listing, item.canonicalId)).toBe(true);
    expect(refreshes.consume(context, listing, item.canonicalId)).toBe(false);
  });

  it('restores normal reads after observed library activity or disconnect, including an in-flight import', () => {
    const refreshes = new PlexNotificationRefreshes();
    for (const reason of ['activity', 'disconnect']) {
      refreshes.connect('source', ['library']);
      const notified = {
        ...context,
        notification: true,
        notificationToken: refreshes.token('library'),
      };
      refreshes.record(notified, item);
      if (reason === 'activity') refreshes.invalidate('library');
      else refreshes.disconnect('source');
      refreshes.record(notified, item);
      expect(refreshes.consume(context, item, item.canonicalId)).toBe(false);
    }
  });
});
