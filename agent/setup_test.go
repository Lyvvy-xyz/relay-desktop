package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testHost = "127.0.0.1:5555"

func setupRequest(method, path, token, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Host = testHost
	if token != "" {
		request.Header.Set("X-Setup-Token", token)
	}
	return request
}

func serve(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestTheSetupPageNeedsTheTokenFromTheOpenedLink(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	handler := setupHandler(testHost, "secret", make(chan struct{}))

	if got := serve(handler, setupRequest("GET", "/?t=secret", "", "")); got.Code != http.StatusOK ||
		!strings.Contains(got.Body.String(), "Relay setup") {
		t.Fatalf("page with token: %d", got.Code)
	}
	if got := serve(handler, setupRequest("GET", "/?t=guess", "", "")).Code; got != http.StatusForbidden {
		t.Fatalf("page without the right token: %d", got)
	}
	if got := serve(handler, setupRequest("POST", "/api/screenshots", "", `{"on":true}`)).Code; got != http.StatusForbidden {
		t.Fatalf("api call without token: %d", got)
	}
}

func TestARequestForAnotherHostIsRefused(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	handler := setupHandler(testHost, "secret", make(chan struct{}))
	request := setupRequest("GET", "/api/state", "secret", "")
	request.Host = "evil.example:5555" // DNS rebinding points another name at 127.0.0.1
	if got := serve(handler, request).Code; got != http.StatusForbidden {
		t.Fatalf("rebinding host: %d", got)
	}
}

func TestSettingsChangedOnThePageAreSaved(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	folder := t.TempDir()
	handler := setupHandler(testHost, "secret", make(chan struct{}))

	serve(handler, setupRequest("POST", "/api/screenshots", "secret", `{"on":true}`))
	added := serve(handler, setupRequest("POST", "/api/folders", "secret", `{"folder":"`+folder+`","approve":true}`))
	if added.Code != http.StatusOK {
		t.Fatalf("adding a folder: %d %s", added.Code, added.Body)
	}
	settings, err := loadConfig()
	if err != nil || !settings.Screenshots || len(settings.Folders) != 1 {
		t.Fatalf("saved %+v, %v", settings, err)
	}
	finish := serve(handler, setupRequest("POST", "/api/finish", "secret", `{}`))
	if finish.Code != http.StatusBadRequest || !strings.Contains(finish.Body.String(), "pair") {
		t.Fatalf("finishing before pairing: %d %s", finish.Code, finish.Body)
	}
}

func TestTheFontsAndFrogAreServedAndOnlyDoneEndsSetup(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	finished := make(chan struct{})
	handler := setupHandler(testHost, "secret", finished)
	for _, asset := range []string{"/assets/archivo.woff2", "/assets/dm-mono-500.woff2", "/assets/frog.png"} {
		if got := serve(handler, setupRequest("GET", asset, "", "")); got.Code != http.StatusOK || got.Body.Len() == 0 {
			t.Fatalf("%s: %d", asset, got.Code)
		}
	}
	serve(handler, setupRequest("POST", "/api/finish", "secret", `{}`))
	select {
	case <-finished:
		t.Fatal("setup ended before the person clicked Done")
	default:
	}
	if got := serve(handler, setupRequest("POST", "/api/close", "secret", `{}`)); got.Code != http.StatusOK {
		t.Fatalf("close: %d", got.Code)
	}
	serve(handler, setupRequest("POST", "/api/close", "secret", `{}`)) // a second click is harmless
	<-finished
}

func TestAnAddressBehindASignInPageSaysSoInsteadOfPairing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	signIn := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/login" {
			_, _ = writer.Write([]byte("<html>sign in</html>"))
			return
		}
		http.Redirect(writer, request, "/login", http.StatusFound)
	}))
	defer signIn.Close()
	err := pair(config{}, signIn.URL, "ABCD2345")
	if err == nil || !strings.Contains(err.Error(), "home network") {
		t.Fatalf("got %v", err)
	}
}
