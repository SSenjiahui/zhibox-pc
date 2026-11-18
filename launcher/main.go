package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func logf(f *os.File, s string) {
	if f != nil {
		fmt.Fprintln(f, s)
	}
}

// writable 真实探测目录是否可写（建目录 + 写文件 + 删文件）
func writable(dir string) bool {
	if dir == "" {
		return false
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return false
	}
	p := filepath.Join(dir, fmt.Sprintf(".w_%d_probe", os.Getpid()))
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return false
	}
	f.WriteString("x")
	f.Close()
	os.Remove(p)
	return true
}

// pickDataDir 依次尝试候选目录，返回第一个真正可写的。
// 因为受限令牌 / 便携版解压目录下，某些路径可能整盘不可写。
func pickDataDir(lf *os.File, exeDir string) string {
	var cands []string
	add := func(d string) {
		if d == "" {
			return
		}
		for _, x := range cands {
			if x == d {
				return
			}
		}
		cands = append(cands, d)
	}

	if v := os.Getenv("ZB_DATA_DIR"); v != "" {
		add(v)
	}
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		add(filepath.Join(v, "ZhiboX"))
	}
	if v := os.Getenv("APPDATA"); v != "" {
		add(filepath.Join(v, "ZhiboX"))
	}
	add(filepath.Join(exeDir, "data"))
	if wd, err := os.Getwd(); err == nil {
		add(filepath.Join(wd, "ZhiboXData"))
	}
	if v := os.Getenv("TEMP"); v != "" {
		add(filepath.Join(v, "ZhiboX"))
	}
	// 其它盘符兜底（C 盘全不可写时才用）
	for _, L := range "DEFGHIJKLMNOPQRSTUVWXYZ" {
		root := string(L) + ":\\"
		if _, err := os.Stat(root); err == nil {
			add(filepath.Join(root, "ZhiboXData"))
		}
	}

	for _, c := range cands {
		if writable(c) {
			logf(lf, "dataDir picked "+c)
			return c
		}
		logf(lf, "dataDir skip(unwritable) "+c)
	}
	logf(lf, "dataDir NONE writable")
	return ""
}

func main() {
	var lf *os.File
	if p := os.Getenv("ZB_LAUNCHLOG"); p != "" {
		lf, _ = os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	}
	logf(lf, "launcher start")

	self, err := os.Executable()
	if err != nil {
		logf(lf, "os.Executable err: "+err.Error())
		os.Exit(1)
	}
	dir := filepath.Dir(self)
	core := filepath.Join(dir, "zhibo-core.exe")
	if _, e := os.Stat(core); e != nil {
		logf(lf, "core not found: "+core)
		os.Exit(1)
	}
	logf(lf, "core="+core)

	dataDir := pickDataDir(lf, dir)

	args := []string{
		"--no-sandbox",
		"--disable-gpu-sandbox",
	}
	if dataDir != "" {
		args = append(args, "--user-data-dir="+dataDir)
	}
	args = append(args, os.Args[1:]...)
	logf(lf, "args="+strings.Join(args, " "))

	cmd := exec.Command(core, args...)
	cmd.Dir = dir
	if dataDir != "" {
		cmd.Env = append(os.Environ(), "ZB_DATA_DIR="+dataDir)
	}

	// 便携版/安装版 stub 会跟随入口进程生命周期：
	// 入口一退出就清理解压目录或判定完成，因此必须住留到 core 结束。
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		logf(lf, "start err: "+err.Error())
		os.Exit(1)
	}
	logf(lf, fmt.Sprintf("started pid=%d, waiting...", cmd.Process.Pid))

	err = cmd.Wait()
	if err != nil {
		logf(lf, "core exited: "+err.Error())
	} else {
		logf(lf, "core exited: 0")
	}
}
