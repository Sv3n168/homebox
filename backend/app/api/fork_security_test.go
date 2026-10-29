package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/sysadminsmedia/homebox/backend/internal/sys/config"
)

func TestAuthRateLimiter_BackoffKeepsGrowingAfterLongLockout(t *testing.T) {
	l := newAuthRateLimiter(config.AuthRateLimit{
		Enabled: true, Window: time.Minute, MaxAttempts: 5, BaseBackoff: 10 * time.Second, MaxBackoff: 5 * time.Minute,
	})
	t.Cleanup(l.Stop)
	now := time.Unix(1_000_000, 0)
	key := "1.2.3.4|/api/v1/users/login"

	// Fail as soon as allowed until the lockout reaches its maximum.
	allowed := 0
	for i := 0; i < 40; i++ {
		st := l.state[key]
		if st != nil && now.Before(st.lockedUntil) {
			now = st.lockedUntil
		}
		_, ok := l.shouldAllow(key, now)
		require.True(t, ok)
		l.record(key, now, false)
		allowed++
	}
	// 40 attempts take hours now, not ~10 minutes per cycle of 11.
	elapsed := now.Sub(time.Unix(1_000_000, 0))
	assert.Greater(t, elapsed, 2*time.Hour, "lockouts keep their length")
	st := l.state[key]
	require.NotNil(t, st)
	assert.Equal(t, 5*time.Minute, st.lockedUntil.Sub(st.lastAttempt))

	// Only a quiet period longer than max_backoff after the lockout resets it.
	_, ok := l.shouldAllow(key, st.lockedUntil.Add(2*time.Minute))
	assert.True(t, ok)
	assert.NotNil(t, l.state[key], "a short pause does not reset the count")
	_, ok = l.shouldAllow(key, st.lockedUntil.Add(6*time.Minute))
	assert.True(t, ok)
	assert.Nil(t, l.state[key])
}

func TestAuthRateLimiter_WaitingOutShortLockoutsDoesNotReset(t *testing.T) {
	l := newAuthRateLimiter(config.AuthRateLimit{
		Enabled: true, Window: time.Minute, MaxAttempts: 5, BaseBackoff: 10 * time.Second, MaxBackoff: 5 * time.Minute,
	})
	t.Cleanup(l.Stop)
	now := time.Unix(2_000_000, 0)
	key := "1.2.3.4|/api/v1/users/login"
	// Attacker: as many tries as allowed, but pausing 70s after each lockout.
	tries := 0
	for end := now.Add(time.Hour); now.Before(end); {
		if st := l.state[key]; st != nil && now.Before(st.lockedUntil) {
			now = st.lockedUntil.Add(70 * time.Second)
			continue
		}
		if _, ok := l.shouldAllow(key, now); ok {
			l.record(key, now, false)
			tries++
		}
		now = now.Add(time.Second)
	}
	t.Logf("tries in one hour: %d", tries)
	assert.Less(t, tries, 30, "an hour of guessing gets only a handful of tries")
}

func TestClientIPHeader(t *testing.T) {
	t.Cleanup(func() { setClientIPHeader("") })
	r := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", nil)
	r.RemoteAddr = "172.18.0.5:5555"     // cloudflared
	r.Header.Set("X-Real-IP", "6.6.6.6") // passed through from the client
	r.Header.Set("Cf-Connecting-Ip", "203.0.113.7")

	setClientIPHeader("")
	assert.Equal(t, "172.18.0.5", extractClientIP(r, false))

	setClientIPHeader("CF-Connecting-IP")
	assert.Equal(t, "203.0.113.7", extractClientIP(r, false))
	assert.Equal(t, "203.0.113.7", extractClientIP(r, true), "wins over spoofable X-Real-IP")

	r.Header.Set("Cf-Connecting-Ip", "not an ip")
	assert.Equal(t, "172.18.0.5", extractClientIP(r, false))

	// Reaching the port directly from the internet: the header is ignored.
	r.RemoteAddr = "203.0.113.200:4444"
	r.Header.Set("Cf-Connecting-Ip", "198.51.100.1")
	assert.Equal(t, "203.0.113.200", extractClientIP(r, false))
}

func TestLoginsInFlightCapped(t *testing.T) {
	key := "1.2.3.4|/api/v1/users/login"
	require.True(t, enterLogin(key))
	require.True(t, enterLogin(key))
	assert.False(t, enterLogin(key), "a third parallel attempt waits")
	assert.True(t, enterLogin("5.6.7.8|/api/v1/users/login"), "other clients are not affected")
	leaveLogin(key)
	assert.True(t, enterLogin(key))
	leaveLogin(key)
	leaveLogin(key)
	leaveLogin("5.6.7.8|/api/v1/users/login")
	assert.Empty(t, loginsInFlight.n)
}

func TestHTTPSHardening(t *testing.T) {
	h := mwHTTPSHardening(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "hb.auth.session", Value: "x", HttpOnly: true})
		w.WriteHeader(http.StatusNoContent)
	}))

	run := func(proto string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", nil)
		if proto != "" {
			r.Header.Set("X-Forwarded-Proto", proto)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	plain := run("")
	assert.Empty(t, plain.Header().Get("Strict-Transport-Security"))
	assert.NotContains(t, plain.Header().Get("Set-Cookie"), "Secure")

	tls := run("https")
	assert.Equal(t, "max-age=31536000", tls.Header().Get("Strict-Transport-Security"))
	assert.Contains(t, tls.Header().Get("Set-Cookie"), "; Secure")
	assert.Contains(t, tls.Header().Get("Set-Cookie"), "HttpOnly")
}
