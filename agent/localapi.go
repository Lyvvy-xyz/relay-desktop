package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"
)

// Local API for the desktop buddy, so the device token never leaves the agent. It listens on
// 127.0.0.1 and every request needs the secret from an owner-only file.
const localAPIFileName = "local-api.json"

// Dashboard routes the buddy can reach through the agent. Everything else is refused.
var proxiedPath = regexp.MustCompile(`^/(activity|projects|projects/[a-z0-9][a-z0-9-]*/(messages|events|inbox))$`)

type localAPIInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

type localAPI struct {
	settings  config
	client    *http.Client
	token     string
	host      string
	lastCheck *atomic.Int64 // unix seconds of the last successful check-in
}

func startLocalAPI(settings config, lastCheck *atomic.Int64) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	secret := make([]byte, 24)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	api := localAPI{
		settings: settings, client: &http.Client{Timeout: requestTimeout},
		token: hex.EncodeToString(secret), host: listener.Addr().String(), lastCheck: lastCheck,
	}
	info := localAPIInfo{Port: listener.Addr().(*net.TCPAddr).Port, Token: api.token}
	if err := writeLocalAPIInfo(info); err != nil {
		return err
	}
	server := &http.Server{Handler: api.handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() { log.Printf("local api stopped: %v", server.Serve(listener)) }()
	return nil
}

func writeLocalAPIInfo(info localAPIInfo) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(filepath.Dir(path), localAPIFileName), raw, 0o600)
}

func (api localAPI) allowed(request *http.Request) bool {
	supplied := request.Header.Get("X-Buddy-Token")
	return request.Host == api.host && subtle.ConstantTimeCompare([]byte(supplied), []byte(api.token)) == 1
}

// Origins the buddy's pages are served from: tauri://localhost on macOS and Linux,
// http(s)://tauri.localhost on Windows. The secret is still required.
var buddyOrigins = map[string]bool{
	"tauri://localhost": true, "http://tauri.localhost": true, "https://tauri.localhost": true,
}

func (api localAPI) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if origin := request.Header.Get("Origin"); buddyOrigins[origin] {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Set("Vary", "Origin")
			if request.Method == http.MethodOptions {
				writer.Header().Set("Access-Control-Allow-Methods", "GET, POST")
				writer.Header().Set("Access-Control-Allow-Headers", "X-Buddy-Token, Content-Type")
				writer.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if !api.allowed(request) {
			reply(writer, http.StatusForbidden, map[string]string{"error": "not allowed"})
			return
		}
		switch {
		case request.URL.Path == "/status" && request.Method == http.MethodGet:
			api.status(writer)
		case request.URL.Path == "/capture" && request.Method == http.MethodPost:
			// The user asked for this one, so the screenshots setting (which is for projects)
			// doesn't apply.
			image, err := captureScreen()
			if err != nil {
				reply(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write(image)
		case request.URL.Path == "/dropped" && request.Method == http.MethodPost:
			// Files the user just sent: projects may now save changes back to them.
			var body struct {
				Paths []string `json:"paths"`
			}
			if err := json.NewDecoder(io.LimitReader(request.Body, 1<<20)).Decode(&body); err != nil {
				reply(writer, http.StatusBadRequest, map[string]string{"error": "unreadable request"})
				return
			}
			if err := grantDropped(body.Paths, time.Now()); err != nil {
				reply(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			reply(writer, http.StatusOK, map[string]bool{"ok": true})
		case proxiedPath.MatchString(request.URL.Path):
			api.forward(writer, request)
		default:
			reply(writer, http.StatusNotFound, map[string]string{"error": "unknown"})
		}
	})
}

func (api localAPI) status(writer http.ResponseWriter) {
	last := api.lastCheck.Load()
	// Re-read the config so changes made in setup show up straight away.
	settings, err := loadConfig()
	if err != nil || settings.Token == "" {
		settings = api.settings
	}
	reply(writer, http.StatusOK, map[string]any{
		"machine": settings.Machine, "server": settings.Server,
		"folders": settings.Folders, "screenshots": settings.Screenshots,
		"online": last > 0 && time.Since(time.Unix(last, 0)) < 3*errorBackoff,
	})
}

func (api localAPI) forward(writer http.ResponseWriter, request *http.Request) {
	target := api.settings.Server + "/agent" + request.URL.Path
	if request.URL.RawQuery != "" {
		target += "?" + request.URL.RawQuery
	}
	outgoing, err := http.NewRequest(request.Method, target, io.LimitReader(request.Body, maxTransfer+1<<20))
	if err != nil {
		reply(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	outgoing.Header.Set("Authorization", "Bearer "+api.settings.Token)
	if contentType := request.Header.Get("Content-Type"); contentType != "" {
		outgoing.Header.Set("Content-Type", contentType)
	}
	response, err := api.client.Do(outgoing)
	if err != nil {
		reply(writer, http.StatusBadGateway, map[string]string{"error": "the dashboard is not reachable: " + err.Error()})
		return
	}
	defer response.Body.Close()
	writer.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	writer.WriteHeader(response.StatusCode)
	_, _ = io.Copy(writer, response.Body)
}
