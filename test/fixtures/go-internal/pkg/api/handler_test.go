package api

import (
	"testing"

	"example.com/shop/internal/auth"
)

func TestHandle(t *testing.T) {
	if Handle() != auth.Issue() {
		t.Fatal("mismatch")
	}
}
