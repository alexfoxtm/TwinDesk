package engine

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestCopyTrafficDeliversReplyAfterHalfClose(t *testing.T) {
	client, incoming := forwardingSockets(t)
	server, backend := forwardingSockets(t)
	bridge := newTunnel(t.Context(), nil)
	bridge.attach(incoming)
	bridge.attach(backend)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		copyTraffic(bridge, incoming, backend)
	}()
	t.Cleanup(func() {
		bridge.close()
		<-finished
	})

	if _, err := io.WriteString(client, "request"); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	request, err := io.ReadAll(server)
	if err != nil || string(request) != "request" {
		t.Fatalf("request after FIN = %q, %v", request, err)
	}
	if _, err := io.WriteString(server, "final reply"); err != nil {
		t.Fatal(err)
	}
	if err := server.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil || string(response) != "final reply" {
		t.Fatalf("reply after FIN = %q, %v", response, err)
	}
}

func TestAuthenticateBridgeSkipsAbandonedAndWrongProofs(t *testing.T) {
	listener := forwardingListener(t)
	// The abandoned connection would occupy a serial reader until expiry.
	expires := time.Now().Add(proofReadTimeout / 2)
	if err := listener.SetDeadline(expires); err != nil {
		t.Fatal(err)
	}
	bridge := newTunnel(t.Context(), listener)
	t.Cleanup(bridge.close)

	abandoned := forwardingClient(t, listener)
	if _, err := abandoned.Write([]byte{0}); err != nil {
		t.Fatal(err)
	}
	wrong := forwardingClient(t, listener)
	if _, err := wrong.Write(make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	var token [32]byte
	token[0] = 1
	valid := forwardingClient(t, listener)
	if _, err := valid.Write(append(token[:], 'x')); err != nil {
		t.Fatal(err)
	}

	winner := authenticateBridge(bridge, listener, token, expires)
	if winner == nil || winner.RemoteAddr().String() != valid.LocalAddr().String() {
		t.Fatal("the connection with the valid proof did not win")
	}
	if err := winner.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var payload [1]byte
	if _, err := io.ReadFull(winner, payload[:]); err != nil || payload[0] != 'x' {
		t.Fatalf("bytes after the local proof = %q, %v", payload, err)
	}
}

func forwardingSockets(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener := forwardingListener(t)
	client := forwardingClient(t, listener)
	server, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	deadline := time.Now().Add(5 * time.Second)
	for _, conn := range []*net.TCPConn{client, server} {
		if err := conn.SetDeadline(deadline); err != nil {
			t.Fatal(err)
		}
	}
	return client, server
}

func forwardingListener(t *testing.T) *net.TCPListener {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func forwardingClient(t *testing.T, listener *net.TCPListener) *net.TCPConn {
	t.Helper()
	client, err := net.DialTCP("tcp4", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}
