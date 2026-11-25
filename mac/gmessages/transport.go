// SPDX-License-Identifier: AGPL-3.0-only
// The Google Messages transport runs behind the macOS Keychain bridge.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
	"go.mau.fi/util/exhttp"
)

const maxPhoto = 6 << 20

var requiredCookies = []string{"SID", "HSID", "SSID", "OSID", "APISID", "SAPISID"}

func allowedCookie(name string) bool {
	switch name {
	case "SID", "HSID", "SSID", "OSID", "APISID", "SAPISID":
		return true
	}
	return strings.HasPrefix(name, "__Secure-")
}

func cookieNeedsSecure(name string) bool {
	switch name {
	case "SSID", "SAPISID", "OSID":
		return true
	}
	return strings.HasPrefix(name, "__Secure-")
}

func filterCookies(cookies map[string]string) bool {
	for name := range cookies {
		if !allowedCookie(name) {
			delete(cookies, name)
		}
	}
	for _, name := range requiredCookies {
		if cookies[name] == "" {
			return false
		}
	}
	return true
}

type googleTransport struct{ http.RoundTripper }

func (t googleTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	host := req.URL.Host
	switch host {
	case "messages.google.com", "instantmessaging-pa.clients6.google.com", "instantmessaging-pa.googleapis.com":
	default:
		return nil, errors.New("unexpected Google Messages endpoint")
	}
	if req.URL.Scheme != "https" || req.URL.User != nil {
		return nil, errors.New("invalid Google Messages endpoint")
	}
	resp, err := t.RoundTripper.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	// libgm flattens response cookies into AuthData. Filter before it sees them.
	cookies := resp.Cookies()
	resp.Header.Del("Set-Cookie")
	for _, cookie := range cookies {
		if !allowedCookie(cookie.Name) || (cookieNeedsSecure(cookie.Name) && !cookie.Secure) {
			continue
		}
		domain := strings.TrimPrefix(cookie.Domain, ".")
		if cookie.Name == "OSID" {
			if host != "messages.google.com" || (domain != "" && domain != host) {
				continue
			}
		} else if domain != "google.com" {
			continue
		}
		resp.Header.Add("Set-Cookie", cookie.String())
	}
	return resp, nil
}

func client(auth *libgm.AuthData) *libgm.Client {
	settings := exhttp.SensibleClientSettings.WithGlobalTimeout(45 * time.Second)
	settings.TransportOverride = func(s exhttp.ClientSettings) http.RoundTripper {
		return googleTransport{s.Configure(&http.Transport{})}
	}
	return libgm.NewClient(auth, nil, zerolog.Nop(), settings)
}

type command struct {
	Op       string            `json:"op"`
	Cookies  map[string]string `json:"cookies"`
	Session  *libgm.AuthData   `json:"session"`
	Chat     string            `json:"chat"`
	Message  string            `json:"message"`
	Part     int               `json:"part"`
	Text     string            `json:"text"`
	Image    string            `json:"image"`
	Ref      int               `json:"ref"`
	Deadline int64             `json:"deadline"`
}

type output struct {
	mu sync.Mutex
	w  io.Writer
}

type event map[string]any

func (o *output) send(value event) {
	o.mu.Lock()
	defer o.mu.Unlock()
	_ = json.NewEncoder(o.w).Encode(value)
}

func (o *output) save(auth *libgm.AuthData) bool {
	auth.CookiesLock.Lock()
	valid := filterCookies(auth.Cookies)
	auth.CookiesLock.Unlock()
	if valid {
		o.send(event{"type": "session", "session": auth})
	}
	return valid
}

func pair(ctx context.Context, cookies map[string]string, out *output) *libgm.AuthData {
	if !filterCookies(cookies) {
		return nil
	}
	auth := libgm.NewAuthData()
	auth.SetCookies(cookies)
	c := client(auth)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	defer c.Disconnect()
	if c.FetchConfig(ctx) != nil {
		return nil
	}
	emoji, session, err := c.StartGaiaPairing(ctx, ctx)
	if err != nil {
		return nil
	}
	out.send(event{"type": "emoji", "emoji": emoji})
	if _, err = c.FinishGaiaPairing(ctx, session); err != nil {
		return nil
	}
	return auth
}

type item struct {
	ID        string `json:"id"`
	At        int64  `json:"at"`
	Text      string `json:"text"`
	From      string `json:"from,omitempty"`
	Me        bool   `json:"me"`
	Receipt   string `json:"receipt,omitempty"`
	Photos    []int  `json:"photos,omitempty"`
	Transport string `json:"transport,omitempty"`
}

type conversation struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Addrs     []string `json:"addrs"`
	Group     bool     `json:"group"`
	Reply     bool     `json:"reply"`
	At        int64    `json:"at"`
	Snippet   string   `json:"snippet"`
	SnippetMe *bool    `json:"snippetMe,omitempty"`
}

