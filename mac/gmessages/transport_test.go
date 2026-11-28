// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestReopeningSameHistoryCancelsPreviousPhotoView(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in, write := io.Pipe()
	defer in.Close()
	defer write.Close()
	commands := make(chan command)
	go readCommands(ctx, bufio.NewScanner(in), commands)
	deadline := time.Now().Add(time.Minute).UnixMilli()
	send := func(op string, view int) command {
		t.Helper()
		if _, err := fmt.Fprintf(write, "{\"op\":%q,\"chat\":\"same\",\"photoView\":%d,\"deadline\":%d}\n", op, view, deadline); err != nil {
			t.Fatal(err)
		}
		select {
		case cmd := <-commands:
			return cmd
		case <-time.After(time.Second):
			t.Fatal("command reader did not forward " + op)
			return command{}
		}
	}
	send("history", 0)
	first := send("photo", 1)
	download, finish := first.callContext(ctx)
	defer finish()
	send("photo", 1)
	if download.Err() != nil {
		t.Fatal("another photo in the same view canceled the download")
	}
	reopened := send("photo", 2)
	queued, finishQueued := first.callContext(ctx)
	defer finishQueued()
	if !errors.Is(queued.Err(), context.Canceled) {
		t.Fatal("reopening loaded history left the old download eligible to run")
	}
	select {
	case <-download.Done():
	case <-time.After(time.Second):
		t.Fatal("reopening loaded history did not interrupt the running download")
	}
	next, finishNext := reopened.callContext(ctx)
	defer finishNext()
	if next.Err() != nil {
		t.Fatal("the reopened view inherited cancellation from the previous visit")
	}
}

func TestPairingDetailsUseComputerNameAndDesktopAppType(t *testing.T) {
	for _, tc := range []struct{ computer, label string }{
		{"Mac Studio\n", "TwinDesk (Mac Studio)"},
		{"  Büro Mac  ", "TwinDesk (Büro Mac)"},
		{" \n", "TwinDesk (Mac)"},
		{"first\nsecond", "TwinDesk (Mac)"},
		{"name\u202E", "TwinDesk (Mac)"},
		{string([]byte{0xff}), "TwinDesk (Mac)"},
		{strings.Repeat("M", 65), "TwinDesk (Mac)"},
	} {
		got := pairingDetails(tc.computer)
		if got.GetOS() != tc.label {
			t.Errorf("label for %q = %q, want %q", tc.computer, got.GetOS(), tc.label)
		}
		if got.GetDeviceType() != gmproto.DeviceType_PWA || got.GetBrowserType() != gmproto.BrowserType_OTHER ||
			got.GetUserAgent() != util.UserAgent {
			t.Fatalf("unexpected pairing metadata: %v", got)
		}
	}
}

func TestOpeningHistoryCancelsPreviousPhotoBeforeDispatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in, write := io.Pipe()
	defer in.Close()
	defer write.Close()
	commands := make(chan command, 16)
	go readCommands(ctx, bufio.NewScanner(in), commands)
	deadline := time.Now().Add(time.Minute).UnixMilli()
	send := func(op, chat string) command {
		t.Helper()
		if _, err := fmt.Fprintf(write, "{\"op\":%q,\"chat\":%q,\"deadline\":%d}\n", op, chat, deadline); err != nil {
			t.Fatal(err)
		}
		select {
		case cmd := <-commands:
			return cmd
		case <-time.After(time.Second):
			t.Fatal("command reader did not forward " + op)
			return command{}
		}
	}
	send("history", "first")
	first := send("photo", "first")
	download, finish := first.callContext(ctx)
	defer finish()
	if download.Err() != nil {
		t.Fatal("first photo was canceled before a conversation switch")
	}
	next := send("history", "next")
	select {
	case <-download.Done():
	case <-time.After(time.Second):
		t.Fatal("new history waited for the old photo deadline")
	}
	queued, finishQueued := first.callContext(ctx)
	defer finishQueued()
	if queued.Err() == nil {
		t.Fatal("a canceled photo queued before the history must not dispatch")
	}
	history, finishHistory := next.callContext(ctx)
	defer finishHistory()
	photo, finishPhoto := send("photo", "next").callContext(ctx)
	defer finishPhoto()
	if history.Err() != nil || photo.Err() != nil {
		t.Fatal("the new conversation inherited the previous cancellation")
	}
}

