package relay

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

// Compiled by tests/test-tailcat.sh and launched by the Rust transport tests.
// Closing stdin tears down the local relay and STUN server through t.Cleanup.
func TestWhipRelay(t *testing.T) {
	region := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1").Regions[1]
	server := &tailcat.Server{
		Region: region,
		Logf:   logger.Discard,
		OnTCP: func(port uint16) func(net.Conn) {
			if port != 22 {
				return nil
			}
			return func(connection net.Conn) {
				defer connection.Close()
				payload, err := io.ReadAll(connection)
				if err == nil {
					_, _ = connection.Write(payload)
				}
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
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
}
