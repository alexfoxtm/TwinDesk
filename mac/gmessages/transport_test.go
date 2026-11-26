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
	"strconv"
	"testing"
	"time"

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
	rows, complete, err := listRCS(ctx, list)
	if err != nil || complete || calls != 2 || len(rows) != 2 {
		t.Fatal("repeated cursor was treated as a completed listing")
	}
	calls = 0
	_, _, err = listRCS(ctx, func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		cancel()
		return list(ctx, req)
	})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal("canceled listing fetched additional pages")
	}
}

func TestListRCSUsesPageTimeoutAndKeepsEarlierPages(t *testing.T) {
	previous := rcsPageTimeout
	rcsPageTimeout = 20 * time.Millisecond
	defer func() { rcsPageTimeout = previous }()
	page := func(id string, cursor *gmproto.Cursor) *gmproto.ListConversationsResponse {
		return &gmproto.ListConversationsResponse{Cursor: cursor,
			Conversations: []*gmproto.Conversation{{Type: gmproto.ConversationType_RCS, ConversationID: id}}}
	}
	for _, failure := range []string{"error", "timeout"} {
		calls := 0
		rows, complete, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
			calls++
			if calls == 1 {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("page request has no per-page deadline")
				}
				return page("first", &gmproto.Cursor{LastItemID: "one", LastItemTimestamp: 1}), nil
			}
			if failure == "error" {
				return nil, errors.New("synthetic page failure")
			}
			<-ctx.Done()
			return nil, ctx.Err()
		})
		if err != nil || complete || calls != 2 || len(rows) != 1 || rows["first"] == nil {
			t.Fatalf("later-page %s discarded successful pages", failure)
		}
	}
	if _, _, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		return nil, errors.New("synthetic first page failure")
	}); err == nil {
		t.Fatal("first-page failure was not reported")
	}
}

func TestBoundedOrRepeatedCursorDoesNotCompleteOrErase(t *testing.T) {
	const maxPages = 20
	page := func(id string, cursor *gmproto.Cursor) *gmproto.ListConversationsResponse {
		return &gmproto.ListConversationsResponse{Cursor: cursor,
			Conversations: []*gmproto.Conversation{{Type: gmproto.ConversationType_RCS, ConversationID: id}}}
	}
	kept := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, ConversationID: "kept"}
	applyPartial := func(t *testing.T, next map[string]*gmproto.Conversation, complete bool) {
		t.Helper()
		var buf bytes.Buffer
		b := inbox{out: &output{w: &buf}, ready: true, convs: map[string]*gmproto.Conversation{"kept": kept}}
		if b.apply(context.Background(), next, complete, nil) || !b.ready || bytes.Contains(buf.Bytes(), []byte(`"offline"`)) {
			t.Fatal("incomplete listing claimed completion or went offline")
		}
		if b.convs["kept"] != kept {
			t.Fatal("incomplete listing erased a previously known conversation")
		}
		for id, c := range next {
			if b.convs[id] != c {
				t.Fatal("incomplete listing dropped a collected conversation")
			}
		}
	}
	t.Run("page cap", func(t *testing.T) {
		calls := 0
		rows, complete, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
			calls++
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("page request has no per-page deadline")
			}
			id := "p" + strconv.Itoa(calls)
			return page(id, &gmproto.Cursor{LastItemID: id, LastItemTimestamp: int64(calls)}), nil
		})
		if err != nil || complete || calls != maxPages || len(rows) != maxPages {
			t.Fatalf("page cap claimed a complete listing: complete=%v calls=%d rows=%d err=%v", complete, calls, len(rows), err)
		}
		applyPartial(t, rows, complete)
		if len(rows) != maxPages {
			t.Fatal("page cap dropped collected pages")
		}
	})
	t.Run("repeated cursor", func(t *testing.T) {
		cursor := &gmproto.Cursor{LastItemID: "again", LastItemTimestamp: 7}
		calls := 0
		rows, complete, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
			calls++
			return page("r"+strconv.Itoa(calls), cursor), nil
		})
		if err != nil || complete || calls != 2 || len(rows) != 2 {
			t.Fatalf("repeated cursor claimed a complete listing: complete=%v calls=%d rows=%d err=%v", complete, calls, len(rows), err)
		}
		applyPartial(t, rows, complete)
	})
	t.Run("nil cursor", func(t *testing.T) {
		rows, complete, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
			return page("only", nil), nil
		})
		if err != nil || !complete || len(rows) != 1 || rows["only"] == nil {
			t.Fatal("a nil cursor was not a completed listing")
		}
	})
}

