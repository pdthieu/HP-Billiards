// Package ws wraps a WebSocket connection with a read pump, a write pump, a
// bounded outbound queue and a keepalive ping.
package ws

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"

	"billiards/internal/protocol"
)

const (
	outBuffer    = 32   // queued outbound messages per client
	readLimit    = 4096 // bytes per inbound message
	writeTimeout = 5 * time.Second
)

// Options tunes a Client. The zero value means DefaultOptions.
type Options struct {
	// PingInterval is how often the server pings the peer. A peer that does
	// not answer within PingTimeout is disconnected. Zero disables pinging.
	PingInterval time.Duration
	PingTimeout  time.Duration
}

// DefaultOptions pings every 20 seconds and gives up after 10.
func DefaultOptions() Options {
	return Options{PingInterval: 20 * time.Second, PingTimeout: 10 * time.Second}
}

// Client is one WebSocket connection. Send may be called from any goroutine.
type Client struct {
	conn *websocket.Conn
	opts Options

	mu     sync.Mutex
	queue  outQueue
	notify chan struct{} // signalled (capacity 1) when queue gains a message

	closeOnce   sync.Once
	done        chan struct{}
	closeCode   websocket.StatusCode
	closeReason string
}

// NewClient wraps an accepted connection. Call Run to start pumping.
func NewClient(conn *websocket.Conn, opts Options) *Client {
	conn.SetReadLimit(readLimit)
	return &Client{
		conn:   conn,
		opts:   opts,
		queue:  outQueue{max: outBuffer},
		notify: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
}

// Send queues an encoded message without blocking. If the queue is full it
// first discards the oldest droppable message; if there is none the client
// is too slow and is disconnected. It reports whether the message was queued.
func (c *Client) Send(data []byte) bool { return c.enqueue(data, false) }

// SendDroppable queues a message that the next one of its kind supersedes
// (a snapshot, an aim preview). A slow client loses these instead of being
// disconnected. It reports whether the message was queued.
func (c *Client) SendDroppable(data []byte) bool { return c.enqueue(data, true) }

// SendJSON encodes v and queues it with Send.
func (c *Client) SendJSON(v any) bool {
	data, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return c.Send(data)
}

func (c *Client) enqueue(data []byte, droppable bool) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	c.mu.Lock()
	res := c.queue.push(data, droppable)
	c.mu.Unlock()
	switch res {
	case overflow:
		c.Close(websocket.StatusPolicyViolation, "outbound buffer full")
		return false
	case discarded:
		return false
	}
	select {
	case c.notify <- struct{}{}:
	default:
	}
	return true
}

// Dropped returns how many droppable messages were discarded so far.
func (c *Client) Dropped() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.queue.dropped
}

// Close asks the write pump to close the connection. It never blocks and is
// safe to call more than once.
func (c *Client) Close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode, c.closeReason = code, reason
		close(c.done)
	})
}

// Run pumps messages until the connection ends: decoded inbound messages go
// to handle, on the calling goroutine. It returns once the connection is
// closed.
func (c *Client) Run(ctx context.Context, handle func(protocol.ClientMessage)) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go c.writePump(ctx)
	if c.opts.PingInterval > 0 {
		go c.pingLoop(ctx)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	for {
		typ, data, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		var msg protocol.ClientMessage
		if typ != websocket.MessageText || json.Unmarshal(data, &msg) != nil || msg.Type == "" {
			c.SendJSON(protocol.NewError(protocol.ErrBadMessage, `expected a JSON object with a "type"`))
			continue
		}
		handle(msg)
	}
}

// pingLoop sends a WebSocket ping at every interval and kills connections
// whose pong does not come back in time (a peer that vanished without a
// close frame, typically a phone that changed networks). The browser answers
// pings itself, so this needs nothing from the JavaScript client.
func (c *Client) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(c.opts.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-c.done:
			return
		case <-ctx.Done():
			return
		}
		pctx, cancel := context.WithTimeout(ctx, c.opts.PingTimeout)
		err := c.conn.Ping(pctx)
		cancel()
		if err != nil {
			c.Close(websocket.StatusGoingAway, "ping timeout")
			c.conn.CloseNow()
			return
		}
	}
}

func (c *Client) writePump(ctx context.Context) {
	for {
		select {
		case <-c.notify:
			if !c.flush(ctx) {
				c.Close(websocket.StatusAbnormalClosure, "write failed")
				c.conn.CloseNow()
				return
			}
		case <-c.done:
			// Flush what is already queued (e.g. the error explaining the
			// close), then close.
			c.flush(ctx)
			c.conn.Close(c.closeCode, c.closeReason)
			return
		}
	}
}

// flush writes everything queued. It reports false on the first failed write.
func (c *Client) flush(ctx context.Context) bool {
	for {
		c.mu.Lock()
		data, ok := c.queue.pop()
		c.mu.Unlock()
		if !ok {
			return true
		}
		if !c.write(ctx, data) {
			return false
		}
	}
}

func (c *Client) write(ctx context.Context, data []byte) bool {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data) == nil
}
