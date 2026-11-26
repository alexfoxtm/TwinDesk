//go:build darwin && ts_omit_logtail && ts_omit_portmapper

package engine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"expvar"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/metrics"
	"tailscale.com/net/netns"
	"tailscale.com/net/stun/stuntest"
	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// TestPrivateTailnet uses the exported native ABI in three independent processes.
// The pinned Tailscale fixture provides control, DERP and STUN locally.
func TestPrivateTailnet(t *testing.T) {
	if os.Getenv("TWINDESK_NETWORK_TEST_ROOT") == "" {
		t.Skip("set TWINDESK_NETWORK_TEST_ROOT to a private scratch directory")
	}
	t.Run("same-owner", checkPrivateTransport)
	t.Run("different-owner", checkPrivateOwnerBoundary)
}

func checkPrivateTransport(t *testing.T) {
	control, relayPackets := startPrivateControl(t, true, false)
	arrivals := make(chan fixtureArrival)
	backend := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if _, err := io.Copy(w, r.Body); err != nil {
			t.Error(err)
		}
	}))
	backend.Config.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		arrival := fixtureArrival{source: c.RemoteAddr().(*net.TCPAddr).Port, claimed: make(chan struct{})}
		select {
		case arrivals <- arrival:
		case <-t.Context().Done():
			c.Close()
			return ctx
		}
		select {
		case <-arrival.claimed:
		case <-t.Context().Done():
			c.Close()
		}
		return ctx
	}
	backend.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	backend.StartTLS()
	t.Cleanup(backend.Close)
	backendPort := backend.Listener.Addr().(*net.TCPAddr).Port

	start := privateNodeLauncher(t, control, backendPort)
	mac := start("mac", "Test Studio")
	phone := start("android", "")
	tablet := start("ipad", "")
	macStatus := mac.waitFor(func(r reply) bool { return r.State == "running" })
	if macStatus.DisplayName != "test-studio" || !strings.HasPrefix(macStatus.Name, "twindesk-mac-test-studio-") {
		t.Fatal("configured installation name was not announced by the Mac")
	}
	tabletStatus := tablet.waitFor(func(r reply) bool { return r.State == "running" })
	macCandidate := func(r reply) bool {
		return r.State == "running" && len(r.Peers) == 1 &&
			r.Peers[0].Online && r.Peers[0].Name == macStatus.Name && r.Peers[0].DisplayName == macStatus.DisplayName
	}
	phoneStatus := phone.waitFor(macCandidate)
	tablet.waitFor(macCandidate)
	peer := phoneStatus.Peers[0].ID
	macIdentity := fixtureIdentity(t, control, macStatus.Name)
	phoneIdentity := fixtureIdentity(t, control, phoneStatus.Name)
	tabletIdentity := fixtureIdentity(t, control, tabletStatus.Name)
	if control.NumNodes() != 3 || peer != string(macIdentity.StableID) ||
		macIdentity.Machine == phoneIdentity.Machine || macIdentity.Machine == tabletIdentity.Machine ||
		phoneIdentity.Machine == tabletIdentity.Machine {
		t.Fatal("expected three independent machine identities and the Mac's stable ID as the only candidate")
	}
	if denied := phone.call(request{Op: "dial", Peer: string(tabletIdentity.StableID)}); denied.OK || denied.Port != 0 {
		t.Fatal("a non-Mac node became an eligible dial target")
	}
	t.Log("isolated registrations and Mac-only discovery verified")

	serving := mac.ok(request{Op: "serve", Port: backendPort})
	if r := mac.call(request{Op: "claimIngress", Port: backendPort, SourcePort: backendPort, Generation: serving.Generation}); r.OK || r.Error != "ingress-denied" {
		t.Fatal("an unwitnessed loopback connection was eligible for an ingress claim")
	}
	var previousGeneration string
	transfer := func(viewer *isolatedNode, id tailcfg.StableNodeID, tryWrongToken bool) (*tls.Conn, string) {
		return exchangeTLS(t, viewer, peer, backend.Certificate(), arrivals, tryWrongToken, func(source int) {
			claim := request{Op: "claimIngress", Port: backendPort, SourcePort: source, Generation: serving.Generation}
			if previousGeneration != "" {
				stale := claim
				stale.Generation = previousGeneration
				if mac.call(stale).OK {
					t.Fatal("a revoked ingress generation admitted a new connection")
				}
			}
			if got := mac.ok(claim); got.Peer != string(id) || got.Account == "" || got.Account != macStatus.Account {
				t.Fatal("loopback connection did not map to its authenticated tailnet peer and account")
			}
			if mac.call(claim).OK {
				t.Fatal("the same ingress claim succeeded twice")
			}
		})
	}
	before := relayPackets.Value()
	conn, bridge := transfer(phone, phoneIdentity.StableID, true)
	if relayPackets.Value() <= before {
		t.Fatal("authenticated traffic did not traverse the local DERP relay")
	}
	phone.ok(request{Op: "close", Handle: bridge})
	requireStreamClosed(t, conn)

	conn, _ = transfer(phone, phoneIdentity.StableID, false)
	mac.ok(request{Op: "unserve"})
	requireStreamClosed(t, conn)
	t.Log("bridge rejected a wrong token, authenticated ingress once, and carried pinned TLS 1.3; close and unserve cut active streams")

	phone.ok(request{Op: "stop"})
	phone.exit()
	phone = start("android", "")
	restarted := phone.waitFor(macCandidate)
	retained := fixtureIdentity(t, control, restarted.Name)
	if restarted.Name != phoneStatus.Name || retained.Machine != phoneIdentity.Machine || retained.StableID != phoneIdentity.StableID {
		t.Fatal("stop and restart lost the phone's existing account identity")
	}
	previousGeneration = serving.Generation
	serving = mac.ok(request{Op: "serve", Port: backendPort})
	if serving.Generation == "" || serving.Generation == previousGeneration {
		t.Fatal("serve reused its revoked ingress generation")
	}
	conn, _ = transfer(phone, phoneIdentity.StableID, false)
	loggedOut := phone.ok(request{Op: "logout"})
	if loggedOut.RemoteRevoked == nil || (*loggedOut.RemoteRevoked && loggedOut.Warning != "") ||
		(!*loggedOut.RemoteRevoked && loggedOut.Warning != "remote-revocation-unconfirmed") {
		t.Fatal("logout did not distinguish local cleanup from confirmed remote revocation")
	}
	requireStreamClosed(t, conn)
	phone.exit()
	if _, err := os.Stat(filepath.Join(phone.profile, profileName, accountName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("phone's account directory survived logout: %v", err)
	}
	conn, bridge = transfer(tablet, tabletIdentity.StableID, false)
	tablet.ok(request{Op: "close", Handle: bridge})
	requireStreamClosed(t, conn)
	phone = start("android", "")
	newPhone := phone.waitFor(macCandidate)
	fresh := fixtureIdentity(t, control, newPhone.Name)
	if fresh.Machine == phoneIdentity.Machine || mac.ok(request{Op: "status"}).State != "running" {
		t.Fatal("logout did not create a new phone identity or disturbed the Mac account")
	}
	t.Log("process restart retained the account; phone logout revoked its stream and preserved tablet access")
}

