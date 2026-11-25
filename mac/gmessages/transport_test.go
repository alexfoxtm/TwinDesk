// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"testing"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestProjectUsesMessageTransport(t *testing.T) {
	for kind, want := range map[int64]string{0: "", 1: "text", 2: "text", 3: "text", 4: "rcs", 9: ""} {
		if got := project(&gmproto.Message{Type: kind}).Transport; got != want {
			t.Errorf("transport for type %d = %q, want %q", kind, got, want)
		}
	}
}

func TestPairedReplyRespectsConversationSendMode(t *testing.T) {
	for _, mode := range []gmproto.ConversationSendMode{
		gmproto.ConversationSendMode_SEND_MODE_AUTO,
		gmproto.ConversationSendMode_SEND_MODE_XMS,
		gmproto.ConversationSendMode_SEND_MODE_XMS_LATCH,
	} {
		c := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, SendMode: mode, DefaultOutgoingID: "fixture"}
		if summarize(c).Reply != (mode == gmproto.ConversationSendMode_SEND_MODE_AUTO) {
			t.Fatal("reply availability did not follow the send mode")
		}
	}
}

func TestListRCSFollowsCursorAndStopsOnRepeatedCursorOrCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cursor := &gmproto.Cursor{LastItemID: "page-two", LastItemTimestamp: 100}
	calls := 0
	list := func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		calls++
		if calls == 1 && req.GetCursor() != nil || calls == 2 && req.GetCursor() != cursor {
			t.Fatal("unexpected request cursor")
		}
		return &gmproto.ListConversationsResponse{
			Cursor: cursor,
			Conversations: []*gmproto.Conversation{
				{Type: gmproto.ConversationType_RCS, ConversationID: []string{"first", "second"}[calls-1]},
			},
		}, nil
	}
	rows, err := listRCS(ctx, list)
	if err != nil || calls != 2 || len(rows) != 2 {
		t.Fatal("did not collect both pages and stop on a repeated cursor")
	}
	calls = 0
	_, err = listRCS(ctx, func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		cancel()
		return list(ctx, req)
	})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal("canceled listing fetched additional pages")
	}
}

func TestGoogleCookieBoundary(t *testing.T) {
	cookies := make(map[string]string)
	for _, name := range requiredCookies {
		cookies[name] = "fixture"
	}
	cookies["unrelated"] = "fixture"
	if !filterCookies(cookies) || len(cookies) != len(requiredCookies) {
		t.Fatal("initial cookie allow-list mismatch")
	}
	calls := 0
	transport := googleTransport{roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		header := make(http.Header)
		for _, v := range []string{
			"OSID=fixture; Secure", "HSID=fixture; Domain=.google.com",
			"unrelated=fixture; Domain=.google.com; Secure",
			"SID=fixture; Domain=.example.test; Secure", "APISID=fixture; Domain=.google.com",
			"SSID=fixture; Domain=.google.com", "SAPISID=fixture; Domain=.google.com; Secure",
		} {
			header.Add("Set-Cookie", v)
		}
		return &http.Response{Header: header}, nil
	})}
	req, _ := http.NewRequest("GET", "https://messages.google.com/web/config", nil)
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal("Google endpoint was rejected")
	}
	var names []string
	for _, c := range resp.Cookies() {
		names = append(names, c.Name)
	}
	if !reflect.DeepEqual(names, []string{"OSID", "HSID", "APISID", "SAPISID"}) {
		t.Fatal("rotating cookie allow-list mismatch")
	}
	req, _ = http.NewRequest("GET", "https://example.test/redirect", nil)
	if _, err = transport.RoundTrip(req); err == nil || calls != 1 {
		t.Fatal("unexpected destination reached the network")
	}
}

func TestMissingSessionProducesOnlyFixedError(t *testing.T) {
	if os.Getenv("TWINDESK_GM_TEST_CHILD") == "1" {
		main()
		os.Exit(0)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestMissingSessionProducesOnlyFixedError$")
	child.Env = append(os.Environ(), "TWINDESK_GM_TEST_CHILD=1")
	child.Stdin = bytes.NewBufferString("{\"op\":\"pair\",\"cookies\":{\"SID\":\"synthetic-private-value\"}}\n")
	got, err := child.CombinedOutput()
	if err != nil || string(got) != "{\"type\":\"failed\"}\n" {
		t.Fatal("invalid session produced unexpected diagnostics")
	}
}
