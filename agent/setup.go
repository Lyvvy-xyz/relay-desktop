package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// defaultServer is the dashboard address offered on the setup page; empty means ask for it.
var defaultServer = ""

//go:embed setup.html
var setupPage []byte

// The page's fonts and frog, so setup looks right with no internet connection.
//
//go:embed assets
var setupAssets embed.FS

const setupIdleLimit = 30 * time.Minute

func waitForEnter() {
	fmt.Print("\nPress Enter to close this window.")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

type suggestion struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

type setupState struct {
	Paired      bool         `json:"paired"`
	Machine     string       `json:"machine"`
	Server      string       `json:"server"`
	Folders     []string     `json:"folders"`
	Screenshots bool         `json:"screenshots"`
	Suggestions []suggestion `json:"suggestions"`
}

func currentState() (setupState, error) {
	settings, err := loadConfig()
	if err != nil {
		return setupState{}, err
	}
	server := settings.Server
	if server == "" {
		server = defaultServer
	}
	state := setupState{
		Paired: settings.Token != "", Machine: settings.Machine, Server: server,
		Folders: append([]string{}, settings.Folders...), Screenshots: settings.Screenshots,
		Suggestions: []suggestion{},
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return state, nil
	}
	approved := map[string]bool{}
	for _, folder := range settings.Folders {
		approved[folder] = true
	}
	for _, name := range []string{"Desktop", "Documents", "Downloads", "Pictures"} {
		resolved, resolveErr := resolveExisting(filepath.Join(home, name))
		if resolveErr == nil && !approved[resolved] {
			state.Suggestions = append(state.Suggestions, suggestion{name, resolved})
		}
	}
	return state, nil
}

// setUp serves the setup page on this computer only and opens it in the browser. The page is
// reachable just from 127.0.0.1, and every call must carry the random token from the opened
// link, so another website open in the same browser cannot drive it.
func setUp() error { return serveSetup(false) }

// serveSetup runs the setup page. inApp is the desktop buddy asking: it shows the page in its
// own window, so print the address on one machine-readable line instead of opening a browser.
func serveSetup(inApp bool) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	token := hex.EncodeToString(secret)
	host := listener.Addr().String()
	address := fmt.Sprintf("http://%s/?t=%s", host, token)
	finished := make(chan struct{})
	server := &http.Server{Handler: setupHandler(host, token, finished), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()

	if inApp {
		fmt.Println("SETUP_URL " + address)
	} else {
		fmt.Println("Relay machine setup is open in your browser.")
		fmt.Println("If it did not open, paste this address into your browser:")
		fmt.Println("  ", address)
		fmt.Println("\nKeep this window open until you click Done.")
		openBrowser(address)
	}

	select {
	case <-finished:
		time.Sleep(time.Second) // let the page receive its answer
	case <-time.After(setupIdleLimit):
		fmt.Println("Setup was left open too long and has stopped. Double-click the agent to start again.")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}

func setupHandler(host, token string, finished chan struct{}) http.Handler {
	mux := http.NewServeMux()
	var closeOnce sync.Once
	allowed := func(request *http.Request, supplied string) bool {
		// The Host check stops DNS rebinding; the token stops other pages in the browser.
		return request.Host == host && subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) == 1
	}
	mux.HandleFunc("GET /{$}", func(writer http.ResponseWriter, request *http.Request) {
		if !allowed(request, request.URL.Query().Get("t")) {
			http.Error(writer, "Open the address shown in the agent's window.", http.StatusForbidden)
			return
		}
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write(setupPage)
	})
	mux.Handle("GET /assets/", http.FileServerFS(setupAssets))
	api := func(path string, action func(body map[string]any) error) {
		mux.HandleFunc(path, func(writer http.ResponseWriter, request *http.Request) {
			if !allowed(request, request.Header.Get("X-Setup-Token")) {
				reply(writer, http.StatusForbidden, map[string]string{"error": "not allowed"})
				return
			}
			body := map[string]any{}
			if request.Method == http.MethodPost {
				if err := json.NewDecoder(io.LimitReader(request.Body, 1<<16)).Decode(&body); err != nil {
					reply(writer, http.StatusBadRequest, map[string]string{"error": "unreadable request"})
					return
				}
			}
			if action != nil {
				if err := action(body); err != nil {
					reply(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
			}
			state, err := currentState()
			if err != nil {
				reply(writer, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			reply(writer, http.StatusOK, state)
		})
	}
	api("GET /api/state", nil)
	api("POST /api/pair", func(body map[string]any) error {
		settings, err := loadConfig()
		if err != nil {
			return err
		}
		code, server := text(body, "code"), text(body, "server")
		if code == "" {
			return errors.New("type the pairing code from the dashboard")
		}
		if server == "" {
			server = defaultServer
		}
		if server == "" {
			return errors.New("type the dashboard address, such as http://192.0.2.10:3000")
		}
		return pair(settings, server, code)
	})
	api("POST /api/folders", func(body map[string]any) error {
		settings, err := loadConfig()
		if err != nil {
			return err
		}
		approve, _ := body["approve"].(bool)
		return changeFolders(settings, text(body, "folder"), approve)
	})
	api("POST /api/screenshots", func(body map[string]any) error {
		settings, err := loadConfig()
		if err != nil {
			return err
		}
		settings.Screenshots, _ = body["on"].(bool)
		return saveConfig(settings)
	})
	api("POST /api/finish", func(map[string]any) error {
		settings, err := loadConfig()
		if err != nil {
			return err
		}
		if settings.Token == "" {
			return errors.New("pair this computer first")
		}
		if err := install(); err != nil {
			return fmt.Errorf("could not start it in the background: %w", err)
		}
		fmt.Printf("Done: %q is running in the background.\n", settings.Machine)
		return nil
	})
	// Starting the agent leaves the page up for choosing folders; this is the person saying done.
	api("POST /api/close", func(map[string]any) error {
		closeOnce.Do(func() { close(finished) })
		return nil
	})
	return mux
}

func text(body map[string]any, key string) string {
	value, _ := body[key].(string)
	return value
}

func reply(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func openBrowser(address string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", address).Start()
	case "darwin":
		_ = exec.Command("open", address).Start()
	default:
		_ = exec.Command("xdg-open", address).Start()
	}
}

// install copies the agent next to its config, so autostart never points into Downloads,
// then registers and starts it.
func install() error {
	target, err := installedPath()
	if err != nil {
		return err
	}
	if err := copySelf(target); err != nil {
		return err
	}
	return installAutostart(target)
}

func installedPath() (string, error) {
	path, err := configPath()
	if err != nil {
		return "", err
	}
	name := "homelab-agent"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(path), name), nil
}

func copySelf(target string) error {
	source, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(source); resolveErr == nil {
		source = resolved
	}
	if same, _ := filepath.Abs(source); same == target {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	stopRunning()
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
