package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The profiler reads fields this app's own list leaves out, so /api/peerinfo
// hands on every field as Core wrote it - and from the same window as the
// page's list: the page and the profiler together ask Core once.
func TestPeerInfoSharesTheWindowAndKeepsCoresFields(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	calls := 0
	fail := false
	c := &rpcClient{http: &http.Client{}}
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if fail {
			w.Write([]byte(`{"result":null,"error":{"code":-28,"message":"Loading block index..."}}`))
			return
		}
		w.Write([]byte(`{"result":[{"id":7,"addr":"1.0.0.1:8333","connection_type":"manual","startingheight":871000,"pingtime":0.0123456789,"addrlocal":"203.0.113.9:8333"}],"error":null}`))
	}))
	defer core.Close()
	c.url = core.URL + "/"
	src := &source{now: func() time.Time { return now }, fetch: c.getPeerInfo}
	h := newHandler(src, offDashboard())

	ask := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}
	ask("/api/peers")
	rec := ask("/api/peerinfo")
	if calls != 1 {
		t.Fatalf("the page and the profiler in one window asked Core %d times", calls)
	}
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var got struct {
		At     int64                        `json:"at_ms"`
		Result []map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.At != now.UnixMilli() || len(got.Result) != 1 {
		t.Fatalf("at=%d peers=%d", got.At, len(got.Result))
	}
	p := got.Result[0]
	if string(p["id"]) != "7" || string(p["startingheight"]) != "871000" || string(p["pingtime"]) != "0.0123456789" {
		t.Errorf("Core's fields changed on the way: %v", p)
	}
	if _, ok := p["addrlocal"]; ok {
		t.Error("this node's own public address went out with the list")
	}

	now = now.Add(interval)
	fail = true
	if rec := ask("/api/peerinfo"); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("a failed ask must not hand on the old list as new: status %d", rec.Code)
	}
}

// The demo's peers are built in code, without Core's text; they still come out.
func TestPeerInfoFromDemoData(t *testing.T) {
	src := &source{now: time.Now, fetch: mockPeers}
	peers, _, ok := src.peerInfo(context.Background())
	if !ok || len(peers) == 0 || !strings.Contains(string(peers[0]), `"addr"`) {
		t.Fatalf("ok=%v peers=%d", ok, len(peers))
	}
	src = &source{now: time.Now, fetch: func(context.Context) ([]rawPeer, error) { return nil, errors.New("down") }}
	if _, _, ok := src.peerInfo(context.Background()); ok {
		t.Error("no answer yet must not be ok")
	}
}
