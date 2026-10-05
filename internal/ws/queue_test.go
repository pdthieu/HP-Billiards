package ws

import (
	"fmt"
	"testing"
)

func drain(q *outQueue) []string {
	var out []string
	for {
		d, ok := q.pop()
		if !ok {
			return out
		}
		out = append(out, string(d))
	}
}

func TestQueueKeepsOrder(t *testing.T) {
	q := &outQueue{max: 4}
	for i := 0; i < 4; i++ {
		if r := q.push([]byte(fmt.Sprint(i)), i%2 == 0); r != pushed {
			t.Fatalf("push %d = %v", i, r)
		}
	}
	if got := drain(q); fmt.Sprint(got) != "[0 1 2 3]" {
		t.Errorf("order = %v", got)
	}
	if _, ok := q.pop(); ok {
		t.Error("pop on an empty queue reported a message")
	}
}

func TestQueueDropsOldestDroppableFirst(t *testing.T) {
	q := &outQueue{max: 3}
	q.push([]byte("keep1"), false)
	q.push([]byte("snap1"), true)
	q.push([]byte("snap2"), true)

	// Full: a new snapshot pushes out the oldest snapshot, not keep1.
	if r := q.push([]byte("snap3"), true); r != pushedAfterDrop {
		t.Fatalf("push = %v, want pushedAfterDrop", r)
	}
	// Full again: an important message also makes room by dropping a snapshot.
	if r := q.push([]byte("keep2"), false); r != pushedAfterDrop {
		t.Fatalf("push = %v, want pushedAfterDrop", r)
	}
	if got := fmt.Sprint(drain(q)); got != "[keep1 snap3 keep2]" {
		t.Errorf("queue = %v", got)
	}
	if q.dropped != 2 {
		t.Errorf("dropped = %d, want 2", q.dropped)
	}
}

func TestQueueOverflowOnlyForImportantMessages(t *testing.T) {
	q := &outQueue{max: 2}
	q.push([]byte("a"), false)
	q.push([]byte("b"), false)
	if r := q.push([]byte("snap"), true); r != discarded {
		t.Errorf("droppable into a full queue of important messages = %v, want discarded", r)
	}
	if r := q.push([]byte("c"), false); r != overflow {
		t.Errorf("important into a full queue of important messages = %v, want overflow", r)
	}
	if got := fmt.Sprint(drain(q)); got != "[a b]" {
		t.Errorf("queue = %v", got)
	}
}
