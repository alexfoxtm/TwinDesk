// Package engine owns the embedded TwinDesk node and the native JSON ABI.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"twindesk.local/embedded/mobileif"
	"tailscale.com/client/local"
	"tailscale.com/feature/buildfeatures"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
	"tailscale.com/wgengine/netstack"
)

const (
	appPort    = 47800
	apiTimeout = 5 * time.Second
	maxRequest = 16 * 1024
)

var defaultEngine = newEngine("")

// Call handles one native ABI request. Failure replies never contain backend
// error text, which can include credentials, peer details or state paths.
func Call(request string) string {
	return defaultEngine.call(request)
}

type request struct {
	Op          string `json:"op"`
	Dir         string `json:"dir"`
	Role        string `json:"role"`
	DisplayName string `json:"displayName"`
	Port        int    `json:"port"`
	Peer        string `json:"peer"`
	Handle      string `json:"handle"`
	SourcePort  int    `json:"sourcePort"`
	Generation  string `json:"generation"`
}

type reply struct {
	OK            bool        `json:"ok"`
	Error         string      `json:"error,omitempty"`
	State         string      `json:"state,omitempty"`
	Peers         []peerLabel `json:"peers,omitzero"`
	Name          string      `json:"name,omitempty"`
	DisplayName   string      `json:"displayName,omitempty"`
	SelfID        string      `json:"selfID,omitempty"`
	Account       string      `json:"account,omitempty"`
	Tailnet       string      `json:"tailnet,omitempty"`
	AuthURL       string      `json:"authURL,omitempty"`
	Port          int         `json:"port,omitempty"`
	Handle        string      `json:"handle,omitempty"`
	Token         string      `json:"token,omitempty"`
	Peer          string      `json:"peer,omitempty"`
	Generation    string      `json:"generation,omitempty"`
	RemoteRevoked *bool       `json:"remoteRevoked,omitempty"`
	Warning       string      `json:"warning,omitempty"`
}

type peerLabel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Online      bool   `json:"online"`
}

var success = reply{OK: true}

func failed(code string) reply { return reply{Error: code} }

type engine struct {
	mu         sync.Mutex
	lifecycle  sync.Mutex
	node       *node
	last       installation
	controlURL string
}

// controlURL is injected only by same-package tests. The ABI has no override.
func newEngine(controlURL string) *engine {
	if controlURL == "" {
		controlURL = ipn.DefaultControlURL
	}
	return &engine{controlURL: controlURL}
}

func (e *engine) call(raw string) string {
	var req request
	if len(raw) > maxRequest || json.Unmarshal([]byte(raw), &req) != nil {
		return `{"ok":false,"error":"bad-request"}`
	}
	data, _ := json.Marshal(e.dispatch(req))
	return string(data)
}

func (e *engine) dispatch(req request) reply {
	switch req.Op {
	case "start":
		return e.start(req.Dir, req.Role, req.DisplayName)
	case "stop":
		return e.stop(false, installation{})
	case "logout":
		if req.Dir == "" && req.Role == "" {
			return e.stop(true, installation{})
		}
		spec, err := installationAt(req.Dir, req.Role)
		if err != nil {
			return failed("invalid-installation")
		}
		return e.stop(true, spec)
	}

	e.mu.Lock()
	n := e.node
	e.mu.Unlock()
	if req.Op == "status" {
		if n == nil {
			return statusReply("stopped", "")
		}
		return n.status()
	}
	switch req.Op {
	case "login", "serve", "dial", "claimIngress":
		if n == nil {
			return failed("not-started")
		}
	case "unserve", "close":
		if n == nil {
			return success
		}
	default:
		return failed("bad-operation")
	}
	switch req.Op {
	case "login":
		return n.login()
	case "serve":
		return n.serve(req.Port)
	case "unserve":
		n.unserve()
	case "dial":
		return n.dial(req.Peer)
	case "claimIngress":
		return n.claimIngress(req.Port, req.SourcePort, req.Generation)
	case "close":
		n.closeBridge(req.Handle)
	}
	return success
}

