package fixture

import "testing"

func TestValue(t *testing.T) { if Value() != 2 { t.Fatal("unexpected value") } }
