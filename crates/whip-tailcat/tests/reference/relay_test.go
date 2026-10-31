package reference

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/tstest/integration"
	"tailscale.com/types/logger"
)

// Optional test-only upstream server, DERP relay, and STUN fixture. The Rust
// library and its mobile builds never execute or link this Go module.
func TestWhipTailcatReference(t *testing.T) {
	region := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1").Regions[1]
	server := &tailcat.Server{
		Region:              region,
		Logf:                logger.Discard,
		DisablePresharedKey: os.Getenv("WHIP_REFERENCE_NO_PSK") == "1",
		OnTCP: func(port uint16) func(net.Conn) {
			switch port {
			case 22:
				return func(conn net.Conn) {
					defer conn.Close()
					payload, err := io.ReadAll(conn)
					if err == nil {
						_, _ = conn.Write(payload)
					}
				}
			case 23:
				return func(conn net.Conn) {
					defer conn.Close()
					_, _ = io.Copy(conn, conn)
				}
			case 24:
				return func(conn net.Conn) {
					defer conn.Close()
					_, _ = conn.Write([]byte("server-finished"))
					_ = conn.(interface{ CloseWrite() error }).CloseWrite()
					// The client must still be able to write after receiving EOF.
					_, _ = io.Copy(io.Discard, conn)
				}
			default:
				return nil
			}
		},
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"address": string(server.TailcatAddr())}); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}
