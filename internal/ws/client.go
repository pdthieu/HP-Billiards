// Package ws wraps a WebSocket connection with a read pump, a write pump and
// a bounded outbound buffer.
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

// Client is one WebSocket connection. Send may be called from any goroutine.
type Client struct {
	conn *websocket.Conn
	out  chan []byte

	closeOnce   sync.Once
	done        chan struct{}
	closeCode   websocket.StatusCode
	closeReason string
}

// NewClient wraps an accepted connection. Call Run to start pumping.
func NewClient(conn *websocket.Conn) *Client {
	conn.SetReadLimit(readLimit)
	return &Client{
		conn: conn,
		out:  make(chan []byte, outBuffer),
		done: make(chan struct{}),
	}
}

// Send queues an encoded message without blocking. If the buffer is full the
// client is too slow and is disconnected. It reports whether the message was
// queued.
func (c *Client) Send(data []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.out <- data:
		return true
	default:
		c.Close(websocket.StatusPolicyViolation, "outbound buffer full")
		return false
	}
}

// SendJSON encodes v and queues it.
func (c *Client) SendJSON(v any) bool {
	data, err := json.Marshal(v)
	if err != nil {
		return false
	}
	return c.Send(data)
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

func (c *Client) writePump(ctx context.Context) {
	for {
		select {
		case data := <-c.out:
			if !c.write(ctx, data) {
				c.Close(websocket.StatusAbnormalClosure, "write failed")
				c.conn.CloseNow()
				return
			}
		case <-c.done:
			// Flush what is already queued (e.g. the error explaining the
			// close), then close.
			for {
				select {
				case data := <-c.out:
					if c.write(ctx, data) {
						continue
					}
				default:
				}
				break
			}
			c.conn.Close(c.closeCode, c.closeReason)
			return
		}
	}
}

func (c *Client) write(ctx context.Context, data []byte) bool {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data) == nil
}
