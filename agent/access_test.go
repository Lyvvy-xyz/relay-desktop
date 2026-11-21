package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func withBuildCredentials(t *testing.T, id, secret string) {
	t.Helper()
	previousID, previousSecret := accessClientID, accessClientSecret
	accessClientID, accessClientSecret = id, secret
	t.Cleanup(func() { accessClientID, accessClientSecret = previousID, previousSecret })
}

func TestEveryRequestToTheDashboardCarriesTheAccessCredentials(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	withBuildCredentials(t, "client-id.access", "client-secret")
	var missing []string
	dashboard := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("CF-Access-Client-Id") != "client-id.access" ||
			request.Header.Get("CF-Access-Client-Secret") != "client-secret" {
			missing = append(missing, request.URL.Path)
		}
		if request.URL.Path == "/agent/pair" && request.FormValue("code") != "ABCD2345" {
			missing = append(missing, "pairing code")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"machine":"owner-pc","token":"device-token"}`)
	}))
	defer dashboard.Close()

	if err := pair(config{}, dashboard.URL, "ABCD2345"); err != nil {
		t.Fatal(err)
	}
	worker := agent{settings: config{Server: dashboard.URL, Token: "device-token"}, client: dashboard.Client()}
	if response, err := worker.request(http.MethodGet, "/agent/jobs/next", nil, ""); err != nil {
		t.Fatal(err)
	} else {
		response.Body.Close()
	}
	recorder := httptest.NewRecorder()
	testAPI(t, dashboard).handler().ServeHTTP(recorder, buddyRequest("GET", "/projects", "buddy-secret", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("buddy request: status %d", recorder.Code)
	}
	if len(missing) != 0 {
		t.Fatalf("sent without Access credentials: %v", missing)
	}
}

func TestABuildWithoutCredentialsSendsNoAccessHeaders(t *testing.T) {
	withBuildCredentials(t, "", "")
	request := withAccessCredentials(httptest.NewRequest(http.MethodGet, "/agent/jobs/next", nil))
	if request.Header.Get("CF-Access-Client-Id") != "" || request.Header.Get("CF-Access-Client-Secret") != "" {
		t.Fatalf("sent headers: %v", request.Header)
	}
}
