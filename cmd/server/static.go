package main

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// compressible lists the text files worth gzipping; the sounds, icons and
// fonts are compressed already.
var compressible = map[string]bool{
	".js": true, ".css": true, ".html": true, ".svg": true, ".webmanifest": true, ".json": true,
}

// gzipStatic serves text files from fsys gzipped to browsers that accept
// it, compressing each file once. Everything else, and range requests, go to
// next. The 3D library shrinks from about 740 KB to 190 KB.
func gzipStatic(fsys fs.FS, next http.Handler) http.Handler {
	var cache sync.Map // name → []byte
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if strings.HasSuffix(r.URL.Path, "/") {
			name = path.Join(name, "index.html")
		}
		ext := path.Ext(name)
		if !compressible[ext] || r.Header.Get("Range") != "" || strings.HasSuffix(r.URL.Path, "/index.html") ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gz, ok := cache.Load(name)
		if !ok {
			data, err := fs.ReadFile(fsys, name)
			if err != nil {
				next.ServeHTTP(w, r) // a directory or a missing file: the file server answers
				return
			}
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			zw.Write(data)
			zw.Close()
			gz, _ = cache.LoadOrStore(name, buf.Bytes())
		}
		body := gz.([]byte)
		h := w.Header()
		h.Set("Content-Type", mime.TypeByExtension(ext))
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		h.Set("Content-Length", strconv.Itoa(len(body)))
		if r.Method == http.MethodHead {
			return
		}
		w.Write(body)
	})
}
