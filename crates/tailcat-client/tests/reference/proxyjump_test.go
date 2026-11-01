package reference

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/tailcat"
	"golang.org/x/crypto/ssh"
	"tailscale.com/tstest/integration"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const privateTarget = "private-target.invalid"
const blockedTarget = "blocked-target.invalid"

// These are actual authenticated SSH connections and TCP forwarding channels.
// Only the intermediate gateway knows the private target's name-to-port mapping;
// no host DNS, routing, SSH configuration or authorized_keys files are changed.
type jumpFixture struct {
	mu       sync.Mutex
	gateways map[net.Conn]bool
	routers  atomic.Int64
	forwards atomic.Int64
	targets  atomic.Int64
	blocked  atomic.Int64
}

func (f *jumpFixture) track(c net.Conn, handle func(net.Conn)) {
	f.mu.Lock()
	f.gateways[c] = true
	f.mu.Unlock()
	defer func() {
		c.Close()
		f.mu.Lock()
		delete(f.gateways, c)
		f.mu.Unlock()
	}()
	handle(c)
}

func (f *jumpFixture) drop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for c := range f.gateways {
		c.Close()
	}
}

func (f *jumpFixture) status() map[string]int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return map[string]int64{
		"gateways": int64(len(f.gateways)), "routers": f.routers.Load(),
		"forwards": f.forwards.Load(), "blocked": f.blocked.Load(), "targets": f.targets.Load(),
	}
}

func fixtureKey(t *testing.T, path string) ssh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "whip-test-only")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0600); err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func listenFixture(t *testing.T, network, address string, handle func(net.Conn)) net.Listener {
	t.Helper()
	listener, err := net.Listen(network, address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handle(conn)
		}
	}()
	return listener
}

func copyFixture(a, b io.ReadWriteCloser) {
	defer a.Close()
	defer b.Close()
	done := make(chan struct{})
	go func() {
		io.Copy(a, b)
		if half, ok := a.(interface{ CloseWrite() error }); ok {
			half.CloseWrite()
		}
		close(done)
	}()
	io.Copy(b, a)
	if half, ok := b.(interface{ CloseWrite() error }); ok {
		half.CloseWrite()
	}
	<-done
}

func startFixtureSSHD(t *testing.T, root, name, authorized string) (string, ssh.Signer) {
	t.Helper()
	keyPath := filepath.Join(root, name+"-host-key")
	signer := fixtureKey(t, keyPath)
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := reservation.Addr().String()
	port := reservation.Addr().(*net.TCPAddr).Port
	reservation.Close()
	config := fmt.Sprintf(`Port %d
ListenAddress 127.0.0.1
HostKey %s
PidFile %s
AuthorizedKeysFile %s
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes no
AllowTcpForwarding yes
AllowStreamLocalForwarding yes
Subsystem sftp internal-sftp
SetEnv HISTFILE=/dev/null
LogLevel ERROR
`, port, keyPath, filepath.Join(root, name+".pid"), authorized)
	configPath := filepath.Join(root, name+".conf")
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	binary, err := exec.LookPath("sshd")
	if err != nil {
		t.Fatal("sshd is required; run with nix develop .#tailcat-tests")
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "-D", "-e", "-f", configPath)
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { command.Process.Kill(); command.Wait() })
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("temporary sshd did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return address, signer
}

func (f *jumpFixture) router(conn net.Conn, config *ssh.ServerConfig, target string) {
	f.routers.Add(1)
	defer f.routers.Add(-1)
	defer conn.Close()
	server, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	defer server.Close()
	go ssh.DiscardRequests(requests)
	for request := range channels {
		var destination struct {
			Host       string
			Port       uint32
			Origin     string
			OriginPort uint32
		}
		if request.ChannelType() != "direct-tcpip" || ssh.Unmarshal(request.ExtraData(), &destination) != nil ||
			destination.Port != 22 || (destination.Host != privateTarget && destination.Host != blockedTarget) {
			request.Reject(ssh.Prohibited, "fixture private route only")
			continue
		}
		if destination.Host == blockedTarget {
			channel, requests, err := request.Accept()
			if err == nil {
				f.blocked.Add(1)
				go ssh.DiscardRequests(requests)
				go func() { defer channel.Close(); io.Copy(io.Discard, channel) }()
			}
			continue
		}
		remote, err := net.DialTimeout("tcp", target, time.Second)
		if err != nil {
			request.Reject(ssh.ConnectionFailed, "target offline")
			continue
		}
		channel, requests, err := request.Accept()
		if err != nil {
			remote.Close()
			continue
		}
		f.forwards.Add(1)
		go ssh.DiscardRequests(requests)
		f.targets.Add(1)
		go func() { defer f.targets.Add(-1); copyFixture(channel, remote) }()
	}
}

