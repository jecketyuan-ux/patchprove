.PHONY: build test go-build go-test pack

build:
	npm run build

test:
	npm test

go-build: build
	mkdir -p bin
	go build -o bin/patchprove ./go

# Thin launcher smoke: requires dist/cli.js from `npm run build`.
go-test: go-build
	./bin/patchprove --version
	./bin/patchprove run --help

pack:
	npm pack --dry-run