func TestProjectUsesMessageTransport(t *testing.T) {
	for kind, want := range map[int64]string{0: "", 1: "text", 2: "text", 3: "text", 4: "rcs", 9: ""} {
		if got := project(&gmproto.Message{Type: kind}, nil).Transport; got != want {
			t.Errorf("transport for type %d = %q, want %q", kind, got, want)
		}
	}
}

func TestProjectKeepsNonImageAttachmentsAndCaptions(t *testing.T) {
	available := attachmentOf(3, &gmproto.MediaContent{MimeType: "application/pdf", MediaName: "fixture.pdf", Size: 1024, MediaID: "fixture", DecryptionKey: []byte{1}})
	if available.Part != 3 || available.Name != "fixture.pdf" || available.MIME != "application/pdf" || available.Size != 1024 || !available.Save || len(available.Revision) != 64 {
		t.Fatalf("attachment metadata = %+v", available)
	}
	oversized := attachmentOf(0, &gmproto.MediaContent{Size: maxPhoto + 1, MediaID: "fixture", DecryptionKey: []byte{1}})
	if oversized.Save || attachmentOf(0, &gmproto.MediaContent{MediaID: "fixture"}).Save {
		t.Fatal("oversized and keyless attachments cannot be saved")
	}

	media := func(mime string, format gmproto.MediaFormats) *gmproto.MessageInfo {
		return &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{MimeType: mime, Format: format}}}
	}
	pdf := project(&gmproto.Message{
		MessageID: "pdf", Type: 4,
		MessageInfo: []*gmproto.MessageInfo{
			media("application/pdf", gmproto.MediaFormats_APP_PDF),
			&gmproto.MessageInfo{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: "Caption"}}},
		},
	}, nil)
	if pdf.Text != "Caption" || !pdf.Attachment || len(pdf.Photos) != 0 || pdf.Transport != "rcs" || pdf.ID != "pdf" {
		t.Fatalf("pdf caption = %+v", pdf)
	}
	video := project(&gmproto.Message{MessageID: "video", Type: 1, MessageInfo: []*gmproto.MessageInfo{media("video/mp4", gmproto.MediaFormats_VIDEO_MP4)}}, nil)
	if video.Text != "" || !video.Attachment || len(video.Photos) != 0 || video.Transport != "text" || !visibleItem(video) {
		t.Fatalf("video = %+v", video)
	}
	image := project(&gmproto.Message{MessageID: "image", Type: 2, MessageInfo: []*gmproto.MessageInfo{media("image/jpeg", gmproto.MediaFormats_IMAGE_JPEG)}}, nil)
	if image.Attachment || len(image.Photos) != 1 || image.Photos[0] != 0 || !visibleItem(image) {
		t.Fatalf("image = %+v", image)
	}
	empty := project(&gmproto.Message{MessageID: "empty", Type: 1, MessageInfo: []*gmproto.MessageInfo{media("", 0)}}, nil)
	if !empty.Attachment || len(empty.Photos) != 0 || !visibleItem(empty) {
		t.Fatalf("empty media = %+v", empty)
	}
	place := project(&gmproto.Message{MessageID: "place", MessageInfo: []*gmproto.MessageInfo{
		&gmproto.MessageInfo{Data: &gmproto.MessageInfo_LocationContent{LocationContent: &gmproto.LocationContent{
			MessageContent: &gmproto.MessageContent{Content: "Fixture place"},
		}}},
	}}, nil)
	if place.Text != "Fixture place" || place.Attachment || len(place.Photos) != 0 {
		t.Fatalf("location text = %+v", place)
	}
	pin := project(&gmproto.Message{MessageID: "pin", MessageInfo: []*gmproto.MessageInfo{
		&gmproto.MessageInfo{Data: &gmproto.MessageInfo_LocationContent{LocationContent: &gmproto.LocationContent{}}},
	}}, nil)
	if pin.Text != "" || !pin.Attachment || len(pin.Photos) != 0 || !visibleItem(pin) {
		t.Fatalf("bare location = %+v", pin)
	}
	if visibleItem(item{}) {
		t.Fatal("a row with no id is not history")
	}
}

