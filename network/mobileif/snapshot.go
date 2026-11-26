package mobileif

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"

	"tailscale.com/net/netmon"
	"tailscale.com/net/tsaddr"
)

type linkProperties struct {
	Name      string   `json:"name"`
	Index     int      `json:"index"`
	MTU       int      `json:"mtu"`
	Addresses []string `json:"addresses"`
	VPN       *vpnPath `json:"vpn"`
}

type vpnPath struct {
	IPv4     bool   `json:"ipv4"`
	IPv6     bool   `json:"ipv6"`
	Revision uint32 `json:"revision"`
}

var invalidSnapshot = errors.New("invalid Android interface snapshot")

// decode translates the effective Android network into a netmon interface.
// An explicit null denotes no usable default network (offline or blocked).
func decode(raw string) (*netmon.Interface, error) {
	var properties *linkProperties
	if len(raw) > 64*1024 || json.Unmarshal([]byte(raw), &properties) != nil {
		return nil, invalidSnapshot
	}
	if properties == nil {
		return nil, nil
	}
	if vpn := properties.VPN; vpn != nil {
		if properties.Name != "" || properties.Index != 0 || properties.MTU != 0 || len(properties.Addresses) != 0 {
			return nil, invalidSnapshot
		}
		// A changed name makes netmon treat an opaque VPN path change as a
		// rebind. Android still chooses the route for the replacement sockets.
		link := newLink(fmt.Sprintf("appvpn-%08x", vpn.Revision), 0, 0, 2)
		if vpn.IPv4 {
			link.AltAddrs = append(link.AltAddrs, availabilityMarker(false))
		}
		if vpn.IPv6 {
			link.AltAddrs = append(link.AltAddrs, availabilityMarker(true))
		}
		return link, nil
	}
	if properties.Name == "" || len(properties.Name) > 15 ||
		strings.ContainsAny(properties.Name, " \t\r\n\x00/") ||
		properties.Index < 0 || properties.MTU < 0 {
		return nil, invalidSnapshot
	}
	link := newLink(properties.Name, properties.Index, properties.MTU, len(properties.Addresses))
	var suppressed4, suppressed6 bool
	for _, rawPrefix := range properties.Addresses {
		prefix, err := netip.ParsePrefix(rawPrefix)
		if err != nil {
			return nil, invalidSnapshot
		}
		addr := prefix.Addr()
		if tsaddr.CGNATRange().Contains(addr.Unmap()) {
			suppressed4 = true
			continue
		}
		if tsaddr.TailscaleULARange().Contains(addr) {
			suppressed6 = true
			continue
		}
		link.AltAddrs = append(link.AltAddrs, &net.IPNet{
			IP: addr.AsSlice(), Mask: net.CIDRMask(prefix.Bits(), addr.BitLen()),
		})
	}
	// Some cellular networks assign addresses in the shared IPv4 range. Keep
	// the address family available for egress probes without exposing its IP.
	if suppressed4 {
		link.AltAddrs = append(link.AltAddrs, availabilityMarker(false))
	}
	if suppressed6 {
		link.AltAddrs = append(link.AltAddrs, availabilityMarker(true))
	}
	return link, nil
}

func newLink(name string, index, mtu, addresses int) *netmon.Interface {
	return &netmon.Interface{
		Interface: &net.Interface{Name: name, Index: index, MTU: mtu, Flags: net.FlagUp | net.FlagRunning},
		// A nil AltAddrs would trigger Android's forbidden netlink query.
		AltAddrs: make([]net.Addr, 0, addresses),
	}
}

func availabilityMarker(ipv6 bool) *net.IPAddr {
	// The pinned netmon accepts IPAddr for interface availability, and only
	// advertises IPNet entries in LocalAddresses. These documentation IPs
	// describe egress capability without supplying endpoint candidates.
	if ipv6 {
		return &net.IPAddr{IP: netip.MustParseAddr("2001:db8::1").AsSlice()}
	}
	return &net.IPAddr{IP: net.IP{192, 0, 2, 1}}
}
