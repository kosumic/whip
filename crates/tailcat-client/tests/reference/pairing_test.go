package reference

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/tstest/integration"
	"tailscale.com/types/logger"
)

// Real upstream built-in SSH, with an isolated local DERP/STUN relay. No sshd
// or authorized_keys file is used by this fixture.
func TestWhipBuiltinPairing(t *testing.T) {
	region := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1").Regions[1]
	// Match production TLS verification by embedding the fixture certificate pin.
	node := region.Nodes[0]
	conn, err := tls.Dial("tcp", net.JoinHostPort(node.IPv4, strconv.Itoa(node.DERPPort)), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(conn.ConnectionState().PeerCertificates[0].Raw)
	conn.Close()
	node.CertName = fmt.Sprintf("sha256-raw:%x", hash)
	s := &tailcat.Server{Region: region, Logf: logger.Discard}
	handler := s.SSHConnHandler(tailcat.SSHOptions{Shell: true})
	s.OnTCP = func(port uint16) func(net.Conn) {
		if port == 22 {
			return handler
		}
		return nil
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"address": string(s.TailcatAddr())}); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}
