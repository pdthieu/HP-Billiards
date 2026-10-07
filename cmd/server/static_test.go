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
	if res := get("/missing.js", "gzip"); res.StatusCode != http.StatusNotFound {
		t.Errorf("missing file: %d", res.StatusCode)
	}
}
