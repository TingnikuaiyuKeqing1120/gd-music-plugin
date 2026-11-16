package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
)

type job struct {
	Query string `json:"query"`
	Sign  string `json:"sign"`
}

type request struct {
	ID    int64  `json:"id"`
	Op    string `json:"op,omitempty"`
	Query string `json:"query,omitempty"`
	Sign  string `json:"sign,omitempty"`
	URL   string `json:"url,omitempty"`
	Name  string `json:"name,omitempty"`
	Dir   string `json:"dir,omitempty"`
	Batch []job  `json:"batch,omitempty"`
}

type response struct {
	ID      int64        `json:"id"`
	Status  int          `json:"status,omitempty"`
	Body    string       `json:"body,omitempty"`
	Error   string       `json:"error,omitempty"`
	Results []pageResult `json:"results,omitempty"`
}

type pageResult struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

func findBrowser() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("LocalAppData"), "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// safeName reports whether name is a plain file name to keep within the
// offline folder: no path of its own, which would reach out of it.
func safeName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name
}

// downloadTo fetches url into dir/name, going through name.part so a half
// come-in song is never taken for a whole one. A song already there is left
// as it is (查重). It answers how many bytes it holds.
func downloadTo(dir, name, url string) (int64, error) {
	if !safeName(name) {
		return 0, fmt.Errorf("bad file name")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, err
	}
	path := filepath.Join(dir, name)
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return info.Size(), nil
	}
	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	part := path + ".part"
	f, err := os.Create(part)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(part)
		return 0, err
	}
	if err := os.Rename(part, path); err != nil {
		os.Remove(part)
		return 0, err
	}
	return n, nil
}