func (e *engine) start(dir, role, displayName string) reply {
	spec, err := installationAt(dir, role)
	if err != nil {
		return failed("invalid-installation")
	}
	e.lifecycle.Lock()
	defer e.lifecycle.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.node != nil {
		if e.node.spec != spec {
			return failed("already-started")
		}
		e.node.mu.Lock()
		isFailed := e.node.state == "error"
		e.node.mu.Unlock()
		if isFailed {
			return failed("engine-error")
		}
		return success
	}
	ctx, cancel := context.WithCancel(context.Background())
	n := &node{
		spec: spec, state: "starting", ctx: ctx, cancel: cancel,
		ready: make(chan struct{}), bridges: make(map[string]*tunnel),
	}
	e.node = n
	e.last = spec
	go n.start(e.controlURL, displayName)
	return success
}

func (e *engine) stop(logout bool, requested installation) reply {
	e.lifecycle.Lock()
	defer e.lifecycle.Unlock()

	e.mu.Lock()
	n, spec := e.node, e.last
	e.mu.Unlock()
	if requested.dir != "" {
		if spec.dir != "" && spec != requested {
			return failed("installation-mismatch")
		}
		spec = requested
	}
	if n != nil {
		n.mu.Lock()
		n.closing = true
		n.revokeLocked()
		n.cancel()
		n.mu.Unlock()
		<-n.ready
		n.shutdown(logout)

		e.mu.Lock()
		e.node = nil
		e.mu.Unlock()
	} else if logout && spec.dir != "" {
		if err := spec.removeAccount(); err != nil {
			return failed("logout-state")
		}
	}
	if logout {
		if n != nil && n.logoutErr != nil {
			return failed("logout-state")
		}
		revoked := n != nil && n.remoteRevoked
		result := reply{OK: true, RemoteRevoked: &revoked}
		if !revoked {
			result.Warning = "remote-revocation-unconfirmed"
		}
		return result
	}
	return success
}

type node struct {
	spec   installation
	ctx    context.Context
	cancel context.CancelFunc
	ready  chan struct{}

	// The startup goroutine sets these before closing ready. Access from
	// live operations is synchronized by mu and shutdown waits for ready.
	profile *profile
	server  *tsnet.Server
	local   *local.Client
	stack   *netstack.Impl

	mu             sync.Mutex
	state          string
	name           string
	closing        bool
	loginPending   bool
	loginRequested bool
	serveSession   *serveSession
	bridges        map[string]*tunnel
	active         sync.WaitGroup
	shutdownOnce   sync.Once
	accountRemoved bool
	remoteRevoked  bool
	logoutErr      error
}

func (n *node) start(controlURL, displayName string) {
	if err := n.initialize(controlURL, displayName); err != nil {
		n.fail()
		close(n.ready)
		n.shutdown(false)
		return
	}
	close(n.ready)
	n.watch()
}

func (n *node) initialize(controlURL, displayName string) error {
	if buildfeatures.HasLogTail {
		return errors.New("embedded builds must omit logtail")
	}
	if controlURL == ipn.DefaultControlURL && buildfeatures.HasPortMapper {
		return errors.New("embedded builds must omit port mapping")
	}
	// tsnet reads these when no explicit credentials are configured.
	// Refuse inherited credentials instead of ever sending them to control.
	for _, key := range []string{
		"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET",
		"TS_CLIENT_ID", "TS_ID_TOKEN", "TS_AUDIENCE", "TSNET_FORCE_LOGIN",
	} {
		if os.Getenv(key) != "" {
			return errors.New("unexpected inherited provision credentials")
		}
	}
	p, err := n.spec.openProfile(displayName)
	if err != nil {
		return err
	}
	n.profile = p
	if err := n.ctx.Err(); err != nil {
		return err
	}
	n.server = &tsnet.Server{
		Dir: p.accountPath, Hostname: p.name, ControlURL: controlURL,
		UserLogf: logger.Discard, Logf: logger.Discard,
	}
	lc, err := startPrivateBackend(n.server, p.accountPath)
	if err != nil {
		return err
	}
	stack, ok := n.server.Sys().Netstack.Get().(*netstack.Impl)
	if !ok || !n.server.Sys().IsNetstack() {
		return errors.New("userspace stack unavailable")
	}
	mobileif.Attach(n.server.Sys().NetMon.Get())

	n.mu.Lock()
	n.name = p.name
	n.local = lc
	n.stack = stack
	n.mu.Unlock()
	return nil
}

