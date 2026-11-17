// canvas-tunnel: the helper Canvas runs to reach a Cloud hosted on a Mac (src/cloud-tunnel.ts). It is the tailcat
// library (github.com/tailscale/tailcat, BSD-3-Clause, pinned in go.mod): WireGuard tunnels with NAT traversal and
// relays of last resort, no account, no root. Built into Canvas.app by apps/macos/build.sh when Go is installed.
//
// It reads one order as a JSON line on stdin and answers with JSON lines on stdout. Nothing secret is ever on its
// command line: keys and tunnel addresses come over stdin. It writes nothing else to stdout and logs nothing. When
// stdin closes (Canvas quit or crashed) it exits, so it never outlives Canvas.
//
//	{"op":"genkey","kind":"server"|"client"}                 -> {"event":"key","key":{...},"public":"nodekey:..","addr"?:"tc.."}
//	{"op":"serve","key":{...},"port":5190,"allow":[...]|null} -> {"event":"ready","addr":"tc.."}   (allow null: anyone)
//	{"op":"forward","key":{...},"addr":"tc..","port":5190}     -> {"event":"ready","port":N}       (listener on 127.0.0.1:N)
//	any failure                                                -> {"event":"error","message":".."} and exit 1
//
// serve forwards only to 127.0.0.1:5190: the port is fixed here, whatever the order says, and there is no exit-node
// or any other service.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

// cloudPort is the only port a served tunnel reaches: the hosted Cloud on 127.0.0.1.
const cloudPort = 5190

type order struct {
	Op    string             `json:"op"`
	Kind  string             `json:"kind"`
	Key   *tailcat.PrivateKey `json:"key"`
	Addr  string             `json:"addr"`
	Port  int                `json:"port"`
	Allow *[]string          `json:"allow"`
}

var out = json.NewEncoder(os.Stdout)

func say(v map[string]any) { _ = out.Encode(v) }
func fail(msg string) {
	say(map[string]any{"event": "error", "message": msg})
	os.Exit(1)
}
func quiet(string, ...any) {}

func main() {
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadBytes('\n')
	if err != nil {
		fail("no order")
	}
	var o order
	if err := json.Unmarshal(line, &o); err != nil {
		fail("bad order")
	}
	// Stdin closing is the signal to quit.
	go func() { _, _ = io.Copy(io.Discard, r); os.Exit(0) }()
	ctx := context.Background()
	switch o.Op {
	case "genkey":
		genkey(ctx, o.Kind)
		os.Exit(0)
	case "serve":
		serve(ctx, o)
	case "forward":
		forward(ctx, o)
	default:
		fail("unknown order")
	}
	select {}
}

// genkey makes a key. A server key is pinned to the nearest relay region now, so its address stays the same.
func genkey(ctx context.Context, kind string) {
	priv := tailcat.NewPrivateKey()
	pub := priv.Private.Public()
	if kind == "client" {
		say(map[string]any{"event": "key", "key": priv, "public": pubText(pub)})
		return
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	dm, err := tailcat.FetchDERPMap(c, tailcat.DERPMapURL(tailcat.DefaultDERPMapURL), tailcat.ExpandForServer)
	if err != nil {
		fail("could not reach the relay list")
	}
	id, err := tailcat.PickBestRegion(c, dm)
	if err != nil || id == 0 {
		fail("could not find a relay region")
	}
	priv.Public.RegionID = id
	say(map[string]any{"event": "key", "key": priv, "public": pubText(pub), "addr": string(priv.Public.Addr())})
}

func pubText(k key.NodePublic) string {
	b, _ := k.MarshalText()
	return string(b)
}

func serve(ctx context.Context, o order) {
	if o.Key == nil {
		fail("no key")
	}
	ci := o.Key.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(tailcat.DefaultDERPMapURL)); err != nil || len(ci.Region) == 0 {
		fail("could not reach the relays")
	}
	reg := ci.Region[0]
	s := &tailcat.Server{Key: o.Key.Private, PresharedKey: ci.PresharedKey, Logf: quiet, Region: reg}
	if o.Allow != nil {
		if len(*o.Allow) == 0 {
			// No enrolled device yet: nobody. (An empty list would mean everyone.)
			s.AddAllowedClient(key.NodePublic{})
		}
		for _, ks := range *o.Allow {
			var k key.NodePublic
			if err := k.UnmarshalText([]byte(ks)); err != nil {
				fail("bad key in the allow list")
			}
			s.AddAllowedClient(k)
		}
	}
	ln, err := s.Listen(ctx, "tcp", ":5190")
	if err != nil {
		fail("could not start the tunnel")
	}
	addr := (&tailcat.ConnInfo{ServerPublic: tailcat.NodePublic{NodePublic: o.Key.Private.Public()}, ServerDiscoPublic: tailcat.DiscoPublicForNode(o.Key.Private), PresharedKey: ci.PresharedKey, RegionID: reg.RegionID}).Addr()
	say(map[string]any{"event": "ready", "addr": string(addr)})
	for {
		c, err := ln.Accept()
		if err != nil {
			os.Exit(1)
		}
		go func() {
			up, err := net.DialTimeout("tcp", "127.0.0.1:5190", 5*time.Second)
			if err != nil {
				c.Close()
				return
			}
			tailcat.ProxyConns(c, up)
		}()
	}
}

func forward(ctx context.Context, o order) {
	if o.Key == nil || o.Addr == "" {
		fail("no key or address")
	}
	if _, err := tailcat.ParseAddr(tailcat.Addr(o.Addr)); err != nil {
		fail("not a tunnel address")
	}
	cl := tailcat.NewClient(tailcat.Addr(o.Addr))
	cl.Key = o.Key.Private
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail("could not listen")
	}
	say(map[string]any{"event": "ready", "port": ln.Addr().(*net.TCPAddr).Port})
	for {
		c, err := ln.Accept()
		if err != nil {
			os.Exit(1)
		}
		go func() {
			d, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			up, err := cl.DialTCPPort(d, cloudPort)
			if err != nil {
				c.Close()
				return
			}
			tailcat.ProxyConns(c, up)
		}()
	}
}

var _ = tailcfg.DERPRegionID(0)