func checkPrivateOwnerBoundary(t *testing.T) {
	control, _ := startPrivateControl(t, false, true)
	backend, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	port := backend.Addr().(*net.TCPAddr).Port
	start := privateNodeLauncher(t, control, port)
	mac := start("mac", "")
	mac.ok(request{Op: "login"})
	phone := start("android", "")
	macStatus := approvePrivateNode(t, mac, control, true)
	phoneStatus := approvePrivateNode(t, phone, control, false)
	macIdentity := fixtureIdentity(t, control, macStatus.Name)
	phoneIdentity := fixtureIdentity(t, control, phoneStatus.Name)
	if macIdentity.User == phoneIdentity.User || macStatus.Account == phoneStatus.Account || len(phoneStatus.Peers) != 0 {
		t.Fatal("different fixture owners were not isolated in discovery")
	}
	peer := string(macIdentity.StableID)
	if r := phone.call(request{Op: "dial", Peer: peer}); r.OK || r.Port != 0 {
		t.Fatal("a different-owner Mac became available to dial")
	}
	mac.ok(request{Op: "serve", Port: port})
	// The private control fixture permits TCP. Check the host's ingress
	// independently of the viewer's discovery and dial policy.
	phone.ok(request{Op: "fixture-probe-ingress", Peer: peer})
	if err := backend.SetDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	conn, err := backend.AcceptTCP()
	if conn != nil {
		conn.Close()
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("different-owner overlay connection reached the app backend: %v", err)
	}
	t.Log("interactive fixture login and approval completed; different-owner discovery, dial and ingress denied")
}

