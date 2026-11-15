package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStaticCacheControl(t *testing.T) {
	cases := map[string]string{
		"/_nuxt/BKOpeLj3.js":          "public, max-age=31536000, immutable",
		"/_nuxt/entry.5vdZhpDB.css":   "public, max-age=31536000, immutable",
		"/_nuxt/builds/latest.json":   "no-cache",
		"/_nuxt/builds/meta/abc.json": "no-cache",
		"/sw.js":                      "no-cache",
		"/workbox-8df661a4.js":        "no-cache",
		"/manifest.webmanifest":       "no-cache",
		"/":                           "no-cache",
		"/home":                       "no-cache",
		"/item/123":                   "no-cache",
	}
	for path, want := range cases {
		if got := staticCacheControl(path); got != want {
			t.Errorf("staticCacheControl(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestMissingBuildAssetIs404(t *testing.T) {
	handler := notFoundHandler()

	rec := httptest.NewRecorder()
	if err := handler(rec, httptest.NewRequest(http.MethodGet, "/_nuxt/gone-after-update.js", nil)); err != nil {
		t.Fatalf("handler returned an error: %v", err)
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing build file: status %d, want 404 (never the page fallback)", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("missing build file: Cache-Control %q, want no-store", got)
	}
}
