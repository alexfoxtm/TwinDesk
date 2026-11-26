//go:build !android

package mobileif

import "tailscale.com/net/netmon"

func Attach(*netmon.Monitor) {}

func Detach(*netmon.Monitor) {}