// Run only through test-tailcat-proxyjump.sh. Go remains a separate fixture,
// never a production dependency. EOF runs t.Cleanup; Rust owns its process group
// as a fallback so failed tests cannot leave SSH daemons or session children.
func TestWhipTailcatProxyJump(t *testing.T) {
	// The upstream built-in service uses os.UserConfigDir. Only Linux honors
	// XDG_CONFIG_HOME; on macOS it would touch the real user's Tailcat keys.
	if runtime.GOOS != "linux" {
		t.Fatal("the combined SSH fixture requires Linux for isolated XDG configuration")
	}
	root, err := os.MkdirTemp("", "whip-jump-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	// Upstream resets PATH to /usr/bin:/bin for shell requests. A real shell
	// wrapper makes the Nix-provided OpenBSD nc available to that service too.
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("nc"); err != nil {
		t.Fatal("OpenBSD nc is required; use the tailcat-tests shell")
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	loginShell := filepath.Join(root, "login-shell")
	script := fmt.Sprintf("#!%s\nexport PATH=%s\nexec %s \"$@\"\n", shell, quote(os.Getenv("PATH")), quote(shell))
	if err := os.WriteFile(loginShell, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", loginShell)
	configDir := filepath.Join(root, "config", "tailcat", "ssh")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("TS_DEBUG_ALWAYS_USE_DERP", strconv.FormatBool(os.Getenv("WHIP_REFERENCE_RELAY_ONLY") == "1"))
	clientPath := filepath.Join(root, "client-key")
	client := fixtureKey(t, clientPath)
	fixtureKey(t, filepath.Join(root, "wrong-client-key"))
	authorized := filepath.Join(root, "authorized_keys")
	if err := os.WriteFile(authorized, ssh.MarshalAuthorizedKey(client.PublicKey()), 0600); err != nil {
		t.Fatal(err)
	}
	target, targetKey := startFixtureSSHD(t, root, "target", authorized)
	gateway, gatewayKey := startFixtureSSHD(t, root, "gateway", authorized)
	builtinKey := fixtureKey(t, filepath.Join(configDir, "ssh_host_ed25519_key"))
	routerKey := fixtureKey(t, filepath.Join(root, "router-key"))
	routerConfig := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if !bytes.Equal(key.Marshal(), client.PublicKey().Marshal()) {
				return nil, fmt.Errorf("unauthorized fixture key")
			}
			return nil, nil
		},
	}
	routerConfig.AddHostKey(routerKey)
	fixture := &jumpFixture{gateways: make(map[net.Conn]bool)}
	t.Cleanup(fixture.drop)
	router := listenFixture(t, "tcp", "127.0.0.1:0", func(c net.Conn) { fixture.router(c, routerConfig, target) })
	echo := func(c net.Conn) {
		defer c.Close()
		payload, err := io.ReadAll(c)
		if err == nil {
			c.Write(payload)
		}
	}
	tcpEcho := listenFixture(t, "tcp", "127.0.0.1:0", echo)
	socketPath := filepath.Join(root, "echo.sock")
	listenFixture(t, "unix", socketPath, func(c net.Conn) { defer c.Close(); io.Copy(c, c) })
	if err := os.WriteFile(filepath.Join(root, "sftp.txt"), []byte("private target SFTP\n"), 0600); err != nil {
		t.Fatal(err)
	}
	region := integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1").Regions[1]
	// Pin the local TLS certificate so the Rust SSH adapter uses its ordinary
	// production defaults, including relay certificate verification.
	node := region.Nodes[0]
	tlsConn, err := tls.Dial("tcp", net.JoinHostPort(node.IPv4, strconv.Itoa(node.DERPPort)), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(tlsConn.ConnectionState().PeerCertificates[0].Raw)
	tlsConn.Close()
	node.CertName = fmt.Sprintf("sha256-raw:%x", hash)
	server := &tailcat.Server{Region: region, Logf: logger.Discard}
	var allowed key.NodePublic
	if err := allowed.UnmarshalText([]byte(os.Getenv("WHIP_REFERENCE_CLIENT_NODE_KEY"))); err != nil {
		t.Fatal(err)
	}
	server.AllowClient = func(candidate key.NodePublic) bool { return candidate == allowed }
	builtin := os.Getenv("WHIP_REFERENCE_BUILTIN_SSH") == "1"
	handler := func(c net.Conn) {
		remote, err := net.DialTimeout("tcp", gateway, time.Second)
		if err != nil {
			c.Close()
			return
		}
		copyFixture(c, remote)
	}
	if builtin {
		handler = server.SSHConnHandler(tailcat.SSHOptions{Shell: true, AuthorizedKeys: []string{string(ssh.MarshalAuthorizedKey(client.PublicKey()))}})
		gatewayKey = builtinKey
	}
	server.OnTCP = func(port uint16) func(net.Conn) {
		if port != 22 {
			return nil
		}
		return func(c net.Conn) { fixture.track(c, handler) }
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	currentUser, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(map[string]any{
		"address": string(server.TailcatAddr()), "root": root, "username": currentUser.Username,
		"gateway_key": string(ssh.MarshalAuthorizedKey(gatewayKey.PublicKey())),
		"router_key":  string(ssh.MarshalAuthorizedKey(routerKey.PublicKey())),
		"target_key":  string(ssh.MarshalAuthorizedKey(targetKey.PublicKey())),
		"router_port": router.Addr().(*net.TCPAddr).Port,
		"tcp_port":    tcpEcho.Addr().(*net.TCPAddr).Port, "unix_socket": socketPath,
	}); err != nil {
		t.Fatal(err)
	}
	input := bufio.NewScanner(os.Stdin)
	for input.Scan() {
		switch input.Text() {
		case "drop":
			fixture.drop()
		case "status":
		default:
			return
		}
		if err := encoder.Encode(fixture.status()); err != nil {
			return
		}
	}
}
