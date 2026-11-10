import { FetchSource, PMTiles, type Protocol, type RangeResponse, type Source } from 'pmtiles';

const RETRIES = 3;

/** pmtiles' error when a Range request is answered with the whole file (HTTP 200). */
const isWholeFileResponse = (err: unknown): boolean =>
  err instanceof Error && /content-length/i.test(err.message);

/**
 * A FetchSource that survives the first visit after a data deploy.
 *
 * Right after the .pmtiles files change, a Range request can come back as HTTP 200 with the whole
 * file: Chrome revalidates the ranges it cached from the previous file with If-Range (a changed
 * ETag means "send everything"), and a CDN edge that has not cached the new file yet may do the same.
 * pmtiles then gives up, and because it caches the failed header lookup the layer stays empty until
 * a reload. Instead: retry straight away bypassing the browser cache (`mustReload` = fetch with
 * `cache: 'reload'`), then back off briefly while the CDN catches up.
 */
class ResilientSource implements Source {
  private inner: FetchSource;

  constructor(url: string) {
    this.inner = new FetchSource(url);
  }

  getKey(): string {
    return this.inner.getKey();
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.getBytes(offset, length, signal, etag);
      } catch (err) {
        if (attempt >= RETRIES || signal?.aborted || !isWholeFileResponse(err)) throw err;
        this.inner.mustReload = true;
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
}

/** Serve `url` from a ResilientSource for every map that asks for pmtiles://url (main, lens, aerial). */
export function registerArchive(protocol: Protocol, url: string): void {
  if (!protocol.get(url)) protocol.add(new PMTiles(new ResilientSource(url)));
}
