# fix-ssh-ed25519-windows

Enable ed25519 SSH authentication on Windows by building the vendored libssh2 with the openssl-on-win32 crypto backend instead of WinCNG (which lacks ed25519), so pali serve can sync memory repos over SSH without an HTTPS token.