func isRCS(c *gmproto.Conversation) bool {
	return c.GetType() == gmproto.ConversationType_RCS &&
		(c.GetStatus() == gmproto.ConversationStatus_ACTIVE || c.GetStatus() == gmproto.ConversationStatus_UNKNOWN_CONVERSATION_STATUS)
}

func summarize(c *gmproto.Conversation) conversation {
	addrs := make([]string, 0, len(c.GetParticipants()))
	name := c.GetName()
	group := c.GetIsGroupChat() || len(c.GetOtherParticipants()) > 1
	for _, p := range c.GetParticipants() {
		if p.GetIsMe() || p.GetID().GetParticipantID() == c.GetDefaultOutgoingID() {
			continue
		}
		if number := p.GetID().GetNumber(); number != "" {
			addrs = append(addrs, number)
		}
		if name == "" && !group {
			name = p.GetFullName()
		}
	}
	return conversation{c.GetConversationID(), name, addrs, group,
		!c.GetReadOnly() && c.GetDefaultOutgoingID() != "", c.GetLastMessageTimestamp() / 1000,
		c.GetLatestMessage().GetDisplayContent(), direction(c.GetLatestMessage().GetLatestMessageStatus().GetStatus())}
}

func direction(status gmproto.MessageStatusType) *bool {
	if status == 0 {
		return nil
	}
	me := status > 0 && status < 100
	return &me
}

func project(m *gmproto.Message) item {
	status := m.GetMessageStatus().GetStatus()
	i := item{ID: m.GetMessageID(), At: m.GetTimestamp() / 1000,
		Me: m.GetSenderParticipant().GetIsMe() || (status > 0 && status < 100)}
	switch m.GetType() {
	case 1, 2, 3: // SMS and the downloaded/pending MMS variants
		i.Transport = "text"
	case 4: // RCS, including in a conversation that has also used SMS
		i.Transport = "rcs"
	}
	if !i.Me {
		i.From = m.GetSenderParticipant().GetFullName()
		if i.From == "" {
			i.From = m.GetSenderParticipant().GetID().GetNumber()
		}
	}
	switch status {
	case gmproto.MessageStatusType_OUTGOING_DISPLAYED:
		i.Receipt = "read"
	case gmproto.MessageStatusType_OUTGOING_DELIVERED:
		i.Receipt = "delivered"
	}
	var texts []string
	for index, part := range m.GetMessageInfo() {
		if content := part.GetMessageContent().GetContent(); content != "" {
			texts = append(texts, content)
		}
		if media := part.GetMediaContent(); media != nil &&
			(strings.HasPrefix(media.GetMimeType(), "image/") || strings.HasPrefix(libgm.FormatToMediaType[media.GetFormat()].Format, "image/")) {
			i.Photos = append(i.Photos, index)
		}
	}
	i.Text = strings.Join(texts, "\n")
	return i
}

type inbox struct {
	client  *libgm.Client
	out     *output
	convs   map[string]*gmproto.Conversation
	cursors map[string]*gmproto.Cursor
	photos  map[string]map[string][]*gmproto.MessageInfo
	sims    []*gmproto.SIMCard
	ready   bool
	active  string
}

func (b *inbox) publish() {
	rows := make([]conversation, 0, len(b.convs))
	for _, c := range b.convs {
		rows = append(rows, summarize(c))
	}
	b.out.send(event{"type": "conversations", "items": rows})
}

func (b *inbox) offline() {
	b.ready = false
	b.cursors = make(map[string]*gmproto.Cursor)
	b.photos = make(map[string]map[string][]*gmproto.MessageInfo)
	b.active = ""
	b.out.send(event{"type": "offline"})
}

func (b *inbox) sync(ctx context.Context) {
	resp, err := b.client.ListConversations(ctx, &gmproto.ListConversationsRequest{Count: 100, Folder: gmproto.ListConversationsRequest_INBOX})
	if err != nil {
		b.offline()
		return
	}
	next := make(map[string]*gmproto.Conversation)
	for _, c := range resp.GetConversations() {
		if isRCS(c) && c.GetConversationID() != "" {
			next[c.GetConversationID()] = c
		}
	}
	b.convs = next
	b.ready = true
	b.publish()
}

func (b *inbox) remember(chat string, m *gmproto.Message) item {
	i := project(m)
	if chat == b.active && len(i.Photos) != 0 {
		if b.photos[chat] == nil {
			b.photos[chat] = make(map[string][]*gmproto.MessageInfo)
		}
		b.photos[chat][i.ID] = m.GetMessageInfo()
	}
	return i
}

