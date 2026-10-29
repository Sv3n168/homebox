package main

// Fork: login hardening for an installation behind a Cloudflare tunnel.
//
//   - HBOX_OPTIONS_CLIENT_IP_HEADER (e.g. CF-Connecting-IP): the client IP is
//     read from this one header, which the proxy overwrites on every request.
//     Behind a tunnel every request otherwise comes from cloudflared's
//     address, so one attacker's failed logins would lock out everybody.
//     X-Real-IP / X-Forwarded-For (trust_proxy) are passed through from the
//     client by Cloudflare and must not be trusted there.
//   - Requests that arrived over HTTPS get Strict-Transport-Security, and the
//     session cookies set on them get the Secure flag, so a later plain-HTTP
//     request to the same host never carries them.

import (
	"net"
	"net/http"
	"strings"
	"sync"
)

// clientIPHeader is set once at startup (newApp).
var clientIPHeader string

func setClientIPHeader(h string) {
	clientIPHeader = http.CanonicalHeaderKey(strings.TrimSpace(h))
}

// clientIPFromHeader returns the configured header's IP, or "" when the
// option is off or the header is missing/invalid. The header is only taken
// from a peer on the local/private network (cloudflared on the same host or
// LAN); a client reaching the port directly from the internet cannot pick
// its own address.
func clientIPFromHeader(r *http.Request) string {
	if clientIPHeader == "" || !fromPrivatePeer(r) {
		return ""
	}
	ip := strings.TrimSpace(firstValue(r.Header.Get(clientIPHeader)))
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

func fromPrivatePeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

// loginsInFlight caps parallel attempts per client on the rate-limited auth
// routes. The brake decides before and counts after the password check, so
// without this cap many attempts sent at once would all get through.
var loginsInFlight = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

const maxLoginsInFlight = 2

func enterLogin(key string) bool {
	loginsInFlight.Lock()
	defer loginsInFlight.Unlock()
	if loginsInFlight.n[key] >= maxLoginsInFlight {
		return false
	}
	loginsInFlight.n[key]++
	return true
}

func leaveLogin(key string) {
	loginsInFlight.Lock()
	defer loginsInFlight.Unlock()
	if loginsInFlight.n[key] <= 1 {
		delete(loginsInFlight.n, key)
		return
	}
	loginsInFlight.n[key]--
}

func firstValue(v string) string {
	first, _, _ := strings.Cut(v, ",")
	return first
}

// requestIsHTTPS reports whether the client used HTTPS. The proxy headers
// may come from the client itself; that only makes its own cookies stricter.
func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(firstValue(r.Header.Get("X-Forwarded-Proto"))), "https") {
		return true
	}
	return strings.Contains(strings.ReplaceAll(r.Header.Get("Cf-Visitor"), " ", ""), `"scheme":"https"`)
}

func mwHTTPSHardening(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requestIsHTTPS(r) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		// Session cookies are only set below /api/v1/users (login, refresh,
		// logout, OIDC). Other routes keep the original writer (websockets).
		if strings.HasPrefix(r.URL.Path, "/api/v1/users/") {
			w = &secureCookieWriter{ResponseWriter: w}
		}
		next.ServeHTTP(w, r)
	})
}

type secureCookieWriter struct {
	http.ResponseWriter
	done bool
}

func (w *secureCookieWriter) secure() {
	if w.done {
		return
	}
	w.done = true
	cookies := w.Header().Values("Set-Cookie")
	if len(cookies) == 0 {
		return
	}
	w.Header().Del("Set-Cookie")
	for _, c := range cookies {
		if !strings.Contains(strings.ToLower(c), "; secure") {
			c += "; Secure"
		}
		w.Header().Add("Set-Cookie", c)
	}
}

func (w *secureCookieWriter) WriteHeader(code int) {
	w.secure()
	w.ResponseWriter.WriteHeader(code)
}

func (w *secureCookieWriter) Write(b []byte) (int, error) {
	w.secure()
	return w.ResponseWriter.Write(b)
}

func (w *secureCookieWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