func TestReplyIsIndependentOfSendModeAndRespectsReadOnly(t *testing.T) {
	for _, mode := range []gmproto.ConversationSendMode{
		gmproto.ConversationSendMode_SEND_MODE_AUTO,
		gmproto.ConversationSendMode_SEND_MODE_XMS,
		gmproto.ConversationSendMode_SEND_MODE_XMS_LATCH,
	} {
		for _, kind := range []gmproto.ConversationType{gmproto.ConversationType_RCS, gmproto.ConversationType_SMS} {
			c := &gmproto.Conversation{ConversationID: "fixture", Type: kind, SendMode: mode, DefaultOutgoingID: "self"}
			if !summarize(c, nil).Reply {
				t.Fatalf("reply unavailable for type %v in send mode %v", kind, mode)
			}
			c.ReadOnly = true
			if summarize(c, nil).Reply {
				t.Fatalf("read-only conversation offered a reply in send mode %v", mode)
			}
		}
	}
	if summarize(&gmproto.Conversation{ConversationID: "fixture"}, nil).Reply {
		t.Fatal("reply offered without a default outgoing participant")
	}
	if summarize(&gmproto.Conversation{ConversationID: "fixture", DefaultOutgoingID: "self",
		Status: gmproto.ConversationStatus_ARCHIVED}, nil).Reply {
		t.Fatal("reply offered for a conversation that is not listed")
	}
}

func TestListingKeepsEveryActiveConversationAndTagsItsKind(t *testing.T) {
	sms := &gmproto.Conversation{Type: gmproto.ConversationType_SMS, ConversationID: "sms", Status: gmproto.ConversationStatus_ACTIVE}
	mms := &gmproto.Conversation{ConversationID: "mms"}
	rcs := &gmproto.Conversation{Type: gmproto.ConversationType_RCS, ConversationID: "rcs"}
	archived := &gmproto.Conversation{Type: gmproto.ConversationType_SMS, ConversationID: "archived", Status: gmproto.ConversationStatus_ARCHIVED}
	rows, complete, err := listRCS(context.Background(), func(ctx context.Context, req *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error) {
		return &gmproto.ListConversationsResponse{Conversations: []*gmproto.Conversation{sms, mms, rcs, archived, {Type: gmproto.ConversationType_SMS}}}, nil
	})
	if err != nil || !complete || len(rows) != 3 || rows["sms"] != sms || rows["mms"] != mms || rows["rcs"] != rcs {
		t.Fatalf("listing kept %d rows, want sms, mms and rcs", len(rows))
	}
	for c, want := range map[*gmproto.Conversation]string{sms: "sms", mms: "", rcs: "rcs"} {
		if got := summarize(c, nil).Kind; got != want {
			t.Errorf("kind of %s = %q, want %q", c.GetConversationID(), got, want)
		}
	}
	var buf bytes.Buffer
	b := inbox{out: &output{w: &buf}, ready: true, convs: map[string]*gmproto.Conversation{}}
	b.update(sms)
	if b.convs["sms"] != sms {
		t.Fatal("an SMS conversation event was not kept")
	}
	b.update(&gmproto.Conversation{Type: gmproto.ConversationType_SMS, ConversationID: "sms", Status: gmproto.ConversationStatus_ARCHIVED})
	if b.convs["sms"] != nil {
		t.Fatal("an archived conversation event was not removed")
	}
	b.publish()
	if !bytes.Contains(buf.Bytes(), []byte(`"items":[]`)) {
		t.Fatal("archived conversation was still published")
	}
	b.update(mms)
	buf.Reset()
	b.publish()
	if !bytes.Contains(buf.Bytes(), []byte(`"kind":""`)) {
		t.Fatal("an unknown kind was not sent explicitly")
	}
}

