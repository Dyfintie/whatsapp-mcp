# Local WhatsApp calling backend

This optional Linux backend uses Chromium, Puppeteer and PipeWire. It has a
separate WhatsApp Web login from the Baileys MCP daemon. Tests mock browser and
audio operations and never place calls.

Prerequisites: Node 24.22.0, Chromium at `/usr/sbin/chromium`, PipeWire's `pactl`
and `paplay`, and local Piper installed as `~/.local/bin/piper`. Install the
requested voice model and its JSON configuration under
`~/.local/share/piper-voices/en_US-{ryan,lessac}-medium.onnx[.json]`. Models and
browser profiles are local to the host. Set `WHATSAPP_CHROMIUM_BIN` in the
calling process environment if the distribution uses another executable path.

From the repository root:

```sh
npm ci --prefix calling
npm run build --prefix calling
npm test --prefix calling
python3 scripts/test-audio-helper.py calling/scripts/whatsapp-audio-setup
mkdir -p "$HOME/.local/bin"
install -m 755 calling/scripts/whatsapp-audio-setup "$HOME/.local/bin/whatsapp-audio-setup"
```

Expose `calling/dist/index.js` as `~/.local/bin/whatsapp-call`, for example with
a symlink to its absolute path after making the generated entrypoint executable:

```sh
chmod +x calling/dist/index.js
ln -s "$(pwd)/calling/dist/index.js" "$HOME/.local/bin/whatsapp-call"
```

If that path already exists, inspect it and preserve its current target before
replacing it. Ensure Node and `~/.local/bin` are on the daemon's PATH. Run
`whatsapp-call login` interactively to link the dedicated browser profile.
Login is an account setup action; it is not part of the test suite.

The dedicated browser picks a loopback debugging port and records its port and
instance ID in the calling profile. When upgrading from the fixed-port helper,
close the old calling window before starting the updated helper against that
profile. For initial linking, scan the QR code in the visible window. Login
waits for the chat list. Status and hangup inspect an existing WhatsApp tab.

Calls and voice notes contact real recipients. Obtain explicit recipient and
intent authorization before invoking action tools. Exact recipient verification
fails when the UI cannot prove identity, including a phone lookup displaying only
a saved name. Browser selectors depend on WhatsApp Web's version and language.
Concurrent dials through the MCP daemon are guarded; independent CLI processes
have no shared lock. A timeout requests hangup but does not prove remote
termination. Inspect status before considering another dial.
