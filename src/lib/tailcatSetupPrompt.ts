export const TAILCAT_SETUP_PROMPT = `Set up this computer so I can connect to it from the Whip mobile app.

1. Check this computer's operating system and CPU architecture. Install Tailcat if it is missing, following https://github.com/tailscale/tailcat/blob/main/INSTALL.md.
2. Download the latest matching Whipair binary from the whipair-v* releases at https://github.com/kosumic/whip/releases?q=whipair-v. Verify its SHA-256 checksum against the release checksum file and make the binary executable. Use the native binary directly.
3. If Herdr is installed, run commands in Herdr. Run whipair --tailcat. Use Tailcat's built-in SSH service so a system SSH server and SSH keys are not required. Do not change my system SSH configuration.
4. Keep the process running in a terminal I can return to, and show me its Whip pairing QR code so I can scan it on my phone. Tell me how to stop it when I am done. Keep the QR code and tc address private.`;
