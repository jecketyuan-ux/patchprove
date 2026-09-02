package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	node, err := exec.LookPath("node")
	if err != nil {
		fmt.Fprintf(os.Stderr, "patchprove: node not found on PATH (Node 20+ is required)\n")
		os.Exit(2)
	}
	cli, err := findCLI()
	if err != nil {
		fmt.Fprintf(os.Stderr, "patchprove: %v\n", err)
		os.Exit(2)
	}
	cmd := exec.Command(node, append([]string{cli}, os.Args[1:]...)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "patchprove: %v\n", err)
		os.Exit(2)
	}
}

func findCLI() (string, error) {
	if env := strings.TrimSpace(os.Getenv("PATCHPROVE_CLI")); env != "" {
		if _, err := os.Stat(env); err == nil {
			return env, nil
		}
		return "", fmt.Errorf("PATCHPROVE_CLI does not exist: %s", env)
	}

	exe, err := os.Executable()
	if err == nil {
		exeDir := filepath.Dir(exe)
		for _, candidate := range []string{
			filepath.Join(exeDir, "cli.js"),
			filepath.Join(exeDir, "dist", "cli.js"),
			filepath.Join(exeDir, "..", "dist", "cli.js"),
		} {
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
				return candidate, nil
			}
		}
	}

	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	dir := cwd
	for i := 0; i < 8; i++ {
		if cli := cliFromPackage(dir); cli != "" {
			return cli, nil
		}
		nested := filepath.Join(dir, "node_modules", "patchprove", "dist", "cli.js")
		if st, err := os.Stat(nested); err == nil && !st.IsDir() {
			return nested, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("could not find patchprove CLI (build with `npm run build`, or set PATCHPROVE_CLI)")
}

func cliFromPackage(dir string) string {
	pkgPath := filepath.Join(dir, "package.json")
	raw, err := os.ReadFile(pkgPath)
	if err != nil {
		return ""
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &pkg) != nil || pkg.Name != "patchprove" {
		return ""
	}
	cli := filepath.Join(dir, "dist", "cli.js")
	if st, err := os.Stat(cli); err == nil && !st.IsDir() {
		return cli
	}
	return ""
}
