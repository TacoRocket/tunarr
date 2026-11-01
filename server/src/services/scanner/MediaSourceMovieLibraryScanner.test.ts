import { describe, expect, it, vi } from 'vitest';
import type { ProgramConverter } from '../../db/converters/ProgramConverter.ts';
import type { ProgramDaoMinter } from '../../db/converters/ProgramMinter.ts';
import type {
  IProgramDB,
  ProgramCanonicalIdLookupResult,
} from '../../db/interfaces/IProgramDB.ts';
import type { MediaSourceDB } from '../../db/mediaSourceDB.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.js';
import type { MediaSourceLibrary } from '../../db/schema/MediaSourceLibrary.ts';
import type { MediaSourceApiClient } from '../../external/MediaSourceApiClient.ts';
import type { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { Movie } from '../../types/Media.ts';
import { Result } from '../../types/result.ts';
import type { MeilisearchService } from '../MeilisearchService.ts';
import { MediaSourceMovieLibraryScanner } from './MediaSourceMovieLibraryScanner.ts';
import type { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import type { ScanContext } from './MediaSourceScanner.ts';

class TestMovieScanner extends MediaSourceMovieLibraryScanner<
  'plex',
  MediaSourceApiClient,
  Movie
> {
  readonly mediaSourceType = 'plex';
  getApiClient = vi.fn();
  getLibrarySize = vi.fn();
  getLibraryContents = vi.fn();
  getSubtitles = vi.fn();
  shouldSkipItem = vi.fn().mockReturnValue(false);
  recordItemRefresh = vi.fn();
  scanMovie = vi.fn();
  scanMovieById = vi.fn();
  downloadExternalSubtitleStreams = vi.fn().mockResolvedValue(undefined);

  scanItem(
    context: ScanContext<MediaSourceApiClient>,
    incoming: Movie,
    existing: ProgramCanonicalIdLookupResult,
  ) {
    return this.scanSingleInternal(context, incoming, existing);
  }
}

describe('movie full-metadata change detection (#45)', () => {
  it('saves changed full metadata once, then skips despite a partial listing', async () => {
    const fullMovie = {
      externalId: 'movie',
      canonicalId: 'with-credits',
      type: 'movie',
    } as Movie;
    const incoming = { ...fullMovie, canonicalId: 'listing-without-credits' };
    const persisted = { ...fullMovie, uuid: 'program-id', externalIds: [] };
    const upsertPrograms = vi.fn().mockResolvedValue([persisted]);
    const indexMovie = vi.fn().mockResolvedValue(undefined);
    const minted = { program: persisted };
    const mintMovie = vi.fn().mockReturnValue(minted);
    const scanner = new TestMovieScanner(
      {} as MediaSourceDB,
      { upsertPrograms } as unknown as IProgramDB,
      {} as MediaSourceProgressService,
      { indexMovie } as unknown as MeilisearchService,
      {} as ProgramConverter,
      { mintMovie } as unknown as ProgramDaoMinter,
      {} as ExternalSubtitleDownloader,
    );
    scanner.scanMovie.mockResolvedValue(Result.success(fullMovie));
    const context: ScanContext<MediaSourceApiClient> = {
      force: false,
      apiClient: {} as MediaSourceApiClient,
      scannedEntities: 0,
      totalEntities: 0,
      mediaSource: {
        uuid: 'source',
        replacePaths: [],
      } as unknown as MediaSourceWithRelations,
      library: { uuid: 'library' } as MediaSourceLibrary,
    };
    const existing: ProgramCanonicalIdLookupResult = {
      uuid: 'program-id',
      libraryId: 'library',
      externalKey: 'movie',
      canonicalId: incoming.canonicalId,
    };

    await scanner.scanItem(context, incoming, existing);
    expect(mintMovie).toHaveBeenCalledWith(
      context.mediaSource,
      context.library,
      fullMovie,
    );
    expect(upsertPrograms).toHaveBeenCalledExactlyOnceWith([minted]);
    expect(indexMovie).toHaveBeenCalledTimes(1);

    await scanner.scanItem(context, incoming, {
      ...existing,
      canonicalId: fullMovie.canonicalId,
    });
    expect(scanner.scanMovie).toHaveBeenCalledTimes(2);
    expect(scanner.recordItemRefresh).toHaveBeenCalledTimes(2);

    // A successfully imported notification already satisfied this detail read.
    scanner.shouldSkipItem.mockReturnValue(true);
    await scanner.scanItem(context, incoming, {
      ...existing,
      canonicalId: fullMovie.canonicalId,
    });
    expect(scanner.scanMovie).toHaveBeenCalledTimes(2);
    expect(upsertPrograms).toHaveBeenCalledTimes(1);
    scanner.shouldSkipItem.mockReturnValue(false);
    scanner.scanMovie.mockResolvedValue(
      Result.forError(new Error('Plex detail request failed')),
    );
    await scanner.scanItem(context, incoming, existing);
    expect(scanner.recordItemRefresh).toHaveBeenCalledTimes(2);
    expect(scanner.downloadExternalSubtitleStreams).toHaveBeenCalledTimes(1);
    expect(indexMovie).toHaveBeenCalledTimes(1);
  });
});