func TestTypingRejectsSMS(t *testing.T) {
	b := inbox{ready: true, active: "sms", convs: map[string]*gmproto.Conversation{
		"sms": {ConversationID: "sms", Type: gmproto.ConversationType_SMS},
	}}
	if b.handle(context.Background(), command{Op: "typing", Chat: "sms"}) {
		t.Fatal("typing accepted for an SMS conversation")
	}
}

func TestOnePersonShapesHaveOneAddress(t *testing.T) {
	sims := []*gmproto.SIMCard{{SIMParticipant: &gmproto.SIMParticipant{ID: "sim2"}}}
	base := func(extra ...*gmproto.Participant) *gmproto.Conversation {
		return &gmproto.Conversation{
			ConversationID: "fixture", Type: gmproto.ConversationType_RCS, DefaultOutgoingID: "self",
			Participants: append([]*gmproto.Participant{
				{ID: &gmproto.SmallInfo{ParticipantID: "self"}, IsMe: true, IsVisible: true},
				{ID: &gmproto.SmallInfo{ParticipantID: "p1", Number: "+1 202-555-0100"}, FullName: "Arkadiy", IsVisible: true},
			}, extra...),
			OtherParticipants: []string{"p1"},
		}
	}
	for name, c := range map[string]*gmproto.Conversation{
		"invisible participant": base(&gmproto.Participant{ID: &gmproto.SmallInfo{ParticipantID: "p2", Number: "+12025550199"}}),
		"second SIM self entry": base(&gmproto.Participant{ID: &gmproto.SmallInfo{ParticipantID: "sim2", Number: "+12025550111"}, IsVisible: true}),
		"duplicated number":     base(&gmproto.Participant{ID: &gmproto.SmallInfo{ParticipantID: "p3", Number: "+12025550100"}, IsVisible: true}),
	} {
		s := summarize(c, sims)
		if s.Group || len(s.Addrs) != 1 || s.Addrs[0] != "+1 202-555-0100" || s.Name != "Arkadiy" || s.People != nil {
			t.Errorf("%s: group=%v addrs=%v name=%q people=%v, want a one-to-one conversation", name, s.Group, s.Addrs, s.Name, s.People)
		}
	}
}

func TestGroupFromOtherParticipantsOrGroupFlag(t *testing.T) {
	c := &gmproto.Conversation{
		ConversationID: "fixture", Type: gmproto.ConversationType_RCS, DefaultOutgoingID: "self",
		Participants: []*gmproto.Participant{
			{ID: &gmproto.SmallInfo{ParticipantID: "self"}, IsMe: true},
			{ID: &gmproto.SmallInfo{ParticipantID: "p1", Number: "+12025550100"}, FullName: "Ann", IsVisible: true},
		},
		OtherParticipants: []string{"p1", "self", "unmapped"},
	}
	s := summarize(c, nil)
	if !s.Group || len(s.Addrs) != 1 || len(s.People) != 1 || s.People[0] != (person{"Ann", "+12025550100"}) {
		t.Fatalf("group=%v addrs=%v people=%v, want a group from an unmapped other participant", s.Group, s.Addrs, s.People)
	}
	c.OtherParticipants = []string{"p1", "self"}
	if summarize(c, nil).Group {
		t.Fatal("mapped and self other participants made a group")
	}
	c.IsGroupChat = true
	if s := summarize(c, nil); !s.Group || len(s.Addrs) != 1 || len(s.People) != 1 {
		t.Fatal("a group chat with one member was not a group")
	}
	for i := 0; i < 30; i++ {
		c.Participants = append(c.Participants, &gmproto.Participant{
			ID: &gmproto.SmallInfo{ParticipantID: "m" + strconv.Itoa(i), Number: "+1202555" + strconv.Itoa(1000+i)}, IsVisible: true})
	}
	if s := summarize(c, nil); len(s.People) != maxPeople || len(s.Addrs) != 31 {
		t.Fatalf("people=%d addrs=%d, want %d people and every address", len(s.People), len(s.Addrs), maxPeople)
	}
}

