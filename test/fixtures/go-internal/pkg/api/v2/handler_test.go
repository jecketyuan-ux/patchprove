package v2

import "testing"

func TestHandleV2(t *testing.T) {
	if HandleV2() == "" {
		t.Fatal("empty")
	}
}
