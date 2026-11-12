// The peers service: the peers of a Bitcoin Core node, where they are and
// what they run, for the peer list and the world map, split into manual,
// inbound and outbound connections.
//
// There is no background loop: Core is asked for getpeerinfo only when
// someone asks here - the page for its list, the profiler every 15 seconds
// for its records (/api/peerinfo) - and never more than once per interval
// (10s), however many ask. Every request inside that window gets the cached
// answer, so the app's two halves share one question to Core.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"peerlab/peers/asn"
	"peerlab/peers/geo"
)

// Version is set at build time with -ldflags "-X main.Version=...".
var Version = "dev"

const interval = 10 * time.Second

//go:embed web
var webFS embed.FS

type config struct {
	port    string
	mock    bool
	rpcURL  string
	rpcUser string
	rpcPass string
}

func loadConfig() (config, error) {
	c := config{port: env("PEERS_PORT", "8789"), mock: os.Getenv("PEERS_DEMO") == "1"}
	if p, err := strconv.Atoi(c.port); err != nil || p < 1 || p > 65535 {
		return c, fmt.Errorf("PEERS_PORT=%q is not a port number", c.port)
	}
	if c.mock {
		return c, nil
	}
	var missing []string
	get := func(k string) string {
		v := os.Getenv(k)
		if v == "" {
			missing = append(missing, k)
		}
		return v
	}
	host, port := get("APP_BITCOIN_NODE_IP"), get("APP_BITCOIN_RPC_PORT")
	c.rpcUser, c.rpcPass = get("APP_BITCOIN_RPC_USER"), get("APP_BITCOIN_RPC_PASS")
	if len(missing) > 0 {
		return c, fmt.Errorf("missing environment variable(s) %v (set PEERS_DEMO=1 to run with demo data)", missing)
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return c, fmt.Errorf("APP_BITCOIN_RPC_PORT=%q is not a port number", port)
	}
	c.rpcURL = "http://" + net.JoinHostPort(host, port) + "/"
	return c, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---- Bitcoin Core RPC ------------------------------------------------------

// An error with two faces: the detail for the log, and the one line the
// dashboard is allowed to see. Go's *url.Error prints the URL it failed on,
// which is Core's host and port - the node's address on the umbrel network,
// which no browser has any business learning. The dashboard is told only what
// is written here, so an error type nobody anticipated cannot leak a new
// detail by accident.
type shownError struct {
	line string // for the browser; nothing about where the node lives
	err  error  // for the log; nil when the line is the whole story
}

func (e *shownError) Error() string {
	if e.err == nil {
		return e.line
	}
	return e.err.Error()
}

func (e *shownError) Unwrap() error { return e.err }

// shownText is the line the snapshot may carry for err. An error that never
// passed through the RPC client says as little as possible.
func shownText(err error) string {
	var s *shownError
	if errors.As(err, &s) {
		return s.line
	}
	return "could not be asked for its peers"
}

type rpcClient struct {
	url, user, pass string
	http            *http.Client
}

// The dashboard prefixes these lines with "Bitcoin Core: ", so they are
// written to continue that sentence.
func (c *rpcClient) getPeerInfo(ctx context.Context) ([]rawPeer, error) {
	body := []byte(`{"jsonrpc":"1.0","id":"peers","method":"getpeerinfo","params":[]}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, &shownError{line: "could not be asked for its peers", err: err}
	}
	req.SetBasicAuth(c.user, c.pass)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &shownError{line: "unreachable from this app", err: fmt.Errorf("cannot reach Bitcoin Core: %w", err)}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, &shownError{line: "rejected the RPC credentials (401)"}
	}
	var out struct {
		Result []rawPeer `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	// 200 peers are roughly 250 KB of JSON; 32 MB is a guard, not a budget.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&out); err != nil {
		return nil, &shownError{
			line: fmt.Sprintf("sent a reply this app could not read (HTTP %d)", resp.StatusCode),
			err:  fmt.Errorf("unreadable RPC reply (HTTP %d): %w", resp.StatusCode, err),
		}
	}
	if out.Error != nil {
		// Core's own words about the request - "Loading block index...", and
		// the like. Worth showing: it says what to wait for, and unlike a
		// transport error it names nothing about where the node lives.
		return nil, &shownError{line: fmt.Sprintf("RPC error %d: %s", out.Error.Code, out.Error.Message)}
	}
	// A reply without a list is not "no peers": taking it as one replaced the
	// last good list with an empty map. An empty list decodes as [], not nil.
	if out.Result == nil {
		return nil, &shownError{line: "sent no peer list", err: fmt.Errorf("RPC reply without a result (HTTP %d)", resp.StatusCode)}
	}
	return out.Result, nil
}

// ---- cache: at most one RPC call per interval ------------------------------

type snapshot struct {
	Peers     []Peer `json:"peers"`
	FetchedAt int64  `json:"fetched_at"`
	NextIn    int    `json:"next_in"`
	Interval  int    `json:"interval"`
	Error     string `json:"error,omitempty"`
	Demo      bool   `json:"demo,omitempty"`
	// The newest block the dashboard has seen: who mined it, and which peer
	// here delivered it. Absent while it has not seen one or is not up.
	LastBlock *lastBlock `json:"last_block,omitempty"`
	// Where this node is (a region), so the map can draw the lines to it.
	Home    *Home  `json:"home,omitempty"`
	Version string `json:"version"`
}

type source struct {
	mu      sync.Mutex
	fetch   func(context.Context) ([]rawPeer, error)
	now     func() time.Time
	last    time.Time // when the last answer came in; the window runs from there
	lastErr string    // the last failure logged, so a node that stays down logs once
	snap    snapshot
	raw     []rawPeer // Core's last good answer, as it came; nil while the last ask failed
	rawAt   time.Time
}

// peerInfo is Core's answer from the cached window, each peer as Core wrote
// it, and when Core gave it. ok is false while the last ask failed: the
// profiler then asks Core itself rather than record an old list as new.
func (s *source) peerInfo(ctx context.Context) (peers []json.RawMessage, at time.Time, ok bool) {
	s.get(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.raw == nil {
		return nil, time.Time{}, false
	}
	peers = make([]json.RawMessage, 0, len(s.raw))
	for _, p := range s.raw {
		full := p.full
		if full == nil { // demo data, built in code
			b, err := json.Marshal(p)
			if err != nil {
				return nil, time.Time{}, false
			}
			full = b
		}
		// Every field as Core wrote it but one: addrlocal is the address the
		// peer sees this node under - its public IP - and the profiler has no
		// use for it.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(full, &fields); err != nil {
			return nil, time.Time{}, false
		}
		delete(fields, "addrlocal")
		b, err := json.Marshal(fields)
		if err != nil {
			return nil, time.Time{}, false
		}
		peers = append(peers, b)
	}
	return peers, s.rawAt, true
}

func (s *source) get(ctx context.Context) snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.last.IsZero() || now.Sub(s.last) >= interval {
		// The call belongs to this app, not to the browser request that
		// triggered it: a dashboard that navigates away mid-poll used to
		// cancel the RPC, and the cancellation was then cached as Core's
		// answer - every other open dashboard read an error its node never
		// produced. The lock is still held across the call, so the pollers
		// waiting behind it get this one answer instead of asking again.
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
		raw, err := s.fetch(cctx)
		cancel()
		now = s.now() // the call can take seconds; the window runs from its end
		// No case for context.Canceled: the call runs on a context detached
		// from the browser's, so only the 20s deadline can end it early, and
		// a node that does not answer within that has answered all the same.
		switch {
		case err != nil:
			// A node that is down has answered all the same. The window holds,
			// so it is asked once per interval and not once per poll.
			s.last = now
			if s.lastErr != err.Error() {
				log.Printf("getpeerinfo failed: %v", err)
				s.lastErr = err.Error()
			}
			s.snap.Error = shownText(err) // keep the last good peer list on screen
			s.raw = nil
		default:
			s.last = now
			s.lastErr = ""
			s.raw, s.rawAt = raw, now
			if s.raw == nil {
				s.raw = []rawPeer{}
			}
			s.snap.Peers = convertAt(raw, now)
			s.snap.Home = homeOf(raw)
			s.snap.FetchedAt = now.Unix()
			s.snap.Error = ""
		}
	}
	out := s.snap
	out.Interval = int(interval / time.Second)
	out.NextIn = int((interval - now.Sub(s.last) + time.Second - 1) / time.Second)
	if out.NextIn < 1 {
		out.NextIn = 1
	}
	if out.Peers == nil {
		out.Peers = []Peer{}
	}
	return out
}

