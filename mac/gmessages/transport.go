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
	"os/exec"
	"runtime/debug"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

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

	photoContext context.Context
}

func (cmd command) callContext(ctx context.Context) (context.Context, context.CancelFunc) {
	call, cancel := context.WithDeadline(ctx, time.UnixMilli(cmd.Deadline))
	if cmd.photoContext == nil {
		return call, cancel
	}
	stop := context.AfterFunc(cmd.photoContext, cancel)
	if cmd.photoContext.Err() != nil {
		cancel()
	}
	return call, func() { stop(); cancel() }
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

func computerName(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--get", "ComputerName").Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func pairingDetails(name string) *gmproto.BrowserDetails {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 64 ||
		strings.ContainsFunc(name, func(r rune) bool { return !unicode.IsPrint(r) }) {
		name = "Mac"
	}
	return &gmproto.BrowserDetails{
		UserAgent: util.UserAgent, BrowserType: gmproto.BrowserType_OTHER,
		OS: "TwinDesk (" + name + ")",
		// The protocol has no native Mac type. PWA identifies an installed app.
		DeviceType: gmproto.DeviceType_PWA,
	}
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
	// This helper pairs at most once. Set libgm's pairing metadata before it builds either Gaia payload.
	util.BrowserDetailsMessage = pairingDetails(computerName(ctx))
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
	Status    string `json:"status,omitempty"`
}

type person struct {
	Name   string `json:"name"`
	Number string `json:"number"`
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
	Kind      string   `json:"kind"`
	People    []person `json:"people,omitempty"`
}

const maxPeople = 20

// An inbox conversation of any type is listed while it is active (or its status is unknown).
func listed(c *gmproto.Conversation) bool {
	return c.GetConversationID() != "" &&
		(c.GetStatus() == gmproto.ConversationStatus_ACTIVE || c.GetStatus() == gmproto.ConversationStatus_UNKNOWN_CONVERSATION_STATUS)
}

func kind(c *gmproto.Conversation) string {
	switch c.GetType() {
	case gmproto.ConversationType_RCS:
		return "rcs"
	case gmproto.ConversationType_SMS:
		return "sms"
	}
	return ""
}

func digits(number string) string {
	var b strings.Builder
	for _, r := range number {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return number
	}
	return b.String()
}

// Self is IsMe, the conversation's default outgoing participant, or a SIM participant from Settings.
func isSelf(c *gmproto.Conversation, sims []*gmproto.SIMCard, p *gmproto.Participant) bool {
	return p.GetIsMe() || selfID(c, sims, p.GetID().GetParticipantID())
}

func selfID(c *gmproto.Conversation, sims []*gmproto.SIMCard, id string) bool {
	if id == "" {
		return false
	}
	if id == c.GetDefaultOutgoingID() {
		return true
	}
	for _, s := range sims {
		if s.GetSIMParticipant().GetID() == id {
			return true
		}
	}
	return false
}

func summarize(c *gmproto.Conversation, sims []*gmproto.SIMCard) conversation {
	addrs := make([]string, 0, len(c.GetParticipants()))
	var people []person
	name := c.GetName()
	numbers := make(map[string]bool)
	entries := make(map[string]bool)
	members := 0
	var remote []*gmproto.Participant
	for _, p := range c.GetParticipants() {
		if id := p.GetID().GetParticipantID(); id != "" {
			entries[id] = true
		}
		if isSelf(c, sims, p) || !p.GetIsVisible() {
			continue
		}
		number := p.GetID().GetNumber()
		if number != "" {
			key := digits(number)
			if numbers[key] {
				continue
			}
			numbers[key] = true
			addrs = append(addrs, number)
		}
		members++
		remote = append(remote, p)
	}
	for _, id := range c.GetOtherParticipants() {
		if id != "" && !entries[id] && !selfID(c, sims, id) {
			entries[id] = true
			members++
		}
	}
	group := c.GetIsGroupChat() || members > 1
	for _, p := range remote {
		if group {
			if len(people) < maxPeople {
				people = append(people, person{p.GetFullName(), p.GetID().GetNumber()})
			}
		} else if name == "" {
			name = p.GetFullName()
		}
	}
	return conversation{ID: c.GetConversationID(), Name: name, Addrs: addrs, Group: group,
		Reply: listed(c) && !c.GetReadOnly() && c.GetDefaultOutgoingID() != "", At: c.GetLastMessageTimestamp() / 1000,
		Snippet: c.GetLatestMessage().GetDisplayContent(), SnippetMe: direction(c.GetLatestMessage().GetLatestMessageStatus().GetStatus()),
		Kind: kind(c), People: people}
}

func direction(status gmproto.MessageStatusType) *bool {
	if status == 0 {
		return nil
	}
	me := status > 0 && status < 100
	return &me
}

func sendStatus(status gmproto.MessageStatusType) string {
	switch status {
	case 8, 9, 13, 17, 18, 19, 21, 22, 24, 25, 27:
		return "failed"
	case 4, 5, 6, 7, 10, 20:
		return "sending"
	}
	return ""
}

// When the message carries no sender, the conversation participant with its ParticipantID stands in.
func sender(m *gmproto.Message, c *gmproto.Conversation) *gmproto.Participant {
	s := m.GetSenderParticipant()
	if s != nil && (s.GetIsMe() || s.GetFullName() != "" || s.GetID().GetParticipantID() != "" || s.GetID().GetNumber() != "") {
		return s
	}
	if id := m.GetParticipantID(); id != "" {
		for _, p := range c.GetParticipants() {
			if p.GetID().GetParticipantID() == id {
				return p
			}
		}
	}
	return s
}

func project(m *gmproto.Message, c *gmproto.Conversation) item {
	status := m.GetMessageStatus().GetStatus()
	from := sender(m, c)
	i := item{ID: m.GetMessageID(), At: m.GetTimestamp() / 1000,
		Me: from.GetIsMe() || (status > 0 && status < 100), Status: sendStatus(status)}
	switch m.GetType() {
	case 1, 2, 3: // SMS and the downloaded/pending MMS variants
		i.Transport = "text"
	case 4: // RCS, including in a conversation that has also used SMS
		i.Transport = "rcs"
	}
	if !i.Me {
		i.From = from.GetFullName()
		if i.From == "" {
			i.From = from.GetID().GetNumber()
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
	markers map[string]marker
	ready   bool
	active  string
}

// The newest encryption-switch marker seen for a chat, by message timestamp.
type marker struct {
	at int64
	on bool
}

func (b *inbox) mark(chat string, m *gmproto.Message) {
	var on bool
	switch m.GetMessageStatus().GetStatus() {
	case 235, 237:
		on = true
	case 236, 238:
		on = false
	default:
		return
	}
	if chat == "" {
		return
	}
	if b.markers == nil {
		b.markers = make(map[string]marker)
	}
	if prev, ok := b.markers[chat]; ok && prev.at > m.GetTimestamp() {
		return
	}
	b.markers[chat] = marker{m.GetTimestamp(), on}
}

func (b *inbox) update(c *gmproto.Conversation) {
	id := c.GetConversationID()
	if listed(c) {
		b.convs[id] = c
	} else {
		delete(b.convs, id)
	}
}

func (b *inbox) publish() {
	rows := make([]conversation, 0, len(b.convs))
	for _, c := range b.convs {
		rows = append(rows, summarize(c, b.sims))
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

// Each page has its own deadline. A later page that fails or times out ends the listing with the
// pages already collected (complete == false); a failed first page or root cancellation is an error.
// A nil cursor is the only completed listing. The 20-page bound and a repeated cursor are not an
// end: completion stays false so a previous inbox is not replaced.
var rcsPageTimeout = 15 * time.Second

func listRCS(ctx context.Context, list func(context.Context, *gmproto.ListConversationsRequest) (*gmproto.ListConversationsResponse, error)) (map[string]*gmproto.Conversation, bool, error) {
	const maxPages = 20
	next := make(map[string]*gmproto.Conversation)
	type position struct {
		id string
		at int64
	}
	seen := make(map[position]bool)
	var cursor *gmproto.Cursor
	ended := false
	for page := 0; page < maxPages; page++ {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		call, cancel := context.WithTimeout(ctx, rcsPageTimeout)
		resp, err := list(call, &gmproto.ListConversationsRequest{
			Count: 100, Folder: gmproto.ListConversationsRequest_INBOX, Cursor: cursor,
		})
		cancel()
		if rootErr := ctx.Err(); rootErr != nil {
			return nil, false, rootErr
		}
		if err != nil {
			if page == 0 {
				return nil, false, err
			}
			return next, false, nil
		}
		for _, c := range resp.GetConversations() {
			if id := c.GetConversationID(); listed(c) && next[id] == nil {
				next[id] = c
			}
		}
		cursor = resp.GetCursor()
		if cursor == nil {
			ended = true
			break
		}
		pos := position{cursor.GetLastItemID(), cursor.GetLastItemTimestamp()}
		if seen[pos] {
			break
		}
		seen[pos] = true
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return next, ended, nil
}

// The wait before the next listing: a complete one is refreshed every minute, a failed one is
// retried soon, and one that stopped at the page bound or a repeated cursor is not restarted at
// the retry pace (it would list the same pages again).
func syncDelay(complete, ready bool) time.Duration {
	switch {
	case !ready:
		return 8 * time.Second
	case complete:
		return time.Minute
	default:
		return 5 * time.Minute
	}
}

// Returns whether the inbox now holds a complete listing.
func (b *inbox) sync(ctx context.Context) bool {
	next, complete, err := listRCS(ctx, b.client.ListConversations)
	return b.apply(ctx, next, complete, err)
}

func (b *inbox) apply(ctx context.Context, next map[string]*gmproto.Conversation, complete bool, err error) bool {
	if ctx.Err() != nil {
		// Root cancellation: this owner is ending. Nothing stale is published.
		return false
	}
	if err != nil {
		b.offline()
		return false
	}
	if !complete && b.ready {
		// Stopped before a real end: keep previously known conversations, refreshed by pages that arrived.
		for id, c := range next {
			b.convs[id] = c
		}
		next = b.convs
	}
	b.convs = next
	b.ready = true
	b.publish()
	return complete
}

// Feeds the encryption marker, then drops status markers (>= 200) and projects the rest.
func (b *inbox) remember(chat string, m *gmproto.Message) (item, bool) {
	b.mark(chat, m)
	if m.GetMessageStatus().GetStatus() >= 200 {
		return item{}, false
	}
	i := project(m, b.convs[chat])
	if chat == b.active && len(i.Photos) != 0 {
		if b.photos[chat] == nil {
			b.photos[chat] = make(map[string][]*gmproto.MessageInfo)
		}
		b.photos[chat][i.ID] = m.GetMessageInfo()
	}
	return i, true
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
		i, ok := b.remember(chat, m)
		if ok && i.ID != "" && (i.Text != "" || len(i.Photos) != 0) {
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
	if !summarize(c, b.sims).Reply || len(cmd.Text) > 20000 {
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
	resp, err := b.client.SendMessage(ctx, b.request(c, cmd.Chat, util.GenerateTmpID(), parts))
	return err == nil && resp.GetStatus() == gmproto.SendMessageResponse_SUCCESS
}

// ForceRCS only for an RCS conversation in auto send mode whose newest encryption marker is "on";
// otherwise the phone decides.
func (b *inbox) request(c *gmproto.Conversation, chat, id string, parts []*gmproto.MessageInfo) *gmproto.SendMessageRequest {
	force := c.GetType() == gmproto.ConversationType_RCS &&
		c.GetSendMode() == gmproto.ConversationSendMode_SEND_MODE_AUTO && b.markers[chat].on
	return &gmproto.SendMessageRequest{
		ConversationID: chat, TmpID: id, SIMPayload: b.sim(c), ForceRCS: force,
		MessagePayload: &gmproto.MessagePayload{
			ConversationID: chat, TmpID: id, TmpID2: id, ParticipantID: c.GetDefaultOutgoingID(), MessageInfo: parts,
		},
	}
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
		return cmd.Chat == b.active && kind(c) == "rcs" && b.client.SetTyping(ctx, cmd.Chat, b.sim(c)) == nil
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
			complete := b.sync(ctx)
			syncTimer.Reset(syncDelay(complete, b.ready))
		case cmd := <-commands:
			call, cancel := cmd.callContext(ctx)
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
					b.update(e)
					b.publish()
				}
			case *libgm.WrappedMessage:
				chat := e.GetConversationID()
				b.mark(chat, e.Message)
				if b.ready && b.convs[chat] != nil {
					if i, ok := b.remember(chat, e.Message); ok {
						out.send(event{"type": "message", "chat": chat, "item": i})
					}
				}
			case *gmproto.TypingData:
				if b.ready && e.GetConversationID() == b.active && kind(b.convs[b.active]) == "rcs" {
					out.send(event{"type": "typing", "chat": b.active, "typing": e.GetType() == gmproto.TypingTypes_STARTED_TYPING})
				}
			}
		}
	}
}

// Cancel downloads when new history is requested, before the command reaches the serial inbox.
// The HTTP media reader takes this context, so switching chats can interrupt a slow download.
func readCommands(ctx context.Context, in *bufio.Scanner, commands chan<- command) {
	photos, cancelPhotos := context.WithCancel(ctx)
	defer func() { cancelPhotos() }()
	for in.Scan() {
		var cmd command
		if json.Unmarshal(in.Bytes(), &cmd) != nil {
			continue
		}
		switch cmd.Op {
		case "history":
			cancelPhotos()
			nextPhotos, cancelNextPhotos := context.WithCancel(ctx)
			photos, cancelPhotos = nextPhotos, cancelNextPhotos
		case "photo":
			cmd.photoContext = photos
		}
		select {
		case commands <- cmd:
		case <-ctx.Done():
			return
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
		readCommands(ctx, in, commands)
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
