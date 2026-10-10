package web

import (
	"io/fs"
	"testing"
)

// TestEmbeddedClient guards against the client silently vanishing from the
// binary when a file is renamed or the embed pattern changes.
func TestEmbeddedClient(t *testing.T) {
	for _, name := range []string{
		"index.html", "app.js", "style.css", "tokens.css", "components.css", "fonts.css",
		"fonts/SourceSans3-400-latin.woff2", "fonts/BarlowSemiCondensed-600-latin.woff2",
		"debug.html", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
		"icons/apple-touch-icon.png", "sounds/clack-1.wav", "sounds/cue-1.wav", "sounds/pocket-1.wav",
		"view3d.js", "arena3d.js", "vendor/three-r186/three.min.js", "vendor/three-r186/LICENSE",
		"voice/lines.json", "voice/great-01.m4a",
	} {
		data, err := fs.ReadFile(Files, name)
		if err != nil {
			t.Fatalf("%s is not embedded: %v", name, err)
		}
		if len(data) == 0 {
			t.Fatalf("%s is empty", name)
		}
	}
}
