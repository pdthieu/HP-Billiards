// Package web holds the static client, embedded into the server binary.
package web

import (
	"embed"
	"mime"
)

// Files is the content served at the site root: the game client
// (index.html, app.js, the stylesheets and fonts) and the protocol debug page.
//
//go:embed *.html *.js *.css fonts/*.woff2
var Files embed.FS

func init() {
	// Go's built-in table has no entry for woff2; without it the fonts are
	// served as application/octet-stream.
	mime.AddExtensionType(".woff2", "font/woff2")
}