func approvePrivateNode(t *testing.T, p *isolatedNode, control *testcontrol.Server, earlyLogin bool) reply {
	t.Helper()
	needsLogin := p.waitFor(func(r reply) bool { return r.State == "needsLogin" })
	if needsLogin.AuthURL != "" {
		t.Fatal("login URL was exposed before the user requested it")
	}
	if !earlyLogin {
		p.ok(request{Op: "login"})
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		// The loopback fixture URL is deliberately blocked by the production
		// URL policy. Read it through the private test pipe only.
		if p.ok(request{Op: "status"}).AuthURL != "" {
			t.Fatal("production ABI exposed the fixture-only authorization URL")
		}
		auth := p.ok(request{Op: "fixture-auth-url"}).AuthURL
		if auth != "" && control.CompleteAuth(auth) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture did not issue an authorization URL")
		}
		time.Sleep(25 * time.Millisecond)
	}
	approval := p.waitFor(func(r reply) bool { return r.State == "needsApproval" })
	nodeKey := fixtureIdentity(t, control, approval.Name).Key
	if !control.CompleteDeviceApproval(control.BaseURL(), control.BaseURL()+"/admin", &nodeKey) {
		t.Fatal("fixture could not approve the enrolled node")
	}
	return p.waitFor(func(r reply) bool { return r.State == "running" })
}

type loopbackSTUN struct{}

func (loopbackSTUN) ListenPacket(ctx context.Context, _, _ string) (net.PacketConn, error) {
	return (&net.ListenConfig{}).ListenPacket(ctx, "udp4", "127.0.0.1:0")
}

func startPrivateControl(t *testing.T, sameOwner, interactive bool) (*testcontrol.Server, *expvar.Int) {
	t.Helper()
	// As in tsnet's upstream startControl fixture, provide a complete local
	// map. Bind STUN explicitly instead of using its wildcard default.
	relay := derpserver.New(key.NewNode(), logger.Discard)
	t.Cleanup(func() { relay.Close() })
	derpHTTP := httptest.NewTLSServer(derpserver.Handler(relay))
	t.Cleanup(derpHTTP.Close)
	stunAddr, closeSTUN := stuntest.ServeWithPacketListener(t, loopbackSTUN{})
	t.Cleanup(closeSTUN)
	const region = 1
	control := &testcontrol.Server{
		Logf: logger.Discard, AllOnline: true, AllNodesSameUser: sameOwner,
		RequireAuth: interactive, RequireMachineAuth: interactive,
		MagicDNSDomain: "twindesk-fixture.invalid",
		DERPMap: &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
			region: {RegionID: region, RegionCode: "fixture", Nodes: []*tailcfg.DERPNode{{
				Name: "fixture-1", RegionID: region, IPv4: "127.0.0.1", IPv6: "none",
				HostName: "127.0.0.1", STUNTestIP: "127.0.0.1", STUNPort: stunAddr.Port,
				DERPPort: derpHTTP.Listener.Addr().(*net.TCPAddr).Port, InsecureForTests: true,
			}}},
		}},
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control, relay.ExpVar(false).(*metrics.Set).Get("packets_sent").(*expvar.Int)
}

