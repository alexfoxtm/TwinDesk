// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Private stdio adapter for the same embedded node used by the mobile bridges.
package main

import (
	"bufio"
	"encoding/json"
	"os"

	"twindesk.local/embedded/engine"
)

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 8192), 32*1024)
	out := json.NewEncoder(os.Stdout)
	for in.Scan() {
		var call struct {
			ID      uint64          `json:"id"`
			Request json.RawMessage `json:"request"`
		}
		if json.Unmarshal(in.Bytes(), &call) != nil || call.ID == 0 {
			continue
		}
		reply := struct {
			ID    uint64          `json:"id"`
			Reply json.RawMessage `json:"reply"`
		}{call.ID, json.RawMessage(engine.Call(string(call.Request)))}
		if out.Encode(reply) != nil {
			break
		}
	}
	engine.Call(`{"op":"stop"}`)
}