// tsnet constructs its socket statistics logger synchronously during Start.
// Even when uploads are compiled out, its directory lookup otherwise touches
// the system state path or panics on Android, where there is no home or /tmp.
var sdkStartup sync.Mutex

func startPrivateBackend(server *tsnet.Server, privateDir string) (*local.Client, error) {
	sdkStartup.Lock()
	defer sdkStartup.Unlock()
	previous, existed := os.LookupEnv("TS_LOGS_DIR")
	if err := os.Setenv("TS_LOGS_DIR", privateDir); err != nil {
		return nil, err
	}
	defer func() {
		if existed {
			_ = os.Setenv("TS_LOGS_DIR", previous)
		} else {
			_ = os.Unsetenv("TS_LOGS_DIR")
		}
	}()
	return server.LocalClient()
}

func (n *node) watch() {
	flags := ipn.NotifyInitialState | ipn.NotifyNoPrivateKeys | ipn.NotifyNoNetMap
	watcher, err := n.local.WatchIPNBus(n.ctx, flags)
	if err == nil {
		defer watcher.Close()
		for {
			event, err := watcher.Next()
			if err != nil || event.ErrMessage != nil {
				break
			}
			if event.State != nil {
				state := backendState(event.State.String())
				if state == "error" {
					break
				}
				n.setState(state)
			}
		}
	}
	if n.ctx.Err() == nil {
		n.fail()
		n.shutdown(false)
	}
}

func backendState(state string) string {
	switch state {
	case "NoState", "Starting":
		return "starting"
	case "NeedsLogin":
		return "needsLogin"
	case "NeedsMachineAuth":
		return "needsApproval"
	case "Running":
		return "running"
	case "Stopped":
		return "stopped"
	default:
		return "error"
	}
}

func (n *node) setState(state string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing {
		return
	}
	resumeLogin := state == "needsLogin" && n.loginPending
	n.state = state
	if state != "running" {
		n.revokeLocked()
	}
	if state != "needsLogin" && state != "starting" {
		n.loginRequested = false
	}
	if state != "starting" {
		n.loginPending = false
	}
	if resumeLogin {
		n.loginRequested = true
		n.active.Go(func() { _ = n.loginInteractive() })
	}
}

func (n *node) fail() {
	n.setState("error")
}

func (n *node) shutdown(logout bool) {
	n.shutdownOnce.Do(func() {
		n.cancel()
		n.active.Wait()
		if logout && n.local != nil {
			ctx, cancel := context.WithTimeout(context.Background(), apiTimeout)
			status, err := n.local.StatusWithoutPeers(ctx)
			hadNodeKey := err == nil && status != nil && status.HaveNodeKey
			// LocalAPI returns success without a control RPC when no key is
			// present. Only an existing key plus SDK logout success confirms
			// key expiry in control; roster deletion is a separate operation.
			n.remoteRevoked = n.local.Logout(ctx) == nil && hadNodeKey
			cancel()
		}
		if n.server != nil {
			if sys := n.server.Sys(); sys != nil {
				if monitor, ok := sys.NetMon.GetOK(); ok {
					mobileif.Detach(monitor)
				}
			}
			_ = n.server.Close()
		}
		if logout && n.profile != nil {
			n.logoutErr = n.profile.removeAccount()
			n.accountRemoved = true
		}
		if n.profile != nil {
			n.profile.close()
		}
	})
	// The worker may have already closed the server after a fatal error.
	// Local logout must still clear the account of that installation.
	if logout && !n.accountRemoved {
		n.logoutErr = n.spec.removeAccount()
	}
}