func privateNodeLauncher(t *testing.T, control *testcontrol.Server, backendPort int) func(string, string) *isolatedNode {
	t.Helper()
	scratch := os.Getenv("TWINDESK_NETWORK_TEST_ROOT")
	scratch, err := filepath.EvalSymlinks(scratch)
	if err != nil || !filepath.IsAbs(scratch) {
		t.Fatal("need an existing, absolute scratch directory")
	}
	root, err := os.MkdirTemp(scratch, "twindesk-int-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})

	// A synthetic standalone socket represents the daemon's local API. A
	// second loopback listener verifies that the sandbox allows only fixture ports.
	daemonSocket := filepath.Join(root, "daemon.sock")
	daemon, err := net.Listen("unix", daemonSocket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { daemon.Close() })
	privateFile := filepath.Join(root, "unrelated-state")
	if err := os.WriteFile(privateFile, []byte("fixture-only"), 0600); err != nil {
		t.Fatal(err)
	}
	other, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { other.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	t.Cleanup(cancel)
	derpNode := control.DERPMap.Regions[1].Nodes[0]
	ports := []int{control.HTTPTestServer.Listener.Addr().(*net.TCPAddr).Port, derpNode.DERPPort, backendPort}
	return func(role, displayName string) *isolatedNode {
		home := filepath.Join(root, role)
		if err := os.Mkdir(home, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			t.Fatal(err)
		}
		p := launchIsolatedNode(t, ctx, home, root, control.BaseURL(), daemonSocket, other.Addr().String(), privateFile, ports, derpNode.STUNPort)
		p.ok(request{Op: "start", Dir: p.profile, Role: role, DisplayName: displayName})
		return p
	}
}

func fixtureIdentity(t *testing.T, control *testcontrol.Server, hostname string) *tailcfg.Node {
	t.Helper()
	for _, node := range slices.Backward(control.AllNodes()) {
		if strings.HasPrefix(node.Name, hostname+".") {
			return node
		}
	}
	t.Fatal("private control server has no matching registration")
	return nil
}

type isolatedNode struct {
	t       *testing.T
	ctx     context.Context
	cmd     *exec.Cmd
	input   io.WriteCloser
	encode  *json.Encoder
	decode  *json.Decoder
	profile string
}

func launchIsolatedNode(t *testing.T, ctx context.Context, home, fixtureRoot, control, daemon, other, privateFile string, tcpPorts []int, stunPort int) *isolatedNode {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	operatorHome, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(operatorHome) {
		t.Fatal("need the operator's home path to isolate its files")
	}
	operatorHome, err = filepath.EvalSymlinks(operatorHome)
	if err != nil {
		t.Fatal(err)
	}
	policy := fmt.Sprintf(`(version 1) (allow default)
(deny file-read* file-write* (subpath %q) (subpath %q))
(allow file-read* (literal %q))
(allow file-read* file-write* (subpath %q))
(deny network*) (allow network-bind)
(allow network-inbound (local ip "localhost:*"))`, operatorHome, fixtureRoot, exe, home)
	// The engine canonicalizes an existing profile on restart, which requires
	// lstat on the ancestor directories of this fixture's home.
	for parent := filepath.Dir(home); parent != "/"; parent = filepath.Dir(parent) {
		policy += fmt.Sprintf("\n(allow file-read-metadata (literal %q))", parent)
	}
	for _, port := range tcpPorts {
		policy += fmt.Sprintf("\n(allow network-outbound (remote tcp \"localhost:%d\"))", port)
	}
	policy += fmt.Sprintf("\n(allow network-outbound (remote udp \"localhost:%d\"))", stunPort)
	cmd := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", "-p", policy, exe, "-test.run=^TestPrivateTailnetChild$")
	cmd.Env = []string{
		"HOME=" + home, "TMPDIR=" + home, "GODEBUG=netdns=go",
		"TWINDESK_NETWORK_TEST_CONTROL=" + control,
		"TWINDESK_NETWORK_TEST_DENIED_TCP=" + other,
		"TWINDESK_NETWORK_TEST_DENIED_UNIX=" + daemon,
		"TWINDESK_NETWORK_TEST_DENIED_FILE=" + privateFile,
		"TS_PANIC_IF_HIT_MAIN_CONTROL=1", "TS_ASSUME_NETWORK_UP_FOR_TEST=1",
		"TS_DEBUG_NEVER_DIRECT_UDP=1", "TS_DEBUG_OMIT_LOCAL_ADDRS=1",
	}
	cmd.Dir = home
	cmd.Stderr = os.Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &isolatedNode{t, ctx, cmd, input, json.NewEncoder(input), json.NewDecoder(output), filepath.Join(home, "profile")}
	t.Cleanup(p.exit)
	return p
}

func (p *isolatedNode) exit() {
	if p.cmd == nil {
		return
	}
	p.input.Close()
	if err := p.cmd.Wait(); err != nil {
		p.t.Errorf("engine child exit: %v", err)
	}
	p.cmd = nil
}

func (p *isolatedNode) call(req request) reply {
	p.t.Helper()
	if err := p.encode.Encode(req); err != nil {
		p.t.Fatalf("send %s: %v", req.Op, err)
	}
	var r reply
	if err := p.decode.Decode(&r); err != nil {
		p.t.Fatalf("receive %s: %v", req.Op, err)
	}
	return r
}

func (p *isolatedNode) ok(req request) reply {
	p.t.Helper()
	r := p.call(req)
	if !r.OK {
		p.t.Fatalf("%s: %s", req.Op, r.Error)
	}
	return r
}

func (p *isolatedNode) waitFor(ready func(reply) bool) reply {
	p.t.Helper()
	deadline := time.NewTimer(18 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(100 * time.Millisecond)
	defer poll.Stop()
	for {
		r := p.ok(request{Op: "status"})
		if ready(r) {
			return r
		}
		if r.State == "error" {
			p.t.Fatal("embedded engine reported startup error")
		}
		select {
		case <-deadline.C:
			p.t.Fatalf("embedded node did not become ready; final state %q", r.State)
		case <-p.ctx.Done():
			p.t.Fatal(p.ctx.Err())
		case <-poll.C:
		}
	}
}

func TestPrivateTailnetChild(t *testing.T) {
	control := os.Getenv("TWINDESK_NETWORK_TEST_CONTROL")
	if control == "" {
		t.Skip("subprocess only")
	}
	address, httpControl := strings.CutPrefix(control, "http://")
	host, portText, err := net.SplitHostPort(address)
	port, portErr := strconv.Atoi(portText)
	if !httpControl || err != nil || portErr != nil || host != "127.0.0.1" || port < 1 || port > 65535 {
		t.Fatal("child control endpoint must use IPv4 loopback")
	}
	dialer := net.Dialer{Timeout: time.Second}
	for _, probe := range []struct{ network, address string }{
		{"udp4", "192.0.2.1:9"}, {"udp6", "[2001:db8::1]:9"},
		{"tcp4", os.Getenv("TWINDESK_NETWORK_TEST_DENIED_TCP")}, {"unix", os.Getenv("TWINDESK_NETWORK_TEST_DENIED_UNIX")},
	} {
		c, err := dialer.Dial(probe.network, probe.address)
		if c != nil {
			c.Close()
		}
		// UDP connect creates no packets. The kernel must reject it before
		// any test node starts, along with unfenced local TCP/Unix access.
		if !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.EACCES) {
			fmt.Fprintf(os.Stderr, "sandbox preflight on %s: expected denial, got %v\n", probe.network, err)
			t.FailNow()
		}
	}
	if _, err := os.ReadFile(os.Getenv("TWINDESK_NETWORK_TEST_DENIED_FILE")); !errors.Is(err, os.ErrPermission) {
		fmt.Fprintf(os.Stderr, "sandbox preflight on sibling state: expected denial, got %v\n", err)
		t.FailNow()
	}
	netns.SetEnabled(false)
	defaultEngine = newEngine(control)
	defer Call(`{"op":"stop"}`)
	decoder := json.NewDecoder(os.Stdin)
	for {
		var input json.RawMessage
		if err := decoder.Decode(&input); err != nil {
			if !errors.Is(err, io.EOF) {
				t.Fatal(err)
			}
			return
		}
		var req request
		if err := json.Unmarshal(input, &req); err != nil {
			t.Fatal(err)
		}
		var output string
		switch req.Op {
		case "fixture-auth-url", "fixture-probe-ingress":
			// These two operations exist only on the sandboxed test pipe.
			data, err := json.Marshal(privateFixtureCall(control, req))
			if err != nil {
				t.Fatal(err)
			}
			output = string(data)
		default:
			output = Call(string(input))
		}
		if _, err := fmt.Fprintln(os.Stdout, output); err != nil {
			t.Fatal(err)
		}
	}
}

func privateFixtureCall(control string, req request) reply {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	n := defaultEngine.node
	status, err := n.local.Status(ctx)
	if err != nil {
		return failed("fixture-status")
	}
	if req.Op == "fixture-auth-url" {
		if strings.HasPrefix(status.AuthURL, control+"/auth/") {
			return reply{OK: true, AuthURL: status.AuthURL}
		}
		return success
	}
	for _, peer := range status.Peer {
		if string(peer.ID) != req.Peer || !peer.InNetworkMap {
			continue
		}
		for _, dst := range peer.TailscaleIPs {
			if !dst.Is4() || !tsaddr.IsTailscaleIP(dst) {
				continue
			}
			for _, src := range status.TailscaleIPs {
				if !src.Is4() || !tsaddr.IsTailscaleIP(src) {
					continue
				}
				conn, err := n.stack.DialContextTCPWithBind(ctx, src, netip.AddrPortFrom(dst, appPort))
				if err != nil {
					return failed("fixture-overlay-dial")
				}
				defer conn.Close()
				if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
					return failed("fixture-overlay-read-deadline")
				}
				var b [1]byte
				if got, err := conn.Read(b[:]); got == 0 && err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
					return success
				}
				return failed("fixture-overlay-not-rejected")
			}
		}
	}
	return failed("fixture-peer-missing")
}

