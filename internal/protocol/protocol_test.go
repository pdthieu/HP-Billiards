package protocol

import (
	"math"
	"reflect"
	"testing"
)

func TestCleanLook(t *testing.T) {
	for _, c := range []struct {
		name string
		in   *Look
		want *Look
	}{
		{"none", nil, nil},
		{"no body", &Look{Skin: "#aabbcc"}, nil},
		{"unknown body", &Look{Body: "robot"}, nil},
		{"plain", &Look{Body: "woman"}, &Look{Body: "woman"}},
		{"colours kept and lowered", &Look{Body: "man", Skin: "#EFC7A8", HairColor: "#573823", Eyes: "#4f6f86"},
			&Look{Body: "man", Skin: "#efc7a8", HairColor: "#573823", Eyes: "#4f6f86"}},
		{"bad colours dropped", &Look{Body: "man", Skin: "red", HairColor: "#12345", Eyes: "#12345g"}, &Look{Body: "man"}},
		{"hairstyles", &Look{Body: "woman", Hair: "bun"}, &Look{Body: "woman", Hair: "bun"}},
		{"unknown hairstyle dropped", &Look{Body: "woman", Hair: "mohawk"}, &Look{Body: "woman"}},
		{"measures brought into range", &Look{Body: "man", Face: &Face{W: 9, Jaw: 0.1, Lips: 0.7, Beard: 3}},
			&Look{Body: "man", Face: &Face{W: 1.15, Jaw: 0.4, Lips: 0.7, Beard: 1}}},
		{"no number, no face", &Look{Body: "man", Face: &Face{W: math.NaN(), Nose: math.Inf(1)}}, &Look{Body: "man"}},
	} {
		if got := CleanLook(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: CleanLook(%+v) = %+v, want %+v", c.name, c.in, got, c.want)
		}
	}
}
