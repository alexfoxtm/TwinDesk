package engine

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/tsaddr"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const (
	loopback         = "127.0.0.1"
	bridgeWindow     = 15 * time.Second
	maxBridges       = 8
	maxHostStreams   = 32
	maxProofReaders  = 8
	proofReadTimeout = 750 * time.Millisecond
	relayDialTimeout = 12 * time.Second
	reverseDrain     = 2 * time.Second
)

var loopbackIP = [4]byte{127, 0, 0, 1}

type tunnel struct {
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	listener net.Listener
	conns    []net.Conn
}

func newTunnel(parent context.Context, listener net.Listener) *tunnel {
	ctx, cancel := context.WithCancel(parent)
	return &tunnel{ctx: ctx, cancel: cancel, listener: listener}
}

func (t *tunnel) attach(conn net.Conn) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ctx.Err() != nil {
		_ = conn.Close()
		return false
	}
	t.conns = append(t.conns, conn)
	return true
}

func (t *tunnel) discard(conn net.Conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns = slices.DeleteFunc(t.conns, func(c net.Conn) bool { return c == conn })
	_ = conn.Close()
}

func (t *tunnel) discardOtherThan(keep net.Conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns = slices.DeleteFunc(t.conns, func(conn net.Conn) bool {
		if conn == keep {
			return false
		}
		_ = conn.Close()
		return true
	})
}

func (t *tunnel) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cancel()
	if t.listener != nil {
		_ = t.listener.Close()
		t.listener = nil
	}
	for _, conn := range t.conns {
		_ = conn.Close()
	}
	t.conns = nil
}

func copyTraffic(t *tunnel, a, b net.Conn) {
	var copying sync.WaitGroup
	defer copying.Wait()
	defer t.close()

	done := make(chan bool, 2)
	copyDirection := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		writer, canHalfClose := dst.(interface{ CloseWrite() error })
		done <- err == nil && canHalfClose && writer.CloseWrite() == nil
	}
	copying.Go(func() { copyDirection(a, b) })
	copying.Go(func() { copyDirection(b, a) })

	select {
	case <-t.ctx.Done():
		return
	case graceful := <-done:
		if !graceful {
			return
		}
	}
	// A FIN in either direction still allows the peer to send its last reply.
	drain := time.NewTimer(reverseDrain)
	defer drain.Stop()
	select {
	case <-t.ctx.Done():
	case <-done:
	case <-drain.C:
	}
}

func (n *node) revokeLocked() {
	n.unserveLocked()
	for id, t := range n.bridges {
		t.close()
		delete(n.bridges, id)
	}
}

type serveSession struct {
	listener   net.Listener
	port       int
	generation string
	streams    map[*tunnel]struct{}
	ingress    map[int]ingress
}

type ingress struct {
	tunnel  *tunnel
	socket  syscall.RawConn
	peer    tailcfg.StableNodeID
	account string
}

func randomHandle() string {
	var token [16]byte
	rand.Read(token[:])
	return hex.EncodeToString(token[:])
}

func (n *node) serve(port int) reply {
	if n.spec.role != "mac" {
		return failed("wrong-role")
	}
	if port < 1 || port > 65535 || port == appPort {
		return failed("invalid-port")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing || n.state != "running" {
		return failed("not-running")
	}
	if n.serveSession != nil {
		if n.serveSession.port == port {
			return reply{OK: true, Generation: n.serveSession.generation}
		}
		return failed("already-serving")
	}
	listener, err := n.server.Listen("tcp", ":"+strconv.Itoa(appPort))
	if err != nil {
		return failed("serve-failed")
	}
	session := &serveSession{
		listener: listener, port: port, generation: randomHandle(),
		streams: make(map[*tunnel]struct{}), ingress: make(map[int]ingress),
	}
	n.serveSession = session
	n.active.Go(func() { n.acceptHost(session) })
	return reply{OK: true, Generation: session.generation}
}

func (n *node) claimIngress(port, sourcePort int, generation string) reply {
	n.mu.Lock()
	defer n.mu.Unlock()
	session := n.serveSession
	if n.closing || n.state != "running" || session == nil || session.port != port ||
		session.generation != generation || sourcePort < 1 || sourcePort > 65535 {
		return failed("ingress-denied")
	}
	binding, found := session.ingress[sourcePort]
	if !found || !binding.connectedTo(port) {
		return failed("ingress-denied")
	}
	delete(session.ingress, sourcePort)
	return reply{OK: true, Peer: string(binding.peer), Account: binding.account}
}

func (binding ingress) connectedTo(port int) bool {
	var connected bool
	err := binding.socket.Control(func(fd uintptr) {
		peer, err := unix.Getpeername(int(fd))
		if address, ok := peer.(*unix.SockaddrInet4); err == nil && ok {
			connected = address.Addr == loopbackIP && address.Port == port
		}
	})
	return err == nil && connected
}

func (n *node) unserve() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.unserveLocked()
}

