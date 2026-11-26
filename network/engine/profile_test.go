package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLogoutLeavesSymlinkTargetIntact(t *testing.T) {
	parent := t.TempDir()
	outside := filepath.Join(parent, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(outside, "unrelated")
	if err := os.WriteFile(sentinel, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	spec := installation{dir: filepath.Join(parent, "installation"), role: "mac"}
	p, err := spec.openProfile("")
	if err != nil {
		t.Fatal(err)
	}
	p.close()
	if err := os.Remove(p.accountPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, p.accountPath); err != nil {
		t.Fatal(err)
	}

	e := newEngine("")
	req, err := json.Marshal(request{Op: "logout", Dir: spec.dir, Role: spec.role})
	if err != nil {
		t.Fatal(err)
	}
	var got reply
	if err := json.Unmarshal([]byte(e.call(string(req))), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.RemoteRevoked == nil || *got.RemoteRevoked || got.Warning != "remote-revocation-unconfirmed" {
		t.Fatal("stopped logout must report local success and unconfirmed remote revocation")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("logout reached outside its private account tree: %v", err)
	}
	if _, err := os.Lstat(p.accountPath); !os.IsNotExist(err) {
		t.Fatalf("stale private account link remains: %v", err)
	}
}
