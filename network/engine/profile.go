package engine

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	profileName    = "twindesk-tsnet"
	identityName   = "installation-name"
	accountName    = "account"
	maxDeviceLabel = 28
)

var hostName = regexp.MustCompile(`^twindesk-(mac|ipad|android)-(?:([a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?)-)?([0-9a-f]{16})$`)
var deviceLabelSeparator = regexp.MustCompile(`[^a-z0-9]+`)

type installation struct {
	dir  string
	role string
}

func installationAt(dir, role string) (installation, error) {
	if role != "mac" && role != "ipad" && role != "android" {
		return installation{}, errors.New("invalid role")
	}
	if !filepath.IsAbs(dir) || dir != filepath.Clean(dir) || dir == "/" || len(dir) > 4096 || strings.ContainsRune(dir, 0) {
		return installation{}, errors.New("invalid private directory")
	}
	if info, err := os.Lstat(dir); err == nil {
		if !private(info, true) {
			return installation{}, errors.New("invalid directory permissions")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return installation{}, err
	}
	resolved, err := canonicalPath(dir)
	if err != nil {
		return installation{}, err
	}
	return installation{dir: resolved, role: role}, nil
}

// Resolve existing ancestors even when the platform's private app directory
// does not exist yet, so start and a later logout agree on its identity.
func canonicalPath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if !errors.Is(err, fs.ErrNotExist) || path == "/" {
		return resolved, err
	}
	parent, err := canonicalPath(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func private(info fs.FileInfo, dir bool) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 || info.Mode()&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky) != 0 {
		return false
	}
	if dir {
		return info.IsDir()
	}
	return info.Mode().IsRegular() && st.Nlink == 1
}

type profile struct {
	root        *os.Root
	lock        *os.File
	name        string
	accountPath string
}

func (i installation) openProfile(displayName string) (*profile, error) {
	return i.open(true, sanitizeDeviceLabel(displayName))
}

func (i installation) open(create bool, label string) (*profile, error) {
	if create {
		if err := os.MkdirAll(i.dir, 0700); err != nil {
			return nil, err
		}
	}
	info, err := os.Lstat(i.dir)
	if err != nil {
		return nil, err
	}
	if !private(info, true) {
		return nil, errors.New("unsafe private directory")
	}
	base, err := os.OpenRoot(i.dir)
	if err != nil {
		return nil, err
	}
	defer base.Close()
	actual, err := base.Stat(".")
	if err != nil || !os.SameFile(info, actual) {
		return nil, errors.New("private directory changed")
	}
	if create {
		if err := base.Mkdir(profileName, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
	}
	dirInfo, err := base.Lstat(profileName)
	if err != nil {
		return nil, err
	}
	if !private(dirInfo, true) {
		return nil, errors.New("unsafe profile directory")
	}
	root, err := base.OpenRoot(profileName)
	if err != nil {
		return nil, err
	}
	var lock *os.File
	done := false
	defer func() {
		if !done {
			if lock != nil {
				lock.Close()
			}
			root.Close()
		}
	}()
	actual, err = root.Stat(".")
	if err != nil || !os.SameFile(dirInfo, actual) {
		return nil, errors.New("profile directory changed")
	}
	flags := os.O_RDWR | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if create {
		flags |= os.O_CREATE
	}
	lock, err = root.OpenFile("lock", flags, 0600)
	if err != nil {
		return nil, accountMetadataError(root, err, create)
	}
	if lockInfo, err := lock.Stat(); err != nil || !private(lockInfo, false) {
		return nil, errors.New("unsafe profile lock")
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, err
	}

	name, err := i.profileIdentity(root, create, label)
	if err != nil {
		return nil, accountMetadataError(root, err, create)
	}
	if create {
		if err := root.Mkdir(accountName, 0700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		if err := checkAccount(root); err != nil {
			return nil, err
		}
	}
	done = true
	return &profile{root: root, lock: lock, name: name, accountPath: filepath.Join(i.dir, profileName, accountName)}, nil
}

// Missing metadata is harmless only when there is no account state to clear.
func accountMetadataError(root *os.Root, err error, create bool) error {
	if !create && errors.Is(err, fs.ErrNotExist) {
		if _, accountErr := root.Lstat(accountName); !errors.Is(accountErr, fs.ErrNotExist) {
			return errors.New("account without installation metadata")
		}
	}
	return err
}

func sanitizeDeviceLabel(raw string) string {
	label := strings.Trim(deviceLabelSeparator.ReplaceAllString(strings.ToLower(raw), "-"), "-")
	if len(label) > maxDeviceLabel {
		label = strings.TrimRight(label[:maxDeviceLabel], "-")
	}
	return label
}

func deviceLabel(name string) string {
	parts := hostName.FindStringSubmatch(name)
	if parts == nil {
		return ""
	}
	return parts[2]
}

func (i installation) profileIdentity(root *os.Root, create bool, label string) (string, error) {
	info, err := root.Lstat(identityName)
	if errors.Is(err, fs.ErrNotExist) && create {
		if _, err := root.Lstat(accountName); !errors.Is(err, fs.ErrNotExist) {
			return "", errors.New("account without installation identity")
		}
		var id [8]byte
		rand.Read(id[:])
		return i.writeIdentity(root, label, hex.EncodeToString(id[:]))
	}
	if err != nil {
		return "", err
	}
	if !private(info, false) || info.Size() > 63 {
		return "", errors.New("unsafe profile identity")
	}
	value, err := root.ReadFile(identityName)
	if err != nil {
		return "", err
	}
	name := string(value)
	parts := hostName.FindStringSubmatch(name)
	if parts == nil || parts[1] != i.role {
		return "", errors.New("profile identity role mismatch")
	}
	if create && label != "" && parts[2] == "" {
		return i.writeIdentity(root, label, parts[3])
	}
	return name, nil
}

func (i installation) writeIdentity(root *os.Root, label, suffix string) (string, error) {
	name := "twindesk-" + i.role + "-"
	if label != "" {
		name += label + "-"
	}
	name += suffix
	tempName := identityName + "-" + rand.Text()
	f, err := root.OpenFile(tempName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return "", err
	}
	defer root.Remove(tempName)
	_, writeErr := f.WriteString(name)
	if err := errors.Join(writeErr, f.Close()); err != nil {
		return "", err
	}
	if err := root.Rename(tempName, identityName); err != nil {
		return "", err
	}
	return name, nil
}

func checkAccount(root *os.Root) error {
	return fs.WalkDir(root.FS(), accountName, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !private(info, entry.IsDir()) {
			return errors.New("unsafe account entry")
		}
		return nil
	})
}

func (p *profile) removeAccount() error {
	return p.root.RemoveAll(accountName)
}

func (p *profile) close() {
	_ = p.lock.Close()
	_ = p.root.Close()
}

func (i installation) removeAccount() error {
	p, err := i.open(false, "")
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer p.close()
	return p.removeAccount()
}