func (n *node) unserveLocked() {
	session := n.serveSession
	if session == nil {
		return
	}
	n.serveSession = nil
	_ = session.listener.Close()
	clear(session.ingress)
	for t := range session.streams {
		t.close()
		delete(session.streams, t)
	}
}

func (n *node) acceptHost(session *serveSession) {
	for {
		conn, err := session.listener.Accept()
		n.mu.Lock()
		if n.serveSession != session {
			n.mu.Unlock()
			if conn != nil {
				_ = conn.Close()
			}
			return
		}
		if err != nil {
			n.unserveLocked()
			n.mu.Unlock()
			return
		}
		if len(session.streams) >= maxHostStreams {
			n.mu.Unlock()
			_ = conn.Close()
			continue
		}
		t := newTunnel(n.ctx, nil)
		t.attach(conn)
		session.streams[t] = struct{}{}
		n.active.Go(func() { n.forwardHost(session, t, conn) })
		n.mu.Unlock()
	}
}

func (n *node) forwardHost(session *serveSession, t *tunnel, incoming net.Conn) {
	sourcePort := 0
	defer func() {
		n.mu.Lock()
		defer n.mu.Unlock()
		if session.ingress[sourcePort].tunnel == t {
			delete(session.ingress, sourcePort)
		}
		delete(session.streams, t)
		t.close()
	}()
	ctx, cancel := context.WithTimeout(t.ctx, apiTimeout)
	defer cancel()
	remote, err := netip.ParseAddrPort(incoming.RemoteAddr().String())
	if err != nil {
		return
	}
	remote = netip.AddrPortFrom(remote.Addr().Unmap(), remote.Port())
	if !tsaddr.IsTailscaleIP(remote.Addr()) {
		return
	}
	who, err := n.local.WhoIsProto(ctx, "tcp", remote.String())
	if err != nil || who == nil || who.Node == nil || who.UserProfile == nil ||
		who.Node.StableID == "" || !who.Node.Hostinfo.Valid() || who.Node.Key.IsZero() ||
		who.Node.User != who.UserProfile.ID || !isOwnedAddress(who.Node, remote.Addr()) {
		return
	}
	host := who.Node.Hostinfo.Hostname()
	if !hostName.MatchString(host) || strings.HasPrefix(host, "twindesk-mac-") {
		return
	}
	st, err := n.local.StatusWithoutPeers(ctx)
	if err != nil || st.BackendState != "Running" || !sameOwner(st, who.Node.User) || who.Node.StableID == st.Self.ID {
		return
	}
	if !n.matches(ctx, target{id: who.Node.StableID, owner: who.Node.User, key: who.Node.Key, ip: remote.Addr()}) {
		return
	}
	backend, sourcePort, err := n.connectBackend(ctx, session, ingress{
		tunnel: t, peer: who.Node.StableID, account: who.UserProfile.LoginName,
	})
	if err != nil || !t.attach(backend) {
		return
	}
	cancel()
	copyTraffic(t, incoming, backend)
}