// ---- HTTP -------------------------------------------------------------------

func newHandler(src *source, dash *dashboardClient) http.Handler {
	static, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(static))
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok\n")
	})
	// One answer in the making at a time, whoever asks: the locks below are
	// held across Core's and the dashboard's answers, up to 24 seconds, and a
	// browser that gives up meanwhile must not leave a worker of its own
	// behind. Requests that come while one is under way wait for that one.
	fetch := &sharedFetch{}
	mux.HandleFunc("GET /api/peers", func(w http.ResponseWriter, r *http.Request) {
		// ?block=<hash>: the page has just heard of this block (dashboard.go,
		// latest). Only a hash is taken, nothing else.
		want := r.URL.Query().Get("block")
		if !isBlockHash(want) {
			want = ""
		}
		call := fetch.join(func() snapshot {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			snap := src.get(ctx)
			snap.LastBlock = dash.latest(ctx, want)
			return snap
		})
		var snap snapshot
		select {
		case <-call.done:
			snap = call.snap
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(snap)
	})
	// The dashboard's question, container to container: what kind of
	// software each peer runs, for the ranking. Three fields a peer, not the
	// whole list with places and the block card - which would have the block
	// card ask the dashboard in turn.
	mux.HandleFunc("GET /api/kinds", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		type kind struct {
			Addr        string `json:"addr"`
			Kind        string `json:"kind"`
			NoRelay     bool   `json:"no_relay,omitempty"`
			LinkingLion bool   `json:"linking_lion,omitempty"`
			Fork        string `json:"fork,omitempty"`
		}
		snap := src.get(ctx)
		out := struct {
			Peers []kind `json:"peers"`
		}{Peers: make([]kind, 0, len(snap.Peers))}
		for _, p := range snap.Peers {
			out.Peers = append(out.Peers, kind{p.Addr, p.Kind, p.NoRelay, p.LinkingLion, p.Fork})
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(out)
	})
	// The profiler's question, container to container: Core's getpeerinfo,
	// every field as Core wrote it, out of the same window the page's list
	// comes from - so the profiler's 15-second poll and an open page ask Core
	// once between them, not each on its own clock. 503 while the last ask
	// failed; the profiler then asks Core itself. The dashboard does not pass
	// this one on to the browser (peers-proxy.js).
	mux.HandleFunc("GET /api/peerinfo", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		peers, at, ok := src.peerInfo(ctx)
		if !ok {
			http.Error(w, "no fresh answer from Bitcoin Core", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(struct {
			At     int64             `json:"at_ms"`
			Result []json.RawMessage `json:"result"`
		}{at.UnixMilli(), peers})
	})
	// The two files the page loads from here, and nothing else: no index, no
	// directory listing. no-cache for both, world.json included: it changes
	// between releases, and a day-long cache kept showing the old map after
	// an update.
	for _, name := range []string{"/app.js", "/world.json"} {
		mux.HandleFunc("GET "+name, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
		})
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		// base-uri and form-action have no fallback: default-src does not cover
		// them, so without these two an injected <base> could re-point every
		// relative URL on the page, and an injected form could post off-site.
		// The page has no <base>, and its two forms send by fetch, so both are
		// 'none'. The dashboard sends the same policy with the page itself.
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
		gzipped(mux).ServeHTTP(w, r)
	})
}