func main() {
	browser := findBrowser()
	if browser == "" {
		os.Stderr.WriteString("no Chrome or Edge found\n")
		os.Exit(1)
	}
	dataDir, err := os.MkdirTemp("", "gd-helper-")
	if err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
	defer os.RemoveAll(dataDir)

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(browser),
		chromedp.Flag("headless", "new"),
		chromedp.UserDataDir(dataDir),
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("no-default-browser-check", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("mute-audio", true),
		chromedp.WindowSize(1280, 800),
	)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelAlloc()
	ctx, cancelCtx := chromedp.NewContext(allocCtx)
	defer cancelCtx()

	var outMu sync.Mutex
	enc := json.NewEncoder(os.Stdout)
	send := func(r response) {
		outMu.Lock()
		defer outMu.Unlock()
		enc.Encode(r)
	}

	// 端口先于浏览器初始化公布：插件能立刻拿到封面/离线供流 URL。
	// 浏览器初始化失败（如断网）不退出进程——离线供流仍要能用，
	// 只是搜索/封面这类要站点页面的请求会报错。
	initDone := make(chan struct{})
	var initErr error
	waitInit := func(c context.Context) error {
		select {
		case <-initDone:
		case <-c.Done():
			return c.Err()
		}
		return initErr
	}

	// 离线库目录由插件 config 告知（插件自己的 dataDir/offline）。
	var offMu sync.Mutex
	offlineDir := ""

	// 封面懒解析服务：搜索先把列表返回，封面 URL 指向这里；App 并发来抓时
	// 才去 GD 解析（站点串行、每个约 400ms），解析出 CDN 地址就 302 跳转。
	var coverMu sync.Mutex
	covers := map[string]string{}
	resolvePic := func(c context.Context, source, id string) (string, error) {
		key := source + ":" + id
		coverMu.Lock()
		if u, ok := covers[key]; ok {
			coverMu.Unlock()
			return u, nil
		}
		coverMu.Unlock()
		if err := waitInit(c); err != nil {
			return "", err
		}
		expr := fmt.Sprintf(`(async () => {
			const enc = s => encodeURIComponent(s).replace(/\(/g,'%%28').replace(/\)/g,'%%29').replace(/\*/g,'%%2A').replace(/'/g,'%%27').replace(/!/g,'%%21');
			const id = %s, source = %s;
			const q = 'types=pic&id=' + enc(id) + '&source=' + source + '&size=600';
			const r = await fetch('api.php?' + q + '&s=' + crc32(enc(id)));
			return {status: r.status, body: await r.text()};
		})()`, jsString(id), jsString(source))
		res, err := chromedp.Run(c, chromedp.Evaluate[pageResult](expr, chromedp.EvalAwaitPromise))
		if err != nil {
			return "", err
		}
		if res.Status != 200 {
			return "", fmt.Errorf("pic status %d", res.Status)
		}
		var pic struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal([]byte(res.Body), &pic); err != nil {
			return "", err
		}
		if pic.URL == "" {
			return "", fmt.Errorf("no cover url")
		}
		coverMu.Lock()
		covers[key] = pic.URL
		coverMu.Unlock()
		return pic.URL, nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/cover", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		source := r.URL.Query().Get("source")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		c, cancel := context.WithTimeout(ctx, 25*time.Second)
		defer cancel()
		url, err := resolvePic(c, source, id)
		if err != nil || url == "" {
			http.Error(w, "no cover", http.StatusNotFound)
			return
		}
		http.Redirect(w, r, url, http.StatusFound)
	})
	// 离线供流：把已下载的歌从本机喂给 App，断网也能播。支持 Range 拖动。
	mux.HandleFunc("/audio", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("f")
		if !safeName(name) {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		offMu.Lock()
		dir := offlineDir
		offMu.Unlock()
		if dir == "" {
			http.Error(w, "offline not ready", http.StatusServiceUnavailable)
			return
		}
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err != nil {
			http.Error(w, "not cached", http.StatusNotFound)
			return
		}
		http.ServeFile(w, r, path)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Stderr.WriteString("listen: " + err.Error() + "\n")
		os.Exit(1)
	}
	go http.Serve(ln, mux)
	outMu.Lock()
	enc.Encode(map[string]any{"port": ln.Addr().(*net.TCPAddr).Port})
	outMu.Unlock()

	go func() {
		if err := chromedp.Do(ctx,
			chromedp.Navigate("https://music.gdstudio.xyz/"),
			chromedp.Poll[chromedp.Void](`typeof window.crc32 === "function" && typeof window.mkPlayer === "object" && mkPlayer !== null`, chromedp.WithPollingTimeout(30*time.Second)),
		); err != nil {
			initErr = err
			os.Stderr.WriteString("page init: " + err.Error() + "\n")
		}
		close(initDone)
	}()

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			continue
		}
		go func(req request) {
			switch req.Op {
			case "config":
				offMu.Lock()
				offlineDir = req.Dir
				offMu.Unlock()
				send(response{ID: req.ID, Status: 200})
				return
			case "dl":
				offMu.Lock()
				dir := offlineDir
				offMu.Unlock()
				if dir == "" {
					send(response{ID: req.ID, Error: "offline dir not set"})
					return
				}
				n, err := downloadTo(dir, req.Name, req.URL)
				if err != nil {
					send(response{ID: req.ID, Error: err.Error()})
					return
				}
				body, _ := json.Marshal(map[string]any{"size": n, "file": req.Name})
				send(response{ID: req.ID, Status: 200, Body: string(body)})
				return
			}
			callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := waitInit(callCtx); err != nil {
				send(response{ID: req.ID, Error: "站点未就绪: " + err.Error()})
				return
			}
			if len(req.Batch) > 0 {
				jobsJSON, _ := json.Marshal(req.Batch)
				expr := fmt.Sprintf(`(async () => { const jobs = %s; return await Promise.all(jobs.map(async j => { try { const r = await fetch('api.php?' + j.query + '&s=' + crc32(j.sign)); return {status: r.status, body: await r.text()}; } catch (e) { return {status: 0, body: String(e)}; } })); })()`, jobsJSON)
				res, err := chromedp.Run(callCtx, chromedp.Evaluate[[]pageResult](expr, chromedp.EvalAwaitPromise))
				if err != nil {
					send(response{ID: req.ID, Error: err.Error()})
					return
				}
				send(response{ID: req.ID, Results: res})
				return
			}
			var expr string
			if req.URL != "" {
				expr = fmt.Sprintf(`(async () => { const r = await fetch(%s); return {status: r.status, body: await r.text()}; })()`, jsString(req.URL))
			} else {
				expr = fmt.Sprintf(`(async () => { const r = await fetch('api.php?' + %s + '&s=' + crc32(%s)); return {status: r.status, body: await r.text()}; })()`, jsString(req.Query), jsString(req.Sign))
			}
			res, err := chromedp.Run(callCtx, chromedp.Evaluate[pageResult](expr, chromedp.EvalAwaitPromise))
			if err != nil {
				send(response{ID: req.ID, Error: err.Error()})
				return
			}
			send(response{ID: req.ID, Status: res.Status, Body: res.Body})
		}(req)
	}
}