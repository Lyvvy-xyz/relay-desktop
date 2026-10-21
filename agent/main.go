// homelab-agent lets Relay projects reach this machine: list, read and write files inside
// folders approved here, and take screenshots if switched on here. It connects out to the
// dashboard and never listens on a port. What it may touch lives in a local config file the
// server cannot change, so a compromised server cannot widen it.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

const (
	pollInterval    = 3 * time.Second
	errorBackoff    = 30 * time.Second
	requestTimeout  = 2 * time.Minute
	maxTransfer     = 100 << 20
	configDirectory = "homelab-agent"
	configFileName  = "config.json"
	usage           = `homelab-agent - lets your Relay projects reach this machine

  (double-click, or run with no arguments, for guided setup)

  homelab-agent pair <dashboard-url> <code>   pair with a code from the dashboard's Machines page
  homelab-agent allow <folder>                approve a folder projects may read and write
  homelab-agent disallow <folder>             remove an approved folder
  homelab-agent screenshots on|off            allow or refuse screenshots (off by default)
  homelab-agent status                        show what this machine allows
  homelab-agent install                       start the agent at every login
  homelab-agent run                           check in for jobs (what install starts)
`
)

type config struct {
	Server      string    `json:"server"`
	Token       string    `json:"token"`
	Machine     string    `json:"machine"`
	Folders     []string  `json:"folders"`
	Screenshots bool      `json:"screenshots"`
	Dropped     []dropped `json:"dropped,omitempty"`
}

// dropped is a file or folder the person dropped on the buddy and sent to a project: projects
// may read it and save their changes back to it until the grant runs out.
type dropped struct {
	Path  string    `json:"path"`
	Until time.Time `json:"until"`
}

const droppedFor = 7 * 24 * time.Hour

// editable is every dropped path whose grant has not run out.
func (settings config) editable(now time.Time) []string {
	paths := []string{}
	for _, item := range settings.Dropped {
		if now.Before(item.Until) {
			paths = append(paths, item.Path)
		}
	}
	return paths
}

// grantDropped lets projects edit these paths for droppedFor from now, and forgets lapsed grants.
func grantDropped(paths []string, now time.Time) error {
	settings, err := loadConfig()
	if err != nil {
		return err
	}
	kept := settings.Dropped[:0]
	for _, item := range settings.Dropped {
		if now.Before(item.Until) && !slices.Contains(paths, item.Path) {
			kept = append(kept, item)
		}
	}
	for _, path := range paths {
		resolved, err := resolveExisting(path)
		if err != nil {
			return err
		}
		kept = append(kept, dropped{resolved, now.Add(droppedFor)})
	}
	settings.Dropped = kept
	return saveConfig(settings)
}

func configPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, configDirectory, configFileName), nil
}

func loadConfig() (config, error) {
	var loaded config
	path, err := configPath()
	if err != nil {
		return loaded, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return loaded, nil
	}
	if err != nil {
		return loaded, err
	}
	return loaded, json.Unmarshal(raw, &loaded)
}

func saveConfig(saved config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	// The device token is in here: owner-only, like an SSH key.
	return os.WriteFile(path, raw, 0o600)
}

