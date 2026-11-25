# TwinDesk network impairment fixture

Run with Node.js 18 or later. Each relay process forwards one fixed TCP or UDP listener to one IPv4 loopback service. Use only verified TwinDesk endpoints or the disposable loopback fixtures. For an authorized device test, pass the exact interface IPv4 with `--listen` and the sole allowed source IPv4 with `--client`. The default binds and accepts only `127.0.0.1`. The relay does not discover ports, change system network state, or log payloads or peer identifiers.

```sh
node tools/netem/relay.mjs --protocol tcp --port 43171 --target-port 47800 --profile poor --seed 20261125
node --test tools/netem/relay.test.mjs
node tools/netem/fixture.mjs
```

The first command treats `47800` as a preverified local control endpoint. Start another process with `--protocol udp` and exact listener and target ports to shape a verified media endpoint. Send `SIGUSR1` to the relay PID to close current flows and reject new traffic. Send `SIGUSR2` to reopen for fresh connections. TERM or Ctrl-C closes the listener and prints counters. Apply cut and reconnect to each relay in the verified test path.

| Profile | Added RTT, ms | Loss per direction | Rate per flow and direction |
| --- | ---: | ---: | ---: |
| easy | 80 | 1% | 20 Mbps |
| poor | 150 | 3% | 5 Mbps |
| severe | 300 | 5% | 2 Mbps |

Override `--rtt`, `--loss` and `--mbps` independently. Each accepted flow gets separate seeded random streams for jitter and loss on each direction. Each read or datagram draws an integer uniformly from −30 through +30 ms inclusive for jitter. The added one-way delay is RTT/2 plus that draw, floored at zero. Delivery remains FIFO, so an earlier delayed item can hold subsequent items and there is no simulated reordering. Seeded decisions repeat for the same flow creation and read/datagram order. TCP read boundaries and wall-clock scheduling can vary by run.

UDP loss discards whole datagrams. TCP loss is a per-read probability of waiting one additional configured RTT before forwarding that read. TCP preserves the stream and half-closes. The two native TCP legs handle their own handshakes and congestion control. The stall model does not reproduce kernel TCP packet loss, retransmission algorithms, or a shaped TCP SYN. For app connect timing, measure from dial initiation to the authenticated Welcome. Each flow and direction has a 64 KiB token bucket burst and a queue bounded to 256 KiB and 512 entries. The relay applies TCP backpressure and drops UDP overflow. It limits each listener to 32 flows and retires idle flows after 60 seconds. Each UDP client has its own connected upstream socket.

## Measuring the actual app

Verify the authenticated WebSocket route and the WebRTC selected candidate pair before interpreting measurements. The installed Android and iPad manual address paths use a fixed control port, and WebRTC negotiates ports independently. Relaying the control listener alone shapes signaling and input delivery to the socket. Media can take a separate path or bypass that relay entirely. A full device run needs a test route that can select the relay port and explicitly route the negotiated media through the measured path while preserving normal pairing and consent. Check direct versus DERP only for confirmed tailnet peers and record the media route separately.

Define first presented frame as the first current-session viewer frame callback following an open or resume. Report decoded FPS and incoming video bitrate from interval deltas at the receiver. Control ping/pong RTT and application-input-to-host RTT are separate measurements. For cut, switch or sleep, measure authenticated reconnection and first presented frame after recovery only when the same approved owner and session path are known.

`fixture.mjs` runs the 27 combinations of RTT 80/150/300 ms, loss 1/3/5%, and rate 2/5/20 Mbps on disposable sockets using seed `20261125`. Each UDP row sends 100 synthetic 64-byte echo requests 20 ms apart and collects replies for 600 ms more. It emits actual duration, echoed counts, p50/p95 RTT and drop counters. The three independent bulk TCP rows measure delivered bytes over two seconds after a one-second warm-up at zero added delay and loss. These fixtures check relay behavior and contain no device, video or input measurements.