func (b *inbox) history(ctx context.Context, chat string, earlier bool) bool {
	var cursor *gmproto.Cursor
	if earlier {
		cursor = b.cursors[chat]
		if cursor == nil || chat != b.active {
			return false
		}
	} else {
		b.active = chat
		b.photos = make(map[string]map[string][]*gmproto.MessageInfo)
		b.cursors = make(map[string]*gmproto.Cursor)
	}
	resp, err := b.client.FetchMessages(ctx, chat, 50, cursor)
	if err != nil {
		return false
	}
	next := resp.GetCursor()
	more := next != nil && len(resp.GetMessages()) != 0 &&
		(cursor == nil || cursor.GetLastItemID() != next.GetLastItemID() || cursor.GetLastItemTimestamp() != next.GetLastItemTimestamp())
	if !more {
		next = nil
	}
	b.cursors[chat] = next
	items := make([]item, 0, len(resp.GetMessages()))
	for _, m := range resp.GetMessages() {
		i := b.remember(chat, m)
		if i.ID != "" && (i.Text != "" || len(i.Photos) != 0) {
			items = append(items, i)
		}
	}
	b.out.send(event{"type": "history", "chat": chat, "items": items, "earlier": earlier, "more": more})
	return true
}

func (b *inbox) sim(c *gmproto.Conversation) *gmproto.SIMPayload {
	if sim := c.GetSimCard().GetSIMData().GetSIMPayload(); sim != nil {
		return sim
	}
	for _, s := range b.sims {
		if s.GetSIMParticipant().GetID() == c.GetDefaultOutgoingID() {
			return s.GetSIMData().GetSIMPayload()
		}
	}
	for _, p := range c.GetParticipants() {
		if p.GetID().GetParticipantID() == c.GetDefaultOutgoingID() {
			return p.GetSimPayload()
		}
	}
	return nil
}

func (b *inbox) send(ctx context.Context, c *gmproto.Conversation, cmd command) bool {
	if !summarize(c).Reply || len(cmd.Text) > 20000 {
		return false
	}
	var parts []*gmproto.MessageInfo
	if cmd.Image != "" {
		data, ok := strings.CutPrefix(cmd.Image, "data:image/jpeg;base64,")
		if !ok || len(data) > maxPhoto {
			return false
		}
		raw, err := base64.StdEncoding.DecodeString(data)
		if err != nil || http.DetectContentType(raw) != "image/jpeg" {
			return false
		}
		media, err := b.client.UploadMedia(ctx, raw, "photo.jpg", "image/jpeg")
		if err != nil {
			return false
		}
		parts = append(parts, &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MediaContent{MediaContent: media}})
	}
	if cmd.Text != "" {
		parts = append(parts, &gmproto.MessageInfo{Data: &gmproto.MessageInfo_MessageContent{
			MessageContent: &gmproto.MessageContent{Content: cmd.Text},
		}})
	}
	if len(parts) == 0 {
		return false
	}
	id := util.GenerateTmpID()
	resp, err := b.client.SendMessage(ctx, &gmproto.SendMessageRequest{
		ConversationID: cmd.Chat, TmpID: id, SIMPayload: b.sim(c), ForceRCS: true,
		MessagePayload: &gmproto.MessagePayload{
			ConversationID: cmd.Chat, TmpID: id, TmpID2: id, ParticipantID: c.GetDefaultOutgoingID(), MessageInfo: parts,
		},
	})
	return err == nil && resp.GetStatus() == gmproto.SendMessageResponse_SUCCESS
}

func (b *inbox) photo(ctx context.Context, cmd command) bool {
	parts := b.photos[cmd.Chat][cmd.Message]
	if cmd.Part < 0 || cmd.Part >= len(parts) {
		return false
	}
	m := parts[cmd.Part].GetMediaContent()
	if m == nil {
		return false
	}
	id, key := m.GetMediaID(), m.GetDecryptionKey()
	if id == "" || m.GetSize() > maxPhoto {
		id, key = m.GetThumbnailMediaID(), m.GetThumbnailDecryptionKey()
	}
	if id == "" || len(key) == 0 {
		return false
	}
	r, err := b.client.DownloadMedia(ctx, id, key)
	if err != nil {
		return false
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, maxPhoto+1))
	if err != nil || len(data) > maxPhoto {
		return false
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		b.out.send(event{"type": "photo", "chat": cmd.Chat, "message": cmd.Message, "part": cmd.Part, "ref": cmd.Ref,
			"data": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)})
		return true
	}
	return false
}

