/*
 Copyright 2019 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

/// <reference lib="esnext" />

import * as storage from 'idb-keyval';

import {fetchWithFallback} from '../../lib/fetchWithFallback';
import {longestMatchingPrefix} from '../../lib/longestMatchingPrefix';

import {
  ClientIdToHash,
  Manifest,
  ManifestURLToHashes,
  PageURLToManifestURL,
} from '../../lib/interfaces';

async function getClientUrlForEvent(event: FetchEvent) {
  try {
    // TODO: Figure out if this is the right precedence.
    const effectiveClientId =
      // Is replacesClientId implemented anywhere?
      // event.replacesClientId ||
      event.resultingClientId ||
      event.clientId;
    const client = await self.clients.get(effectiveClientId);
    return client.url;
  } catch(e) {
    // Firefox currently sets the referer to 'about:client' for initial
    // navigations, but that's not useful for our purposes.
    if (event.request.referrer && event.request.referrer !== 'about:client') {
      return event.request.referrer;
    }

    // Use the event's request URL as the last resort, with the assumption
    // that this is a navigation request and we can't detect it otherwise.
    return event.request.url;
  }
}

async function getLatestManifestVersion(manifestUrl: string) {
  const manifestURLToHashes: ManifestURLToHashes = await storage.get('ManifestURLToHashes');
  if (!manifestURLToHashes) {
    return;
  }

  const hashesToManifest = manifestURLToHashes[manifestUrl];
  if (!hashesToManifest) {
    return;
  }

  const hashes = [...hashesToManifest.keys()];
  // Map objects preserve the ordering of insertion, so the last key will be the
  // most recent hash.
  return hashes[hashes.length - 1];
}

async function getManifestWithHash(manifestUrl: string, hash: string) {
  const manifestURLToHashes: ManifestURLToHashes = (await storage.get('ManifestURLToHashes') || {});

  const hashToManifest = manifestURLToHashes[manifestUrl];
  if (!hashToManifest) {
    return;
  }

  return hashToManifest.get(hash);
}

async function saveClientIdAndHash(clientId: string, hash: string) {
  if (clientId) {
    const clientIdToHash: ClientIdToHash = (await storage.get('ClientIdToHash') || {});
    clientIdToHash[clientId] = hash;
    await storage.set('ClientIdToHash', clientIdToHash);
  }
}

async function appCacheLogic(
  event: FetchEvent,
  manifest: Manifest,
  hash: string,
  clientUrl: string
) {
  const requestUrl = event.request.url;

  // Is our request URL listed in the CACHES section?
  // Or is our request URL the client URL, since any page that
  // registers a manifest is treated as if it were in the CACHE?
  if ((manifest.cache.indexOf(requestUrl) >= 0)  || (requestUrl === clientUrl)) {
    // If so, return the cached response.
    const cache = await caches.open(hash);
    return cache.match(requestUrl);
  }

  // Otherwise, check the FALLBACK section next.
  // FALLBACK keys are URL prefixes, and if more than one prefix
  // matches our request URL, the longest prefix "wins".
  // (Of course, it might be that none of the prefixes match.)
  const fallbackKey = longestMatchingPrefix(Object.keys(manifest.fallback),
    requestUrl);
  if (fallbackKey) {
    return fetchWithFallback(event.request, manifest.fallback[fallbackKey],
      hash);
  }

  // If CACHE and FALLBACK don't apply, try NETWORK.
  if ((manifest.network.indexOf(requestUrl) >= 0) ||
      (manifest.network.indexOf('*') >= 0)) {
    return fetch(event.request);
  }

  // If nothing matches, then return an error response.
  return Response.error();
}

async function manifestBehavior(
  event: FetchEvent,
  manifestUrl: string,
  clientUrl: string
) {
  if (event.clientId) {
    const clientIdToHash: ClientIdToHash = (await storage.get('ClientIdToHash') || {});
    const hash = clientIdToHash[event.clientId];

    // If we already have a hash assigned to this client id, use the associated
    // manifest to implement the AppCache logic.
    if (hash) {
      const manifest = await getManifestWithHash(manifestUrl, hash);
      if (manifest) {
        return appCacheLogic(event, manifest, hash, clientUrl);
      }
    }
  }

  // If there's isn't yet a hash for this client id, or there's no client id,
  // then get the latest version of the manifest, and use that to implement
  // AppCache logic.
  const latestHash = await getLatestManifestVersion(manifestUrl);
  if (latestHash) {
    // Establish the clientId-to-hash mapping for future use.
    if (event.clientId) {
      await saveClientIdAndHash(event.clientId, latestHash);
    }

    const manifest = await getManifestWithHash(manifestUrl, latestHash);
    if (manifest) {
      return appCacheLogic(event, manifest, latestHash, clientUrl);
    }
  }

  // If we don't have a matching manifest, return an error response.
  return Response.error();
}

async function noManifestBehavior(event: FetchEvent) {
  // If we fall through to this point, then we don't have a known
  // manifest associated with the client making the request.
  // We now need to check to see if our request URL matches a prefix
  // from the FALLBACK section of *any* manifest in our origin. If
  // there are multiple matches, the longest prefix wins. If there are
  // multiple prefixes of the same length in different manifest, then
  // the one we access last wins. (This might not match browser behavior.)
  // See https://www.w3.org/TR/2011/WD-html5-20110525/offline.html#concept-appcache-matches-fallback
  const manifestURLToHashes: ManifestURLToHashes = (await storage.get('ManifestURLToHashes') || {});

  let currentLongestPrefix = '';
  let effectiveManifest: Manifest | undefined;
  let cacheName = '';

  for (const hashToManifest of Object.values(manifestURLToHashes)) {
    const entries = [...hashToManifest.entries()];
    const [hash, latestManifest] = entries[entries.length - 1];

    // Create an array of the longest matching prefix for each manifest. If no
    // prefixes match for a given manifest, the value will be ''.
    const longestPrefix = longestMatchingPrefix(Object.keys(latestManifest.fallback), event.request.url);
    if (longestPrefix && (longestPrefix.length >= currentLongestPrefix.length)) {
      effectiveManifest = latestManifest;
      currentLongestPrefix = longestPrefix;
      cacheName = hash;
    }
  }

  // Lookup the fallback URL value in the winning manifest, assuming there is one.
  if (effectiveManifest && currentLongestPrefix && cacheName) {
    return fetchWithFallback(event.request, effectiveManifest.fallback[currentLongestPrefix], cacheName);
  }

  // If nothing matches, then just fetch().
  return fetch(event.request);
}

async function appCacheBehaviorForEvent(event: FetchEvent) {
  // If this is a request that, as per the AppCache spec, should be handled
  // via a direct fetch(), then do that and bail early.
  if (event.request.headers.get('X-Use-Fetch') === 'true') {
    return fetch(event.request);
  }

  const requestUrl = new URL(event.request.url);

  // Appcache rules only apply to GETs & same-scheme requests.
  if ((event.request.method !== 'GET') || (requestUrl.protocol !== location.protocol)) {
    return fetch(event.request);
  }

  const clientUrl = await getClientUrlForEvent(event);
  const pageURLToManifestURL: PageURLToManifestURL = (await storage.get('PageURLToManifestURL') || {});
  const manifestUrl = pageURLToManifestURL[clientUrl];

  if (manifestUrl) {
    return manifestBehavior(event, manifestUrl, clientUrl);
  }

  return noManifestBehavior(event);
}

async function cleanupClientIdAndHash(idsOfActiveClients: Array<string>) {
  const inactiveHashes: Array<string> = [];

  const clientIdToHash: ClientIdToHash = (await storage.get('ClientIdToHash') || {});

  // We're going to be modifying clientIdToHash, so get a list of the original entries first.
  const entries = [...Object.entries(clientIdToHash)];
  for (const [clientId, hash] of entries) {
    if (idsOfActiveClients.indexOf(clientId) === -1) {
      delete clientIdToHash[clientId];
      inactiveHashes.push(hash);
    }
  }

  await storage.set('ClientIdToHash', clientIdToHash);

  return inactiveHashes;
}

async function getHashesOfOlderVersions() {
  const hashesOfOlderVersions: Set<string> = new Set();

  const manifestURLToHashes: ManifestURLToHashes = (await storage.get('ManifestURLToHashes') || {});

  for (const hashToManifest of Object.values(manifestURLToHashes)) {
    const allHashes = [...hashToManifest.keys()];
    // We want to iterate over everything other than the last key.
    for (const hash of allHashes.slice(0, allHashes.length - 1)) {
      hashesOfOlderVersions.add(hash);
    }
  }

  return hashesOfOlderVersions;
}

/**
 * Does the following:
 * 1. Gets a list of all client ids associated with this service worker.
 * 2. Calls cleanupClientIdAndHash() to remove the out of date client id
 *    to hash associations.
 * 3. Calls getHashesOfOlderVersions() to get a list of all the hashes
 *    that correspond to out-of-date manifest versions.
 * 4. If there's a match between an out of date hash and a hash that is no
 *    longer being used by a client, then it deletes the corresponding cache.
 */
