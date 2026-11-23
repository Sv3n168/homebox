package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStaticCacheControl(t *testing.T) {
	const revalidate = "no-cache"
	cases := map[string]string{
		"/_nuxt/BKOpeLj3.js":          "public, max-age=31536000, immutable",
		"/_nuxt/entry.5vdZhpDB.css":   "public, max-age=31536000, immutable",
		"/_nuxt/builds/latest.json":   revalidate,
		"/_nuxt/builds/meta/abc.json": revalidate,
		"/sw.js":                      revalidate,
		"/workbox-8df661a4.js":        revalidate,
		"/manifest.webmanifest":       revalidate,
		"/":                           revalidate,
		"/home":                       revalidate,
		"/item/123":                   revalidate,
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
