// Package mobileif bridges Android's effective network state into tsnet.
package mobileif

import (
	"sync/atomic"

	"tailscale.com/net/netmon"
)

var activeLink atomic.Pointer[netmon.Interface]
var activeMonitor atomic.Pointer[netmon.Monitor]

func init() {
	// netmon's getter is process-global and unsynchronized. Register once
	// before any workers exist. It reads immutable snapshots thereafter.
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		if link := activeLink.Load(); link != nil {
			return []netmon.Interface{*link}, nil
		}
		return nil, nil
	})
}

// Publish replaces the snapshot and wakes the current monitor. Android's
// ordinary polling interval is ten minutes, so waiting on it delays roaming.
func Publish(raw string) bool {
	link, err := decode(raw)
	if err != nil {
		return false
	}
	name := ""
	if link != nil {
		name = link.Name
	}
	activeLink.Store(link)
	netmon.UpdateLastKnownDefaultRouteInterface(name)
	if m := activeMonitor.Load(); m != nil {
		m.InjectEvent()
	}
	return true
}

func Attach(m *netmon.Monitor) {
	activeMonitor.Store(m)
	// A network callback can arrive between netmon creation and attachment.
	m.InjectEvent()
}

func Detach(m *netmon.Monitor) {
	activeMonitor.CompareAndSwap(m, nil)
}
