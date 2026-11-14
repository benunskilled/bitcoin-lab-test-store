package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Branches no test reached (night check, 13.11.2026).

// A sentence that gives its reasons from what is known of the peer
// ("Claims: ... Probably: LinkingLion ...", one of LinkingLion's ranges here)
// replaces the one the session line was written under: that line goes too.
func TestClaimsTakeTheSessionLineAlong(t *testing.T) {
	yes := true
	got := convertAt([]rawPeer{{Addr: "143.20.137.7:8333", ConnectionType: "inbound", Inbound: true,
		Subver: "/curl:8.5.0/", Version: 70016,
		ServicesNames: []string{}, RelayTxes: &yes,
		BytesRecvPerMsg: map[string]int64{"mempool": 24}}}, time.Now())[0]
	if !strings.HasPrefix(got.About, "Claims: ") {
		t.Fatalf("LinkingLion's range is not told: %q", got.About)
	}
	if got.Seen != "" || got.NoTxSaid {
		t.Errorf("the session is said twice: about %q, seen %q", got.About, got.Seen)
	}
}

// Hemi's code with its own name left empty: "/:<version>-dev+<commit>/",
// after a version message, gets the Hemi line above what it did.
func TestHemiUnnamedGetsItsLine(t *testing.T) {
	got := convertAt([]rawPeer{{Addr: "1.0.0.1:8333", ConnectionType: "inbound", Inbound: true,
		Subver: "/:1.1.0-dev+c1771608d/", Version: 70016, ServicesNames: []string{}}}, time.Now())[0]
	if got.Kind != noAgentKind {
		t.Fatalf("kind %q, want %q", got.Kind, noAgentKind)
	}
	if !strings.HasPrefix(got.About, hemiUnnamedAbout+"\n") || got.Label != "Probably Hemi's code" {
		t.Errorf("about %q, label %q", got.About, got.Label)
	}
}

func TestCoreMajorNamesTheRelease(t *testing.T) {
	for _, c := range []struct {
		maj, mnr int
		want     string
	}{{0, 21, "0.21"}, {0, 8, "0.8"}, {31, 0, "31"}, {22, 1, "22"}} {
		if got := coreMajor(c.maj, c.mnr); got != c.want {
			t.Errorf("coreMajor(%d, %d) = %q, want %q", c.maj, c.mnr, got, c.want)
		}
	}
}

// A block reply that is not JSON costs the card and says why, once; one with
// no detectedAt costs the card without a word (no block yet).
func TestDashboardBlockReplyThatCannotBeRead(t *testing.T) {
	reply := "not json"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			return
		}
		w.Write([]byte(reply))
	}))
	defer srv.Close()

	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)

	clock := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	s := &dashboardClient{
		url: srv.URL + "/api/health", blockURL: srv.URL + "/api/blocks/latest",
		client: srv.Client(), every: time.Minute,
		now: func() time.Time { return clock },
	}
	if got := s.latest(context.Background(), ""); got != nil {
		t.Fatalf("a reply that is not JSON gave a block: %+v", got)
	}
	if !strings.Contains(logged.String(), "could not be read") {
		t.Errorf("no word why: %q", logged.String())
	}

	logged.Reset()
	reply = `{"hash":"00beef","height":1,"detectedAt":0}`
	clock = clock.Add(2 * time.Minute)
	if got := s.latest(context.Background(), ""); got != nil {
		t.Fatalf("a reply without detectedAt gave a block: %+v", got)
	}
	if logged.Len() != 0 {
		t.Errorf("no block yet is not a problem, but it logged: %q", logged.String())
	}
}

// Review 14.11.2026.

// Every inbound IPv6, Tor and I2P peer reaches Core through the gateway or a
// proxy, a private address: an outside indexer there is not this Umbrel's.
func TestIndexerBehindAProxyIsNotYourOwn(t *testing.T) {
	for _, addr := range []string{torProxy + ":41234", dockerGateway + ":41234"} {
		got := convert([]rawPeer{{Addr: addr, ConnectionType: "inbound", Inbound: true,
			Network: "not_publicly_routable", Subver: "/electrs:0.10.0/"}})[0]
		if got.App != "" || strings.Contains(got.About, "your own") {
			t.Errorf("%s: about %q, app %q", addr, got.About, got.App)
		}
	}
}

// A name of nothing but slashes says nothing, as no name at all: LinkingLion
// with it stays "No user agent", and a research host has no claim to quote.
func TestEmptyNameClaimsNothing(t *testing.T) {
	got := convertAt([]rawPeer{{Addr: "143.20.137.7:8333", ConnectionType: "inbound", Inbound: true,
		Subver: "//", Version: 70016, ServicesNames: []string{}}}, time.Now())[0]
	if got.Kind != noAgentKind || strings.Contains(got.About, "Claims:") || got.Label != "Probably LinkingLion" {
		t.Errorf("LinkingLion: kind %q, about %q, label %q", got.Kind, got.About, got.Label)
	}
	got = convertAt([]rawPeer{{Addr: "147.229.8.240:8333", ConnectionType: "inbound", Inbound: true,
		Subver: "/:0.1/", Version: 70016, ServicesNames: []string{}}}, time.Now())[0]
	if strings.Contains(got.About, "Claims:") {
		t.Errorf("research host: about %q", got.About)
	}
}
