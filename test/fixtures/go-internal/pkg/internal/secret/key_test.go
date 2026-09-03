package secret

import "testing"

func TestKey(t *testing.T) {
	if Key() == "" {
		t.Fatal("empty")
	}
}
