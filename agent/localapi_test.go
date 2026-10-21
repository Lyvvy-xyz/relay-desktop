package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const buddyHost = "127.0.0.1:6000"

func testAPI(t *testing.T, dashboard *httptest.Server) localAPI {
	t.Helper()
	var lastCheck atomic.Int64
	return localAPI{
		settings: config{Server: dashboard.URL, Token: "device-token", Machine: "owner-pc"},
		client:   dashboard.Client(), token: "buddy-secret", host: buddyHost, lastCheck: &lastCheck,
	}
}

func buddyRequest(method, path, token string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, path, body)
	request.Host = buddyHost
	if token != "" {
		request.Header.Set("X-Buddy-Token", token)
	}
	return request
}

func TestTheBuddyReachesOnlyTheProjectRoutesWithTheDeviceToken(t *testing.T) {
	var seen []string
	dashboard := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seen = append(seen, request.Method+" "+request.URL.RequestURI()+" "+request.Header.Get("Authorization"))
		_, _ = io.WriteString(writer, `{"ok":true}`)
	}))
	defer dashboard.Close()
	handler := testAPI(t, dashboard).handler()

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, buddyRequest("GET", "/projects/ops/events?cursor=a:3", "buddy-secret", nil))
	if recorder.Code != http.StatusOK || len(seen) != 1 ||
		seen[0] != "GET /agent/projects/ops/events?cursor=a:3 Bearer device-token" {
		t.Fatalf("forwarded %v, status %d", seen, recorder.Code)
	}
	for _, path := range []string{
		"/jobs/next", "/projects/../pair", "/broker/machines", "/projects/OPS/messages",
		"/buddy/latest.json", "/buddy/files/../config.json",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, buddyRequest("GET", path, "buddy-secret", nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s reached the dashboard: %d", path, recorder.Code)
		}
	}
	if len(seen) != 1 {
		t.Fatalf("refused paths still reached the dashboard: %v", seen)
	}
}

func TestTheBuddyNeedsItsSecretAndTheLocalHost(t *testing.T) {
	dashboard := httptest.NewServer(http.NotFoundHandler())
	defer dashboard.Close()
	handler := testAPI(t, dashboard).handler()
	for name, request := range map[string]*http.Request{
		"no secret":    buddyRequest("GET", "/status", "", nil),
		"wrong secret": buddyRequest("GET", "/status", "guess", nil),
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, recorder.Code)
		}
	}
	rebound := buddyRequest("GET", "/status", "buddy-secret", nil)
	rebound.Host = "evil.example:6000"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, rebound)
	if recorder.Code != http.StatusForbidden {
		t.Errorf("rebinding host: %d", recorder.Code)
	}
}

func TestStatusNeverHandsTheDeviceTokenToTheBuddy(t *testing.T) {
	dashboard := httptest.NewServer(http.NotFoundHandler())
	defer dashboard.Close()
	recorder := httptest.NewRecorder()
	testAPI(t, dashboard).handler().ServeHTTP(recorder, buddyRequest("GET", "/status", "buddy-secret", nil))
	if recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), "device-token") ||
		!strings.Contains(recorder.Body.String(), "owner-pc") {
		t.Fatalf("status: %d %s", recorder.Code, recorder.Body)
	}
}

func TestOnlyTheBuddysOwnOriginsGetCrossOriginAccess(t *testing.T) {
	dashboard := httptest.NewServer(http.NotFoundHandler())
	defer dashboard.Close()
	handler := testAPI(t, dashboard).handler()
	for origin, allowed := range map[string]bool{
		"http://tauri.localhost": true, "tauri://localhost": true, "https://evil.example": false,
	} {
		preflight := buddyRequest("OPTIONS", "/status", "", nil)
		preflight.Header.Set("Origin", origin)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, preflight)
		got := recorder.Header().Get("Access-Control-Allow-Origin") == origin
		if got != allowed {
			t.Errorf("%s: cross-origin allowed=%v, want %v (status %d)", origin, got, allowed, recorder.Code)
		}
	}
}

func TestSendingFromTheBuddyMakesThePathEditableForAWeek(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	folder := t.TempDir()
	handler := testAPI(t, httptest.NewServer(http.NotFoundHandler())).handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, buddyRequest("POST", "/dropped", "buddy-secret", strings.NewReader(`{"paths":["`+folder+`"]}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("granting: %d %s", response.Code, response.Body)
	}
	settings, _ := loadConfig()
	now := time.Now()
	if editable := settings.editable(now); len(editable) != 1 {
		t.Fatalf("editable now: %v", editable)
	}
	if editable := settings.editable(now.Add(droppedFor + time.Minute)); len(editable) != 0 {
		t.Fatalf("still editable after the week: %v", editable)
	}
}
