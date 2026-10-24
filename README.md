# LiveMic

Web dashboard for monitoring and controlling Shure SLX-D receivers (SLXD4 and SLXD4D) from any browser on your network. Part of the Live series.

Version 0.4.0

## The mixer

Each channel is a vertical strip: level meter and gain fader side by side, a gain readout with -/+ buttons, a Low / Hot / Clipping hint, and one RF bar and battery gauge. Alerts (low battery, weak RF, clipping, receiver offline) appear as small pills at the top, and only when there is something to say.

Everything you rarely touch lives in Settings (gear icon, top right; it turns into **Done**), laid out like LivePi's Setup page:

- **Channels**: name, output level (mic / line) and frequency for every channel
- **Receivers**: connection status, address, model, firmware, and per-antenna RF for each receiver
- **Settings**: theme (Auto / Dark / Light), show or hide idle channels, gain check range, alert thresholds, control and PIN status, version

Display, gain check and alert settings are saved per device (in the browser). Names, output level and frequency are written to the receiver.

## Gain check

Shure's SLX-D guide describes a manual gain screen: sound-check the transmitter at performance level and keep the audio meter inside its "optimal range". The receiver has no automatic gain routine, so LiveMic does the same thing on screen. The outlined zone on each meter is the optimal peak range (default -20 to -6 dBFS). While someone talks, the strip watches the loudest peak of the last 8 seconds and shows Low, Hot, Clipping or In range, with a one-tap button that applies the suggested change (aiming for -12 dBFS). Shure gives no numbers, so the range and aim point are adjustable in Settings > Gain check.

SLX-D's published command strings do not include a mute command, so there is no mute button.

## How it works

Browsers cannot open raw TCP connections, so a small bridge (`server.js`) connects to each receiver on port 2202 and serves the dashboard. No packages to install; Node 18 or newer.

## Set it up from the web page

Nothing needs editing by hand. Open the dashboard and go to **Settings (gear) > Receivers**:

- **Search the network** looks for SLX-D receivers in an address range (it suggests your own network, for example `192.168.1.0/24`; type another range if your receivers are on a different network or VLAN). It tries port 2202 on every address, then asks each device that answers for its model, firmware and name. Tap **Add** on a receiver, or **Add all**. If a device has port 2202 open but does not answer, it is flagged: on the receiver, set Advanced Settings > Controller Access to Allow, then search again.
- **Add by address** adds a receiver by IP address or host name.
- Each receiver can be renamed, moved to a new address, switched between 1, 2 or 4 channels, or removed.
- **Settings > Control** sets a control PIN (stored hashed) and a read-only mode.

Changes apply right away and are saved to the config file. The search only looks at private network addresses, at most 1,024 at a time.

## Run it with Docker

Images for PC/server (amd64) and Raspberry Pi (arm64) are built by GitHub Actions and published to `ghcr.io/leonidis2013/livemic`.

```
curl -O https://raw.githubusercontent.com/leonidis2013/LiveMic/main/docker-compose.yml
docker compose up -d
```

Then open `http://<that machine's IP>:8080` and use Settings > Receivers > Search. Your settings are kept in a Docker volume, so they survive updates.

- Update: `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f`
- Build it yourself instead: `docker compose up -d --build`
- The container only makes outbound connections to the receivers (port 2202). The machine running it needs a route to the receivers' network.
- If the pull is refused, open the package on GitHub (Packages on the repo's page) and set its visibility to Public.

## Run it without Docker

1. Install Node.js on an always-on machine on the same network as the receivers (a Raspberry Pi is a good fit).
2. Start it with `node server.js` (or `node server.js --demo` to look around with simulated receivers), then open `http://<that machine's IP>:8080`.
3. Settings are saved to `config.json` next to `server.js`. Set the `CONFIG` environment variable to keep it somewhere else.

To run at boot on a Pi, create `/etc/systemd/system/livemic.service`:

```
[Unit]
Description=LiveMic
After=network-online.target

[Service]
WorkingDirectory=/home/pi/livemic
ExecStart=/usr/bin/node server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now livemic`.

## On the receivers

Set **Advanced Settings > Controller Access** to **Allow**. SLX-D blocks third-party control by default, and LiveMic shows "no data" until you do. Give each receiver a fixed IP address (or a DHCP reservation).

## config.json (optional)

Everything below is normally written for you by the web page. You can also edit it by hand while LiveMic is stopped: `receivers` (`name`, `host`, `channels`), `readOnly`, `meterMs` (update interval, default 250), and `demo` (true = simulated receivers). `controlPin` in plain text still works, but setting the PIN in the web page stores it hashed. The port comes from the `PORT` environment variable (default 8080); in Docker, map it with `ports`.

Anyone on the network can open the dashboard. Set a control PIN so only people who know it can change settings.

## Tests

`npm test` runs the bridge against a fake SLX-D that speaks the same command strings. It checks parsing, the gain offset, metering conversion, the exact commands sent, the network search, and adding, editing and removing receivers and the PIN from the web. It has not been run against real hardware yet; the command strings follow Shure's published SLX-D document.
