package main

// Not visible: last internal parent is pkg/, this file lives under cmd/.
import "example.com/shop/pkg/internal/secret"

func main() { _ = secret.Key }
