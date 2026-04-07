import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../helpers/msw/server';
import { getAuthUrl, fetchImageAsBlob, clearImageQueue } from '../../../src/api/authUrl';

// Flush microtasks + a macro-task so async handlers finish
const flushPromises = () => new Promise<void>(r => setTimeout(r, 10));

beforeEach(() => {
  clearImageQueue();
  vi.restoreAllMocks(); // restore any vi.spyOn() wrappers from the previous test

  // jsdom's URL.createObjectURL returns '' and may be non-configurable, so
  // Object.defineProperty in setup.ts can fail silently on CI. Assign directly
  // here (after restoreAllMocks) so every test in this file gets a fresh mock.
  URL.createObjectURL = vi.fn(() => 'blob:mock') as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

// ── getAuthUrl ─────────────────────────────────────────────────────────────────

describe('getAuthUrl', () => {
  describe('FE-COMP-AUTHURL-001: empty URL returns early', () => {
    it('returns empty string without hitting the network', async () => {
      const result = await getAuthUrl('', 'download');
      expect(result).toBe('');
    });
  });

  describe('FE-COMP-AUTHURL-002: token appended with ?', () => {
    it('appends token as first query param when URL has no query string', async () => {
      server.use(
        http.post('/api/auth/resource-token', () =>
          HttpResponse.json({ token: 'abc123' })
        )
      );
      const result = await getAuthUrl('/uploads/file.pdf', 'download');
      expect(result).toBe('/uploads/file.pdf?token=abc123');
    });
  });

  describe('FE-COMP-AUTHURL-003: token appended with &', () => {
    it('appends token as additional query param when URL already has a query string', async () => {
      server.use(
        http.post('/api/auth/resource-token', () =>
          HttpResponse.json({ token: 'xyz' })
        )
      );
      const result = await getAuthUrl('/uploads/file.pdf?size=lg', 'download');
      expect(result).toBe('/uploads/file.pdf?size=lg&token=xyz');
    });
  });

  describe('FE-COMP-AUTHURL-004: non-ok API response returns original URL', () => {
    it('returns original URL unchanged when resource-token returns 500', async () => {
      server.use(
        http.post('/api/auth/resource-token', () =>
          HttpResponse.json({}, { status: 500 })
        )
      );
      const result = await getAuthUrl('/uploads/file.pdf', 'download');
      expect(result).toBe('/uploads/file.pdf');
    });
  });

  describe('FE-COMP-AUTHURL-005: fetch throws returns original URL', () => {
    it('returns original URL when fetch throws a network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new TypeError('Network error')
      );
      const result = await getAuthUrl('/uploads/file.pdf', 'download');
      expect(result).toBe('/uploads/file.pdf');
    });
  });
});

// ── fetchImageAsBlob ───────────────────────────────────────────────────────────

describe('fetchImageAsBlob', () => {
  describe('FE-COMP-AUTHURL-006: empty URL returns empty string', () => {
    it('resolves to empty string without network call', async () => {
      const result = await fetchImageAsBlob('');
      expect(result).toBe('');
    });
  });

  describe('FE-COMP-AUTHURL-007: successful fetch returns blob object URL', () => {
    it('resolves to a blob URL for a valid image response', async () => {
      server.use(
        http.get('/uploads/photo.jpg', () =>
          new HttpResponse(new Blob(['fake-image'], { type: 'image/jpeg' }), {
            status: 200,
          })
        )
      );
      const result = await fetchImageAsBlob('/uploads/photo.jpg');
      // URL.createObjectURL is native in Node 20+; just assert it's a blob URL
      expect(result).toMatch(/^blob:/);
    });
  });

  describe('FE-COMP-AUTHURL-008: non-ok response resolves to empty string', () => {
    it('resolves to empty string when image URL returns 404', async () => {
      server.use(
        http.get('/uploads/missing.jpg', () =>
          HttpResponse.json({}, { status: 404 })
        )
      );
      const result = await fetchImageAsBlob('/uploads/missing.jpg');
      expect(result).toBe('');
    });
  });

  describe('FE-COMP-AUTHURL-009: fetch throws resolves to empty string', () => {
    it('resolves to empty string when fetch rejects', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new TypeError('Network error')
      );
      const result = await fetchImageAsBlob('/uploads/error.jpg');
      expect(result).toBe('');
    });
  });

  // ── Concurrency tests use vi.spyOn(fetch) for synchronous barrier control ──
  // When the spy mock runs, it executes synchronously up to its first `await`,
  // so `resolvers.push(r)` happens synchronously inside fetchImageAsBlob(), giving
  // us deterministic access to in-flight requests without needing flushPromises().

  describe('FE-COMP-AUTHURL-010: concurrency cap at MAX_CONCURRENT=6', () => {
    it('fires at most 6 requests simultaneously', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const resolvers: Array<() => void> = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>(r => resolvers.push(r));
        concurrent--;
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 });
      });

      const urls = Array.from({ length: 8 }, (_, i) => `/uploads/img${i}.jpg`);
      const promises = urls.map(url => fetchImageAsBlob(url));

      // After synchronous calls: 6 run()s called fetch() and pushed to resolvers,
      // 2 are in the module queue
      expect(resolvers.length).toBe(6);
      expect(maxConcurrent).toBeLessThanOrEqual(6);

      // Drain iteratively: each pass resolves current in-flight requests,
      // then the next batch from the queue starts and pushes new resolvers
      while (resolvers.length > 0) {
        resolvers.splice(0).forEach(r => r());
        await flushPromises();
      }

      await Promise.all(promises);
      expect(maxConcurrent).toBeLessThanOrEqual(6);
    });
  });

  describe('FE-COMP-AUTHURL-011: queued request runs after active slot frees', () => {
    it('7th request eventually resolves once one of the 6 active slots is freed', async () => {
      const resolvers: Array<() => void> = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await new Promise<void>(r => resolvers.push(r));
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 });
      });

      const urls = Array.from({ length: 7 }, (_, i) => `/uploads/queue${i}.jpg`);
      const promises = urls.map(url => fetchImageAsBlob(url));

      // 6 in-flight, 1 queued
      expect(resolvers.length).toBe(6);

      // Resolve the 6 active requests
      resolvers.splice(0).forEach(r => r());
      await flushPromises();

      // 7th should now have started
      expect(resolvers.length).toBe(1);

      // Resolve the 7th
      resolvers.splice(0).forEach(r => r());

      const results = await Promise.all(promises);
      expect(results).toHaveLength(7);
      results.forEach(r => expect(r).toMatch(/^blob:/));
    });
  });
});

// ── clearImageQueue ────────────────────────────────────────────────────────────

describe('clearImageQueue', () => {
  describe('FE-COMP-AUTHURL-012: clearImageQueue discards pending entries', () => {
    it('removes queued items so they never execute after active slots drain', async () => {
      const resolvers: Array<() => void> = [];
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await new Promise<void>(r => resolvers.push(r));
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 });
      });

      const urls = Array.from({ length: 7 }, (_, i) => `/uploads/clear${i}.jpg`);
      const promises = urls.map(url => fetchImageAsBlob(url));

      // 6 in-flight, 1 queued
      expect(resolvers.length).toBe(6);

      // Discard the queued 7th request
      clearImageQueue();

      // Resolve the 6 active requests and let them drain
      resolvers.splice(0).forEach(r => r());
      await flushPromises();

      // 6 active slots completed; queue was cleared so the 7th never ran
      expect(createObjectURLSpy).toHaveBeenCalledTimes(6);

      // First 6 promises resolved; 7th is orphaned (never resolves)
      await Promise.all(promises.slice(0, 6));
    });
  });
});