func main() {
	log.SetFlags(log.LstdFlags)
	// No arguments means someone double-clicked it: walk them through setup in the window,
	// and keep the window open at the end so the outcome can be read.
	if len(os.Args) == 1 {
		if err := setUp(); err != nil {
			fmt.Println("\nSetup did not finish:", err)
			waitForEnter()
		}
		return
	}
	if err := dispatch(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func dispatch(arguments []string) error {
	settings, err := loadConfig()
	if err != nil {
		return fmt.Errorf("reading the config: %w", err)
	}
	switch command, rest := arguments[0], arguments[1:]; {
	case command == "pair" && len(rest) == 2:
		return pair(settings, rest[0], rest[1])
	case command == "allow" && len(rest) == 1:
		return changeFolders(settings, rest[0], true)
	case command == "disallow" && len(rest) == 1:
		return changeFolders(settings, rest[0], false)
	case command == "screenshots" && len(rest) == 1 && (rest[0] == "on" || rest[0] == "off"):
		settings.Screenshots = rest[0] == "on"
		return saveConfig(settings)
	case command == "status":
		return printStatus(settings)
	case command == "install":
		return install()
	case command == "run":
		return run(settings)
	case command == "setup-serve":
		return serveSetup(true)
	default:
		fmt.Print(usage)
		return errors.New("unknown command")
	}
}

func pair(settings config, server, code string) error {
	server = strings.TrimRight(server, "/")
	// Redirects are not followed: an address behind a sign-in page redirects to it, and following
	// would read the sign-in page as the answer.
	client := &http.Client{
		Timeout:       requestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.PostForm(server+"/agent/pair", url.Values{"code": {code}})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return fmt.Errorf("%s isn't the dashboard itself (it may be behind a sign-in page), so it can't pair. "+
			"Use the dashboard's address on your home network, like http://192.0.2.10:3000", server)
	}
	var reply struct {
		Machine string `json:"machine"`
		Token   string `json:"token"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		return fmt.Errorf("the dashboard answered %s", response.Status)
	}
	if response.StatusCode != http.StatusOK {
		return errors.New(reply.Error)
	}
	settings.Server, settings.Token, settings.Machine = server, reply.Token, reply.Machine
	if err := saveConfig(settings); err != nil {
		return err
	}
	fmt.Printf("Paired as %q.\n", reply.Machine)
	return nil
}

func changeFolders(settings config, folder string, approve bool) error {
	resolved, err := resolveExisting(folder)
	if err != nil {
		return err
	}
	kept := settings.Folders[:0]
	for _, existing := range settings.Folders {
		if existing != resolved {
			kept = append(kept, existing)
		}
	}
	if approve {
		if info, statErr := os.Stat(resolved); statErr != nil || !info.IsDir() {
			return fmt.Errorf("%s is not a folder", resolved)
		}
		kept = append(kept, resolved)
	}
	settings.Folders = kept
	return saveConfig(settings)
}

func printStatus(settings config) error {
	path, _ := configPath()
	fmt.Printf("config:      %s\nmachine:     %s\nserver:      %s\nscreenshots: %v\nfolders:\n",
		path, settings.Machine, settings.Server, settings.Screenshots)
	for _, folder := range settings.Folders {
		fmt.Println("  ", folder)
	}
	return nil
}

type job struct {
	ID         string `json:"id"`
	Verb       string `json:"verb"`
	Argument   string `json:"argument"`
	HasPayload bool   `json:"has_payload"`
}

type agent struct {
	settings config
	client   *http.Client
}

func run(settings config) error {
	if settings.Token == "" {
		return errors.New("not paired yet: run `homelab-agent pair <dashboard-url> <code>` first")
	}
	worker := agent{settings: settings, client: &http.Client{Timeout: requestTimeout}}
	var lastCheck atomic.Int64
	if err := startLocalAPI(settings, &lastCheck); err != nil {
		log.Printf("the desktop buddy cannot connect: %v", err)
	}
	log.Printf("checking in with %s as %s", settings.Server, settings.Machine)
	for {
		next, err := worker.nextJob()
		if err == nil {
			lastCheck.Store(time.Now().Unix())
		}
		switch {
		case err != nil:
			log.Printf("check-in failed: %v", err)
			time.Sleep(errorBackoff)
		case next == nil:
			time.Sleep(pollInterval)
		default:
			worker.handle(*next)
		}
	}
}

func (worker agent) request(method, path string, body io.Reader, contentType string) (*http.Response, error) {
	request, err := http.NewRequest(method, worker.settings.Server+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+worker.settings.Token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return worker.client.Do(request)
}

func (worker agent) nextJob() (*job, error) {
	response, err := worker.request(http.MethodGet, "/agent/jobs/next", nil, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		var next job
		return &next, json.NewDecoder(response.Body).Decode(&next)
	case http.StatusUnauthorized:
		return nil, errors.New("the dashboard no longer knows this machine; pair it again")
	default:
		return nil, fmt.Errorf("the dashboard answered %s", response.Status)
	}
}

func (worker agent) handle(next job) {
	log.Printf("job %s: %s %s", next.ID, next.Verb, next.Argument)
	result, err := worker.perform(next)
	if err != nil {
		log.Printf("job %s refused: %v", next.ID, err)
		worker.report(next.ID, "failure", strings.NewReader(url.Values{"error": {err.Error()}}.Encode()),
			"application/x-www-form-urlencoded")
		return
	}
	worker.report(next.ID, "result", bytes.NewReader(result), "application/octet-stream")
}

func (worker agent) perform(next job) ([]byte, error) {
	// Re-read, so folders, screenshots and drops changed since the agent started apply at once.
	settings, err := loadConfig()
	if err != nil || settings.Token == "" {
		settings = worker.settings
	}
	editable := settings.editable(time.Now())
	readable := append(append([]string{}, settings.Folders...), editable...)
	switch next.Verb {
	case "list":
		return listFolder(readable, next.Argument)
	case "read":
		return readFile(readable, next.Argument)
	case "write":
		payload, err := worker.payload(next.ID)
		if err != nil {
			return nil, err
		}
		return nil, writeFile(settings.Folders, editable, next.Argument, payload)
	case "screenshot":
		if !settings.Screenshots {
			return nil, errors.New("screenshots are switched off on this machine")
		}
		return captureScreen()
	default:
		return nil, fmt.Errorf("this agent does not do %q", next.Verb)
	}
}

func (worker agent) payload(jobID string) ([]byte, error) {
	response, err := worker.request(http.MethodGet, "/agent/jobs/"+jobID+"/payload", nil, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("could not fetch the file to write: %s", response.Status)
	}
	return io.ReadAll(io.LimitReader(response.Body, maxTransfer))
}

func (worker agent) report(jobID, outcome string, body io.Reader, contentType string) {
	response, err := worker.request(http.MethodPost, "/agent/jobs/"+jobID+"/"+outcome, body, contentType)
	if err != nil {
		log.Printf("job %s: could not report back: %v", jobID, err)
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		log.Printf("job %s: the dashboard answered %s", jobID, response.Status)
	}
}