// gzipped packs text answers for a browser that takes gzip. The peer list is
// about 270 kB of JSON and comes again every poll; packed it is a fifth of
// that, which counts on a phone away from home. A range request is left
// alone: its offsets would point into the packed bytes.
func gzipped(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept-Encoding")
		if r.Method != http.MethodGet || r.Header.Get("Range") != "" || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		g := &gzipWriter{ResponseWriter: w}
		next.ServeHTTP(g, r)
		if g.gz != nil {
			g.gz.Close()
		}
	})
}

// gzipWriter decides on the status and type the handler set: only a 200 with
// text in it is packed, so a 304 stays empty and a PNG is not packed twice.
type gzipWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer
	started bool
}

func (g *gzipWriter) WriteHeader(code int) {
	if g.started {
		return
	}
	g.started = true
	h := g.Header()
	if code == http.StatusOK && h.Get("Content-Encoding") == "" && packable(h.Get("Content-Type")) {
		h.Del("Content-Length")
		h.Set("Content-Encoding", "gzip")
		g.gz = gzip.NewWriter(g.ResponseWriter)
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.started {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func packable(contentType string) bool {
	for _, t := range []string{"text/", "application/json", "application/javascript", "text/javascript", "image/svg+xml"} {
		if strings.HasPrefix(contentType, t) {
			return true
		}
	}
	return false
}

func healthcheck() int {
	c := http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + env("PEERS_PORT", "8789") + "/api/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck())
		case "version", "-version", "--version":
			fmt.Println(Version)
			return
		default:
			fmt.Fprintf(os.Stderr, "usage: %s [healthcheck|version]\n", os.Args[0])
			os.Exit(2)
		}
	}
	log.SetFlags(0)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("peers: %v", err)
	}

	src := &source{now: time.Now}
	if cfg.mock {
		src.fetch = mockPeers
		src.snap.Demo = true
	} else {
		rpc := &rpcClient{url: cfg.rpcURL, user: cfg.rpcUser, pass: cfg.rpcPass, http: &http.Client{}}
		src.fetch = rpc.getPeerInfo
	}
	src.snap.Version = Version

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           newHandler(src, newDashboardClient()),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	regions, v4, v6 := geo.Sizes()
	networks, a4, a6 := asn.Size()
	mode := "rpc " + cfg.rpcURL
	if cfg.mock {
		mode = "DEMO DATA (PEERS_DEMO=1)"
	}
	log.Printf("peers %s listening on :%s, %s, geo table %d regions, %d/%d ranges (v4/v6), network table %d operators, %d/%d ranges (v4/v6), Core asked at most every %s, one answer for the page and the profiler",
		Version, cfg.port, mode, regions, v4, v6, networks, a4, a6, interval)

	ln, err := listenConfig().Listen(context.Background(), "tcp", srv.Addr)
	if err != nil {
		log.Fatalf("peers: %v", err)
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("peers: %v", err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

// listenConfig is how the dashboard's port is opened. Go listeners accept
// Multipath TCP by default on Linux (since Go 1.24); the dashboard only ever
// gets plain connections from Umbrel's app proxy, so it is switched off and
// the kernel's MPTCP code is never reached through this app.
func listenConfig() *net.ListenConfig {
	lc := &net.ListenConfig{}
	lc.SetMultipathTCP(false)
	return lc
}

// sharedFetch runs at most one fetch at a time and hands its result to every
// request that joined while it ran. A request that gives up only stops
// waiting; the fetch finishes for the others, and nothing else is left behind.
type sharedFetch struct {
	mu  sync.Mutex
	cur *fetchCall
}

type fetchCall struct {
	done chan struct{}
	snap snapshot
}

func (f *sharedFetch) join(fn func() snapshot) *fetchCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cur != nil {
		return f.cur
	}
	c := &fetchCall{done: make(chan struct{})}
	f.cur = c
	go func() {
		c.snap = fn()
		f.mu.Lock()
		f.cur = nil
		f.mu.Unlock()
		close(c.done)
	}()
	return c
}

// isBlockHash is 64 hex digits, and nothing else.
func isBlockHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// acceptsGzip reads Accept-Encoding as a list: "gzip" or "*" counts, unless
// its weight is zero ("gzip;q=0" means: never gzip).
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "gzip" && name != "*" {
			continue
		}
		q := strings.ReplaceAll(strings.ToLower(params), " ", "")
		if q == "q=0" || strings.HasPrefix(q, "q=0.0") && strings.Trim(strings.TrimPrefix(q, "q="), "0.") == "" {
			return false
		}
		return true
	}
	return false
}