async function cleanupOldCaches() {
  const activeClients = await self.clients.matchAll();
  const idsOfActiveClients = activeClients.map((client) => client.id);
  const hashesNotInUse = await cleanupClientIdAndHash(idsOfActiveClients);
  const hashesOfOlderVersions = await getHashesOfOlderVersions();
  const hashesToDelete = [...hashesOfOlderVersions].filter((hash) => hashesNotInUse.includes(hash));
  await Promise.all(hashesToDelete.map((hash) => caches.delete(hash)));
}

/**
 * `goog.appCacheBehavior.fetch` is the main entry point to the library
 * from within service worker code.
 *
 * The goal of the library is to provide equivalent behavior to AppCache
 * whenever possible. The one difference in how this library behaves compared to
 * a native AppCache implementation is that its client-side code will attempt to
 * fetch a fresh AppCache manifest once any cached version is older than 24
 * hours. This works around a
 * [major pitfall](http://alistapart.com/article/application-cache-is-a-douchebag#section6)
 * in the native AppCache implementation.
 *
 * **Important**
 * In addition to calling `goog.appCacheBehavior.fetch()` from within your
 * service worker, you *must* add the following to each HTML document that
 * contains an App Cache Manifest:
 *
 * ```html
 * <script src="path/to/client-runtime.js"
 *         data-service-worker="service-worker.js">
 * </script>
 * ```
 *
 * (The `data-service-worker` attribute is optional. If provided, it will
 * automatically call
 * [`navigator.serviceWorker.register()`](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)
 * for you.)
 *
 * Once you've added `<script src="path/to/client-runtime.js"></script>` to
 * your HTML pages, you can use `goog.appCacheBehavior.fetch` within your
 * service worker script to get a `Response` suitable for passing to
 * [`FetchEvent.respondWidth()`](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith):
 *
 * ```js
 * // Import the library into the service worker global scope:
 * // https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts
 * importScripts('path/to/appcache-behavior-import.js');
 *
 * self.addEventListener('fetch', event => {
 *   event.respondWith(goog.appCacheBehavior.fetch(event).catch(error => {
 *     // Fallback behavior goes here, e.g. return fetch(event.request);
 *   }));
 * });
 * ```
 *
 * `goog.appCacheBehavior.fetch()` can be selectively applied to only a subset
 * of requests, to aid in the migration off of App Cache and onto a more
 * robust service worker implementation:
 *
 * ```js
 * // Import the library into the service worker global scope:
 * // https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/importScripts
 * importScripts('path/to/appcache-behavior-import.js');
 *
 * self.addEventListener('fetch', event => {
 *   if (event.request.url.match(/legacyRegex/)) {
 *     event.respondWith(goog.appCacheBehavior.fetch(event));
 *   } else {
 *     event.respondWith(goog.appCacheBehavior.fetch(event));
 *   }
 * });
 * ```
 */
export async function handle(event: FetchEvent) {
  const response = await appCacheBehaviorForEvent(event);
  // If this is a navigation, clean up unused caches that correspond to old
  // AppCache manifest versions which are no longer associated with an
  // active client. This will be done asynchronously, and won't block the
  // response from being returned to the onfetch handler.
  if (event.request.mode === 'navigate') {
    event.waitUntil(cleanupOldCaches());
  }

  return response;
}