func statusReply(state, name string) reply {
	return reply{OK: true, State: state, Name: name, DisplayName: deviceLabel(name), Peers: []peerLabel{}}
}

func (n *node) status() reply {
	n.mu.Lock()
	if n.closing {
		n.mu.Unlock()
		return statusReply("stopped", "")
	}
	if n.local == nil || n.state == "error" {
		result := statusReply(n.state, n.name)
		n.mu.Unlock()
		return result
	}
	n.active.Add(1)
	n.mu.Unlock()
	defer n.active.Done()

	ctx, cancel := context.WithTimeout(n.ctx, apiTimeout)
	defer cancel()
	st, err := n.local.Status(ctx)
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing {
		return statusReply("stopped", "")
	}
	result := statusReply(n.state, n.name)
	if n.state == "error" || err != nil || st == nil || n.state != backendState(st.BackendState) {
		return result
	}
	if result.State == "needsLogin" && n.loginRequested && validAuthURL(st.AuthURL) {
		result.AuthURL = st.AuthURL
	}
	if result.State != "running" {
		return result
	}
	if st.CurrentTailnet != nil {
		result.Tailnet = st.CurrentTailnet.Name
	}
	if st.Self != nil {
		result.SelfID = string(st.Self.ID)
		result.Account = st.User[st.Self.UserID].LoginName
	}
	if n.spec.role != "mac" {
		result.Peers = macPeers(st)
	}
	return result
}

func (n *node) login() reply {
	n.mu.Lock()
	if n.closing {
		n.mu.Unlock()
		return failed("login-cancelled")
	}
	switch n.state {
	case "starting":
		n.loginPending = true
		n.mu.Unlock()
		return success
	case "running", "needsApproval":
		n.mu.Unlock()
		return success
	case "needsLogin":
		n.loginRequested = true
		n.active.Add(1)
	default:
		n.mu.Unlock()
		return failed("not-ready-for-login")
	}
	n.mu.Unlock()
	defer n.active.Done()
	return n.loginInteractive()
}

func (n *node) loginInteractive() reply {
	ctx, cancel := context.WithTimeout(n.ctx, apiTimeout)
	defer cancel()
	status, err := n.local.StatusWithoutPeers(ctx)
	if err != nil || status == nil {
		return failed("login-failed")
	}
	// A deferred request may run after an existing session restored.
	// Never turn that restore into an interactive reauthentication.
	if status.BackendState != "NeedsLogin" {
		return success
	}
	if err := n.local.StartLoginInteractive(ctx); err != nil {
		return failed("login-failed")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing || n.state == "error" {
		return failed("login-cancelled")
	}
	if n.state == "needsLogin" {
		n.loginRequested = true
	}
	return success
}

var loginPath = regexp.MustCompile(`^/a/[A-Za-z0-9_-]{1,256}$`)

func validAuthURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") ||
		!loginPath.MatchString(u.EscapedPath()) {
		return false
	}
	return u.Host == "login.tailscale.com" || u.Host == "controlplane.tailscale.com"
}

func macPeers(st *ipnstate.Status) []peerLabel {
	peers := []peerLabel{}
	for _, p := range st.Peer {
		if !eligibleMac(p) || !p.Online || !sameOwner(st, p.UserID) || p.ID == "" || st.Self.ID == p.ID {
			continue
		}
		peers = append(peers, peerLabel{ID: string(p.ID), Name: p.HostName, DisplayName: deviceLabel(p.HostName), Online: true})
	}
	slices.SortFunc(peers, func(a, b peerLabel) int {
		if order := strings.Compare(a.Name, b.Name); order != 0 {
			return order
		}
		return strings.Compare(a.ID, b.ID)
	})
	return peers
}
