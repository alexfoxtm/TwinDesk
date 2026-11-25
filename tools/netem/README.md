# TwinDesk network impairment fixture

Run with Node.js 18 or later. Each process forwards one fixed TCP or UDP listener to one IPv4 loopback service. The default binds and accepts only `127.0.0.1`. Non-loopback mode requires the exact Mac interface and sole authorized client IPv4, both RFC 1918 or 100.64.0.0/10. It rejects .0 and .255 addresses and accepts only the two TCP mappings below. The relay does not discover ports, change system network state, or log payloads or peer identifiers.

```sh
node tools/netem/relay.mjs --protocol tcp --port 43171 --target-port 47800 --profile poor --seed 20261125
node --test tools/netem/relay.test.mjs tools/netem/turn.test.mjs
node tools/netem/fixture.mjs
```

The first command assumes a preverified local control service at `47800`. Send `SIGUSR1` to the relay PID to close current flows and reject new traffic. Send `SIGUSR2` to admit fresh connections. TERM or Ctrl-C closes the listener and prints counters. Apply cut and reconnect to both relay processes for a device run.

| Profile | Added RTT, ms | Loss per direction | Rate per flow and direction |
| --- | ---: | ---: | ---: |
| easy | 80 | 1% | 20 Mbps |
| poor | 150 | 3% | 5 Mbps |
| severe | 300 | 5% | 2 Mbps |

Override `--rtt`, `--loss` and `--mbps` independently. Each accepted flow gets separate seeded random streams for jitter and loss on each direction. Each read or datagram draws an integer uniformly from −30 through +30 ms inclusive for jitter. The added one-way delay is RTT/2 plus that draw, floored at zero. Delivery remains FIFO, so an earlier delayed item can hold subsequent items and there is no simulated reordering. Seeded decisions repeat for the same flow creation and read/datagram order. TCP read boundaries and wall-clock scheduling can vary by run.

UDP loss discards whole datagrams. TCP loss is a per-chunk probability of waiting one additional configured RTT. TCP chunks are at most 64 KiB, and the relay preserves byte order and half-closes. The native TCP legs handle their own handshakes and congestion control. The stall model does not reproduce kernel TCP packet loss, retransmission algorithms, or a shaped TCP SYN. Each flow and direction has a 64 KiB token bucket burst and a queue bounded to 256 KiB and 512 entries. The relay applies TCP backpressure and drops UDP overflow. It limits each listener to 32 flows and retires idle flows after 60 seconds. Each UDP client has its own connected upstream socket.

## Measuring the actual app

Start from one already paired phone or iPad and a Mac whose interface address and peer identity have been verified. Pair normally with the Mac before enabling this route. QR pairing has a port field and can persist addresses, so the test uses the saved pair from Connect instead. Existing Release mobile builds use their normal route.

1. Stage the same diagnostics on both revisions under comparison. For the original baseline, apply the test route and harness to the baseline sources before building. Launch an authorized test Mac process with `TWINDESK_NETEM_PHONE` set to the already paired phone's device ID. Verify that process owns `47800` and the dedicated loopback TURN listener `43200`. If the live Mac already owns `47800`, this requires a controlled test cutover or an isolated test Mac with its own ordinary pairing. The wired listener on `47802` is outside this route.
2. Build Android Debug with `-PtwNetemPeer=<paired-Mac-id> -PtwNetemAddress=<Mac-interface-IPv4>`. For iPad, use a provisioned Debug build and set `TWINDESK_NETEM_PEER` and `TWINDESK_NETEM_ADDRESS` in its authorized launch environment. Select the saved Mac and open its viewer using ordinary consent. The in-memory override dials `43198` with the existing certificate pin and token and does not save the relay endpoint.
3. Set `mac_test_ip` and `phone_test_ip` to the exact authorized endpoints. Start both TCP processes for each profile, including identical seed, RTT, loss and rate when repeating a run.

```sh
node tools/netem/relay.mjs --protocol tcp --listen "$mac_test_ip" --client "$phone_test_ip" --port 43198 --target-port 47800 --profile poor --seed 20261125
node tools/netem/relay.mjs --protocol tcp --listen "$mac_test_ip" --client "$phone_test_ip" --port 43199 --target-port 43200 --profile poor --seed 20261125
```

The Mac offers the dedicated TURN server only to the authenticated configured handset on its opted-in loopback control socket. The Mac leg stays on loopback. The mobile viewer routes its TURN/TCP leg through `43199` and requires a relay candidate for that offer. The TURN test instance exchanges UDP only between its own live allocations. Its media impairment uses TCP stalls and an independent rate cap, with the original UDP fixture covering actual simulated datagram loss.

Collect only the `TwinDeskNetem` diagnostic lines and proxy counters. `welcome_ms` starts at dial and ends at the authenticated Welcome. `first_presented_ms` ends at the first current-offer `requestVideoFrameCallback` observed by the mobile bridge. It includes any time the operator took to open the viewer. `offer_to_presented_ms` starts at that offer. `receiver_fps` and `receiver_kbps` use inbound video deltas and `-1` means no interval sample. The selected video ICE pair counts as `proxy-turn-tcp` only when its candidate stats prove the expected TURN URL, TCP relay protocol and a relay candidate on the Mac end. Check both processes forwarded bytes in the same trial. A different known path reports `bypass`, and incomplete stats report `unverified`. Control may pass through its proxy even if media is unverified. Check direct versus DERP only for confirmed tailnet peers, independently of ICE stats.

For cut or recovery, record the time of the operator action, authenticated reconnection and first presented frame on one external elapsed clock. Per-dial diagnostics use device clocks with different suspend semantics. Keep a sleep trial below the relay's 60-second expiry or record that expiry as an additional impairment. An application input RTT is unavailable without an acknowledgment at a defined input handler, including any separate input lane. Control ping/pong RTT does not measure that. Stop both relay processes and the dedicated test Mac process after recording evidence.

`fixture.mjs` runs the 27 combinations of RTT 80/150/300 ms, loss 1/3/5%, and rate 2/5/20 Mbps on disposable sockets using seed `20261125`. Each UDP row sends 100 synthetic 64-byte echo requests 20 ms apart and collects replies for 600 ms more. It emits actual duration, echoed counts, p50/p95 RTT and drop counters. The three independent bulk TCP rows measure delivered bytes over two seconds after a one-second warm-up at zero added delay and loss. These fixtures check relay behavior and contain no device, video or input measurements.
