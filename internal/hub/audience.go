package hub

import (
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"billiards/internal/protocol"
	"billiards/internal/ws"
)

// Spectators and comments. A spectator joins with watch: it gets what the
// players get (room state, snapshots, the shooter's aim, results) but no
// seat, and may only comment and leave. Everyone in the room comments on
// one shared thread, at most once per ChatCooldown each.

// handleWatch lets c watch, if the room takes another spectator.
func (r *room) handleWatch(c *ws.Client, msg protocol.ClientMessage) bool {
	if r.practice || len(r.watchers) >= r.maxSpectators {
		c.SendJSON(protocol.NewError(protocol.ErrAudienceFull, "no more spectators can watch this room"))
		return false
	}
	name := strings.Join(strings.Fields(msg.Name), " ")
	if utf8.RuneCountInString(name) > maxNameLength {
		name = string([]rune(name)[:maxNameLength])
	}
	if name == "" || !utf8.ValidString(name) {
		name = "Guest"
	}
	r.watchers = append(r.watchers, &watcher{client: c, name: name})
	c.SendJSON(protocol.Welcome{
		Type:      protocol.TypeWelcome,
		V:         protocol.Version,
		Seat:      -1,
		RoomCode:  r.code,
		AimLine:   int(math.Round(max(0, r.hub.opts.AimLine) * 1000)),
		Spectator: true,
	})
	c.SendJSON(r.roomState())
	r.sendChatLog(c)
	r.broadcastAudience()
	return true
}

// handleWatcherMessage applies a message from spectator w.
func (r *room) handleWatcherMessage(w *watcher, msg protocol.ClientMessage) {
	switch msg.Type {
	case protocol.TypeChat:
		r.handleChat(w.client, w.name, -1, &w.lastChat, msg.Text)
	case protocol.TypeLeave:
		r.dropWatcher(r.watcherOf(w.client))
		w.client.Close(websocket.StatusNormalClosure, "left the room")
	case protocol.TypeJoin:
		w.client.SendJSON(protocol.NewError(protocol.ErrBadMessage, "already joined"))
	default:
		w.client.SendJSON(protocol.NewError(protocol.ErrSpectator, "spectators can only watch and comment"))
	}
}

// dropWatcher removes spectator i and tells the others.
func (r *room) dropWatcher(i int) {
	if i < 0 {
		return
	}
	r.watchers = append(r.watchers[:i], r.watchers[i+1:]...)
	r.broadcastAudience()
}

// closeWatchers sends the spectators away when the room goes.
func (r *room) closeWatchers() {
	for _, w := range r.watchers {
		w.client.Close(websocket.StatusGoingAway, "room closed")
	}
	r.watchers = nil
}

func (r *room) watcherNames() []string {
	names := make([]string, len(r.watchers))
	for i, w := range r.watchers {
		names[i] = w.name
	}
	return names
}

func (r *room) broadcastAudience() {
	r.broadcast(protocol.Audience{Type: protocol.TypeAudience, Names: r.watcherNames(), Max: r.maxSpectators})
}

// handleSetAudience changes how many spectators may watch. Lowering it
// below the number watching sends nobody away; it only keeps others out.
func (r *room) handleSetAudience(n *int) error {
	if r.practice || n == nil || *n < 0 || *n > r.hub.opts.MaxSpectators {
		return errBadSpectators
	}
	r.maxSpectators = *n
	r.broadcastAudience()
	return nil
}

// handleChat relays a comment from c (named from, in seat, -1 for a
// spectator) to everyone, unless it is empty, too long or too soon after
// the sender's last one (last).
func (r *room) handleChat(c *ws.Client, from string, seat int, last *time.Time, text string) {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" || !utf8.ValidString(text) || utf8.RuneCountInString(text) > maxChatLength {
		c.SendJSON(protocol.NewError(protocol.ErrBadMessage, "a comment is 1 to 200 characters"))
		return
	}
	now := time.Now()
	if cd := r.hub.opts.ChatCooldown; cd > 0 && !last.IsZero() {
		if wait := cd - now.Sub(*last); wait > 0 {
			e := protocol.NewError(protocol.ErrChatCooldown, "wait a moment before the next comment")
			e.RetryMs = int(math.Ceil(float64(wait) / float64(time.Millisecond)))
			c.SendJSON(e)
			return
		}
	}
	*last = now
	msg := protocol.Chat{Type: protocol.TypeChat, From: from, Seat: seat, Text: text, At: now.UnixMilli()}
	r.chatLog = append(r.chatLog, msg)
	if len(r.chatLog) > chatLogSize {
		r.chatLog = r.chatLog[len(r.chatLog)-chatLogSize:]
	}
	r.broadcast(msg)
}

// sendChatLog gives a newcomer the recent comments.
func (r *room) sendChatLog(c *ws.Client) {
	if len(r.chatLog) == 0 {
		return
	}
	c.SendJSON(protocol.ChatLog{Type: protocol.TypeChatLog, Messages: r.chatLog})
}
