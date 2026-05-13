'use strict';
const MANIFEST = 'flutter-app-manifest';
const TEMP = 'flutter-temp-cache';
const CACHE_NAME = 'flutter-app-cache';

const RESOURCES = {"main.dart.mjs": "d23cf6a0a2fdbba02a2d8e252172f620",
"assets/AssetManifest.bin.json": "3191cfbccf959147d53600e05e343926",
"assets/packages/wakelock_plus/assets/no_sleep.js": "74499cf34f37daae14b51e3a23cd9f7a",
"assets/packages/flutter_map/lib/assets/flutter_map_logo.png": "208d63cc917af9713fc9572bd5c09362",
"assets/packages/cupertino_icons/assets/CupertinoIcons.ttf": "6323a28c4d27ae6070923bcb643dc985",
"assets/shaders/ink_sparkle.frag": "ecc85a2e95f5e9f53123dcaf8cb9b6ce",
"assets/shaders/stretch_effect.frag": "40d68efbbf360632f614c731219e95f0",
"assets/fonts/roboto.woff2": "e507bd45228483ae2f864d36f26bb43e",
"assets/fonts/MaterialIcons-Regular.otf": "f34ace52ea74c95e26949fab4870ac22",
"assets/AssetManifest.bin": "4a7fd941d294d1afa234963b0f96690e",
"assets/NOTICES": "d4f1df90449f62f5ef4d8d3b43fbb9e5",
"assets/FontManifest.json": "6d7513ce1c88ccff09eb0c72d3685bdc",
"assets/app/app.zip.hash": "815f9f5fae31a59d00de6e9bbb55c564",
"assets/app/app.zip": "558df90dc96be9123f6578a9d2d5c0ac",
"favicon.png": "41e5bc5ad6aab67633b4d31c0aa2b8ab",
"manifest.json": "ede3c2cd7a4ff0aac2d672ed60ddd887",
"python.js": "352c5261eadd3cc73ac082984266c0fc",
"flutter.js.map": "493b39420f09daa62e485b78a7ff50ba",
"index.html": "f90944085f70f1db1dc37d78fa3afc3b",
"/": "f90944085f70f1db1dc37d78fa3afc3b",
"splash/img/dark-2x.png": "0b1dcfc1bd6c872904999125eaf18b58",
"splash/img/dark-1x.png": "f64824fce9ca5a76c2a624bd7d419d27",
"splash/img/dark-3x.png": "ae807b0c060ac361981de61f3ad87597",
"splash/img/light-4x.png": "1bd22698351cf0ced8b3b5d70a1b218f",
"splash/img/light-1x.png": "f64824fce9ca5a76c2a624bd7d419d27",
"splash/img/light-2x.png": "0b1dcfc1bd6c872904999125eaf18b58",
"splash/img/dark-4x.png": "1bd22698351cf0ced8b3b5d70a1b218f",
"splash/img/light-3x.png": "ae807b0c060ac361981de61f3ad87597",
"pyodide/packaging-24.2-py3-none-any.whl": "ba8472e04cb67139842aa03ff5921358",
"pyodide/pyodide.asm.js": "31daa2b26f2436587ab55425451df592",
"pyodide/pyodide-lock.json": "c514c0f3480fe7388346a9106cc56d95",
"pyodide/pyodide.d.ts": "13cfd754c98bc09d35b15f30661623c8",
"pyodide/pyodide.js": "3f5a03308cbaf16edcf3a456673ea441",
"pyodide/ffi.d.ts": "e40213f539be775d0924e4aa348ec4f7",
"pyodide/pyodide.asm.wasm": "ba116948a682d77867d1e34d9e837614",
"pyodide/micropip-0.8.0-py3-none-any.whl": "b132a43045c127404f00f781d32f3048",
"pyodide/python_stdlib.zip": "ba7bdcbf412690e702e7f1e0997382ed",
"pyodide/pyodide.mjs": "d3c7620427e7f434afc90983bb2219b6",
"pyodide/package.json": "e7dad597b3686bf79bb01240086a4de8",
"canvaskit/skwasm_st.js.symbols": "c7e7aac7cd8b612defd62b43e3050bdd",
"canvaskit/skwasm.js.symbols": "80806576fa1056b43dd6d0b445b4b6f7",
"canvaskit/chromium/canvaskit.js.symbols": "5a23598a2a8efd18ec3b60de5d28af8f",
"canvaskit/chromium/canvaskit.wasm": "64a386c87532ae52ae041d18a32a3635",
"canvaskit/chromium/canvaskit.js": "34beda9f39eb7d992d46125ca868dc61",
"canvaskit/skwasm_heavy.js": "740d43a6b8240ef9e23eed8c48840da4",
"canvaskit/canvaskit.js.symbols": "68eb703b9a609baef8ee0e413b442f33",
"canvaskit/skwasm.wasm": "f0dfd99007f989368db17c9abeed5a49",
"canvaskit/canvaskit.wasm": "efeeba7dcc952dae57870d4df3111fad",
"canvaskit/skwasm_heavy.js.symbols": "0755b4fb399918388d71b59ad390b055",
"canvaskit/skwasm_st.wasm": "56c3973560dfcbf28ce47cebe40f3206",
"canvaskit/canvaskit.js": "86e461cf471c1640fd2b461ece4589df",
"canvaskit/skwasm_heavy.wasm": "b0be7910760d205ea4e011458df6ee01",
"canvaskit/skwasm.js": "f2ad9363618c5f62e813740099a80e63",
"canvaskit/skwasm_st.js": "d1326ceef381ad382ab492ba5d96f04d",
"flutter.js": "24bc71911b75b5f8135c949e27a2984e",
"flutter_bootstrap.js": "0652909a72650b15b9c2eee4a11725cd",
"main.dart.wasm": "c2fddc8a3c51bb9137192bf332e4f9a1",
"python-worker.js": "26eb131f3acb5ce232fea72da957e8ce",
"main.dart.js": "d1026918e3210116a423124adecff745",
"version.json": "d4ceb385e2370b9d09ef653f246325bd",
"icons/apple-touch-icon-192.png": "8cf0d5162941f467a77f023c414a1812",
"icons/Icon-maskable-512.png": "0b1dcfc1bd6c872904999125eaf18b58",
"icons/Icon-maskable-192.png": "d1f96bab23c50fe5f5db429aabbac81a",
"icons/Icon-512.png": "0b1dcfc1bd6c872904999125eaf18b58",
"icons/loading-animation.png": "41a96047dbd2463a50c46ad3bf6ff158",
"icons/Icon-192.png": "d1f96bab23c50fe5f5db429aabbac81a"};
// The application shell files that are downloaded before a service worker can
// start.
const CORE = ["main.dart.js",
"main.dart.wasm",
"main.dart.mjs",
"index.html",
"flutter_bootstrap.js",
"assets/AssetManifest.bin.json",
"assets/FontManifest.json"];

