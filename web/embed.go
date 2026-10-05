// Package web holds the static client, embedded into the server binary.
package web

import "embed"

// Files is the content served at the site root: the game client
// (index.html, app.js, style.css) and the protocol debug page.
//
//go:embed *.html *.js *.css
var Files embed.FS
