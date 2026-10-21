package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var errOutsideApproved = errors.New("that path is outside this machine's approved folders")

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, path[1:]), nil
	}
	return path, nil
}

// resolveExisting turns a path into its absolute, symlink-free form, so a link inside an
// approved folder cannot point the agent somewhere else.
func resolveExisting(path string) (string, error) {
	expanded, err := expandHome(path)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

func within(folder, path string) bool {
	relative, err := filepath.Rel(folder, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative)
}

// approvedPath resolves path and accepts it only inside an approved folder. For a file that does
// not exist yet (a write), its parent folder is resolved instead and must already exist.
func approvedPath(folders []string, path string, mustExist bool) (string, error) {
	resolved, err := resolveExisting(path)
	if err != nil && !mustExist && errors.Is(err, os.ErrNotExist) {
		expanded, expandErr := expandHome(path)
		if expandErr != nil {
			return "", expandErr
		}
		absolute, absErr := filepath.Abs(expanded)
		if absErr != nil {
			return "", absErr
		}
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(absolute))
		if parentErr != nil {
			return "", parentErr
		}
		resolved, err = filepath.Join(parent, filepath.Base(absolute)), nil
	}
	if err != nil {
		return "", err
	}
	for _, folder := range folders {
		if approved, folderErr := filepath.EvalSymlinks(folder); folderErr == nil && within(approved, resolved) {
			return resolved, nil
		}
	}
	return "", errOutsideApproved
}

type entry struct {
	Name     string    `json:"name"`
	IsFolder bool      `json:"is_folder"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func listFolder(folders []string, path string) ([]byte, error) {
	resolved, err := approvedPath(folders, path, true)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(resolved)
	if err != nil {
		return nil, err
	}
	listing := make([]entry, 0, len(items))
	for _, item := range items {
		info, infoErr := item.Info()
		if infoErr != nil {
			continue
		}
		listing = append(listing, entry{item.Name(), item.IsDir(), info.Size(), info.ModTime()})
	}
	return json.MarshalIndent(map[string]any{"folder": resolved, "entries": listing}, "", " ")
}

func readFile(folders []string, path string) ([]byte, error) {
	resolved, err := approvedPath(folders, path, true)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if info, statErr := file.Stat(); statErr != nil || info.IsDir() {
		return nil, errors.New("that is a folder; list it instead")
	}
	content, err := io.ReadAll(io.LimitReader(file, maxTransfer+1))
	if len(content) > maxTransfer {
		return nil, fmt.Errorf("files over %d MB are refused", maxTransfer>>20)
	}
	return content, err
}

// writeFile never overwrites inside an approved folder: a project putting a file on your machine
// should not be able to replace one you already have. The exception is what you dropped on the
// buddy and sent (editable): a project may save its changes back there, and the version it
// replaces is kept in the agent's replaced folder first.
func writeFile(folders, editable []string, path string, content []byte) error {
	resolved, err := approvedPath(append(append([]string{}, folders...), editable...), path, false)
	if err != nil {
		return err
	}
	if _, err := approvedPath(editable, resolved, false); err == nil {
		if err := keepReplaced(resolved); err != nil {
			return fmt.Errorf("could not keep the old version, so nothing was changed: %w", err)
		}
		return os.WriteFile(resolved, content, 0o644)
	}
	file, err := os.OpenFile(resolved, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already exists; pick another name", resolved)
	}
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// replacedFolder is where overwritten files are kept; a variable so tests can point it elsewhere.
var replacedFolder = func() (string, error) {
	path, err := configPath()
	return filepath.Join(filepath.Dir(path), "replaced"), err
}

// keepReplaced copies a file about to be overwritten into the replaced folder, stamped so every
// version is kept. A file that does not exist yet has nothing to keep.
func keepReplaced(path string) error {
	old, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	folder, err := replacedFolder()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return err
	}
	name := time.Now().Format("20060102-150405.000") + "-" + filepath.Base(path)
	return os.WriteFile(filepath.Join(folder, name), old, 0o600)
}
