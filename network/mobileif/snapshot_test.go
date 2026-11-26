package mobileif

import (
	"slices"
	"testing"

	"tailscale.com/net/netmon"
	"tailscale.com/types/logger"
	"tailscale.com/util/eventbus"
)

func TestDecodeLinkAndOffline(t *testing.T) {
	link, err := decode(`{"name":"wlan0","index":12,"mtu":1500,"addresses":["192.0.2.42/24","2001:db8::42/64"]}`)
	if err != nil {
		t.Fatal(err)
	}
	if !link.IsUp() || link.Name != "wlan0" || link.Index != 12 || link.MTU != 1500 {
		t.Fatalf("unexpected interface: %#v", link.Interface)
	}
	addrs, err := link.Addrs()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, addr := range addrs {
		got = append(got, addr.String())
	}
	if want := []string{"192.0.2.42/24", "2001:db8::42/64"}; !slices.Equal(got, want) {
		t.Fatalf("addresses = %v, want %v", got, want)
	}
	if offline, err := decode(`null`); offline != nil || err != nil {
		t.Fatalf("offline = %v, %v", offline, err)
	}
}

func TestDecodeRejectsInvalidSnapshot(t *testing.T) {
	if link, err := decode(`{"name":"wlan0","addresses":["192.0.2.42/33"]}`); link != nil || err == nil {
		t.Fatalf("invalid prefix = %v, %v", link, err)
	}
	if link, err := decode(`{"vpn":{"ipv4":true},"name":"tun0","addresses":["100.65.0.4/32"]}`); link != nil || err == nil {
		t.Fatalf("VPN interface data = %v, %v", link, err)
	}
}

func TestVPNAvailabilityRebindAndAddressPrivacy(t *testing.T) {
	t.Cleanup(func() { netmon.RegisterInterfaceGetter(nil) })
	register := func(raw string) netmon.State {
		t.Helper()
		link, err := decode(raw)
		if err != nil || link == nil {
			t.Fatalf("decode = %v, %v", link, err)
		}
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) { return []netmon.Interface{*link}, nil })
		regular, loopback, err := netmon.LocalAddresses()
		if len(regular) != 0 || len(loopback) != 0 || err != nil {
			t.Fatalf("availability markers exposed as local endpoints: %v, %v, %v", regular, loopback, err)
		}
		bus := eventbus.New()
		defer bus.Close()
		monitor, err := netmon.New(bus, logger.Discard)
		if err != nil {
			t.Fatal(err)
		}
		defer monitor.Close()
		state := *monitor.InterfaceState()
		state.DefaultRouteInterface = link.Name
		return state
	}
	before := register(`{"vpn":{"ipv4":true,"ipv6":true,"revision":4}}`)
	after := register(`{"vpn":{"ipv4":true,"ipv6":true,"revision":5}}`)
	if !before.HaveV4 || !before.HaveV6 || !after.AnyInterfaceUp() {
		t.Fatalf("expected usable VPN address families, got %v -> %v", &before, &after)
	}
	delta, err := netmon.NewChangeDelta(&before, &after, 0, false)
	if err != nil || !delta.RebindLikelyRequired {
		t.Fatalf("VPN underlay revision did not trigger a rebind: %v, %v", delta, err)
	}
	carrier := register(`{"name":"rmnet0","addresses":["100.115.93.32/24","fd7a:115c:a1e0::1/64","::ffff:100.64.0.10/128"]}`)
	if !carrier.HaveV4 || !carrier.HaveV6 {
		t.Fatalf("suppressed carrier addresses disabled egress families: %v", &carrier)
	}
}
