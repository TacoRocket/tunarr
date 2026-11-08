import { describe, expect, it } from 'vitest';
import { carriedSettings } from './carryOver.ts';
import type { Manifest } from './schema.ts';

const saved = {
  bazarrUrl: 'http://bazarr:6767',
  apiKey: 'saved-key',
  note: 'x',
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    settings: [
      { key: 'bazarrUrl', type: 'url', label: 'Bazarr URL' },
      { key: 'apiKey', type: 'secret', label: 'API key' },
      { key: 'note', type: 'text', label: 'Note' },
    ],
    requests: [
      {
        id: 'movies',
        method: 'GET',
        baseUrlSetting: 'bazarrUrl',
        path: 'api/movies',
        query: [],
        body: [],
        credential: { setting: 'apiKey', header: 'X-API-KEY' },
      },
    ],
    ...overrides,
  } as Manifest;
}

// The shape of a Bazarr package built for API v2, which this Tunarr can't run.
const apiV2 = {
  apiVersion: 2,
  settings: [
    { key: 'bazarrUrl', type: 'url' },
    { key: 'apiKey', type: 'secret' },
    { key: 'note', type: 'text' },
  ],
  reads: [
    {
      id: 'movies',
      baseUrlSetting: 'bazarrUrl',
      path: 'api/movies',
      credential: { setting: 'apiKey', header: 'X-API-KEY' },
    },
  ],
};

describe('carriedSettings', () => {
  it('keeps the address and API key across an update to a new API', () => {
    expect(carriedSettings(apiV2, manifest(), saved)).toEqual(saved);
  });

  it('keeps everything on an ordinary update', () => {
    expect(carriedSettings(manifest(), manifest(), saved)).toEqual(saved);
  });

  it('drops a value whose type changed', () => {
    const previous = {
      ...apiV2,
      settings: [
        { key: 'bazarrUrl', type: 'url' },
        { key: 'apiKey', type: 'text' },
      ],
    };
    expect(carriedSettings(previous, manifest(), saved)).toEqual({
      bazarrUrl: 'http://bazarr:6767',
    });
  });

  it('drops a secret that would be sent to a different address setting', () => {
    const next = manifest({
      settings: [
        { key: 'bazarrUrl', type: 'url', label: 'Bazarr URL' },
        { key: 'otherUrl', type: 'url', label: 'Other URL' },
        { key: 'apiKey', type: 'secret', label: 'API key' },
      ],
      requests: [
        {
          id: 'movies',
          method: 'GET',
          baseUrlSetting: 'otherUrl',
          path: 'api/movies',
          query: [],
          body: [],
          credential: { setting: 'apiKey', header: 'X-API-KEY' },
        },
      ],
    });
    expect(carriedSettings(apiV2, next, saved)).toEqual({
      bazarrUrl: 'http://bazarr:6767',
    });
  });

  it('drops the secret when its address does not carry over', () => {
    const previous = {
      ...apiV2,
      settings: [
        { key: 'bazarrUrl', type: 'text' },
        { key: 'apiKey', type: 'secret' },
      ],
    };
    expect(carriedSettings(previous, manifest(), saved)).toEqual({});
  });

  it('keeps nothing when the previous manifest is unreadable', () => {
    expect(carriedSettings(undefined, manifest(), saved)).toEqual({});
    expect(carriedSettings('not a manifest', manifest(), saved)).toEqual({});
  });
});
