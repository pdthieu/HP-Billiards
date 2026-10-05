package web

import (
	"io/fs"
	"testing"
)

// TestEmbeddedClient guards against the client silently vanishing from the
// binary when a file is renamed or the embed pattern changes.
func TestEmbeddedClient(t *testing.T) {
	for _, name := range []string{"index.html", "app.js", "style.css", "debug.html"} {
		data, err := fs.ReadFile(Files, name)
		if err != nil {
			t.Fatalf("%s is not embedded: %v", name, err)
		}
		if len(data) == 0 {
			t.Fatalf("%s is empty", name)
		}
	}
}