func (n *node) connectBackend(ctx context.Context, session *serveSession, binding ingress) (net.Conn, int, error) {
	var sourcePort int
	dialer := net.Dialer{ControlContext: func(ctx context.Context, _, _ string, socket syscall.RawConn) error {
		// Publish the reservation while this Go-owned socket still holds the
		// port and before connect can wake the backend's accept handler.
		var bindErr error
		err := socket.Control(func(fd uintptr) {
			if bindErr = unix.Bind(int(fd), &unix.SockaddrInet4{Addr: loopbackIP}); bindErr != nil {
				return
			}
			bound, err := unix.Getsockname(int(fd))
			bindErr = err
			if address, ok := bound.(*unix.SockaddrInet4); err == nil && ok {
				sourcePort = address.Port
			}
		})
		if err != nil {
			return err
		}
		if bindErr != nil {
			return bindErr
		}
		if sourcePort == 0 {
			return errors.New("missing loopback source port")
		}
		n.mu.Lock()
		defer n.mu.Unlock()
		if n.serveSession != session {
			return context.Canceled
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		binding.socket = socket
		session.ingress[sourcePort] = binding
		return nil
	}}
	conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(loopback, strconv.Itoa(session.port)))
	return conn, sourcePort, err
}

type target struct {
	id     tailcfg.StableNodeID
	owner  tailcfg.UserID
	key    key.NodePublic
	ip     netip.Addr
	source netip.Addr
}

func sameOwner(st *ipnstate.Status, user tailcfg.UserID) bool {
	return st != nil && st.Self != nil && !user.IsZero() && st.Self.UserID == user
}

func eligibleMac(peer *ipnstate.PeerStatus) bool {
	return peer != nil && peer.InNetworkMap && !peer.Expired &&
		!peer.ShareeNode && !peer.PublicKey.IsZero() &&
		(peer.Tags == nil || peer.Tags.Len() == 0) &&
		hostName.MatchString(peer.HostName) && strings.HasPrefix(peer.HostName, "twindesk-mac-")
}

func pickTarget(st *ipnstate.Status, id tailcfg.StableNodeID) (target, bool) {
	if st == nil || st.BackendState != "Running" || st.Self == nil || st.Self.ID == id || id == "" {
		return target{}, false
	}
	var selected *ipnstate.PeerStatus
	for _, peer := range st.Peer {
		if peer == nil || peer.ID != id {
			continue
		}
		if selected != nil || !eligibleMac(peer) || !peer.Online || !sameOwner(st, peer.UserID) {
			return target{}, false
		}
		selected = peer
	}
	if selected == nil {
		return target{}, false
	}
	// Prefer IPv4, but use a Tailscale IPv6 pair when that's the only option.
	for _, v4 := range []bool{true, false} {
		for _, ip := range selected.TailscaleIPs {
			if ip.Is4() != v4 || !tsaddr.IsTailscaleIP(ip) {
				continue
			}
			for _, source := range st.TailscaleIPs {
				if source.Is4() == v4 && source != ip && tsaddr.IsTailscaleIP(source) {
					return target{id: id, owner: selected.UserID, key: selected.PublicKey, ip: ip, source: source}, true
				}
			}
		}
	}
	return target{}, false
}

func (n *node) dial(id string) reply {
	if n.spec.role == "mac" {
		return failed("wrong-role")
	}
	if id == "" || len(id) > 128 {
		return failed("invalid-peer")
	}
	n.mu.Lock()
	if n.closing || n.state != "running" {
		n.mu.Unlock()
		return failed("not-running")
	}
	n.active.Add(1)
	n.mu.Unlock()
	defer n.active.Done()

	ctx, cancel := context.WithTimeout(n.ctx, apiTimeout)
	defer cancel()
	st, err := n.local.Status(ctx)
	peer, ok := pickTarget(st, tailcfg.StableNodeID(id))
	if err != nil || !ok || !n.matches(ctx, peer) {
		return failed("peer-unavailable")
	}

	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing || n.state != "running" {
		return failed("not-running")
	}
	if len(n.bridges) >= maxBridges {
		return failed("too-many-bridges")
	}
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return failed("bridge-failed")
	}
	expires := time.Now().Add(bridgeWindow)
	if err := listener.SetDeadline(expires); err != nil {
		_ = listener.Close()
		return failed("bridge-failed")
	}
	var token [32]byte
	rand.Read(token[:])
	handle := randomHandle()
	t := newTunnel(n.ctx, listener)
	n.bridges[handle] = t
	n.active.Go(func() { n.acceptBridge(handle, t, listener, peer, token, expires) })
	return reply{OK: true, Port: listener.Addr().(*net.TCPAddr).Port, Handle: handle, Token: hex.EncodeToString(token[:])}
}

