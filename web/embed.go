// Package web holds the static client, embedded into the server binary.
package web

import (
	"embed"
	"mime"
)

// Files is the content served at the site root: the game client
// (index.html, app.js, the stylesheets, fonts, icons, the recorded sounds
// and the web app manifest that lets a phone add it to the home screen)
// and the protocol debug page.
//
//go:embed *.html *.js *.css *.webmanifest fonts/*.woff2 icons sounds
var Files embed.FS

func init() {
	// Go's built-in table has no entry for woff2, webmanifest or wav; without them
	// they are served as application/octet-stream.
	mime.AddExtensionType(".woff2", "font/woff2")
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".wav", "audio/wav")
}
