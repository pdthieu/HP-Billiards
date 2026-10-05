// Package web holds the static client, embedded into the server binary.
package web

import "embed"

// Files is the content served at the site root.
//
//go:embed *.html
var Files embed.FS