func TestForceRCSFollowsTheNewestEncryptionMarker(t *testing.T) {
	marker := func(status gmproto.MessageStatusType, at int64) *gmproto.Message {
		return &gmproto.Message{MessageID: "m" + strconv.FormatInt(at, 10), Timestamp: at,
			MessageStatus: &gmproto.MessageStatus{Status: status}}
	}
	rcs := &gmproto.Conversation{ConversationID: "chat", Type: gmproto.ConversationType_RCS, DefaultOutgoingID: "self"}
	sms := &gmproto.Conversation{ConversationID: "chat", Type: gmproto.ConversationType_SMS, DefaultOutgoingID: "self"}
	b := inbox{convs: map[string]*gmproto.Conversation{"chat": rcs}}
	force := func(c *gmproto.Conversation) bool {
		r := b.request(c, "chat", "tmp", nil)
		if r.GetConversationID() != "chat" || r.GetMessagePayload().GetParticipantID() != "self" || r.GetTmpID() != "tmp" {
			t.Fatal("request lost its conversation, participant or temporary id")
		}
		return r.GetForceRCS()
	}
	if force(rcs) {
		t.Fatal("RCS without a marker forced RCS")
	}
	if _, ok := b.remember("chat", marker(237, 100)); ok {
		t.Fatal("an encryption marker was projected as a message")
	}
	if !force(rcs) {
		t.Fatal("RCS after marker 237 did not force RCS")
	}
	if force(sms) {
		t.Fatal("SMS forced RCS")
	}
	xms := &gmproto.Conversation{ConversationID: "chat", Type: gmproto.ConversationType_RCS, DefaultOutgoingID: "self",
		SendMode: gmproto.ConversationSendMode_SEND_MODE_XMS}
	if force(xms) {
		t.Fatal("XMS send mode forced RCS")
	}
	b.mark("chat", marker(238, 200))
	if force(rcs) {
		t.Fatal("a later 238 did not turn ForceRCS off")
	}
	b.mark("chat", marker(235, 150))
	if force(rcs) {
		t.Fatal("an older marker overrode a newer one")
	}
	b.mark("chat", marker(235, 300))
	if !force(rcs) {
		t.Fatal("a newer 235 did not turn ForceRCS on")
	}
	b.mark("chat", marker(236, 250))
	if !force(rcs) {
		t.Fatal("an older 236 overrode a newer marker")
	}
	b.mark("chat", marker(236, 400))
	if force(rcs) {
		t.Fatal("a newer 236 did not turn ForceRCS off")
	}
}

