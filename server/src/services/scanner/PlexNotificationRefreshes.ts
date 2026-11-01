import { injectable } from 'inversify';
import { createHash } from 'node:crypto';
import type { Movie, Episode } from '../../types/Media.ts';
import type { ScanContext } from './MediaSourceScanner.ts';

type Item = Movie | Episode;
type Receipt = { libraryId: string; canonicalId: string; summary: string };

// One-use acknowledgements, not a metadata cache: a successful pushed refresh
// can replace the next ordinary detail read. Unannounced changes therefore still
// get a full read on the following scan. Eviction simply restores normal work.
@injectable()
export class PlexNotificationRefreshes {
  private readonly libraries = new Map<
    string,
    { sourceId: string; token: object }
  >();
  private readonly receipts = new Map<string, Receipt>();

  connect(sourceId: string, libraryIds: string[]) {
    this.disconnect(sourceId);
    for (const id of libraryIds)
      this.libraries.set(id, { sourceId, token: {} });
  }

  disconnect(sourceId: string) {
    for (const [id, library] of this.libraries) {
      if (library.sourceId !== sourceId) continue;
      this.invalidate(id);
      this.libraries.delete(id);
    }
  }

  invalidate(libraryId: string) {
    const library = this.libraries.get(libraryId);
    if (library) library.token = {};
    for (const [key, receipt] of this.receipts) {
      if (receipt.libraryId === libraryId) this.receipts.delete(key);
    }
  }

  invalidateItem(sourceId: string, libraryId: string, itemId: string) {
    this.receipts.delete(`${sourceId}:${libraryId}:${itemId}`);
  }

  token(libraryId: string): object | undefined {
    return this.libraries.get(libraryId)?.token;
  }

  record(context: ScanContext<unknown>, item: Item) {
    const library = this.libraries.get(context.library.uuid);
    if (
      !context.notification ||
      !context.notificationToken ||
      context.notificationToken !== library?.token ||
      context.mediaSource.uuid !== library.sourceId ||
      !item.canonicalId
    )
      return;
    const key = this.key(context, item);
    this.receipts.delete(key);
    this.receipts.set(key, {
      libraryId: context.library.uuid,
      canonicalId: item.canonicalId,
      summary: this.summary(item),
    });
    if (this.receipts.size > 10_000) {
      this.receipts.delete(this.receipts.keys().next().value!);
    }
  }

  has(context: ScanContext<unknown>, item: Item): boolean {
    if (context.notification || context.force || context.pathFilter)
      return false;
    const receipt = this.receipts.get(this.key(context, item));
    return !!receipt && receipt.summary === this.summary(item);
  }

  consume(
    context: ScanContext<unknown>,
    item: Item,
    canonicalId?: string | null,
  ): boolean {
    const key = this.key(context, item);
    const receipt = this.receipts.get(key);
    const reuse =
      this.has(context, item) &&
      !!canonicalId &&
      receipt?.canonicalId === canonicalId;
    if (!context.notification) this.receipts.delete(key);
    return reuse;
  }

  private key(context: ScanContext<unknown>, item: Item) {
    return `${context.mediaSource.uuid}:${context.library.uuid}:${item.externalId}`;
  }

  private summary(item: Item) {
    // These listing-visible fields can invalidate an acknowledgement; they cannot
    // establish freshness themselves (Plex listings omit streams and markers).
    return createHash('sha256')
      .update(
        JSON.stringify([
          item.title,
          item.year,
          item.duration,
          item.summary,
          item.mediaItem?.locations.map((location) => [
            location.type,
            location.path,
            location.type === 'remote' ? location.externalKey : null,
          ]),
          item.type === 'episode' ? item.episodeNumber : null,
        ]),
      )
      .digest('hex');
  }
}
