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

// resolveExisting returns the absolute path with symlinks resolved, so a link inside an approved
// folder can't point elsewhere.
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

// approvedPath resolves path and accepts it only inside an approved folder. For a new file, its
// parent folder must exist and is checked instead.
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

// writeFile won't overwrite an existing file in an approved folder. Files the user sent from the
// buddy (editable) are the exception: projects can save changes back to them, and the old version
// is kept in the replaced folder first.
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

// replacedFolder holds overwritten versions. A variable so tests can change it.
var replacedFolder = func() (string, error) {
	path, err := configPath()
	return filepath.Join(filepath.Dir(path), "replaced"), err
}

// keepReplaced copies a file into the replaced folder, timestamped, before it's overwritten. Does
// nothing if the file doesn't exist yet.
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