func (n *node) closeBridge(handle string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if t := n.bridges[handle]; t != nil {
		t.close()
		delete(n.bridges, handle)
	}
}

func (n *node) acceptBridge(handle string, t *tunnel, listener net.Listener, peer target, token [32]byte, expires time.Time) {
	defer func() {
		t.close()
		n.mu.Lock()
		if n.bridges[handle] == t {
			delete(n.bridges, handle)
		}
		n.mu.Unlock()
	}()
	client := authenticateBridge(t, listener, token, expires)
	if client == nil {
		return
	}
	ctx, cancel := context.WithTimeout(t.ctx, apiTimeout)
	st, err := n.local.Status(ctx)
	current, ok := pickTarget(st, peer.id)
	valid := err == nil && ok && current == peer && n.matches(ctx, peer)
	cancel()
	if !valid {
		return
	}
	// tsnet.Server.Dial and LocalClient.DialTCP may fall back to the system
	// dialer when a route disappears. Use only tsnet's in-process TCP stack.
	ctx, cancel = context.WithTimeout(t.ctx, relayDialTimeout)
	remote, err := n.stack.DialContextTCPWithBind(ctx, peer.source, netip.AddrPortFrom(peer.ip, appPort))
	cancel()
	if err != nil || !t.attach(remote) {
		return
	}
	ctx, cancel = context.WithTimeout(t.ctx, apiTimeout)
	valid = n.matches(ctx, peer)
	cancel()
	if !valid {
		return
	}
	copyTraffic(t, client, remote)
}

func authenticateBridge(t *tunnel, listener net.Listener, token [32]byte, expires time.Time) net.Conn {
	var winner net.Conn
	var choose sync.Once
	var readers sync.WaitGroup
	selected := make(chan struct{})
	slots := make(chan struct{}, maxProofReaders)
accept:
	for {
		select {
		case slots <- struct{}{}:
		case <-selected:
			break accept
		case <-t.ctx.Done():
			break accept
		}
		conn, err := listener.Accept()
		if err != nil || !t.attach(conn) {
			break
		}
		readers.Go(func() {
			defer func() { <-slots }()
			won := false
			if readBridgeProof(conn, token, expires) {
				choose.Do(func() {
					won = true
					winner = conn
					close(selected)
					_ = listener.Close()
				})
			}
			if !won {
				t.discard(conn)
			}
		})
	}
	// Stop any late reader from winning after the accept loop has ended.
	choose.Do(func() {})
	_ = listener.Close()
	t.discardOtherThan(winner)
	readers.Wait()
	if t.ctx.Err() != nil {
		return nil
	}
	return winner
}

func readBridgeProof(conn net.Conn, token [32]byte, expires time.Time) bool {
	deadline := time.Now().Add(proofReadTimeout)
	if expires.Before(deadline) {
		deadline = expires
	}
	if conn.SetReadDeadline(deadline) != nil {
		return false
	}
	var supplied [32]byte
	_, err := io.ReadFull(conn, supplied[:])
	return err == nil && subtle.ConstantTimeCompare(token[:], supplied[:]) == 1 &&
		time.Now().Before(expires) && conn.SetReadDeadline(time.Time{}) == nil
}

func (n *node) matches(ctx context.Context, peer target) bool {
	who, err := n.local.WhoIs(ctx, peer.ip.String())
	return err == nil && who != nil && who.Node != nil &&
		who.Node.StableID == peer.id && who.Node.Key == peer.key && who.Node.User == peer.owner &&
		isOwnedAddress(who.Node, peer.ip)
}

func isOwnedAddress(node *tailcfg.Node, addr netip.Addr) bool {
	return node.Sharer.IsZero() && len(node.Tags) == 0 &&
		slices.Contains(node.Addresses, netip.PrefixFrom(addr, addr.BitLen()))
}
