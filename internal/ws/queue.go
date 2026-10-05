package ws

// outMsg is one queued outbound message.
type outMsg struct {
	data []byte
	// droppable messages (snapshots, aim previews) are superseded by the
	// next one of their kind, so they may be discarded when the client is
	// slow instead of disconnecting it.
	droppable bool
}

// outQueue is a bounded FIFO of outbound messages. It is not safe for
// concurrent use; Client guards it with a mutex.
type outQueue struct {
	max     int
	items   []outMsg
	dropped int // droppable messages discarded so far
}

// pushResult says what push did with a message.
type pushResult int

const (
	pushed pushResult = iota
	// pushedAfterDrop: queued after discarding the oldest droppable message.
	pushedAfterDrop
	// discarded: the message itself was droppable and nothing could make
	// room for it.
	discarded
	// overflow: the message is not droppable and the queue is full of
	// messages that must not be lost. The client is too slow.
	overflow
)

func (q *outQueue) push(data []byte, droppable bool) pushResult {
	res := pushed
	if len(q.items) >= q.max {
		idx := -1
		for i := range q.items {
			if q.items[i].droppable {
				idx = i
				break
			}
		}
		switch {
		case idx >= 0:
			q.items = append(q.items[:idx], q.items[idx+1:]...)
			q.dropped++
			res = pushedAfterDrop
		case droppable:
			q.dropped++
			return discarded
		default:
			return overflow
		}
	}
	q.items = append(q.items, outMsg{data: data, droppable: droppable})
	return res
}

// pop removes and returns the oldest message.
func (q *outQueue) pop() ([]byte, bool) {
	if len(q.items) == 0 {
		return nil, false
	}
	m := q.items[0]
	q.items[0] = outMsg{} // let the data be collected
	q.items = q.items[1:]
	return m.data, true
}

func (q *outQueue) len() int { return len(q.items) }