func TestPartialSyncKeepsCoherentListOnline(t *testing.T) {
	var buf bytes.Buffer
	old := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, ConversationID: "old", Name: "before"}
	kept := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, ConversationID: "kept"}
	b := inbox{out: &output{w: &buf}, ready: true, convs: map[string]*gmproto.Conversation{"old": old, "kept": kept}}
	fresh := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, ConversationID: "old", Name: "after"}
	if b.apply(context.Background(), map[string]*gmproto.Conversation{"old": fresh}, false, nil) {
		t.Fatal("partial listing reported complete")
	}
	if bytes.Contains(buf.Bytes(), []byte(`"offline"`)) || !b.ready {
		t.Fatal("partial listing marked the inbox offline")
	}
	if b.convs["kept"] != kept || b.convs["old"] != fresh {
		t.Fatal("partial listing dropped the previous coherent list or ignored the fresh page")
	}
	buf.Reset()
	cold := inbox{out: &output{w: &buf}, convs: map[string]*gmproto.Conversation{}}
	cold.apply(context.Background(), map[string]*gmproto.Conversation{"old": fresh}, false, nil)
	if !cold.ready || cold.convs["old"] != fresh || bytes.Contains(buf.Bytes(), []byte(`"offline"`)) {
		t.Fatal("successful pages were not published without a previous list")
	}
	buf.Reset()
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	b.apply(canceled, nil, false, context.Canceled)
	if buf.Len() != 0 || b.convs["kept"] != kept {
		t.Fatal("root cancellation published stale state")
	}
	b.apply(context.Background(), nil, false, errors.New("synthetic first page failure"))
	if b.ready || !bytes.Contains(buf.Bytes(), []byte(`"offline"`)) {
		t.Fatal("a failed first page did not go offline")
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

func TestIncompleteListingIsNotRestartedAtTheRetryPace(t *testing.T) {
	if got := syncDelay(false, true); got != 5*time.Minute {
		t.Fatalf("incomplete but online = %v, want 5m", got)
	}
	if got := syncDelay(true, true); got != time.Minute {
		t.Fatalf("complete = %v, want 1m", got)
	}
	for _, complete := range []bool{false, true} {
		if got := syncDelay(complete, false); got != 8*time.Second {
			t.Fatalf("offline = %v, want 8s", got)
		}
	}
}

func TestPartlyMappedGroupIsNeverAOnePersonConversation(t *testing.T) {
	c := &gmproto.Conversation{
		ConversationID: "fixture", Type: gmproto.ConversationType_RCS, DefaultOutgoingID: "self",
		Participants: []*gmproto.Participant{
			{ID: &gmproto.SmallInfo{ParticipantID: "self"}, IsMe: true},
			{ID: &gmproto.SmallInfo{ParticipantID: "p1", Number: "+12025550100"}},
			{ID: &gmproto.SmallInfo{ParticipantID: "p2"}},
		},
	}
	if s := summarize(c); !s.Group || len(s.Addrs) != 1 {
		t.Fatalf("group=%v addrs=%d, want a group with its one mapped address", s.Group, len(s.Addrs))
	}
	c.Participants = c.Participants[:2]
	if s := summarize(c); s.Group || len(s.Addrs) != 1 {
		t.Fatalf("group=%v addrs=%d, want a one-person conversation", s.Group, len(s.Addrs))
	}
}