func (b *inbox) handle(ctx context.Context, cmd command) bool {
	c := b.convs[cmd.Chat]
	if !b.ready || c == nil {
		return false
	}
	switch cmd.Op {
	case "history", "earlier":
		return b.history(ctx, cmd.Chat, cmd.Op == "earlier")
	case "send":
		return b.send(ctx, c, cmd)
	case "read":
		return cmd.Chat == b.active && cmd.Message != "" && b.client.MarkRead(ctx, cmd.Chat, cmd.Message) == nil
	case "typing":
		return cmd.Chat == b.active && b.client.SetTyping(ctx, cmd.Chat, b.sim(c)) == nil
	case "photo":
		return cmd.Chat == b.active && b.photo(ctx, cmd)
	}
	return false
}

func run(ctx context.Context, auth *libgm.AuthData, commands <-chan command, out *output) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := client(auth)
	defer c.Disconnect()
	queue := make(chan any, 256)
	resync := make(chan struct{}, 1)
	c.SetEventHandler(func(e any) {
		if _, ok := e.(*events.AuthTokenRefreshed); ok {
			if !out.save(auth) {
				cancel()
			}
			return
		}
		switch e.(type) {
		case *events.GaiaLoggedOut, *events.ListenFatalError:
			// Fatal auth failures cannot be dropped when the phone floods events.
			cancel()
		case *events.ListenTemporaryError, *events.PhoneNotResponding,
			*events.ListenRecovered, *events.PhoneRespondingAgain, *events.NoDataReceived,
			*gmproto.Settings, *gmproto.Conversation, *libgm.WrappedMessage, *gmproto.TypingData:
			select {
			case queue <- e:
			default:
				select {
				case resync <- struct{}{}:
				default:
				}
			}
		}
	})
	configCtx, cancelConfig := context.WithTimeout(ctx, 25*time.Second)
	configErr := c.FetchConfig(configCtx)
	cancelConfig()
	if configErr != nil || c.Config.GetDeviceInfo().GetEmail() == "" || !out.save(auth) || c.Connect(ctx) != nil {
		return
	}
	b := inbox{client: c, out: out, convs: make(map[string]*gmproto.Conversation)}
	syncTimer := time.NewTimer(2 * time.Second)
	defer syncTimer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-resync:
			b.offline()
			syncTimer.Reset(0)
		case <-syncTimer.C:
			call, cancel := context.WithTimeout(ctx, 25*time.Second)
			b.sync(call)
			cancel()
			if b.ready {
				syncTimer.Reset(time.Minute)
			} else {
				syncTimer.Reset(8 * time.Second)
			}
		case cmd := <-commands:
			deadline := time.UnixMilli(cmd.Deadline)
			call, cancel := context.WithDeadline(ctx, deadline)
			ok := call.Err() == nil && b.handle(call, cmd)
			cancel()
			if cmd.Ref != 0 {
				out.send(event{"type": "result", "ref": cmd.Ref, "ok": ok})
			}
		case entry := <-queue:
			switch e := entry.(type) {
			case *events.ListenTemporaryError, *events.PhoneNotResponding:
				b.offline()
			case *events.ListenRecovered, *events.PhoneRespondingAgain, *events.NoDataReceived:
				syncTimer.Reset(0)
			case *gmproto.Settings:
				b.sims = e.GetSIMCards()
			case *gmproto.Conversation:
				if b.ready {
					id := e.GetConversationID()
					if isRCS(e) && id != "" {
						b.convs[id] = e
					} else {
						delete(b.convs, id)
					}
					b.publish()
				}
			case *libgm.WrappedMessage:
				chat := e.GetConversationID()
				if b.ready && b.convs[chat] != nil {
					out.send(event{"type": "message", "chat": chat, "item": b.remember(chat, e.Message)})
				}
			case *gmproto.TypingData:
				if b.ready && e.GetConversationID() == b.active {
					out.send(event{"type": "typing", "chat": b.active, "typing": e.GetType() == gmproto.TypingTypes_STARTED_TYPING})
				}
			}
		}
	}
}

func main() {
	debug.SetTraceback("none")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 4096), 10_000_000)
	if !in.Scan() {
		return
	}
	var first command
	if json.Unmarshal(in.Bytes(), &first) != nil {
		return
	}
	out := &output{w: os.Stdout}
	commands := make(chan command, 16)
	go func() {
		defer cancel()
		for in.Scan() {
			var cmd command
			if json.Unmarshal(in.Bytes(), &cmd) == nil {
				select {
				case commands <- cmd:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	var auth *libgm.AuthData
	switch first.Op {
	case "pair":
		auth = pair(ctx, first.Cookies, out)
		if auth != nil {
			out.save(auth)
		}
	case "resume":
		auth = first.Session
	}
	if auth != nil && auth.RequestCrypto != nil && auth.RefreshKey != nil &&
		auth.Browser != nil && auth.Mobile != nil && len(auth.TachyonAuthToken) != 0 &&
		auth.PairingID != uuid.Nil && filterCookies(auth.Cookies) {
		run(ctx, auth, commands, out)
	}
	out.send(event{"type": "failed"})
}
