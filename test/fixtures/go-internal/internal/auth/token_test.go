package auth

import "testing"

func TestIssue(t *testing.T) {
	if Issue() == "" {
		t.Fatal("empty")
	}
}
