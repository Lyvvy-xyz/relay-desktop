package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func approvedTree(t *testing.T) (approved string, outside string) {
	t.Helper()
	root := t.TempDir()
	approved = filepath.Join(root, "approved")
	outside = filepath.Join(root, "outside")
	for _, folder := range []string{approved, outside} {
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(approved, "notes.txt"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	return approved, outside
}

func TestReadsInsideAnApprovedFolder(t *testing.T) {
	approved, _ := approvedTree(t)
	content, err := readFile([]string{approved}, filepath.Join(approved, "notes.txt"))
	if err != nil || string(content) != "inside" {
		t.Fatalf("got %q, %v", content, err)
	}
}

func TestRefusesEverythingThatEscapes(t *testing.T) {
	approved, outside := approvedTree(t)
	if err := os.Symlink(outside, filepath.Join(approved, "link")); err != nil {
		t.Fatal(err)
	}
	folders := []string{approved}
	for _, path := range []string{
		filepath.Join(outside, "secret.txt"),
		filepath.Join(approved, "..", "outside", "secret.txt"),
		filepath.Join(approved, "link", "secret.txt"),
		approved + "-sibling",
	} {
		if _, err := readFile(folders, path); err == nil {
			t.Errorf("read %s, want refusal", path)
		}
	}
	if err := writeFile(folders, nil, filepath.Join(approved, "link", "dropped.txt"), []byte("x")); err == nil {
		t.Error("wrote through a symlink out of the approved folder")
	}
}

func TestWritesNewFilesButNeverOverwrites(t *testing.T) {
	approved, _ := approvedTree(t)
	folders := []string{approved}
	target := filepath.Join(approved, "report.txt")
	if err := writeFile(folders, nil, target, []byte("report")); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(folders, nil, target, []byte("replaced")); err == nil ||
		!strings.Contains(err.Error(), "already exists") {
		t.Fatalf("overwrote an existing file: %v", err)
	}
	if content, _ := os.ReadFile(target); string(content) != "report" {
		t.Fatalf("file changed to %q", content)
	}
}

func TestNothingIsApprovedByDefault(t *testing.T) {
	approved, _ := approvedTree(t)
	if _, err := readFile(nil, filepath.Join(approved, "notes.txt")); err != errOutsideApproved {
		t.Fatalf("want refusal with no approved folders, got %v", err)
	}
}

func TestListingShowsTheFolderContents(t *testing.T) {
	approved, _ := approvedTree(t)
	listing, err := listFolder([]string{approved}, approved)
	if err != nil || !strings.Contains(string(listing), "notes.txt") {
		t.Fatalf("got %s, %v", listing, err)
	}
}

func TestDroppedFilesAreSavedBackWithTheOldVersionKept(t *testing.T) {
	approved, outside := approvedTree(t)
	kept := t.TempDir()
	replacedFolder = func() (string, error) { return kept, nil }
	secret := filepath.Join(outside, "secret.txt")
	if err := writeFile([]string{approved}, []string{secret}, secret, []byte("edited")); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(secret); string(content) != "edited" {
		t.Fatalf("file is %q", content)
	}
	backups, _ := os.ReadDir(kept)
	if len(backups) != 1 {
		t.Fatalf("want the old version kept, found %d", len(backups))
	}
	if old, _ := os.ReadFile(filepath.Join(kept, backups[0].Name())); string(old) != "outside" {
		t.Fatalf("kept %q", old)
	}
}

func TestADroppedFolderIsEditableButItsNeighboursAreNot(t *testing.T) {
	approved, outside := approvedTree(t)
	replacedFolder = func() (string, error) { return t.TempDir(), nil }
	editable := []string{outside}
	if err := writeFile(nil, editable, filepath.Join(outside, "new.txt"), []byte("new")); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(nil, editable, filepath.Join(approved, "notes.txt"), []byte("x")); err == nil {
		t.Fatal("wrote outside the dropped folder")
	}
	if err := writeFile([]string{approved}, editable, filepath.Join(approved, "notes.txt"), []byte("x")); err == nil {
		t.Fatal("overwrote a file in an approved folder")
	}
}