func TestProjectMapsSendStatusDropsMarkersAndResolvesSender(t *testing.T) {
	msg := func(status gmproto.MessageStatusType) *gmproto.Message {
		return &gmproto.Message{MessageID: "m", MessageStatus: &gmproto.MessageStatus{Status: status},
			MessageInfo: []*gmproto.MessageInfo{{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: "hi"}}}}}
	}
	for _, status := range []gmproto.MessageStatusType{8, 9, 13, 17, 18, 19, 21, 22, 24, 25, 27} {
		if got := project(msg(status), nil).Status; got != "failed" {
			t.Errorf("status %d = %q, want failed", status, got)
		}
	}
	for _, status := range []gmproto.MessageStatusType{4, 5, 6, 7, 10, 20} {
		if got := project(msg(status), nil).Status; got != "sending" {
			t.Errorf("status %d = %q, want sending", status, got)
		}
	}
	for _, status := range []gmproto.MessageStatusType{1, 2, 11, 100, 101} {
		if got := project(msg(status), nil).Status; got != "" {
			t.Errorf("status %d = %q, want none", status, got)
		}
	}
	c := &gmproto.Conversation{ConversationID: "chat", Participants: []*gmproto.Participant{
		{ID: &gmproto.SmallInfo{ParticipantID: "self"}, IsMe: true},
		{ID: &gmproto.SmallInfo{ParticipantID: "p1", Number: "+12025550100"}, FullName: "Ann"},
	}}
	var buf bytes.Buffer
	b := inbox{out: &output{w: &buf}, convs: map[string]*gmproto.Conversation{"chat": c}}
	for _, status := range []gmproto.MessageStatusType{200, 207, 235, 239} {
		if _, ok := b.remember("chat", msg(status)); ok {
			t.Errorf("status %d was not dropped", status)
		}
	}
	in := msg(100)
	in.ParticipantID = "p1"
	if i, ok := b.remember("chat", in); !ok || i.Me || i.From != "Ann" {
		t.Fatalf("incoming sender = %q me=%v, want the participant's name", i.From, i.Me)
	}
	in.SenderParticipant = &gmproto.Participant{FullName: "Named"}
	if i := project(in, c); i.From != "Named" {
		t.Fatal("a present sender was replaced by the participant")
	}
	mine := msg(0)
	mine.ParticipantID = "self"
	if i := project(mine, c); !i.Me || i.From != "" {
		t.Fatal("a message from the self participant was not mine")
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
			{ID: &gmproto.SmallInfo{ParticipantID: "self"}, IsMe: true, IsVisible: true},
			{ID: &gmproto.SmallInfo{ParticipantID: "p1", Number: "+12025550100"}, IsVisible: true},
			{ID: &gmproto.SmallInfo{ParticipantID: "p2"}, IsVisible: true},
		},
	}
	if s := summarize(c, nil); !s.Group || len(s.Addrs) != 1 {
		t.Fatalf("group=%v addrs=%d, want a group with its one mapped address", s.Group, len(s.Addrs))
	}
	c.Participants = c.Participants[:2]
	if s := summarize(c, nil); s.Group || len(s.Addrs) != 1 {
		t.Fatalf("group=%v addrs=%d, want a one-person conversation", s.Group, len(s.Addrs))
	}
}

func TestAttachmentRevisionRejectsChangedPayloadBeforeFetch(t *testing.T) {
	media := &gmproto.MediaContent{MimeType: "application/pdf", MediaName: "fixture.pdf", Size: 1024, MediaID: "fixture", DecryptionKey: []byte{1}}
	original := attachmentOf(0, media)
	base := *media
	b := &inbox{photos: map[string]map[string][]*gmproto.MessageInfo{"chat": {"message": {&gmproto.MessageInfo{Data: &gmproto.MessageInfo_MediaContent{MediaContent: media}}}}}}
	cmd := command{Chat: "chat", Message: "message", Part: 0, Revision: original.Revision}
	// There is no client in this fixture: every mismatch must refuse before a fetch.
	for _, mutate := range []func(){func() { media.MediaID = "replacement" }, func() { media.DecryptionKey = []byte{2} }, func() { media.MediaName = "replacement.pdf" }, func() { media.Size++ }} {
		*media = base
		mutate()
		if attachmentOf(0, media).Revision == original.Revision || b.attachment(context.Background(), cmd) {
			t.Fatal("changed media kept a pending Save authorized")
		}
	}
	cmd.Revision = ""
	if b.attachment(context.Background(), cmd) {
		t.Fatal("missing revision accepted")
	}
}
