package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// captureScreen takes a PNG of the whole screen with the OS's own tool. The commands are fixed;
// only the temp output path varies.
func captureScreen() ([]byte, error) {
	output, err := os.CreateTemp("", "homelab-screenshot-*.png")
	if err != nil {
		return nil, err
	}
	path := output.Name()
	output.Close()
	defer os.Remove(path)
	if err := runCapture(path); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

const windowsCapture = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($i)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size)
$i.Save($env:HOMELAB_SHOT,[System.Drawing.Imaging.ImageFormat]::Png)`

func runCapture(path string) error {
	switch runtime.GOOS {
	case "windows":
		command := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", windowsCapture)
		command.Env = append(os.Environ(), "HOMELAB_SHOT="+path)
		return command.Run()
	case "darwin":
		return exec.Command("screencapture", "-x", path).Run()
	default:
		// Try Wayland, then GNOME, then X11.
		for _, candidate := range [][]string{
			{"grim", path},
			{"gnome-screenshot", "-f", path},
			{"import", "-window", "root", path},
			{"scrot", "-o", path},
		} {
			if _, lookErr := exec.LookPath(candidate[0]); lookErr == nil {
				return exec.Command(candidate[0], candidate[1:]...).Run()
			}
		}
		return errors.New("no screenshot tool found; install grim, gnome-screenshot, imagemagick or scrot")
	}
}

const windowsRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "lan.homelab.agent.plist")
}

// stopRunning stops a running agent so its executable can be replaced. Usually nothing is running,
// so errors are ignored.
func stopRunning() {
	switch runtime.GOOS {
	case "windows":
		// Skip ourselves: setup inside the buddy also runs as homelab-agent.exe.
		self := fmt.Sprintf("PID ne %d", os.Getpid())
		_ = exec.Command("taskkill", "/F", "/IM", "homelab-agent.exe", "/FI", self).Run()
	case "darwin":
		_ = exec.Command("launchctl", "unload", launchAgentPath()).Run()
	default:
		_ = exec.Command("systemctl", "--user", "stop", "homelab-agent.service").Run()
	}
}

// installAutostart runs the agent at login rather than as a system service, since screenshots need
// the desktop session and file access should be the user's. It also starts it now.
func installAutostart(executable string) error {
	switch runtime.GOOS {
	case "windows":
		// The per-user Run key needs no admin rights, unlike a scheduled task. conhost --headless
		// hides the console window.
		command := fmt.Sprintf(`conhost.exe --headless "%s" run`, executable)
		if err := exec.Command("reg", "add", windowsRunKey, "/v", "homelab-agent", "/t", "REG_SZ",
			"/d", command, "/f").Run(); err != nil {
			return err
		}
		quoted := strings.ReplaceAll(executable, "'", "''")
		start := fmt.Sprintf("Start-Process -FilePath '%s' -ArgumentList 'run' -WindowStyle Hidden", quoted)
		return exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", start).Run()
	case "darwin":
		plist := launchAgentPath()
		if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(plist, []byte(fmt.Sprintf(launchAgent, executable)), 0o644); err != nil {
			return err
		}
		return exec.Command("launchctl", "load", "-w", plist).Run()
	default:
		configHome, configErr := os.UserConfigDir()
		if configErr != nil {
			return configErr
		}
		unit := filepath.Join(configHome, "systemd", "user", "homelab-agent.service")
		if mkdirErr := os.MkdirAll(filepath.Dir(unit), 0o755); mkdirErr != nil {
			return mkdirErr
		}
		body := fmt.Sprintf(systemdUnit, executable)
		if writeErr := os.WriteFile(unit, []byte(body), 0o644); writeErr != nil {
			return writeErr
		}
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		return exec.Command("systemctl", "--user", "enable", "--now", "homelab-agent.service").Run()
	}
}

const launchAgent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>lan.homelab.agent</string>
<key>ProgramArguments</key><array><string>%s</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`

const systemdUnit = `[Unit]
Description=homelab agent

[Service]
ExecStart=%s run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`
