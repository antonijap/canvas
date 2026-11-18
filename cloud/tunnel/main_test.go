package main

import "testing"

// A served tunnel reaches its own hosted Cloud's port and nothing else: never the editor on 5189, never outside the range.
func TestLocalTarget(t *testing.T) {
	for _, p := range []int{5189, 0, -1, 5198, 5290, 80, 65535} {
		if _, ok := localTarget(p); ok {
			t.Errorf("port %d must be refused", p)
		}
	}
	for p, want := range map[int]string{5190: "127.0.0.1:5190", 5191: "127.0.0.1:5191", 5289: "127.0.0.1:5289"} {
		if got, ok := localTarget(p); !ok || got != want {
			t.Errorf("port %d: got %q %v, want %q", p, got, ok, want)
		}
	}
}
