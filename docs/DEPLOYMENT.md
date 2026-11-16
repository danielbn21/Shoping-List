# Deployment

Running, securing, backing up and upgrading the server.

## Run it

```bash
docker compose up -d --build
```

Open `http://<server-ip>:3000` (or `HOST_PORT=3010 docker compose up -d --build` to use another host port). The first visit asks you to create the admin account. Data is stored in `./data/shoplist.db`; back up that folder.

**Back up the whole `data/` folder**: the database, receipt photos (`data/receipts/`), installed modules and their data (`data/modules/`) and the key file `secret.key`.

## Nginx Proxy Manager + Cloudflare

PWAs (install, service worker, push) need HTTPS, and so does the phone camera that barcode scanning uses.

1. NPM → Proxy Hosts → Add: your domain, scheme `http`, forward host = the Docker host, port `3000`.
2. Turn on **Websockets Support** (for live sync, when it is added) and **Block Common Exploits**.
3. SSL tab: request a certificate, enable **Force SSL** and **HTTP/2**.
4. In Cloudflare, proxy (orange cloud) is fine. Keep SSL/TLS mode on **Full** or **Full (strict)**.
5. In the app: Admin → Server settings → set **Public address** to your https URL so invite and reset links are correct.

The server trusts `X-Forwarded-*` headers, so cookies are marked `Secure` automatically behind HTTPS.

## Accounts and passwords

- **Registration mode** (Admin → Server settings): invite-only (default), open, or admin-only.
- **Forgot password:** by email if SMTP is configured; otherwise the admin uses **Reset password** on the user to generate a **one-time password** (shown once; the user must choose a new password at next sign-in).
- **Stay signed in:** a revocable session cookie (default 365 days, sliding). Users can sign out devices from Settings.

## Modules and restarts

Receipt reading, price comparison, barcode scanning and the Hebrew language are modules that ship with the image and start switched on. In **Admin → Modules** an admin can install a module from a zip (the screen shows its name, version and a hash to confirm), switch it on or off, choose who may use it, roll back or uninstall. Changes take effect after the admin presses **Restart server**; Docker (`restart: unless-stopped`, already in the compose file) starts the server again. Installed modules and their data live in `data/modules/`. An uploaded module runs inside the server with full access to its own data, so install only modules you trust.

## Receipt reading and privacy

- **Local (default):** Tesseract inside the container, English and Hebrew. Private and free; accuracy depends on the photo (flat, well-lit, full-frame receipts work best).
- **Cloud (optional, per user):** in Settings a user chooses a provider (Anthropic, OpenAI or Google) and pastes their own API key. The key is encrypted at rest (`data/secret.key`) and never shown again. With the engine on *Automatic*, cloud is used only when the user has saved a key; *Local only* keeps photos on the server. When cloud is used, the receipt photo is sent to that provider.
- The admin can switch receipt scanning off entirely (Server settings). Receipt photos live in `data/receipts/` and are deleted with their household.

## Upgrading

Recommended: **`./update.sh`** (pulls from GitHub, builds first, backs up `data/`, starts the new version, checks it, and rolls back by itself if it fails). Also `./update.sh --tag v1.5.0` (any tag), `--rollback` and `--dry-run`. By hand:

1. Replace the project folder with the new zip but keep your `data/` folder.
2. **Keep your port setting:** a new `docker-compose.yml` overwrites the old one, so put your port in a `.env` file next to it (`HOST_PORT=3010`) and it survives upgrades.
3. `docker compose up -d --build` and **read the output**: if the build fails (network, apt, npm), compose keeps the OLD container running and you keep seeing the old version.
4. Settings shows `Version: app X · server Y`. If a device still runs old files, a yellow *Update now* banner appears; it clears the cached app and reloads.

## Run the published image (GitHub container registry)

Pushing a version tag builds, tests and publishes the image, so the server can *pull* it instead of building.

1. **Publish:** `scripts/set-version.sh 1.0.1`, commit, then `git tag -a v1.0.1 -m "v1.0.1" && git push && git push --tags`. Watch the *Release image* run under the repository's **Actions** tab. The image appears under your profile's **Packages** as `ghcr.io/YOUR-USER/YOUR-REPO` (all lowercase) with tags `1.0.1`, `1.0` and `latest`. The run refuses to publish if the tag and the versions in `server/package.json` and `web/package.json` disagree.
2. **Let the server pull it (private repositories):** create a *Personal access token (classic)* with only the `read:packages` scope, then on the server: `echo YOUR_TOKEN | docker login ghcr.io -u YOUR-GITHUB-USER --password-stdin`.
3. **Point the server at it:** in `.env` set `SHOPLIST_IMAGE=ghcr.io/YOUR-USER/YOUR-REPO` and `SHOPLIST_TAG=1.0.1`.
4. **Install or upgrade:** back up `data/` (`cp -a data data-backup-$(date +%F)`), then `docker compose pull && docker compose up -d`. To roll back, set the previous `SHOPLIST_TAG` and run the same two commands (restore the backup too if the newer version had changed the database).

Without those two variables the compose file keeps building from source, so `./update.sh` works as before. The image contains the app only; your data, photos and keys stay in `./data` on the server.

## Troubleshooting

- **`port is already allocated`:** something else uses the host port. Start with `HOST_PORT=3010 docker compose up -d` (or put `HOST_PORT=3010` in a `.env` file next to the compose file).
- **`SQLITE_CANTOPEN`:** the data folder is not writable. The image fixes ownership on start; if your platform forbids that, run `chown -R 1000:1000 ./data` on the host.
