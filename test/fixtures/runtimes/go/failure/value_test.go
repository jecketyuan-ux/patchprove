package fixture

import "testing"

func TestValue(t *testing.T) { if Value() != 3 { t.Fatal("unexpected value") } }
