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
    },
  },

  css: ["@/assets/css/main.css", "@/assets/css/liquid-glass.css"],

  pwa: {
    workbox: {
      // The module adds its own patterns (_nuxt/builds/*.json), which replaces
      // workbox's defaults — without this list the JS bundles and the start
      // page are never precached and the app can't start offline.
      globPatterns: ["**/*.{js,css,html,svg,png,jpg,jpeg,webp,ico,woff,woff2,webmanifest}"],
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      navigateFallbackDenylist: [/^\/api/],
      cleanupOutdatedCaches: true,
      // API JSON is cached by the app itself (lib/offline) so it can answer
      // searches and queue writes. Here only photos/attachments: immutable per
      // id, so cache-first. ignoreSearch because the URL carries an access
      // token that changes with every login.
      runtimeCaching: [
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
    injectRegister: "script",
    injectManifest: {
      swSrc: "sw.js",
    },
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
