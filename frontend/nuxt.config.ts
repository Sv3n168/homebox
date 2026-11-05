import { defineNuxtConfig } from "nuxt/config";

// https://v3.nuxtjs.org/api/configuration/nuxt.config
export default defineNuxtConfig({
  ssr: false,

  components: {
    dirs: [],
  },

  build: {
    transpile: ["vue-i18n"],
  },

  modules: [
    "@nuxtjs/tailwindcss",
    "@pinia/nuxt",
    "@vueuse/nuxt",
    "@vite-pwa/nuxt",
    "unplugin-icons/nuxt",
    "shadcn-nuxt",
    "@nuxt/eslint",
  ],

  eslint: {
    config: {},
  },

  // Runtime config for OpenTelemetry
  // Note: otelEnabled is determined automatically by querying the backend status endpoint.
  // When the backend has telemetry enabled, the frontend will automatically enable it.
  runtimeConfig: {
    public: {
      // OpenTelemetry configuration (can be overridden by environment variables)
      otelServiceName: process.env.NUXT_PUBLIC_OTEL_SERVICE_NAME || "homebox-frontend",
      otelServiceVersion: process.env.NUXT_PUBLIC_OTEL_SERVICE_VERSION || "1.0.0",
      otelSampleRate: process.env.NUXT_PUBLIC_OTEL_SAMPLE_RATE || "1.0",
      otelDebug: process.env.NUXT_PUBLIC_OTEL_DEBUG || "false",
      // When this frontend was built; Settings → Tools compares it with the server build.
      appBuildTime: new Date().toISOString(),
    },
  },

  nitro: {
    devProxy: {
      "/api": {
        target: "http://localhost:7745/api",
        ws: true,
        changeOrigin: true,
      },
    },
  },

  app: {
    head: {
      script: [{ src: "/set-theme.js" }],
      meta: [
        // viewport-fit=cover exposes the iPhone safe-area insets (tab bar above the home indicator).
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-title", content: "Homebox" },
        { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      ],
      link: [{ rel: "apple-touch-icon", href: "/pwa-192x192.png" }],
    },
  },

  css: ["@/assets/css/main.css", "@/assets/css/liquid-glass.css"],

  pwa: {
    workbox: {
      // The module adds its own patterns (_nuxt/builds/*.json), which replaces
      // workbox's defaults — without this list the JS bundles and the start
      // page are never precached and the app can't start offline.
      // Fork: no page HTML here (Cloudflare Access) — a precached page is served
      // without asking the network, so an expired Access session never shows
      // its login. Only 200.html (the same SPA shell) as the offline fallback.
      globPatterns: ["**/*.{js,css,svg,png,jpg,jpeg,webp,ico,woff,woff2,webmanifest}", "200.html"],
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      navigateFallback: null,
      cleanupOutdatedCaches: true,
      // Fork: a new version takes over right away. Set here because the module
      // only adds these when it injects its own register script (see below).
      skipWaiting: true,
      clientsClaim: true,
      // API JSON is cached by the app itself (lib/offline) so it can answer
      // searches and queue writes. Here only photos/attachments: immutable per
      // id, so cache-first. ignoreSearch because the URL carries an access
      // token that changes with every login.
      runtimeCaching: [
        // Fork: page loads always go to the network first, so Cloudflare Access
        // can redirect to its login (the browser follows the redirect). Only
        // without a connection (basement) the precached app shell answers.
        {
          urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
          handler: "NetworkFirst",
          options: {
            cacheName: "hb-pages",
            networkTimeoutSeconds: 8,
            plugins: [
              {
                // Never store pages: a stale page would point at old JS bundles,
                // and an Access redirect must never be kept.
                cacheWillUpdate: async () => null,
                // The module stores 200.html under "/200"; both spellings in case that changes.
                handlerDidError: async () =>
                  (await caches.match("/200", { ignoreSearch: true })) ??
                  (await caches.match("/200.html", { ignoreSearch: true })) ??
                  Response.error(),
              },
            ],
          },
        },
        {
          urlPattern: /\/api\/v1\/entities\/[^/]+\/attachments\/[^/?]+(\?.*)?$/,
          handler: "CacheFirst",
          method: "GET",
          options: {
            cacheName: "hb-attachments",
            matchOptions: { ignoreSearch: true },
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 5000 },
          },
        },
      ],
    },
    registerType: "autoUpdate",
    // Fork: registered from plugins/sw.client.ts once the page is idle. The
    // injected script registered it at the top of <head>, so the precache of
    // all ~200 bundles raced the page's own download of the same files.
    injectRegister: null,
    devOptions: {
      // Enable to troubleshoot during development
      enabled: false,
    },
    manifest: {
      name: "Homebox",
      short_name: "Homebox",
      description: "Home Inventory App",
      theme_color: "#5b7f67",
      start_url: "/home",
      icons: [
        {
          src: "pwa-192x192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "pwa-512x512.png",
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: "pwa-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
  },
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  compatibilityDate: "2024-11-29",
});