type fixtureArrival struct {
	source  int
	claimed chan struct{}
}

func exchangeTLS(t *testing.T, node *isolatedNode, peer string, cert *x509.Certificate, arrivals <-chan fixtureArrival,
	tryWrongToken bool, claim func(source int)) (*tls.Conn, string) {
	t.Helper()
	bridge := node.ok(request{Op: "dial", Peer: peer})
	token, err := hex.DecodeString(bridge.Token)
	if bridge.Port == 0 || bridge.Handle == "" || err != nil || len(token) != 32 {
		t.Fatal("dial returned an incomplete bridge")
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(bridge.Port))
	dial := func() net.Conn {
		conn, err := net.DialTimeout("tcp4", addr, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		if err := conn.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	if tryWrongToken {
		intruder := dial()
		wrong := bytes.Clone(token)
		wrong[0] ^= 1
		if _, err := intruder.Write(wrong); err != nil {
			t.Fatal(err)
		}
		requireStreamClosed(t, intruder)
	}
	raw := dial()
	if _, err := raw.Write(token); err != nil {
		t.Fatal(err)
	}
	select {
	case arrival := <-arrivals:
		claim(arrival.source)
		close(arrival.claimed)
	case <-time.After(7 * time.Second):
		t.Fatal("authorized bridge never reached the TLS backend")
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	conn := tls.Client(raw, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13, ServerName: "127.0.0.1"})
	if err := conn.Handshake(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(conn.ConnectionState().PeerCertificates[0].Raw, cert.Raw) {
		t.Fatal("bridge did not preserve the backend TLS certificate")
	}
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	payload := []byte{0, 0x80, 0xff, 0x10, 0, 0x0a, 0x0d, 0x7f}
	req, err := http.NewRequest(http.MethodPost, "https://127.0.0.1/fixture", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if err := req.Write(conn); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	got, err := io.ReadAll(res.Body)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("opaque payload round trip failed: %v", err)
	}
	if second, err := net.DialTimeout("tcp4", addr, time.Second); err == nil {
		second.Close()
		t.Fatal("one-client bridge accepted a second connection")
	}
	return conn, bridge.Handle
}

func requireStreamClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	n, err := conn.Read(b[:])
	if n != 0 || err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("stream remained open: read %d bytes with error %v", n, err)
	}
	conn.Close()
}
