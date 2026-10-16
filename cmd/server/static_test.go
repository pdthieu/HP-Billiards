package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestGzipStatic(t *testing.T) {
	fsys := fstest.MapFS{
		"app.js":     {Data: []byte("console.log('hello, hello, hello, hello')")},
		"index.html": {Data: []byte("<!doctype html><title>pool</title>")},
		"a.wav":      {Data: []byte("RIFF....WAVE")},
		"m.mjs":      {Data: []byte("export const hello = 'hello, hello, hello'")},
		"m.wasm":     {Data: []byte("\x00asm\x01\x00\x00\x00")},
	}
	h := gzipStatic(fsys, http.FileServerFS(fsys))
	get := func(path, enc string) *http.Response {
		req := httptest.NewRequest("GET", path, nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Result()
	}
	body := func(res *http.Response) string {
		var r io.Reader = res.Body
		if res.Header.Get("Content-Encoding") == "gzip" {
			zr, err := gzip.NewReader(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			r = zr
		}
		b, _ := io.ReadAll(r)
		return string(b)
	}

	for _, tc := range []struct {
		path, enc, want string
		gzipped         bool
	}{
		{"/app.js", "gzip, deflate, br", "console.log('hello, hello, hello, hello')", true},
		{"/app.js", "", "console.log('hello, hello, hello, hello')", false},
		{"/", "gzip", "<!doctype html><title>pool</title>", true},
		{"/a.wav", "gzip", "RIFF....WAVE", false},
		{"/m.mjs", "gzip", "export const hello = 'hello, hello, hello'", true},
		{"/m.wasm", "gzip", "\x00asm\x01\x00\x00\x00", true},
	} {
		res := get(tc.path, tc.enc)
		if got := res.Header.Get("Content-Encoding") == "gzip"; got != tc.gzipped {
			t.Errorf("%s (%q): gzipped %v, want %v", tc.path, tc.enc, got, tc.gzipped)
		}
		if got := body(res); got != tc.want {
			t.Errorf("%s (%q): body %q", tc.path, tc.enc, got)
		}
		if tc.gzipped && res.Header.Get("Content-Type") == "" {
			t.Errorf("%s: no content type", tc.path)
		}
	}
	// wasm keeps its type, or the browser can't compile it as it arrives
	if got := get("/m.wasm", "gzip").Header.Get("Content-Type"); got != "application/wasm" {
		t.Errorf("wasm: content type %q", got)
	}
	if res := get("/missing.js", "gzip"); res.StatusCode != http.StatusNotFound {
		t.Errorf("missing file: %d", res.StatusCode)
	}
}
