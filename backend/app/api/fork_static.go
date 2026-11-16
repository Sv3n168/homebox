package main

import (
	"net/http"
	"strings"
)

// Fork: how the embedded frontend is cached, and what a missing build file
// answers. Both matter for the offline mode: the service worker stores every
// file of the app on the phone, and whatever it is given under a file's
// address is what the app gets from then on, without a connection too.

// buildAssetPrefix is where Nuxt puts its scripts and styles. Their names
// carry a hash of their content, except for the build manifest below.
const buildAssetPrefix = "/_nuxt/"

// isBuildAsset reports whether the path is a script or style of one build.
// After an update the files of the previous build are gone.
func isBuildAsset(p string) bool {
	return strings.HasPrefix(p, buildAssetPrefix)
}

// staticCacheControl is the Cache-Control for an embedded frontend file.
//
// Hashed build files never change, so they may be kept for good. Everything
// else (pages, sw.js, the web manifest, the build manifest) must be asked for
// again each time: without a header a proxy such as Cloudflare keeps .js files
// for hours by default, and a stale sw.js lists the files of the old build.
func staticCacheControl(p string) string {
	if isBuildAsset(p) && !strings.HasPrefix(p, buildAssetPrefix+"builds/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

// missingBuildAsset answers a build file that does not exist with 404.
//
// The page fallback (index.html, status 200) is right for app routes, but for
// a script it hands out HTML under a .js address: a proxy caches that, and a
// service worker stores it as that script for good, which breaks the page that
// needs it. A 404 makes the install fail cleanly and try again.
func missingBuildAsset(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	http.NotFound(w, r)
}