// During install, the TEMP cache is populated with the application shell files.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  return event.waitUntil(
    caches.open(TEMP).then((cache) => {
      return cache.addAll(
        CORE.map((value) => new Request(value, {'cache': 'reload'})));
    })
  );
});
// During activate, the cache is populated with the temp files downloaded in
// install. If this service worker is upgrading from one with a saved
// MANIFEST, then use this to retain unchanged resource files.
self.addEventListener("activate", function(event) {
  return event.waitUntil(async function() {
    try {
      var contentCache = await caches.open(CACHE_NAME);
      var tempCache = await caches.open(TEMP);
      var manifestCache = await caches.open(MANIFEST);
      var manifest = await manifestCache.match('manifest');
      // When there is no prior manifest, clear the entire cache.
      if (!manifest) {
        await caches.delete(CACHE_NAME);
        contentCache = await caches.open(CACHE_NAME);
        for (var request of await tempCache.keys()) {
          var response = await tempCache.match(request);
          await contentCache.put(request, response);
        }
        await caches.delete(TEMP);
        // Save the manifest to make future upgrades efficient.
        await manifestCache.put('manifest', new Response(JSON.stringify(RESOURCES)));
        // Claim client to enable caching on first launch
        self.clients.claim();
        return;
      }
      var oldManifest = await manifest.json();
      var origin = self.location.origin;
      for (var request of await contentCache.keys()) {
        var key = request.url.substring(origin.length + 1);
        if (key == "") {
          key = "/";
        }
        // If a resource from the old manifest is not in the new cache, or if
        // the MD5 sum has changed, delete it. Otherwise the resource is left
        // in the cache and can be reused by the new service worker.
        if (!RESOURCES[key] || RESOURCES[key] != oldManifest[key]) {
          await contentCache.delete(request);
        }
      }
      // Populate the cache with the app shell TEMP files, potentially overwriting
      // cache files preserved above.
      for (var request of await tempCache.keys()) {
        var response = await tempCache.match(request);
        await contentCache.put(request, response);
      }
      await caches.delete(TEMP);
      // Save the manifest to make future upgrades efficient.
      await manifestCache.put('manifest', new Response(JSON.stringify(RESOURCES)));
      // Claim client to enable caching on first launch
      self.clients.claim();
      return;
    } catch (err) {
      // On an unhandled exception the state of the cache cannot be guaranteed.
      console.error('Failed to upgrade service worker: ' + err);
      await caches.delete(CACHE_NAME);
      await caches.delete(TEMP);
      await caches.delete(MANIFEST);
    }
  }());
});
// The fetch handler redirects requests for RESOURCE files to the service
// worker cache.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET') {
    return;
  }
  var origin = self.location.origin;
  var key = event.request.url.substring(origin.length + 1);
  // Redirect URLs to the index.html
  if (key.indexOf('?v=') != -1) {
    key = key.split('?v=')[0];
  }
  if (event.request.url == origin || event.request.url.startsWith(origin + '/#') || key == '') {
    key = '/';
  }
  // If the URL is not the RESOURCE list then return to signal that the
  // browser should take over.
  if (!RESOURCES[key]) {
    return;
  }
  // If the URL is the index.html, perform an online-first request.
  if (key == '/') {
    return onlineFirst(event);
  }
  event.respondWith(caches.open(CACHE_NAME)
    .then((cache) =>  {
      return cache.match(event.request).then((response) => {
        // Either respond with the cached resource, or perform a fetch and
        // lazily populate the cache only if the resource was successfully fetched.
        return response || fetch(event.request).then((response) => {
          if (response && Boolean(response.ok)) {
            cache.put(event.request, response.clone());
          }
          return response;
        });
      })
    })
  );
});
self.addEventListener('message', (event) => {
  // SkipWaiting can be used to immediately activate a waiting service worker.
  // This will also require a page refresh triggered by the main worker.
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
    return;
  }
  if (event.data === 'downloadOffline') {
    downloadOffline();
    return;
  }
});
// Download offline will check the RESOURCES for all files not in the cache
// and populate them.
async function downloadOffline() {
  var resources = [];
  var contentCache = await caches.open(CACHE_NAME);
  var currentContent = {};
  for (var request of await contentCache.keys()) {
    var key = request.url.substring(origin.length + 1);
    if (key == "") {
      key = "/";
    }
    currentContent[key] = true;
  }
  for (var resourceKey of Object.keys(RESOURCES)) {
    if (!currentContent[resourceKey]) {
      resources.push(resourceKey);
    }
  }
  return contentCache.addAll(resources);
}
// Attempt to download the resource online before falling back to
// the offline cache.
function onlineFirst(event) {
  return event.respondWith(
    fetch(event.request).then((response) => {
      return caches.open(CACHE_NAME).then((cache) => {
        cache.put(event.request, response.clone());
        return response;
      });
    }).catch((error) => {
      return caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((response) => {
          if (response != null) {
            return response;
          }
          throw error;
        });
      });
    })
  );
}
