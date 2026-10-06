// WebSocket speed-test server (Go + gorilla/websocket). See ../README.md for the protocol.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var (
	startedAt   = time.Now()
	connections atomic.Int64
	msgsIn      atomic.Uint64
	msgsOut     atomic.Uint64
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
	CheckOrigin:       func(r *http.Request) bool { return true },
}

const mb = 1048576.0

// osStats returns resident memory (MB) and OS thread count via ps (or /proc on Linux).
func osStats() (rssMB any, threads any) {
	pid := strconv.Itoa(os.Getpid())
	if out, err := exec.Command("ps", "-o", "rss=", "-p", pid).Output(); err == nil {
		if kb, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64); err == nil {
			rssMB = kb / 1024
		}
	}
	if runtime.GOOS == "linux" {
		if b, err := os.ReadFile("/proc/self/status"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if v, ok := strings.CutPrefix(line, "Threads:"); ok {
					if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
						threads = n
					}
				}
			}
		}
	} else if out, err := exec.Command("ps", "-M", "-p", pid).Output(); err == nil {
		threads = len(strings.Split(strings.TrimSpace(string(out)), "\n")) - 1
	}
	return
}

func cpuMs() float64 {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	tv := func(t syscall.Timeval) float64 { return float64(t.Sec)*1000 + float64(t.Usec)/1000 }
	return tv(ru.Utime) + tv(ru.Stime)
}

func statsMessage() string {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	rss, threads := osStats()
	v := map[string]any{
		"evt": "stats", "server": "go", "pid": os.Getpid(),
		"uptimeS": time.Since(startedAt).Seconds(), "cpuCores": runtime.NumCPU(),
		"rssMB": rss, "heapMB": float64(m.HeapAlloc) / mb, "threads": threads,
		"processes":   runtime.NumGoroutine(), // goroutines
		"connections": connections.Load(), "msgsIn": msgsIn.Load(), "msgsOut": msgsOut.Load(),
		"cpuMs": cpuMs(),
		"extra": map[string]any{
			"goroutines": runtime.NumGoroutine(), "gomaxprocs": runtime.GOMAXPROCS(0),
			"heapSysMB": float64(m.HeapSys) / mb, "stackInUseMB": float64(m.StackInuse) / mb,
			"gcCount": m.NumGC, "gcPauseTotalMs": float64(m.PauseTotalNs) / 1e6,
			"gcCpuFraction": m.GCCPUFraction,
		},
	}
	b, _ := json.Marshal(v)
	return "@" + string(b)
}

func sendControl(c *websocket.Conn, v map[string]any) error {
	b, _ := json.Marshal(v)
	return c.WriteMessage(websocket.TextMessage, append([]byte{'@'}, b...))
}

type command struct {
	Cmd   string `json:"cmd"`
	Mode  string `json:"mode"`
	Count int    `json:"count"`
	Size  int    `json:"size"`
}

func generate(c *websocket.Conn, count, size int) error {
	pad := strings.Repeat("x", size)
	start := time.Now()
	buf := make([]byte, 0, size+24)
	for i := 0; i < count; i++ {
		buf = strconv.AppendInt(buf[:0], int64(i), 10)
		buf = append(buf, '|')
		buf = append(buf, pad...)
		// WriteMessage blocks when the TCP buffer is full, which gives natural backpressure.
		if err := c.WriteMessage(websocket.TextMessage, buf); err != nil {
			return err
		}
		msgsOut.Add(1)
	}
	return sendControl(c, map[string]any{
		"evt": "done", "count": count, "size": size,
		"serverMs": float64(time.Since(start).Microseconds()) / 1000,
	})
}

func handle(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	connections.Add(1)
	defer func() { connections.Add(-1); c.Close() }()

	mode := "echo"
	for {
		typ, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		if typ == websocket.TextMessage && len(data) > 0 && data[0] == '@' {
			var cmd command
			if json.Unmarshal(data[1:], &cmd) != nil {
				continue
			}
			switch cmd.Cmd {
			case "info", "mode":
				if cmd.Cmd == "mode" && (cmd.Mode == "echo" || cmd.Mode == "generate") {
					mode = cmd.Mode
				}
				err = sendControl(c, map[string]any{
					"evt": "info", "server": "go", "runtime": "Go " + runtime.Version(), "mode": mode,
				})
			case "stats":
				err = c.WriteMessage(websocket.TextMessage, []byte(statsMessage()))
			case "start":
				if mode == "generate" {
					err = generate(c, max(cmd.Count, 0), max(cmd.Size, 0))
				}
			}
			if err != nil {
				return
			}
			continue
		}
		msgsIn.Add(1)
		if mode == "echo" {
			if err := c.WriteMessage(typ, data); err != nil {
				return
			}
			msgsOut.Add(1)
		}
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8085"
	}
	http.HandleFunc("/ws", handle)
	fmt.Printf("go server listening on ws://localhost:%s/ws\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
