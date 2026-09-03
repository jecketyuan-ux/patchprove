package api

import "example.com/shop/internal/auth"

func Handle() string { return auth.Issue() }
